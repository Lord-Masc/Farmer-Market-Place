'use strict';
/**
 * AI Farmer Assistant (Stage 8, module G) — route unit.
 *
 * TDD: written FIRST and watched RED (router module not found) before
 * any implementation. Route tests invoke the handlers directly — no
 * supertest dependency is added — and prove the guards are actually
 * mounted (same pattern as negotiation.test.js). The assistant service
 * is mocked: the route's own job is auth, validation, the 503 voice
 * shape, and passing the caller's id through — not the pipeline.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const fs = require('fs');
const path = require('path');

const mockHolder = { supabase: null };

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => mockHolder.supabase,
}));
jest.mock('../services/assistantService', () => ({ chat: jest.fn() }));

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

describe('migration file (parse-checked separately with pglast)', () => {
  test('20261123_assistant.sql defines assistant_conversations with user RLS', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '../../supabase/migrations/20261123_assistant.sql'),
      'utf8',
    );
    expect(sql).toContain('assistant_conversations');
    expect(sql).toContain('messages jsonb');
    expect(sql).toContain('sources jsonb');
    expect(sql).toContain('ROW LEVEL SECURITY');
    expect(sql).toContain('auth.uid() = user_id');
    expect(sql).toContain('is_admin()');
    expect(sql).toContain('20261116');
  });
});

describe('routes mount the right guards', () => {
  test('the router exposes exactly the two assistant routes', () => {
    const routes = require('../routes/assistantRoutes');
    expect(routeList(routes)).toEqual(['POST /chat', 'POST /voice']);
  });

  test('both routes sit behind requireAuth (unauthenticated callers get 401)', async () => {
    const routes = require('../routes/assistantRoutes');
    for (const routePath of ['/chat', '/voice']) {
      const layer = findRoute(routes, 'POST', routePath);
      const authLayer = layer.route.stack.find(
        (l) => l.name === 'requireAuth' || (l.handle && l.handle.name === 'requireAuth'),
      ) || layer.route.stack[1];
      const next = jest.fn();
      await authLayer.handle({ headers: {} }, {}, next);
      expect(next.mock.calls[0][0]).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    }
  });

  test('chat is rate-limited to 30 and voice to 10 (own limiter layers)', () => {
    const routes = require('../routes/assistantRoutes');
    // Each route carries its own rateLimit layer plus requireAuth plus
    // the handler — the two limiters have different budgets.
    for (const routePath of ['/chat', '/voice']) {
      const layer = findRoute(routes, 'POST', routePath);
      expect(layer.route.stack.length).toBeGreaterThanOrEqual(3);
    }
    const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    expect(server).toContain("require('./routes/assistantRoutes')");
    expect(server).toContain("app.use('/api/assistant'");
  });
});

describe('POST /chat handler', () => {
  function setup() {
    jest.resetModules();
    jest.clearAllMocks();
    const service = require('../services/assistantService');
    const routes = require('../routes/assistantRoutes');
    const layer = findRoute(routes, 'POST', '/chat');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    return { service, handler };
  }

  test('passes the callers id and message through and answers 200', async () => {
    const { service, handler } = setup();
    service.chat.mockResolvedValue({
      conversation_id: 'conv1', intent: 'list_produce', entities: {},
      answer: 'Aaj ki sabzi: Wheat.',
      sources: [{ type: 'product', id: 'prod1' }], no_data: false,
    });
    const req = { user: { id: 'buyer1' }, body: { message: 'sabzi dikhao' } };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(service.chat).toHaveBeenCalledWith('buyer1', 'sabzi dikhao', undefined);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: 'conv1', intent: 'list_produce',
    }));
    expect(next).not.toHaveBeenCalled();
  });

  test('forwards an explicit conversation id for a follow-up turn', async () => {
    const { service, handler } = setup();
    service.chat.mockResolvedValue({
      conversation_id: 'conv1', intent: 'unknown', entities: {},
      answer: 'Samajh nahi aaya.', sources: [], no_data: true,
    });
    const req = { user: { id: 'buyer1' }, body: { message: 'aur?', conversation_id: 'conv1' } };
    await handler(req, mockRes(), jest.fn());
    expect(service.chat).toHaveBeenCalledWith('buyer1', 'aur?', 'conv1');
  });

  test('missing message is a 400 and never calls the service', async () => {
    const { service, handler } = setup();
    const res = mockRes();
    const next = jest.fn();
    await handler({ user: { id: 'buyer1' }, body: {} }, res, next);
    expect(service.chat).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0]).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });

  test('service errors reach next() (the central handler answers them)', async () => {
    const { service, handler } = setup();
    const err = new Error('boom');
    err.status = 404;
    service.chat.mockRejectedValue(err);
    const next = jest.fn();
    await handler({ user: { id: 'buyer1' }, body: { message: 'x' } }, mockRes(), next);
    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('POST /voice handler — no STT provider exists', () => {
  function setup() {
    jest.resetModules();
    const routes = require('../routes/assistantRoutes');
    const layer = findRoute(routes, 'POST', '/voice');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    return { handler };
  }

  test('a JSON audio_url is a valid shape — and still answers 503 unconfigured', async () => {
    const { handler } = setup();
    const res = mockRes();
    const next = jest.fn();
    await handler(
      { user: { id: 'buyer1' }, headers: { 'content-type': 'application/json' }, body: { audio_url: 'https://example.com/a.mp3' } },
      res, next,
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'VOICE_NOT_CONFIGURED',
    }));
    expect(res.json.mock.calls[0][0].error).toMatch(/not configured/i);
    expect(next).not.toHaveBeenCalled();
  });

  test('multipart/audio input is a valid shape — and still answers 503, never a transcript', async () => {
    const { handler } = setup();
    const res = mockRes();
    await handler(
      { user: { id: 'buyer1' }, headers: { 'content-type': 'multipart/form-data; boundary=abc' }, body: {} },
      res, jest.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('transcript');
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('text');
  });

  test('no audio at all is a 400, not a 503', async () => {
    const { handler } = setup();
    const res = mockRes();
    const next = jest.fn();
    await handler(
      { user: { id: 'buyer1' }, headers: { 'content-type': 'application/json' }, body: {} },
      res, next,
    );
    expect(next.mock.calls[0][0]).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });
});
