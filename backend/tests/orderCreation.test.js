'use strict';
/**
 * Order creation via the backend (Stage 0, closes M2/R2).
 * POST /api/orders must derive price, farmer and stock from the product row
 * and ignore anything the client claims about totals or counterparties.
 * The unit price is snapshotted as price_at_order so a later farmer price
 * edit can no longer brick payment with AMOUNT_MISMATCH.
 * Same mock pattern as escrow-security.test.js (in-memory tables).
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_mock';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'test-secret';

const mockHolder = { supabase: null, razorpay: null };

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => mockHolder.supabase,
}));
jest.mock('razorpay', () => jest.fn().mockImplementation(() => mockHolder.razorpay));

function makeSupabaseMock(db) {
  function matches(row, filters) {
    for (const f of filters) {
      if (f.type === 'eq' && row[f.col] !== f.val) return false;
      if (f.type === 'in' && !f.val.includes(row[f.col])) return false;
      if (f.type === 'is') {
        if (f.val === null) {
          if (row[f.col] !== null && row[f.col] !== undefined) return false;
        } else if (row[f.col] !== f.val) return false;
      }
    }
    return true;
  }

  function execute(q) {
    const table = db[q.table];
    if (!table) return { data: null, error: { message: `table ${q.table} does not exist` } };
    if (q.op === 'select') {
      return { data: table.filter((r) => matches(r, q.filters)), error: null };
    }
    if (q.op === 'update') {
      const matched = table.filter((r) => matches(r, q.filters));
      for (const r of matched) Object.assign(r, q.fields);
      return { data: matched, error: null };
    }
    if (q.op === 'insert') {
      if (q.table === 'idempotency_keys' && table.some((r) => r.key === q.row.key && r.user_id === q.row.user_id)) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "idempotency_keys_pkey"' } };
      }
      const row = { id: `id_${Math.random().toString(36).slice(2)}`, ...q.row };
      table.push(row);
      return { data: [row], error: null };
    }
    return { data: null, error: { message: 'unsupported op' } };
  }

  function builder(table) {
    const q = { table, op: null, fields: null, row: null, filters: [] };
    const api = {
      select() { if (!q.op) q.op = 'select'; return api; },
      update(fields) { q.op = 'update'; q.fields = fields; return api; },
      insert(row) { q.op = 'insert'; q.row = row; return api; },
      eq(col, val) { q.filters.push({ type: 'eq', col, val }); return api; },
      in(col, val) { q.filters.push({ type: 'in', col, val }); return api; },
      is(col, val) { q.filters.push({ type: 'is', col, val }); return api; },
      then(resolve, reject) {
        return new Promise((res) => setTimeout(res, 1)).then(() => execute(q)).then(resolve, reject);
      },
    };
    return api;
  }

  return { from: (table) => builder(table), rpc: async () => ({ data: null, error: { message: 'unknown function' } }) };
}

function seedDb() {
  return {
    products: [
      { id: 'prod-1', farmer_id: 'farmer_1', user_price: 50, price: 45, quantity: 100, unit: 'kg' },
    ],
    profiles: [
      { id: 'buyer_1', first_name: 'Ramesh', last_name: 'Kumar', phone_number: '9999999999' },
      { id: 'farmer_1', first_name: 'Suresh', last_name: 'Singh', phone_number: '8888888888' },
    ],
    orders: [],
    idempotency_keys: [],
    payments: [],
  };
}

describe('createMarketplaceOrder (POST /api/orders)', () => {
  let service;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    mockHolder.razorpay = { orders: { create: jest.fn(), fetch: jest.fn() }, payments: { fetch: jest.fn() } };
    service = require('../services/escrowService');
  });

  const input = { product_id: 'prod-1', quantity: 2, unit: 'kg', delivery_address: 'Village X' };

  test('derives price, farmer and total from the product row and snapshots the unit price', async () => {
    const order = await service.createMarketplaceOrder('buyer_1', {
      ...input, total_price: 1, farmer_id: 'attacker', farmer_name: 'Fake',
    });
    expect(order.status).toBe('PENDING');
    expect(order.farmer_id).toBe('farmer_1');
    expect(order.total_price).toBe(100);
    expect(order.price_at_order).toBe(50);
    expect(order.buyer_phone).toBe('9999999999');
    expect(order.farmer_name).toBe('Suresh Singh');
    expect(order.farmer_phone).toBe('8888888888');
    expect(db.orders).toHaveLength(1);
  });

  test('quintal quantity converts to kg for the total', async () => {
    const order = await service.createMarketplaceOrder('buyer_1', { ...input, quantity: 1, unit: 'quintal' });
    expect(order.total_price).toBe(5000);
    expect(order.unit_at_order).toBe('quintal');
  });

  test('rejects buying your own product', async () => {
    await expect(service.createMarketplaceOrder('farmer_1', input))
      .rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(db.orders).toHaveLength(0);
  });

  test('rejects when the requested quantity exceeds stock', async () => {
    await expect(service.createMarketplaceOrder('buyer_1', { ...input, quantity: 101 }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK', status: 409 });
    expect(db.orders).toHaveLength(0);
  });

  test('rejects invalid quantities', async () => {
    for (const quantity of [0, -1, 'abc', NaN]) {
      await expect(service.createMarketplaceOrder('buyer_1', { ...input, quantity }))
        .rejects.toMatchObject({ code: 'INVALID_QUANTITY', status: 400 });
    }
    expect(db.orders).toHaveLength(0);
  });

  test('rejects an unknown product without revealing which check failed', async () => {
    await expect(service.createMarketplaceOrder('buyer_1', { ...input, product_id: 'nope' }))
      .rejects.toMatchObject({ code: 'ORDER_NOT_ACCESSIBLE', status: 404 });
  });

  test('rejects an unknown unit', async () => {
    await expect(service.createMarketplaceOrder('buyer_1', { ...input, unit: 'tonne' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 });
  });

  test('rejects a missing delivery address', async () => {
    await expect(service.createMarketplaceOrder('buyer_1', { ...input, delivery_address: '  ' }))
      .rejects.toMatchObject({ code: 'MISSING_FIELDS', status: 400 });
  });

  test('an explicit delivery phone from the buyer wins over the profile phone', async () => {
    const order = await service.createMarketplaceOrder('buyer_1', { ...input, buyer_phone: '  7777777777 ' });
    expect(order.buyer_phone).toBe('7777777777');
  });

  test('same idempotency key + same body replays the first order without a second insert', async () => {
    const first = await service.createMarketplaceOrder('buyer_1', input, 'key-1');
    const second = await service.createMarketplaceOrder('buyer_1', input, 'key-1');
    expect(second.id).toBe(first.id);
    expect(db.orders).toHaveLength(1);
  });

  test('same idempotency key + different body fails loudly', async () => {
    await service.createMarketplaceOrder('buyer_1', input, 'key-1');
    await expect(service.createMarketplaceOrder('buyer_1', { ...input, quantity: 3 }, 'key-1'))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 422 });
    expect(db.orders).toHaveLength(1);
  });

  test('an in-flight idempotency key returns 409, not a duplicate order', async () => {
    // Seed the exact hash the service will compute, so the test exercises
    // the status check (a different hash must give 422, covered above).
    const crypto = require('crypto');
    const requestHash = crypto.createHash('sha256')
      .update(JSON.stringify({ buyerId: 'buyer_1', product_id: 'prod-1', quantity: 2, unit: 'kg', delivery_address: 'Village X', buyer_phone: '' }))
      .digest('hex');
    db.idempotency_keys.push({ key: 'key-1', user_id: 'buyer_1', request_hash: requestHash, status: 'in_progress' });
    await expect(service.createMarketplaceOrder('buyer_1', input, 'key-1'))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS', status: 409 });
    expect(db.orders).toHaveLength(0);
  });
});

describe('createRazorpayOrder uses the price snapshot', () => {
  let service;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    mockHolder.razorpay = {
      orders: {
        create: jest.fn(async () => ({ id: 'rzp_1', amount: 10000, status: 'created' })),
        fetch: jest.fn(async () => ({ id: 'rzp_1', amount: 10000, status: 'created' })),
      },
      payments: { fetch: jest.fn() },
    };
    service = require('../services/escrowService');
  });

  test('a farmer price edit after confirmation no longer bricks payment', async () => {
    // Order was created at ₹50/kg (snapshot); the farmer has since raised the
    // listing to ₹60/kg. The charge must still be the snapshot total.
    db.orders.push({
      id: 'order-1', buyer_id: 'buyer_1', farmer_id: 'farmer_1', product_id: 'prod-1',
      quantity: 2, unit_at_order: 'kg', total_price: 100, price_at_order: 50,
      status: 'CONFIRMED', razorpay_order_id: null,
    });
    db.products[0].user_price = 60;
    const result = await service.createRazorpayOrder('buyer_1', 'order-1');
    expect(result.amount).toBe(10000);
    expect(mockHolder.razorpay.orders.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 10000 }),
    );
  });

  test('an order total that disagrees with its own snapshot is still rejected', async () => {
    db.orders.push({
      id: 'order-1', buyer_id: 'buyer_1', farmer_id: 'farmer_1', product_id: 'prod-1',
      quantity: 2, unit_at_order: 'kg', total_price: 999, price_at_order: 50,
      status: 'CONFIRMED', razorpay_order_id: null,
    });
    await expect(service.createRazorpayOrder('buyer_1', 'order-1'))
      .rejects.toMatchObject({ code: 'AMOUNT_MISMATCH', status: 409 });
    expect(mockHolder.razorpay.orders.create).not.toHaveBeenCalled();
  });
});
