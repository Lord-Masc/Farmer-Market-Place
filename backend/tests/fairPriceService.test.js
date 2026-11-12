'use strict';
/**
 * FairPrice Intelligence (Stage 3, module B) — service unit.
 *
 * TDD: written FIRST and watched RED (service module not found) before
 * any implementation. The service is tested against an in-memory fake
 * Supabase client (same builder pattern as adminStage10.test.js, with
 * single() unwrapping the row — the real client returns one row, not
 * an array). The migration is asserted by SQL content here and
 * parse-checked separately with pglast (no live Postgres in this repo).
 *
 * Fixtures: the Onion row is Rishabh's VERIFIED live OGD response
 * (2026-11-13 01:37 IST, his browser test): Mukkom Market, Kerala,
 * min 5200 / max 5500 / modal 5400, arrival 12/11/2026. All other
 * numbers are hand-pinned test literals, not production data.
 *
 * Units: every price is RUPEES per QUINTAL. Net earnings are rupees
 * (2dp). A missing cell is null / "no data", never a filled-in number.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const fs = require('fs');
const path = require('path');

const mockHolder = { admin: null };

jest.mock('../utils/supabaseAdmin', () => ({
  from: (...args) => mockHolder.admin.from(...args),
}));

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
    if (opts.missingTable && q.table === opts.missingTable) {
      return { data: null, error: { code: '42P01', message: `relation "public.${q.table}" does not exist` } };
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
      for (const r of rows) table.push(r);
      const out = rows.map((r) => ({ ...r }));
      return { data: q.single ? (out[0] ?? null) : out, error: null };
    }
    return { data: null, error: { message: 'unsupported op' } };
  }
  function builder(table) {
    const q = { table, op: null, fields: null, row: null, filters: [], limit: null, order: null, single: false };
    const api = {
      select() { if (!q.op) q.op = 'select'; return api; },
      update(fields) { q.op = 'update'; q.fields = fields; return api; },
      insert(row) { q.op = 'insert'; q.row = row; return api; },
      eq(col, val) { q.filters.push({ type: 'eq', col, val }); return api; },
      in(col, val) { q.filters.push({ type: 'in', col, val }); return api; },
      is(col, val) { q.filters.push({ type: 'is', col, val }); return api; },
      order(col, options = {}) { q.order = { col, ascending: options.ascending !== false }; return api; },
      limit(n) { q.limit = n; return api; },
      single() { q.single = true; return api; },
      then(resolve, reject) {
        return Promise.resolve().then(() => execute(q)).then(resolve, reject);
      },
    };
    return api;
  }
  return { from: (table) => builder(table) };
}

// Verified live OGD row (Rishabh's browser test, 2026-11-13 01:37 IST).
const ONION_ROW = {
  state: 'Kerala', district: 'Kozhikode', market: 'Mukkom Market',
  commodity: 'Onion', variety: 'Other', grade: 'FAQ',
  arrival_date: '12/11/2026', min_price: '5200', max_price: '5500', modal_price: '5400',
};

function mandiRow(overrides = {}) {
  return {
    id: `mp_${Math.random().toString(36).slice(2)}`,
    commodity: 'Onion', variety: '', grade: '', state: 'Kerala', district: 'Kozhikode',
    mandi: 'Mukkom Market', date: '2026-11-12',
    min_price: 5200, max_price: 5500, modal_price: 5400,
    unit: 'quintal', source: 'Agmarknet / data.gov.in', raw: {}, synced_at: '2026-11-12T20:30:00.000Z',
    ...overrides,
  };
}

function setup(tables = {}, opts = {}) {
  jest.resetModules();
  const db = {
    mandi_prices: tables.mandi_prices !== undefined ? tables.mandi_prices : [],
    price_alerts: tables.price_alerts !== undefined ? tables.price_alerts : [],
    platform_cost_params: tables.platform_cost_params !== undefined ? tables.platform_cost_params : [],
  };
  mockHolder.admin = makeFakeAdmin(db, opts);
  const service = require('../services/fairPriceService');
  return { db, service };
}

describe('normaliseCommodity', () => {
  test('verified alias: Lady Finger -> Bhindi (both spellings)', () => {
    const { service } = setup();
    expect(service.normaliseCommodity('Lady Finger')).toBe('Bhindi');
    expect(service.normaliseCommodity('ladyfinger')).toBe('Bhindi');
    expect(service.normaliseCommodity('Bhindi')).toBe('Bhindi');
  });
  test('case + whitespace normalisation, unknown names pass through', () => {
    const { service } = setup();
    expect(service.normaliseCommodity('  oNiOn  ')).toBe('Onion');
    expect(service.normaliseCommodity('TOMATO')).toBe('Tomato');
    expect(service.normaliseCommodity('')).toBe('');
    expect(service.normaliseCommodity(null)).toBe('');
  });
});

describe('parseOgdDate', () => {
  test('DD/MM/YYYY -> ISO; ISO passes through; invalid -> null', () => {
    const { service } = setup();
    expect(service.parseOgdDate('12/11/2026')).toBe('2026-11-12');
    expect(service.parseOgdDate('2026-11-12')).toBe('2026-11-12');
    expect(service.parseOgdDate('32/13/2026')).toBeNull();
    expect(service.parseOgdDate('')).toBeNull();
    expect(service.parseOgdDate(null)).toBeNull();
  });
});

describe('normalisePrice', () => {
  test('rupees pass through; kg hint converts x100; bad values -> null', () => {
    const { service } = setup();
    expect(service.normalisePrice(5400)).toBe(5400);
    expect(service.normalisePrice('5400')).toBe(5400);
    expect(service.normalisePrice(54, 'Kg')).toBe(5400);
    expect(service.normalisePrice('abc')).toBeNull();
    expect(service.normalisePrice(-5)).toBeNull();
    expect(service.normalisePrice(null)).toBeNull();
  });
});

describe('normaliseRow', () => {
  test('verified Onion row normalises to rupees/quintal with source + raw', () => {
    const { service } = setup();
    const row = service.normaliseRow(ONION_ROW);
    expect(row).toMatchObject({
      commodity: 'Onion', mandi: 'Mukkom Market', state: 'Kerala',
      district: 'Kozhikode', date: '2026-11-12',
      min_price: 5200, max_price: 5500, modal_price: 5400,
      unit: 'quintal', source: 'Agmarknet / data.gov.in',
    });
    expect(row.raw).toEqual(ONION_ROW);
  });
  test('Lady Finger row becomes Bhindi; missing modal/mandi/date -> null', () => {
    const { service } = setup();
    expect(service.normaliseRow({ ...ONION_ROW, commodity: 'Lady Finger' }).commodity).toBe('Bhindi');
    expect(service.normaliseRow({ ...ONION_ROW, modal_price: '' })).toBeNull();
    expect(service.normaliseRow({ ...ONION_ROW, market: '' })).toBeNull();
    expect(service.normaliseRow({ ...ONION_ROW, arrival_date: 'tomorrow' })).toBeNull();
    expect(service.normaliseRow(null)).toBeNull();
  });
  test('missing min/max fall back to the modal (no range reported, no invented price)', () => {
    const { service } = setup();
    const row = service.normaliseRow({ ...ONION_ROW, min_price: '', max_price: '' });
    expect(row.min_price).toBe(5400);
    expect(row.max_price).toBe(5400);
  });
});

describe('freshnessFor', () => {
  test('today / yesterday are fresh; older is stale with its date', () => {
    const { service } = setup();
    expect(service.freshnessFor('2026-11-13', '2026-11-13')).toMatchObject({ label: 'Today', isStale: false });
    expect(service.freshnessFor('2026-11-12', '2026-11-13')).toMatchObject({ label: 'Yesterday', isStale: false });
    expect(service.freshnessFor('2026-11-10', '2026-11-13')).toMatchObject({ label: 'Stale — 2026-11-10', isStale: true, daysOld: 3 });
  });
});

describe('computeNetEarnings', () => {
  // Hand-checked literals: modal 5400/qtl, 10 qtl, transport ₹50/qtl,
  // commission 2%, packaging ₹20/qtl, platform fee ₹10/qtl, wastage 5%.
  // saleable 9.5 qtl; gross 5400*9.5 = 51300; transport 500;
  // commission 51300*0.02 = 1026; packaging 200; fee 100;
  // net 51300-500-1026-200-100 = 49474; per qtl 4947.4; wastage 0.5 qtl.
  const PARAMS = {
    transport_paise_per_quintal: 5000, commission_pct: 2,
    packaging_paise_per_quintal: 2000, platform_fee_paise_per_quintal: 1000,
    wastage_pct: 5, version: 1,
  };
  test('itemised maths matches hand-checked literals, labelled estimated', () => {
    const { service } = setup();
    const r = service.computeNetEarnings({ modalPriceRupees: 5400, quantityQuintals: 10, costParams: PARAMS });
    expect(r).toMatchObject({
      gross: 51300, transport: 500, commission: 1026, packaging: 200,
      platformFee: 100, wastageQty: 0.5, saleableQty: 9.5,
      net: 49474, netPerQuintal: 4947.4, currency: 'INR', estimated: true,
    });
  });
  test('no cost params -> null (not configured); qty 0 -> null', () => {
    const { service } = setup();
    expect(service.computeNetEarnings({ modalPriceRupees: 5400, quantityQuintals: 10, costParams: null })).toBeNull();
    expect(service.computeNetEarnings({ modalPriceRupees: 5400, quantityQuintals: 0, costParams: PARAMS })).toBeNull();
  });
  test('net CAN be negative — costs exceeding gross are honest, never clamped', () => {
    const { service } = setup();
    const r = service.computeNetEarnings({
      modalPriceRupees: 100, quantityQuintals: 1,
      costParams: { ...PARAMS, transport_paise_per_quintal: 20000, commission_pct: 0, packaging_paise_per_quintal: 0, platform_fee_paise_per_quintal: 0, wastage_pct: 0 },
    });
    expect(r.net).toBe(-100);
  });
});

describe('getLatestPrice', () => {
  test('latest date wins; primary is the deterministic first row (mandi ASC)', async () => {
    const { service } = setup({
      mandi_prices: [
        mandiRow({ mandi: 'Mukkom Market', date: '2026-11-12', modal_price: 5400 }),
        mandiRow({ mandi: 'Kochi', date: '2026-11-12', modal_price: 5300 }),
        mandiRow({ mandi: 'Mukkom Market', date: '2026-11-11', modal_price: 5000 }),
      ],
    });
    const r = await service.getLatestPrice('Onion');
    expect(r.date).toBe('2026-11-12');
    expect(r.prices).toHaveLength(2);
    expect(r.primary.mandi).toBe('Kochi');
    expect(r.source).toBe('Agmarknet / data.gov.in');
    expect(r.freshness.isStale).toBe(false);
  });
  test('state + mandi filters narrow the rows; no rows -> null', async () => {
    const { service } = setup({
      mandi_prices: [mandiRow({ state: 'Kerala' }), mandiRow({ state: 'Punjab', mandi: 'Ludhiana', modal_price: 5000 })],
    });
    expect((await service.getLatestPrice('Onion', { state: 'Punjab' })).prices).toHaveLength(1);
    expect(await service.getLatestPrice('Wheat')).toBeNull();
  });
  test('missing table -> null, never a 500', async () => {
    const { service } = setup({}, { missingTable: 'mandi_prices' });
    expect(await service.getLatestPrice('Onion')).toBeNull();
  });
});

describe('getHistory', () => {
  // 9 days, modals 5000,5100,5200,5100,5300,5400,5300,5500,5400.
  // change vs yesterday: (5400-5500)/5500*100 = -1.82.
  // avg7 (prior 7, excl latest): (5100+5200+5100+5300+5400+5300+5500)/7 = 5271.43.
  const SERIES = [5000, 5100, 5200, 5100, 5300, 5400, 5300, 5500, 5400]
    .map((m, i) => mandiRow({ date: `2026-11-${String(4 + i).padStart(2, '0')}`, modal_price: m }));
  test('daily series + change + avg7 match hand-checked literals', async () => {
    const { service } = setup({ mandi_prices: SERIES });
    const h = await service.getHistory('Onion', { days: 30 });
    expect(h.series).toHaveLength(9);
    expect(h.latest_date).toBe('2026-11-12');
    expect(h.change_pct_vs_yesterday).toBe(-1.82);
    expect(h.avg7_modal).toBe(5271.43);
  });
  test('one day of history -> change and avg7 are null, never 0', async () => {
    const { service } = setup({ mandi_prices: [mandiRow()] });
    const h = await service.getHistory('Onion');
    expect(h.series).toHaveLength(1);
    expect(h.change_pct_vs_yesterday).toBeNull();
    expect(h.avg7_modal).toBeNull();
  });
  test('missing table -> empty series', async () => {
    const { service } = setup({}, { missingTable: 'mandi_prices' });
    const h = await service.getHistory('Onion');
    expect(h.series).toEqual([]);
  });
});

describe('getNearbyMandis', () => {
  test('same commodity + same day, other mandis, modal DESC', async () => {
    const { service } = setup({
      mandi_prices: [
        mandiRow({ mandi: 'Mukkom Market', modal_price: 5400 }),
        mandiRow({ mandi: 'Kochi', modal_price: 5300 }),
        mandiRow({ mandi: 'Palakkad', modal_price: 5200 }),
      ],
    });
    const rows = await service.getNearbyMandis('Onion', { mandi: 'Mukkom Market' });
    expect(rows.map((r) => r.mandi)).toEqual(['Kochi', 'Palakkad']);
  });
  test('no data -> []', async () => {
    const { service } = setup();
    expect(await service.getNearbyMandis('Onion')).toEqual([]);
  });
});

describe('getCostParams', () => {
  const PARAMS = (state, cls) => ({
    state, commodity_class: cls, transport_paise_per_quintal: 1000, commission_pct: 1,
    packaging_paise_per_quintal: 500, platform_fee_paise_per_quintal: 100, wastage_pct: 2,
    version: 1, is_current: true,
  });
  test('most specific scope wins; falls back to global; none -> null', async () => {
    const { service } = setup({
      platform_cost_params: [
        PARAMS(null, null), PARAMS('Uttar Pradesh', null),
        PARAMS(null, 'Grains'), PARAMS('Uttar Pradesh', 'Grains'),
      ],
    });
    expect((await service.getCostParams({ state: 'Uttar Pradesh', commodityClass: 'Grains' })).commodity_class).toBe('Grains');
    expect((await service.getCostParams({ state: 'Uttar Pradesh', commodityClass: 'Grains' })).state).toBe('Uttar Pradesh');
    expect((await service.getCostParams({ state: 'Punjab', commodityClass: 'Grains' })).state).toBeNull();
    expect((await service.getCostParams({ state: 'Punjab', commodityClass: 'Vegetables' })).state).toBeNull();
  });
  test('no rows -> null', async () => {
    const { service } = setup();
    expect(await service.getCostParams({})).toBeNull();
  });
});

describe('price alerts', () => {
  test('create validates: bad basis / direction / threshold throw', async () => {
    const { service } = setup();
    await expect(service.createAlert('u1', { commodity: 'Wheat', threshold_pct: 10, basis: 'yesterday', direction: 'rise' })).resolves.toMatchObject({ commodity: 'Wheat' });
    await expect(service.createAlert('u1', { commodity: 'Wheat', threshold_pct: 10, basis: 'week', direction: 'rise' })).rejects.toThrow();
    await expect(service.createAlert('u1', { commodity: 'Wheat', threshold_pct: 0, basis: 'yesterday', direction: 'rise' })).rejects.toThrow();
    await expect(service.createAlert('u1', { commodity: 'Wheat', threshold_pct: 10, basis: 'yesterday', direction: 'sideways' })).rejects.toThrow();
  });
  test('list returns only the caller’s alerts', async () => {
    const { db, service } = setup({
      price_alerts: [
        { id: 'a1', user_id: 'u1', commodity: 'Wheat', threshold_pct: 10, basis: 'yesterday', direction: 'rise' },
        { id: 'a2', user_id: 'u2', commodity: 'Wheat', threshold_pct: 10, basis: 'yesterday', direction: 'rise' },
      ],
    });
    expect((await service.listAlerts('u1')).map((a) => a.id)).toEqual(['a1']);
    expect(db.price_alerts).toHaveLength(2);
  });
});

describe('evaluateAlerts', () => {
  // Wheat flat 5000 for 8 days (11-04..11-11), then 5600 on 11-12 (+12%).
  const WHEAT = [5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5600]
    .map((m, i) => mandiRow({
      commodity: 'Wheat', date: `2026-11-${String(4 + i).padStart(2, '0')}`, modal_price: m,
      mandi: 'Mathura', state: 'Uttar Pradesh',
    }));
  test('fires only on a real crossing — 12% rise fires a 10% rise alert, not a 15% one', async () => {
    const { db, service } = setup({
      mandi_prices: WHEAT,
      price_alerts: [
        { id: 'a10', user_id: 'u1', commodity: 'Wheat', threshold_pct: 10, basis: 'yesterday', direction: 'rise', last_triggered_date: null },
        { id: 'a15', user_id: 'u1', commodity: 'Wheat', threshold_pct: 15, basis: 'yesterday', direction: 'rise', last_triggered_date: null },
        { id: 'aFall', user_id: 'u1', commodity: 'Wheat', threshold_pct: 10, basis: 'yesterday', direction: 'fall', last_triggered_date: null },
      ],
    });
    const r = await service.evaluateAlerts();
    expect(r.evaluated).toBe(3);
    expect(r.fired.map((f) => f.alertId)).toEqual(['a10']);
    expect(r.fired[0]).toMatchObject({ commodity: 'Wheat', change_pct: 12, latest_price: 5600, reference_price: 5000 });
    expect(db.price_alerts.find((a) => a.id === 'a10').last_triggered_date).toBe('2026-11-12');
  });
  test('never re-fires on the same data date', async () => {
    const { service } = setup({
      mandi_prices: WHEAT,
      price_alerts: [
        { id: 'a10', user_id: 'u1', commodity: 'Wheat', threshold_pct: 10, basis: 'yesterday', direction: 'rise', last_triggered_date: '2026-11-12' },
      ],
    });
    const r = await service.evaluateAlerts();
    expect(r.fired).toEqual([]);
  });
  test('avg7 basis uses the 7-day average excluding the latest day', async () => {
    const { service } = setup({
      mandi_prices: WHEAT,
      price_alerts: [
        { id: 'aAvg', user_id: 'u1', commodity: 'Wheat', threshold_pct: 10, basis: 'avg7', direction: 'rise', last_triggered_date: null },
      ],
    });
    const r = await service.evaluateAlerts();
    expect(r.fired.map((f) => f.alertId)).toEqual(['aAvg']);
    expect(r.fired[0].reference_price).toBe(5000);
  });
  test('no history -> nothing fires', async () => {
    const { service } = setup({
      mandi_prices: [mandiRow({ commodity: 'Wheat', date: '2026-11-12', modal_price: 5600 })],
      price_alerts: [
        { id: 'a1', user_id: 'u1', commodity: 'Wheat', threshold_pct: 10, basis: 'yesterday', direction: 'rise', last_triggered_date: null },
      ],
    });
    const r = await service.evaluateAlerts();
    expect(r.fired).toEqual([]);
  });
});

describe('getAnchor', () => {
  test('latest modal for the crop; null on no data or missing table', async () => {
    const { service } = setup({ mandi_prices: [mandiRow({ commodity: 'Wheat', modal_price: 5600, mandi: 'Mathura' })] });
    expect(await service.getAnchor('Wheat')).toMatchObject({ commodity: 'Wheat', modal_price: 5600, mandi: 'Mathura' });
    const { service: empty } = setup();
    expect(await empty.getAnchor('Wheat')).toBeNull();
    const { service: missing } = setup({}, { missingTable: 'mandi_prices' });
    expect(await missing.getAnchor('Wheat')).toBeNull();
  });
});

describe('migration 20261118_mandi_prices.sql', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', '..', 'supabase', 'migrations', '20261118_mandi_prices.sql'), 'utf8',
  );
  test('creates all three tables with the assessment columns', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.mandi_prices');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.price_alerts');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.platform_cost_params');
    expect(sql).toContain('modal_price numeric NOT NULL');
    expect(sql).toContain('UNIQUE (commodity, mandi, date, variety, grade)');
    expect(sql).toContain("basis IN ('yesterday', 'avg7')");
  });
  test('RLS: public read on prices, user-scoped alerts, no writes on mandi_prices', () => {
    expect(sql).toContain('CREATE POLICY "Anyone reads mandi prices"');
    expect(sql).toContain('CREATE POLICY "Users read their own alerts"');
    expect(sql).not.toMatch(/ON public\.mandi_prices FOR (INSERT|UPDATE|DELETE)/);
    expect(sql).not.toMatch(/ON public\.platform_cost_params FOR (INSERT|UPDATE|DELETE)/);
  });
});

describe('no API key in the frontend', () => {
  test('src/ never references the OGD key or the OGD API directly', () => {
    const srcDir = path.join(__dirname, '..', '..', 'src');
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(jsx?|css|html)$/.test(e.name)) files.push(p);
      }
    }(srcDir));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      // The OGD key and the OGD API must never be reachable from the
      // browser bundle — the key lives in the backend env only.
      // (A generic VITE_*KEY check would false-positive on the
      // pre-existing PUBLIC keys: VITE_RAZORPAY_KEY_ID and
      // VITE_GOOGLE_MAPS_API_KEY, which are public by design.)
      expect(text).not.toMatch(/DATA_GOV/);
      expect(text).not.toMatch(/api\.data\.gov\.in/);
    }
  });
});

describe('cost parameters (admin)', () => {
  const VALID = {
    transport_paise_per_quintal: 5000,
    commission_pct: 2,
    packaging_paise_per_quintal: 2000,
    platform_fee_paise_per_quintal: 1000,
    wastage_pct: 5,
  };

  test('create inserts version 1, current, global scope when no scope given', async () => {
    const { db, service } = setup();
    const row = await service.createCostParams('admin1', VALID);
    expect(row.version).toBe(1);
    expect(row.is_current).toBe(true);
    expect(row.state).toBeNull();
    expect(row.commodity_class).toBeNull();
    expect(row.created_by).toBe('admin1');
    expect(db.platform_cost_params).toHaveLength(1);
  });

  test('create 409s when a current row already exists for the same scope', async () => {
    const { service } = setup({
      platform_cost_params: [{ id: 'c1', ...VALID, state: null, commodity_class: null, version: 1, is_current: true }],
    });
    await expect(service.createCostParams('admin1', VALID))
      .rejects.toMatchObject({ status: 409, code: 'COST_PARAMS_EXIST' });
  });

  test('create allows a different scope (state-scoped + global coexist)', async () => {
    const { db, service } = setup({
      platform_cost_params: [{ id: 'c1', ...VALID, state: null, commodity_class: null, version: 1, is_current: true }],
    });
    const row = await service.createCostParams('admin1', { ...VALID, state: 'Uttar Pradesh' });
    expect(row.state).toBe('Uttar Pradesh');
    expect(db.platform_cost_params).toHaveLength(2);
  });

  test('create rejects negative transport and wastage > 100 with 400', async () => {
    const { service } = setup();
    await expect(service.createCostParams('admin1', { ...VALID, transport_paise_per_quintal: -1 }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    await expect(service.createCostParams('admin1', { ...VALID, wastage_pct: 101 }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });

  test('update versions: old row flips off, new row is version+1 with merged fields', async () => {
    const { db, service } = setup({
      platform_cost_params: [{ id: 'c1', ...VALID, state: null, commodity_class: null, version: 1, is_current: true, created_by: 'admin1' }],
    });
    const row = await service.updateCostParams('c1', 'admin1', { commission_pct: 3 });
    expect(row.version).toBe(2);
    expect(row.is_current).toBe(true);
    expect(row.commission_pct).toBe(3);
    expect(row.transport_paise_per_quintal).toBe(5000); // unchanged field kept
    expect(db.platform_cost_params.find((r) => r.id === 'c1').is_current).toBe(false);
    expect(db.platform_cost_params).toHaveLength(2);
  });

  test('update 404s when the row is not current', async () => {
    const { service } = setup({
      platform_cost_params: [{ id: 'c1', ...VALID, state: null, commodity_class: null, version: 1, is_current: false }],
    });
    await expect(service.updateCostParams('c1', 'admin1', { commission_pct: 3 }))
      .rejects.toMatchObject({ status: 404, code: 'COST_PARAMS_NOT_FOUND' });
  });

  test('update 409s on a scope collision AND leaves the old row current', async () => {
    const { db, service } = setup({
      platform_cost_params: [
        { id: 'c1', ...VALID, state: null, commodity_class: null, version: 1, is_current: true },
        { id: 'c2', ...VALID, state: 'Uttar Pradesh', commodity_class: null, version: 1, is_current: true },
      ],
    });
    await expect(service.updateCostParams('c1', 'admin1', { ...VALID, state: 'Uttar Pradesh' }))
      .rejects.toMatchObject({ status: 409, code: 'COST_PARAMS_EXIST' });
    expect(db.platform_cost_params.find((r) => r.id === 'c1').is_current).toBe(true);
    expect(db.platform_cost_params).toHaveLength(2);
  });

  test('list returns only current rows; [] when the table does not exist yet', async () => {
    const { service } = setup({
      platform_cost_params: [
        { id: 'c1', ...VALID, state: null, commodity_class: null, version: 2, is_current: true },
        { id: 'c0', ...VALID, state: null, commodity_class: null, version: 1, is_current: false },
      ],
    });
    const rows = await service.listCostParams();
    expect(rows.map((r) => r.id)).toEqual(['c1']);
    const missing = setup({}, { missingTable: 'platform_cost_params' });
    await expect(missing.service.listCostParams()).resolves.toEqual([]);
  });
});
