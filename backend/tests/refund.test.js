'use strict';
/**
 * Refund idempotency — Jest unit tests (mocked Supabase + mocked Razorpay).
 * These are UNIT tests: they verify the fix's logic (atomic claim, idempotency
 * check, cron safety, failure handling) with a mock that faithfully models
 * Postgres semantics — the atomic UPDATE (filter + write) executes
 * synchronously in one JS tick, exactly like a row-locked UPDATE in Postgres,
 * so concurrent callers serialize on the claim. They are NOT a substitute for
 * the live concurrency run (scripts/refund-concurrency-test.js), which is
 * blocked because this VM cannot reach the live Supabase host.
 */

// Dummy env so the module's credential check stays quiet (mocks ignore the values).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_mock';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'test-secret';

// Holder for the per-test mocks. Jest allows "mock"-prefixed vars in mock factories.
const mockHolder = { supabase: null, razorpay: null };

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => mockHolder.supabase,
}));
jest.mock('razorpay', () => jest.fn().mockImplementation(() => mockHolder.razorpay));

// ---------------------------------------------------------------------------
// Mock Supabase client — in-memory tables + fluent query builder.
// The query builder is thenable (await executes it after a 1ms simulated
// latency). The UPDATE itself is synchronous (filter + write in one tick),
// which is what makes the atomic claim faithful: concurrent callers serialize
// on it, exactly as Postgres serializes row-locked UPDATEs.
// ---------------------------------------------------------------------------
function makeSupabaseMock(db, options = {}) {
  const rpcAvailable = options.rpcAvailable !== false;

  function matches(row, filters) {
    for (const f of filters) {
      if (f.type === 'eq' && row[f.col] !== f.val) return false;
      if (f.type === 'in' && !f.val.includes(row[f.col])) return false;
      if (f.type === 'lt' && !(row[f.col] < f.val)) return false;
      if (f.type === 'not' && f.op === 'in') {
        const list = String(f.val).replace(/[()"]/g, '').split(',').map((s) => s.trim());
        if (list.includes(row[f.col])) return false;
      }
    }
    return true;
  }

  // Synchronous execution — no await between the WHERE filter and the write.
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
      if (q.table === 'refunds' && table.some((r) => r.order_id === q.row.order_id)) {
        return { data: null, error: { message: 'duplicate key value violates unique constraint "refunds_order_id_key"' } };
      }
      const row = { id: `id_${Math.random().toString(36).slice(2)}`, ...q.row };
      table.push(row);
      return { data: [row], error: null };
    }
    return { data: null, error: { message: 'unsupported op' } };
  }

  function builder(table) {
    const q = { table, op: null, fields: null, row: null, filters: [], limit: null };
    const api = {
      // .select() after .update()/.insert() only means "return the rows"
      // (supabase-js semantics) — it must NOT overwrite the operation.
      select() { if (!q.op) q.op = 'select'; return api; },
      update(fields) { q.op = 'update'; q.fields = fields; return api; },
      insert(row) { q.op = 'insert'; q.row = row; return api; },
      eq(col, val) { q.filters.push({ type: 'eq', col, val }); return api; },
      in(col, val) { q.filters.push({ type: 'in', col, val }); return api; },
      lt(col, val) { q.filters.push({ type: 'lt', col, val }); return api; },
      not(col, op, val) { q.filters.push({ type: 'not', col, op, val }); return api; },
      limit(n) { q.limit = n; return api; },
      single() { return api; },
      then(resolve, reject) {
        return new Promise((res) => setTimeout(res, 1))
          .then(() => execute(q))
          .then(resolve, reject);
      },
    };
    return api;
  }

  return {
    from: (table) => builder(table),
    rpc: async (fnName, args) => {
      await new Promise((r) => setTimeout(r, 1));
      if (fnName === 'claim_pending_refunds') {
        if (!rpcAvailable) return { data: null, error: { message: 'function public.claim_pending_refunds does not exist' } };
        // FOR UPDATE SKIP LOCKED: atomically flip up to p_limit REFUND_PENDING
        // rows to REFUND_PROCESSING; a concurrent run skips the claimed rows.
        const limit = (args && args.p_limit) || 50;
        const claimed = [];
        for (const row of db.orders) {
          if (claimed.length >= limit) break;
          if (row.status === 'REFUND_PENDING') {
            row.status = 'REFUND_PROCESSING';
            claimed.push({ ...row });
          }
        }
        return { data: claimed, error: null };
      }
      return { data: null, error: { message: `unknown function ${fnName}` } };
    },
  };
}

// Mock Razorpay client. refund() is a jest.fn so tests can count invocations
// (including retry attempts). Set mock._failRefund = true to make it throw.
function makeRazorpayMock() {
  const mock = {
    _failRefund: false,
    payments: {
      refund: jest.fn(async (paymentId, opts) => {
        await new Promise((r) => setTimeout(r, 1));
        if (mock._failRefund) throw new Error('Razorpay gateway error (mocked)');
        return { id: `rfnd_mock_${mock.payments.refund.mock.calls.length}`, entity: 'refund', amount: opts.amount };
      }),
    },
    orders: { create: jest.fn(async () => ({ id: 'order_mock_1' })) },
  };
  return mock;
}

describe('refund idempotency', () => {
  let service;
  let db;
  let rzp;

  beforeEach(() => {
    jest.resetModules();
    db = { orders: [], payments: [], refunds: [] };
    rzp = makeRazorpayMock();
    mockHolder.supabase = makeSupabaseMock(db, { rpcAvailable: true });
    mockHolder.razorpay = rzp;
    service = require('../services/escrowService');
  });

  function seedOrder({ status = 'REFUND_PENDING', amount = 499, paymentId = 'pay_test_123' } = {}) {
    const order = {
      id: 'order_1', status, total_price: amount,
      buyer_id: 'buyer_1', farmer_id: 'farmer_1',
      delivery_deadline: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    };
    db.orders.push(order);
    db.payments.push({ id: 'pay_1', order_id: order.id, amount, status: 'HELD', razorpay_payment_id: paymentId });
    return order;
  }

  test('(1) double call — second refund is a no-op, exactly 1 gateway call', async () => {
    const order = seedOrder();
    const r1 = await service.refundOrder(order.id);
    expect(r1.success).toBe(true);
    expect(r1.gateway_refund_id).toBeTruthy();

    const r2 = await service.refundOrder(order.id);
    expect(r2.success).toBe(true);
    expect(r2.alreadyHandled).toBe(true);

    expect(db.refunds.length).toBe(1);
    expect(rzp.payments.refund.mock.calls.length).toBe(1);
    expect(db.orders[0].status).toBe('REFUNDED');
    expect(db.payments[0].status).toBe('REFUNDED');
  });

  test('(2) concurrent calls — 50 parallel, only 1 processes, 0 duplicates', async () => {
    const order = seedOrder();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => service.refundOrder(order.id)),
    );
    expect(results.filter((r) => r.success).length).toBe(50);
    expect(db.refunds.length).toBe(1);
    expect(rzp.payments.refund.mock.calls.length).toBe(1);
    expect(db.orders[0].status).toBe('REFUNDED');
  });

  test('(3) cron overlap — two concurrent autoRefundJob runs, no duplicate', async () => {
    seedOrder({ status: 'PAID' });
    await Promise.all([service.autoRefundJob(), service.autoRefundJob()]);
    expect(db.refunds.length).toBe(1);
    expect(rzp.payments.refund.mock.calls.length).toBe(1);
    expect(db.orders[0].status).toBe('REFUNDED');
  });

  test('(4) gateway failure — order ends REFUND_FAILED, not stuck', async () => {
    const order = seedOrder();
    rzp._failRefund = true;
    await expect(service.refundOrder(order.id)).rejects.toThrow(/Refund Failed/);
    expect(db.orders[0].status).toBe('REFUND_FAILED');
    expect(db.refunds.length).toBe(0);
    // 3 attempts (initial + 2 retries with exponential backoff).
    expect(rzp.payments.refund.mock.calls.length).toBe(3);
  }, 15000);
});
