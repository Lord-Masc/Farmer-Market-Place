'use strict';
/**
 * Admin & Platform Intelligence (Stage 10, module I) — Unit A:
 * migration + backend.
 *
 * TDD: written FIRST and watched RED (migration file, services and the
 * requireAuth suspension check do not exist yet) before any
 * implementation. Services are tested against an in-memory fake
 * Supabase client (same builder pattern as escrow-security.test.js);
 * the migration is asserted by SQL content here and parse-checked
 * separately with pglast (no live Postgres in this repo).
 *
 * Units: orders.total_price is RUPEES (numeric); payments.amount and
 * every *_paise field are integer PAISE. GMV = sum of total_price x 100
 * over orders with a captured (HELD/RELEASED) payment.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const fs = require('fs');
const path = require('path');

const mockHolder = { admin: null, supabase: null };

jest.mock('../utils/supabaseAdmin', () => ({
  from: (...args) => mockHolder.admin.from(...args),
}));
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => mockHolder.supabase,
}));
jest.mock('../utils/auditLog', () => ({
  logAudit: jest.fn(),
}));

// Re-required fresh in each beforeEach (after jest.resetModules):
// the top-level require goes stale once the module registry resets.
let logAudit;

function makeFakeAdmin(tables, opts = {}) {
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
    if (q.table === 'mandi_prices' && opts.mandiMissing) {
      return { data: null, error: { code: '42P01', message: 'relation "public.mandi_prices" does not exist' } };
    }
    const table = tables[q.table];
    if (!table) return { data: null, error: { message: `table ${q.table} does not exist` } };
    if (q.op === 'select') {
      let rows = table.filter((r) => matches(r, q.filters));
      if (q.order) {
        const { col, ascending } = q.order;
        rows = [...rows].sort((a, b) => {
          if (a[col] < b[col]) return ascending ? -1 : 1;
          if (a[col] > b[col]) return ascending ? 1 : -1;
          return 0;
        });
      }
      if (q.limit != null) rows = rows.slice(0, q.limit);
      if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
      return { data: rows.map((r) => ({ ...r })), error: null };
    }
    if (q.op === 'update') {
      const matched = table.filter((r) => matches(r, q.filters));
      for (const r of matched) Object.assign(r, q.fields);
      return { data: matched.map((r) => ({ ...r })), error: null };
    }
    if (q.op === 'insert') {
      const row = { id: `id_${Math.random().toString(36).slice(2)}`, ...q.row };
      table.push(row);
      return { data: [{ ...row }], error: null };
    }
    return { data: null, error: { message: 'unsupported op' } };
  }
  function builder(table) {
    const q = { table, op: null, fields: null, row: null, filters: [], limit: null, order: null, range: null };
    const api = {
      select() { if (!q.op) q.op = 'select'; return api; },
      update(fields) { q.op = 'update'; q.fields = fields; return api; },
      insert(row) { q.op = 'insert'; q.row = row; return api; },
      eq(col, val) { q.filters.push({ type: 'eq', col, val }); return api; },
      in(col, val) { q.filters.push({ type: 'in', col, val }); return api; },
      is(col, val) { q.filters.push({ type: 'is', col, val }); return api; },
      order(col, options = {}) { q.order = { col, ascending: options.ascending !== false }; return api; },
      limit(n) { q.limit = n; return api; },
      range(a, b) { q.range = [a, b]; return api; },
      single() { return api; },
      then(resolve, reject) {
        return Promise.resolve().then(() => execute(q)).then(resolve, reject);
      },
    };
    return api;
  }
  return { from: (table) => builder(table) };
}

// Hand-checked metrics fixture. Orders: total_price in RUPEES.
// o1 CONFIRMED, no payment -> excluded from GMV/median.
// o2 PAID 1000 x qty 4, HELD -> GMV +100000, realisation 25000/unit.
// o3 COMPLETED 600 x qty 3, RELEASED, on time -> GMV +60000, realisation 20000.
// o4 COMPLETED 300 x qty 1, RELEASED, late -> GMV +30000, realisation 30000.
// o5 REFUNDED 200, payment REFUNDED -> excluded.
// o6 DELIVERED 400 x qty 2, RELEASED, no deadline -> GMV +40000, realisation 20000,
//   excluded from the on-time denominator (no deadline).
// GMV = 230000. Realisations sorted [20000,20000,25000,30000] -> median 22500.
// On-time: 1 of 2 eligible -> 0.5. Disputes 2 of 6 orders -> rate 0.3333.
const METRIC_ORDERS = [
  { id: 'o1', total_price: 500, quantity: 2, status: 'CONFIRMED', created_at: '2026-11-10T09:00:00.000Z', completed_at: null, delivery_deadline: null },
  { id: 'o2', total_price: 1000, quantity: 4, status: 'PAID', created_at: '2026-11-10T09:00:00.000Z', completed_at: null, delivery_deadline: '2026-11-12T12:00:00.000Z' },
  { id: 'o3', total_price: 600, quantity: 3, status: 'COMPLETED', created_at: '2026-11-09T09:00:00.000Z', completed_at: '2026-11-10T10:00:00.000Z', delivery_deadline: '2026-11-10T12:00:00.000Z' },
  { id: 'o4', total_price: 300, quantity: 1, status: 'COMPLETED', created_at: '2026-11-09T09:00:00.000Z', completed_at: '2026-11-10T13:00:00.000Z', delivery_deadline: '2026-11-10T12:00:00.000Z' },
  { id: 'o5', total_price: 200, quantity: 1, status: 'REFUNDED', created_at: '2026-11-09T09:00:00.000Z', completed_at: null, delivery_deadline: null },
  { id: 'o6', total_price: 400, quantity: 2, status: 'DELIVERED', created_at: '2026-11-08T09:00:00.000Z', completed_at: '2026-11-09T09:00:00.000Z', delivery_deadline: null },
];
const METRIC_PAYMENTS = [
  { order_id: 'o2', status: 'HELD' },
  { order_id: 'o3', status: 'RELEASED' },
  { order_id: 'o4', status: 'RELEASED' },
  { order_id: 'o5', status: 'REFUNDED' },
  { order_id: 'o6', status: 'RELEASED' },
];
const METRIC_GROUPS = [
  { id: 'g1', status: 'closed', order_id: 'o3' },
  { id: 'g2', status: 'open', order_id: null },
  { id: 'g3', status: 'closed', order_id: 'o4' },
];
const METRIC_PARTICIPANTS = [
  { group_buy_id: 'g1', contribution_quantity: 100 },
  { group_buy_id: 'g1', contribution_quantity: 200 },
  { group_buy_id: 'g2', contribution_quantity: 50 },
  { group_buy_id: 'g3', contribution_quantity: 300 },
];
const METRIC_NOTIFICATIONS = [
  { delivery_status: 'sent' }, { delivery_status: 'sent' }, { delivery_status: 'sent' },
  { delivery_status: 'sent' }, { delivery_status: 'sent' },
  { delivery_status: 'failed' },
  { delivery_status: 'deferred' }, { delivery_status: 'deferred' },
  { delivery_status: 'pending' }, { delivery_status: 'pending' }, { delivery_status: 'pending' },
  { delivery_status: 'weird' },
];
// 2 disputes: 1 resolved in exactly 24h (2026-11-05T10:00Z -> 2026-11-06T10:00Z), 1 still filed.
const METRIC_DISPUTES = [
  { status: 'resolved', created_at: '2026-11-05T10:00:00.000Z', resolved_at: '2026-11-06T10:00:00.000Z' },
  { status: 'filed', created_at: '2026-11-10T09:00:00.000Z', resolved_at: null },
];

function metricTables(overrides = {}) {
  return {
    orders: overrides.orders !== undefined ? overrides.orders : METRIC_ORDERS.map((r) => ({ ...r })),
    payments: overrides.payments !== undefined ? overrides.payments : METRIC_PAYMENTS.map((r) => ({ ...r })),
    group_buys: overrides.group_buys !== undefined ? overrides.group_buys : METRIC_GROUPS.map((r) => ({ ...r })),
    group_buy_participants: overrides.participants !== undefined ? overrides.participants : METRIC_PARTICIPANTS.map((r) => ({ ...r })),
    notifications: overrides.notifications !== undefined ? overrides.notifications : METRIC_NOTIFICATIONS.map((r) => ({ ...r })),
    disputes: overrides.disputes !== undefined ? overrides.disputes : METRIC_DISPUTES.map((r) => ({ ...r })),
    mandi_prices: overrides.mandi_prices !== undefined ? overrides.mandi_prices : [],
  };
}

describe('migration file (parse-checked separately with pglast)', () => {
  test('20261125_admin_views.sql defines the two views, the two columns and the RLS change', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '../../supabase/migrations/20261125_admin_views.sql'),
      'utf8',
    );
    expect(sql).toContain('admin_stuck_money');
    expect(sql).toContain('platform_metrics_daily');
    expect(sql).toContain('suspended_at');
    expect(sql).toContain("status IN ('active', 'hidden')");
    expect(sql).toContain('Products are viewable by everyone');
    expect(sql).toContain('confirmed_unpaid');
    expect(sql).toContain('completed_held');
    expect(sql).toContain('refund_reconcile');
    expect(sql).toContain('REFUND_RECONCILE');
    expect(sql).toContain('20261116');
    expect(sql).toMatch(/deviation/i);
    expect(sql).not.toContain('CREATE TABLE');
  });
});

describe('adminMetricsService.getPlatformMetrics', () => {
  let service;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockHolder.admin = makeFakeAdmin(metricTables(), { mandiMissing: true });
    service = require('../services/adminMetricsService');
  });

  test('hand-checked fixture: GMV, median realisation, dispute/on-time/group/notification numbers', async () => {
    const m = await service.getPlatformMetrics();
    expect(m).toEqual({
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
    });
  });

  test('mandi table missing (Stage 3 blocked) -> mandi_modal_paise is null, never invented', async () => {
    const m = await service.getPlatformMetrics();
    expect(m.mandi_modal_paise).toBeNull();
    expect(m.gmv_paise).toBe(230000);
  });

  test('mandi rows present -> modal price in paise (most frequent, rupees x 100)', async () => {
    mockHolder.admin = makeFakeAdmin(metricTables({
      mandi_prices: [{ price: 2400 }, { price: 2400 }, { price: 2600 }],
    }));
    const m = await service.getPlatformMetrics();
    expect(m.mandi_modal_paise).toBe(240000);
  });

  test('no data at all -> counts are 0, measurements are null (never 0 as a measurement)', async () => {
    mockHolder.admin = makeFakeAdmin(metricTables({
      orders: [], payments: [], group_buys: [], participants: [], notifications: [], disputes: [],
    }), { mandiMissing: true });
    const m = await service.getPlatformMetrics();
    expect(m).toEqual({
      total_orders: 0,
      gmv_paise: null,
      median_realisation_paise: null,
      mandi_modal_paise: null,
      dispute_rate: null,
      dispute_count: 0,
      avg_resolution_hours: null,
      on_time_rate: null,
      group_selling: { groups_total: 0, groups_closed: 0, pooled_quantity: null, pooled_gmv_paise: null },
      notification_delivery: { sent: 0, failed: 0, deferred: 0, pending: 0 },
    });
  });

  test('output carries no personal-data fields (contract keys only)', async () => {
    const m = await service.getPlatformMetrics();
    const blob = JSON.stringify(m).toLowerCase();
    for (const word of ['email', 'phone', 'first_name', 'last_name', 'address']) {
      expect(blob).not.toContain(word);
    }
    expect(Object.keys(m).sort()).toEqual([
      'avg_resolution_hours', 'dispute_count', 'dispute_rate', 'gmv_paise',
      'group_selling', 'mandi_modal_paise', 'median_realisation_paise',
      'notification_delivery', 'on_time_rate', 'total_orders',
    ].sort());
  });
});

describe('adminMetricsService.getStuckMoney', () => {
  let service;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    service = require('../services/adminMetricsService');
  });

  test('hand-checked fixture: one row per stuck category, exact amounts, unknown categories dropped', async () => {
    mockHolder.admin = makeFakeAdmin({
      admin_stuck_money: [
        { order_id: 'o-conf', category: 'confirmed_unpaid', amount_paise: 50000, order_status: 'CONFIRMED', payment_status: null, created_at: '2026-11-10T10:00:00.000Z' },
        { order_id: 'o-held', category: 'completed_held', amount_paise: 120000, order_status: 'COMPLETED', payment_status: 'HELD', created_at: '2026-11-09T10:00:00.000Z' },
        { order_id: 'o-rec', category: 'refund_reconcile', amount_paise: 75000, order_status: 'REFUND_RECONCILE', payment_status: 'HELD', created_at: '2026-11-08T10:00:00.000Z' },
        { order_id: 'o-bogus', category: 'bogus', amount_paise: 1, order_status: 'PAID', payment_status: 'HELD', created_at: '2026-11-07T10:00:00.000Z' },
      ],
    });
    const stuck = await service.getStuckMoney();
    expect(stuck).toEqual([
      { order_id: 'o-conf', category: 'confirmed_unpaid', amount_paise: 50000, order_status: 'CONFIRMED', payment_status: null, created_at: '2026-11-10T10:00:00.000Z' },
      { order_id: 'o-held', category: 'completed_held', amount_paise: 120000, order_status: 'COMPLETED', payment_status: 'HELD', created_at: '2026-11-09T10:00:00.000Z' },
      { order_id: 'o-rec', category: 'refund_reconcile', amount_paise: 75000, order_status: 'REFUND_RECONCILE', payment_status: 'HELD', created_at: '2026-11-08T10:00:00.000Z' },
    ]);
  });
});

describe('moderationService', () => {
  let service;
  let tables;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    tables = {
      profiles: [
        { id: 'farmer1', role: 'farmer', suspended_at: null, email_address: 'farmer1@test' },
        { id: 'admin1', role: 'admin', suspended_at: null, email_address: 'admin1@test' },
        { id: 'susp1', role: 'farmer', suspended_at: '2026-11-11T10:00:00.000Z', email_address: 'susp1@test' },
      ],
      products: [
        { id: 'p1', farmer_id: 'farmer1', status: 'active' },
        { id: 'p2', farmer_id: 'farmer1', status: 'active' },
        { id: 'p3', farmer_id: 'other1', status: 'active' },
        { id: 'p4', farmer_id: 'susp1', status: 'hidden' },
        { id: 'p5', farmer_id: 'susp1', status: 'hidden' },
      ],
    };
    mockHolder.admin = makeFakeAdmin(tables);
    logAudit = require('../utils/auditLog').logAudit;
    service = require('../services/moderationService');
  });

  test('suspend hides all of the user products, audit-logs, exact response shape', async () => {
    const result = await service.suspendUser('admin1', 'farmer1');
    expect(result.listings_hidden).toBe(2);
    expect(result.user.id).toBe('farmer1');
    expect(result.user.role).toBe('farmer');
    expect(typeof result.user.suspended_at).toBe('string');
    expect(Object.keys(result).sort()).toEqual(['listings_hidden', 'user']);
    expect(Object.keys(result.user).sort()).toEqual(['id', 'role', 'suspended_at']);
    expect(tables.profiles.find((p) => p.id === 'farmer1').suspended_at).toBe(result.user.suspended_at);
    expect(tables.products.filter((p) => p.farmer_id === 'farmer1').every((p) => p.status === 'hidden')).toBe(true);
    expect(tables.products.find((p) => p.id === 'p3').status).toBe('active');
    expect(logAudit).toHaveBeenCalledWith('admin1', 'moderation.suspended', { user_id: 'farmer1', listings_hidden: 2 });
  });

  test('self-suspend -> 409, nothing changes', async () => {
    await expect(service.suspendUser('admin1', 'admin1'))
      .rejects.toMatchObject({ status: 409 });
    expect(tables.profiles.find((p) => p.id === 'admin1').suspended_at).toBeNull();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('suspending an already-suspended user -> 409', async () => {
    await expect(service.suspendUser('admin1', 'susp1'))
      .rejects.toMatchObject({ status: 409 });
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('suspending a missing user -> 404', async () => {
    await expect(service.suspendUser('admin1', 'ghost'))
      .rejects.toMatchObject({ status: 404, code: 'USER_NOT_FOUND' });
  });

  test('reinstate restores listings, clears suspended_at, audit-logs, exact response shape', async () => {
    const result = await service.reinstateUser('admin1', 'susp1');
    expect(result).toEqual({
      user: { id: 'susp1', role: 'farmer', suspended_at: null },
      listings_restored: 2,
    });
    expect(tables.products.filter((p) => p.farmer_id === 'susp1').every((p) => p.status === 'active')).toBe(true);
    expect(logAudit).toHaveBeenCalledWith('admin1', 'moderation.reinstated', { user_id: 'susp1', listings_restored: 2 });
  });

  test('reinstating a non-suspended user -> 409, nothing changes', async () => {
    await expect(service.reinstateUser('admin1', 'farmer1'))
      .rejects.toMatchObject({ status: 409 });
    expect(tables.products.filter((p) => p.farmer_id === 'farmer1').every((p) => p.status === 'active')).toBe(true);
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('reinstating a missing user -> 404', async () => {
    await expect(service.reinstateUser('admin1', 'ghost'))
      .rejects.toMatchObject({ status: 404, code: 'USER_NOT_FOUND' });
  });

  test('moderation is reversible: suspend -> reinstate restores the exact prior state', async () => {
    await service.suspendUser('admin1', 'farmer1');
    expect(tables.profiles.find((p) => p.id === 'farmer1').suspended_at).not.toBeNull();
    const result = await service.reinstateUser('admin1', 'farmer1');
    expect(result.user.suspended_at).toBeNull();
    expect(result.listings_restored).toBe(2);
    expect(tables.products.filter((p) => p.farmer_id === 'farmer1').every((p) => p.status === 'active')).toBe(true);
  });

  test('lookup by UUID returns the user with role and suspension state', async () => {
    await expect(service.lookupUser('11111111-1111-1111-1111-111111111111'))
      .rejects.toMatchObject({ status: 404, code: 'USER_NOT_FOUND' });
    // farmer1 has a short test id, not a UUID — use the real-UUID fixture row instead.
    tables.profiles.push({ id: '22222222-2222-2222-2222-222222222222', role: 'buyer', suspended_at: null, email_address: 'buyer2@test' });
    const result = await service.lookupUser('22222222-2222-2222-2222-222222222222');
    expect(result).toEqual({ user: { id: '22222222-2222-2222-2222-222222222222', role: 'buyer', suspended_at: null } });
  });

  test('lookup by email returns the user (suspended_at included when suspended)', async () => {
    const result = await service.lookupUser('susp1@test');
    expect(result).toEqual({
      user: { id: 'susp1', role: 'farmer', suspended_at: '2026-11-11T10:00:00.000Z' },
    });
    const plain = await service.lookupUser('farmer1@test');
    expect(plain).toEqual({ user: { id: 'farmer1', role: 'farmer', suspended_at: null } });
  });

  test('lookup of an unknown UUID, unknown email or garbage query all return the same generic 404', async () => {
    for (const query of ['33333333-3333-3333-3333-333333333333', 'nobody@test', 'not-an-id']) {
      await expect(service.lookupUser(query))
        .rejects.toMatchObject({ status: 404, code: 'USER_NOT_FOUND' });
    }
  });
});

describe('requireAuth suspension enforcement', () => {
  let requireAuth;

  function callMiddleware(headers) {
    return new Promise((resolve) => {
      const req = { headers: headers || {} };
      const res = {};
      requireAuth(req, res, (err) => resolve({ req, err }));
    });
  }

  beforeEach(() => {
    jest.resetModules();
    mockHolder.supabase = {
      auth: {
        getUser: async (token) => {
          const users = {
            'good-token': { id: 'u1', email: 'u1@test' },
            'suspended-token': { id: 'susp1', email: 'susp1@test' },
            'ghost-token': { id: 'ghost1', email: 'ghost@test' },
          };
          const user = users[token];
          if (!user) return { data: { user: null }, error: { message: 'invalid token' } };
          return { data: { user }, error: null };
        },
      },
    };
    mockHolder.admin = makeFakeAdmin({
      profiles: [
        { id: 'u1', role: 'buyer', suspended_at: null },
        { id: 'susp1', role: 'farmer', suspended_at: '2026-11-11T10:00:00.000Z' },
      ],
    });
    requireAuth = require('../middleware/requireAuth');
  });

  test('a non-suspended user passes with req.user set', async () => {
    const { req, err } = await callMiddleware({ authorization: 'Bearer good-token' });
    expect(err).toBeFalsy();
    expect(req.user.id).toBe('u1');
  });

  test('a suspended user gets 403 ACCOUNT_SUSPENDED on any authenticated request', async () => {
    const { err } = await callMiddleware({ authorization: 'Bearer suspended-token' });
    expect(err).toMatchObject({ status: 403, code: 'ACCOUNT_SUSPENDED' });
  });

  test('a user with no profile row cannot be suspended, so the request passes', async () => {
    const { req, err } = await callMiddleware({ authorization: 'Bearer ghost-token' });
    expect(err).toBeFalsy();
    expect(req.user.id).toBe('ghost1');
  });

  test('no token -> 401, bad token -> 401 (unchanged)', async () => {
    const noToken = await callMiddleware({});
    expect(noToken.err).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    const badToken = await callMiddleware({ authorization: 'Bearer nope' });
    expect(badToken.err).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });
});
