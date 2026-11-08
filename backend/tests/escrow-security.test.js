'use strict';
/**
 * Escrow security — Jest unit tests (mocked Supabase + mocked Razorpay).
 * Covers the 2026-11-08 security fix: JWT auth middleware, ownership +
 * state-machine gates on ship/complete/update-status, server-side price
 * binding on create-order, Razorpay-verified payment marking, atomic stock
 * decrement, and manual-refund eligibility. Same mock pattern as
 * refund.test.js (in-memory tables, synchronous atomic UPDATEs).
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
      select() { if (!q.op) q.op = 'select'; return api; },
      update(fields) { q.op = 'update'; q.fields = fields; return api; },
      insert(row) { q.op = 'insert'; q.row = row; return api; },
      eq(col, val) { q.filters.push({ type: 'eq', col, val }); return api; },
      in(col, val) { q.filters.push({ type: 'in', col, val }); return api; },
      lt(col, val) { q.filters.push({ type: 'lt', col, val }); return api; },
      is(col, val) { q.filters.push({ type: 'is', col, val }); return api; },
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
    rpc: async () => ({ data: [], error: null }),
    auth: {
      getUser: async (token) => {
        const users = {
          'buyer-token': { id: 'buyer_1', email: 'buyer@test' },
          'farmer-token': { id: 'farmer_1', email: 'farmer@test' },
          'other-token': { id: 'other_1', email: 'other@test' },
        };
        const user = users[token];
        if (!user) return { data: { user: null }, error: { message: 'invalid token' } };
        return { data: { user }, error: null };
      },
    },
  };
}

function makeRazorpayMock() {
  const mock = {
    // Configurable fetched payment (verifyAndMarkPaid reads this).
    _payment: { id: 'pay_1', status: 'captured', amount: 49900, order_id: 'order_rzp_1' },
    _gatewayRefunds: [],
    payments: {
      fetch: jest.fn(async (paymentId) => {
        await new Promise((r) => setTimeout(r, 1));
        return { ...mock._payment, id: paymentId };
      }),
      fetchMultipleRefund: jest.fn(async () => {
        await new Promise((r) => setTimeout(r, 1));
        return { items: mock._gatewayRefunds, count: mock._gatewayRefunds.length };
      }),
      refund: jest.fn(async (paymentId, opts) => {
        await new Promise((r) => setTimeout(r, 1));
        return { id: `rfnd_mock_${mock.payments.refund.mock.calls.length}`, entity: 'refund', amount: opts.amount };
      }),
    },
    orders: { create: jest.fn(async () => ({ id: 'order_rzp_1' })) },
  };
  return mock;
}

describe('escrow security', () => {
  let service;
  let requireAuth;
  let db;
  let rzp;

  beforeEach(() => {
    jest.resetModules();
    db = { orders: [], payments: [], refunds: [], products: [] };
    rzp = makeRazorpayMock();
    mockHolder.supabase = makeSupabaseMock(db);
    mockHolder.razorpay = rzp;
    service = require('../services/escrowService');
    requireAuth = require('../middleware/requireAuth');
    // One product: farmer_1 sells at 499/unit, 10 in stock.
    db.products.push({ id: 'prod_1', farmer_id: 'farmer_1', user_price: 499, quantity: 10 });
  });

  function seedOrder(overrides = {}) {
    const order = {
      id: `order_${Math.random().toString(36).slice(2)}`,
      status: 'pending',
      total_price: 499,
      buyer_id: 'buyer_1',
      farmer_id: 'farmer_1',
      product_id: 'prod_1',
      quantity: 1,
      unit_at_order: 'kg',
      delivery_address: 'Test Address',
      buyer_phone: '9999999999',
      delivery_deadline: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      ...overrides,
    };
    db.orders.push(order);
    return order;
  }

  function seedPayment(order, overrides = {}) {
    const payment = {
      id: `pay_${Math.random().toString(36).slice(2)}`,
      order_id: order.id,
      amount: order.total_price,
      status: 'HELD',
      razorpay_payment_id: 'pay_1',
      ...overrides,
    };
    db.payments.push(payment);
    return payment;
  }

  function callMiddleware(mw, headers) {
    return new Promise((resolve) => {
      const req = { headers: headers || {} };
      const res = {};
      mw(req, res, (err) => resolve({ req, err }));
    });
  }

  // --- requireAuth -------------------------------------------------------
  test('auth: no token → 401', async () => {
    const { err } = await callMiddleware(requireAuth, {});
    expect(err).toBeTruthy();
    expect(err.status).toBe(401);
  });

  test('auth: bad token → 401', async () => {
    const { err } = await callMiddleware(requireAuth, { authorization: 'Bearer nope' });
    expect(err).toBeTruthy();
    expect(err.status).toBe(401);
  });

  test('auth: valid token → req.user set', async () => {
    const { req, err } = await callMiddleware(requireAuth, { authorization: 'Bearer buyer-token' });
    expect(err).toBeFalsy();
    expect(req.user.id).toBe('buyer_1');
  });

  // --- create-order price binding ----------------------------------------
  test('create-order: exact product price succeeds and stores the validated total', async () => {
    const res = await service.createRazorpayOrder('buyer_1', 'farmer_1', 499, 'prod_1', 1, 'kg', 'Addr', '9999999999');
    expect(res.order_id).toBeTruthy();
    expect(res.razorpay_order_id).toBe('order_rzp_1');
    expect(db.orders[0].total_price).toBe(499);
    expect(db.orders[0].status).toBe('CREATED');
    expect(db.orders[0].delivery_deadline).toBeTruthy();
  });

  test('create-order: 1-rupee amount for a 499 product is rejected', async () => {
    await expect(
      service.createRazorpayOrder('buyer_1', 'farmer_1', 1, 'prod_1', 1, 'kg', 'Addr', '9999999999')
    ).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH' });
    expect(db.orders.length).toBe(0);
  });

  test('create-order: wrong seller for the product is rejected', async () => {
    await expect(
      service.createRazorpayOrder('buyer_1', 'farmer_9', 499, 'prod_1', 1, 'kg', 'Addr', '9999999999')
    ).rejects.toMatchObject({ code: 'INVALID_SELLER' });
  });

  test('create-order: negative quantity is rejected', async () => {
    await expect(
      service.createRazorpayOrder('buyer_1', 'farmer_1', 499, 'prod_1', -5, 'kg', 'Addr', '9999999999')
    ).rejects.toMatchObject({ code: 'INVALID_QUANTITY' });
  });

  test('create-order existing-order: deadline is NOT reset, total is corrected, buyer-only, CREATED-only', async () => {
    const deadline = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const existing = seedOrder({ status: 'CREATED', total_price: 1, delivery_deadline: deadline, delivery_address: 'Victim Address' });
    const res = await service.createRazorpayOrder('buyer_1', 'farmer_1', 499, 'prod_1', 1, 'kg', 'Attacker Address', '9999999999', existing.id);
    expect(res.order_id).toBe(existing.id);
    expect(db.orders[0].delivery_deadline).toBe(deadline);
    expect(db.orders[0].delivery_address).toBe('Attacker Address');
    expect(db.orders[0].total_price).toBe(499);

    // Another buyer cannot reuse the order id.
    await expect(
      service.createRazorpayOrder('other_1', 'farmer_1', 499, 'prod_1', 1, 'kg', 'X', '111', existing.id)
    ).rejects.toMatchObject({ status: 403 });

    // A PAID order cannot be re-entered through create-order.
    db.orders[0].status = 'PAID';
    await expect(
      service.createRazorpayOrder('buyer_1', 'farmer_1', 499, 'prod_1', 1, 'kg', 'X', '111', existing.id)
    ).rejects.toMatchObject({ code: 'ORDER_NOT_EDITABLE' });
  });

  // --- verify-payment binding --------------------------------------------
  test('verify-payment: happy path marks PAID, records the gateway amount, backfills deadline', async () => {
    const order = seedOrder({ status: 'CREATED', delivery_deadline: null });
    const updated = await service.verifyAndMarkPaid(order.id, 'order_rzp_1', 'pay_1', 'buyer_1');
    expect(updated.status).toBe('PAID');
    expect(db.orders[0].delivery_deadline).toBeTruthy();
    expect(db.payments.length).toBe(1);
    expect(db.payments[0].status).toBe('HELD');
    expect(db.payments[0].razorpay_payment_id).toBe('pay_1');
    expect(db.payments[0].amount).toBe(499);
  });

  test('verify-payment: 1-rupee payment for a 499 order is rejected', async () => {
    const order = seedOrder({ status: 'CREATED' });
    rzp._payment = { id: 'pay_1', status: 'captured', amount: 100, order_id: 'order_rzp_1' };
    await expect(service.verifyAndMarkPaid(order.id, 'order_rzp_1', 'pay_1', 'buyer_1'))
      .rejects.toMatchObject({ code: 'AMOUNT_MISMATCH' });
    expect(db.orders[0].status).toBe('CREATED');
    expect(db.payments.length).toBe(0);
  });

  test('verify-payment: replaying one payment across two orders is rejected', async () => {
    const a = seedOrder({ status: 'CREATED' });
    const b = seedOrder({ status: 'CREATED' });
    await service.verifyAndMarkPaid(a.id, 'order_rzp_1', 'pay_1', 'buyer_1');
    await expect(service.verifyAndMarkPaid(b.id, 'order_rzp_1', 'pay_1', 'buyer_1'))
      .rejects.toMatchObject({ code: 'PAYMENT_ALREADY_USED' });
    expect(db.orders[1].status).toBe('CREATED');
  });

  test('verify-payment: payment for another Razorpay order is rejected', async () => {
    const order = seedOrder({ status: 'CREATED' });
    rzp._payment = { id: 'pay_1', status: 'captured', amount: 49900, order_id: 'order_rzp_OTHER' };
    await expect(service.verifyAndMarkPaid(order.id, 'order_rzp_1', 'pay_1', 'buyer_1'))
      .rejects.toMatchObject({ code: 'PAYMENT_ORDER_MISMATCH' });
  });

  test('verify-payment: non-captured payment is rejected', async () => {
    const order = seedOrder({ status: 'CREATED' });
    rzp._payment = { id: 'pay_1', status: 'authorized', amount: 49900, order_id: 'order_rzp_1' };
    await expect(service.verifyAndMarkPaid(order.id, 'order_rzp_1', 'pay_1', 'buyer_1'))
      .rejects.toMatchObject({ code: 'PAYMENT_NOT_CAPTURED' });
  });

  test('verify-payment: wrong buyer and non-CREATED order are rejected', async () => {
    const order = seedOrder({ status: 'CREATED' });
    await expect(service.verifyAndMarkPaid(order.id, 'order_rzp_1', 'pay_1', 'other_1'))
      .rejects.toMatchObject({ status: 403 });
    db.orders[0].status = 'PAID';
    await expect(service.verifyAndMarkPaid(order.id, 'order_rzp_1', 'pay_1', 'buyer_1'))
      .rejects.toMatchObject({ code: 'ORDER_NOT_PAYABLE' });
  });

  // --- update-status state machine + atomic stock -------------------------
  test('update-status: confirm decrements stock once; re-confirm and revert are rejected', async () => {
    const order = seedOrder({ status: 'pending', quantity: 2 });
    const confirmed = await service.updateOrderStatusWithStock(order.id, 'farmer_1', 'confirmed');
    expect(confirmed.status).toBe('confirmed');
    expect(db.products[0].quantity).toBe(8);

    await expect(service.updateOrderStatusWithStock(order.id, 'farmer_1', 'confirmed'))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(service.updateOrderStatusWithStock(order.id, 'farmer_1', 'pending'))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(service.updateOrderStatusWithStock(order.id, 'farmer_1', 'COMPLETED'))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(db.products[0].quantity).toBe(8);
  });

  test('update-status: wrong farmer gets the generic 404 (no oracle)', async () => {
    const order = seedOrder({ status: 'pending', quantity: 1 });
    await expect(service.updateOrderStatusWithStock(order.id, 'farmer_9', 'confirmed'))
      .rejects.toMatchObject({ status: 404, code: 'ORDER_NOT_ACCESSIBLE' });
    expect(db.products[0].quantity).toBe(10);
  });

  test('update-status: insufficient stock reports a generic error without the exact stock level', async () => {
    const order = seedOrder({ status: 'pending', quantity: 20 });
    await expect(service.updateOrderStatusWithStock(order.id, 'farmer_1', 'confirmed'))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    try {
      await service.updateOrderStatusWithStock(order.id, 'farmer_1', 'confirmed');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.message).not.toContain('10');
    }
    expect(db.products[0].quantity).toBe(10);
  });

  test('update-status: negative stored quantity cannot increase stock', async () => {
    const order = seedOrder({ status: 'pending', quantity: -5 });
    await expect(service.updateOrderStatusWithStock(order.id, 'farmer_1', 'confirmed'))
      .rejects.toMatchObject({ code: 'INVALID_QUANTITY' });
    expect(db.products[0].quantity).toBe(10);
  });

  test('update-status: two concurrent confirms for 6kg each from 10kg stock — only one succeeds', async () => {
    const a = seedOrder({ status: 'pending', quantity: 6 });
    const b = seedOrder({ status: 'pending', quantity: 6 });
    const results = await Promise.allSettled([
      service.updateOrderStatusWithStock(a.id, 'farmer_1', 'confirmed'),
      service.updateOrderStatusWithStock(b.id, 'farmer_1', 'confirmed'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);
    expect(db.products[0].quantity).toBe(4);
    const confirmedCount = db.orders.filter((o) => o.status === 'confirmed').length;
    expect(confirmedCount).toBe(1);
  });

  // --- ship / complete -----------------------------------------------------
  test('ship-order: farmer-only, PAID/confirmed only', async () => {
    const paid = seedOrder({ status: 'PAID' });
    const shipped = await service.markOrderAsShipped(paid.id, 'farmer_1');
    expect(shipped.status).toBe('SHIPPED');

    const completed = seedOrder({ status: 'COMPLETED' });
    await expect(service.markOrderAsShipped(completed.id, 'farmer_1'))
      .rejects.toMatchObject({ code: 'ORDER_NOT_SHIPPABLE' });

    const other = seedOrder({ status: 'PAID' });
    await expect(service.markOrderAsShipped(other.id, 'farmer_9'))
      .rejects.toMatchObject({ status: 404 });
  });

  test('confirm-delivery: buyer-only, PAID/SHIPPED + HELD payment, releases escrow', async () => {
    const order = seedOrder({ status: 'PAID' });
    seedPayment(order);
    const done = await service.markOrderAsCompleted(order.id, 'buyer_1');
    expect(done.status).toBe('COMPLETED');
    expect(db.payments[0].status).toBe('RELEASED');

    const created = seedOrder({ status: 'CREATED' });
    await expect(service.markOrderAsCompleted(created.id, 'buyer_1'))
      .rejects.toMatchObject({ code: 'ORDER_NOT_RELEASABLE' });

    const farmerTry = seedOrder({ status: 'PAID' });
    seedPayment(farmerTry);
    await expect(service.markOrderAsCompleted(farmerTry.id, 'farmer_1'))
      .rejects.toMatchObject({ status: 404 });
    expect(db.orders.find((o) => o.id === farmerTry.id).status).toBe('PAID');
  });

  test('confirm-delivery: PAID order with no HELD payment rolls back and is refused', async () => {
    const order = seedOrder({ status: 'PAID' });
    seedPayment(order, { status: 'RELEASED' });
    await expect(service.markOrderAsCompleted(order.id, 'buyer_1'))
      .rejects.toMatchObject({ code: 'ORDER_NOT_RELEASABLE' });
    expect(db.orders[0].status).toBe('PAID');
  });

  // --- manual refund eligibility -------------------------------------------
  test('markRefundPending: buyer-only; SHIPPED needs a past deadline; PAID is fine', async () => {
    const paid = seedOrder({ status: 'PAID' });
    const enqueued = await service.markRefundPending(paid.id, { buyerId: 'buyer_1' });
    expect(enqueued.status).toBe('REFUND_PENDING');

    const shippedFuture = seedOrder({ status: 'SHIPPED' });
    await expect(service.markRefundPending(shippedFuture.id, { buyerId: 'buyer_1' }))
      .rejects.toMatchObject({ code: 'REFUND_NOT_ELIGIBLE' });
    expect(db.orders.find((o) => o.id === shippedFuture.id).status).toBe('SHIPPED');

    const shippedPast = seedOrder({
      status: 'SHIPPED',
      delivery_deadline: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const enqueued2 = await service.markRefundPending(shippedPast.id, { buyerId: 'buyer_1' });
    expect(enqueued2.status).toBe('REFUND_PENDING');

    const others = seedOrder({ status: 'PAID' });
    await expect(service.markRefundPending(others.id, { buyerId: 'other_1' }))
      .rejects.toMatchObject({ status: 403 });
  });
});
