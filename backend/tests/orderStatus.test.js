'use strict';

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.RAZORPAY_KEY_ID = 'rzp_test';
process.env.RAZORPAY_KEY_SECRET = 'test-secret';

const mockHolder = { client: null };
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mockHolder.client }));
jest.mock('razorpay', () => jest.fn().mockImplementation(() => ({ orders: {}, payments: {} })));

function query(data) {
  const q = {
    select: () => q,
    eq: () => q,
    then: (resolve) => Promise.resolve({ data, error: null }).then(resolve),
  };
  return q;
}

describe('farmer order approval', () => {
  let service;
  let order;
  let rpc;

  beforeEach(() => {
    jest.resetModules();
    order = { id: 'order-1', buyer_id: 'buyer-1', farmer_id: 'farmer-1', status: 'PENDING' };
    rpc = jest.fn(async () => ({ data: [{ ...order, status: 'CONFIRMED' }], error: null }));
    mockHolder.client = { from: () => ({ select: () => query([order]) }), rpc };
    service = require('../services/escrowService');
  });

  test('uses one database transaction for stock reservation and approval', async () => {
    const result = await service.updateOrderStatusWithStock('order-1', 'farmer-1', 'CONFIRMED');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('confirm_order_and_reserve_stock', {
      p_order_id: 'order-1', p_farmer_id: 'farmer-1',
    });
    expect(result.status).toBe('CONFIRMED');
  });

  test('reports insufficient stock without approving the order', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'INSUFFICIENT_STOCK' } });
    await expect(service.updateOrderStatusWithStock('order-1', 'farmer-1', 'CONFIRMED'))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK', status: 409 });
  });
});
