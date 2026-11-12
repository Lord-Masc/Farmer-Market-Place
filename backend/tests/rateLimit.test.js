'use strict';
/**
 * Per-route rate limiting (Stage 0, M5): the limiter factory behind the
 * global cap and the stricter per-route caps in server.js. A spent budget
 * answers 429 with a Retry-After hint; different IPs get separate buckets.
 */

const { rateLimit } = require('../middleware/security');

function mockRes() {
  const res = { headers: {}, statusCode: null, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (code) => {
    res.statusCode = code;
    return { json: (body) => { res.body = body; } };
  };
  return res;
}

function runLimiter(limiter, ip) {
  const req = { ip, connection: { remoteAddress: ip } };
  const res = mockRes();
  let nextCalled = false;
  limiter(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

describe('rateLimit', () => {
  test('allows requests within the budget', () => {
    const limiter = rateLimit({ windowMs: 60000, max: 3 });
    for (let i = 0; i < 3; i++) {
      expect(runLimiter(limiter, '1.2.3.4').nextCalled).toBe(true);
    }
  });

  test('returns 429 with Retry-After once the budget is spent', () => {
    const limiter = rateLimit({ windowMs: 60000, max: 3 });
    for (let i = 0; i < 3; i++) runLimiter(limiter, '1.2.3.4');
    const { res, nextCalled } = runLimiter(limiter, '1.2.3.4');
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(res.headers['Retry-After']).toBeDefined();
  });

  test('different IPs get separate budgets', () => {
    const limiter = rateLimit({ windowMs: 60000, max: 2 });
    runLimiter(limiter, '1.1.1.1');
    runLimiter(limiter, '1.1.1.1');
    expect(runLimiter(limiter, '2.2.2.2').nextCalled).toBe(true);
    expect(runLimiter(limiter, '1.1.1.1').nextCalled).toBe(false);
  });
});
