'use strict';
/**
 * Digital Crop Passport (Stage 2, module A) — migration + backend unit.
 *
 * Service functions are tested against the same in-memory Supabase mock
 * pattern as verification.test.js (eq/in filters, order/range, exact
 * counts). Route tests invoke the handlers directly — no supertest
 * dependency is added — and prove the guards are actually mounted.
 *
 * Stats fixture (hand-checked, literals — NOT derived from the code):
 * farmer1 has 5 orders:
 *   o1 DELIVERED  deadline 2026-11-10, completed 2026-11-09 -> on time
 *   o2 COMPLETED  deadline 2026-11-10, completed 2026-11-10 -> on time (<=)
 *   o3 COMPLETED  deadline 2026-11-10, completed 2026-11-12 -> late
 *   o4 REFUNDED   no deadline / completed_at (refund-flow dispute)
 *   o5 PAID       deadline 2026-11-20, completed_at null
 * Hand computation: total_orders 5; deliveries 3 (o1,o2,o3); on-time
 * denominator 3 (o1,o2,o3 have deadline + completed_at), on time 2 -> 2/3;
 * dispute denominator 5 (all five are paid-or-beyond), disputes 1 (o4) -> 0.2.
 * The seeded farmer_stats row is what the SQL view must return for these
 * orders; the service only passes the view row through.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const mockHolder = { supabase: null };

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => mockHolder.supabase,
}));

function makeSupabaseMock(db) {
  function matches(row, filters) {
    for (const f of filters) {
      if (f.type === 'eq' && row[f.col] !== f.val) return false;
      if (f.type === 'in' && !f.val.includes(row[f.col])) return false;
    }
    return true;
  }

  function execute(q) {
    const table = db[q.table];
    if (!table) return { data: null, error: { message: `table ${q.table} does not exist` } };
    if (q.op === 'select') {
      let rows = table.filter((r) => matches(r, q.filters));
      if (q.orderBy) {
        const { col, ascending } = q.orderBy;
        rows = [...rows].sort((a, b) => {
          const av = a[col] ?? '';
          const bv = b[col] ?? '';
          if (av === bv) return 0;
          return ascending ? (av < bv ? -1 : 1) : (av > bv ? -1 : 1);
        });
      }
      const count = q.countExact ? rows.length : null;
      if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
      if (q.limit != null) rows = rows.slice(0, q.limit);
      return { data: rows, count, error: null };
    }
    if (q.op === 'update') {
      const matched = table.filter((r) => matches(r, q.filters));
      for (const r of matched) Object.assign(r, q.fields);
      return { data: matched, error: null };
    }
    if (q.op === 'insert') {
      const row = { id: `id_${Math.random().toString(36).slice(2)}`, ...q.row };
      table.push(row);
      return { data: [row], error: null };
    }
    return { data: null, error: { message: 'unsupported op' } };
  }

  function builder(table) {
    const q = { table, op: null, fields: null, row: null, filters: [], limit: null, orderBy: null, range: null, countExact: false };
    const api = {
      select(_cols, opts) { if (!q.op) q.op = 'select'; if (opts && opts.count === 'exact') q.countExact = true; return api; },
      update(fields) { q.op = 'update'; q.fields = fields; return api; },
      insert(row) { q.op = 'insert'; q.row = row; return api; },
      eq(col, val) { q.filters.push({ type: 'eq', col, val }); return api; },
      in(col, val) { q.filters.push({ type: 'in', col, val }); return api; },
      limit(n) { q.limit = n; return api; },
      order(col, { ascending = true } = {}) { q.orderBy = { col, ascending }; return api; },
      range(from, to) { q.range = [from, to]; return api; },
      then(resolve, reject) {
        return new Promise((res) => setTimeout(res, 1)).then(() => execute(q)).then(resolve, reject);
      },
    };
    return api;
  }

  return { from: (table) => builder(table) };
}

function seedDb() {
  return {
    profiles: [
      { id: 'farmer1', first_name: 'Suresh', last_name: 'Singh', city: 'Jaipur', state: 'Rajasthan', role: 'farmer', verification_status: 'verified', verified_at: '2026-11-05T00:00:00.000Z', created_at: '2026-11-01T00:00:00.000Z' },
      { id: 'farmer2', first_name: 'Meena', last_name: 'Devi', city: 'Kota', state: 'Rajasthan', role: 'farmer', verification_status: 'unverified', verified_at: null, created_at: '2026-11-02T00:00:00.000Z' },
      { id: 'farmer3', first_name: 'Arjun', last_name: 'Patel', city: 'Udaipur', state: 'Rajasthan', role: 'farmer', verification_status: 'verified', verified_at: '2026-11-05T00:00:00.000Z', created_at: '2026-11-03T00:00:00.000Z' },
      { id: 'buyer1', first_name: 'Ramesh', last_name: 'Kumar', city: 'Delhi', state: 'Delhi', role: 'buyer', verification_status: 'unverified', verified_at: null, created_at: '2026-11-04T00:00:00.000Z' },
    ],
    products: [
      { id: 'prod1', farmer_id: 'farmer1', name: 'Wheat', gov_price: 2500 },
      { id: 'prod2', farmer_id: 'farmer1', name: 'Rice', gov_price: 0 },
      { id: 'prod3', farmer_id: 'farmer2', name: 'Maize', gov_price: 1800 },
      { id: 'prod4', farmer_id: 'farmer1', name: 'Bajra', gov_price: 3200 },
    ],
    crop_passports: [
      { id: 'pass1', product_id: 'prod1', farmer_id: 'farmer1', crop: 'Wheat', variety: 'HD-2967', quantity: 100, unit: 'kg', harvest_date: '2026-10-20', quality_grade: 'A', photos: ['https://example.test/wheat.jpg'], mandi_price_reference: 2500, created_at: '2026-11-06T00:00:00.000Z' },
      // farmer2 holds a passport row but is unverified — the public
      // endpoints must never leak it.
      { id: 'pass3', product_id: 'prod3', farmer_id: 'farmer2', crop: 'Maize', variety: null, quantity: 50, unit: 'kg', harvest_date: '2026-10-18', quality_grade: 'B', photos: [], mandi_price_reference: 1800, created_at: '2026-11-06T00:00:00.000Z' },
    ],
    orders: [
      { id: 'o1', farmer_id: 'farmer1', status: 'DELIVERED', delivery_deadline: '2026-11-10T00:00:00.000Z', completed_at: '2026-11-09T00:00:00.000Z' },
      { id: 'o2', farmer_id: 'farmer1', status: 'COMPLETED', delivery_deadline: '2026-11-10T00:00:00.000Z', completed_at: '2026-11-10T00:00:00.000Z' },
      { id: 'o3', farmer_id: 'farmer1', status: 'COMPLETED', delivery_deadline: '2026-11-10T00:00:00.000Z', completed_at: '2026-11-12T00:00:00.000Z' },
      { id: 'o4', farmer_id: 'farmer1', status: 'REFUNDED', delivery_deadline: null, completed_at: null },
      { id: 'o5', farmer_id: 'farmer1', status: 'PAID', delivery_deadline: '2026-11-20T00:00:00.000Z', completed_at: null },
      { id: 'o6', farmer_id: 'farmer2', status: 'PAID', delivery_deadline: '2026-11-20T00:00:00.000Z', completed_at: null },
    ],
    // Hand-computed view output for the orders above (see file header).
    farmer_stats: [
      { farmer_id: 'farmer1', total_orders: 5, deliveries: 3, on_time_rate: 2 / 3, dispute_rate: 0.2 },
      { farmer_id: 'farmer2', total_orders: 1, deliveries: 0, on_time_rate: null, dispute_rate: 0 },
    ],
    audit_log: [],
  };
}

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

const VALID_BODY = {
  product_id: 'prod2',
  crop: 'Rice',
  variety: 'Basmati',
  quantity: 50,
  unit: 'kg',
  harvest_date: '2026-10-20',
  quality_grade: 'A',
  photos: ['https://example.test/rice.jpg'],
};

describe('passportService.createPassport', () => {
  let service;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    service = require('../services/passportService');
  });

  test('happy path snapshots gov_price and audits the creation', async () => {
    const row = await service.createPassport('farmer1', { ...VALID_BODY, product_id: 'prod4' });
    expect(row.product_id).toBe('prod4');
    expect(row.farmer_id).toBe('farmer1');
    expect(row.mandi_price_reference).toBe(3200);
    expect(row.crop).toBe('Rice');
    expect(db.crop_passports).toHaveLength(3);
    expect(db.audit_log).toHaveLength(1);
    expect(db.audit_log[0].event).toBe('passport.created');
    expect(db.audit_log[0].actor_id).toBe('farmer1');
  });

  test('gov_price 0 stores a NULL mandi price — never invents one', async () => {
    const row = await service.createPassport('farmer1', { ...VALID_BODY });
    expect(row.mandi_price_reference).toBeNull();
  });

  test('variety is optional', async () => {
    const body = { ...VALID_BODY };
    delete body.variety;
    const row = await service.createPassport('farmer1', body);
    expect(row.variety).toBeNull();
  });

  test('photos default to an empty array', async () => {
    const body = { ...VALID_BODY };
    delete body.photos;
    const row = await service.createPassport('farmer1', body);
    expect(row.photos).toEqual([]);
  });

  test("another farmer's product is a 403", async () => {
    await expect(service.createPassport('farmer1', { ...VALID_BODY, product_id: 'prod3' }))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(db.crop_passports).toHaveLength(2);
  });

  test('a missing product is a 403, not a 404 — no existence oracle', async () => {
    await expect(service.createPassport('farmer1', { ...VALID_BODY, product_id: 'no-such-product' }))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  test('a duplicate passport for the same product is a 409', async () => {
    await expect(service.createPassport('farmer1', { ...VALID_BODY, product_id: 'prod1' }))
      .rejects.toMatchObject({ status: 409, code: 'PASSPORT_EXISTS' });
    expect(db.crop_passports).toHaveLength(2);
  });

  test('bad grade is a 422', async () => {
    await expect(service.createPassport('farmer1', { ...VALID_BODY, quality_grade: 'D' }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createPassport('farmer1', { ...VALID_BODY, quality_grade: 'a' }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
  });

  test('a future harvest date is a 422', async () => {
    await expect(service.createPassport('farmer1', { ...VALID_BODY, harvest_date: '2999-01-01' }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
  });

  test('an invalid harvest date is a 422', async () => {
    await expect(service.createPassport('farmer1', { ...VALID_BODY, harvest_date: 'not-a-date' }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createPassport('farmer1', { ...VALID_BODY, harvest_date: '2026-13-40' }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
  });

  test('quantity <= 0 is a 422', async () => {
    await expect(service.createPassport('farmer1', { ...VALID_BODY, quantity: 0 }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createPassport('farmer1', { ...VALID_BODY, quantity: -5 }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createPassport('farmer1', { ...VALID_BODY, quantity: 'abc' }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
  });

  test('more than 5 photos is a 422', async () => {
    const photos = Array.from({ length: 6 }, (_, i) => `https://example.test/p${i}.jpg`);
    await expect(service.createPassport('farmer1', { ...VALID_BODY, photos }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
  });

  test('a non-http(s) photo URL is a 422', async () => {
    await expect(service.createPassport('farmer1', { ...VALID_BODY, photos: ['ftp://example.test/x.jpg'] }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createPassport('farmer1', { ...VALID_BODY, photos: ['not-a-url'] }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
  });

  test('empty crop and oversized strings are 422s', async () => {
    await expect(service.createPassport('farmer1', { ...VALID_BODY, crop: '  ' }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createPassport('farmer1', { ...VALID_BODY, crop: 'x'.repeat(121) }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createPassport('farmer1', { ...VALID_BODY, variety: 'x'.repeat(121) }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createPassport('farmer1', { ...VALID_BODY, unit: '' }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createPassport('farmer1', { ...VALID_BODY, unit: 'x'.repeat(21) }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
  });
});

describe('passportService.listMyPassports', () => {
  let service;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    service = require('../services/passportService');
  });

  test("returns only the caller's lots with product names and hand-checked stats", async () => {
    const result = await service.listMyPassports('farmer1');
    expect(result.lots).toHaveLength(1);
    expect(result.lots[0].product_name).toBe('Wheat');
    expect(result.lots[0].mandi_price_reference).toBe(2500);
    expect(result.stats).toEqual({
      farmer_id: 'farmer1', total_orders: 5, deliveries: 3, on_time_rate: 2 / 3, dispute_rate: 0.2,
    });
  });

  test("a farmer's own lots are returned even while unverified — /mine is their own data", async () => {
    const result = await service.listMyPassports('farmer2');
    expect(result.lots).toHaveLength(1);
    expect(result.lots[0].id).toBe('pass3');
    expect(result.lots[0].product_name).toBe('Maize');
    expect(result.stats).toEqual({
      farmer_id: 'farmer2', total_orders: 1, deliveries: 0, on_time_rate: null, dispute_rate: 0,
    });
  });

  test('stats are null when the farmer has zero orders', async () => {
    const result = await service.listMyPassports('farmer3');
    expect(result.lots).toEqual([]);
    expect(result.stats).toBeNull();
  });
});

describe('passportService.getFarmerPassport (public)', () => {
  let service;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    service = require('../services/passportService');
  });

  test("a verified farmer's passport returns farmer fields, stats and lots", async () => {
    const result = await service.getFarmerPassport('farmer1');
    expect(result.farmer).toEqual({
      id: 'farmer1', first_name: 'Suresh', last_name: 'Singh',
      city: 'Jaipur', state: 'Rajasthan',
      verification_status: 'verified', verified_at: '2026-11-05T00:00:00.000Z',
    });
    expect(result.stats).toEqual({
      farmer_id: 'farmer1', total_orders: 5, deliveries: 3, on_time_rate: 2 / 3, dispute_rate: 0.2,
    });
    expect(result.lots).toHaveLength(1);
    expect(result.lots[0].product_name).toBe('Wheat');
    expect(result.lots[0].mandi_price_reference).toBe(2500);
  });

  test('an unverified farmer is a 404 with the generic message', async () => {
    await expect(service.getFarmerPassport('farmer2'))
      .rejects.toMatchObject({ status: 404, code: 'PASSPORT_NOT_FOUND', message: 'Passport not found.' });
  });

  test('a missing farmer is the same 404 — never distinguishable', async () => {
    await expect(service.getFarmerPassport('ghost'))
      .rejects.toMatchObject({ status: 404, code: 'PASSPORT_NOT_FOUND', message: 'Passport not found.' });
  });
});

describe('passportService.getProductPassport (public)', () => {
  let service;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    service = require('../services/passportService');
  });

  test('a verified farmer with a passport returns the lot', async () => {
    const result = await service.getProductPassport('prod1');
    expect(result).toEqual({
      product_id: 'prod1', farmer_verified: true,
      passport: expect.objectContaining({ id: 'pass1', crop: 'Wheat', mandi_price_reference: 2500 }),
    });
  });

  test('a verified farmer without a passport returns passport null', async () => {
    const result = await service.getProductPassport('prod2');
    expect(result).toEqual({ product_id: 'prod2', farmer_verified: true, passport: null });
  });

  test('an unverified farmer hides the lot entirely', async () => {
    const result = await service.getProductPassport('prod3');
    expect(result).toEqual({ product_id: 'prod3', farmer_verified: false, passport: null });
  });

  test('a missing product is a 404', async () => {
    await expect(service.getProductPassport('ghost'))
      .rejects.toMatchObject({ status: 404, code: 'PASSPORT_NOT_FOUND' });
  });
});

describe('routes mount the right guards', () => {
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
  });

  function routeList(routes) {
    return routes.stack
      .filter((l) => l.route)
      .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`)
      .sort();
  }

  test('the router exposes exactly the four passport routes', () => {
    const passportRoutes = require('../routes/passportRoutes');
    expect(routeList(passportRoutes)).toEqual([
      'GET /farmers/:id/passport',
      'GET /passports/mine',
      'GET /products/:id/passport',
      'POST /passports',
    ].sort());
  });

  test('POST /passports sits behind requireAuth and the farmer role', async () => {
    const passportRoutes = require('../routes/passportRoutes');
    const postLayer = passportRoutes.stack.find((l) => l.route && l.route.path === '/passports');
    expect(postLayer.route.stack).toHaveLength(3);
    const [authLayer, farmerLayer] = postLayer.route.stack;
    // No token at all -> 401 from requireAuth.
    const nextAuth = jest.fn();
    await authLayer.handle({ headers: {} }, {}, nextAuth);
    expect(nextAuth.mock.calls[0][0]).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    // A buyer JWT -> 403 from the farmer role gate.
    const nextRole = jest.fn();
    await farmerLayer.handle({ user: { id: 'buyer1' } }, {}, nextRole);
    expect(nextRole.mock.calls[0][0]).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    // A farmer JWT passes both gates.
    const nextFarmer = jest.fn();
    await farmerLayer.handle({ user: { id: 'farmer1' } }, {}, nextFarmer);
    expect(nextFarmer).toHaveBeenCalledWith();
  });

  test('GET /passports/mine sits behind the same two guards', () => {
    const passportRoutes = require('../routes/passportRoutes');
    const mineLayer = passportRoutes.stack.find((l) => l.route && l.route.path === '/passports/mine');
    expect(mineLayer.route.stack).toHaveLength(3);
  });

  test('the two public routes have no auth guard at all', () => {
    const passportRoutes = require('../routes/passportRoutes');
    for (const path of ['/farmers/:id/passport', '/products/:id/passport']) {
      const layer = passportRoutes.stack.find((l) => l.route && l.route.path === path);
      expect(layer.route.stack).toHaveLength(1);
    }
  });

  test('POST /passports handler creates the passport and answers 201', async () => {
    const passportRoutes = require('../routes/passportRoutes');
    const postLayer = passportRoutes.stack.find((l) => l.route && l.route.path === '/passports');
    const handler = postLayer.route.stack[2].handle;
    const req = { user: { id: 'farmer1' }, body: { ...VALID_BODY, product_id: 'prod4' } };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ product_id: 'prod4', mandi_price_reference: 3200 }));
    expect(db.crop_passports).toHaveLength(3);
  });

  test('POST /passports handler forwards a duplicate as next(err) 409', async () => {
    const passportRoutes = require('../routes/passportRoutes');
    const postLayer = passportRoutes.stack.find((l) => l.route && l.route.path === '/passports');
    const handler = postLayer.route.stack[2].handle;
    const req = { user: { id: 'farmer1' }, body: { ...VALID_BODY, product_id: 'prod1' } };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 409, code: 'PASSPORT_EXISTS' });
    expect(res.status).not.toHaveBeenCalled();
  });

  test('GET /passports/mine handler returns the caller’s lots and stats', async () => {
    const passportRoutes = require('../routes/passportRoutes');
    const mineLayer = passportRoutes.stack.find((l) => l.route && l.route.path === '/passports/mine');
    const handler = mineLayer.route.stack[2].handle;
    const req = { user: { id: 'farmer1' } };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      lots: [expect.objectContaining({ id: 'pass1', product_name: 'Wheat' })],
      stats: { farmer_id: 'farmer1', total_orders: 5, deliveries: 3, on_time_rate: 2 / 3, dispute_rate: 0.2 },
    });
  });

  test('GET /farmers/:id/passport handler answers 200 for a verified farmer', async () => {
    const passportRoutes = require('../routes/passportRoutes');
    const layer = passportRoutes.stack.find((l) => l.route && l.route.path === '/farmers/:id/passport');
    const handler = layer.route.stack[0].handle;
    const req = { params: { id: 'farmer1' } };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      farmer: expect.objectContaining({ id: 'farmer1', verification_status: 'verified' }),
      stats: expect.objectContaining({ total_orders: 5 }),
      lots: [expect.objectContaining({ id: 'pass1' })],
    }));
  });

  test('GET /farmers/:id/passport handler forwards the generic 404 for an unverified farmer', async () => {
    const passportRoutes = require('../routes/passportRoutes');
    const layer = passportRoutes.stack.find((l) => l.route && l.route.path === '/farmers/:id/passport');
    const handler = layer.route.stack[0].handle;
    const req = { params: { id: 'farmer2' } };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 404, message: 'Passport not found.' });
  });

  test('GET /products/:id/passport handler answers 200 and hides an unverified lot', async () => {
    const passportRoutes = require('../routes/passportRoutes');
    const layer = passportRoutes.stack.find((l) => l.route && l.route.path === '/products/:id/passport');
    const handler = layer.route.stack[0].handle;
    const res = mockRes();
    const next = jest.fn();
    await handler({ params: { id: 'prod1' } }, res, next);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ product_id: 'prod1', farmer_verified: true }));
    expect(res.json.mock.calls[0][0].passport).toMatchObject({ id: 'pass1' });
    const res2 = mockRes();
    const next2 = jest.fn();
    await handler({ params: { id: 'prod3' } }, res2, next2);
    expect(res2.json).toHaveBeenCalledWith({ product_id: 'prod3', farmer_verified: false, passport: null });
  });
});
