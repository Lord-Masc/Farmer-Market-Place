'use strict';
/**
 * Negotiation (Stage 4, module C) — migration + backend unit.
 *
 * Service functions are tested against the same in-memory Supabase mock
 * pattern as passport.test.js (eq/in filters, order/range, exact counts),
 * plus the idempotency_keys 23505 simulation from orderCreation.test.js.
 * Route tests invoke the handlers directly — no supertest dependency is
 * added — and prove the guards are actually mounted.
 *
 * Locked-price fixture (hand-checked, literals — NOT derived from the
 * code): prod1 lists Wheat at 2200/kg. Offer off1 locks 2200 for 10 kg.
 * Acceptance must create exactly one order with price_at_order 2200 and
 * total_price 22000 — even after the listing is edited to 2600.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_mock';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'test-secret';

const fs = require('fs');
const path = require('path');

const mockHolder = { supabase: null, razorpay: null };

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => mockHolder.supabase,
}));
jest.mock('razorpay', () => jest.fn().mockImplementation(() => mockHolder.razorpay));

function makeSupabaseMock(db) {
  function matches(row, filters) {
    for (const f of filters) {
      if (f.type === 'eq' && row[f.col] !== f.val) return false;
      if (f.type === 'in' && !f.val.includes(row[f.col])) return false;
      if (f.type === 'is') {
        if (f.val === null) {
          if (row[f.col] !== null && row[f.col] !== undefined) return false;
        } else if (row[f.col] !== f.val) return false;
      }
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
      if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
      if (q.limit != null) rows = rows.slice(0, q.limit);
      return { data: rows, error: null };
    }
    if (q.op === 'update') {
      const matched = table.filter((r) => matches(r, q.filters));
      for (const r of matched) Object.assign(r, q.fields);
      return { data: matched, error: null };
    }
    if (q.op === 'insert') {
      if (q.table === 'idempotency_keys' && table.some((r) => r.key === q.row.key && r.user_id === q.row.user_id)) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "idempotency_keys_pkey"' } };
      }
      const row = { id: `id_${Math.random().toString(36).slice(2)}`, ...q.row };
      table.push(row);
      return { data: [row], error: null };
    }
    return { data: null, error: { message: 'unsupported op' } };
  }

  function builder(table) {
    const q = { table, op: null, fields: null, row: null, filters: [], limit: null, orderBy: null, range: null };
    const api = {
      select() { if (!q.op) q.op = 'select'; return api; },
      update(fields) { q.op = 'update'; q.fields = fields; return api; },
      insert(row) { q.op = 'insert'; q.row = row; return api; },
      eq(col, val) { q.filters.push({ type: 'eq', col, val }); return api; },
      in(col, val) { q.filters.push({ type: 'in', col, val }); return api; },
      is(col, val) { q.filters.push({ type: 'is', col, val }); return api; },
      limit(n) { q.limit = n; return api; },
      order(col, { ascending = true } = {}) { q.orderBy = { col, ascending }; return api; },
      range(from, to) { q.range = [from, to]; return api; },
      then(resolve, reject) {
        return new Promise((res) => setTimeout(res, 1)).then(() => execute(q)).then(resolve, reject);
      },
    };
    return api;
  }

  return { from: (table) => builder(table), rpc: async () => ({ data: null, error: { message: 'unknown function' } }) };
}

function seedDb() {
  return {
    profiles: [
      { id: 'buyer1', first_name: 'Ramesh', last_name: 'Kumar', phone_number: '9999999999', role: 'buyer', verification_status: 'unverified' },
      { id: 'buyer2', first_name: 'Anita', last_name: 'Sharma', phone_number: '7777777777', role: 'buyer', verification_status: 'unverified' },
      { id: 'farmer1', first_name: 'Suresh', last_name: 'Singh', phone_number: '8888888888', role: 'farmer', verification_status: 'verified' },
      { id: 'farmer2', first_name: 'Meena', last_name: 'Devi', phone_number: '6666666666', role: 'farmer', verification_status: 'verified' },
      { id: 'farmer3', first_name: 'Arjun', last_name: 'Patel', phone_number: '5555555555', role: 'farmer', verification_status: 'verified' },
      { id: 'admin1', first_name: 'Admin', last_name: 'User', phone_number: null, role: 'admin', verification_status: 'verified' },
    ],
    products: [
      { id: 'prod1', farmer_id: 'farmer1', name: 'Wheat', user_price: 2200, price: 2200, quantity: 500 },
      { id: 'prod2', farmer_id: 'farmer2', name: 'Wheat', user_price: 2300, price: 2300, quantity: 500 },
      { id: 'prod3', farmer_id: 'farmer1', name: 'Rice', user_price: 3000, price: 3000, quantity: 100 },
    ],
    requirements: [
      {
        id: 'req1', buyer_id: 'buyer1', crop: 'Wheat', quantity: 100, quality: 'A grade',
        delivery_window_start: '2027-02-01', delivery_window_end: '2027-02-10',
        target_price: 2000, status: 'open', created_at: '2026-11-12T00:00:00.000Z',
      },
    ],
    offers: [
      {
        id: 'off1', requirement_id: 'req1', farmer_id: 'farmer1', created_by: 'farmer1',
        product_id: 'prod1', price: 2200, quantity: 10, price_tiers: [],
        expires_at: '2027-01-01T00:00:00.000Z', status: 'open',
        created_at: '2026-11-12T00:00:00.000Z',
      },
      {
        id: 'off-expired', requirement_id: 'req1', farmer_id: 'farmer1', created_by: 'farmer1',
        product_id: 'prod1', price: 2100, quantity: 5, price_tiers: [],
        expires_at: '2020-01-01T00:00:00.000Z', status: 'open',
        created_at: '2026-11-12T00:00:00.000Z',
      },
      {
        id: 'off2', requirement_id: 'req1', farmer_id: 'farmer2', created_by: 'farmer2',
        product_id: 'prod2', price: 2300, quantity: 10, price_tiers: [],
        expires_at: '2027-01-01T00:00:00.000Z', status: 'open',
        created_at: '2026-11-12T00:00:00.000Z',
      },
    ],
    agreements: [],
    orders: [],
    idempotency_keys: [],
    audit_log: [],
  };
}

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

function setup() {
  jest.resetModules();
  const db = seedDb();
  mockHolder.supabase = makeSupabaseMock(db);
  mockHolder.razorpay = { orders: { create: jest.fn(), fetch: jest.fn() }, payments: { fetch: jest.fn() } };
  return { db, service: require('../services/negotiationService') };
}

const VALID_REQUIREMENT = {
  crop: 'Rice',
  quantity: 50,
  quality: 'A grade',
  delivery_window_start: '2027-03-01',
  delivery_window_end: '2027-03-10',
  target_price: 2500,
};

const VALID_OFFER = {
  product_id: 'prod3',
  price: 2800,
  quantity: 20,
  price_tiers: [{ min_quantity: 50, price: 2700 }],
  expires_at: '2027-01-15T00:00:00.000Z',
};

const ACCEPT_BODY = { delivery_address: 'Village X, Mathura' };

describe('fairPriceAnchor (Stage 3 integration point)', () => {
  test('returns null today — Stage 3 has not wired mandi_prices yet', () => {
    jest.resetModules();
    const { getFairPriceAnchor } = require('../services/fairPriceAnchor');
    expect(getFairPriceAnchor('Wheat')).toBeNull();
  });
});

describe('negotiationService.createRequirement', () => {
  test('happy path stores the requirement open and audits it', async () => {
    const { db, service } = setup();
    const row = await service.createRequirement('buyer1', { ...VALID_REQUIREMENT });
    expect(row.buyer_id).toBe('buyer1');
    expect(row.crop).toBe('Rice');
    expect(row.status).toBe('open');
    expect(db.requirements).toHaveLength(2);
    expect(db.audit_log).toHaveLength(1);
    expect(db.audit_log[0]).toMatchObject({ event: 'requirement.created', actor_id: 'buyer1' });
  });

  test('bad crop, quantity, target price and delivery window are 422s', async () => {
    const { db, service } = setup();
    await expect(service.createRequirement('buyer1', { ...VALID_REQUIREMENT, crop: '  ' }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createRequirement('buyer1', { ...VALID_REQUIREMENT, quantity: 0 }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createRequirement('buyer1', { ...VALID_REQUIREMENT, target_price: -5 }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createRequirement('buyer1', { ...VALID_REQUIREMENT, delivery_window_end: '2027-02-01' }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createRequirement('buyer1', { ...VALID_REQUIREMENT, delivery_window_start: '2027-13-40' }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    expect(db.requirements).toHaveLength(1);
  });
});

describe('negotiationService.createOffer', () => {
  test('happy path stores the open offer and audits it', async () => {
    const { db, service } = setup();
    const row = await service.createOffer('farmer1', 'req1', { ...VALID_OFFER });
    expect(row.requirement_id).toBe('req1');
    expect(row.farmer_id).toBe('farmer1');
    expect(row.created_by).toBe('farmer1');
    expect(row.status).toBe('open');
    expect(row.price_tiers).toEqual([{ min_quantity: 50, price: 2700 }]);
    expect(db.offers).toHaveLength(4);
    expect(db.audit_log).toHaveLength(1);
    expect(db.audit_log[0]).toMatchObject({ event: 'offer.created', actor_id: 'farmer1' });
  });

  test("another farmer's product is a 403 — no existence oracle", async () => {
    const { db, service } = setup();
    await expect(service.createOffer('farmer1', 'req1', { ...VALID_OFFER, product_id: 'prod2' }))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await expect(service.createOffer('farmer1', 'req1', { ...VALID_OFFER, product_id: 'no-such-product' }))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(db.offers).toHaveLength(3);
  });

  test('a missing requirement is a 404', async () => {
    const { service } = setup();
    await expect(service.createOffer('farmer1', 'ghost', { ...VALID_OFFER }))
      .rejects.toMatchObject({ status: 404, code: 'NEGOTIATION_NOT_FOUND' });
  });

  test('bad price, quantity, tiers and a past expiry are 422s', async () => {
    const { db, service } = setup();
    await expect(service.createOffer('farmer1', 'req1', { ...VALID_OFFER, price: 0 }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createOffer('farmer1', 'req1', { ...VALID_OFFER, quantity: -1 }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createOffer('farmer1', 'req1', { ...VALID_OFFER, expires_at: '2020-01-01T00:00:00.000Z' }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createOffer('farmer1', 'req1', { ...VALID_OFFER, price_tiers: [{ min_quantity: 0, price: 100 }] }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createOffer('farmer1', 'req1', { ...VALID_OFFER, product_id: undefined }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    expect(db.offers).toHaveLength(3);
  });
});

describe('negotiationService.counterOffer', () => {
  test('a counter invalidates the previous offer and opens the new one', async () => {
    const { db, service } = setup();
    const row = await service.counterOffer('buyer1', 'off1', {
      price: 2100, quantity: 10, expires_at: '2027-01-20T00:00:00.000Z',
    });
    expect(row.requirement_id).toBe('req1');
    expect(row.farmer_id).toBe('farmer1');
    expect(row.created_by).toBe('buyer1');
    expect(row.price).toBe(2100);
    expect(row.status).toBe('open');
    expect(db.offers.find((o) => o.id === 'off1').status).toBe('countered');
    expect(db.offers).toHaveLength(4);
    const events = db.audit_log.map((a) => a.event);
    expect(events).toContain('offer.countered');
    expect(events).toContain('offer.created');
  });

  test('the maker cannot counter their own offer, and a third party cannot either', async () => {
    const { db, service } = setup();
    await expect(service.counterOffer('farmer1', 'off1', { price: 2100, quantity: 10, expires_at: '2027-01-20T00:00:00.000Z' }))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await expect(service.counterOffer('farmer3', 'off1', { price: 2100, quantity: 10, expires_at: '2027-01-20T00:00:00.000Z' }))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await expect(service.counterOffer('buyer2', 'off1', { price: 2100, quantity: 10, expires_at: '2027-01-20T00:00:00.000Z' }))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(db.offers.find((o) => o.id === 'off1').status).toBe('open');
    expect(db.offers).toHaveLength(3);
  });

  test('an expired offer cannot be countered', async () => {
    const { db, service } = setup();
    await expect(service.counterOffer('buyer1', 'off-expired', { price: 2000, quantity: 5, expires_at: '2027-01-20T00:00:00.000Z' }))
      .rejects.toMatchObject({ status: 409, code: 'OFFER_EXPIRED' });
    expect(db.offers).toHaveLength(3);
  });

  test('a countered offer cannot be countered again', async () => {
    const { service } = setup();
    await service.counterOffer('buyer1', 'off1', { price: 2100, quantity: 10, expires_at: '2027-01-20T00:00:00.000Z' });
    await expect(service.counterOffer('buyer1', 'off1', { price: 2150, quantity: 10, expires_at: '2027-01-20T00:00:00.000Z' }))
      .rejects.toMatchObject({ status: 409, code: 'OFFER_NOT_OPEN' });
  });
});

describe('negotiationService.acceptOffer', () => {
  test('acceptance creates exactly one order at the locked price (literals 2200 / 22000)', async () => {
    const { db, service } = setup();
    const result = await service.acceptOffer('buyer1', 'off1', { ...ACCEPT_BODY });
    expect(db.orders).toHaveLength(1);
    const order = db.orders[0];
    expect(order.price_at_order).toBe(2200);
    expect(order.total_price).toBe(22000);
    expect(order.quantity).toBe(10);
    expect(order.buyer_id).toBe('buyer1');
    expect(order.farmer_id).toBe('farmer1');
    expect(order.product_id).toBe('prod1');
    expect(order.status).toBe('PENDING');
    expect(result.agreement.locked_price).toBe(2200);
    expect(result.agreement.locked_quantity).toBe(10);
    expect(result.agreement.order_id).toBe(order.id);
    expect(result.agreement.requirement_id).toBe('req1');
    expect(result.order.id).toBe(order.id);
    expect(db.offers.find((o) => o.id === 'off1').status).toBe('accepted');
    expect(db.requirements.find((r) => r.id === 'req1').status).toBe('accepted');
    // The competing open offer on the same requirement is rejected.
    expect(db.offers.find((o) => o.id === 'off2').status).toBe('rejected');
    const events = db.audit_log.map((a) => a.event);
    expect(events).toContain('offer.accepted');
    expect(events).toContain('agreement.created');
    expect(events).toContain('offer.rejected');
  });

  test('the locked price survives a later listing edit (2200 stays 2200, not 2600)', async () => {
    const { db, service } = setup();
    await service.acceptOffer('buyer1', 'off1', { ...ACCEPT_BODY });
    db.products.find((p) => p.id === 'prod1').user_price = 2600;
    db.products.find((p) => p.id === 'prod1').price = 2600;
    expect(db.orders).toHaveLength(1);
    expect(db.orders[0].price_at_order).toBe(2200);
    expect(db.orders[0].total_price).toBe(22000);
  });

  test('an expired offer cannot be accepted', async () => {
    const { db, service } = setup();
    await expect(service.acceptOffer('buyer1', 'off-expired', { ...ACCEPT_BODY }))
      .rejects.toMatchObject({ status: 409, code: 'OFFER_EXPIRED' });
    expect(db.orders).toHaveLength(0);
    expect(db.agreements).toHaveLength(0);
  });

  test('only the counterparty can accept — maker and third parties get 403', async () => {
    const { db, service } = setup();
    await expect(service.acceptOffer('farmer1', 'off1', { ...ACCEPT_BODY }))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await expect(service.acceptOffer('farmer3', 'off1', { ...ACCEPT_BODY }))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await expect(service.acceptOffer('buyer2', 'off1', { ...ACCEPT_BODY }))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(db.orders).toHaveLength(0);
  });

  test('duplicate accept calls with the same Idempotency-Key create only one order', async () => {
    const { db, service } = setup();
    const first = await service.acceptOffer('buyer1', 'off1', { ...ACCEPT_BODY }, 'accept-key-1');
    const second = await service.acceptOffer('buyer1', 'off1', { ...ACCEPT_BODY }, 'accept-key-1');
    expect(second.agreement.id).toBe(first.agreement.id);
    expect(second.order.id).toBe(first.order.id);
    expect(db.orders).toHaveLength(1);
    expect(db.agreements).toHaveLength(1);
  });

  test('a second accept without the key is a 409, not a second order', async () => {
    const { db, service } = setup();
    await service.acceptOffer('buyer1', 'off1', { ...ACCEPT_BODY }, 'accept-key-1');
    await expect(service.acceptOffer('buyer1', 'off1', { ...ACCEPT_BODY }))
      .rejects.toMatchObject({ status: 409, code: 'OFFER_ALREADY_ACCEPTED' });
    expect(db.orders).toHaveLength(1);
  });

  test('accepting without a delivery address is a 400 and creates nothing', async () => {
    const { db, service } = setup();
    await expect(service.acceptOffer('buyer1', 'off1', { delivery_address: '  ' }))
      .rejects.toMatchObject({ status: 400, code: 'MISSING_FIELDS' });
    expect(db.orders).toHaveLength(0);
    expect(db.offers.find((o) => o.id === 'off1').status).toBe('open');
  });
});

describe('negotiationService.getNegotiationThread', () => {
  test('buyer sees requirement + offers + agreement + a null fairPriceAnchor', async () => {
    const { service } = setup();
    const thread = await service.getNegotiationThread('buyer1', 'req1');
    expect(thread.requirement.id).toBe('req1');
    expect(thread.offers).toHaveLength(3);
    expect(thread.agreement).toBeNull();
    expect(thread.fairPriceAnchor).toBeNull();
  });

  test('a quoting farmer sees the thread; a non-quoting farmer gets the generic 404', async () => {
    const { service } = setup();
    const thread = await service.getNegotiationThread('farmer1', 'req1');
    expect(thread.requirement.id).toBe('req1');
    await expect(service.getNegotiationThread('farmer3', 'req1'))
      .rejects.toMatchObject({ status: 404, code: 'NEGOTIATION_NOT_FOUND' });
    await expect(service.getNegotiationThread('buyer2', 'req1'))
      .rejects.toMatchObject({ status: 404, code: 'NEGOTIATION_NOT_FOUND' });
  });

  test('an admin sees the thread; a missing requirement is the same 404', async () => {
    const { service } = setup();
    const thread = await service.getNegotiationThread('admin1', 'req1');
    expect(thread.requirement.id).toBe('req1');
    await expect(service.getNegotiationThread('buyer1', 'ghost'))
      .rejects.toMatchObject({ status: 404, code: 'NEGOTIATION_NOT_FOUND' });
  });

  test('after acceptance the thread carries the agreement', async () => {
    const { db, service } = setup();
    await service.acceptOffer('buyer1', 'off1', { ...ACCEPT_BODY });
    const thread = await service.getNegotiationThread('buyer1', 'req1');
    expect(thread.agreement).toMatchObject({ locked_price: 2200, order_id: db.orders[0].id });
    expect(thread.fairPriceAnchor).toBeNull();
  });
});

// Merge fix: the Requirements page lists the buyer's own requirements —
// the contract had no list endpoint, so this one is added here.
describe('negotiationService.listRequirements', () => {
  test('a buyer lists only their own requirements, each with its offer_count', async () => {
    const { service } = setup();
    const result = await service.listRequirements('buyer1');
    expect(result.requirements).toHaveLength(1);
    expect(result.requirements[0]).toMatchObject({ id: 'req1', offer_count: 3 });
    const other = await service.listRequirements('buyer2');
    expect(other.requirements).toHaveLength(0);
  });
});

describe('migration 20261119_negotiation.sql (file-level guard)', () => {
  test('defines the three tables, the post-acceptance edit guard and RLS', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', '..', 'supabase', 'migrations', '20261119_negotiation.sql'),
      'utf8',
    );
    for (const table of ['public.requirements', 'public.offers', 'public.agreements']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain('prevent_accepted_negotiation_edit');
    expect(sql).toContain('CREATE TRIGGER prevent_requirement_edit_after_acceptance');
    expect(sql).toContain('CREATE TRIGGER prevent_offer_edit_after_acceptance');
    expect(sql).toContain('CREATE TRIGGER prevent_agreement_edit');
    expect(sql).toContain('is_admin()');
    expect(sql).toContain('ROW LEVEL SECURITY');
  });
});

describe('routes mount the right guards', () => {
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

  test('the router exposes exactly the six negotiation routes — no edit routes', () => {
    const routes = require('../routes/negotiationRoutes');
    expect(routeList(routes)).toEqual([
      'GET /negotiations/:id',
      'GET /requirements',
      'POST /offers/:id/accept',
      'POST /offers/:id/counter',
      'POST /requirements',
      'POST /requirements/:id/offers',
    ].sort());
  });

  test('POST /requirements sits behind requireAuth and the buyer role', async () => {
    const routes = require('../routes/negotiationRoutes');
    const layer = findRoute(routes, 'POST', '/requirements');
    expect(layer.route.stack).toHaveLength(3);
    const [authLayer, buyerLayer] = layer.route.stack;
    const nextAuth = jest.fn();
    await authLayer.handle({ headers: {} }, {}, nextAuth);
    expect(nextAuth.mock.calls[0][0]).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    const nextRole = jest.fn();
    await buyerLayer.handle({ user: { id: 'farmer1' } }, {}, nextRole);
    expect(nextRole.mock.calls[0][0]).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    const nextBuyer = jest.fn();
    await buyerLayer.handle({ user: { id: 'buyer1' } }, {}, nextBuyer);
    expect(nextBuyer).toHaveBeenCalledWith();
  });

  test('POST /requirements/:id/offers sits behind requireAuth and the farmer role', async () => {
    const routes = require('../routes/negotiationRoutes');
    const layer = findRoute(routes, 'POST', '/requirements/:id/offers');
    expect(layer.route.stack).toHaveLength(3);
    const [, farmerLayer] = layer.route.stack;
    const nextRole = jest.fn();
    await farmerLayer.handle({ user: { id: 'buyer1' } }, {}, nextRole);
    expect(nextRole.mock.calls[0][0]).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  test('counter, accept and thread routes sit behind requireAuth only (service enforces counterparty)', () => {
    const routes = require('../routes/negotiationRoutes');
    for (const [method, routePath] of [
      ['POST', '/offers/:id/counter'],
      ['POST', '/offers/:id/accept'],
      ['GET', '/negotiations/:id'],
    ]) {
      const layer = findRoute(routes, method, routePath);
      expect(layer.route.stack).toHaveLength(2);
    }
  });

  test('POST /requirements handler creates the requirement and answers 201', async () => {
    const { db } = setup();
    const routes = require('../routes/negotiationRoutes');
    const layer = findRoute(routes, 'POST', '/requirements');
    const handler = layer.route.stack[2].handle;
    const req = { user: { id: 'buyer1' }, body: { ...VALID_REQUIREMENT } };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ crop: 'Rice', status: 'open' }));
    expect(db.requirements).toHaveLength(2);
  });

  test('GET /requirements handler lists the buyer\u2019s own requirements with offer counts', async () => {
    setup();
    const routes = require('../routes/negotiationRoutes');
    const layer = findRoute(routes, 'GET', '/requirements');
    expect(layer.route.stack).toHaveLength(3);
    const handler = layer.route.stack[2].handle;
    const req = { user: { id: 'buyer1' } };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      requirements: [expect.objectContaining({ id: 'req1', offer_count: 3 })],
    }));
  });

  test('POST /offers/:id/accept handler forwards the Idempotency-Key and answers 201', async () => {
    const { db } = setup();
    const routes = require('../routes/negotiationRoutes');
    const layer = findRoute(routes, 'POST', '/offers/:id/accept');
    const handler = layer.route.stack[1].handle;
    const req = {
      user: { id: 'buyer1' },
      params: { id: 'off1' },
      body: { ...ACCEPT_BODY },
      headers: { 'idempotency-key': 'route-key-1' },
    };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].agreement).toMatchObject({ locked_price: 2200 });
    expect(db.orders).toHaveLength(1);
    expect(db.orders[0].price_at_order).toBe(2200);
  });

  test('GET /negotiations/:id handler answers 200 for the buyer', async () => {
    setup();
    const routes = require('../routes/negotiationRoutes');
    const layer = findRoute(routes, 'GET', '/negotiations/:id');
    const handler = layer.route.stack[1].handle;
    const req = { user: { id: 'buyer1' }, params: { id: 'req1' } };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      requirement: expect.objectContaining({ id: 'req1' }),
      fairPriceAnchor: null,
    }));
  });
});
