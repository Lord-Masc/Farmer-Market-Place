'use strict';
/**
 * Admin & transparency routes (Stage 10, module I) — route unit.
 *
 * TDD: written FIRST and watched RED (the new routes and the
 * transparency router do not exist yet) before any implementation.
 * Route tests invoke the handlers directly — no supertest dependency
 * is added — and prove the guards are actually mounted (same pattern
 * as notificationRoutes.test.js / assistant.test.js). The metrics and
 * moderation services are mocked: the route's own job is auth,
 * validation and passing the caller's id through — not the service
 * logic (see adminStage10.test.js).
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const fs = require('fs');
const path = require('path');

const mockHolder = {
  // Default stubs: the routers capture the createClient return value at
  // require time, so this object must exist before the first require and
  // is MUTATED (never reassigned) by the tests below.
  supabase: {
    auth: {
      getUser: async () => ({ data: { user: null }, error: { message: 'no user' } }),
    },
  },
  admin: {
    from: () => ({
      select: () => ({
        eq: async () => ({ data: [], error: null }),
      }),
    }),
  },
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => mockHolder.supabase,
}));
jest.mock('../utils/supabaseAdmin', () => ({
  from: (...args) => mockHolder.admin.from(...args),
}));
jest.mock('../services/adminMetricsService', () => ({
  getPlatformMetrics: jest.fn(),
  getStuckMoney: jest.fn(),
}));
jest.mock('../services/moderationService', () => ({
  suspendUser: jest.fn(),
  reinstateUser: jest.fn(),
  lookupUser: jest.fn(),
}));
jest.mock('../services/fairPriceService', () => ({
  listCostParams: jest.fn(),
  createCostParams: jest.fn(),
  updateCostParams: jest.fn(),
}));

const adminMetricsService = require('../services/adminMetricsService');
const moderationService = require('../services/moderationService');
const fairPriceService = require('../services/fairPriceService');
const { AppError } = require('../utils/errors');
// Routers are required ONCE at the top (no jest.resetModules in this
// file): the mocked services above are the same instances the routers
// capture, so per-test mockResolvedValue calls land on the right object.
const adminRoutes = require('../routes/adminRoutes');
const transparencyRoutes = require('../routes/transparencyRoutes');

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
    const fn = typeof layer === 'function' ? layer : layer.handle;
    const res = mockRes();
    const next = (err) => resolve({ res, err });
    res.json = (...args) => { resolve({ res, err: null, jsonArgs: args }); return res; };
    res.status = (code) => { res.statusCode = code; return res; };
    fn(req, res, next);
  });
}

function runHandler(routes, method, routePath, req) {
  const layer = findRoute(routes, method, routePath);
  const handler = layer.route.stack[layer.route.stack.length - 1];
  return runLayer(handler, req);
}

const METRICS_FIXTURE = {
  total_orders: 6,
  gmv_paise: 230000,
  median_realisation_paise: 22500,
  mandi_modal_paise: null,
  dispute_rate: 0.3333,
  dispute_count: 2,
  avg_resolution_hours: 24,
  on_time_rate: 0.5,
  group_selling: { groups_total: 3, groups_closed: 2, pooled_quantity: 600, pooled_gmv_paise: 90000 },
  notification_delivery: { sent: 5, failed: 1, deferred: 2, pending: 3 },
};

describe('admin router', () => {
  let routes;

  beforeEach(() => {
    jest.clearAllMocks();
    // Mutate the stub in place: requireAuth captured this exact object
    // when the router was required above, so reassigning it would not
    // take effect. (supabaseAdmin is delegated at call time, so the
    // admin mock MAY be reassigned — see the guard test.)
    mockHolder.supabase.auth.getUser = async (token) => {
      if (token === 'admin-token') return { data: { user: { id: 'admin1', email: 'admin@test' } }, error: null };
      return { data: { user: null }, error: { message: 'invalid token' } };
    };
    mockHolder.admin = {
      from: () => ({
        select: () => ({
          eq: async () => ({ data: [{ role: 'admin' }], error: null }),
        }),
      }),
    };
    routes = adminRoutes;
  });

  test('the router exposes exactly the Stage 1 routes plus the Stage 10 routes plus the Stage 3 cost-params routes', () => {
    expect(routeList(routes)).toEqual([
      'GET /cost-params',
      'GET /metrics',
      'GET /reconciliation',
      'GET /roles',
      'GET /verifications',
      'GET /verifications/:id/document',
      'POST /moderation/:userId/reinstate',
      'POST /moderation/:userId/suspend',
      'GET /moderation/:query',
      'POST /roles/:userId',
      'POST /verifications/:id/approve',
      'POST /verifications/:id/reject',
      'POST /cost-params',
      'PATCH /cost-params/:id',
    ].sort());
  });

  test('every admin route sits behind requireAuth + requireAdmin (router-level layers)', async () => {
    // router.use(requireAuth, requireAdmin) registers two layers before any route.
    expect(routes.stack[0].handle.name).toBe('requireAuth');
    const adminLayer = routes.stack[1];
    expect(typeof adminLayer.handle).toBe('function');
    // Unauthenticated caller -> 401 from the first layer.
    const unauth = await runLayer(routes.stack[0], { headers: {} });
    expect(unauth.err).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    // A buyer profile -> 403 from the admin layer.
    mockHolder.admin = {
      from: () => ({
        select: () => ({
          eq: async () => ({ data: [{ role: 'buyer' }], error: null }),
        }),
      }),
    };
    const buyer = await runLayer(adminLayer, { user: { id: 'buyer1' } });
    expect(buyer.err).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    // An admin profile passes.
    mockHolder.admin = {
      from: () => ({
        select: () => ({
          eq: async () => ({ data: [{ role: 'admin' }], error: null }),
        }),
      }),
    };
    const admin = await runLayer(adminLayer, { user: { id: 'admin1' } });
    expect(admin.err).toBeFalsy();
  });

  test('GET /metrics returns { metrics } from the service', async () => {
    adminMetricsService.getPlatformMetrics.mockResolvedValue({ ...METRICS_FIXTURE });
    const { jsonArgs, err } = await runHandler(routes, 'GET', '/metrics', { user: { id: 'admin1' } });
    expect(err).toBeNull();
    expect(jsonArgs[0]).toEqual({ metrics: METRICS_FIXTURE });
  });

  test('GET /reconciliation returns { stuck } from the service', async () => {
    const stuck = [
      { order_id: 'o-conf', category: 'confirmed_unpaid', amount_paise: 50000, order_status: 'CONFIRMED', payment_status: null, created_at: '2026-11-10T10:00:00.000Z' },
    ];
    adminMetricsService.getStuckMoney.mockResolvedValue(stuck);
    const { jsonArgs, err } = await runHandler(routes, 'GET', '/reconciliation', { user: { id: 'admin1' } });
    expect(err).toBeNull();
    expect(jsonArgs[0]).toEqual({ stuck });
  });

  test('POST /moderation/:userId/suspend passes the admin id and target through, exact shape', async () => {
    const result = {
      user: { id: 'farmer1', role: 'farmer', suspended_at: '2026-11-12T15:00:00.000Z' },
      listings_hidden: 2,
    };
    moderationService.suspendUser.mockResolvedValue(result);
    const { jsonArgs, err } = await runHandler(routes, 'POST', '/moderation/:userId/suspend', {
      user: { id: 'admin1' }, params: { userId: 'farmer1' },
    });
    expect(err).toBeNull();
    expect(moderationService.suspendUser).toHaveBeenCalledWith('admin1', 'farmer1');
    expect(jsonArgs[0]).toEqual(result);
  });

  test('POST /moderation/:userId/reinstate passes through, exact shape', async () => {
    const result = {
      user: { id: 'farmer1', role: 'farmer', suspended_at: null },
      listings_restored: 2,
    };
    moderationService.reinstateUser.mockResolvedValue(result);
    const { jsonArgs, err } = await runHandler(routes, 'POST', '/moderation/:userId/reinstate', {
      user: { id: 'admin1' }, params: { userId: 'farmer1' },
    });
    expect(err).toBeNull();
    expect(moderationService.reinstateUser).toHaveBeenCalledWith('admin1', 'farmer1');
    expect(jsonArgs[0]).toEqual(result);
  });

  test('a service 409 (e.g. self-suspend) reaches next, not a 200', async () => {
    moderationService.suspendUser.mockRejectedValue(new AppError(409, 'SELF_SUSPEND', 'An admin cannot suspend their own account.'));
    const { err } = await runHandler(routes, 'POST', '/moderation/:userId/suspend', {
      user: { id: 'admin1' }, params: { userId: 'admin1' },
    });
    expect(err).toMatchObject({ status: 409, code: 'SELF_SUSPEND' });
  });

  test('GET /moderation/:query passes the query through and returns { user }', async () => {
    const result = { user: { id: 'farmer1', role: 'farmer', suspended_at: null } };
    moderationService.lookupUser.mockResolvedValue(result);
    const { jsonArgs, err } = await runHandler(routes, 'GET', '/moderation/:query', {
      user: { id: 'admin1' }, params: { query: 'farmer1@test' },
    });
    expect(err).toBeNull();
    expect(moderationService.lookupUser).toHaveBeenCalledWith('farmer1@test');
    expect(jsonArgs[0]).toEqual(result);
  });

  test('GET /moderation/:query propagates the generic 404 for an unknown user', async () => {
    moderationService.lookupUser.mockRejectedValue(new AppError(404, 'USER_NOT_FOUND', 'User not found.'));
    const { err } = await runHandler(routes, 'GET', '/moderation/:query', {
      user: { id: 'admin1' }, params: { query: 'nobody@test' },
    });
    expect(err).toMatchObject({ status: 404, code: 'USER_NOT_FOUND' });
  });

  // Stage 3 cost parameters (module B): the net-earnings assumptions.
  // The router's job is passing the admin id + body through; the
  // versioning lives in the service (see fairPriceService.test.js).
  test('GET /cost-params returns { params }', async () => {
    const params = [{ id: 'c1', version: 1, is_current: true, transport_paise_per_quintal: 5000 }];
    fairPriceService.listCostParams.mockResolvedValue(params);
    const { jsonArgs, err } = await runHandler(routes, 'GET', '/cost-params', { user: { id: 'admin1' } });
    expect(err).toBeNull();
    expect(jsonArgs[0]).toEqual({ params });
  });

  test('POST /cost-params creates with the admin id and answers 201', async () => {
    const param = { id: 'c1', version: 1, is_current: true };
    fairPriceService.createCostParams.mockResolvedValue(param);
    const body = { transport_paise_per_quintal: 5000, commission_pct: 2, packaging_paise_per_quintal: 2000, platform_fee_paise_per_quintal: 1000, wastage_pct: 5 };
    const { res, jsonArgs, err } = await runHandler(routes, 'POST', '/cost-params', { user: { id: 'admin1' }, body });
    expect(err).toBeNull();
    expect(res.statusCode).toBe(201);
    expect(fairPriceService.createCostParams).toHaveBeenCalledWith('admin1', body);
    expect(jsonArgs[0]).toEqual({ param });
  });

  test('PATCH /cost-params/:id versions with the admin id and body', async () => {
    const param = { id: 'c2', version: 2, is_current: true };
    fairPriceService.updateCostParams.mockResolvedValue(param);
    const body = { commission_pct: 3 };
    const { jsonArgs, err } = await runHandler(routes, 'PATCH', '/cost-params/:id', {
      user: { id: 'admin1' }, params: { id: 'c1' }, body,
    });
    expect(err).toBeNull();
    expect(fairPriceService.updateCostParams).toHaveBeenCalledWith('c1', 'admin1', body);
    expect(jsonArgs[0]).toEqual({ param });
  });

  test('POST /cost-params passes a 409 (scope already exists) to next()', async () => {
    fairPriceService.createCostParams.mockRejectedValue(new AppError(409, 'COST_PARAMS_EXIST', 'Cost parameters already exist for this scope.'));
    const { err } = await runHandler(routes, 'POST', '/cost-params', {
      user: { id: 'admin1' }, body: { transport_paise_per_quintal: 5000 },
    });
    expect(err).toMatchObject({ status: 409, code: 'COST_PARAMS_EXIST' });
  });
});

describe('transparency router (public)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('the router exposes exactly GET / and mounts no requireAuth layer', () => {
    expect(routeList(transparencyRoutes)).toEqual(['GET /']);
    const names = transparencyRoutes.stack
      .flatMap((l) => (l.route ? l.route.stack : [l]))
      .map((l) => l.handle && l.handle.name)
      .filter(Boolean);
    expect(names).not.toContain('requireAuth');
    expect(names).not.toContain('requireAdmin');
  });

  test('GET / returns the same aggregated metrics shape, with no personal data anywhere', async () => {
    adminMetricsService.getPlatformMetrics.mockResolvedValue({ ...METRICS_FIXTURE });
    const { jsonArgs, err } = await runHandler(transparencyRoutes, 'GET', '/', {});
    expect(err).toBeNull();
    expect(jsonArgs[0]).toEqual({ metrics: METRICS_FIXTURE });
    const blob = JSON.stringify(jsonArgs[0]).toLowerCase();
    for (const word of ['email', 'phone', 'first_name', 'last_name', 'address', 'user_id', 'buyer', 'farmer']) {
      expect(blob).not.toContain(word);
    }
    expect(Object.keys(jsonArgs[0].metrics).sort()).toEqual([
      'avg_resolution_hours', 'dispute_count', 'dispute_rate', 'gmv_paise',
      'group_selling', 'mandi_modal_paise', 'median_realisation_paise',
      'notification_delivery', 'on_time_rate', 'total_orders',
    ].sort());
  });

  test('server.js mounts /api/transparency publicly with its own rate limit', () => {
    const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    expect(server).toContain('transparencyRoutes');
    expect(server).toContain("'/api/transparency'");
    expect(server).toContain('rateLimit({ max: 60 })');
  });
});
