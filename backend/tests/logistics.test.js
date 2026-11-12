'use strict';
/**
 * Logistics & Delivery (Stage 6, module E) — migration + backend unit.
 *
 * OTP design (the brief's two requirements together force it): booking
 * stores ONLY otp_hash (SHA-256 of salt+otp) + otp_salt — never the
 * plaintext, never logged — AND the buyer must see the OTP on their
 * tracking page. So the OTP is derived deterministically from the stored
 * salt and the shipment id (SHA-256(salt:id) -> 6 digits): the buyer
 * track call recomputes it, the verify call hashes the candidate and
 * compares in constant time. A 6-digit OTP is brute-forceable from a
 * leaked hash anyway; the real guards are the 5-attempt lockout and
 * that only the buyer ever sees the OTP in a response.
 *
 * Drop point: orders carry NO delivery lat/lng (only delivery_address
 * text) — the quote uses the buyer's profile latitude/longitude, the
 * only buyer coordinates in the schema. Pickup is the farmer's profile
 * lat/lng. Missing coordinates + no flat rate -> 422 NO_ROUTE_DATA.
 *
 * Hand-checked literals (NOT derived from the code):
 * - Haversine (0,0) -> (0,1) at R=6371 km is 111.19492664455873 km
 *   (2*6371*asin(sin(0.5 deg in rad))); rounded distance_km 111.19.
 * - Per-km rate 100 paise/km x that distance = 11119.49... -> 11119 paise.
 * - Flat rate 5000 returns as-is, distance_km null.
 * - Pooled lot: one shipment per order (UNIQUE order_id) — a second
 *   booking for the same pooled order is a 409, never a second shipment.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_mock';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'test-secret';

const fs = require('fs');
const path = require('path');

const mockHolder = { supabase: null, lastSignedUrl: null, signedUrlBuckets: [] };

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
      if (q.table === 'shipments' && table.some((r) => r.order_id === q.row.order_id)) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "shipments_order_id_key"' } };
      }
      if (q.table === 'transporters' && table.some((r) => r.user_id === q.row.user_id)) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "transporters_user_id_key"' } };
      }
      if (q.table === 'verification_submissions' && table.some(
        (r) => r.farmer_id === q.row.farmer_id && r.status === 'pending',
      )) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "verification_submissions_one_pending_idx"' } };
      }
      const row = { id: q.row.id || `id_${Math.random().toString(36).slice(2)}`, ...q.row };
      table.push(row);
      return { data: [row], error: null };
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
    storage: {
      from: (bucket) => ({
        createSignedUrl: jest.fn(async (innerPath, expiresIn) => {
          mockHolder.signedUrlBuckets.push(bucket);
          const url = `https://example.test/signed/${bucket}/${innerPath}?expires=${expiresIn}`;
          mockHolder.lastSignedUrl = url;
          return { data: { signedUrl: url }, error: null };
        }),
      }),
    },
  };
}

function seedDb() {
  return {
    profiles: [
      { id: 'farmer1', role: 'farmer', verification_status: 'verified', latitude: 0, longitude: 0 },
      { id: 'farmer2', role: 'farmer', verification_status: 'verified', latitude: 1, longitude: 1 },
      { id: 'farmer-noloc', role: 'farmer', verification_status: 'verified', latitude: null, longitude: null },
      { id: 'buyer1', role: 'buyer', verification_status: 'unverified', latitude: 0, longitude: 1 },
      { id: 'buyer-noloc', role: 'buyer', verification_status: 'unverified', latitude: null, longitude: null },
      { id: 'transporter1', role: 'transporter', verification_status: 'verified', latitude: null, longitude: null },
      { id: 'transporter2', role: 'transporter', verification_status: 'verified', latitude: null, longitude: null },
      { id: 'transporter3', role: 'transporter', verification_status: 'pending', latitude: null, longitude: null },
      { id: 'transporter4', role: 'transporter', verification_status: 'verified', latitude: null, longitude: null },
      { id: 'newbie', role: 'buyer', verification_status: 'unverified', latitude: null, longitude: null },
      { id: 'admin1', role: 'admin', verification_status: 'verified', latitude: null, longitude: null },
    ],
    transporters: [
      { id: 'tr1', user_id: 'transporter1', verification_status: 'verified', vehicle_type: 'Truck', vehicle_number: 'UP81AB1234', service_areas: ['Mathura', 'Agra'], rate_paise_per_km: null, flat_rate_paise: 5000, rating: null },
      { id: 'tr2', user_id: 'transporter2', verification_status: 'verified', vehicle_type: 'Tempo', vehicle_number: 'UP81CD5678', service_areas: ['Mathura'], rate_paise_per_km: 100, flat_rate_paise: null, rating: null },
      { id: 'tr3', user_id: 'transporter3', verification_status: 'pending', vehicle_type: 'Truck', vehicle_number: 'UP81EF9999', service_areas: ['Mathura'], rate_paise_per_km: null, flat_rate_paise: 1000, rating: null },
      { id: 'tr4', user_id: 'transporter4', verification_status: 'verified', vehicle_type: 'Bike', vehicle_number: 'UP81GH0001', service_areas: ['Mathura'], rate_paise_per_km: null, flat_rate_paise: null, rating: null },
    ],
    orders: [
      { id: 'order1', buyer_id: 'buyer1', farmer_id: 'farmer1', product_id: 'prod1', status: 'PAID', total_price: 100000, delivery_deadline: '2026-11-14T00:00:00.000Z', completed_at: null },
      { id: 'order2', buyer_id: 'buyer1', farmer_id: 'farmer1', product_id: 'prod1', status: 'PAID', total_price: 50000, delivery_deadline: '2026-11-14T00:00:00.000Z', completed_at: null },
      { id: 'order3', buyer_id: 'buyer1', farmer_id: 'farmer1', product_id: 'prod1', status: 'CONFIRMED', total_price: 50000, delivery_deadline: null, completed_at: null },
      { id: 'order4', buyer_id: 'buyer1', farmer_id: 'farmer2', product_id: 'prod2', status: 'PAID', total_price: 20000, delivery_deadline: '2026-11-14T00:00:00.000Z', completed_at: null },
      { id: 'order-noloc', buyer_id: 'buyer-noloc', farmer_id: 'farmer-noloc', product_id: 'prod1', status: 'PAID', total_price: 10000, delivery_deadline: '2026-11-14T00:00:00.000Z', completed_at: null },
    ],
    payments: [
      { id: 'pay1', order_id: 'order1', status: 'HELD', amount: 100000 },
      { id: 'pay2', order_id: 'order2', status: 'HELD', amount: 50000 },
      { id: 'pay4', order_id: 'order4', status: 'HELD', amount: 20000 },
    ],
    shipments: [],
    shipment_events: [],
    verification_submissions: [],
    audit_log: [],
    group_buys: [
      { id: 'gb1', owner_id: 'farmer1', crop: 'Wheat', status: 'closed', order_id: 'order2', requirement_id: null },
      { id: 'gb2', owner_id: 'farmer1', crop: 'Rice', status: 'closed', order_id: null, requirement_id: null },
    ],
    group_buy_participants: [
      { id: 'gbp1', group_buy_id: 'gb1', user_id: 'farmer1', contribution_quantity: 100 },
      { id: 'gbp2', group_buy_id: 'gb1', user_id: 'farmer2', contribution_quantity: 200 },
    ],
  };
}

const WINDOW = { delivery_window_start: '2026-11-13T10:00:00.000Z', delivery_window_end: '2026-11-13T18:00:00.000Z' };

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

// Wrong OTP that is guaranteed to differ from the real one for a shipment.
async function wrongOtpFor(service, shipmentId) {
  const tracked = await service.trackShipment('buyer1', shipmentId);
  const real = tracked.otp;
  return real === '000000' ? '000001' : '000000';
}

describe('logisticsService.quoteShipment', () => {
  let service;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    service = require('../services/logisticsService');
  });

  test('flat rate returns as-is with null distance', async () => {
    const q = await service.quoteShipment('farmer1', { order_id: 'order1', transporter_id: 'tr1' });
    expect(q).toEqual({ price_paise: 5000, distance_km: null, currency: 'INR' });
  });

  test('per-km rate x haversine distance gives exact paise (hand-checked)', async () => {
    // Farmer (0,0) -> buyer (0,1): 111.19492664455873 km; x100 paise/km -> 11119.
    expect(service.haversineKm(0, 0, 0, 1)).toBeCloseTo(111.19492664455873, 10);
    const q = await service.quoteShipment('farmer1', { order_id: 'order1', transporter_id: 'tr2' });
    expect(q).toEqual({ price_paise: 11119, distance_km: 111.19, currency: 'INR' });
  });

  test('unverified transporter cannot be quoted', async () => {
    await expect(service.quoteShipment('farmer1', { order_id: 'order1', transporter_id: 'tr3' }))
      .rejects.toMatchObject({ status: 422, code: 'TRANSPORTER_NOT_VERIFIED' });
  });

  test('only the order farmer can quote (buyer and other farmer get generic 404)', async () => {
    await expect(service.quoteShipment('buyer1', { order_id: 'order1', transporter_id: 'tr1' }))
      .rejects.toMatchObject({ status: 404, code: 'ORDER_NOT_ACCESSIBLE' });
    await expect(service.quoteShipment('farmer2', { order_id: 'order1', transporter_id: 'tr1' }))
      .rejects.toMatchObject({ status: 404, code: 'ORDER_NOT_ACCESSIBLE' });
  });

  test('missing coordinates and no flat rate -> 422 NO_ROUTE_DATA', async () => {
    await expect(service.quoteShipment('farmer-noloc', { order_id: 'order-noloc', transporter_id: 'tr2' }))
      .rejects.toMatchObject({ status: 422, code: 'NO_ROUTE_DATA' });
  });

  test('transporter with neither rate -> 422', async () => {
    await expect(service.quoteShipment('farmer1', { order_id: 'order1', transporter_id: 'tr4' }))
      .rejects.toMatchObject({ status: 422, code: 'NO_RATE' });
  });

  test('missing order -> generic 404, missing transporter -> 404', async () => {
    await expect(service.quoteShipment('farmer1', { order_id: 'nope', transporter_id: 'tr1' }))
      .rejects.toMatchObject({ status: 404, code: 'ORDER_NOT_ACCESSIBLE' });
    await expect(service.quoteShipment('farmer1', { order_id: 'order1', transporter_id: 'nope' }))
      .rejects.toMatchObject({ status: 404, code: 'TRANSPORTER_NOT_FOUND' });
  });
});

describe('transporterService', () => {
  let service;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    service = require('../services/transporterService');
  });

  test('register flips role, creates pending transporter row + pending submission', async () => {
    const out = await service.registerTransporter('newbie', {
      vehicle_type: 'Truck', vehicle_number: 'UP81ZZ1111', service_areas: ['Mathura'], flat_rate_paise: 2000,
    });
    expect(out.transporter.verification_status).toBe('pending');
    expect(out.transporter.vehicle_number).toBe('UP81ZZ1111');
    expect(out.submission.status).toBe('pending');
    expect(db.profiles.find((p) => p.id === 'newbie').role).toBe('transporter');
    expect(db.profiles.find((p) => p.id === 'newbie').verification_status).toBe('pending');
    expect(db.audit_log.some((r) => r.event === 'transporter.registered')).toBe(true);
  });

  test('second registration -> 409', async () => {
    await expect(service.registerTransporter('transporter1', {
      vehicle_type: 'Truck', vehicle_number: 'UP81ZZ2222', service_areas: ['Mathura'], flat_rate_paise: 100,
    })).rejects.toMatchObject({ status: 409, code: 'TRANSPORTER_ALREADY_REGISTERED' });
  });

  test('no rate at all -> 422; missing vehicle number -> 422; empty service areas -> 422', async () => {
    await expect(service.registerTransporter('newbie', {
      vehicle_type: 'Truck', vehicle_number: 'UP81ZZ1111', service_areas: ['Mathura'],
    })).rejects.toMatchObject({ status: 422 });
    await expect(service.registerTransporter('newbie', {
      vehicle_type: 'Truck', service_areas: ['Mathura'], flat_rate_paise: 100,
    })).rejects.toMatchObject({ status: 422 });
    await expect(service.registerTransporter('newbie', {
      vehicle_type: 'Truck', vehicle_number: 'UP81ZZ1111', service_areas: [], flat_rate_paise: 100,
    })).rejects.toMatchObject({ status: 422 });
  });

  test('list returns verified transporters only', async () => {
    const rows = await service.listTransporters();
    expect(rows.map((r) => r.user_id).sort()).toEqual(['transporter1', 'transporter2', 'transporter4']);
    expect(rows.every((r) => r.verification_status === 'verified')).toBe(true);
  });

  test('mine returns own row, 404 when none', async () => {
    const row = await service.getMyTransporter('transporter2');
    expect(row.vehicle_number).toBe('UP81CD5678');
    await expect(service.getMyTransporter('newbie'))
      .rejects.toMatchObject({ status: 404, code: 'TRANSPORTER_NOT_FOUND' });
  });
});

describe('logisticsService.bookShipment', () => {
  let service;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    service = require('../services/logisticsService');
  });

  test('books, ships the order, sets delivery_deadline to the window end, first event booked', async () => {
    const row = await service.bookShipment('farmer1', {
      order_id: 'order1', transporter_id: 'tr1', price_paise: 5000, ...WINDOW,
    });
    expect(row.status).toBe('booked');
    expect(row.price_paise).toBe(5000);
    expect(row.otp_hash).toBeUndefined();
    expect(row.otp_salt).toBeUndefined();
    expect(row.otp).toBeUndefined();
    expect(db.orders.find((o) => o.id === 'order1').status).toBe('SHIPPED');
    expect(db.orders.find((o) => o.id === 'order1').delivery_deadline).toBe(WINDOW.delivery_window_end);
    expect(db.shipment_events.filter((e) => e.shipment_id === row.id).map((e) => e.status)).toEqual(['booked']);
    expect(db.audit_log.some((r) => r.event === 'shipment.booked')).toBe(true);
    const stored = db.shipments.find((s) => s.id === row.id);
    expect(typeof stored.otp_hash).toBe('string');
    expect(stored.otp_hash).toHaveLength(64);
    expect(typeof stored.otp_salt).toBe('string');
  });

  test('second booking for the same order -> 409 (one shipment per order)', async () => {
    await service.bookShipment('farmer1', { order_id: 'order1', transporter_id: 'tr1', price_paise: 5000, ...WINDOW });
    await expect(service.bookShipment('farmer1', { order_id: 'order1', transporter_id: 'tr1', price_paise: 5000, ...WINDOW }))
      .rejects.toMatchObject({ status: 409, code: 'SHIPMENT_ALREADY_EXISTS' });
    expect(db.shipments.filter((s) => s.order_id === 'order1')).toHaveLength(1);
  });

  test('price mismatch with the recomputed quote -> 422', async () => {
    await expect(service.bookShipment('farmer1', { order_id: 'order1', transporter_id: 'tr1', price_paise: 4999, ...WINDOW }))
      .rejects.toMatchObject({ status: 422, code: 'PRICE_MISMATCH' });
    expect(db.shipments).toHaveLength(0);
    expect(db.orders.find((o) => o.id === 'order1').status).toBe('PAID');
  });

  test('unpaid order cannot be booked -> 409, nothing created', async () => {
    await expect(service.bookShipment('farmer1', { order_id: 'order3', transporter_id: 'tr1', price_paise: 5000, ...WINDOW }))
      .rejects.toMatchObject({ status: 409 });
    expect(db.shipments).toHaveLength(0);
  });

  test('only the order farmer can book', async () => {
    await expect(service.bookShipment('farmer2', { order_id: 'order1', transporter_id: 'tr1', price_paise: 5000, ...WINDOW }))
      .rejects.toMatchObject({ status: 404, code: 'ORDER_NOT_ACCESSIBLE' });
  });

  test('self-delivery (no transporter) books and ships without a quote', async () => {
    const row = await service.bookShipment('farmer1', {
      order_id: 'order1', transporter_id: null, price_paise: 0, ...WINDOW,
    });
    expect(row.status).toBe('booked');
    expect(row.transporter_id).toBeNull();
    expect(db.orders.find((o) => o.id === 'order1').status).toBe('SHIPPED');
  });

  test('bad window (end before start) -> 422', async () => {
    await expect(service.bookShipment('farmer1', {
      order_id: 'order1', transporter_id: 'tr1', price_paise: 5000,
      delivery_window_start: '2026-11-13T18:00:00.000Z', delivery_window_end: '2026-11-13T10:00:00.000Z',
    })).rejects.toMatchObject({ status: 422 });
  });
});

describe('escrow ship-order backward compat (Stage 0 endpoint, no transporter)', () => {
  let escrow;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    escrow = require('../services/escrowService');
  });

  test('POST /api/escrow/ship-order path still ships a PAID order untouched by Stage 6', async () => {
    const updated = await escrow.markOrderAsShipped('order4', 'farmer2');
    expect(updated.status).toBe('SHIPPED');
    expect(db.orders.find((o) => o.id === 'order4').status).toBe('SHIPPED');
  });
});

describe('logisticsService.updateShipmentStatus', () => {
  let service;
  let db;
  let shipmentId;

  beforeEach(async () => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    service = require('../services/logisticsService');
    const row = await service.bookShipment('farmer1', {
      order_id: 'order1', transporter_id: 'tr2', price_paise: 11119, ...WINDOW,
    });
    shipmentId = row.id;
  });

  test('transporter advances booked -> picked_up with a GPS point; second update appends a second point in order', async () => {
    const afterFirst = await service.updateShipmentStatus('transporter2', shipmentId, { status: 'picked_up', lat: 27.5, lng: 77.7 });
    expect(afterFirst.status).toBe('picked_up');
    expect(afterFirst.gps_trail).toEqual([{ lat: 27.5, lng: 77.7, at: expect.any(String) }]);
    const afterSecond = await service.updateShipmentStatus('transporter2', shipmentId, { status: 'in_transit', lat: 27.6, lng: 77.8 });
    expect(afterSecond.gps_trail).toHaveLength(2);
    expect(afterSecond.gps_trail[0].lat).toBe(27.5);
    expect(afterSecond.gps_trail[1].lat).toBe(27.6);
    // A status update without coordinates never rewrites the trail.
    const afterThird = await service.updateShipmentStatus('transporter2', shipmentId, { status: 'out_for_delivery' });
    expect(afterThird.gps_trail).toHaveLength(2);
    const events = db.shipment_events.filter((e) => e.shipment_id === shipmentId).map((e) => e.status);
    expect(events).toEqual(['booked', 'picked_up', 'in_transit', 'out_for_delivery']);
  });

  test('another transporter cannot update -> 403; a non-party cannot either', async () => {
    await expect(service.updateShipmentStatus('transporter1', shipmentId, { status: 'picked_up' }))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await expect(service.updateShipmentStatus('buyer1', shipmentId, { status: 'picked_up' }))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  test('delivered via PATCH is rejected with 422 (delivery goes through verify-otp only)', async () => {
    await expect(service.updateShipmentStatus('transporter2', shipmentId, { status: 'delivered' }))
      .rejects.toMatchObject({ status: 422, code: 'DELIVERY_REQUIRES_OTP' });
  });

  test('skipping a step is a 409', async () => {
    await expect(service.updateShipmentStatus('transporter2', shipmentId, { status: 'in_transit' }))
      .rejects.toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
  });

  test('farmer may cancel from booked; farmer may not pick up; cancel from in_transit is a 409', async () => {
    const cancelled = await service.updateShipmentStatus('farmer1', shipmentId, { status: 'cancelled' });
    expect(cancelled.status).toBe('cancelled');
    await expect(service.updateShipmentStatus('transporter2', shipmentId, { status: 'picked_up' }))
      .rejects.toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
  });

  test('farmer picked_up attempt -> 403; transporter cancel from in_transit -> 409', async () => {
    await expect(service.updateShipmentStatus('farmer1', shipmentId, { status: 'picked_up' }))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await service.updateShipmentStatus('transporter2', shipmentId, { status: 'picked_up' });
    await service.updateShipmentStatus('transporter2', shipmentId, { status: 'in_transit' });
    await expect(service.updateShipmentStatus('transporter2', shipmentId, { status: 'cancelled' }))
      .rejects.toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
  });

  test('out-of-range coordinates -> 422', async () => {
    await expect(service.updateShipmentStatus('transporter2', shipmentId, { status: 'picked_up', lat: 91, lng: 0 }))
      .rejects.toMatchObject({ status: 422 });
  });
});

describe('logisticsService.verifyOtp', () => {
  let service;
  let db;
  let shipmentId;
  let realOtp;

  beforeEach(async () => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    service = require('../services/logisticsService');
    const row = await service.bookShipment('farmer1', {
      order_id: 'order1', transporter_id: 'tr2', price_paise: 11119, ...WINDOW,
    });
    shipmentId = row.id;
    realOtp = (await service.trackShipment('buyer1', shipmentId)).otp;
    expect(typeof realOtp).toBe('string');
    expect(realOtp).toHaveLength(6);
  });

  test('missing proof photo -> 422 even with the correct OTP', async () => {
    await expect(service.verifyOtp('transporter2', shipmentId, { otp: realOtp }))
      .rejects.toMatchObject({ status: 422, code: 'PROOF_REQUIRED' });
    expect(db.shipments.find((s) => s.id === shipmentId).status).toBe('booked');
  });

  test('proof path outside delivery-proofs/ -> 422', async () => {
    await expect(service.verifyOtp('transporter2', shipmentId, { otp: realOtp, proof_photo_path: 'product-items/x.jpg' }))
      .rejects.toMatchObject({ status: 422, code: 'PROOF_REQUIRED' });
  });

  test('wrong OTP -> 401 and increments attempts; correct OTP completes delivery AND releases payment', async () => {
    const wrong = await wrongOtpFor(service, shipmentId);
    await expect(service.verifyOtp('transporter2', shipmentId, { otp: wrong, proof_photo_path: 'delivery-proofs/transporter2-abc.jpg' }))
      .rejects.toMatchObject({ status: 401, code: 'INVALID_OTP' });
    expect(db.shipments.find((s) => s.id === shipmentId).otp_attempts).toBe(1);
    expect(db.orders.find((o) => o.id === 'order1').status).toBe('SHIPPED');

    const done = await service.verifyOtp('transporter2', shipmentId, { otp: realOtp, proof_photo_path: 'delivery-proofs/transporter2-abc.jpg' });
    expect(done.status).toBe('delivered');
    expect(done.proof_photo_paths).toEqual(['delivery-proofs/transporter2-abc.jpg']);
    expect(db.shipments.find((s) => s.id === shipmentId).otp_attempts).toBe(0);
    // The escrow release path ran, not just the shipment row: order
    // COMPLETED with completed_at, HELD payment RELEASED.
    const order = db.orders.find((o) => o.id === 'order1');
    expect(order.status).toBe('COMPLETED');
    expect(order.completed_at).toBeTruthy();
    expect(db.payments.find((p) => p.order_id === 'order1').status).toBe('RELEASED');
    expect(db.shipment_events.filter((e) => e.shipment_id === shipmentId).map((e) => e.status))
      .toEqual(['booked', 'delivered']);
    expect(db.audit_log.some((r) => r.event === 'shipment.otp_verified')).toBe(true);
    expect(db.audit_log.some((r) => r.event === 'shipment.delivered')).toBe(true);
  });

  test('5 wrong OTPs lock the shipment for 15 minutes (429 while locked)', async () => {
    const wrong = await wrongOtpFor(service, shipmentId);
    for (let i = 0; i < 5; i++) {
      await expect(service.verifyOtp('transporter2', shipmentId, { otp: wrong, proof_photo_path: 'delivery-proofs/x.jpg' }))
        .rejects.toMatchObject({ status: 401 });
    }
    const stored = db.shipments.find((s) => s.id === shipmentId);
    expect(stored.otp_attempts).toBe(5);
    expect(new Date(stored.otp_locked_until).getTime()).toBeGreaterThan(Date.now());
    await expect(service.verifyOtp('transporter2', shipmentId, { otp: realOtp, proof_photo_path: 'delivery-proofs/x.jpg' }))
      .rejects.toMatchObject({ status: 429, code: 'OTP_LOCKED' });
  });

  test('only the assigned transporter can verify (other transporter -> 403)', async () => {
    await expect(service.verifyOtp('transporter1', shipmentId, { otp: realOtp, proof_photo_path: 'delivery-proofs/x.jpg' }))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  test('self-delivery: the order farmer verifies the OTP (no transporter assigned)', async () => {
    const selfRow = await service.bookShipment('farmer1', {
      order_id: 'order2', transporter_id: null, price_paise: 0, ...WINDOW,
    });
    const selfOtp = (await service.trackShipment('buyer1', selfRow.id)).otp;
    const done = await service.verifyOtp('farmer1', selfRow.id, { otp: selfOtp, proof_photo_path: 'delivery-proofs/farmer1-abc.jpg' });
    expect(done.status).toBe('delivered');
    expect(db.orders.find((o) => o.id === 'order2').status).toBe('COMPLETED');
  });
});

describe('logisticsService.trackShipment', () => {
  let service;
  let db;
  let shipmentId;

  beforeEach(async () => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    service = require('../services/logisticsService');
    const row = await service.bookShipment('farmer1', {
      order_id: 'order1', transporter_id: 'tr2', price_paise: 11119, ...WINDOW,
    });
    shipmentId = row.id;
    await service.updateShipmentStatus('transporter2', shipmentId, { status: 'picked_up', lat: 27.5, lng: 77.7 });
  });

  test('buyer sees the OTP, events, GPS trail and proof signed URLs; hash/salt never leak', async () => {
    const out = await service.trackShipment('buyer1', shipmentId);
    expect(typeof out.otp).toBe('string');
    expect(out.otp).toHaveLength(6);
    expect(out.shipment.otp_hash).toBeUndefined();
    expect(out.shipment.otp_salt).toBeUndefined();
    expect(out.events.map((e) => e.status)).toEqual(['booked', 'picked_up']);
    expect(out.shipment.gps_trail).toHaveLength(1);
    expect(out.proof_photos).toEqual([]);
  });

  test('track response matches the frontend contract: top-level gps_trail and proof_photos', async () => {
    const out = await service.trackShipment('buyer1', shipmentId);
    expect(out.gps_trail).toHaveLength(1);
    expect(out.gps_trail[0]).toMatchObject({ lat: 27.5, lng: 77.7 });
    expect(out.proof_photos).toEqual([]);
    expect(out.proof_photo_urls).toBeUndefined();
  });

  test('transporter and farmer never see the OTP; proof photos get 5-minute signed URLs from delivery-proofs', async () => {
    const realOtp = (await service.trackShipment('buyer1', shipmentId)).otp;
    await service.verifyOtp('transporter2', shipmentId, { otp: realOtp, proof_photo_path: 'delivery-proofs/transporter2-abc.jpg' });
    const asTransporter = await service.trackShipment('transporter2', shipmentId);
    expect(asTransporter.otp).toBeUndefined();
    expect(asTransporter.proof_photos).toHaveLength(1);
    expect(asTransporter.proof_photos[0]).toContain('delivery-proofs/transporter2-abc.jpg');
    expect(asTransporter.proof_photos[0]).toContain('expires=300');
    expect(mockHolder.signedUrlBuckets).toContain('delivery-proofs');
    const asFarmer = await service.trackShipment('farmer1', shipmentId);
    expect(asFarmer.otp).toBeUndefined();
    const asAdmin = await service.trackShipment('admin1', shipmentId);
    expect(asAdmin.otp).toBeUndefined();
    expect(asAdmin.shipment.status).toBe('delivered');
  });

  test('non-party gets a generic 404', async () => {
    await expect(service.trackShipment('farmer2', shipmentId))
      .rejects.toMatchObject({ status: 404, code: 'SHIPMENT_NOT_ACCESSIBLE' });
    await expect(service.trackShipment('newbie', shipmentId))
      .rejects.toMatchObject({ status: 404, code: 'SHIPMENT_NOT_ACCESSIBLE' });
  });
});

describe('verificationService transporter sync (Stage 1 queue, no second flow)', () => {
  let verification;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    verification = require('../services/verificationService');
  });

  test('approving a transporter submission also verifies the transporters row', async () => {
    db.verification_submissions.push({
      id: 'sub-t3', farmer_id: 'transporter3', document_path: '', status: 'pending',
      review_note: null, reviewed_by: null, reviewed_at: null, created_at: '2026-11-12T00:00:00.000Z',
    });
    const out = await verification.approveVerification('admin1', 'sub-t3');
    expect(out.status).toBe('approved');
    expect(db.transporters.find((t) => t.user_id === 'transporter3').verification_status).toBe('verified');
    expect(db.audit_log.some((r) => r.event === 'transporter.approved')).toBe(true);
  });

  test('rejecting a transporter submission also rejects the transporters row', async () => {
    db.verification_submissions.push({
      id: 'sub-t3', farmer_id: 'transporter3', document_path: '', status: 'pending',
      review_note: null, reviewed_by: null, reviewed_at: null, created_at: '2026-11-12T00:00:00.000Z',
    });
    await verification.rejectVerification('admin1', 'sub-t3', 'Vehicle papers unclear.');
    expect(db.transporters.find((t) => t.user_id === 'transporter3').verification_status).toBe('rejected');
    expect(db.audit_log.some((r) => r.event === 'transporter.rejected')).toBe(true);
  });

  test('approving a farmer submission leaves transporters untouched (no row for that user)', async () => {
    db.verification_submissions.push({
      id: 'sub-f1', farmer_id: 'farmer1', document_path: 'verification-docs/farmer1-abc.jpg', status: 'pending',
      review_note: null, reviewed_by: null, reviewed_at: null, created_at: '2026-11-12T00:00:00.000Z',
    });
    await verification.approveVerification('admin1', 'sub-f1');
    expect(db.transporters).toHaveLength(4);
    expect(db.audit_log.some((r) => r.event === 'transporter.approved')).toBe(false);
  });
});

describe('groupTransport shared booking (Stage 5 hook)', () => {
  let transport;
  let logistics;
  let db;

  beforeEach(async () => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    transport = require('../services/groupTransport');
    logistics = require('../services/logisticsService');
  });

  test('pooled lot with a shipment returns the shared booking summary', async () => {
    const row = await logistics.bookShipment('farmer1', {
      order_id: 'order2', transporter_id: 'tr1', price_paise: 5000, ...WINDOW,
    });
    const group = db.group_buys.find((g) => g.id === 'gb1');
    const booking = await transport.getTransportBooking(group);
    expect(booking).toEqual({
      shipment_id: row.id, transporter_id: 'tr1', status: 'booked', price_paise: 5000, shared_by: 2,
    });
  });

  test('no shipment yet -> null; group with no order -> null', async () => {
    const group = db.group_buys.find((g) => g.id === 'gb1');
    expect(await transport.getTransportBooking(group)).toBeNull();
    expect(await transport.getTransportBooking(db.group_buys.find((g) => g.id === 'gb2'))).toBeNull();
    expect(await transport.getTransportBooking(null)).toBeNull();
  });
});

describe('routes mount the right guards', () => {
  beforeEach(() => {
    jest.resetModules();
    mockHolder.supabase = makeSupabaseMock(seedDb());
  });

  test('logistics router has the five Stage 6 routes; verify-otp carries the extra 10/min limiter', () => {
    const logisticsRoutes = require('../routes/logisticsRoutes');
    const paths = logisticsRoutes.stack
      .filter((l) => l.route)
      .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`)
      .sort();
    expect(paths).toEqual([
      'GET /:id/track',
      'PATCH /:id/status',
      'POST /',
      'POST /:id/verify-otp',
      'POST /quote',
    ].sort());
    const otpLayer = logisticsRoutes.stack.find((l) => l.route && l.route.path === '/:id/verify-otp');
    // requireAuth + otp limiter + handler.
    expect(otpLayer.route.stack).toHaveLength(3);
    const quoteLayer = logisticsRoutes.stack.find((l) => l.route && l.route.path === '/quote');
    expect(quoteLayer.route.stack).toHaveLength(2);
  });

  test('transporter router has register / list / mine', () => {
    const transporterRoutes = require('../routes/transporterRoutes');
    const paths = transporterRoutes.stack
      .filter((l) => l.route)
      .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`)
      .sort();
    expect(paths).toEqual(['GET /', 'GET /mine', 'POST /register'].sort());
  });

  test('server.js mounts shipments and transporters at rateLimit 60', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    expect(src).toContain("app.use('/api/shipments', rateLimit({ max: 60 }), logisticsRoutes)");
    expect(src).toContain("app.use('/api/transporters', rateLimit({ max: 60 }), transporterRoutes)");
  });

  test('POST /api/shipments handler books via the service (handler invoked directly)', async () => {
    const logisticsRoutes = require('../routes/logisticsRoutes');
    const layer = logisticsRoutes.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.post);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const req = { user: { id: 'farmer1' }, body: { order_id: 'order1', transporter_id: 'tr1', price_paise: 5000, ...WINDOW } };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].status).toBe('booked');
  });

  test('POST /api/transporters/register handler registers via the service', async () => {
    const transporterRoutes = require('../routes/transporterRoutes');
    const layer = transporterRoutes.stack.find((l) => l.route && l.route.path === '/register');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const req = { user: { id: 'newbie' }, body: { vehicle_type: 'Truck', vehicle_number: 'UP81ZZ1111', service_areas: ['Mathura'], flat_rate_paise: 2000 } };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].transporter.verification_status).toBe('pending');
  });
});
