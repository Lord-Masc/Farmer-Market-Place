'use strict';
// Mandi price sync job (Stage 3, module B).
//
// Twice daily (~11:00 + ~20:30 IST, scheduled in server.js) this pulls
// the day's mandi prices from the data.gov.in OGD API ("Current Daily
// Price of Various Commodities from Various Markets (Mandi)", resource
// 9ef84268-d588-465a-a308-a864a43d0070) and appends normalised rows to
// mandi_prices. It NEVER overwrites or deletes: a re-fetch of the same
// day is a no-op (UNIQUE + ON CONFLICT DO NOTHING), and a failed sync
// leaves yesterday's snapshot in place, labelled stale.
//
// RESPONSE FORMATS — the API answers JSON when the request carries
// `Accept: application/json`, but a browser (Accept: text/html) gets
// XML despite `format=json` in the URL (verified 2026-11-13 by
// Rishabh's own test). So this client sends the JSON Accept header AND
// parses whatever actually arrives: a body starting with `{` is JSON,
// one starting with `<` is the XML records structure. No XML library
// is added — the records are flat <item> blocks with known fields, and
// the hand-rolled parser below is ~25 lines (stdlib only, ponytail
// ladder: no new dependency for a flat, regular shape).
//
// KEY: DATA_GOV_API_KEY comes from process.env ONLY (Render env var at
// runtime). If it is unset, runMandiSync logs a clear error and returns
// { ok: false } without crashing the server; the standalone CLI exits
// non-zero. The key NEVER appears in any file, test, or log.
const supabaseAdmin = require('../utils/supabaseAdmin');
const { normaliseRow, evaluateAlerts } = require('../services/fairPriceService');

const OGD_RESOURCE_ID = '9ef84268-d588-465a-a308-a864a43d0070';
const OGD_BASE_URL = `https://api.data.gov.in/resource/${OGD_RESOURCE_ID}`;
const SYNC_STATES_ENV = 'MANDI_SYNC_STATES';
const API_KEY_ENV = 'DATA_GOV_API_KEY';
const PAGE_LIMIT = 1000;
const INSERT_BATCH = 500;
const MAX_ATTEMPTS = 4; // initial try + 3 retries, exponential backoff
const BACKOFF_MS = [1000, 2000, 4000];
const REQUEST_TIMEOUT_MS = 15000;

// The OGD record fields (verified in the live response, 2026-11-13).
const OGD_FIELDS = [
  'state', 'district', 'market', 'commodity', 'variety', 'grade',
  'arrival_date', 'min_price', 'max_price', 'modal_price',
];

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

// Parse the XML records structure:
// <result><status>ok</status><total>…</total><records><item><state>…
// </state>…</item>…</records></result>
function parseOgdXml(text) {
  const statusMatch = /<status>([\s\S]*?)<\/status>/.exec(text);
  if (statusMatch && statusMatch[1].trim().toLowerCase() !== 'ok') {
    const msgMatch = /<message>([\s\S]*?)<\/message>/.exec(text);
    throw new Error(`OGD API error: ${msgMatch ? decodeXmlEntities(msgMatch[1].trim()) : statusMatch[1].trim()}`);
  }
  const records = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(text)) !== null) {
    const block = m[1];
    const rec = {};
    for (const field of OGD_FIELDS) {
      const fm = new RegExp(`<${field}>([\\s\\S]*?)<\\/${field}>`).exec(block);
      if (fm) rec[field] = decodeXmlEntities(fm[1].trim());
    }
    records.push(rec);
  }
  return records;
}

// Parse whatever the API actually sent. JSON when the body starts with
// `{`, XML when it starts with `<`. Anything else is an error.
function parseOgdResponse(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('OGD API returned an empty response.');
  if (trimmed.startsWith('{')) {
    const json = JSON.parse(trimmed);
    if (Array.isArray(json.records)) return json.records;
    if (json.status && String(json.status).toLowerCase() !== 'ok') {
      throw new Error(`OGD API error: ${json.message || json.status}`);
    }
    throw new Error('OGD API JSON response has no records array.');
  }
  if (trimmed.startsWith('<')) return parseOgdXml(trimmed);
  throw new Error('OGD API returned an unrecognised response format.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl({ apiKey, state, offset, limit }) {
  const params = new URLSearchParams({
    'api-key': apiKey,
    format: 'json',
    limit: String(limit),
    offset: String(offset),
  });
  if (state) params.set('filters[state]', state);
  return `${OGD_BASE_URL}?${params.toString()}`;
}

// One GET with retries (exponential backoff) and a hard timeout.
// Returns the response body as text. Throws after MAX_ATTEMPTS.
async function fetchWithRetry(url, { fetchImpl, sleepImpl = sleep } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleepImpl(BACKOFF_MS[attempt - 1]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Farmer-Marketplace/1.0 (mandi-sync)',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`OGD API HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      console.error(`Mandi sync fetch attempt ${attempt + 1}/${MAX_ATTEMPTS} failed: ${err.message}`);
    }
  }
  throw lastError;
}

// Sync one state (or the whole country when state is null): paginate
// until a page returns fewer than `limit` rows, normalise, and insert
// in batches. Returns per-state counts.
async function syncState({ apiKey, state, supabase, fetchImpl, sleepImpl, limit, batchSize }) {
  const counts = { fetched: 0, valid: 0, invalid: 0, inserted: 0, duplicates: 0 };
  let offset = 0;
  for (;;) {
    const url = buildUrl({ apiKey, state, offset, limit });
    const text = await fetchWithRetry(url, { fetchImpl, sleepImpl });
    const records = parseOgdResponse(text);
    counts.fetched += records.length;
    const rows = [];
    for (const rec of records) {
      const row = normaliseRow(rec);
      if (row) rows.push(row);
      else counts.invalid += 1;
    }
    counts.valid += rows.length;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const { data, error } = await supabase.from('mandi_prices')
        .insert(batch, {
          onConflict: 'commodity,mandi,date,variety,grade',
          ignoreDuplicates: true,
        });
      if (error) throw error;
      const inserted = (data || []).length;
      counts.inserted += inserted;
      counts.duplicates += batch.length - inserted;
    }
    if (records.length < limit) break;
    offset += records.length;
  }
  return counts;
}

// States to sync, from MANDI_SYNC_STATES (comma-separated). Unset
// means the whole country (no state filter) — the platform serves all
// of India, and the OGD API paginates nationally at ~13k rows/day.
function syncStatesFromEnv() {
  const raw = (process.env[SYNC_STATES_ENV] || '').trim();
  if (!raw) return [null];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// Main entry: importable (server.js cron) and runnable standalone
// (`node backend/jobs/mandiSync.js`). Returns a summary; ok:false when
// the key is missing or every state failed. A failed state never
// deletes or overwrites — yesterday's snapshot stays in place.
async function runMandiSync(deps = {}) {
  const {
    fetchImpl = fetch,
    supabase = supabaseAdmin,
    states = syncStatesFromEnv(),
    limit = PAGE_LIMIT,
    batchSize = INSERT_BATCH,
    sleepImpl,
    evaluateAlertsImpl = evaluateAlerts,
  } = deps;
  const startedAt = new Date().toISOString();
  const apiKey = process.env[API_KEY_ENV];
  if (!apiKey) {
    console.error(`Mandi sync aborted: ${API_KEY_ENV} is not set. Set it in the backend environment (Render env var) — never in git.`);
    return { ok: false, startedAt, finishedAt: new Date().toISOString(), error: `${API_KEY_ENV} is not set.` };
  }
  const summary = {
    ok: true, startedAt, finishedAt: null,
    states: [], inserted: 0, duplicates: 0, invalid: 0, fetched: 0,
    alerts: { evaluated: 0, fired: [] }, errors: [],
  };
  for (const state of states) {
    try {
      const counts = await syncState({
        apiKey, state, supabase, fetchImpl, sleepImpl, limit, batchSize,
      });
      summary.states.push({ state: state || '(all)', ...counts });
      summary.inserted += counts.inserted;
      summary.duplicates += counts.duplicates;
      summary.invalid += counts.invalid;
      summary.fetched += counts.fetched;
      console.log(`Mandi sync ${state || '(all states)'}: fetched ${counts.fetched}, inserted ${counts.inserted}, duplicates ${counts.duplicates}, invalid ${counts.invalid}.`);
    } catch (err) {
      summary.errors.push({ state: state || '(all)', error: err.message });
      console.error(`Mandi sync failed for ${state || '(all states)'}: ${err.message} — yesterday's snapshot stays in place.`);
    }
  }
  if (summary.states.length === 0) {
    summary.ok = false;
    summary.finishedAt = new Date().toISOString();
    return summary;
  }
  try {
    summary.alerts = await evaluateAlertsImpl();
    if (summary.alerts.fired.length > 0) {
      console.log(`Mandi sync: ${summary.alerts.fired.length} price alert(s) fired.`);
    }
  } catch (err) {
    summary.errors.push({ state: '(alerts)', error: err.message });
    console.error(`Mandi sync: alert evaluation failed: ${err.message} — prices are stored, alerts will retry next run.`);
  }
  summary.finishedAt = new Date().toISOString();
  return summary;
}

if (require.main === module) {
  runMandiSync().then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.ok ? 0 : 1);
  }).catch((err) => {
    console.error('Mandi sync crashed:', err);
    process.exit(1);
  });
}

module.exports = {
  OGD_RESOURCE_ID,
  OGD_BASE_URL,
  PAGE_LIMIT,
  MAX_ATTEMPTS,
  parseOgdResponse,
  parseOgdXml,
  fetchWithRetry,
  buildUrl,
  syncStatesFromEnv,
  runMandiSync,
};
