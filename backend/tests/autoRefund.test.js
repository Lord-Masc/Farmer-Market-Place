'use strict';
/**
 * Auto-refund NULL-deadline guard (Stage 0, closes M4).
 * A PAID/SHIPPED order with no delivery_deadline used to be enqueued for
 * refund on the next hourly run — even if the goods were delivered, even
 * with no payment row. Now only NULL-deadline orders older than the grace
 * period AND with a payments row are enqueued.
 * Same in-memory mock pattern as escrow-security.test.js.
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
      if (f.type === 'lt' && !(row[f.col] < f.val)) return false;
      if (f.type === 'lte' && !(row[f.col] <= f.val)) return false;
      if (f.type === 'is') {
        if (f.val === null) {
          if (row[f.col] !== null && row[f.col] !== undefined) return false;
        } else if (row[f.col] !== f.val) return false;
      }
      if (f.type === 'or') {
        const parts = f.val.split(',');
        const ok = parts.some((part) => {
          const [col, op, ...rest] = part.split('.');
          const val = rest.join('.');
          if (op === 'is' && val === 'null') return row[col] === null || row[col] === undefined;
          if (op === 'lte') return row[col] !== null && row[col] !== undefined && row[col] <= val;
          return false;
        });
        if (!ok) return false;
      }
    }
    return true;
  }

  function execute(q) {
    const table = db[q.table];
    if (!table) return { data: null, error: { message: `table ${q.table} does not exist` } };
    if (q.op === 'select') {
      let rows = table.filter((r) => matches(r, q.filters));
      if (q.orderBy) rows = [...rows].sort((a, b) => (a[q.orderBy] < b[q.orderBy] ? -1 : 1));
      if (q.limit != null) rows = rows.slice(0, q.limit);
      return { data: rows, error: null };
    }
    if (q.op === 'update') {
      const matched = table.filter((r) => matches(r, q.filters));
      for (const r of matched) Object.assign(r, q.fields);
      return { data: matched, error: null };
    }
    if (q.op === 'insert') {
      if (q.table === 'refunds' && table.some((r) => r.order_id === q.row.order_id)) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "refunds_order_id_key"' } };
      }
      const row = { id: `id_${Math.random().toString(36).slice(2)}`, ...q.row };
      table.push(row);
      return { data: [row], error: null };
    }
    return { data: null, error: { message: 'unsupported op' } };
  }

  function builder(table) {
    const q = { table, op: null, fields: null, row: null, filters: [], limit: null, orderBy: null };
    const api = {
      select() { if (!q.op) q.op = 'select'; return api; },
      update(fields) { q.op = 'update'; q.fields = fields; return api; },
      insert(row) { q.op = 'insert'; q.row = row; return api; },
      eq(col, val) { q.filters.push({ type: 'eq', col, val }); return api; },
      in(col, val) { q.filters.push({ type: 'in', col, val }); return api; },
      lt(col, val) { q.filters.push({ type: 'lt', col, val }); return api; },
      is(col, val) { q.filters.push({ type: 'is', col, val }); return api; },
      or(val) { q.filters.push({ type: 'or', val }); return api; },
      order(col) { q.orderBy = col; return api; },
      limit(n) { q.limit = n; return api; },
      then(resolve, reject) {
        return new Promise((res) => setTimeout(res, 1)).then(() => execute(q)).then(resolve, reject);
      },
    };
    return api;
  }

  // claim_pending_refunds RPC is intentionally unavailable in this mock:
  // the job's fallback path (plain select + per-order claim) is exercised.
  return { from: (table) => builder(table), rpc: async () => ({ data: null, error: { message: 'function does not exist' } }) };
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe('autoRefundJob NULL-deadline guard (M4)', () => {
  let service;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = { orders: [], payments: [], refunds: [] };
    mockHolder.supabase = makeSupabaseMock(db);
    mockHolder.razorpay = {
      orders: {},
      payments: {
        fetchMultipleRefund: jest.fn(async () => ({ items: [] })),
        refund: jest.fn(async () => ({ id: 'rfnd_1' })),
      },
    };
    service = require('../services/escrowService');
  });

  function seedOrder(overrides = {}) {
    const order = {
      id: `order_${Math.random().toString(36).slice(2)}`,
      buyer_id: 'buyer_1', farmer_id: 'farmer_1', product_id: 'prod-1',
      quantity: 1, unit_at_order: 'kg', total_price: 499,
      status: 'PAID', delivery_deadline: null, created_at: daysAgo(10),
      refund_attempts: 0, next_retry_at: null,
      ...overrides,
    };
    db.orders.push(order);
    return order;
  }

  function seedPayment(order) {
    db.payments.push({ id: 'p1', order_id: order.id, amount: 499, status: 'HELD', razorpay_payment_id: 'pay_1' });
  }

  test('NULL-deadline order older than the grace period WITH a payment row is refunded', async () => {
    const order = seedOrder();
    seedPayment(order);
    await service.autoRefundJob();
    expect(order.status).toBe('REFUNDED');
    expect(mockHolder.razorpay.payments.refund).toHaveBeenCalledWith('pay_1', { amount: 49900 });
  });

  test('NULL-deadline order younger than the grace period is left alone', async () => {
    const order = seedOrder({ created_at: daysAgo(1) });
    seedPayment(order);
    await service.autoRefundJob();
    expect(order.status).toBe('PAID');
    expect(mockHolder.razorpay.payments.refund).not.toHaveBeenCalled();
  });

  test('NULL-deadline order with no payments row is never enqueued', async () => {
    const order = seedOrder();
    await service.autoRefundJob();
    expect(order.status).toBe('PAID');
    expect(mockHolder.razorpay.payments.refund).not.toHaveBeenCalled();
  });

  test('past-deadline order with a payment row still refunds (existing behaviour)', async () => {
    const order = seedOrder({ delivery_deadline: daysAgo(1) });
    seedPayment(order);
    await service.autoRefundJob();
    expect(order.status).toBe('REFUNDED');
  });

  test('past-deadline SHIPPED order refunds', async () => {
    const order = seedOrder({ status: 'SHIPPED', delivery_deadline: daysAgo(1) });
    seedPayment(order);
    await service.autoRefundJob();
    expect(order.status).toBe('REFUNDED');
  });
});
