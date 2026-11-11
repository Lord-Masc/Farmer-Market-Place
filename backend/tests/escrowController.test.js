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
