'use strict';
/**
 * Reconciliation job (Stage 0, closes H1/R3/R4 alongside the webhook).
 * Orders stuck CONFIRMED with a gateway order id but no payments row are
 * checked against Razorpay; only a gateway-paid order is marked PAID.
 * The job never invents a payment and never touches an order the gateway
 * says is unpaid.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_mock';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'test-secret';

const mockHolder = { supabase: null, razorpay: null, service: null };

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => mockHolder.supabase,
}));
jest.mock('razorpay', () => jest.fn().mockImplementation(() => mockHolder.razorpay));
jest.mock('../services/escrowService', () => mockHolder.service);

function makeSupabaseMock(db) {
  function matches(row, filters) {
    for (const f of filters) {
      if (f.type === 'eq' && row[f.col] !== f.val) return false;
      if (f.type === 'lt' && !(row[f.col] < f.val)) return false;
    }
    return true;
  }
  function builder(table) {
    const q = { table, filters: [], limit: null };
    const api = {
      select() { return api; },
      eq(col, val) { q.filters.push({ type: 'eq', col, val }); return api; },
      lt(col, val) { q.filters.push({ type: 'lt', col, val }); return api; },
      limit(n) { q.limit = n; return api; },
      then(resolve) {
        let rows = db[table].filter((r) => matches(r, q.filters));
        if (q.limit != null) rows = rows.slice(0, q.limit);
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return api;
  }
  return { from: (table) => builder(table) };
}

describe('reconcileUnpaidOrders', () => {
  let reconcile;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = { orders: [], payments: [] };
    mockHolder.supabase = makeSupabaseMock(db);
    mockHolder.razorpay = {
      orders: { fetch: jest.fn() },
      payments: {},
    };
    mockHolder.service = {
      verifyAndMarkPaid: jest.fn(async (orderId) => {
        const order = db.orders.find((o) => o.id === orderId);
        order.status = 'PAID';
        db.payments.push({ id: 'p1', order_id: orderId, amount: order.total_price, status: 'HELD', razorpay_payment_id: 'pay_1' });
        return order;
      }),
    };
    reconcile = require('../jobs/reconcile').reconcileUnpaidOrders;
  });

  function seedOrder(overrides = {}) {
    const order = {
      id: `order_${Math.random().toString(36).slice(2)}`,
      buyer_id: 'buyer_1', farmer_id: 'farmer_1', product_id: 'prod-1',
      quantity: 1, unit_at_order: 'kg', total_price: 499,
      status: 'CONFIRMED', razorpay_order_id: 'order_rzp_1',
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      ...overrides,
    };
    db.orders.push(order);
    return order;
  }

  test('a gateway-paid order with no payments row is marked PAID', async () => {
    const order = seedOrder();
    mockHolder.razorpay.orders.fetch.mockResolvedValue({ id: 'order_rzp_1', status: 'paid', amount: 49900 });
    // fetchPayments is read off the mocked razorpay client by the job.
    mockHolder.razorpay.orders.fetchPayments = jest.fn(async () => ({
      items: [{ id: 'pay_1', status: 'captured', amount: 49900 }],
    }));
    const result = await reconcile({ olderThanMinutes: 0 });
    expect(mockHolder.service.verifyAndMarkPaid).toHaveBeenCalledWith(order.id, 'order_rzp_1', 'pay_1', 'buyer_1');
    expect(order.status).toBe('PAID');
    expect(result.reconciled).toBe(1);
  });

  test('an order the gateway says is unpaid is left alone', async () => {
    seedOrder();
    mockHolder.razorpay.orders.fetch.mockResolvedValue({ id: 'order_rzp_1', status: 'created', amount: 49900 });
    const result = await reconcile({ olderThanMinutes: 0 });
    expect(mockHolder.service.verifyAndMarkPaid).not.toHaveBeenCalled();
    expect(result.reconciled).toBe(0);
  });

  test('an order that already has a payments row is skipped without a gateway call', async () => {
    const order = seedOrder();
    db.payments.push({ id: 'p1', order_id: order.id, amount: 499, status: 'HELD', razorpay_payment_id: 'pay_1' });
    const result = await reconcile({ olderThanMinutes: 0 });
    expect(mockHolder.razorpay.orders.fetch).not.toHaveBeenCalled();
    expect(mockHolder.service.verifyAndMarkPaid).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  test('a gateway failure on one order does not stop the next', async () => {
    const first = seedOrder({ razorpay_order_id: 'order_rzp_1' });
    const second = seedOrder({ razorpay_order_id: 'order_rzp_2' });
    mockHolder.razorpay.orders.fetch
      .mockRejectedValueOnce(new Error('gateway down'))
      .mockResolvedValueOnce({ id: 'order_rzp_2', status: 'paid', amount: 49900 });
    mockHolder.razorpay.orders.fetchPayments = jest.fn(async () => ({
      items: [{ id: 'pay_2', status: 'captured', amount: 49900 }],
    }));
    const result = await reconcile({ olderThanMinutes: 0 });
    expect(mockHolder.service.verifyAndMarkPaid).toHaveBeenCalledTimes(1);
    expect(mockHolder.service.verifyAndMarkPaid).toHaveBeenCalledWith(second.id, 'order_rzp_2', 'pay_2', 'buyer_1');
    expect(first.status).toBe('CONFIRMED');
    expect(result.reconciled).toBe(1);
    expect(result.failed).toBe(1);
  });

  test('orders newer than the cutoff are not touched', async () => {
    seedOrder({ created_at: new Date().toISOString() });
    const result = await reconcile({ olderThanMinutes: 15 });
    expect(mockHolder.razorpay.orders.fetch).not.toHaveBeenCalled();
    expect(result.checked).toBe(0);
  });
});
