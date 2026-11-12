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
      if (f.type === 'is') {
        if (f.val === null) {
          if (row[f.col] !== null && row[f.col] !== undefined) return false;
        } else if (row[f.col] !== f.val) return false;
      }
      if (f.type === 'not' && f.op === 'in') {
        const list = String(f.val).replace(/[()"]/g, '').split(',').map((s) => s.trim());
        if (list.includes(row[f.col])) return false;
      }
      if (f.type === 'or') {
        // PostgREST or-filter: the row passes if ANY clause matches.
        const hit = f.clauses.some((c) => {
          if (c.op === 'is') return c.val === null ? row[c.col] == null : row[c.col] === c.val;
          if (c.op === 'lte') return row[c.col] != null && row[c.col] <= c.val;
          return false;
        });
        if (!hit) return false;
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
      if (q.orderBy) {
        const { col, ascending } = q.orderBy;
        rows = [...rows].sort((a, b) => {
          const av = a[col] ?? '';
          const bv = b[col] ?? '';
          if (av === bv) return 0;
          return ascending ? (av < bv ? -1 : 1) : (av > bv ? -1 : 1);
        });
      }
      if (q.limit != null) rows = rows.slice(0, q.limit);
      return { data: rows, error: null };
    }
    if (q.op === 'update') {
      // Test hook: force the refunds-ledger update to fail (post-gateway
      // failure scenario). Toggle via options.failLedgerUpdate.
      if (q.table === 'refunds' && options.failLedgerUpdate) {
        return { data: null, error: { message: 'ledger update failed (mock)' } };
      }
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
      is(col, val) { q.filters.push({ type: 'is', col, val }); return api; },
      not(col, op, val) { q.filters.push({ type: 'not', col, op, val }); return api; },
      limit(n) { q.limit = n; return api; },
      // PostgREST or-filter: 'col.op.val,col.op.val' (value is everything
      // after the second dot, so ISO timestamps with '.' survive).
      or(str) {
        const clauses = String(str).split(',').map((part) => {
          const [col, op, ...rest] = part.split('.');
          const joined = rest.join('.');
          return { col, op, val: op === 'is' && joined === 'null' ? null : joined };
        });
        q.filters.push({ type: 'or', clauses });
        return api;
      },
      order(col, { ascending = true } = {}) { q.orderBy = { col, ascending }; return api; },
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
          if (row.status === 'REFUND_PENDING' && (!row.next_retry_at || Date.parse(row.next_retry_at) <= Date.now())) {
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
// mock._gatewayRefunds lists the refunds fetchMultipleRefund returns (for
// the idempotency / reconcile paths).
function makeRazorpayMock() {
  const mock = {
    _failRefund: false,
    _gatewayRefunds: [],
    payments: {
      fetch: jest.fn(async (paymentId) => {
        await new Promise((r) => setTimeout(r, 1));
        return { id: paymentId, status: 'captured', amount: 49900, order_id: 'order_rzp_mock' };
      }),
      fetchMultipleRefund: jest.fn(async () => {
        await new Promise((r) => setTimeout(r, 1));
        return { items: mock._gatewayRefunds, count: mock._gatewayRefunds.length };
      }),
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
  // Mutable per-test mock flags (failLedgerUpdate is toggled by test 6).
  let mockOptions;

  beforeEach(() => {
    jest.resetModules();
    db = { orders: [], payments: [], refunds: [] };
    rzp = makeRazorpayMock();
    mockOptions = { rpcAvailable: true, failLedgerUpdate: false };
    mockHolder.supabase = makeSupabaseMock(db, mockOptions);
    mockHolder.razorpay = rzp;
    service = require('../services/escrowService');
  });

  function seedOrder({ id = 'order_1', status = 'REFUND_PENDING', amount = 499, paymentId = 'pay_test_123' } = {}) {
    const order = {
      id, status, total_price: amount,
      buyer_id: 'buyer_1', farmer_id: 'farmer_1',
      delivery_deadline: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    };
    db.orders.push(order);
    db.payments.push({ id: `pay_${id}`, order_id: order.id, amount, status: 'HELD', razorpay_payment_id: paymentId });
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
    // Exactly one caller performs the refund (it carries the gateway id);
    // every other caller gets an honest alreadyHandled answer (already
    // processed, or already in progress) — never a false success.
    expect(results.filter((r) => r.success && r.gateway_refund_id).length).toBe(1);
    expect(results.filter((r) => r.alreadyHandled).length).toBe(49);
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

  test('(4) transient gateway failure — order returns to REFUND_PENDING (retryable), not terminal', async () => {
    const order = seedOrder();
    rzp._failRefund = true;
    await expect(service.refundOrder(order.id)).rejects.toThrow(/Refund Failed/);
    expect(db.orders[0].status).toBe('REFUND_PENDING');
    expect(db.orders[0].refund_attempts).toBe(1);
    // The pending ledger row was written before the gateway call (it is how
    // the gateway refund id is never lost); it has no gateway id yet.
    expect(db.refunds.length).toBe(1);
    expect(db.refunds[0].status).toBe('PENDING');
    expect(db.refunds[0].gateway_refund_id).toBeNull();
    // 3 attempts (initial + 2 retries with exponential backoff).
    expect(rzp.payments.refund.mock.calls.length).toBe(3);
  }, 15000);

  test('(5) transient failure then recovery — retry after the gateway recovers succeeds', async () => {
    const order = seedOrder();
    rzp._failRefund = true;
    await expect(service.refundOrder(order.id)).rejects.toThrow(/Refund Failed/);
    expect(db.orders[0].status).toBe('REFUND_PENDING');

    rzp._failRefund = false;
    const r = await service.refundOrder(order.id);
    expect(r.success).toBe(true);
    expect(r.gateway_refund_id).toBeTruthy();
    expect(db.refunds.length).toBe(1);
    expect(db.orders[0].status).toBe('REFUNDED');
    expect(db.payments[0].status).toBe('REFUNDED');
    // 3 failed attempts + 1 successful retry.
    expect(rzp.payments.refund.mock.calls.length).toBe(4);
  }, 15000);

  test('(6) post-gateway ledger failure — order goes to REFUND_RECONCILE, reconcile completes it', async () => {
    const order = seedOrder();
    // Fail the refunds-ledger update (step 4) after a successful gateway call.
    mockOptions.failLedgerUpdate = true;
    await expect(service.refundOrder(order.id)).rejects.toThrow(/Refund Failed/);
    expect(db.orders[0].status).toBe('REFUND_RECONCILE');
    expect(rzp.payments.refund.mock.calls.length).toBe(1);
    // The gateway refund exists; the ledger row is still PENDING with no id.
    expect(db.refunds.length).toBe(1);
    expect(db.refunds[0].status).toBe('PENDING');
    expect(db.refunds[0].gateway_refund_id).toBeNull();

    // The reconciler finds the gateway refund by listing the payment's
    // refunds and completes the ledger + statuses (no second gateway call).
    mockOptions.failLedgerUpdate = false;
    rzp._gatewayRefunds = [{ id: 'rfnd_mock_1', amount: 49900 }];
    await service.reconcileRefunds();
    expect(db.orders[0].status).toBe('REFUNDED');
    expect(db.payments[0].status).toBe('REFUNDED');
    expect(db.refunds[0].gateway_refund_id).toBe('rfnd_mock_1');
    expect(db.refunds[0].status).toBe('REFUNDED');
    expect(rzp.payments.refund.mock.calls.length).toBe(1);
  });

  test('(7) honest alreadyHandled — a failed refund reports success:false, not success', async () => {
    const order = seedOrder();
    // Permanent failure: no payment row, so the refund can never proceed.
    db.payments.length = 0;
    await expect(service.refundOrder(order.id)).rejects.toThrow(/Refund Failed/);
    expect(db.orders[0].status).toBe('REFUND_FAILED');

    const r = await service.refundOrder(order.id);
    expect(r.success).toBe(false);
    expect(r.alreadyHandled).toBe(true);
    expect(r.code).toBe('REFUND_NOT_PENDING');
    expect(rzp.payments.refund.mock.calls.length).toBe(0);
  });

  test('(8) NULL delivery deadline — a fresh order is NOT auto-refunded (M4 guard)', async () => {
    const order = seedOrder({ status: 'PAID' });
    order.delivery_deadline = null;
    await service.autoRefundJob();
    expect(db.refunds.length).toBe(0);
    expect(rzp.payments.refund.mock.calls.length).toBe(0);
    expect(db.orders[0].status).toBe('PAID');
  });

  test('(8b) NULL delivery deadline — an order older than the grace period WITH a payment row is refunded', async () => {
    const order = seedOrder({ status: 'PAID' });
    order.delivery_deadline = null;
    order.created_at = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await service.autoRefundJob();
    expect(db.refunds.length).toBe(1);
    expect(rzp.payments.refund.mock.calls.length).toBe(1);
    expect(db.orders[0].status).toBe('REFUNDED');
  });

  test('(9) existing gateway refund is reused — no second gateway call', async () => {
    const order = seedOrder();
    // An earlier attempt created the gateway refund but timed out before
    // the ledger recorded it.
    rzp._gatewayRefunds = [{ id: 'rfnd_existing_1', amount: 49900 }];
    const r = await service.refundOrder(order.id);
    expect(r.success).toBe(true);
    expect(r.gateway_refund_id).toBe('rfnd_existing_1');
    expect(rzp.payments.refund.mock.calls.length).toBe(0);
    expect(db.refunds.length).toBe(1);
    expect(db.refunds[0].gateway_refund_id).toBe('rfnd_existing_1');
    expect(db.orders[0].status).toBe('REFUNDED');
  });

  test('(10) future retry is not claimed before next_retry_at', async () => {
    const order = seedOrder();
    order.next_retry_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await service.autoRefundJob();
    expect(order.status).toBe('REFUND_PENDING');
    expect(db.refunds.length).toBe(0);
    expect(rzp.payments.refund.mock.calls.length).toBe(0);
  });

  test('(11) fallback claim — due rows are not starved by future-retry rows', async () => {
    // RPC unavailable: the fallback select must filter + order in the
    // query. With the old select-first-50 + JS-filter code, the 50
    // future-retry rows fill the page and the 2 due rows are never seen.
    mockOptions.rpcAvailable = false;
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 50; i++) {
      const o = seedOrder({ id: `order_future_${i}`, status: 'REFUND_PENDING' });
      o.next_retry_at = future;
    }
    seedOrder({ id: 'order_due_1', status: 'REFUND_PENDING' });
    seedOrder({ id: 'order_due_2', status: 'REFUND_PENDING' });
    await service.autoRefundJob();
    expect(db.orders.find((o) => o.id === 'order_due_1').status).toBe('REFUNDED');
    expect(db.orders.find((o) => o.id === 'order_due_2').status).toBe('REFUNDED');
    expect(db.refunds.length).toBe(2);
    expect(rzp.payments.refund.mock.calls.length).toBe(2);
    expect(db.orders.filter((o) => o.id.startsWith('order_future_'))
      .every((o) => o.status === 'REFUND_PENDING')).toBe(true);
  });

  test('(12) partial refund then full refund via refundOrder -> 409 REFUND_ALREADY_EXISTS, order NOT refunded', async () => {
    const order = seedOrder({ status: 'PAID' });
    const partial = await service.refundPartialOrder(order.id, 20000);
    expect(partial.success).toBe(true);
    expect(rzp.payments.refund.mock.calls.length).toBe(1);
    expect(db.orders[0].status).toBe('PAID');
    expect(db.payments[0].status).toBe('HELD');

    await service.markRefundPending(order.id, { buyerId: 'buyer_1' });
    const r = await service.refundOrder(order.id);
    expect(r.success).toBe(false);
    expect(r.code).toBe('REFUND_ALREADY_EXISTS');
    // The order never flips to REFUNDED while only partially refunded.
    expect(db.orders[0].status).toBe('REFUND_PENDING');
    expect(db.payments[0].status).toBe('HELD');
    // No gateway call for the remainder.
    expect(rzp.payments.refund.mock.calls.length).toBe(1);
    expect(db.refunds).toHaveLength(1);
    expect(db.refunds[0]).toMatchObject({ order_id: order.id, amount: 200 });
  });

  test('(13) full refund then partial refund -> 409 REFUND_ALREADY_EXISTS (already blocked, pinned)', async () => {
    const order = seedOrder();
    const r = await service.refundOrder(order.id);
    expect(r.success).toBe(true);
    await expect(service.refundPartialOrder(order.id, 20000))
      .rejects.toMatchObject({ status: 409, code: 'REFUND_ALREADY_EXISTS' });
    expect(rzp.payments.refund.mock.calls.length).toBe(1);
    expect(db.refunds).toHaveLength(1);
    expect(db.orders[0].status).toBe('REFUNDED');
  });

  test('(14) reconcileRefunds with a partial ledger row does NOT mark the order REFUNDED', async () => {
    const order = seedOrder({ status: 'REFUND_RECONCILE' });
    db.refunds.push({
      id: 'ref_partial', order_id: order.id,
      gateway_refund_id: 'rfnd_partial_1', status: 'REFUNDED', amount: 200,
    });
    await service.reconcileRefunds();
    expect(db.orders[0].status).toBe('REFUND_RECONCILE');
    expect(db.payments[0].status).toBe('HELD');
    expect(rzp.payments.refund.mock.calls.length).toBe(0);
    expect(db.refunds).toHaveLength(1);
  });

  test('(15) auto-refund RPC path: a partial ledger row under a claimed order returns the claim, order stays REFUND_PENDING', async () => {
    const order = seedOrder({ status: 'REFUND_PENDING' });
    db.refunds.push({
      id: 'ref_partial', order_id: order.id,
      gateway_refund_id: 'rfnd_partial_1', status: 'REFUNDED', amount: 200,
    });
    await service.autoRefundJob();
    expect(db.orders[0].status).toBe('REFUND_PENDING');
    expect(db.payments[0].status).toBe('HELD');
    expect(rzp.payments.refund.mock.calls.length).toBe(0);
    expect(db.refunds).toHaveLength(1);
  });
});
