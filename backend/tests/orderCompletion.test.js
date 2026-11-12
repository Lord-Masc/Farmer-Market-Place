'use strict';
/**
 * Order completion — payment release (audit H2).
 * markOrderAsCompleted flips the order to COMPLETED first and then releases
 * the HELD payment. If the payment update fails, the order must roll back
 * to its previous status — otherwise the payment stays HELD forever with no
 * reconciler and the farmer never gets paid.
 */

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.RAZORPAY_KEY_ID = 'rzp_test';
process.env.RAZORPAY_KEY_SECRET = 'test-secret';

const mockHolder = { client: null };
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mockHolder.client }));
jest.mock('razorpay', () => jest.fn().mockImplementation(() => ({ orders: {}, payments: {} })));

// Minimal table-aware mock: select/update with eq/in filters, applied
// synchronously in one tick (same pattern as refund.test.js).
function makeClient(db, opts = {}) {
  function query(table) {
    const q = { table, op: null, fields: null, filters: [] };
    const api = {
      select() { if (!q.op) q.op = 'select'; return api; },
      update(fields) { q.op = 'update'; q.fields = fields; return api; },
      eq(col, val) { q.filters.push({ col, val }); return api; },
      in(col, vals) { q.filters.push({ col, vals, isIn: true }); return api; },
      then(resolve) {
        const rows = db[q.table] || [];
        const matched = rows.filter((r) =>
          q.filters.every((f) => (f.isIn ? f.vals.includes(r[f.col]) : r[f.col] === f.val)),
        );
        let result;
        if (q.op === 'select') {
          result = { data: matched, error: null };
        } else if (q.op === 'update') {
          if (q.table === 'payments' && opts.failPaymentsUpdate) {
            result = { data: null, error: { message: 'payments update failed (mock)' } };
          } else {
            matched.forEach((r) => Object.assign(r, q.fields));
            result = { data: matched, error: null };
          }
        } else {
          result = { data: null, error: { message: 'unsupported op' } };
        }
        return Promise.resolve(result).then(resolve);
      },
    };
    return api;
  }
  return { from: query };
}

describe('markOrderAsCompleted payment release', () => {
  let service;
  let db;

  function loadService(clientOpts) {
    jest.resetModules();
    mockHolder.client = makeClient(db, clientOpts);
    service = require('../services/escrowService');
  }

  beforeEach(() => {
    db = {
      orders: [{ id: 'order-1', buyer_id: 'buyer-1', farmer_id: 'farmer-1', status: 'PAID', total_price: 499 }],
      payments: [{ id: 'pay-1', order_id: 'order-1', status: 'HELD', amount: 499, razorpay_payment_id: 'pay_rzp_1' }],
    };
    loadService();
  });

  test('releases the HELD payment and completes the order', async () => {
    const result = await service.markOrderAsCompleted('order-1', 'buyer-1');
    expect(result.status).toBe('COMPLETED');
    expect(db.orders[0].status).toBe('COMPLETED');
    expect(db.payments[0].status).toBe('RELEASED');
  });

  test('completion stamps completed_at (Stage 2: the on-time signal for farmer_stats)', async () => {
    const result = await service.markOrderAsCompleted('order-1', 'buyer-1');
    expect(db.orders[0].completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(result.completed_at).toBe(db.orders[0].completed_at);
  });

  test('payment-update error rolls the order back to PAID (audit H2)', async () => {
    loadService({ failPaymentsUpdate: true });
    let caught = null;
    try {
      await service.markOrderAsCompleted('order-1', 'buyer-1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(db.orders[0].status).toBe('PAID');
    expect(db.payments[0].status).toBe('HELD');
  });

  test('payment-update error also clears completed_at (Stage 2)', async () => {
    loadService({ failPaymentsUpdate: true });
    let caught = null;
    try {
      await service.markOrderAsCompleted('order-1', 'buyer-1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(db.orders[0].status).toBe('PAID');
    expect(db.orders[0].completed_at).toBeNull();
  });

  test('no HELD payment rolls the order back and refuses with 409', async () => {
    db.payments[0].status = 'REFUNDED';
    await expect(service.markOrderAsCompleted('order-1', 'buyer-1'))
      .rejects.toMatchObject({ code: 'ORDER_NOT_RELEASABLE', status: 409 });
    expect(db.orders[0].status).toBe('PAID');
  });

  test('no HELD payment also clears completed_at (Stage 2)', async () => {
    db.payments[0].status = 'REFUNDED';
    await expect(service.markOrderAsCompleted('order-1', 'buyer-1')).rejects.toMatchObject({ status: 409 });
    expect(db.orders[0].status).toBe('PAID');
    expect(db.orders[0].completed_at).toBeNull();
  });
});
