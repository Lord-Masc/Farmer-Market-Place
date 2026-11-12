'use strict';
// FairPrice Intelligence (Stage 3, module B) — the service layer.
//
// Reads/writes the mandi_prices / price_alerts / platform_cost_params
// tables (migration 20261118_mandi_prices.sql). All prices are RUPEES
// per QUINTAL internally (the OGD/Agmarknet convention); the unit
// column records the normalised unit. Every price this service returns
// carries its source + data date + freshness — a missing cell is null /
// "no data", never a stale number presented as fresh.
//
// Honesty rules (assessment §3.3, binding): an estimate is never an
// official price; MSP is never a market price; missing cells are never
// silently filled from another mandi or a stale row. Net earnings are
// estimates built from admin-set cost parameters (there is no official
// dataset for transport/commission/packaging/wastage) and are labelled
// "estimated" everywhere they are shown.
const supabaseAdmin = require('../utils/supabaseAdmin');
const { AppError } = require('../utils/errors');

const SOURCE = 'Agmarknet / data.gov.in';
const UNIT = 'quintal';

// Same table-missing detector as the Stage 8 price tool and Stage 10
// metrics: PostgREST 42P01 / PGRST205, or a "does not exist" message.
// A missing table is "no data", never a 500.
function isTableMissing(error) {
  if (!error) return false;
  return error.code === '42P01'
    || error.code === 'PGRST205'
    || /does not exist/i.test(String(error.message || ''));
}

// Crop-name normalisation. The OGD feed spells the same commodity
// differently across states — verified in the data: "Bhindi" vs
// "Lady Finger". The alias map below holds ONLY spellings observed in
// the real feed (or direct spelling variants of one); a new alias is
// added only from an observed OGD value, never guessed. Anything not
// in the map passes through unchanged (title-cased) — different
// commodities are never silently merged.
const COMMODITY_ALIASES = {
  'Lady Finger': 'Bhindi',
  'Ladyfinger': 'Bhindi',
};

function normaliseCommodity(name) {
  if (typeof name !== 'string') return '';
  const cleaned = name.trim().replace(/\s+/g, ' ');
  if (!cleaned) return '';
  const titled = cleaned
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
  return COMMODITY_ALIASES[titled] || titled;
}

// OGD arrival_date is DD/MM/YYYY ("12/11/2026"). ISO YYYY-MM-DD passes
// through (validated). Anything else is null — the row is skipped.
function parseOgdDate(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (dmy) {
    const [, d, m, y] = dmy;
    const day = Number(d);
    const month = Number(m);
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.exec(trimmed)) return trimmed;
  return null;
}

// Price to ₹/quintal. The OGD resource carries no unit column —
// Agmarknet modal prices are quoted per quintal, so a missing unit
// hint means "already per quintal". A kg hint converts (x100).
// Returns null for a missing / non-finite / negative value.
function normalisePrice(value, unitHint) {
  // Number('') and Number(null) are both 0 — an empty/missing price
  // must be null, never a fabricated ₹0.
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  const hint = String(unitHint || '').trim().toLowerCase();
  if (hint === 'kg' || hint === 'kilogram' || hint === 'per kg' || hint === 'rs/kg' || hint === 'rs. per kg') {
    return n * 100;
  }
  return n;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Normalise one raw OGD record (JSON object or parsed-XML object —
// both carry the same field names) into a mandi_prices row. Returns
// null when the row is unusable (no commodity, no mandi, no parseable
// date, no modal price) — the sync job counts it as skipped, never
// inserts a bad row. min/max fall back to the modal when the source
// omits them: the modal IS the reported price, so this invents no
// price — it only means "no range reported".
function normaliseRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const commodity = normaliseCommodity(raw.commodity);
  const mandi = typeof raw.market === 'string' ? raw.market.trim() : '';
  const state = typeof raw.state === 'string' ? raw.state.trim() : '';
  const date = parseOgdDate(raw.arrival_date);
  const modal = normalisePrice(raw.modal_price, raw.unit);
  if (!commodity || !mandi || !state || !date || modal === null) return null;
  const min = normalisePrice(raw.min_price, raw.unit);
  const max = normalisePrice(raw.max_price, raw.unit);
  return {
    commodity,
    variety: typeof raw.variety === 'string' ? raw.variety.trim() : '',
    grade: typeof raw.grade === 'string' ? raw.grade.trim() : '',
    state,
    district: typeof raw.district === 'string' ? raw.district.trim() : null,
    mandi,
    date,
    min_price: min === null ? modal : min,
    max_price: max === null ? modal : max,
    modal_price: modal,
    unit: UNIT,
    source: SOURCE,
    raw,
  };
}

// Freshness of a data date against today (YYYY-MM-DD, IST). The OGD
// feed runs on the daily Agmarknet cycle, so yesterday's data is the
// normal fresh state — only older data is stale.
function freshnessFor(dateStr, todayStr) {
  const today = todayStr || new Date().toISOString().slice(0, 10);
  const daysOld = Math.round((new Date(`${today}T00:00:00Z`).getTime()
    - new Date(`${dateStr}T00:00:00Z`).getTime()) / 86400000);
  if (daysOld <= 0) return { label: 'Today', isStale: false, daysOld: 0 };
  if (daysOld === 1) return { label: 'Yesterday', isStale: false, daysOld: 1 };
  return { label: `Stale — ${dateStr}`, isStale: true, daysOld };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Latest price for a commodity (optionally a state / mandi). Returns
// null when there is no data (or the table does not exist yet) — never
// a filled-in number. `prices` holds every row for the latest date
// (one per mandi/variety); `primary` is the deterministic first row
// (mandi ASC, variety ASC).
async function getLatestPrice(commodity, { state, mandi } = {}) {
  const name = normaliseCommodity(commodity);
  if (!name) return null;
  try {
    let q = supabaseAdmin.from('mandi_prices').select('date').eq('commodity', name);
    if (state) q = q.eq('state', state);
    if (mandi) q = q.eq('mandi', mandi);
    const { data: dateRows, error: dateError } = await q
      .order('date', { ascending: false }).limit(1);
    if (dateError) {
      if (isTableMissing(dateError)) return null;
      throw dateError;
    }
    if (!dateRows || dateRows.length === 0) return null;
    const latestDate = dateRows[0].date;
    let q2 = supabaseAdmin.from('mandi_prices').select('*')
      .eq('commodity', name).eq('date', latestDate);
    if (state) q2 = q2.eq('state', state);
    if (mandi) q2 = q2.eq('mandi', mandi);
    const { data, error } = await q2.order('mandi', { ascending: true });
    if (error) {
      if (isTableMissing(error)) return null;
      throw error;
    }
    const rows = (data || []).map((r) => ({
      mandi: r.mandi,
      variety: r.variety || '',
      grade: r.grade || '',
      state: r.state,
      district: r.district || null,
      min_price: toNumber(r.min_price),
      max_price: toNumber(r.max_price),
      modal_price: toNumber(r.modal_price),
      unit: r.unit || UNIT,
      date: r.date,
    }));
    if (rows.length === 0) return null;
    rows.sort((a, b) => (a.mandi < b.mandi ? -1 : a.mandi > b.mandi ? 1
      : (a.variety < b.variety ? -1 : a.variety > b.variety ? 1 : 0)));
    return {
      commodity: name,
      date: latestDate,
      freshness: freshnessFor(latestDate),
      source: SOURCE,
      prices: rows,
      primary: rows[0],
    };
  } catch (err) {
    if (isTableMissing(err)) return null;
    throw err;
  }
}

// Daily modal series for a commodity (latest N days, one point per
// date — the first row per date, mandi ASC). change_pct_vs_yesterday
// compares the latest two days; avg7_modal is the mean of the 7 daily
// modals BEFORE the latest day (the reference window for alerts).
// Both are null when there is not enough history — never 0.
async function getHistory(commodity, { state, mandi, days = 30 } = {}) {
  const name = normaliseCommodity(commodity);
  if (!name) return { commodity: '', days: 0, series: [], change_pct_vs_yesterday: null, avg7_modal: null, latest_date: null };
  const nDays = Math.max(1, Math.min(90, Number(days) || 30));
  try {
    let q = supabaseAdmin.from('mandi_prices')
      .select('date,modal_price,mandi')
      .eq('commodity', name);
    if (state) q = q.eq('state', state);
    if (mandi) q = q.eq('mandi', mandi);
    const { data, error } = await q.order('date', { ascending: true }).limit(nDays * 10);
    if (error) {
      if (isTableMissing(error)) {
        return { commodity: name, days: nDays, series: [], change_pct_vs_yesterday: null, avg7_modal: null, latest_date: null };
      }
      throw error;
    }
    const byDate = new Map();
    for (const r of data || []) {
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date).push(r);
    }
    const dates = [...byDate.keys()].sort().slice(-nDays);
    const series = dates.map((date) => {
      const rows = [...byDate.get(date)].sort((a, b) => (a.mandi < b.mandi ? -1 : 1));
      return { date, modal_price: toNumber(rows[0].modal_price) };
    }).filter((p) => p.modal_price !== null);
    let change = null;
    if (series.length >= 2) {
      const latest = series[series.length - 1].modal_price;
      const prev = series[series.length - 2].modal_price;
      if (prev > 0) change = round2(((latest - prev) / prev) * 100);
    }
    let avg7 = null;
    const prior = series.slice(0, -1).slice(-7);
    if (prior.length > 0) {
      avg7 = round2(prior.reduce((a, p) => a + p.modal_price, 0) / prior.length);
    }
    return {
      commodity: name,
      days: nDays,
      series,
      change_pct_vs_yesterday: change,
      avg7_modal: avg7,
      latest_date: series.length > 0 ? series[series.length - 1].date : null,
    };
  } catch (err) {
    if (isTableMissing(err)) {
      return { commodity: name, days: nDays, series: [], change_pct_vs_yesterday: null, avg7_modal: null, latest_date: null };
    }
    throw err;
  }
}

// Same commodity, same day, other mandis — ordered by modal price
// (highest first), so the farmer sees where the price is better.
// `date` defaults to the commodity's latest date. Returns [] on no data.
async function getNearbyMandis(commodity, { state, mandi, date, limit = 5 } = {}) {
  const name = normaliseCommodity(commodity);
  if (!name) return [];
  try {
    const latest = await getLatestPrice(name, { state });
    const day = date || (latest && latest.date);
    if (!day) return [];
    let q = supabaseAdmin.from('mandi_prices').select('*')
      .eq('commodity', name).eq('date', day);
    if (state) q = q.eq('state', state);
    const { data, error } = await q.order('modal_price', { ascending: false }).limit(50);
    if (error) {
      if (isTableMissing(error)) return [];
      throw error;
    }
    return (data || [])
      .filter((r) => !mandi || r.mandi !== mandi)
      .slice(0, Math.max(1, Math.min(10, Number(limit) || 5)))
      .map((r) => ({
        mandi: r.mandi,
        district: r.district || null,
        state: r.state,
        min_price: toNumber(r.min_price),
        max_price: toNumber(r.max_price),
        modal_price: toNumber(r.modal_price),
        unit: r.unit || UNIT,
        date: r.date,
      }));
  } catch (err) {
    if (isTableMissing(err)) return [];
    throw err;
  }
}

// Most-specific current cost parameters: (state, class) wins over
// (state, any) wins over (any, class) wins over (any, any). Null when
// no parameters exist at all — the caller reports "not configured".
async function getCostParams({ state, commodityClass } = {}) {
  try {
    const { data, error } = await supabaseAdmin.from('platform_cost_params')
      .select('*').eq('is_current', true);
    if (error) {
      if (isTableMissing(error)) return null;
      throw error;
    }
    const rows = data || [];
    const score = (r) => {
      const stateMatch = state && r.state === state;
      const classMatch = commodityClass && r.commodity_class === commodityClass;
      const stateWild = r.state === null || r.state === undefined;
      const classWild = r.commodity_class === null || r.commodity_class === undefined;
      if (stateMatch && classMatch) return 4;
      if (stateMatch && classWild) return 3;
      if (stateWild && classMatch) return 2;
      if (stateWild && classWild) return 1;
      return 0;
    };
    let best = null;
    let bestScore = 0;
    for (const r of rows) {
      const s = score(r);
      if (s > bestScore) { bestScore = s; best = r; }
    }
    return best;
  } catch (err) {
    if (isTableMissing(err)) return null;
    throw err;
  }
}

// Net earnings for a lot: mandi modal price minus the itemised
// platform estimates. All money in RUPEES (2dp). Wastage shrinks the
// saleable quantity (gross is earned on what survives); transport and
// packaging are charged on the full quantity moved; commission is a
// share of the gross. The result is an ESTIMATE — costParams are
// admin-set assumptions, not official figures. Returns null when no
// cost parameters are configured (the caller reports that honestly).
// Net CAN be negative (costs exceed gross) — that is honest, never
// clamped to zero.
function computeNetEarnings({ modalPriceRupees, quantityQuintals, costParams }) {
  const price = toNumber(modalPriceRupees);
  const qty = toNumber(quantityQuintals);
  if (price === null || price < 0 || qty === null || qty <= 0 || !costParams) return null;
  const transportPaise = toNumber(costParams.transport_paise_per_quintal);
  const commissionPct = toNumber(costParams.commission_pct);
  const packagingPaise = toNumber(costParams.packaging_paise_per_quintal);
  const feePaise = toNumber(costParams.platform_fee_paise_per_quintal);
  const wastagePct = toNumber(costParams.wastage_pct);
  if ([transportPaise, commissionPct, packagingPaise, feePaise, wastagePct].some((v) => v === null || v < 0)) return null;
  const saleableQty = qty * (1 - wastagePct / 100);
  const gross = price * saleableQty;
  const transport = (transportPaise / 100) * qty;
  const commission = (gross * commissionPct) / 100;
  const packaging = (packagingPaise / 100) * qty;
  const platformFee = (feePaise / 100) * qty;
  const net = gross - transport - commission - packaging - platformFee;
  return {
    gross: round2(gross),
    transport: round2(transport),
    commission: round2(commission),
    packaging: round2(packaging),
    platformFee: round2(platformFee),
    wastageQty: round2(qty - saleableQty),
    saleableQty: round2(saleableQty),
    net: round2(net),
    netPerQuintal: round2(net / qty),
    currency: 'INR',
    estimated: true,
    assumptions: {
      transport_paise_per_quintal: transportPaise,
      commission_pct: commissionPct,
      packaging_paise_per_quintal: packagingPaise,
      platform_fee_paise_per_quintal: feePaise,
      wastage_pct: wastagePct,
      params_version: costParams.version ?? null,
    },
  };
}

// --- Price alerts ----------------------------------------------------
// An alert fires on a REAL threshold crossing: the latest modal moved
// vs the reference (yesterday's modal, or the 7-day average modal
// excluding the latest day) by at least threshold_pct in the alert's
// direction. An alert never re-fires on the same data date —
// last_triggered_date guards it. With no history there is no reference
// and nothing fires ("once history exists").

function validateAlertInput({ commodity, threshold_pct, basis, direction }) {
  const name = normaliseCommodity(commodity);
  if (!name) throw new AppError(400, 'VALIDATION_ERROR', 'commodity is required.');
  const pct = toNumber(threshold_pct);
  if (pct === null || pct <= 0) throw new AppError(400, 'VALIDATION_ERROR', 'threshold_pct must be a number greater than 0.');
  if (basis !== 'yesterday' && basis !== 'avg7') throw new AppError(400, 'VALIDATION_ERROR', "basis must be 'yesterday' or 'avg7'.");
  if (direction !== 'rise' && direction !== 'fall') throw new AppError(400, 'VALIDATION_ERROR', "direction must be 'rise' or 'fall'.");
  return { commodity: name, threshold_pct: pct, basis, direction };
}

async function createAlert(userId, input) {
  const row = validateAlertInput(input);
  const { data, error } = await supabaseAdmin.from('price_alerts')
    .insert([{ user_id: userId, ...row }]).select().single();
  if (error) throw error;
  return data;
}

async function listAlerts(userId) {
  const { data, error } = await supabaseAdmin.from('price_alerts')
    .select('*').eq('user_id', userId).order('created_at', { ascending: false });
  if (error) {
    if (isTableMissing(error)) return [];
    throw error;
  }
  return data || [];
}

// Evaluate every alert against the freshest data. Returns
// { evaluated, fired: [{ alertId, userId, commodity, change_pct,
//   latest_price, reference_price, date }] }. A fired alert is stamped
// (last_triggered_*) so it cannot fire twice on the same price.
// Delivery (a Stage 9 notification) is NOT wired here — the stamp is
// the fire record; wiring delivery needs a Stage 9 event type.
async function evaluateAlerts() {
  const { data: alerts, error } = await supabaseAdmin.from('price_alerts').select('*');
  if (error) {
    if (isTableMissing(error)) return { evaluated: 0, fired: [] };
    throw error;
  }
  const fired = [];
  for (const alert of alerts || []) {
    const latest = await getLatestPrice(alert.commodity);
    if (!latest || !latest.primary) continue;
    const history = await getHistory(alert.commodity, { days: 9 });
    let reference = null;
    if (alert.basis === 'yesterday') {
      const s = history.series;
      if (s.length >= 2) reference = s[s.length - 2].modal_price;
    } else {
      reference = history.avg7_modal;
    }
    if (reference === null || reference === undefined || reference <= 0) continue;
    const latestPrice = latest.primary.modal_price;
    const change = ((latestPrice - reference) / reference) * 100;
    const crossed = alert.direction === 'rise'
      ? change >= alert.threshold_pct
      : change <= -alert.threshold_pct;
    if (!crossed) continue;
    if (alert.last_triggered_date === latest.date) continue;
    const { error: stampError } = await supabaseAdmin.from('price_alerts')
      .update({
        last_triggered_at: new Date().toISOString(),
        last_triggered_price: latestPrice,
        last_triggered_date: latest.date,
      })
      .eq('id', alert.id);
    if (stampError) throw stampError;
    fired.push({
      alertId: alert.id,
      userId: alert.user_id,
      commodity: alert.commodity,
      change_pct: round2(change),
      latest_price: latestPrice,
      reference_price: reference,
      date: latest.date,
    });
  }
  return { evaluated: (alerts || []).length, fired };
}

// --- Cost parameters (admin) ----------------------------------------
// The net-earnings assumptions. There is NO official dataset for these
// numbers — they are platform estimates, set by an admin, labelled
// "estimated" everywhere they are shown. VERSIONED: an update never
// overwrites — it flips the old current row off and inserts a new row
// (version+1), so the assumptions behind any past figure stay auditable.

function validateCostInput(input) {
  const out = {};
  for (const field of ['transport_paise_per_quintal', 'packaging_paise_per_quintal', 'platform_fee_paise_per_quintal']) {
    const v = toNumber(input[field]);
    if (v === null || !Number.isInteger(v) || v < 0) {
      throw new AppError(400, 'VALIDATION_ERROR', `${field} must be a non-negative integer (paise per quintal).`);
    }
    out[field] = v;
  }
  for (const field of ['commission_pct', 'wastage_pct']) {
    const v = toNumber(input[field]);
    if (v === null || v < 0) {
      throw new AppError(400, 'VALIDATION_ERROR', `${field} must be a number >= 0.`);
    }
    out[field] = v;
  }
  if (out.wastage_pct > 100) {
    throw new AppError(400, 'VALIDATION_ERROR', 'wastage_pct must be <= 100.');
  }
  out.state = typeof input.state === 'string' && input.state.trim() ? input.state.trim() : null;
  out.commodity_class = typeof input.commodity_class === 'string' && input.commodity_class.trim()
    ? input.commodity_class.trim()
    : null;
  return out;
}

async function listCostParams() {
  const { data, error } = await supabaseAdmin.from('platform_cost_params')
    .select('*').eq('is_current', true).order('created_at', { ascending: false });
  if (error) {
    if (isTableMissing(error)) return [];
    throw error;
  }
  return data || [];
}

async function createCostParams(adminId, input) {
  const row = validateCostInput(input);
  const { data: existing, error: existingError } = await supabaseAdmin.from('platform_cost_params')
    .select('id').eq('is_current', true);
  if (existingError) throw existingError;
  const clash = (existing || []).find((r) => {
    // Scope equality must treat NULL as a value: two NULLs are the same scope.
    const sameState = (r.state || null) === row.state;
    const sameClass = (r.commodity_class || null) === row.commodity_class;
    return sameState && sameClass;
  });
  if (clash) {
    throw new AppError(409, 'COST_PARAMS_EXIST', 'Cost parameters already exist for this scope — PATCH the existing row to version them.');
  }
  const { data, error } = await supabaseAdmin.from('platform_cost_params')
    .insert([{ ...row, version: 1, is_current: true, created_by: adminId }]).select().single();
  if (error) throw error;
  return data;
}

async function updateCostParams(id, adminId, input) {
  const { data: current, error: currentError } = await supabaseAdmin.from('platform_cost_params')
    .select('*').eq('id', id).eq('is_current', true);
  if (currentError) throw currentError;
  const old = (current || [])[0];
  if (!old) throw new AppError(404, 'COST_PARAMS_NOT_FOUND', 'Cost parameters not found or not current.');
  // Partial PATCH: omitted fields keep the old row's values.
  const row = validateCostInput({
    transport_paise_per_quintal: input.transport_paise_per_quintal ?? old.transport_paise_per_quintal,
    commission_pct: input.commission_pct ?? old.commission_pct,
    packaging_paise_per_quintal: input.packaging_paise_per_quintal ?? old.packaging_paise_per_quintal,
    platform_fee_paise_per_quintal: input.platform_fee_paise_per_quintal ?? old.platform_fee_paise_per_quintal,
    wastage_pct: input.wastage_pct ?? old.wastage_pct,
    state: input.state ?? old.state,
    commodity_class: input.commodity_class ?? old.commodity_class,
  });
  // A scope change must not collide with another current row — check
  // BEFORE flipping the old row off, or a failed insert would leave
  // no current row for the scope.
  const { data: siblings, error: siblingsError } = await supabaseAdmin.from('platform_cost_params')
    .select('id,state,commodity_class').eq('is_current', true);
  if (siblingsError) throw siblingsError;
  const clash = (siblings || []).find((r) => r.id !== old.id
    && (r.state || null) === row.state && (r.commodity_class || null) === row.commodity_class);
  if (clash) {
    throw new AppError(409, 'COST_PARAMS_EXIST', 'Cost parameters already exist for this scope — PATCH that row instead.');
  }
  const { error: offError } = await supabaseAdmin.from('platform_cost_params')
    .update({ is_current: false }).eq('id', old.id);
  if (offError) throw offError;
  const { data, error } = await supabaseAdmin.from('platform_cost_params')
    .insert([{
      ...row,
      version: (old.version || 1) + 1,
      is_current: true,
      created_by: adminId,
    }]).select().single();
  if (error) throw error;
  return data;
}

// The Stage 4 negotiation anchor: the latest modal for a crop, or
// null when there is no data (or the table does not exist yet).
async function getAnchor(crop) {
  const latest = await getLatestPrice(crop);
  if (!latest || !latest.primary) return null;
  return {
    commodity: latest.commodity,
    modal_price: latest.primary.modal_price,
    unit: latest.primary.unit,
    mandi: latest.primary.mandi,
    date: latest.date,
  };
}

module.exports = {
  COMMODITY_ALIASES,
  SOURCE,
  UNIT,
  normaliseCommodity,
  parseOgdDate,
  normalisePrice,
  normaliseRow,
  freshnessFor,
  getLatestPrice,
  getHistory,
  getNearbyMandis,
  getCostParams,
  computeNetEarnings,
  validateAlertInput,
  createAlert,
  listAlerts,
  evaluateAlerts,
  listCostParams,
  createCostParams,
  updateCostParams,
  getAnchor,
  isTableMissing,
};
