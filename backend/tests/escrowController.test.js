'use strict';
/**
 * Escrow controller — HMAC signature verification (audit M4).
 * The signature check is the most security-critical code in the PR and had
 * zero test coverage: a regression (e.g. reverting to `!==`) would pass CI
 * silently. These tests pin it: valid signature passes, wrong / malformed
 * signatures are rejected before the service is ever called, and a missing
 * secret fails closed with 503.
 */

const crypto = require('crypto');

const SECRET = 'test-secret-for-hmac';
process.env.RAZORPAY_KEY_SECRET = SECRET;

const mockService = {
  createRazorpayOrder: jest.fn(),
  createMarketplaceOrder: jest.fn(),
  verifyAndMarkPaid: jest.fn(),
  updateOrderStatusWithStock: jest.fn(),
  markOrderAsShipped: jest.fn(),
  markOrderAsCompleted: jest.fn(),
  markRefundPending: jest.fn(),
  refundOrder: jest.fn(),
};
jest.mock('../services/escrowService', () => mockService);

function sign(orderId, paymentId) {
  return crypto.createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}

function mockRes() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  return res;
}

describe('verifyPayment signature check', () => {
  let controller;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    controller = require('../controllers/escrowController');
  });

  function callVerify(body) {
    const req = { body, user: { id: 'buyer-1' } };
    const res = mockRes();
    const next = jest.fn();
    return { req, res, next, promise: controller.verifyPayment(req, res, next) };
  }

  test('valid signature reaches the service and returns 200', async () => {
    const order = { id: 'order-1', status: 'PAID' };
    mockService.verifyAndMarkPaid.mockResolvedValue(order);
    const { res, next, promise } = callVerify({
      razorpay_order_id: 'order_rzp_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: sign('order_rzp_1', 'pay_1'),
      order_id: 'order-1',
    });
    await promise;
    expect(mockService.verifyAndMarkPaid).toHaveBeenCalledWith(
      'order-1', 'order_rzp_1', 'pay_1', 'buyer-1',
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, order });
    expect(next).not.toHaveBeenCalled();
  });

  test('wrong signature is rejected with 400 and never reaches the service', async () => {
    const valid = sign('order_rzp_1', 'pay_1');
    const wrong = (valid[0] === '0' ? '1' : '0') + valid.slice(1);
    const { next, promise } = callVerify({
      razorpay_order_id: 'order_rzp_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: wrong,
      order_id: 'order-1',
    });
    await promise;
    expect(mockService.verifyAndMarkPaid).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 400, code: 'INVALID_SIGNATURE' });
  });

  test('odd-length hex signature is rejected with 400', async () => {
    const { next, promise } = callVerify({
      razorpay_order_id: 'order_rzp_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: 'abc',
      order_id: 'order-1',
    });
    await promise;
    expect(mockService.verifyAndMarkPaid).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0]).toMatchObject({ status: 400, code: 'INVALID_SIGNATURE' });
  });

  test('non-hex signature is rejected with 400', async () => {
    const { next, promise } = callVerify({
      razorpay_order_id: 'order_rzp_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
      order_id: 'order-1',
    });
    await promise;
    expect(mockService.verifyAndMarkPaid).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0]).toMatchObject({ status: 400, code: 'INVALID_SIGNATURE' });
  });

  test('missing secret fails closed with 503', async () => {
    delete process.env.RAZORPAY_KEY_SECRET;
    const { next, promise } = callVerify({
      razorpay_order_id: 'order_rzp_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: sign('order_rzp_1', 'pay_1'),
      order_id: 'order-1',
    });
    await promise;
    expect(mockService.verifyAndMarkPaid).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0]).toMatchObject({ status: 503, code: 'PAYMENT_UNAVAILABLE' });
  });

  test('missing fields are rejected with 400', async () => {
    const { next, promise } = callVerify({ order_id: 'order-1' });
    await promise;
    expect(mockService.verifyAndMarkPaid).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0]).toMatchObject({ status: 400, code: 'MISSING_FIELDS' });
  });
});

describe('createMarketplaceOrder (POST /api/orders)', () => {
  let controller;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    controller = require('../controllers/escrowController');
  });

  function callCreate(body, headers = {}) {
    const req = { body, headers, user: { id: 'buyer-1' } };
    const res = mockRes();
    const next = jest.fn();
    return { req, res, next, promise: controller.createMarketplaceOrder(req, res, next) };
  }

  test('creates the order server-side and returns 201', async () => {
    const order = { id: 'order-1', status: 'PENDING', total_price: 100 };
    mockService.createMarketplaceOrder.mockResolvedValue(order);
    const { res, next, promise } = callCreate(
      { product_id: 'prod-1', quantity: 2, unit: 'kg', delivery_address: 'Village X' },
      { 'idempotency-key': 'key-1' },
    );
    await promise;
    expect(mockService.createMarketplaceOrder).toHaveBeenCalledWith('buyer-1', {
      product_id: 'prod-1', quantity: 2, unit: 'kg', delivery_address: 'Village X',
    }, 'key-1');
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(order);
    expect(next).not.toHaveBeenCalled();
  });

  test('client-supplied totals are never forwarded to the service', async () => {
    mockService.createMarketplaceOrder.mockResolvedValue({ id: 'order-1' });
    const { promise } = callCreate({
      product_id: 'prod-1', quantity: 2, total_price: 1, farmer_id: 'attacker', delivery_address: 'Village X',
    });
    await promise;
    const forwarded = mockService.createMarketplaceOrder.mock.calls[0][1];
    expect(forwarded).not.toHaveProperty('total_price');
    expect(forwarded).not.toHaveProperty('farmer_id');
  });

  test('missing fields are rejected with 400 before the service is called', async () => {
    const { next, promise } = callCreate({ product_id: 'prod-1' });
    await promise;
    expect(mockService.createMarketplaceOrder).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0]).toMatchObject({ status: 400, code: 'MISSING_FIELDS' });
  });

  test('service errors reach the error handler', async () => {
    mockService.createMarketplaceOrder.mockRejectedValue(
      Object.assign(new Error('no stock'), { status: 409, code: 'INSUFFICIENT_STOCK' }),
    );
    const { next, promise } = callCreate({ product_id: 'prod-1', quantity: 999, delivery_address: 'Village X' });
    await promise;
    expect(next.mock.calls[0][0]).toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' });
  });
});
