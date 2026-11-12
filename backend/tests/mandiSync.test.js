'use strict';
/**
 * Mandi price sync job (Stage 3, module B) — unit.
 *
 * TDD: written FIRST and watched RED (job module not found) before any
 * implementation. The OGD API is NEVER hit from tests (it is unreachable
 * from this VM anyway) — fetch is injected and fixtures carry the real
 * field names from Rishabh's verified live response (2026-11-13 01:37
 * IST): Onion, Mukkom Market, Kerala, min 5200 / max 5500 / modal
 * 5400, arrival 12/11/2026, total 16,787 records. The XML fixture is
 * the exact structure his browser received (JSON was requested, XML
 * arrived). The in-memory fake Supabase enforces the mandi_prices
 * UNIQUE key on insert with ignoreDuplicates, like PostgREST.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const mockHolder = { admin: null };

jest.mock('../utils/supabaseAdmin', () => ({
  from: (...args) => mockHolder.admin.from(...args),
}));

function makeFakeAdmin(tables) {
  const insertCalls = [];
  function keyOf(r) {
    return [r.commodity, r.mandi, r.date, r.variety || '', r.grade || ''].join('|');
  }
  function matches(row, filters) {
    for (const f of filters) {
      if (f.type === 'eq' && row[f.col] !== f.val) return false;
    }
    return true;
  }
  function execute(q) {
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
      const out = rows.map((r) => ({ ...r }));
      return { data: q.single ? (out[0] ?? null) : out, error: null };
    }
    if (q.op === 'update') {
      const matched = table.filter((r) => matches(r, q.filters));
      for (const r of matched) Object.assign(r, q.fields);
      const out = matched.map((r) => ({ ...r }));
      return { data: q.single ? (out[0] ?? null) : out, error: null };
    }
    if (q.op === 'insert') {
      const rows = (Array.isArray(q.row) ? q.row : [q.row]).map((r) => ({
        id: `id_${Math.random().toString(36).slice(2)}`, ...r,
      }));
      const inserted = [];
      for (const r of rows) {
        // ON CONFLICT DO NOTHING on the mandi_prices unique key.
        if (q.options && q.options.ignoreDuplicates && q.table === 'mandi_prices') {
          if (table.some((t) => keyOf(t) === keyOf(r))) continue;
        }
        table.push(r);
        inserted.push({ ...r });
      }
      return { data: inserted, error: null };
    }
    return { data: null, error: { message: 'unsupported op' } };
  }
  function builder(table) {
    const q = { table, op: null, fields: null, row: null, options: null, filters: [], limit: null, order: null, single: false };
    const api = {
      select() { if (!q.op) q.op = 'select'; return api; },
      update(fields) { q.op = 'update'; q.fields = fields; return api; },
      insert(row, options) { q.op = 'insert'; q.row = row; q.options = options || null; insertCalls.push({ table, options: q.options }); return api; },
      eq(col, val) { q.filters.push({ type: 'eq', col, val }); return api; },
      order(col, options = {}) { q.order = { col, ascending: options.ascending !== false }; return api; },
      limit(n) { q.limit = n; return api; },
      single() { q.single = true; return api; },
      then(resolve, reject) {
        return Promise.resolve().then(() => execute(q)).then(resolve, reject);
      },
    };
    return api;
  }
  return { from: (table) => builder(table), insertCalls };
}

// Verified live OGD record (Rishabh's browser test, 2026-11-13 01:37 IST).
const ONION_JSON = {
  state: 'Kerala', district: 'Kozhikode', market: 'Mukkom Market',
  commodity: 'Onion', variety: 'Other', grade: 'FAQ',
  arrival_date: '12/11/2026', min_price: '5200', max_price: '5500', modal_price: '5400',
};
const ONION_XML = `<result><status>ok</status><total>16787</total><count>1</count><records><item><state>Kerala</state><district>Kozhikode</district><market>Mukkom Market</market><commodity>Onion</commodity><variety>Other</variety><grade>FAQ</grade><arrival_date>12/11/2026</arrival_date><min_price>5200</min_price><max_price>5500</max_price><modal_price>5400</modal_price></item></records></result>`;
const ONION_JSON_TEXT = JSON.stringify({ status: 'ok', total: 16787, count: 1, records: [ONION_JSON] });

function setup(tables = {}) {
  jest.resetModules();
  const db = {
    mandi_prices: tables.mandi_prices !== undefined ? tables.mandi_prices : [],
    price_alerts: tables.price_alerts !== undefined ? tables.price_alerts : [],
    platform_cost_params: tables.platform_cost_params !== undefined ? tables.platform_cost_params : [],
  };
  mockHolder.admin = makeFakeAdmin(db);
  const job = require('../jobs/mandiSync');
  const service = require('../services/fairPriceService');
  return { db, job, service };
}

describe('parseOgdResponse', () => {
  test('JSON body -> records array (verified field names)', () => {
    const { job } = setup();
    const records = job.parseOgdResponse(ONION_JSON_TEXT);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ commodity: 'Onion', market: 'Mukkom Market', modal_price: '5400' });
  });
  test('XML body -> the SAME records (browser got XML despite format=json)', () => {
    const { job } = setup();
    const records = job.parseOgdResponse(ONION_XML);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ commodity: 'Onion', market: 'Mukkom Market', modal_price: '5400' });
  });
  test('JSON and XML fixtures normalise to identical rows', () => {
    const { job, service } = setup();
    const fromJson = service.normaliseRow(job.parseOgdResponse(ONION_JSON_TEXT)[0]);
    const fromXml = service.normaliseRow(job.parseOgdResponse(ONION_XML)[0]);
    expect(fromXml).toEqual(fromJson);
  });
  test('XML entities decode; error status throws; empty/garbage throws', () => {
    const { job } = setup();
    const xml = '<result><status>ok</status><records><item><state>Uttar Pradesh</state><market>Mathura &amp; Sons</market><commodity>Wheat</commodity><arrival_date>12/11/2026</arrival_date><modal_price>2400</modal_price></item></records></result>';
    expect(job.parseOgdResponse(xml)[0].market).toBe('Mathura & Sons');
    expect(() => job.parseOgdResponse('<result><status>error</status><message>Invalid key</message></result>')).toThrow('Invalid key');
    expect(() => job.parseOgdResponse('')).toThrow();
    expect(() => job.parseOgdResponse('hello')).toThrow();
    expect(() => job.parseOgdResponse(JSON.stringify({ status: 'ok' }))).toThrow('no records array');
  });
});

describe('fetchWithRetry', () => {
  test('fails twice then succeeds -> 3 calls, returns the body', async () => {
    const { job } = setup();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls < 3) throw new Error('network down');
      return { ok: true, text: async () => ONION_JSON_TEXT };
    };
    const text = await job.fetchWithRetry('https://example.test/x', { fetchImpl, sleepImpl: async () => {} });
    expect(calls).toBe(3);
    expect(text).toBe(ONION_JSON_TEXT);
  });
  test('always failing -> 4 attempts (initial + 3 retries), then throws', async () => {
    const { job } = setup();
    let calls = 0;
    const fetchImpl = async () => { calls += 1; throw new Error('network down'); };
    await expect(job.fetchWithRetry('https://example.test/x', { fetchImpl, sleepImpl: async () => {} })).rejects.toThrow('network down');
    expect(calls).toBe(4);
  });
  test('HTTP error status retries like a network failure', async () => {
    const { job } = setup();
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { ok: false, status: 500, text: async () => '' }; };
    await expect(job.fetchWithRetry('https://example.test/x', { fetchImpl, sleepImpl: async () => {} })).rejects.toThrow('HTTP 500');
    expect(calls).toBe(4);
  });
});

describe('buildUrl', () => {
  test('carries api-key, format=json, limit, offset and the state filter', () => {
    const { job } = setup();
    const url = new URL(job.buildUrl({ apiKey: 'k', state: 'Kerala', offset: 1000, limit: 1000 }));
    expect(url.searchParams.get('api-key')).toBe('k');
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('limit')).toBe('1000');
    expect(url.searchParams.get('offset')).toBe('1000');
    expect(url.searchParams.get('filters[state]')).toBe('Kerala');
    expect(job.buildUrl({ apiKey: 'k', state: null, offset: 0, limit: 1000 })).not.toContain('filters');
  });
});

describe('runMandiSync', () => {
  const OLD_KEY = process.env.DATA_GOV_API_KEY;
  beforeEach(() => { delete process.env.DATA_GOV_API_KEY; });
  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env.DATA_GOV_API_KEY;
    else process.env.DATA_GOV_API_KEY = OLD_KEY;
  });

  test('no API key -> ok:false, fetch never called, nothing inserted', async () => {
    const { job } = setup();
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { ok: true, text: async () => ONION_JSON_TEXT }; };
    const summary = await job.runMandiSync({ fetchImpl, states: ['Kerala'] });
    expect(summary.ok).toBe(false);
    expect(summary.error).toMatch(/DATA_GOV_API_KEY is not set/);
    expect(calls).toBe(0);
  });

  test('paginates (limit 2: 2 rows then 1), inserts with ON CONFLICT DO NOTHING', async () => {
    process.env.DATA_GOV_API_KEY = 'test-key';
    const { db, job } = setup();
    const page1 = JSON.stringify({ status: 'ok', total: 3, count: 2, records: [
      ONION_JSON,
      { ...ONION_JSON, market: 'Kochi', modal_price: '5300', min_price: '5100', max_price: '5400' },
    ] });
    const page2 = JSON.stringify({ status: 'ok', total: 3, count: 1, records: [
      { ...ONION_JSON, market: 'Palakkad', modal_price: '5200', min_price: '5000', max_price: '5300' },
    ] });
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      const offset = Number(new URL(url).searchParams.get('offset'));
      return { ok: true, text: async () => (offset === 0 ? page1 : page2) };
    };
    const summary = await job.runMandiSync({ fetchImpl, states: ['Kerala'], limit: 2, sleepImpl: async () => {} });
    expect(summary.ok).toBe(true);
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0]).searchParams.get('offset')).toBe('0');
    expect(new URL(urls[1]).searchParams.get('offset')).toBe('2');
    expect(summary.fetched).toBe(3);
    expect(summary.inserted).toBe(3);
    expect(db.mandi_prices).toHaveLength(3);
    const insertCall = mockHolder.admin.insertCalls.find((c) => c.table === 'mandi_prices');
    expect(insertCall.options).toMatchObject({ onConflict: 'commodity,mandi,date,variety,grade', ignoreDuplicates: true });
  });

  test('re-fetch of the same day inserts nothing (duplicates counted, not re-inserted)', async () => {
    process.env.DATA_GOV_API_KEY = 'test-key';
    const { db, job } = setup({
      mandi_prices: [{
        id: 'seed', commodity: 'Onion', variety: 'Other', grade: 'FAQ', state: 'Kerala',
        district: 'Kozhikode', mandi: 'Mukkom Market', date: '2026-11-12',
        min_price: 5200, max_price: 5500, modal_price: 5400, unit: 'quintal',
        source: 'Agmarknet / data.gov.in', raw: {}, synced_at: '2026-11-12T11:00:00.000Z',
      }],
    });
    const fetchImpl = async () => ({ ok: true, text: async () => ONION_JSON_TEXT });
    const summary = await job.runMandiSync({ fetchImpl, states: ['Kerala'], sleepImpl: async () => {} });
    expect(summary.ok).toBe(true);
    expect(summary.inserted).toBe(0);
    expect(summary.duplicates).toBe(1);
    expect(db.mandi_prices).toHaveLength(1);
  });

  test('invalid rows are counted, never inserted', async () => {
    process.env.DATA_GOV_API_KEY = 'test-key';
    const { db, job } = setup();
    const feed = JSON.stringify({ status: 'ok', total: 2, count: 2, records: [
      ONION_JSON,
      { ...ONION_JSON, modal_price: '' },
    ] });
    const fetchImpl = async () => ({ ok: true, text: async () => feed });
    const summary = await job.runMandiSync({ fetchImpl, states: ['Kerala'], sleepImpl: async () => {} });
    expect(summary.inserted).toBe(1);
    expect(summary.invalid).toBe(1);
    expect(db.mandi_prices).toHaveLength(1);
  });

  test('failed upstream -> ok:false, yesterday’s snapshot stays untouched', async () => {
    process.env.DATA_GOV_API_KEY = 'test-key';
    const { db, job } = setup({
      mandi_prices: [{
        id: 'yesterday', commodity: 'Onion', variety: 'Other', grade: 'FAQ', state: 'Kerala',
        district: 'Kozhikode', mandi: 'Mukkom Market', date: '2026-11-11',
        min_price: 5000, max_price: 5200, modal_price: 5100, unit: 'quintal',
        source: 'Agmarknet / data.gov.in', raw: {}, synced_at: '2026-11-11T20:30:00.000Z',
      }],
    });
    const fetchImpl = async () => { throw new Error('network down'); };
    const summary = await job.runMandiSync({ fetchImpl, states: ['Kerala'], sleepImpl: async () => {} });
    expect(summary.ok).toBe(false);
    expect(summary.errors).toHaveLength(1);
    expect(db.mandi_prices).toHaveLength(1);
    expect(db.mandi_prices[0].id).toBe('yesterday');
  });

  test('XML feed syncs exactly like JSON', async () => {
    process.env.DATA_GOV_API_KEY = 'test-key';
    const { db, job } = setup();
    const fetchImpl = async () => ({ ok: true, text: async () => ONION_XML });
    const summary = await job.runMandiSync({ fetchImpl, states: ['Kerala'], sleepImpl: async () => {} });
    expect(summary.ok).toBe(true);
    expect(summary.inserted).toBe(1);
    expect(db.mandi_prices[0]).toMatchObject({ commodity: 'Onion', mandi: 'Mukkom Market', modal_price: 5400 });
  });

  test('a real threshold crossing fires the alert after sync', async () => {
    process.env.DATA_GOV_API_KEY = 'test-key';
    const history = [5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000]
      .map((m, i) => ({
        id: `h${i}`, commodity: 'Wheat', variety: '', grade: '', state: 'Uttar Pradesh',
        district: 'Mathura', mandi: 'Mathura', date: `2026-11-${String(4 + i).padStart(2, '0')}`,
        min_price: m, max_price: m, modal_price: m, unit: 'quintal',
        source: 'Agmarknet / data.gov.in', raw: {}, synced_at: '2026-11-12T20:30:00.000Z',
      }));
    const { db, job } = setup({
      mandi_prices: history,
      price_alerts: [{
        id: 'a1', user_id: 'u1', commodity: 'Wheat', threshold_pct: 10,
        basis: 'yesterday', direction: 'rise', last_triggered_date: null,
      }],
    });
    const wheatRow = JSON.stringify({ status: 'ok', total: 1, count: 1, records: [{
      state: 'Uttar Pradesh', district: 'Mathura', market: 'Mathura', commodity: 'Wheat',
      variety: '', grade: '', arrival_date: '12/11/2026',
      min_price: '5500', max_price: '5700', modal_price: '5600',
    }] });
    const fetchImpl = async () => ({ ok: true, text: async () => wheatRow });
    const summary = await job.runMandiSync({ fetchImpl, states: ['Uttar Pradesh'], sleepImpl: async () => {} });
    expect(summary.ok).toBe(true);
    expect(summary.alerts.fired.map((f) => f.alertId)).toEqual(['a1']);
    expect(db.price_alerts[0].last_triggered_date).toBe('2026-11-12');
  });
});
