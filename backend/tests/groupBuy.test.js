'use strict';
/**
 * Smart Group Selling (Stage 5, module D) — migration + backend unit.
 *
 * COORDINATOR SEMANTICS (demand pool): farmers pool quantities of the same
 * crop to buy wholesale AS ONE BUYER. The owner places the pooled order as
 * buyer-representative. Settlement rows record each participant's SHARE OF
 * THE POOLED ORDER TOTAL in integer paise (what they owe toward the pooled
 * order) — never a "payout". Collection/reconciliation is a later stage.
 * No transport is built here (Stage 6) — groupTransport is a null stub.
 *
 * Service functions are tested against the same in-memory Supabase mock
 * pattern as negotiation.test.js (eq/in/is filters, order/range), plus the
 * 23505 duplicate-key simulation from orderCreation.test.js, extended here
 * to group_buy_participants (group_buy_id, user_id) and group_settlements
 * (group_buy_id, participant_id).
 *
 * Hand-checked literals (NOT derived from the code):
 * - gb1 pools 100 + 200 + 300 = 600 kg of Wheat (threshold 100).
 * - Direct close buys prod2 (farmer2's Wheat, 2300/kg, stock 5000):
 *   order total 600 * 2300 = 1,380,000 rupees = 138,000,000 paise.
 *   Settlements: 100/600 -> 23,000,000; 200/600 -> 46,000,000;
 *   300/600 -> 69,000,000 paise. Sum is exactly 138,000,000.
 * - Remainder split: 100 paise across 1:1:1 -> 34/33/33 (first by
 *   created_at gets the extra paise). Realistic split: 100,000 paise
 *   across 100:200:300 kg -> 16667/33333/50000 (16666.67 rounds up by
 *   largest remainder). Both sum exactly to the total.
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
      if (q.table === 'group_buy_participants' && table.some(
        (r) => r.group_buy_id === q.row.group_buy_id && r.user_id === q.row.user_id,
      )) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "group_buy_participants_group_buy_id_user_id_key"' } };
      }
      if (q.table === 'group_settlements' && table.some(
        (r) => r.group_buy_id === q.row.group_buy_id && r.participant_id === q.row.participant_id,
      )) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "group_settlements_group_buy_id_participant_id_key"' } };
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
      { id: 'farmer1', first_name: 'Suresh', last_name: 'Singh', phone_number: '8888888888', role: 'farmer', verification_status: 'verified' },
      { id: 'farmer2', first_name: 'Meena', last_name: 'Devi', phone_number: '6666666666', role: 'farmer', verification_status: 'verified' },
      { id: 'farmer3', first_name: 'Arjun', last_name: 'Patel', phone_number: '5555555555', role: 'farmer', verification_status: 'verified' },
      { id: 'farmer4', first_name: 'Kiran', last_name: 'Yadav', phone_number: '4444444444', role: 'farmer', verification_status: 'verified' },
      { id: 'buyer1', first_name: 'Ramesh', last_name: 'Kumar', phone_number: '9999999999', role: 'buyer', verification_status: 'unverified' },
      { id: 'admin1', first_name: 'Admin', last_name: 'User', phone_number: null, role: 'admin', verification_status: 'verified' },
    ],
    products: [
      { id: 'prod1', farmer_id: 'farmer1', name: 'Wheat', user_price: 2200, price: 2200, quantity: 500 },
      { id: 'prod2', farmer_id: 'farmer2', name: 'Wheat', user_price: 2300, price: 2300, quantity: 5000 },
      { id: 'prod3', farmer_id: 'farmer1', name: 'Rice', user_price: 3000, price: 3000, quantity: 100 },
    ],
    group_buys: [
      {
        id: 'gb1', owner_id: 'farmer1', crop: 'Wheat', threshold_quantity: 100, unit: 'kg',
        deadline: '2027-01-01T00:00:00.000Z', status: 'open', requirement_id: null, order_id: null,
        closed_at: null, created_at: '2026-11-12T00:00:00.000Z', updated_at: '2026-11-12T00:00:00.000Z',
      },
      {
        id: 'gb2', owner_id: 'farmer1', crop: 'Rice', threshold_quantity: 500, unit: 'kg',
        deadline: '2027-01-01T00:00:00.000Z', status: 'open', requirement_id: null, order_id: null,
        closed_at: null, created_at: '2026-11-12T00:00:00.000Z', updated_at: '2026-11-12T00:00:00.000Z',
      },
      {
        id: 'gb3', owner_id: 'farmer2', crop: 'Wheat', threshold_quantity: 500, unit: 'kg',
        deadline: '2020-01-01T00:00:00.000Z', status: 'open', requirement_id: null, order_id: null,
        closed_at: null, created_at: '2026-11-12T00:00:00.000Z', updated_at: '2026-11-12T00:00:00.000Z',
      },
      {
        id: 'gb-closed', owner_id: 'farmer1', crop: 'Wheat', threshold_quantity: 100, unit: 'kg',
        deadline: '2027-01-01T00:00:00.000Z', status: 'closed', requirement_id: null, order_id: 'order-closed',
        closed_at: '2026-11-12T01:00:00.000Z', created_at: '2026-11-12T00:00:00.000Z', updated_at: '2026-11-12T01:00:00.000Z',
      },
    ],
    group_buy_participants: [
      { id: 'p1', group_buy_id: 'gb1', user_id: 'farmer1', contribution_quantity: 100, share: null, created_at: '2026-11-12T00:00:01.000Z' },
      { id: 'p2', group_buy_id: 'gb1', user_id: 'farmer2', contribution_quantity: 200, share: null, created_at: '2026-11-12T00:00:02.000Z' },
      { id: 'p3', group_buy_id: 'gb1', user_id: 'farmer3', contribution_quantity: 300, share: null, created_at: '2026-11-12T00:00:03.000Z' },
      { id: 'p4', group_buy_id: 'gb2', user_id: 'farmer2', contribution_quantity: 50, share: null, created_at: '2026-11-12T00:00:01.000Z' },
      { id: 'p5', group_buy_id: 'gb3', user_id: 'farmer2', contribution_quantity: 50, share: null, created_at: '2026-11-12T00:00:01.000Z' },
      { id: 'pc1', group_buy_id: 'gb-closed', user_id: 'farmer1', contribution_quantity: 100, share: 0.3333333333333333, created_at: '2026-11-12T00:00:01.000Z' },
      { id: 'pc2', group_buy_id: 'gb-closed', user_id: 'farmer2', contribution_quantity: 200, share: 0.6666666666666666, created_at: '2026-11-12T00:00:02.000Z' },
    ],
    group_settlements: [
      { id: 'sc1', group_buy_id: 'gb-closed', participant_id: 'pc1', user_id: 'farmer1', amount_paise: 23000000, status: 'pending', created_at: '2026-11-12T01:00:00.000Z' },
      { id: 'sc2', group_buy_id: 'gb-closed', participant_id: 'pc2', user_id: 'farmer2', amount_paise: 46000000, status: 'pending', created_at: '2026-11-12T01:00:00.000Z' },
    ],
    requirements: [],
    offers: [],
    agreements: [],
    orders: [
      {
        id: 'order-closed', buyer_id: 'farmer1', farmer_id: 'farmer2', product_id: 'prod2',
        quantity: 300, unit_at_order: 'kg', total_price: 690000, price_at_order: 2300,
        status: 'PENDING', delivery_address: 'Village X, Mathura', buyer_phone: '8888888888',
        farmer_name: 'Meena Devi', farmer_phone: '6666666666',
      },
    ],
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
  return { db, service: require('../services/groupBuyService') };
}

const VALID_GROUP = {
  crop: 'Wheat',
  threshold_quantity: 100,
  deadline: '2027-06-01T00:00:00.000Z',
  unit: 'kg',
};

const VALID_NEGOTIATE = {
  target_price: 2000,
  delivery_window_start: '2027-02-01',
  delivery_window_end: '2027-02-10',
  quality: 'A grade',
};

const CLOSE_BODY = { product_id: 'prod2', delivery_address: 'Village X, Mathura' };

describe('groupSettlementService.splitPayment (pure)', () => {
  test('remainder case: 100 paise across 1:1:1 splits 34/33/33 and sums exactly', () => {
    const { splitPayment } = require('../services/groupSettlementService');
    const parts = splitPayment(100, [
      { participant_id: 'a', contribution_quantity: 1, created_at: '2026-11-12T00:00:01.000Z', id: 'a' },
      { participant_id: 'b', contribution_quantity: 1, created_at: '2026-11-12T00:00:02.000Z', id: 'b' },
      { participant_id: 'c', contribution_quantity: 1, created_at: '2026-11-12T00:00:03.000Z', id: 'c' },
    ]);
    expect(parts.map((p) => p.amount_paise)).toEqual([34, 33, 33]);
    expect(parts.reduce((sum, p) => sum + p.amount_paise, 0)).toBe(100);
  });

  test('realistic case: 100000 paise across 100:200:300 splits 16667/33333/50000', () => {
    const { splitPayment } = require('../services/groupSettlementService');
    const parts = splitPayment(100000, [
      { participant_id: 'a', contribution_quantity: 100, created_at: '2026-11-12T00:00:01.000Z', id: 'a' },
      { participant_id: 'b', contribution_quantity: 200, created_at: '2026-11-12T00:00:02.000Z', id: 'b' },
      { participant_id: 'c', contribution_quantity: 300, created_at: '2026-11-12T00:00:03.000Z', id: 'c' },
    ]);
    expect(parts.map((p) => p.amount_paise)).toEqual([16667, 33333, 50000]);
    expect(parts.reduce((sum, p) => sum + p.amount_paise, 0)).toBe(100000);
  });

  test('a single participant takes the whole total; empty contributions are a 422', () => {
    const { splitPayment } = require('../services/groupSettlementService');
    const parts = splitPayment(5000, [
      { participant_id: 'a', contribution_quantity: 10, created_at: '2026-11-12T00:00:01.000Z', id: 'a' },
    ]);
    expect(parts).toEqual([{ participant_id: 'a', amount_paise: 5000 }]);
    expect(() => splitPayment(100, [])).toThrow(expect.objectContaining({ status: 422, code: 'VALIDATION_ERROR' }));
    expect(() => splitPayment(-5, [{ participant_id: 'a', contribution_quantity: 1, created_at: '2026-11-12T00:00:01.000Z', id: 'a' }]))
      .toThrow(expect.objectContaining({ status: 422, code: 'VALIDATION_ERROR' }));
  });
});

describe('groupSettlementService.createSettlements', () => {
  test('inserts exactly one row per participant and the amounts sum exactly (16667/33333/50000)', async () => {
    const { db } = setup();
    const { createSettlements } = require('../services/groupSettlementService');
    const participants = [
      { id: 'p1', user_id: 'farmer1', contribution_quantity: 100, created_at: '2026-11-12T00:00:01.000Z' },
      { id: 'p2', user_id: 'farmer2', contribution_quantity: 200, created_at: '2026-11-12T00:00:02.000Z' },
      { id: 'p3', user_id: 'farmer3', contribution_quantity: 300, created_at: '2026-11-12T00:00:03.000Z' },
    ];
    const rows = await createSettlements('gb1', 100000, participants);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.amount_paise).sort((a, b) => a - b)).toEqual([16667, 33333, 50000]);
    expect(db.group_settlements.filter((s) => s.group_buy_id === 'gb1')).toHaveLength(3);
    expect(db.group_settlements.filter((s) => s.group_buy_id === 'gb1')
      .reduce((sum, s) => sum + s.amount_paise, 0)).toBe(100000);
    expect(db.group_settlements.filter((s) => s.group_buy_id === 'gb1')
      .every((s) => s.status === 'pending')).toBe(true);
    // ONE summary audit event, not one per participant.
    const settlementEvents = db.audit_log.filter((a) => a.event === 'settlement.created');
    expect(settlementEvents).toHaveLength(1);
    expect(settlementEvents[0].details).toMatchObject({ participant_count: 3, total_paise: 100000 });
  });

  test('a 23505 duplicate re-reads instead of duplicating rows', async () => {
    const { db } = setup();
    const { createSettlements } = require('../services/groupSettlementService');
    const participants = [
      { id: 'pc1', user_id: 'farmer1', contribution_quantity: 100, created_at: '2026-11-12T00:00:01.000Z' },
      { id: 'pc2', user_id: 'farmer2', contribution_quantity: 200, created_at: '2026-11-12T00:00:02.000Z' },
    ];
    const rows = await createSettlements('gb-closed', 69000000, participants);
    expect(rows).toHaveLength(2);
    expect(db.group_settlements.filter((s) => s.group_buy_id === 'gb-closed')).toHaveLength(2);
  });
});

describe('groupBuyService.createGroup', () => {
  test('happy path stores the group open with zero totals and audits it', async () => {
    const { db, service } = setup();
    const row = await service.createGroup('farmer1', { ...VALID_GROUP });
    expect(row.owner_id).toBe('farmer1');
    expect(row.crop).toBe('Wheat');
    expect(row.status).toBe('open');
    expect(row.total_quantity).toBe(0);
    expect(row.participant_count).toBe(0);
    expect(db.group_buys).toHaveLength(5);
    expect(db.audit_log).toHaveLength(1);
    expect(db.audit_log[0]).toMatchObject({ event: 'group_buy.created', actor_id: 'farmer1' });
  });

  test('a past deadline, a non-positive threshold and a bad unit are 422s', async () => {
    const { db, service } = setup();
    await expect(service.createGroup('farmer1', { ...VALID_GROUP, deadline: '2020-01-01T00:00:00.000Z' }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createGroup('farmer1', { ...VALID_GROUP, threshold_quantity: 0 }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createGroup('farmer1', { ...VALID_GROUP, unit: 'tonne' }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.createGroup('farmer1', { ...VALID_GROUP, crop: '  ' }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    expect(db.group_buys).toHaveLength(4);
  });

  test('unit defaults to kg', async () => {
    const { service } = setup();
    const { unit: _unit, ...noUnit } = VALID_GROUP;
    const row = await service.createGroup('farmer1', noUnit);
    expect(row.unit).toBe('kg');
  });
});

describe('groupBuyService.listGroups / getGroupDetail', () => {
  test('default list shows open groups newest first, each with totals', async () => {
    const { service } = setup();
    const { group_buys } = await service.listGroups('farmer1', {});
    expect(group_buys.map((g) => g.id)).toEqual(['gb1', 'gb2', 'gb3']);
    const gb1 = group_buys.find((g) => g.id === 'gb1');
    expect(gb1.total_quantity).toBe(600);
    expect(gb1.participant_count).toBe(3);
    expect(group_buys.find((g) => g.id === 'gb2').total_quantity).toBe(50);
  });

  test('status=closed lists only closed groups; status=mine lists owned or joined groups', async () => {
    const { service } = setup();
    const closed = await service.listGroups('farmer1', { status: 'closed' });
    expect(closed.group_buys.map((g) => g.id)).toEqual(['gb-closed']);
    // farmer2 owns gb3 and joined gb1, gb2 and gb-closed — 'mine' is
    // owned-or-joined (the "My groups" tab), not owner-only.
    const mine = await service.listGroups('farmer2', { status: 'mine' });
    expect(mine.group_buys.map((g) => g.id)).toEqual(['gb1', 'gb2', 'gb3', 'gb-closed']);
    await expect(service.listGroups('farmer1', { status: 'bogus' }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
  });

  test('status=all lists open and closed groups', async () => {
    const { service } = setup();
    const all = await service.listGroups('farmer1', { status: 'all' });
    expect(all.group_buys.map((g) => g.id)).toEqual(['gb1', 'gb2', 'gb3', 'gb-closed']);
  });

  test('detail returns the group, its participants in join order, the total and transport null', async () => {
    const { service } = setup();
    const detail = await service.getGroupDetail('buyer1', 'gb1');
    expect(detail.group_buy.id).toBe('gb1');
    expect(detail.total_quantity).toBe(600);
    expect(detail.transport).toBeNull();
    expect(detail.participants.map((p) => p.user_id)).toEqual(['farmer1', 'farmer2', 'farmer3']);
    expect(detail.participants[0]).toMatchObject({ id: 'p1', contribution_quantity: 100 });
    await expect(service.getGroupDetail('buyer1', 'ghost'))
      .rejects.toMatchObject({ status: 404, code: 'GROUP_BUY_NOT_FOUND' });
  });
});

describe('groupBuyService.joinGroup', () => {
  test('joining adds the participant row and audits it', async () => {
    const { db, service } = setup();
    const row = await service.joinGroup('farmer3', 'gb2', { contribution_quantity: 75 });
    expect(row.group_buy_id).toBe('gb2');
    expect(row.user_id).toBe('farmer3');
    expect(row.contribution_quantity).toBe(75);
    expect(db.group_buy_participants.filter((p) => p.group_buy_id === 'gb2')).toHaveLength(2);
    expect(db.audit_log).toHaveLength(1);
    expect(db.audit_log[0]).toMatchObject({ event: 'group_buy.joined', actor_id: 'farmer3' });
  });

  test('joining twice is impossible — the second join is a 409 via the UNIQUE backstop', async () => {
    const { db, service } = setup();
    await service.joinGroup('farmer3', 'gb2', { contribution_quantity: 75 });
    await expect(service.joinGroup('farmer3', 'gb2', { contribution_quantity: 25 }))
      .rejects.toMatchObject({ status: 409, code: 'GROUP_ALREADY_JOINED' });
    expect(db.group_buy_participants.filter((p) => p.group_buy_id === 'gb2')).toHaveLength(2);
  });

  test('joining a closed group is a 409 and joining past the deadline is a 409', async () => {
    const { service } = setup();
    await expect(service.joinGroup('farmer3', 'gb-closed', { contribution_quantity: 10 }))
      .rejects.toMatchObject({ status: 409, code: 'GROUP_NOT_OPEN' });
    await expect(service.joinGroup('farmer3', 'gb3', { contribution_quantity: 10 }))
      .rejects.toMatchObject({ status: 409, code: 'GROUP_DEADLINE_PASSED' });
  });

  test('a non-positive contribution and a missing group are rejected', async () => {
    const { service } = setup();
    await expect(service.joinGroup('farmer3', 'gb1', { contribution_quantity: 0 }))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.joinGroup('farmer3', 'ghost', { contribution_quantity: 10 }))
      .rejects.toMatchObject({ status: 404, code: 'GROUP_BUY_NOT_FOUND' });
  });
});

describe('groupBuyService.negotiateAsGroup', () => {
  test('creates a Stage 4 requirement with quantity = pooled total and group_buy_id set', async () => {
    const { db, service } = setup();
    const { requirement } = await service.negotiateAsGroup('farmer1', 'gb1', { ...VALID_NEGOTIATE });
    expect(requirement.crop).toBe('Wheat');
    expect(requirement.quantity).toBe(600);
    expect(requirement.group_buy_id).toBe('gb1');
    expect(requirement.status).toBe('open');
    expect(db.group_buys.find((g) => g.id === 'gb1').requirement_id).toBe(requirement.id);
    expect(db.audit_log.map((a) => a.event)).toContain('group_buy.negotiated');
  });

  test('a second negotiate is a 409 and negotiating below threshold is a 409', async () => {
    const { service } = setup();
    await service.negotiateAsGroup('farmer1', 'gb1', { ...VALID_NEGOTIATE });
    await expect(service.negotiateAsGroup('farmer1', 'gb1', { ...VALID_NEGOTIATE }))
      .rejects.toMatchObject({ status: 409, code: 'GROUP_REQUIREMENT_EXISTS' });
    await expect(service.negotiateAsGroup('farmer1', 'gb2', { ...VALID_NEGOTIATE }))
      .rejects.toMatchObject({ status: 409, code: 'GROUP_THRESHOLD_NOT_MET' });
  });

  test('only the owner can negotiate', async () => {
    const { service } = setup();
    await expect(service.negotiateAsGroup('farmer2', 'gb1', { ...VALID_NEGOTIATE }))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });
});

describe('negotiationService group-requirement offer guard (Stage 5 extension)', () => {
  test('an offer on a group requirement with the wrong quantity is a 422', async () => {
    const { db, service } = setup();
    const { requirement } = await service.negotiateAsGroup('farmer1', 'gb1', { ...VALID_NEGOTIATE });
    const negotiation = require('../services/negotiationService');
    await expect(negotiation.createOffer('farmer2', requirement.id, {
      product_id: 'prod2', price: 2300, quantity: 500, expires_at: '2027-01-15T00:00:00.000Z',
    })).rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    expect(db.offers).toHaveLength(0);
  });

  test('an offer matching the pooled total is accepted', async () => {
    const { db, service } = setup();
    const { requirement } = await service.negotiateAsGroup('farmer1', 'gb1', { ...VALID_NEGOTIATE });
    const negotiation = require('../services/negotiationService');
    const offer = await negotiation.createOffer('farmer2', requirement.id, {
      product_id: 'prod2', price: 2300, quantity: 600, expires_at: '2027-01-15T00:00:00.000Z',
    });
    expect(offer.requirement_id).toBe(requirement.id);
    expect(offer.quantity).toBe(600);
    expect(db.offers).toHaveLength(1);
  });
});

describe('groupBuyService.closeGroup — direct path', () => {
  test('closing a threshold-met group creates exactly one pooled order + one settlement per participant (literals 1380000 / 138000000)', async () => {
    const { db, service } = setup();
    const result = await service.closeGroup('farmer1', 'gb1', { ...CLOSE_BODY }, undefined);
    expect(db.orders.filter((o) => o.buyer_id === 'farmer1' && o.product_id === 'prod2' && o.quantity === 600)).toHaveLength(1);
    expect(db.orders).toHaveLength(2); // seed order-closed + this one pooled order
    const order = result.order;
    expect(order.quantity).toBe(600);
    expect(order.total_price).toBe(1380000);
    expect(order.price_at_order).toBe(2300);
    expect(result.group_buy.status).toBe('closed');
    expect(result.group_buy.order_id).toBe(order.id);
    expect(result.settlements).toHaveLength(3);
    expect(result.settlements.map((s) => s.amount_paise).sort((a, b) => a - b))
      .toEqual([23000000, 46000000, 69000000]);
    expect(result.settlements.reduce((sum, s) => sum + s.amount_paise, 0)).toBe(138000000);
    expect(db.group_settlements.filter((s) => s.group_buy_id === 'gb1')).toHaveLength(3);
    // Shares are stored on the participant rows at close.
    expect(db.group_buy_participants.find((p) => p.id === 'p1').share).toBeCloseTo(100 / 600);
    expect(db.group_buy_participants.find((p) => p.id === 'p3').share).toBe(0.5);
    expect(db.audit_log.map((a) => a.event)).toContain('group_buy.closed');
    // The settlement summary event is attributed to the owner who closed.
    expect(db.audit_log.find((a) => a.event === 'settlement.created')).toMatchObject({ actor_id: 'farmer1' });
  });

  test('a locked unit_price overrides the listing price at close', async () => {
    const { db, service } = setup();
    const result = await service.closeGroup('farmer1', 'gb1', { ...CLOSE_BODY, unit_price: 2000 }, undefined);
    expect(result.order.price_at_order).toBe(2000);
    expect(result.order.total_price).toBe(1200000);
    expect(result.settlements.reduce((sum, s) => sum + s.amount_paise, 0)).toBe(120000000);
    expect(db.orders).toHaveLength(2); // seed order-closed + this one
  });

  test('a group below threshold at deadline cannot close (past deadline + total < threshold)', async () => {
    const { db, service } = setup();
    await expect(service.closeGroup('farmer2', 'gb3', { ...CLOSE_BODY }, undefined))
      .rejects.toMatchObject({ status: 409, code: 'GROUP_THRESHOLD_NOT_MET' });
    await expect(service.closeGroup('farmer1', 'gb2', { ...CLOSE_BODY }, undefined))
      .rejects.toMatchObject({ status: 409, code: 'GROUP_THRESHOLD_NOT_MET' });
    expect(db.orders).toHaveLength(1);
    expect(db.group_settlements).toHaveLength(2);
  });

  test('only the owner can close — a non-owner gets 403 and nothing is created', async () => {
    const { db, service } = setup();
    await expect(service.closeGroup('farmer2', 'gb1', { ...CLOSE_BODY }, undefined))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(db.orders).toHaveLength(1);
    expect(db.group_settlements).toHaveLength(2);
    expect(db.group_buys.find((g) => g.id === 'gb1').status).toBe('open');
  });

  test('a second close with a different key is a 409 and creates nothing new', async () => {
    const { db, service } = setup();
    await service.closeGroup('farmer1', 'gb1', { ...CLOSE_BODY }, undefined);
    await expect(service.closeGroup('farmer1', 'gb1', { ...CLOSE_BODY }, 'some-other-key'))
      .rejects.toMatchObject({ status: 409, code: 'GROUP_ALREADY_CLOSED' });
    expect(db.orders).toHaveLength(2);
    expect(db.group_settlements.filter((s) => s.group_buy_id === 'gb1')).toHaveLength(3);
  });

  test('a second close with the same derived key replays the order + settlements with zero new rows', async () => {
    const { db, service } = setup();
    const first = await service.closeGroup('farmer1', 'gb1', { ...CLOSE_BODY }, undefined);
    const second = await service.closeGroup('farmer1', 'gb1', { ...CLOSE_BODY }, 'group-buy-close-gb1');
    expect(second.order.id).toBe(first.order.id);
    expect(second.settlements).toHaveLength(3);
    expect(db.orders).toHaveLength(2);
    expect(db.group_settlements.filter((s) => s.group_buy_id === 'gb1')).toHaveLength(3);
  });
});

describe('groupBuyService.closeGroup — negotiated path', () => {
  test('an accepted group requirement reuses its order — no second order is created', async () => {
    const { db, service } = setup();
    const negotiation = require('../services/negotiationService');
    const { requirement } = await service.negotiateAsGroup('farmer1', 'gb1', { ...VALID_NEGOTIATE });
    const offer = await negotiation.createOffer('farmer2', requirement.id, {
      product_id: 'prod2', price: 2300, quantity: 600, expires_at: '2027-01-15T00:00:00.000Z',
    });
    const { order } = await negotiation.acceptOffer('farmer1', offer.id, { delivery_address: 'Village X, Mathura' });
    expect(order.total_price).toBe(1380000);
    const result = await service.closeGroup('farmer1', 'gb1', {}, undefined);
    expect(result.order.id).toBe(order.id);
    expect(db.orders).toHaveLength(2); // seed order-closed + the accepted order
    expect(result.settlements).toHaveLength(3);
    expect(result.settlements.reduce((sum, s) => sum + s.amount_paise, 0)).toBe(138000000);
    expect(result.group_buy.status).toBe('closed');
    expect(result.group_buy.order_id).toBe(order.id);
  });

  test('a requirement with no agreement yet and no product_id is a 409 GROUP_NEGOTIATION_PENDING', async () => {
    const { db, service } = setup();
    await service.negotiateAsGroup('farmer1', 'gb1', { ...VALID_NEGOTIATE });
    await expect(service.closeGroup('farmer1', 'gb1', {}, undefined))
      .rejects.toMatchObject({ status: 409, code: 'GROUP_NEGOTIATION_PENDING' });
    expect(db.orders).toHaveLength(1);
    expect(db.group_buys.find((g) => g.id === 'gb1').status).toBe('open');
  });

  test('a pending requirement with a product_id closes via the direct path instead', async () => {
    const { db, service } = setup();
    await service.negotiateAsGroup('farmer1', 'gb1', { ...VALID_NEGOTIATE });
    const result = await service.closeGroup('farmer1', 'gb1', { ...CLOSE_BODY }, undefined);
    expect(result.order.total_price).toBe(1380000);
    expect(result.settlements).toHaveLength(3);
    expect(result.group_buy.status).toBe('closed');
    expect(db.orders).toHaveLength(2); // seed order-closed + this direct order
  });

  test('an order whose quantity no longer matches the pooled total is a 409 GROUP_ORDER_MISMATCH', async () => {
    const { db, service } = setup();
    const negotiation = require('../services/negotiationService');
    const { requirement } = await service.negotiateAsGroup('farmer1', 'gb1', { ...VALID_NEGOTIATE });
    const offer = await negotiation.createOffer('farmer2', requirement.id, {
      product_id: 'prod2', price: 2300, quantity: 600, expires_at: '2027-01-15T00:00:00.000Z',
    });
    await negotiation.acceptOffer('farmer1', offer.id, { delivery_address: 'Village X, Mathura' });
    // A fourth farmer joins after the offer locked 600 kg — the pool is now 700.
    db.group_buy_participants.push({
      id: 'p-late', group_buy_id: 'gb1', user_id: 'farmer4',
      contribution_quantity: 100, share: null, created_at: '2026-11-12T00:00:04.000Z',
    });
    await expect(service.closeGroup('farmer1', 'gb1', {}, undefined))
      .rejects.toMatchObject({ status: 409, code: 'GROUP_ORDER_MISMATCH' });
    expect(db.group_buys.find((g) => g.id === 'gb1').status).toBe('open');
  });
});

describe('groupBuyService.getSettlement', () => {
  test('owner reads the settlement: order total in paise + one row per participant', async () => {
    const { service } = setup();
    const result = await service.getSettlement('farmer1', 'gb-closed');
    expect(result.group_buy_id).toBe('gb-closed');
    expect(result.order_id).toBe('order-closed');
    expect(result.total_paise).toBe(69000000);
    expect(result.settlements.map((s) => s.amount_paise).sort((a, b) => a - b))
      .toEqual([23000000, 46000000]);
    expect(result.settlements[0]).toHaveProperty('contribution_quantity');
    expect(result.settlements[0]).toHaveProperty('share');
  });

  test('a participant and an admin can read it; a non-participant gets the generic 404', async () => {
    const { service } = setup();
    const asParticipant = await service.getSettlement('farmer2', 'gb-closed');
    expect(asParticipant.settlements).toHaveLength(2);
    const asAdmin = await service.getSettlement('admin1', 'gb-closed');
    expect(asAdmin.settlements).toHaveLength(2);
    await expect(service.getSettlement('farmer3', 'gb-closed'))
      .rejects.toMatchObject({ status: 404, code: 'GROUP_BUY_NOT_FOUND' });
    await expect(service.getSettlement('buyer1', 'gb-closed'))
      .rejects.toMatchObject({ status: 404, code: 'GROUP_BUY_NOT_FOUND' });
    await expect(service.getSettlement('farmer1', 'ghost'))
      .rejects.toMatchObject({ status: 404, code: 'GROUP_BUY_NOT_FOUND' });
  });
});

describe('migration 20261120_group_selling.sql (file-level guard)', () => {
  test('defines the three tables, the requirements link, RLS and the trigger backstops', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', '..', 'supabase', 'migrations', '20261120_group_selling.sql'),
      'utf8',
    );
    for (const table of ['public.group_buys', 'public.group_buy_participants', 'public.group_settlements']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain('UNIQUE(group_buy_id, user_id)');
    expect(sql).toContain('UNIQUE(group_buy_id, participant_id)');
    expect(sql).toContain('ALTER TABLE public.requirements ADD COLUMN group_buy_id');
    expect(sql).toContain('ROW LEVEL SECURITY');
    expect(sql).toContain('is_admin()');
    expect(sql).toContain('group_buy_participants_group_buy_id_idx');
    expect(sql).toContain('group_settlements_group_buy_id_idx');
    expect(sql).toContain('prevent_group_participant_change_when_closed');
    expect(sql).toContain('prevent_closed_group_buy_edit');
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

  test('the router exposes exactly the seven group-buy routes', () => {
    const routes = require('../routes/groupBuyRoutes');
    expect(routeList(routes)).toEqual([
      'GET /',
      'GET /:id',
      'GET /:id/settlement',
      'POST /',
      'POST /:id/close',
      'POST /:id/join',
      'POST /:id/negotiate',
    ].sort());
  });

  test('POST / sits behind requireAuth and the farmer role', async () => {
    const routes = require('../routes/groupBuyRoutes');
    const layer = findRoute(routes, 'POST', '/');
    expect(layer.route.stack).toHaveLength(3);
    const [authLayer, farmerLayer] = layer.route.stack;
    const nextAuth = jest.fn();
    await authLayer.handle({ headers: {} }, {}, nextAuth);
    expect(nextAuth.mock.calls[0][0]).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    const nextRole = jest.fn();
    await farmerLayer.handle({ user: { id: 'buyer1' } }, {}, nextRole);
    expect(nextRole.mock.calls[0][0]).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    const nextFarmer = jest.fn();
    await farmerLayer.handle({ user: { id: 'farmer1' } }, {}, nextFarmer);
    expect(nextFarmer).toHaveBeenCalledWith();
  });

  test('join, negotiate and close sit behind requireAuth and the farmer role; reads behind auth only', () => {
    const routes = require('../routes/groupBuyRoutes');
    for (const [method, routePath] of [['POST', '/:id/join'], ['POST', '/:id/negotiate'], ['POST', '/:id/close']]) {
      expect(findRoute(routes, method, routePath).route.stack).toHaveLength(3);
    }
    for (const [method, routePath] of [['GET', '/'], ['GET', '/:id'], ['GET', '/:id/settlement']]) {
      expect(findRoute(routes, method, routePath).route.stack).toHaveLength(2);
    }
  });

  test('POST / handler creates the group and answers 201', async () => {
    const { db } = setup();
    const routes = require('../routes/groupBuyRoutes');
    const layer = findRoute(routes, 'POST', '/');
    const handler = layer.route.stack[2].handle;
    const req = { user: { id: 'farmer1' }, body: { ...VALID_GROUP } };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ crop: 'Wheat', status: 'open' }));
    expect(db.group_buys).toHaveLength(5);
  });

  test('GET /:id handler answers 200 with transport null', async () => {
    setup();
    const routes = require('../routes/groupBuyRoutes');
    const layer = findRoute(routes, 'GET', '/:id');
    const handler = layer.route.stack[1].handle;
    const req = { user: { id: 'buyer1' }, params: { id: 'gb1' } };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      group_buy: expect.objectContaining({ id: 'gb1' }),
      total_quantity: 600,
      transport: null,
    }));
  });

  test('POST /:id/close handler forwards the Idempotency-Key and answers 200', async () => {
    const { db } = setup();
    const routes = require('../routes/groupBuyRoutes');
    const layer = findRoute(routes, 'POST', '/:id/close');
    const handler = layer.route.stack[2].handle;
    const req = {
      user: { id: 'farmer1' },
      params: { id: 'gb1' },
      body: { ...CLOSE_BODY },
      headers: { 'idempotency-key': 'route-close-key' },
    };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      group_buy: expect.objectContaining({ id: 'gb1', status: 'closed' }),
      order: expect.objectContaining({ total_price: 1380000 }),
    }));
    expect(db.orders).toHaveLength(2);
    expect(db.group_settlements.filter((s) => s.group_buy_id === 'gb1')).toHaveLength(3);
  });
});
