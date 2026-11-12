'use strict';
/**
 * Razorpay webhook (Stage 0, closes H1) + second-payment edge (L4).
 * The webhook is the only path that can confirm a payment when the buyer's
 * browser never returns: signature verified over the RAW body, then the
 * same idempotent verifyAndMarkPaid the browser callback uses.
 * Same in-memory mock pattern as orderCreation.test.js.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_mock';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'test-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test-webhook-secret';

const crypto = require('crypto');
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
      if (f.type === 'lt' && !(row[f.col] < f.val)) return false;
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
      let rows = table.filter((r) => matches(r, q.filters));
      if (q.limit != null) rows = rows.slice(0, q.limit);
      return { data: rows, error: null };
    }
    if (q.op === 'update') {
      const matched = table.filter((r) => matches(r, q.filters));
      for (const r of matched) Object.assign(r, q.fields);
      return { data: matched, error: null };
    }
    if (q.op === 'insert') {
      const row = { id: `id_${Math.random().toString(36).slice(2)}`, ...q.row };
      table.push(row);
      return { data: [row], error: null };
    }
    return { data: null, error: { message: 'unsupported op' } };
  }

  function builder(table) {
    const q = { table, op: null, fields: null, row: null, filters: [], limit: null };
    const api = {
      select() { if (!q.op) q.op = 'select'; return api; },
      update(fields) { q.op = 'update'; q.fields = fields; return api; },
      insert(row) { q.op = 'insert'; q.row = row; return api; },
      eq(col, val) { q.filters.push({ type: 'eq', col, val }); return api; },
      in(col, val) { q.filters.push({ type: 'in', col, val }); return api; },
      lt(col, val) { q.filters.push({ type: 'lt', col, val }); return api; },
      is(col, val) { q.filters.push({ type: 'is', col, val }); return api; },
      limit(n) { q.limit = n; return api; },
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
      { id: 'prod-1', farmer_id: 'farmer_1', user_price: 499, price: 499, quantity: 10 },
    ],
    profiles: [
      { id: 'buyer_1', first_name: 'Ramesh', last_name: 'Kumar', phone_number: '9999999999' },
      { id: 'farmer_1', first_name: 'Suresh', last_name: 'Singh', phone_number: '8888888888' },
    ],
    orders: [],
    payments: [],
    idempotency_keys: [],
  };
}

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

function signWebhook(rawBody) {
  return crypto.createHmac('sha256', 'test-webhook-secret').update(rawBody).digest('hex');
}

function capturedPayload(overrides = {}) {
  return {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: 'pay_1', order_id: 'order_rzp_1', status: 'captured', amount: 49900,
          ...overrides,
        },
      },
    },
  };
}

describe('POST /api/razorpay/webhook', () => {
  let controller;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    mockHolder.razorpay = {
      orders: { fetch: jest.fn(), create: jest.fn() },
      payments: {
        fetch: jest.fn(async (id) => ({ id, order_id: 'order_rzp_1', status: 'captured', amount: 49900 })),
        fetchMultipleRefund: jest.fn(async () => ({ items: [] })),
        refund: jest.fn(async () => ({ id: 'rfnd_1' })),
      },
    };
    controller = require('../controllers/escrowController');
  });

  function callWebhook(payload, { signature } = {}) {
    const rawBody = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    const req = {
      body: rawBody,
      headers: { 'x-razorpay-signature': signature !== undefined ? signature : signWebhook(rawBody) },
    };
    const res = mockRes();
    const next = jest.fn();
    return { req, res, next, promise: controller.handleRazorpayWebhook(req, res, next) };
  }

  function seedConfirmedOrder(overrides = {}) {
    const order = {
      id: 'order-1', buyer_id: 'buyer_1', farmer_id: 'farmer_1', product_id: 'prod-1',
      quantity: 1, unit_at_order: 'kg', total_price: 499, price_at_order: 499,
      status: 'CONFIRMED', razorpay_order_id: 'order_rzp_1', delivery_deadline: null,
      ...overrides,
    };
    db.orders.push(order);
    return order;
  }

  test('valid signature + payment.captured marks the order PAID', async () => {
    seedConfirmedOrder();
    const { res, next, promise } = callWebhook(capturedPayload());
    await promise;
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(db.orders[0].status).toBe('PAID');
    expect(db.payments).toHaveLength(1);
    expect(db.payments[0].razorpay_payment_id).toBe('pay_1');
  });

  test('a replayed payment.captured is idempotent — no second payments row', async () => {
    seedConfirmedOrder();
    await callWebhook(capturedPayload()).promise;
    const second = callWebhook(capturedPayload());
    await second.promise;
    expect(second.res.status).toHaveBeenCalledWith(200);
    expect(db.payments).toHaveLength(1);
    expect(db.orders[0].status).toBe('PAID');
  });

  test('an invalid signature is rejected before anything is read or written', async () => {
    seedConfirmedOrder();
    const { res, next, promise } = callWebhook(capturedPayload(), { signature: '00'.repeat(32) });
    await promise;
    expect(next.mock.calls[0][0]).toMatchObject({ status: 400, code: 'INVALID_SIGNATURE' });
    expect(res.status).not.toHaveBeenCalled();
    expect(db.orders[0].status).toBe('CONFIRMED');
    expect(db.payments).toHaveLength(0);
  });

  test('a missing signature is rejected', async () => {
    seedConfirmedOrder();
    const rawBody = Buffer.from(JSON.stringify(capturedPayload()));
    const req = { body: rawBody, headers: {} };
    const res = mockRes();
    const next = jest.fn();
    await controller.handleRazorpayWebhook(req, res, next);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 400, code: 'INVALID_SIGNATURE' });
    expect(db.payments).toHaveLength(0);
  });

  test('a missing webhook secret fails closed with 503', async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const { next, promise } = callWebhook(capturedPayload());
    await promise;
    expect(next.mock.calls[0][0]).toMatchObject({ status: 503, code: 'PAYMENT_UNAVAILABLE' });
    process.env.RAZORPAY_WEBHOOK_SECRET = 'test-webhook-secret';
  });

  test('malformed JSON is rejected with 400', async () => {
    const { next, promise } = callWebhook('{not json');
    await promise;
    expect(next.mock.calls[0][0]).toMatchObject({ status: 400, code: 'INVALID_PAYLOAD' });
  });

  test('non-captured events are acknowledged and ignored', async () => {
    seedConfirmedOrder();
    const { res, next, promise } = callWebhook({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_rzp_1' } } } });
    await promise;
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(db.orders[0].status).toBe('CONFIRMED');
    expect(db.payments).toHaveLength(0);
  });

  test('payment.captured for an unknown Razorpay order is acknowledged, not retried', async () => {
    const { res, next, promise } = callWebhook(capturedPayload({ order_id: 'order_rzp_unknown' }));
    await promise;
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(db.payments).toHaveLength(0);
  });

  test('a 5xx failure inside the handler is passed on so Razorpay retries', async () => {
    seedConfirmedOrder();
    // Re-require after swapping the client: the service captures its
    // Supabase client at load, so the throwing client must be in place
    // before the require.
    jest.resetModules();
    mockHolder.supabase = { from: () => { throw new Error('db down'); } };
    controller = require('../controllers/escrowController');
    const { next, promise } = callWebhook(capturedPayload());
    await promise;
    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

describe('handlePaymentCaptured + second-payment edge (L4)', () => {
  let service;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    mockHolder.razorpay = {
      orders: { fetch: jest.fn(), create: jest.fn() },
      payments: {
        fetch: jest.fn(async (id) => ({ id, order_id: 'order_rzp_1', status: 'captured', amount: 49900 })),
        fetchMultipleRefund: jest.fn(async () => ({ items: [] })),
        refund: jest.fn(async () => ({ id: 'rfnd_1' })),
      },
    };
    service = require('../services/escrowService');
  });

  function seedConfirmedOrder(overrides = {}) {
    const order = {
      id: 'order-1', buyer_id: 'buyer_1', farmer_id: 'farmer_1', product_id: 'prod-1',
      quantity: 1, unit_at_order: 'kg', total_price: 499, price_at_order: 499,
      status: 'CONFIRMED', razorpay_order_id: 'order_rzp_1', delivery_deadline: null,
      ...overrides,
    };
    db.orders.push(order);
    return order;
  }

  test('a second, different payment for the same order is refunded at the gateway, not recorded twice', async () => {
    const order = seedConfirmedOrder();
    db.payments.push({ id: 'p1', order_id: order.id, amount: 499, status: 'HELD', razorpay_payment_id: 'pay_1' });
    // A second capture for the same order arrives (buyer double-paid).
    const result = await service.handlePaymentCaptured({ id: 'pay_2', order_id: 'order_rzp_1', status: 'captured', amount: 49900 });
    expect(mockHolder.razorpay.payments.refund).toHaveBeenCalledWith('pay_2', { amount: 49900 });
    expect(db.payments).toHaveLength(1);
    expect(db.payments[0].razorpay_payment_id).toBe('pay_1');
    expect(result.status).toBe('PAID');
  });

  test('a duplicate refund that fails at the gateway is a 409, never a raw 500', async () => {
    const order = seedConfirmedOrder();
    db.payments.push({ id: 'p1', order_id: order.id, amount: 499, status: 'HELD', razorpay_payment_id: 'pay_1' });
    mockHolder.razorpay.payments.refund.mockRejectedValue(new Error('gateway down'));
    await expect(service.handlePaymentCaptured({ id: 'pay_2', order_id: 'order_rzp_1', status: 'captured', amount: 49900 }))
      .rejects.toMatchObject({ code: 'PAYMENT_DUPLICATE', status: 409 });
    expect(db.payments).toHaveLength(1);
    expect(db.orders[0].status).toBe('CONFIRMED');
  });
});
