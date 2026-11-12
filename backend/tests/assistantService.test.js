'use strict';
/**
 * AI Farmer Assistant (Stage 8, module G) — service unit.
 *
 * TDD: this suite was written FIRST and watched RED (service module not
 * found) before any implementation. The platform services are mocked
 * (jest.mock) — the assistant's OWN decisions are what's pinned here:
 * intent detection, floor/refusal logic, grounding (every number in an
 * answer must appear in its cited sources), and user-scoped conversation
 * storage. The Supabase mock follows the negotiation.test.js pattern
 * (eq/in/order/limit; a missing table answers a 42P01 error, which is
 * how a not-yet-migrated table is simulated).
 *
 * Hand-checked literals — NOT derived from the code:
 * - Wheat mandi row: modal_price 2400/quintal, Mathura, 2026-11-12.
 * - Offer off1 (buyer's counter, farmer1's offer): price 2100, tiers
 *   [{ min_quantity: 10, price: 2000 }] — floor is 2000. Asking 1900
 *   must REFUSE; asking 2050 must counter at 2050.
 * - Offer off2 (farmer1's OWN offer): price 2200, no tiers — floor
 *   is 2200.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_mock';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'test-secret';

const mockHolder = { supabase: null };

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => mockHolder.supabase,
}));
jest.mock('../services/negotiationService', () => ({ counterOffer: jest.fn() }));
jest.mock('../services/logisticsService', () => ({
  quoteShipment: jest.fn(),
  bookShipment: jest.fn(),
  trackShipment: jest.fn(),
}));
jest.mock('../services/disputeService', () => ({ fileDispute: jest.fn() }));

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
    // A table that does not exist (e.g. not yet migrated) — PostgREST
    // answers 42P01; the service must treat that as "no data".
    if (!table) {
      return { data: null, error: { code: '42P01', message: `relation "${q.table}" does not exist` } };
    }
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
      if (q.limit != null) rows = rows.slice(0, q.limit);
      return { data: rows, error: null };
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
    const q = { table, op: null, fields: null, row: null, filters: [], limit: null, orderBy: null };
    const api = {
      select() { if (!q.op) q.op = 'select'; return api; },
      update(fields) { q.op = 'update'; q.fields = fields; return api; },
      insert(row) { q.op = 'insert'; q.row = row; return api; },
      eq(col, val) { q.filters.push({ type: 'eq', col, val }); return api; },
      in(col, val) { q.filters.push({ type: 'in', col, val }); return api; },
      is(col, val) { q.filters.push({ type: 'is', col, val }); return api; },
      limit(n) { q.limit = n; return api; },
      order(col, { ascending = true } = {}) { q.orderBy = { col, ascending }; return api; },
      then(resolve, reject) {
        // Record the call so tests can assert user-scoping of reads/writes.
        db.__calls.push({ table, op: q.op, filters: q.filters.map((f) => ({ ...f })) });
        return new Promise((res) => setTimeout(res, 1)).then(() => execute(q)).then(resolve, reject);
      },
    };
    return api;
  }

  return { from: (table) => builder(table) };
}

function seedDb() {
  return {
    __calls: [],
    profiles: [
      { id: 'buyer1', role: 'buyer', verification_status: 'unverified' },
      { id: 'farmer1', role: 'farmer', verification_status: 'verified' },
      { id: 'farmer2', role: 'farmer', verification_status: 'verified' },
    ],
    products: [
      { id: 'prod1', farmer_id: 'farmer1', name: 'Wheat', user_price: 2200, price: 2200, quantity: 500, unit: 'kg', created_at: '2026-11-11T00:00:00.000Z' },
      { id: 'prod2', farmer_id: 'farmer1', name: 'Rice', user_price: 3000, price: 3000, quantity: 100, unit: 'kg', created_at: '2026-11-12T00:00:00.000Z' },
    ],
    orders: [
      { id: 'ord1', buyer_id: 'buyer1', farmer_id: 'farmer1', product_id: 'prod1', status: 'PAID', created_at: '2026-11-12T00:00:00.000Z' },
      { id: 'ord2', buyer_id: 'buyer1', farmer_id: 'farmer1', product_id: 'prod1', status: 'SHIPPED', created_at: '2026-11-12T00:00:00.000Z' },
    ],
    requirements: [
      { id: 'req1', buyer_id: 'buyer1', crop: 'Wheat', quantity: 100, status: 'open' },
    ],
    offers: [
      {
        // Buyer's counter on farmer1's requirement — the farmer MAY
        // counter this one (he did not make it).
        id: 'off1', requirement_id: 'req1', farmer_id: 'farmer1', created_by: 'buyer1',
        product_id: 'prod1', price: 2100, quantity: 10,
        price_tiers: [{ min_quantity: 10, price: 2000 }],
        expires_at: '2027-01-01T00:00:00.000Z', status: 'open',
      },
      {
        // farmer1's OWN offer — floor is the offer price (no tiers).
        id: 'off2', requirement_id: 'req1', farmer_id: 'farmer1', created_by: 'farmer1',
        product_id: 'prod1', price: 2200, quantity: 10, price_tiers: [],
        expires_at: '2027-01-01T00:00:00.000Z', status: 'open',
      },
    ],
    shipments: [
      { id: 'ship1', order_id: 'ord2', transporter_id: 'tr1', status: 'in_transit', price_paise: 5000 },
    ],
    transporters: [
      { id: 'tr1', user_id: 'transporter1', verification_status: 'verified', flat_rate_paise: 5000 },
    ],
    disputes: [],
    dispute_messages: [],
    assistant_conversations: [],
    audit_log: [],
  };
}

function setup() {
  jest.resetModules();
  jest.clearAllMocks();
  const db = seedDb();
  mockHolder.supabase = makeSupabaseMock(db);
  return { db, service: require('../services/assistantService') };
}

// Every numeric token in an answer must appear in the JSON of its
// cited sources — the grounding rule. A no-data answer (sources [])
// must therefore contain NO digits at all.
function assertGrounded(result) {
  const tokens = result.answer.match(/\d+/g) || [];
  const cited = JSON.stringify(result.sources || []);
  for (const token of tokens) {
    expect(cited).toContain(token);
  }
}

describe('detectIntent (deterministic, Hindi-first)', () => {
  test('Hindi price words map to price with the crop entity', () => {
    const { service } = setup();
    expect(service.detectIntent('gehun ka bhaav kya hai')).toEqual({
      intent: 'price', entities: { crop: 'Wheat' },
    });
    expect(service.detectIntent('What is the price of wheat?')).toEqual({
      intent: 'price', entities: { crop: 'Wheat' },
    });
    expect(service.detectIntent('aloo ki keemat batao')).toEqual({
      intent: 'price', entities: { crop: 'Potato' },
    });
  });

  test('order tracking, negotiation, transport, dispute and listing intents', () => {
    const { service } = setup();
    expect(service.detectIntent('meri order ord1 kahan hai')).toEqual({
      intent: 'track_order', entities: { order_id: 'ord1' },
    });
    expect(service.detectIntent('offer off1 par 2050 kar do')).toEqual({
      intent: 'negotiate', entities: { offer_id: 'off1', requested_price: 2050 },
    });
    expect(service.detectIntent('order ord1 ke liye transporter tr1 se gaadi book karo, delivery 2027-02-01 se 2027-02-05 tak')).toEqual({
      intent: 'book_transport',
      entities: {
        order_id: 'ord1', transporter_id: 'tr1',
        delivery_window_start: '2027-02-01', delivery_window_end: '2027-02-05',
      },
    });
    expect(service.detectIntent('order ord1 ki shikayat, maal kharab aaya')).toEqual({
      intent: 'file_dispute', entities: { order_id: 'ord1', category: 'quality' },
    });
    expect(service.detectIntent('sabzi dikhao')).toEqual({
      intent: 'list_produce', entities: {},
    });
  });

  test('anything else is unknown, with no entities', () => {
    const { service } = setup();
    expect(service.detectIntent('aaj mausam kaisa hai')).toEqual({
      intent: 'unknown', entities: {},
    });
  });
});

describe('price tool — mandi_prices (Stage 3 canonical shape)', () => {
  test('no mandi_prices table returns explicit no-data, never a number', async () => {
    const { service } = setup();
    const result = await service.handleMessage('farmer1', 'gehun ka bhaav kya hai');
    expect(result.intent).toBe('price');
    expect(result.no_data).toBe(true);
    expect(result.sources).toEqual([]);
    expect(result.answer).not.toMatch(/\d/);
    assertGrounded(result);
  });

  test('with mocked mandi rows the answer cites the row and is grounded', async () => {
    const { db, service } = setup();
    db.mandi_prices = [
      {
        id: 'mp1', commodity: 'Wheat', mandi: 'Mathura',
        modal_price: 2400, unit: 'quintal', date: '2026-11-12',
      },
    ];
    const result = await service.handleMessage('farmer1', 'gehun ka bhaav kya hai');
    expect(result.no_data).toBe(false);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ type: 'mandi_price', id: 'mp1', price: 2400 });
    expect(result.answer).toContain('2400');
    assertGrounded(result);
  });

  test('rows for another crop only is still no-data for this crop', async () => {
    const { db, service } = setup();
    db.mandi_prices = [
      { id: 'mp2', commodity: 'Rice', mandi: 'Mathura', modal_price: 3000, unit: 'quintal', date: '2026-11-12' },
    ];
    const result = await service.handleMessage('farmer1', 'gehun ka bhaav kya hai');
    expect(result.no_data).toBe(true);
    expect(result.sources).toEqual([]);
    expect(result.answer).not.toMatch(/\d/);
  });
});

describe('track_order tool', () => {
  test('nonexistent order is explicit no-data and never calls the tracker', async () => {
    const { service } = setup();
    const logistics = require('../services/logisticsService');
    const result = await service.handleMessage('buyer1', 'meri order ord9 kahan hai');
    expect(result.intent).toBe('track_order');
    expect(result.no_data).toBe(true);
    expect(result.sources).toEqual([]);
    expect(result.answer).not.toMatch(/\d/);
    expect(logistics.trackShipment).not.toHaveBeenCalled();
    assertGrounded(result);
  });

  test('someone elses order is the same generic no-data (no leak)', async () => {
    const { service } = setup();
    const logistics = require('../services/logisticsService');
    const result = await service.handleMessage('farmer2', 'meri order ord1 kahan hai');
    expect(result.no_data).toBe(true);
    expect(result.sources).toEqual([]);
    expect(logistics.trackShipment).not.toHaveBeenCalled();
  });

  test('own order with a shipment returns order + shipment as sources', async () => {
    const { service } = setup();
    const logistics = require('../services/logisticsService');
    logistics.trackShipment.mockResolvedValue({
      shipment: { id: 'ship1', status: 'in_transit' }, events: [], gps_trail: [], proof_photos: [],
    });
    const result = await service.handleMessage('buyer1', 'meri order ord2 kahan hai');
    expect(result.no_data).toBe(false);
    expect(logistics.trackShipment).toHaveBeenCalledWith('buyer1', 'ship1');
    expect(result.sources.map((s) => s.type)).toEqual(['order', 'shipment']);
    expect(result.answer).toContain('in_transit');
  });

  test('own order with no shipment yet still answers from the order row', async () => {
    const { service } = setup();
    const logistics = require('../services/logisticsService');
    const result = await service.handleMessage('buyer1', 'meri order ord1 kahan hai');
    expect(result.no_data).toBe(false);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ type: 'order', id: 'ord1', status: 'PAID' });
    expect(logistics.trackShipment).not.toHaveBeenCalled();
  });
});

describe('negotiate tool — farmer floor', () => {
  test('requested price below the tier floor is REFUSED and creates nothing', async () => {
    const { db, service } = setup();
    const negotiation = require('../services/negotiationService');
    const result = await service.handleMessage('farmer1', 'offer off1 par 1900 kar do');
    expect(result.intent).toBe('negotiate');
    expect(result.no_data).toBe(false);
    expect(result.answer).toMatch(/2000/);
    expect(result.sources[0]).toMatchObject({ type: 'offer', id: 'off1' });
    expect(negotiation.counterOffer).not.toHaveBeenCalled();
    expect(db.offers).toHaveLength(2);
    assertGrounded(result);
  });

  test('refusal source carries the floor as a scalar so the UI can render it', async () => {
    const { service } = setup();
    const result = await service.handleMessage('farmer1', 'offer off1 par 1900 kar do');
    expect(result.sources[0]).toMatchObject({ type: 'offer', id: 'off1', floor: 2000 });
    expect(typeof result.sources[0].floor).toBe('number');
  });

  test('requested price within limits places the counter via the service', async () => {
    const { db, service } = setup();
    const negotiation = require('../services/negotiationService');
    negotiation.counterOffer.mockResolvedValue({
      id: 'off1c', requirement_id: 'req1', farmer_id: 'farmer1', created_by: 'farmer1',
      product_id: 'prod1', price: 2050, quantity: 10,
      price_tiers: [{ min_quantity: 10, price: 2000 }],
      expires_at: '2027-01-01T00:00:00.000Z', status: 'open',
    });
    const result = await service.handleMessage('farmer1', 'offer off1 par 2050 kar do');
    expect(result.no_data).toBe(false);
    expect(negotiation.counterOffer).toHaveBeenCalledWith('farmer1', 'off1', {
      price: 2050, quantity: 10,
      price_tiers: [{ min_quantity: 10, price: 2000 }],
      expires_at: '2027-01-01T00:00:00.000Z',
    });
    expect(result.sources[0]).toMatchObject({ type: 'offer', id: 'off1c', price: 2050 });
    expect(result.answer).toContain('2050');
    expect(db.offers).toHaveLength(2);
    assertGrounded(result);
  });

  test('a non-owner farmer gets a generic 404, never the offer', async () => {
    const { service } = setup();
    await expect(service.handleMessage('farmer2', 'offer off1 par 2050 kar do'))
      .rejects.toMatchObject({ status: 404, code: 'NEGOTIATION_NOT_FOUND' });
  });

  test('no tiers means the floor is the offer price itself', async () => {
    const { service } = setup();
    const negotiation = require('../services/negotiationService');
    const result = await service.handleMessage('farmer1', 'offer off2 par 2100 kar do');
    expect(result.answer).toMatch(/2200/);
    expect(negotiation.counterOffer).not.toHaveBeenCalled();
  });
});

describe('book_transport tool', () => {
  test('quotes then books and returns shipment + quote as sources', async () => {
    const { service } = setup();
    const logistics = require('../services/logisticsService');
    logistics.quoteShipment.mockResolvedValue({ price_paise: 5000, distance_km: null, currency: 'INR' });
    logistics.bookShipment.mockResolvedValue({
      id: 'ship9', order_id: 'ord1', transporter_id: 'tr1', status: 'booked', price_paise: 5000,
    });
    const result = await service.handleMessage(
      'farmer1',
      'order ord1 ke liye transporter tr1 se gaadi book karo, delivery 2027-02-01 se 2027-02-05 tak',
    );
    expect(result.no_data).toBe(false);
    expect(logistics.quoteShipment).toHaveBeenCalledWith('farmer1', { order_id: 'ord1', transporter_id: 'tr1' });
    expect(logistics.bookShipment).toHaveBeenCalledWith('farmer1', {
      order_id: 'ord1', transporter_id: 'tr1', price_paise: 5000,
      delivery_window_start: '2027-02-01', delivery_window_end: '2027-02-05',
    });
    expect(result.sources.map((s) => s.type)).toEqual(['shipment', 'quote']);
    expect(result.sources[0]).toMatchObject({ type: 'shipment', id: 'ship9' });
    expect(result.answer).toContain('5000');
    assertGrounded(result);
  });

  test('no delivery window in the message asks for it instead of booking', async () => {
    const { service } = setup();
    const logistics = require('../services/logisticsService');
    const result = await service.handleMessage(
      'farmer1', 'order ord1 ke liye transporter tr1 se gaadi book karo',
    );
    expect(result.no_data).toBe(true);
    expect(result.sources).toEqual([]);
    expect(logistics.quoteShipment).not.toHaveBeenCalled();
    expect(logistics.bookShipment).not.toHaveBeenCalled();
  });

  test('someone elses order is generic no-data, never a quote', async () => {
    const { service } = setup();
    const logistics = require('../services/logisticsService');
    const result = await service.handleMessage(
      'farmer2',
      'order ord1 ke liye transporter tr1 se gaadi book karo, delivery 2027-02-01 se 2027-02-05 tak',
    );
    expect(result.no_data).toBe(true);
    expect(logistics.quoteShipment).not.toHaveBeenCalled();
  });
});

describe('file_dispute tool', () => {
  test('files via the dispute service and cites the dispute', async () => {
    const { service } = setup();
    const disputes = require('../services/disputeService');
    disputes.fileDispute.mockResolvedValue({
      id: 'disp1', order_id: 'ord1', filer_id: 'buyer1', category: 'quality', status: 'filed',
    });
    const result = await service.handleMessage('buyer1', 'order ord1 ki shikayat, maal kharab aaya');
    expect(result.no_data).toBe(false);
    expect(disputes.fileDispute).toHaveBeenCalledWith('buyer1', {
      order_id: 'ord1', category: 'quality', description: 'order ord1 ki shikayat, maal kharab aaya',
    });
    expect(result.sources[0]).toMatchObject({ type: 'dispute', id: 'disp1', status: 'filed' });
  });

  test('a non-counterparty gets the generic not-found, never files', async () => {
    const { service } = setup();
    const disputes = require('../services/disputeService');
    await expect(service.handleMessage('farmer2', 'order ord1 ki shikayat, maal kharab aaya'))
      .rejects.toMatchObject({ status: 404 });
    expect(disputes.fileDispute).not.toHaveBeenCalled();
  });
});

describe('list_produce tool', () => {
  test('lists real products with sources and a grounded answer', async () => {
    const { service } = setup();
    const result = await service.handleMessage('buyer1', 'sabzi dikhao');
    expect(result.no_data).toBe(false);
    expect(result.sources).toHaveLength(2);
    expect(result.sources.map((s) => s.type)).toEqual(['product', 'product']);
    expect(result.answer).toContain('2200');
    expect(result.answer).toContain('3000');
    assertGrounded(result);
  });

  test('no products is an honest empty state, never invented rows', async () => {
    const { db, service } = setup();
    db.products = [];
    const result = await service.handleMessage('buyer1', 'sabzi dikhao');
    expect(result.no_data).toBe(true);
    expect(result.sources).toEqual([]);
    expect(result.answer).not.toMatch(/\d/);
  });
});

describe('unknown intent', () => {
  test('returns no_data without fabricating anything', async () => {
    const { service } = setup();
    const result = await service.handleMessage('buyer1', 'aaj mausam kaisa hai');
    expect(result.intent).toBe('unknown');
    expect(result.no_data).toBe(true);
    expect(result.sources).toEqual([]);
    expect(result.answer).not.toMatch(/\d/);
    assertGrounded(result);
  });
});

describe('chat() — conversation storage is user-scoped', () => {
  test('first chat creates one row for the caller with both turns', async () => {
    const { db, service } = setup();
    const result = await service.chat('buyer1', 'sabzi dikhao');
    expect(result.conversation_id).toBeTruthy();
    expect(result.intent).toBe('list_produce');
    expect(db.assistant_conversations).toHaveLength(1);
    const row = db.assistant_conversations[0];
    expect(row.user_id).toBe('buyer1');
    expect(row.messages).toHaveLength(2);
    expect(row.messages[0]).toMatchObject({ role: 'user', content: 'sabzi dikhao' });
    expect(row.messages[1]).toMatchObject({ role: 'assistant', intent: 'list_produce' });
    expect(row.messages[1].sources).toHaveLength(2);
    expect(row.sources).toHaveLength(2);
  });

  test('a no-data turn stores sources [] explicitly with the no_data flag', async () => {
    const { db, service } = setup();
    const result = await service.chat('buyer1', 'gehun ka bhaav kya hai');
    expect(result.no_data).toBe(true);
    const row = db.assistant_conversations[0];
    expect(row.messages[1]).toMatchObject({ role: 'assistant', no_data: true, sources: [] });
    expect(row.sources).toEqual([]);
  });

  test('second chat with the conversation id appends to the same row', async () => {
    const { db, service } = setup();
    const first = await service.chat('buyer1', 'sabzi dikhao');
    const second = await service.chat('buyer1', 'gehun ka bhaav kya hai', first.conversation_id);
    expect(second.conversation_id).toBe(first.conversation_id);
    expect(db.assistant_conversations).toHaveLength(1);
    expect(db.assistant_conversations[0].messages).toHaveLength(4);
  });

  test('another users conversation id never opens their row — a new row is made', async () => {
    const { db, service } = setup();
    const first = await service.chat('buyer1', 'sabzi dikhao');
    const before = JSON.stringify(db.assistant_conversations[0].messages);
    const second = await service.chat('farmer1', 'sabzi dikhao', first.conversation_id);
    expect(second.conversation_id).not.toBe(first.conversation_id);
    expect(db.assistant_conversations).toHaveLength(2);
    expect(JSON.stringify(db.assistant_conversations[0].messages)).toBe(before);
    expect(db.assistant_conversations[1].user_id).toBe('farmer1');
  });

  test('conversation reads always filter by the callers user_id', async () => {
    const { db, service } = setup();
    const first = await service.chat('buyer1', 'sabzi dikhao');
    await service.chat('buyer1', 'sabzi dikhao', first.conversation_id);
    const reads = db.__calls.filter(
      (c) => c.table === 'assistant_conversations' && c.op === 'select',
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.filters).toContainEqual({ type: 'eq', col: 'user_id', val: 'buyer1' });
    }
  });

  test('empty message is a 400, nothing is stored', async () => {
    const { db, service } = setup();
    await expect(service.chat('buyer1', '   ')).rejects.toMatchObject({ status: 400 });
    expect(db.assistant_conversations).toHaveLength(0);
  });
});

describe('llmProvider stub — the core pipeline never calls it', () => {
  test('no provider is configured; generate fails closed, never fabricates', async () => {
    jest.resetModules();
    const { getLlmProvider } = require('../services/llmProvider');
    const provider = getLlmProvider();
    expect(provider.isConfigured()).toBe(false);
    await expect(provider.generate('gehun ka bhaav kya hai'))
      .rejects.toMatchObject({ status: 503, code: 'LLM_NOT_CONFIGURED' });
  });
});
