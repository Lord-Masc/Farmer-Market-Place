'use strict';
/**
 * Notifications (Stage 9, module H) — route unit.
 *
 * TDD: written FIRST and watched RED (router module not found) before
 * any implementation. Route tests invoke the handlers directly — no
 * supertest dependency is added — and prove the guards are actually
 * mounted (same pattern as assistant.test.js). The notification
 * service is mocked: the route's own job is auth, validation, and
 * passing the caller's id through — not the emit/worker logic (see
 * notifications.test.js).
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const fs = require('fs');
const path = require('path');

const mockHolder = { supabase: { auth: { getUser: async () => ({ data: { user: null }, error: { message: 'no user' } }) } } };

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => mockHolder.supabase,
}));
jest.mock('../services/notificationService', () => ({
  emit: jest.fn(),
  getPreferences: jest.fn(),
  upsertPreferences: jest.fn(),
  markRead: jest.fn(),
  listNotifications: jest.fn(),
}));

const notificationService = require('../services/notificationService');

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
    res.json = (...args) => { res.json.mockReturnThis(); resolve({ res, err: null, jsonArgs: args }); return res; };
    res.status = (code) => { res.statusCode = code; return res; };
    layer(req, res, next);
  });
}

describe('routes mount the right guards', () => {
  test('the router exposes exactly the four notification routes', () => {
    const routes = require('../routes/notificationRoutes');
    expect(routeList(routes)).toEqual([
      'GET /',
      'GET /preferences',
      'PATCH /:id/read',
      'PATCH /preferences',
    ]);
  });

  test('every route sits behind requireAuth (unauthenticated callers get 401)', async () => {
    const routes = require('../routes/notificationRoutes');
    for (const [method, routePath] of [['get', '/'], ['patch', '/:id/read'], ['get', '/preferences'], ['patch', '/preferences']]) {
      const layer = findRoute(routes, method, routePath);
      const authLayer = layer.route.stack.find((l) => l.name === 'requireAuth')
        || layer.route.stack[1];
      const { err } = await runLayer(authLayer.handle, { headers: {} });
      expect(err).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    }
  });

  test('every route carries its own per-route rateLimit layer', () => {
    const routes = require('../routes/notificationRoutes');
    for (const [method, routePath] of [['get', '/'], ['patch', '/:id/read'], ['get', '/preferences'], ['patch', '/preferences']]) {
      const layer = findRoute(routes, method, routePath);
      expect(layer.route.stack.length).toBeGreaterThanOrEqual(3);
    }
  });

  test('server.js mounts the router at /api/notifications', () => {
    const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    expect(server).toContain("require('./routes/notificationRoutes')");
    expect(server).toContain("app.use('/api/notifications'");
  });
});

describe('notification route handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function handlerFor(method, routePath) {
    const routes = require('../routes/notificationRoutes');
    const layer = findRoute(routes, method, routePath);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }

  test('GET / lists with the query params passed through and returns the service shape', async () => {
    notificationService.listNotifications.mockResolvedValue({
      notifications: [{ id: 'n1', type: 'order_created' }], unread_count: 1,
    });
    const handler = handlerFor('get', '/');
    const req = { user: { id: 'buyer1' }, query: { unread_only: 'true', limit: '20', offset: '0' } };
    const res = mockRes();
    await handler(req, res, (err) => { throw err; });
    expect(notificationService.listNotifications).toHaveBeenCalledWith('buyer1', {
      unreadOnly: true, limit: 20, offset: 0,
    });
    expect(res.json).toHaveBeenCalledWith({
      notifications: [{ id: 'n1', type: 'order_created' }], unread_count: 1,
    });
  });

  test('PATCH /:id/read marks the row read and returns { notification }', async () => {
    notificationService.markRead.mockResolvedValue({ id: 'n1', read_at: '2026-11-12T10:00:00.000Z' });
    const handler = handlerFor('patch', '/:id/read');
    const req = { user: { id: 'buyer1' }, params: { id: 'n1' } };
    const res = mockRes();
    await handler(req, res, (err) => { throw err; });
    expect(notificationService.markRead).toHaveBeenCalledWith('buyer1', 'n1');
    expect(res.json).toHaveBeenCalledWith({ notification: { id: 'n1', read_at: '2026-11-12T10:00:00.000Z' } });
  });

  test('GET /preferences returns the service rows', async () => {
    notificationService.getPreferences.mockResolvedValue([
      { event_type: 'order_paid', enabled: true, channels: ['in_app'], language: 'hi' },
    ]);
    const handler = handlerFor('get', '/preferences');
    const req = { user: { id: 'buyer1' } };
    const res = mockRes();
    await handler(req, res, (err) => { throw err; });
    expect(notificationService.getPreferences).toHaveBeenCalledWith('buyer1');
    expect(res.json).toHaveBeenCalledWith({
      preferences: [{ event_type: 'order_paid', enabled: true, channels: ['in_app'], language: 'hi' }],
    });
  });

  test('PATCH /preferences upserts the posted rows and returns them', async () => {
    const rows = [{ event_type: 'order_paid', enabled: false, channels: ['in_app'], language: 'en' }];
    notificationService.upsertPreferences.mockResolvedValue(rows);
    const handler = handlerFor('patch', '/preferences');
    const req = { user: { id: 'buyer1' }, body: { preferences: rows } };
    const res = mockRes();
    await handler(req, res, (err) => { throw err; });
    expect(notificationService.upsertPreferences).toHaveBeenCalledWith('buyer1', rows);
    expect(res.json).toHaveBeenCalledWith({ preferences: rows });
  });

  test('PATCH /preferences with a non-array body is a 400, never a crash', async () => {
    const handler = handlerFor('patch', '/preferences');
    const req = { user: { id: 'buyer1' }, body: { preferences: 'nope' } };
    const res = mockRes();
    let caught = null;
    await handler(req, res, (err) => { caught = err; });
    expect(caught).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(notificationService.upsertPreferences).not.toHaveBeenCalled();
  });
});
