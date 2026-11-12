'use strict';
/**
 * FairPrice routes (Stage 3, module B) — route unit.
 *
 * TDD: written FIRST and watched RED (router module not found) before
 * any implementation. Route tests invoke the handlers directly — no
 * supertest dependency is added — and prove the guards are actually
 * mounted (same pattern as notificationRoutes.test.js). The fairPrice
 * service is mocked: the route's own job is auth, validation, and
 * passing the caller's id through — not the normalisation/query logic
 * (see fairPriceService.test.js).
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const mockHolder = { supabase: { auth: { getUser: async () => ({ data: { user: null }, error: { message: 'no user' } }) } } };

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => mockHolder.supabase,
}));
jest.mock('../services/fairPriceService', () => ({
  SOURCE: 'Agmarknet / data.gov.in',
  normaliseCommodity: jest.fn((c) => String(c || '').trim()),
  getLatestPrice: jest.fn(),
  getHistory: jest.fn(),
  getNearbyMandis: jest.fn(),
  getCostParams: jest.fn(),
  computeNetEarnings: jest.fn(),
  listCostParams: jest.fn(),
  listAlerts: jest.fn(),
  createAlert: jest.fn(),
  deleteAlert: jest.fn(),
}));

const fairPriceService = require('../services/fairPriceService');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

function routeList(routes) {
  return routes.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`)
    .sort();
}

function findRoute(routes, method, routePath) {
  return routes.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method.toLowerCase()],
  );
}

function runLayer(layer, req) {
  return new Promise((resolve) => {
    const res = mockRes();
    const next = (err) => resolve({ res, err });
    res.json = (...args) => { resolve({ res, err: null, jsonArgs: args }); return res; };
    res.status = (code) => { res.statusCode = code; return res; };
    layer(req, res, next);
  });
}

function handlerOf(routes, method, routePath) {
  const layer = findRoute(routes, method, routePath);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

describe('routes mount the right guards', () => {
  test('the router exposes exactly the seven fairprice routes', () => {
    const routes = require('../routes/fairPriceRoutes');
    expect(routeList(routes)).toEqual([
      'DELETE /alerts/:id',
      'GET /:commodity',
      'GET /:commodity/history',
      'GET /:commodity/net-earnings',
      'GET /alerts',
      'GET /cost-params',
      'POST /alerts',
    ]);
  });

  test('/alerts routes sit behind requireAuth (unauthenticated callers get 401)', async () => {
    const routes = require('../routes/fairPriceRoutes');
    for (const [method, routePath] of [['get', '/alerts'], ['post', '/alerts'], ['delete', '/alerts/:id']]) {
      const layer = findRoute(routes, method, routePath);
      const authLayer = layer.route.stack.find((l) => l.name === 'requireAuth');
      expect(authLayer).toBeDefined();
      const { err } = await runLayer(authLayer.handle, { headers: {} });
      expect(err).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    }
  });

  test('price reads are PUBLIC — no requireAuth layer on /:commodity or /:commodity/history', () => {
    const routes = require('../routes/fairPriceRoutes');
    for (const [method, routePath] of [['get', '/:commodity'], ['get', '/:commodity/history']]) {
      const layer = findRoute(routes, method, routePath);
      expect(layer.route.stack.find((l) => l.name === 'requireAuth')).toBeUndefined();
    }
  });

  test('every route carries its own per-route rateLimit layer', () => {
    const routes = require('../routes/fairPriceRoutes');
    for (const [method, routePath] of [['get', '/:commodity'], ['get', '/:commodity/history'], ['get', '/:commodity/net-earnings'], ['get', '/cost-params'], ['get', '/alerts'], ['post', '/alerts'], ['delete', '/alerts/:id']]) {
      const layer = findRoute(routes, method, routePath);
      expect(layer.route.stack.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('/cost-params is PUBLIC — no requireAuth layer', () => {
    const routes = require('../routes/fairPriceRoutes');
    const layer = findRoute(routes, 'get', '/cost-params');
    expect(layer.route.stack.find((l) => l.name === 'requireAuth')).toBeUndefined();
  });
});

describe('GET /:commodity', () => {
  beforeEach(() => jest.clearAllMocks());

  test('no data -> { no_data: true, message: no data reported today }, never a number', async () => {
    const routes = require('../routes/fairPriceRoutes');
    fairPriceService.getLatestPrice.mockResolvedValue(null);
    const handler = handlerOf(routes, 'get', '/:commodity');
    const { res, jsonArgs } = await runLayer(handler, { params: { commodity: 'Wheat' }, query: {} });
    expect(res.statusCode).toBe(200);
    expect(jsonArgs[0]).toMatchObject({ no_data: true, message: 'no data reported today', source: 'Agmarknet / data.gov.in' });
    expect(fairPriceService.getNearbyMandis).not.toHaveBeenCalled();
  });

  test('data -> latest + nearby + change + avg7 in one payload', async () => {
    const routes = require('../routes/fairPriceRoutes');
    fairPriceService.getLatestPrice.mockResolvedValue({
      commodity: 'Onion', date: '2026-11-12', source: 'Agmarknet / data.gov.in',
      primary: { modal_price: 5400 }, prices: [{ modal_price: 5400 }],
    });
    fairPriceService.getNearbyMandis.mockResolvedValue([{ mandi: 'Kochi', modal_price: 5300 }]);
    fairPriceService.getHistory.mockResolvedValue({ change_pct_vs_yesterday: 2.5, avg7_modal: 5200 });
    const handler = handlerOf(routes, 'get', '/:commodity');
    const { jsonArgs } = await runLayer(handler, { params: { commodity: 'Onion' }, query: { state: 'Kerala' } });
    expect(jsonArgs[0]).toMatchObject({
      no_data: false, commodity: 'Onion', change_pct_vs_yesterday: 2.5, avg7_modal: 5200,
    });
    expect(jsonArgs[0].nearby).toHaveLength(1);
    expect(fairPriceService.getLatestPrice).toHaveBeenCalledWith('Onion', { state: 'Kerala', mandi: undefined });
  });

  test('empty commodity -> 400', async () => {
    const routes = require('../routes/fairPriceRoutes');
    const handler = handlerOf(routes, 'get', '/:commodity');
    const { err } = await runLayer(handler, { params: { commodity: '   ' }, query: {} });
    expect(err).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });
});

describe('GET /:commodity/history', () => {
  test('passes days/state/mandi through and returns the series', async () => {
    const routes = require('../routes/fairPriceRoutes');
    fairPriceService.getHistory.mockResolvedValue({ commodity: 'Onion', series: [], change_pct_vs_yesterday: null, avg7_modal: null });
    const handler = handlerOf(routes, 'get', '/:commodity/history');
    const { jsonArgs } = await runLayer(handler, { params: { commodity: 'Onion' }, query: { days: '7', state: 'Kerala' } });
    expect(fairPriceService.getHistory).toHaveBeenCalledWith('Onion', { state: 'Kerala', mandi: undefined, days: 7 });
    expect(jsonArgs[0]).toMatchObject({ commodity: 'Onion', source: 'Agmarknet / data.gov.in' });
  });
});

describe('GET /:commodity/net-earnings', () => {
  beforeEach(() => jest.clearAllMocks());

  const LATEST = {
    commodity: 'Onion', date: '2026-11-12', source: 'Agmarknet / data.gov.in',
    primary: { modal_price: 5400, mandi: 'Mukkom Market', unit: 'quintal' },
  };

  test('happy path returns the modal + the computed earnings', async () => {
    const routes = require('../routes/fairPriceRoutes');
    fairPriceService.getLatestPrice.mockResolvedValue(LATEST);
    fairPriceService.getCostParams.mockResolvedValue({ version: 1, transport_paise_per_quintal: 5000 });
    fairPriceService.computeNetEarnings.mockReturnValue({ net: 49474, estimated: true });
    const handler = handlerOf(routes, 'get', '/:commodity/net-earnings');
    const { jsonArgs } = await runLayer(handler, { params: { commodity: 'Onion' }, query: { quantity: '10' } });
    expect(fairPriceService.computeNetEarnings).toHaveBeenCalledWith({
      modalPriceRupees: 5400, quantityQuintals: 10, costParams: { version: 1, transport_paise_per_quintal: 5000 },
    });
    expect(jsonArgs[0]).toMatchObject({ commodity: 'Onion', modal_price: 5400, quantity_quintals: 10, earnings: { net: 49474 } });
  });

  test('unit=kg converts to quintals (1000 kg = 10 qtl)', async () => {
    const routes = require('../routes/fairPriceRoutes');
    fairPriceService.getLatestPrice.mockResolvedValue(LATEST);
    fairPriceService.getCostParams.mockResolvedValue({ version: 1 });
    fairPriceService.computeNetEarnings.mockReturnValue({ net: 49474 });
    const handler = handlerOf(routes, 'get', '/:commodity/net-earnings');
    await runLayer(handler, { params: { commodity: 'Onion' }, query: { quantity: '1000', unit: 'kg' } });
    expect(fairPriceService.computeNetEarnings).toHaveBeenCalledWith(
      expect.objectContaining({ quantityQuintals: 10 }),
    );
  });

  test('no mandi price -> { no_data: true }, never a number', async () => {
    const routes = require('../routes/fairPriceRoutes');
    fairPriceService.getLatestPrice.mockResolvedValue(null);
    const handler = handlerOf(routes, 'get', '/:commodity/net-earnings');
    const { jsonArgs } = await runLayer(handler, { params: { commodity: 'Wheat' }, query: { quantity: '5' } });
    expect(jsonArgs[0]).toMatchObject({ no_data: true, message: 'no data reported today' });
    expect(fairPriceService.computeNetEarnings).not.toHaveBeenCalled();
  });

  test('no cost params yet -> { no_params: true }', async () => {
    const routes = require('../routes/fairPriceRoutes');
    fairPriceService.getLatestPrice.mockResolvedValue(LATEST);
    fairPriceService.getCostParams.mockResolvedValue(null);
    const handler = handlerOf(routes, 'get', '/:commodity/net-earnings');
    const { jsonArgs } = await runLayer(handler, { params: { commodity: 'Onion' }, query: { quantity: '5' } });
    expect(jsonArgs[0]).toMatchObject({ no_params: true, modal_price: 5400 });
  });

  test('missing or bad quantity -> 400', async () => {
    const routes = require('../routes/fairPriceRoutes');
    const handler = handlerOf(routes, 'get', '/:commodity/net-earnings');
    for (const query of [{}, { quantity: '0' }, { quantity: '-3' }, { quantity: 'abc' }, { quantity: '5', unit: 'tonne' }]) {
      const { err } = await runLayer(handler, { params: { commodity: 'Onion' }, query });
      expect(err).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    }
  });
});

describe('GET /cost-params', () => {
  test('returns the current parameters', async () => {
    const routes = require('../routes/fairPriceRoutes');
    fairPriceService.listCostParams.mockResolvedValue([{ id: 'c1', version: 1 }]);
    const handler = handlerOf(routes, 'get', '/cost-params');
    const { jsonArgs } = await runLayer(handler, {});
    expect(jsonArgs[0]).toEqual({ params: [{ id: 'c1', version: 1 }] });
  });
});

describe('alerts', () => {
  beforeEach(() => jest.clearAllMocks());

  test('POST /alerts creates with the caller id and answers 201', async () => {
    const routes = require('../routes/fairPriceRoutes');
    fairPriceService.createAlert.mockResolvedValue({ id: 'a1', commodity: 'Wheat' });
    const handler = handlerOf(routes, 'post', '/alerts');
    const { res, jsonArgs } = await runLayer(handler, {
      user: { id: 'u1' },
      body: { commodity: 'Wheat', threshold_pct: 10, basis: 'yesterday', direction: 'rise' },
    });
    expect(res.statusCode).toBe(201);
    expect(fairPriceService.createAlert).toHaveBeenCalledWith('u1', { commodity: 'Wheat', threshold_pct: 10, basis: 'yesterday', direction: 'rise' });
    expect(jsonArgs[0]).toMatchObject({ alert: { id: 'a1' } });
  });

  test('POST /alerts passes service validation errors to next()', async () => {
    const routes = require('../routes/fairPriceRoutes');
    const err = Object.assign(new Error('bad basis'), { status: 400, code: 'VALIDATION_ERROR' });
    fairPriceService.createAlert.mockRejectedValue(err);
    const handler = handlerOf(routes, 'post', '/alerts');
    const { err: out } = await runLayer(handler, { user: { id: 'u1' }, body: {} });
    expect(out).toBe(err);
  });

  test('GET /alerts lists the caller’s alerts', async () => {
    const routes = require('../routes/fairPriceRoutes');
    fairPriceService.listAlerts.mockResolvedValue([{ id: 'a1' }]);
    const handler = handlerOf(routes, 'get', '/alerts');
    const { jsonArgs } = await runLayer(handler, { user: { id: 'u1' } });
    expect(fairPriceService.listAlerts).toHaveBeenCalledWith('u1');
    expect(jsonArgs[0]).toEqual({ alerts: [{ id: 'a1' }] });
  });

  test('DELETE /alerts/:id deletes the caller’s own alert and answers 200', async () => {
    const routes = require('../routes/fairPriceRoutes');
    fairPriceService.deleteAlert.mockResolvedValue({ id: 'a1', commodity: 'Wheat' });
    const handler = handlerOf(routes, 'delete', '/alerts/:id');
    const { res, jsonArgs } = await runLayer(handler, { user: { id: 'u1' }, params: { id: 'a1' } });
    expect(res.statusCode).toBe(200);
    expect(fairPriceService.deleteAlert).toHaveBeenCalledWith('u1', 'a1');
    expect(jsonArgs[0]).toMatchObject({ alert: { id: 'a1' } });
  });

  test('DELETE /alerts/:id passes another user’s 404 to next()', async () => {
    const routes = require('../routes/fairPriceRoutes');
    const err = Object.assign(new Error('not found'), { status: 404, code: 'ALERT_NOT_FOUND' });
    fairPriceService.deleteAlert.mockRejectedValue(err);
    const handler = handlerOf(routes, 'delete', '/alerts/:id');
    const { err: out } = await runLayer(handler, { user: { id: 'u1' }, params: { id: 'a2' } });
    expect(out).toBe(err);
  });
});
