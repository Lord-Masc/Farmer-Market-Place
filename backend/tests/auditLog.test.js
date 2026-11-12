'use strict';
/**
 * Audit-log wiring (Stage 1, follow-up to Stage 0's audit_log table):
 * every escrow state transition and every trust decision writes one row
 * to audit_log via the service-role client. The audit write is best
 * effort — a failing insert must never break the transition it records.
 * Same in-memory mock pattern as webhook.test.js, extended with order(),
 * range() and a configurable rpc() for the confirm-order RPC.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_mock';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'test-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'test-webhook-secret';

const mockHolder = { supabase: null, razorpay: null, rpc: null };

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
      if (q.order) {
        rows = [...rows].sort((a, b) => {
          const av = a[q.order.col];
          const bv = b[q.order.col];
          if (av === bv) return 0;
          return q.order.ascending ? (av < bv ? -1 : 1) : (av > bv ? -1 : 1);
        });
      }
      const count = rows.length;
      if (q.range) rows = rows.slice(q.range.from, q.range.to + 1);
      if (q.limit != null) rows = rows.slice(0, q.limit);
      return { data: rows, count, error: null };
    }
    if (q.op === 'update') {
      const matched = table.filter((r) => matches(r, q.filters));
      for (const r of matched) Object.assign(r, q.fields);
      return { data: matched, error: null };
    }
    if (q.op === 'insert') {
      const row = { id: `id_${Math.random().toString(36).slice(2)}`, created_at: new Date().toISOString(), ...q.row };
      table.push(row);
      return { data: [row], error: null };
    }
    return { data: null, error: { message: 'unsupported op' } };
  }

  function builder(table) {
    const q = { table, op: null, fields: null, row: null, filters: [], limit: null, order: null, range: null };
    const api = {
      select(_cols, _opts) { if (!q.op) q.op = 'select'; return api; },
      update(fields) { q.op = 'update'; q.fields = fields; return api; },
      insert(row) { q.op = 'insert'; q.row = row; return api; },
      eq(col, val) { q.filters.push({ type: 'eq', col, val }); return api; },
      in(col, val) { q.filters.push({ type: 'in', col, val }); return api; },
      lt(col, val) { q.filters.push({ type: 'lt', col, val }); return api; },
      is(col, val) { q.filters.push({ type: 'is', col, val }); return api; },
      limit(n) { q.limit = n; return api; },
      order(col, opts) { q.order = { col, ascending: !(opts && opts.ascending === false) }; return api; },
      range(from, to) { q.range = { from, to }; return api; },
      then(resolve, reject) {
        return new Promise((res) => setTimeout(res, 1)).then(() => execute(q)).then(resolve, reject);
      },
    };
    return api;
  }

  return {
    from: (table) => builder(table),
    rpc: async (name, args) => (mockHolder.rpc
      ? mockHolder.rpc(name, args, db)
      : ({ data: null, error: { message: 'unknown function' } })),
  };
}

function seedDb() {
  return {
    products: [
      { id: 'prod-1', farmer_id: 'farmer_1', user_price: 499, price: 499, quantity: 10 },
    ],
    profiles: [
      { id: 'buyer_1', first_name: 'Ramesh', last_name: 'Kumar', phone_number: '9999999999', role: 'buyer', verification_status: 'unverified' },
      { id: 'farmer_1', first_name: 'Suresh', last_name: 'Singh', phone_number: '8888888888', role: 'farmer', verification_status: 'unverified' },
      { id: 'admin_1', first_name: 'Admin', last_name: 'User', phone_number: '7777777777', role: 'admin', verification_status: 'unverified' },
    ],
    orders: [],
    payments: [],
    refunds: [],
    idempotency_keys: [],
    verification_submissions: [],
    // Stage 6: approve/reject also update the transporters row when one
    // exists for the submission's user.
    transporters: [],
    audit_log: [],
  };
}

function paidOrder() {
  return {
    id: 'order-1', buyer_id: 'buyer_1', farmer_id: 'farmer_1', product_id: 'prod-1',
    quantity: 1, unit_at_order: 'kg', total_price: 499, price_at_order: 499,
    status: 'PAID', delivery_address: 'Test address', buyer_phone: '9999999999',
    farmer_name: 'Suresh Singh', farmer_phone: '8888888888',
    delivery_deadline: new Date(Date.now() + 86400000).toISOString(),
    created_at: new Date().toISOString(),
  };
}

function auditEvents(db) {
  return db.audit_log.map((r) => r.event);
}

describe('logAudit', () => {
  let logAudit;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    mockHolder.razorpay = { orders: {}, payments: {} };
    logAudit = require('../utils/auditLog').logAudit;
  });

  test('inserts one row with actor, event and details', async () => {
    await logAudit('buyer_1', 'order.created', { order_id: 'order-1' });
    expect(db.audit_log).toHaveLength(1);
    expect(db.audit_log[0]).toMatchObject({
      actor_id: 'buyer_1', event: 'order.created', details: { order_id: 'order-1' },
    });
  });

  test('a failing insert never throws', async () => {
    jest.resetModules();
    // Swap the client for one whose insert always throws, then re-require.
    mockHolder.supabase = {
      from: () => ({ insert: async () => { throw new Error('db down'); } }),
    };
    const fresh = require('../utils/auditLog').logAudit;
    await expect(fresh('buyer_1', 'order.created', {})).resolves.toBeUndefined();
  });

  test('null actor (system events) is allowed', async () => {
    await logAudit(null, 'order.refunded', { order_id: 'order-1' });
    expect(db.audit_log[0]).toMatchObject({ actor_id: null, event: 'order.refunded' });
  });
});

describe('escrow transitions write audit rows', () => {
  let escrow;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    mockHolder.rpc = null;
    mockHolder.razorpay = {
      orders: { fetch: jest.fn(), create: jest.fn() },
      payments: {
        fetch: jest.fn(async (id) => ({ id, order_id: 'order_rzp_1', status: 'captured', amount: 49900 })),
        fetchMultipleRefund: jest.fn(async () => ({ items: [] })),
        refund: jest.fn(async () => ({ id: 'rfnd_1' })),
      },
    };
    escrow = require('../services/escrowService');
  });

  test('order creation writes order.created with the buyer as actor', async () => {
    const order = await escrow.createMarketplaceOrder('buyer_1', {
      product_id: 'prod-1', quantity: 1, unit: 'kg', delivery_address: 'Test address',
    });
    expect(auditEvents(db)).toEqual(['order.created']);
    expect(db.audit_log[0]).toMatchObject({
      actor_id: 'buyer_1', details: { order_id: order.id, product_id: 'prod-1' },
    });
  });

  test('farmer confirm writes order.confirmed; decline writes order.declined', async () => {
    mockHolder.rpc = async (name, args, dbRef) => {
      const order = dbRef.orders.find((o) => o.id === args.p_order_id);
      order.status = 'CONFIRMED';
      return { data: [order], error: null };
    };
    db.orders.push({ ...paidOrder(), id: 'order-c', status: 'PENDING' });
    await escrow.updateOrderStatusWithStock('order-c', 'farmer_1', 'CONFIRMED');
    db.orders.push({ ...paidOrder(), id: 'order-d', status: 'PENDING' });
    await escrow.updateOrderStatusWithStock('order-d', 'farmer_1', 'DECLINED');
    expect(auditEvents(db)).toEqual(['order.confirmed', 'order.declined']);
    expect(db.audit_log[0].actor_id).toBe('farmer_1');
    expect(db.audit_log[0].details).toEqual({ order_id: 'order-c' });
  });

  test('payment verification writes order.paid once (replay writes nothing)', async () => {
    db.orders.push({
      ...paidOrder(), id: 'order-p', status: 'CONFIRMED',
      razorpay_order_id: 'order_rzp_1', delivery_deadline: null,
    });
    await escrow.verifyAndMarkPaid('order-p', 'order_rzp_1', 'pay_1', 'buyer_1');
    expect(auditEvents(db)).toEqual(['order.paid']);
    expect(db.audit_log[0]).toMatchObject({ actor_id: 'buyer_1', details: { order_id: 'order-p' } });
    // Replay: order is PAID now, verifyAndMarkPaid returns the row — no second row.
    await escrow.verifyAndMarkPaid('order-p', 'order_rzp_1', 'pay_1', 'buyer_1');
    expect(db.audit_log).toHaveLength(1);
  });

  test('ship writes order.shipped; delivery writes order.completed', async () => {
    db.orders.push({ ...paidOrder(), id: 'order-s', status: 'PAID' });
    await escrow.markOrderAsShipped('order-s', 'farmer_1');
    db.payments.push({ id: 'payrow-1', order_id: 'order-s', amount: 499, status: 'HELD', razorpay_payment_id: 'pay_1' });
    await escrow.markOrderAsCompleted('order-s', 'buyer_1');
    expect(auditEvents(db)).toEqual(['order.shipped', 'order.completed']);
    expect(db.audit_log[1]).toMatchObject({ actor_id: 'buyer_1', details: { order_id: 'order-s' } });
  });

  test('manual refund request writes order.refund_requested; a no-op writes nothing', async () => {
    db.orders.push({ ...paidOrder(), id: 'order-r', status: 'PAID' });
    await escrow.markRefundPending('order-r', { buyerId: 'buyer_1' });
    expect(auditEvents(db)).toEqual(['order.refund_requested']);
    // Already REFUNDED: markRefundPending is a no-op — no audit row.
    db.orders.push({ ...paidOrder(), id: 'order-r2', status: 'REFUNDED' });
    await escrow.markRefundPending('order-r2', { buyerId: 'buyer_1' });
    expect(db.audit_log).toHaveLength(1);
  });

  test('completed refund writes order.refunded with the gateway refund id', async () => {
    db.orders.push({ ...paidOrder(), id: 'order-f', status: 'REFUND_PENDING' });
    db.payments.push({ id: 'payrow-f', order_id: 'order-f', amount: 499, status: 'HELD', razorpay_payment_id: 'pay_1' });
    const result = await escrow.refundOrder('order-f');
    expect(result.success).toBe(true);
    expect(auditEvents(db)).toEqual(['order.refunded']);
    expect(db.audit_log[0]).toMatchObject({
      actor_id: null, details: { order_id: 'order-f', gateway_refund_id: 'rfnd_1' },
    });
  });
});

describe('trust decisions write audit rows', () => {
  let verification;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    mockHolder.razorpay = { orders: {}, payments: {} };
    verification = require('../services/verificationService');
  });

  test('submit/approve/reject/role-change each write one row', async () => {
    const sub = await verification.submitVerification('farmer_1', 'verification-docs/farmer_1-abc.jpg');
    await verification.approveVerification('admin_1', sub.id);
    const sub2 = await verification.submitVerification('farmer_1', 'verification-docs/farmer_1-def.jpg');
    await verification.rejectVerification('admin_1', sub2.id, 'Document is unreadable.');
    await verification.changeRole('admin_1', 'buyer_1', 'farmer');
    expect(auditEvents(db)).toEqual([
      'verification.submitted',
      'verification.approved',
      // Second submission after the approval: a re-filed verification is a
      // new submission, so it writes its own submitted row.
      'verification.submitted',
      'verification.rejected',
      'role.changed',
    ]);
    expect(db.audit_log[1]).toMatchObject({
      actor_id: 'admin_1', details: { submission_id: sub.id, farmer_id: 'farmer_1' },
    });
    expect(db.audit_log[4]).toMatchObject({
      actor_id: 'admin_1', details: { user_id: 'buyer_1', role: 'farmer' },
    });
  });
});
