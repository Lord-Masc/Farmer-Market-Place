'use strict';
/**
 * Notifications & Communication (Stage 9, module H) — migration + backend unit.
 *
 * Contract under test (Unit B builds the frontend against exactly this):
 * - GET /api/notifications?unread_only=true&limit=20&offset=0 -> 200
 *   { notifications: [{ id, type, title, body, payload, channel,
 *   delivery_status, read_at, created_at }], unread_count }.
 * - PATCH /api/notifications/:id/read -> 200 { notification } (own row
 *   only, 404 otherwise).
 * - GET /api/notifications/preferences -> 200 { preferences: [...] }.
 * - PATCH /api/notifications/preferences { preferences: [...] } -> 200
 *   { preferences } (upsert per event type; channels subset of
 *   in_app/email/sms, language hi|en, quiet times HH:MM or null).
 * - emit({ eventId, type, userIds, payload, channels?, includeAdmins? }):
 *   one row per (user, channel the user enabled); default preference is
 *   in_app only; opted-out types emit nothing; dedupe_key
 *   (eventId:user:channel) UNIQUE — a replay creates zero new rows;
 *   best-effort, never throws; in_app rows are 'sent' at emit.
 * - Worker processPending(supabase, adapters, { now, limit }): pending /
 *   deferred rows due are attempted oldest-first (limit 50); in_app ->
 *   'sent' with no adapter call; quiet hours -> 'deferred' with
 *   next_attempt_at at quiet-end (UTC wall-clock, Render runs UTC);
 *   adapter failure -> attempts+1, next_attempt_at = now + 2^attempts
 *   minutes, after 3 attempts -> 'failed' with payload.delivery_code;
 *   no provider -> 'failed' with PROVIDER_NOT_CONFIGURED, never 'sent';
 *   opted-out-after-emit -> email/sms rows 'failed' with OPTED_OUT,
 *   in_app rows 'sent' (the inbox already delivered them).
 * - Templates: Hindi-first (default 'hi'); every title/body is built
 *   ONLY from the payload — a no-data template contains no digits.
 * - Adapters: provider-agnostic interface + stubs only. Brevo (email)
 *   and httpSMS (sms) are NOT wired — the stubs return
 *   { ok: false, code: 'PROVIDER_NOT_CONFIGURED' } and make no network
 *   call, import no SDK, read no key.
 *
 * Hand-checked literals (NOT derived from the code):
 * - Backoff: attempt 1 -> now + 2 min, attempt 2 -> now + 4 min,
 *   attempt 3 -> 'failed' (attempts 3, code PROVIDER_NOT_CONFIGURED).
 * - Quiet hours 22:00-07:00, now 2026-11-12T23:30:00Z -> 'deferred',
 *   next_attempt_at exactly 2026-11-13T07:00:00.000Z.
 * - Escrow lifecycle on one order (total_price 500 = 50000 paise):
 *   order_created x2 (buyer + farmer), order_confirmed x1 (buyer),
 *   order_paid x1 (farmer), order_shipped x1 (buyer),
 *   order_completed x2 (buyer + farmer); replayed pay and replayed
 *   refund-request add zero rows; second order refunded x1 (buyer).
 *
 * Route tests live in notificationRoutes.test.js (mocked service, same
 * pattern as assistant.test.js). The mock below extends the Stage 7
 * disputes builder with lt/lte/gte + rpc + a dedupe_key unique check
 * on the notifications insert.
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
      if (f.type === 'lt' && !(row[f.col] < f.val)) return false;
      if (f.type === 'lte' && !(row[f.col] <= f.val)) return false;
      if (f.type === 'gte' && !(row[f.col] >= f.val)) return false;
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
      const rows = Array.isArray(q.row) ? q.row : [q.row];
      const inserted = [];
      for (const input of rows) {
        // The notifications dedupe_key UNIQUE backstop: a replay of the
        // same (event, user, channel) is a unique violation, never a
        // second row — the service treats it as already-emitted.
        if (q.table === 'notifications' && input.dedupe_key
          && table.some((r) => r.dedupe_key === input.dedupe_key)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "notifications_dedupe_key_key"' } };
        }
        // The idempotency_keys UNIQUE(key, user_id) backstop: a replayed
        // order creation claims the same key and gets the stored
        // response back instead of a second order.
        if (q.table === 'idempotency_keys'
          && table.some((r) => r.key === input.key && r.user_id === input.user_id)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "idempotency_keys_key_user_id_key"' } };
        }
        const row = {
          id: input.id || `id_${Math.random().toString(36).slice(2)}`,
          created_at: input.created_at || new Date().toISOString(),
          ...input,
        };
        // Keep the caller's explicit id/created_at (spread above puts
        // input last for id but created_at would be overwritten by the
        // default when input has none — re-apply input values verbatim).
        if (input.id) row.id = input.id;
        if (input.created_at) row.created_at = input.created_at;
        table.push(row);
        inserted.push(row);
      }
      return { data: inserted, error: null };
    }
    if (q.op === 'delete') {
      const matched = table.filter((r) => matches(r, q.filters));
      for (const r of matched) table.splice(table.indexOf(r), 1);
      return { data: matched, error: null };
    }
    return { data: null, error: { message: 'unsupported op' } };
  }

  function builder(table) {
    const q = { table, op: null, fields: null, row: null, filters: [], limit: null, orderBy: null, range: null };
    const api = {
      select() { if (!q.op) q.op = 'select'; return api; },
      update(fields) { q.op = 'update'; q.fields = fields; return api; },
      insert(row) { q.op = 'insert'; q.row = row; return api; },
      delete() { q.op = 'delete'; return api; },
      eq(col, val) { q.filters.push({ type: 'eq', col, val }); return api; },
      in(col, val) { q.filters.push({ type: 'in', col, val }); return api; },
      is(col, val) { q.filters.push({ type: 'is', col, val }); return api; },
      lt(col, val) { q.filters.push({ type: 'lt', col, val }); return api; },
      lte(col, val) { q.filters.push({ type: 'lte', col, val }); return api; },
      gte(col, val) { q.filters.push({ type: 'gte', col, val }); return api; },
      limit(n) { q.limit = n; return api; },
      order(col, { ascending = true } = {}) { q.orderBy = { col, ascending }; return api; },
      range(from, to) { q.range = [from, to]; return api; },
      then(resolve, reject) {
        return new Promise((res) => setTimeout(res, 1)).then(() => execute(q)).then(resolve, reject);
      },
    };
    return api;
  }

  return {
    from: (table) => builder(table),
    rpc: async (fnName, args) => {
      if (fnName === 'confirm_order_and_reserve_stock') {
        const order = (db.orders || []).find((o) => o.id === args.p_order_id);
        if (!order) return { data: null, error: { message: 'ORDER_NOT_ACCESSIBLE' } };
        order.status = 'CONFIRMED';
        return { data: [{ ...order }], error: null };
      }
      return { data: null, error: { message: `function ${fnName} does not exist` } };
    },
  };
}

function seedDb() {
  return {
    profiles: [
      { id: 'buyer1', role: 'buyer', first_name: 'Buyer', last_name: 'One', email_address: 'buyer1@example.test', phone_number: '9999999999' },
      { id: 'farmer1', role: 'farmer', first_name: 'Farmer', last_name: 'One', email_address: 'farmer1@example.test', phone_number: '7777777777' },
      { id: 'admin1', role: 'admin', first_name: 'Admin', last_name: 'One', email_address: 'admin1@example.test', phone_number: null },
    ],
    products: [
      { id: 'prod1', farmer_id: 'farmer1', name: 'Wheat', user_price: 500, price: 500, quantity: 100 },
    ],
    orders: [],
    payments: [],
    refunds: [],
    idempotency_keys: [],
    audit_log: [],
    notifications: [],
    notification_preferences: [],
  };
}

function setupRazorpay() {
  mockHolder.razorpay = {
    payments: {
      refund: jest.fn(async (paymentId, { amount }) => ({ id: `rfnd_${paymentId}`, amount })),
      fetchMultipleRefund: jest.fn(async () => ({ items: [] })),
      fetch: jest.fn(async (id) => ({ id, status: 'captured', order_id: 'rzp_order_1', amount: 50000 })),
    },
    orders: { fetch: jest.fn(), create: jest.fn(), fetchPayments: jest.fn(async () => ({ items: [] })) },
  };
}

function setup() {
  jest.resetModules();
  const db = seedDb();
  mockHolder.supabase = makeSupabaseMock(db);
  setupRazorpay();
  return {
    db,
    service: require('../services/notificationService'),
    worker: require('../jobs/notificationWorker'),
    templates: require('../services/notificationTemplates'),
    emailAdapter: require('../services/delivery/emailAdapter'),
    smsAdapter: require('../services/delivery/smsAdapter'),
    escrow: require('../services/escrowService'),
  };
}

function rowsFor(db, type, userId) {
  return db.notifications.filter((r) => r.type === type && (!userId || r.user_id === userId));
}

describe('migration file (parse-checked separately with pglast)', () => {
  test('20261124_notifications.sql defines notifications + preferences with user RLS', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '../../supabase/migrations/20261124_notifications.sql'),
      'utf8',
    );
    expect(sql).toContain('notifications');
    expect(sql).toContain('notification_preferences');
    expect(sql).toContain('dedupe_key');
    expect(sql).toContain('UNIQUE');
    expect(sql).toContain('delivery_status');
    expect(sql).toContain('pending');
    expect(sql).toContain('deferred');
    expect(sql).toContain('ROW LEVEL SECURITY');
    expect(sql).toContain('auth.uid() = user_id');
    expect(sql).toContain('is_admin()');
    expect(sql).toContain('20261116');
    expect(sql).not.toMatch(/FOR DELETE/i);
    expect(sql).toContain('order_created');
    expect(sql).toContain('verification_rejected');
  });
});

describe('notificationTemplates', () => {
  test('every event type has hi + en templates built only from the payload (no digits with no data)', () => {
    const { templates } = setup();
    const { EVENT_TYPES } = templates;
    expect(EVENT_TYPES).toHaveLength(24);
    for (const type of EVENT_TYPES) {
      for (const lang of ['hi', 'en']) {
        const { title, body } = templates.buildTemplate(type, lang, {});
        expect(typeof title).toBe('string');
        expect(title.length).toBeGreaterThan(0);
        expect(typeof body).toBe('string');
        expect(body.length).toBeGreaterThan(0);
        expect(`${title} ${body}`).not.toMatch(/\d/);
      }
    }
  });

  test('payload numbers appear in the body only when the payload carries them', () => {
    const { templates } = setup();
    const withPrice = templates.buildTemplate('order_created', 'hi', { total_price: 500 });
    expect(withPrice.body).toContain('500');
    const withOffer = templates.buildTemplate('offer_received', 'en', { price: 2100, quantity: 10 });
    expect(withOffer.body).toContain('2100');
    expect(withOffer.body).toContain('10');
  });

  test('unknown event type throws a validation error', () => {
    const { templates } = setup();
    expect(() => templates.buildTemplate('not_a_type', 'hi', {})).toThrow();
  });
});

describe('delivery adapters (stubs only — no provider assumed)', () => {
  test('email + sms stubs report unconfigured and never claim a send', async () => {
    const { emailAdapter, smsAdapter } = setup();
    expect(emailAdapter.isConfigured()).toBe(false);
    expect(smsAdapter.isConfigured()).toBe(false);
    await expect(emailAdapter.send({ notification: { id: 'n1' }, to: 'a@example.test' }))
      .resolves.toEqual({ ok: false, code: 'PROVIDER_NOT_CONFIGURED' });
    await expect(smsAdapter.send({ notification: { id: 'n1' }, to: '9999999999' }))
      .resolves.toEqual({ ok: false, code: 'PROVIDER_NOT_CONFIGURED' });
  });
});

describe('notificationService.emit', () => {
  let service;
  let db;

  beforeEach(() => {
    ({ db, service } = setup());
  });

  test('one event -> one in_app row per affected user, sent at emit, default prefs', async () => {
    await service.emit({
      eventId: 'order:o1:created', type: 'order_created',
      userIds: ['buyer1', 'farmer1'], payload: { order_id: 'o1', total_price: 500 },
    });
    expect(db.notifications).toHaveLength(2);
    for (const row of db.notifications) {
      expect(row.channel).toBe('in_app');
      expect(row.delivery_status).toBe('sent');
      expect(row.type).toBe('order_created');
      expect(row.read_at).toBe(null);
      expect(row.title.length).toBeGreaterThan(0);
    }
    expect(rowsFor(db, 'order_created', 'buyer1')).toHaveLength(1);
    expect(rowsFor(db, 'order_created', 'farmer1')).toHaveLength(1);
  });

  test('a replayed event creates zero additional rows (dedupe_key)', async () => {
    const args = {
      eventId: 'order:o1:paid', type: 'order_paid',
      userIds: ['farmer1'], payload: { order_id: 'o1' },
    };
    await service.emit(args);
    await service.emit(args);
    await service.emit(args);
    expect(db.notifications).toHaveLength(1);
    expect(db.notifications[0].dedupe_key).toBe('order:o1:paid:farmer1:in_app');
  });

  test('a user with SMS off receives no SMS row (preference respected)', async () => {
    db.notification_preferences.push({
      user_id: 'buyer1', event_type: 'order_shipped', enabled: true,
      channels: ['in_app'], language: 'hi', quiet_start: null, quiet_end: null,
    });
    await service.emit({
      eventId: 'order:o1:shipped', type: 'order_shipped',
      userIds: ['buyer1'], payload: { order_id: 'o1' }, channels: ['in_app', 'sms'],
    });
    expect(db.notifications).toHaveLength(1);
    expect(db.notifications[0].channel).toBe('in_app');
  });

  test('a user who enabled email + sms gets one row per enabled channel', async () => {
    db.notification_preferences.push({
      user_id: 'buyer1', event_type: 'order_shipped', enabled: true,
      channels: ['in_app', 'email', 'sms'], language: 'en', quiet_start: null, quiet_end: null,
    });
    await service.emit({
      eventId: 'order:o1:shipped', type: 'order_shipped',
      userIds: ['buyer1'], payload: { order_id: 'o1' },
    });
    expect(db.notifications).toHaveLength(3);
    expect(db.notifications.map((r) => r.channel).sort()).toEqual(['email', 'in_app', 'sms']);
    const email = db.notifications.find((r) => r.channel === 'email');
    expect(email.delivery_status).toBe('pending');
    expect(email.title).toMatch(/shipped/i);
  });

  test('an opted-out event type emits no row for that user', async () => {
    db.notification_preferences.push({
      user_id: 'buyer1', event_type: 'offer_received', enabled: false,
      channels: ['in_app'], language: 'hi', quiet_start: null, quiet_end: null,
    });
    await service.emit({
      eventId: 'offer:off1:received', type: 'offer_received',
      userIds: ['buyer1', 'farmer1'], payload: { offer_id: 'off1' },
    });
    expect(db.notifications).toHaveLength(1);
    expect(db.notifications[0].user_id).toBe('farmer1');
  });

  test('includeAdmins resolves admins from profiles; zero admins means no admin rows', async () => {
    await service.emit({
      eventId: 'dispute:d1:filed', type: 'dispute_filed',
      userIds: ['farmer1'], payload: { dispute_id: 'd1', order_id: 'o1' }, includeAdmins: true,
    });
    expect(rowsFor(db, 'dispute_filed', 'admin1')).toHaveLength(1);
    expect(rowsFor(db, 'dispute_filed', 'farmer1')).toHaveLength(1);

    db.profiles = db.profiles.filter((p) => p.role !== 'admin');
    db.notifications.length = 0;
    await service.emit({
      eventId: 'verification:s1:submitted', type: 'verification_submitted',
      userIds: [], payload: { submission_id: 's1' }, includeAdmins: true,
    });
    expect(db.notifications).toHaveLength(0);
  });

  test('emit never throws when the tables are missing (best-effort)', async () => {
    delete db.notifications;
    delete db.notification_preferences;
    await expect(service.emit({
      eventId: 'order:o1:created', type: 'order_created',
      userIds: ['buyer1'], payload: { order_id: 'o1' },
    })).resolves.toBeDefined();
  });

  test('unknown event type emits nothing and never throws', async () => {
    await service.emit({
      eventId: 'x:1', type: 'not_a_type', userIds: ['buyer1'], payload: {},
    });
    expect(db.notifications).toHaveLength(0);
  });
});

describe('notificationService preferences + inbox reads', () => {
  let service;
  let db;

  beforeEach(() => {
    ({ db, service } = setup());
  });

  test('upsertPreferences creates then updates the same (user, event) row; bad values 422', async () => {
    const first = await service.upsertPreferences('buyer1', [
      { event_type: 'order_paid', enabled: true, channels: ['in_app', 'email'], language: 'en', quiet_start: '22:00', quiet_end: '07:00' },
    ]);
    expect(first).toHaveLength(1);
    expect(db.notification_preferences).toHaveLength(1);
    const second = await service.upsertPreferences('buyer1', [
      { event_type: 'order_paid', enabled: false, channels: ['in_app'], language: 'hi', quiet_start: null, quiet_end: null },
    ]);
    expect(second).toHaveLength(1);
    expect(db.notification_preferences).toHaveLength(1);
    expect(db.notification_preferences[0].enabled).toBe(false);
    expect(db.notification_preferences[0].language).toBe('hi');

    await expect(service.upsertPreferences('buyer1', [
      { event_type: 'order_paid', enabled: true, channels: ['in_app', 'pigeon'], language: 'hi' },
    ])).rejects.toMatchObject({ status: 422 });
    await expect(service.upsertPreferences('buyer1', [
      { event_type: 'order_paid', enabled: true, channels: ['in_app'], language: 'fr' },
    ])).rejects.toMatchObject({ status: 422 });
    await expect(service.upsertPreferences('buyer1', [
      { event_type: 'order_paid', enabled: true, channels: ['in_app'], language: 'hi', quiet_start: '25:00' },
    ])).rejects.toMatchObject({ status: 422 });
    await expect(service.upsertPreferences('buyer1', [
      { event_type: 'not_a_type', enabled: true, channels: ['in_app'], language: 'hi' },
    ])).rejects.toMatchObject({ status: 422 });
  });

  test('listNotifications pages, filters unread, and counts unread', async () => {
    await service.emit({ eventId: 'e1', type: 'order_created', userIds: ['buyer1'], payload: {} });
    await service.emit({ eventId: 'e2', type: 'order_paid', userIds: ['buyer1'], payload: {} });
    await service.emit({ eventId: 'e3', type: 'order_created', userIds: ['farmer1'], payload: {} });
    const all = await service.listNotifications('buyer1', {});
    expect(all.notifications).toHaveLength(2);
    expect(all.unread_count).toBe(2);
    await service.markRead('buyer1', all.notifications[0].id);
    const unread = await service.listNotifications('buyer1', { unreadOnly: true });
    expect(unread.notifications).toHaveLength(1);
    expect(unread.unread_count).toBe(1);
    const page = await service.listNotifications('buyer1', { limit: 1, offset: 1 });
    expect(page.notifications).toHaveLength(1);
    expect(page.unread_count).toBe(1);
  });

  test('listNotifications exposes next_attempt_at so the inbox can show a deferred retry time', async () => {
    await service.emit({ eventId: 'e1', type: 'order_shipped', userIds: ['buyer1'], payload: {} });
    db.notifications[0].delivery_status = 'deferred';
    db.notifications[0].next_attempt_at = '2026-11-13T07:00:00.000Z';
    const { notifications } = await service.listNotifications('buyer1', {});
    expect(notifications).toHaveLength(1);
    expect(notifications[0].next_attempt_at).toBe('2026-11-13T07:00:00.000Z');
  });

  test('markRead sets read_at on your own row only; a foreign row is 404', async () => {
    await service.emit({ eventId: 'e1', type: 'order_created', userIds: ['buyer1'], payload: {} });
    const id = db.notifications[0].id;
    const marked = await service.markRead('buyer1', id);
    expect(marked.read_at).not.toBe(null);
    await expect(service.markRead('farmer1', id)).rejects.toMatchObject({ status: 404 });
    await expect(service.markRead('buyer1', 'missing-id')).rejects.toMatchObject({ status: 404 });
  });

  test('getPreferences returns only the rows the user has set', async () => {
    await service.upsertPreferences('buyer1', [
      { event_type: 'order_paid', enabled: true, channels: ['in_app'], language: 'hi' },
    ]);
    const prefs = await service.getPreferences('buyer1');
    expect(prefs).toHaveLength(1);
    expect(prefs[0].event_type).toBe('order_paid');
    expect(await service.getPreferences('farmer1')).toHaveLength(0);
  });
});

describe('notificationWorker.processPending', () => {
  let worker;
  let db;

  beforeEach(() => {
    ({ db, worker } = setup());
  });

  const adapters = (overrides = {}) => ({
    email: {
      name: 'brevo-stub',
      isConfigured: () => false,
      send: async () => ({ ok: false, code: 'PROVIDER_NOT_CONFIGURED' }),
      ...overrides.email,
    },
    sms: {
      name: 'httpsms-stub',
      isConfigured: () => false,
      send: async () => ({ ok: false, code: 'PROVIDER_NOT_CONFIGURED' }),
      ...overrides.sms,
    },
  });

  function seedRow(overrides = {}) {
    const row = {
      id: `n_${Math.random().toString(36).slice(2)}`,
      user_id: 'buyer1', type: 'order_shipped', title: 't', body: 'b',
      payload: {}, channel: 'email', delivery_status: 'pending',
      dedupe_key: `seed:${Math.random().toString(36).slice(2)}`,
      attempts: 0, next_attempt_at: null, read_at: null,
      created_at: '2026-11-12T10:00:00.000Z',
      ...overrides,
    };
    db.notifications.push(row);
    return row;
  }

  test('in_app rows are sent immediately with no adapter call', async () => {
    const send = jest.fn(async () => ({ ok: true }));
    const row = seedRow({ channel: 'in_app' });
    const counts = await worker.processPending(mockHolder.supabase, adapters({ email: { send } }));
    expect(counts.sent).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(row.delivery_status).toBe('sent');
  });

  test('a working adapter marks the row sent and passes the profile contact', async () => {
    const send = jest.fn(async () => ({ ok: true }));
    const row = seedRow({ channel: 'email' });
    const counts = await worker.processPending(mockHolder.supabase, adapters({ email: { send } }));
    expect(counts.sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe('buyer1@example.test');
    expect(row.delivery_status).toBe('sent');
  });

  test('a failed delivery is retried with backoff, then failed after 3 attempts — never sent, never dropped', async () => {
    const now = new Date('2026-11-12T10:00:00.000Z');
    const row = seedRow({ channel: 'email' });
    const counts1 = await worker.processPending(mockHolder.supabase, adapters(), { now });
    expect(counts1.failed).toBe(0);
    expect(row.delivery_status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).toBe('2026-11-12T10:02:00.000Z');
    // Simulate time passing: the row is due again.
    row.next_attempt_at = '2026-11-12T10:00:00.000Z';
    await worker.processPending(mockHolder.supabase, adapters(), { now });
    expect(row.attempts).toBe(2);
    expect(row.next_attempt_at).toBe('2026-11-12T10:04:00.000Z');
    row.next_attempt_at = '2026-11-12T10:00:00.000Z';
    const counts3 = await worker.processPending(mockHolder.supabase, adapters(), { now });
    expect(counts3.failed).toBe(1);
    expect(row.attempts).toBe(3);
    expect(row.delivery_status).toBe('failed');
    expect(row.payload.delivery_code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(row.delivery_status).not.toBe('sent');
  });

  test('a row whose next_attempt_at is in the future is not attempted yet', async () => {
    const send = jest.fn(async () => ({ ok: true }));
    seedRow({ channel: 'email', next_attempt_at: '2026-11-12T12:00:00.000Z' });
    const counts = await worker.processPending(
      mockHolder.supabase, adapters({ email: { send } }), { now: new Date('2026-11-12T10:00:00.000Z') },
    );
    expect(counts.processed).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  test('quiet hours defer delivery to quiet-end and never send inside them', async () => {
    db.notification_preferences.push({
      user_id: 'buyer1', event_type: 'order_shipped', enabled: true,
      channels: ['in_app', 'email'], language: 'hi', quiet_start: '22:00', quiet_end: '07:00',
    });
    const send = jest.fn(async () => ({ ok: true }));
    const row = seedRow({ channel: 'email' });
    const counts = await worker.processPending(
      mockHolder.supabase, adapters({ email: { send } }),
      { now: new Date('2026-11-12T23:30:00.000Z') },
    );
    expect(counts.deferred).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(row.delivery_status).toBe('deferred');
    expect(row.next_attempt_at).toBe('2026-11-13T07:00:00.000Z');
    expect(row.attempts).toBe(0);
    // The deferred row is picked up again once its next_attempt_at is due.
    const counts2 = await worker.processPending(
      mockHolder.supabase, adapters({ email: { send } }),
      { now: new Date('2026-11-13T07:00:00.000Z') },
    );
    expect(counts2.sent).toBe(1);
    expect(row.delivery_status).toBe('sent');
  });

  test('opted-out-after-emit: email/sms rows fail with OPTED_OUT, in_app rows still send', async () => {
    db.notification_preferences.push({
      user_id: 'buyer1', event_type: 'order_shipped', enabled: false,
      channels: ['in_app'], language: 'hi', quiet_start: null, quiet_end: null,
    });
    const send = jest.fn(async () => ({ ok: true }));
    const emailRow = seedRow({ channel: 'email' });
    const inAppRow = seedRow({ channel: 'in_app' });
    const counts = await worker.processPending(mockHolder.supabase, adapters({ email: { send } }));
    expect(send).not.toHaveBeenCalled();
    expect(emailRow.delivery_status).toBe('failed');
    expect(emailRow.payload.delivery_code).toBe('OPTED_OUT');
    expect(inAppRow.delivery_status).toBe('sent');
    expect(counts.failed).toBe(1);
    expect(counts.sent).toBe(1);
  });

  test('no contact on file for the channel fails honestly with NO_CONTACT_ON_FILE', async () => {
    db.profiles.find((p) => p.id === 'buyer1').email_address = null;
    const row = seedRow({ channel: 'email' });
    const counts = await worker.processPending(mockHolder.supabase, adapters(), { now: new Date('2026-11-12T10:00:00.000Z') });
    expect(counts.failed).toBe(0);
    expect(row.attempts).toBe(1);
    expect(row.payload.delivery_code).toBe('NO_CONTACT_ON_FILE');
  });
});

describe('escrow transitions emit exactly one notification per affected user', () => {
  let escrow;
  let db;

  beforeEach(() => {
    ({ db, escrow } = setup());
  });

  async function payOrder(order) {
    const stored = db.orders.find((o) => o.id === order.id);
    stored.razorpay_order_id = 'rzp_order_1';
    return escrow.verifyAndMarkPaid(order.id, 'rzp_order_1', 'pay_razor1', 'buyer1');
  }

  test('full lifecycle: created x2, confirmed x1, paid x1, shipped x1, completed x2; replays add zero rows', async () => {
    const order = await escrow.createMarketplaceOrder('buyer1',
      { product_id: 'prod1', quantity: 1, unit: 'kg', delivery_address: 'Mathura' }, 'key-1');
    expect(rowsFor(db, 'order_created')).toHaveLength(2);
    expect(rowsFor(db, 'order_created', 'buyer1')).toHaveLength(1);
    expect(rowsFor(db, 'order_created', 'farmer1')).toHaveLength(1);

    await escrow.updateOrderStatusWithStock(order.id, 'farmer1', 'CONFIRMED');
    expect(rowsFor(db, 'order_confirmed', 'buyer1')).toHaveLength(1);
    expect(rowsFor(db, 'order_confirmed')).toHaveLength(1);

    await payOrder(order);
    expect(rowsFor(db, 'order_paid', 'farmer1')).toHaveLength(1);
    expect(rowsFor(db, 'order_paid')).toHaveLength(1);

    // Replaying the same pay while the order is PAID returns the order
    // and emits nothing new.
    await payOrder(order);
    expect(rowsFor(db, 'order_paid')).toHaveLength(1);

    await escrow.markOrderAsShipped(order.id, 'farmer1');
    expect(rowsFor(db, 'order_shipped', 'buyer1')).toHaveLength(1);

    await escrow.markOrderAsCompleted(order.id, 'buyer1');
    expect(rowsFor(db, 'order_completed')).toHaveLength(2);
    expect(rowsFor(db, 'order_completed', 'buyer1')).toHaveLength(1);
    expect(rowsFor(db, 'order_completed', 'farmer1')).toHaveLength(1);

    // Replays: the same create call replays the idempotency key — zero
    // new rows. (A pay replay is covered above, while the order is PAID;
    // after completion the pay path correctly 409s.)
    const before = db.notifications.length;
    const replayed = await escrow.createMarketplaceOrder('buyer1',
      { product_id: 'prod1', quantity: 1, unit: 'kg', delivery_address: 'Mathura' }, 'key-1');
    expect(replayed.id).toBe(order.id);
    expect(db.notifications.length).toBe(before);
  });

  test('decline notifies the buyer; refund request + refund notify farmer then buyer; replays add zero rows', async () => {
    const declined = await escrow.createMarketplaceOrder('buyer1',
      { product_id: 'prod1', quantity: 1, unit: 'kg', delivery_address: 'Mathura' }, 'key-decline');
    await escrow.updateOrderStatusWithStock(declined.id, 'farmer1', 'DECLINED');
    expect(rowsFor(db, 'order_declined', 'buyer1')).toHaveLength(1);
    expect(rowsFor(db, 'order_declined')).toHaveLength(1);

    const order = await escrow.createMarketplaceOrder('buyer1',
      { product_id: 'prod1', quantity: 1, unit: 'kg', delivery_address: 'Mathura' }, 'key-2');
    await escrow.updateOrderStatusWithStock(order.id, 'farmer1', 'CONFIRMED');
    await payOrder(order);
    const requested = await escrow.markRefundPending(order.id, { buyerId: 'buyer1' });
    expect(requested).not.toBe(null);
    expect(rowsFor(db, 'refund_requested', 'farmer1')).toHaveLength(1);
    const again = await escrow.markRefundPending(order.id, { buyerId: 'buyer1' });
    expect(again).toBe(null);
    expect(rowsFor(db, 'refund_requested', 'farmer1')).toHaveLength(1);

    const res = await escrow.refundOrder(order.id);
    expect(res.success).toBe(true);
    expect(rowsFor(db, 'refunded', 'buyer1')).toHaveLength(1);
    expect(rowsFor(db, 'refunded')).toHaveLength(1);
    const res2 = await escrow.refundOrder(order.id);
    expect(res2.success).toBe(true);
    expect(res2.alreadyHandled).toBe(true);
    expect(rowsFor(db, 'refunded', 'buyer1')).toHaveLength(1);
  });
});
