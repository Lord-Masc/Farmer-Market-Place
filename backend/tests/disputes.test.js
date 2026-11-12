'use strict';
/**
 * Disputes & Trust Management (Stage 7, module F) — migration + backend unit.
 *
 * Contract under test (Unit B builds the frontend against exactly this):
 * - POST /api/disputes { order_id, category, description } -> 201 { dispute }
 *   (caller must be buyer or farmer of the order, else generic 404;
 *   second OPEN dispute on the same order -> 409).
 * - GET /api/disputes -> { disputes } (own as buyer/farmer; admin all + ?status=).
 * - GET /api/disputes/:id -> { dispute, evidence, messages, shipment }
 *   (evidence carries 5-min signed urls; shipment { id, status } | null).
 * - POST /api/disputes/:id/evidence (multipart, field `file`) -> 201.
 *   Non-image -> 422. Private dispute-evidence bucket.
 * - POST /api/disputes/:id/message { body } -> 201. Resolved -> 409.
 * - POST /api/admin/disputes/:id/status { status } -> 200. Forward-only.
 * - POST /api/admin/disputes/:id/resolve { outcome, amount_paise?, note }
 *   -> 200. Refund reuses the Stage 0 idempotent refund path; partial
 *   refunds the given paise; replacement creates an order with NO payment
 *   row; rejected needs a note.
 * - GET /api/disputes/stats -> real aggregates only; NULL rates when
 *   there is nothing to compute.
 * - POST /api/admin/disputes/check-sla -> { checked, escalated }.
 *
 * Hand-checked literals (NOT derived from the code):
 * - SLA: created_at + 7 days exactly (DISPUTE_SLA_DAYS = 7).
 * - Partial refund: order total_price 500 (rupees) = 50000 paise;
 *   partial 20000 paise -> gateway refund called with 20000, refunds
 *   ledger row amount 200 (rupees, the ledger's unit), order stays
 *   PAID, payment stays HELD.
 * - Full refund: order total_price 500 -> gateway refund 50000 paise,
 *   one refunds row, order REFUNDED, payment REFUNDED; a second
 *   resolve attempt -> 409 AND still exactly one refunds row / one
 *   gateway call.
 * - Stats: 1 resolved of 2, created 2026-11-05T10:00Z resolved
 *   2026-11-06T10:00Z -> resolution_rate 0.5, avg_resolution_hours 24.
 *
 * Route tests invoke the handlers directly — no supertest dependency is
 * added (same as the negotiation/passport suites).
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_mock';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'test-secret';

const mockHolder = { supabase: null, razorpay: null, missingBuckets: new Set(), uploads: [] };

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
        upload: jest.fn(async (innerPath, buffer, opts) => {
          if (mockHolder.missingBuckets.has(bucket)) {
            return { data: null, error: { message: 'Bucket not found' } };
          }
          mockHolder.uploads.push({ bucket, innerPath, bytes: buffer.length, contentType: opts && opts.contentType });
          return { data: { path: innerPath }, error: null };
        }),
        createSignedUrl: jest.fn(async (innerPath, expiresIn) => {
          if (mockHolder.missingBuckets.has(bucket)) {
            return { data: null, error: { message: 'Bucket not found' } };
          }
          return { data: { signedUrl: `https://example.test/signed/${bucket}/${innerPath}?expires=${expiresIn}` }, error: null };
        }),
      }),
    },
  };
}

function seedDb() {
  return {
    profiles: [
      { id: 'buyer1', role: 'buyer', first_name: 'Buyer', last_name: 'One', phone_number: '9999999999' },
      { id: 'buyer2', role: 'buyer', first_name: 'Buyer', last_name: 'Two', phone_number: '8888888888' },
      { id: 'farmer1', role: 'farmer', first_name: 'Farmer', last_name: 'One', phone_number: '7777777777' },
      { id: 'farmer2', role: 'farmer', first_name: 'Farmer', last_name: 'Two', phone_number: '6666666666' },
      { id: 'admin1', role: 'admin', first_name: 'Admin', last_name: 'One', phone_number: null },
    ],
    products: [
      { id: 'prod1', farmer_id: 'farmer1', name: 'Wheat', user_price: 500, price: 500, quantity: 100 },
      { id: 'prod2', farmer_id: 'farmer2', name: 'Rice', user_price: 300, price: 300, quantity: 50 },
    ],
    orders: [
      // total_price is rupees (Stage 0 convention): 500 = 50000 paise.
      { id: 'order1', buyer_id: 'buyer1', farmer_id: 'farmer1', product_id: 'prod1', quantity: 1, unit_at_order: 'kg', total_price: 500, price_at_order: 500, status: 'PAID', delivery_address: 'Mathura', buyer_phone: '9999999999', delivery_deadline: '2026-11-14T00:00:00.000Z', completed_at: null },
      { id: 'order2', buyer_id: 'buyer1', farmer_id: 'farmer1', product_id: 'prod1', quantity: 1, unit_at_order: 'kg', total_price: 500, price_at_order: 500, status: 'PAID', delivery_address: 'Mathura', buyer_phone: '9999999999', delivery_deadline: '2026-11-14T00:00:00.000Z', completed_at: null },
      { id: 'order3', buyer_id: 'buyer1', farmer_id: 'farmer2', product_id: 'prod2', quantity: 2, unit_at_order: 'kg', total_price: 600, price_at_order: 300, status: 'SHIPPED', delivery_address: 'Mathura', buyer_phone: '9999999999', delivery_deadline: '2026-11-14T00:00:00.000Z', completed_at: null },
      { id: 'order4', buyer_id: 'buyer1', farmer_id: 'farmer1', product_id: 'prod1', quantity: 1, unit_at_order: 'kg', total_price: 500, price_at_order: 500, status: 'COMPLETED', delivery_address: 'Mathura', buyer_phone: '9999999999', delivery_deadline: '2026-11-10T00:00:00.000Z', completed_at: '2026-11-09T10:00:00.000Z' },
      { id: 'order5', buyer_id: 'buyer1', farmer_id: 'farmer1', product_id: 'prod1', quantity: 1, unit_at_order: 'kg', total_price: 500, price_at_order: 500, status: 'PENDING', delivery_address: 'Mathura', buyer_phone: '9999999999', delivery_deadline: null, completed_at: null },
    ],
    payments: [
      { id: 'pay1', order_id: 'order1', status: 'HELD', amount: 500, razorpay_payment_id: 'pay_razor1' },
      { id: 'pay2', order_id: 'order2', status: 'HELD', amount: 500, razorpay_payment_id: 'pay_razor2' },
      { id: 'pay3', order_id: 'order3', status: 'HELD', amount: 600, razorpay_payment_id: 'pay_razor3' },
      { id: 'pay4', order_id: 'order4', status: 'RELEASED', amount: 500, razorpay_payment_id: 'pay_razor4' },
    ],
    refunds: [],
    shipments: [
      { id: 'ship1', order_id: 'order3', transporter_id: null, status: 'in_transit' },
    ],
    disputes: [],
    dispute_evidence: [],
    dispute_messages: [],
    audit_log: [],
    idempotency_keys: [],
  };
}

function setupRazorpay() {
  mockHolder.razorpay = {
    payments: {
      refund: jest.fn(async (paymentId, { amount }) => ({ id: `rfnd_${paymentId}`, amount })),
      fetchMultipleRefund: jest.fn(async () => ({ items: [] })),
      fetch: jest.fn(async (id) => ({ id, status: 'captured', amount: 50000 })),
    },
    orders: { fetch: jest.fn(), create: jest.fn(), fetchPayments: jest.fn(async () => ({ items: [] })) },
  };
}

function setup() {
  jest.resetModules();
  const db = seedDb();
  mockHolder.supabase = makeSupabaseMock(db);
  mockHolder.missingBuckets = new Set();
  mockHolder.uploads = [];
  setupRazorpay();
  return { db, service: require('../services/disputeService') };
}

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

function multipartBody(boundary, filename, contentType, bytes) {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

describe('disputeService.fileDispute', () => {
  let service;
  let db;

  beforeEach(() => {
    ({ db, service } = setup());
  });

  test('buyer files a dispute: 201 shape, status filed, SLA exactly +7 days, order embedded', async () => {
    const d = await service.fileDispute('buyer1', { order_id: 'order1', category: 'quality', description: 'Wheat was damp.' });
    expect(d.status).toBe('filed');
    expect(d.category).toBe('quality');
    expect(d.filer_id).toBe('buyer1');
    expect(d.escalated).toBe(false);
    expect(d.resolution).toBe(null);
    expect(d.resolution_amount_paise).toBe(null);
    expect(d.is_overdue).toBe(false);
    expect(new Date(d.sla_deadline).getTime() - new Date(d.created_at).getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(d.order).toEqual({ id: 'order1', product_title: 'Wheat', total_price_paise: 50000 });
    expect(db.disputes).toHaveLength(1);
    // The filing description is the first thread message (no description column by design).
    expect(db.dispute_messages).toHaveLength(1);
    expect(db.dispute_messages[0]).toMatchObject({ dispute_id: d.id, author_id: 'buyer1', body: 'Wheat was damp.' });
    expect(db.audit_log.some((r) => r.event === 'dispute.filed' && r.details.dispute_id === d.id)).toBe(true);
  });

  test('the order farmer can file too', async () => {
    const d = await service.fileDispute('farmer1', { order_id: 'order1', category: 'payment', description: 'Buyer has not confirmed.' });
    expect(d.filer_id).toBe('farmer1');
  });

  test('third party gets the generic 404 (never leaks the order)', async () => {
    await expect(service.fileDispute('buyer2', { order_id: 'order1', category: 'quality', description: 'x' }))
      .rejects.toMatchObject({ status: 404, code: 'DISPUTE_NOT_ACCESSIBLE' });
    await expect(service.fileDispute('farmer2', { order_id: 'order1', category: 'quality', description: 'x' }))
      .rejects.toMatchObject({ status: 404, code: 'DISPUTE_NOT_ACCESSIBLE' });
    await expect(service.fileDispute('buyer1', { order_id: 'nope', category: 'quality', description: 'x' }))
      .rejects.toMatchObject({ status: 404, code: 'DISPUTE_NOT_ACCESSIBLE' });
  });

  test('invalid category or missing description -> 422', async () => {
    await expect(service.fileDispute('buyer1', { order_id: 'order1', category: 'other', description: 'x' }))
      .rejects.toMatchObject({ status: 422 });
    await expect(service.fileDispute('buyer1', { order_id: 'order1', category: 'quality', description: '  ' }))
      .rejects.toMatchObject({ status: 422 });
  });

  test('second OPEN dispute on the same order -> 409', async () => {
    await service.fileDispute('buyer1', { order_id: 'order1', category: 'quality', description: 'first' });
    await expect(service.fileDispute('farmer1', { order_id: 'order1', category: 'quantity', description: 'second' }))
      .rejects.toMatchObject({ status: 409, code: 'DISPUTE_ALREADY_OPEN' });
  });

  test('a new dispute is allowed once the previous one is resolved', async () => {
    const d = await service.fileDispute('buyer1', { order_id: 'order1', category: 'quality', description: 'first' });
    await service.resolveDispute('admin1', d.id, { outcome: 'rejected', note: 'No fault found.' });
    const d2 = await service.fileDispute('buyer1', { order_id: 'order1', category: 'quantity', description: 'second' });
    expect(d2.status).toBe('filed');
    expect(db.disputes).toHaveLength(2);
  });
});

describe('disputeService.listDisputes + getDisputeDetail', () => {
  let service;

  beforeEach(async () => {
    ({ service } = setup());
    await service.fileDispute('buyer1', { order_id: 'order1', category: 'quality', description: 'd1' });
    await service.fileDispute('buyer1', { order_id: 'order3', category: 'non_delivery', description: 'd3' });
  });

  test('buyer sees only their own disputes; farmer sees only theirs', async () => {
    const mine = await service.listDisputes('buyer1', {});
    expect(mine.disputes).toHaveLength(2);
    const farmer1 = await service.listDisputes('farmer1', {});
    expect(farmer1.disputes).toHaveLength(1);
    expect(farmer1.disputes[0].order_id).toBe('order1');
    const farmer2 = await service.listDisputes('farmer2', {});
    expect(farmer2.disputes).toHaveLength(1);
    expect(farmer2.disputes[0].order_id).toBe('order3');
    const outsider = await service.listDisputes('buyer2', {});
    expect(outsider.disputes).toHaveLength(0);
  });

  test('admin sees all, with ?status= filter', async () => {
    const all = await service.listDisputes('admin1', {});
    expect(all.disputes).toHaveLength(2);
    await service.updateStatus('admin1', all.disputes[0].id, 'under_review');
    const filtered = await service.listDisputes('admin1', { status: 'filed' });
    expect(filtered.disputes).toHaveLength(1);
    expect(filtered.disputes[0].status).toBe('filed');
  });

  test('detail carries evidence signed urls, messages and the shipment when the order has one', async () => {
    const listed = await service.listDisputes('buyer1', {});
    const d3 = listed.disputes.find((d) => d.order_id === 'order3');
    const detail = await service.getDisputeDetail('buyer1', d3.id);
    expect(detail.dispute.id).toBe(d3.id);
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0].body).toBe('d3');
    expect(detail.shipment).toEqual({ id: 'ship1', status: 'in_transit' });
    expect(detail.evidence).toEqual([]);
    const d1 = listed.disputes.find((d) => d.order_id === 'order1');
    const detail1 = await service.getDisputeDetail('farmer1', d1.id);
    expect(detail1.shipment).toBe(null);
  });

  test('detail carries the filing description on the dispute (first thread message)', async () => {
    const listed = await service.listDisputes('buyer1', {});
    const d3 = listed.disputes.find((d) => d.order_id === 'order3');
    const detail = await service.getDisputeDetail('buyer1', d3.id);
    expect(detail.dispute.description).toBe('d3');
  });

  test('non-party gets the generic 404 on detail', async () => {
    const listed = await service.listDisputes('buyer1', {});
    await expect(service.getDisputeDetail('buyer2', listed.disputes[0].id))
      .rejects.toMatchObject({ status: 404, code: 'DISPUTE_NOT_ACCESSIBLE' });
    await expect(service.getDisputeDetail('buyer1', 'nope'))
      .rejects.toMatchObject({ status: 404, code: 'DISPUTE_NOT_ACCESSIBLE' });
  });
});

describe('disputeService evidence + messages', () => {
  let service;
  let db;
  let disputeId;

  beforeEach(async () => {
    ({ db, service } = setup());
    const d = await service.fileDispute('buyer1', { order_id: 'order1', category: 'quality', description: 'damp' });
    disputeId = d.id;
  });

  test('valid PNG evidence -> 201, stored under the private dispute-evidence bucket', async () => {
    const out = await service.addEvidence('farmer1', disputeId, { buffer: PNG_BYTES, mime: 'image/png', filename: 'photo.png' });
    expect(out.evidence.storage_path.startsWith('dispute-evidence/')).toBe(true);
    expect(mockHolder.uploads).toHaveLength(1);
    expect(mockHolder.uploads[0]).toMatchObject({ bucket: 'dispute-evidence', contentType: 'image/png' });
    expect(db.dispute_evidence).toHaveLength(1);
    const detail = await service.getDisputeDetail('buyer1', disputeId);
    expect(detail.evidence).toHaveLength(1);
    expect(detail.evidence[0].url).toContain('/signed/dispute-evidence/');
    expect(detail.evidence[0].url).toContain('expires=300');
  });

  test('non-image payloads -> 422 (txt and html)', async () => {
    await expect(service.addEvidence('buyer1', disputeId, { buffer: Buffer.from('hello text'), mime: 'text/plain', filename: 'note.txt' }))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_IMAGE' });
    await expect(service.addEvidence('buyer1', disputeId, { buffer: Buffer.from('<html></html>'), mime: 'text/html', filename: 'page.html' }))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_IMAGE' });
    expect(db.dispute_evidence).toHaveLength(0);
  });

  test('non-party cannot add evidence', async () => {
    await expect(service.addEvidence('buyer2', disputeId, { buffer: PNG_BYTES, mime: 'image/png', filename: 'p.png' }))
      .rejects.toMatchObject({ status: 404, code: 'DISPUTE_NOT_ACCESSIBLE' });
  });

  test('bucket missing -> clear 503, not a crash', async () => {
    mockHolder.missingBuckets.add('dispute-evidence');
    await expect(service.addEvidence('buyer1', disputeId, { buffer: PNG_BYTES, mime: 'image/png', filename: 'p.png' }))
      .rejects.toMatchObject({ status: 503, code: 'EVIDENCE_BUCKET_MISSING' });
    expect(db.dispute_evidence).toHaveLength(0);
  });

  test('counterparty message -> 201; resolved dispute takes no more messages (409)', async () => {
    const m = await service.postMessage('farmer1', disputeId, 'We will replace the lot.');
    expect(m.message.body).toBe('We will replace the lot.');
    expect(m.message.author_role).toBe('farmer');
    await service.resolveDispute('admin1', disputeId, { outcome: 'rejected', note: 'No fault found.' });
    await expect(service.postMessage('buyer1', disputeId, 'Too late.'))
      .rejects.toMatchObject({ status: 409, code: 'DISPUTE_RESOLVED' });
    await expect(service.addEvidence('buyer1', disputeId, { buffer: PNG_BYTES, mime: 'image/png', filename: 'p.png' }))
      .rejects.toMatchObject({ status: 409, code: 'DISPUTE_RESOLVED' });
  });

  test('empty message body -> 422; non-party message -> 404', async () => {
    await expect(service.postMessage('buyer1', disputeId, '   '))
      .rejects.toMatchObject({ status: 422 });
    await expect(service.postMessage('buyer2', disputeId, 'hi'))
      .rejects.toMatchObject({ status: 404, code: 'DISPUTE_NOT_ACCESSIBLE' });
  });
});

describe('disputeService.updateStatus', () => {
  let service;
  let disputeId;

  beforeEach(async () => {
    ({ service } = setup());
    const d = await service.fileDispute('buyer1', { order_id: 'order1', category: 'quality', description: 'damp' });
    disputeId = d.id;
  });

  test('forward-only: filed -> under_review -> evidence_requested -> under_review', async () => {
    let out = await service.updateStatus('admin1', disputeId, 'under_review');
    expect(out.dispute.status).toBe('under_review');
    out = await service.updateStatus('admin1', disputeId, 'evidence_requested');
    expect(out.dispute.status).toBe('evidence_requested');
    out = await service.updateStatus('admin1', disputeId, 'under_review');
    expect(out.dispute.status).toBe('under_review');
  });

  test('skipping a step, going backwards, or naming resolved -> 409/422; non-admin -> 403', async () => {
    await expect(service.updateStatus('admin1', disputeId, 'evidence_requested'))
      .rejects.toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
    await expect(service.updateStatus('admin1', disputeId, 'filed'))
      .rejects.toMatchObject({ status: 422 });
    await expect(service.updateStatus('admin1', disputeId, 'resolved'))
      .rejects.toMatchObject({ status: 422 });
    await expect(service.updateStatus('buyer1', disputeId, 'under_review'))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await service.resolveDispute('admin1', disputeId, { outcome: 'rejected', note: 'No fault.' });
    await expect(service.updateStatus('admin1', disputeId, 'under_review'))
      .rejects.toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
  });
});

describe('disputeService.resolveDispute', () => {
  let service;
  let db;

  beforeEach(() => {
    ({ db, service } = setup());
  });

  test('full refund reuses the Stage 0 idempotent path: one refunds row, one gateway call', async () => {
    const d = await service.fileDispute('buyer1', { order_id: 'order1', category: 'quality', description: 'damp' });
    const out = await service.resolveDispute('admin1', d.id, { outcome: 'refund', note: 'Full refund.' });
    expect(out.dispute.status).toBe('resolved');
    expect(out.dispute.resolution).toBe('refund');
    expect(out.dispute.resolution_amount_paise).toBe(50000);
    expect(mockHolder.razorpay.payments.refund).toHaveBeenCalledTimes(1);
    expect(mockHolder.razorpay.payments.refund).toHaveBeenCalledWith('pay_razor1', { amount: 50000 });
    expect(db.refunds).toHaveLength(1);
    expect(db.refunds[0]).toMatchObject({ order_id: 'order1', status: 'REFUNDED', amount: 500 });
    expect(db.orders.find((o) => o.id === 'order1').status).toBe('REFUNDED');
    expect(db.payments.find((p) => p.id === 'pay1').status).toBe('REFUNDED');
  });

  test('second resolve attempt -> 409 AND still exactly one refund row / gateway call', async () => {
    const d = await service.fileDispute('buyer1', { order_id: 'order1', category: 'quality', description: 'damp' });
    await service.resolveDispute('admin1', d.id, { outcome: 'refund', note: 'Full refund.' });
    await expect(service.resolveDispute('admin1', d.id, { outcome: 'refund', note: 'Again.' }))
      .rejects.toMatchObject({ status: 409, code: 'DISPUTE_RESOLVED' });
    expect(db.refunds).toHaveLength(1);
    expect(mockHolder.razorpay.payments.refund).toHaveBeenCalledTimes(1);
  });

  test('partial refund maths, hand-checked in paise: 50000 total, 20000 refunded, order NOT fully refunded', async () => {
    const d = await service.fileDispute('buyer1', { order_id: 'order2', category: 'quantity', description: 'short' });
    const out = await service.resolveDispute('admin1', d.id, { outcome: 'partial_refund', amount_paise: 20000, note: 'Short by 40%.' });
    expect(out.dispute.status).toBe('resolved');
    expect(out.dispute.resolution).toBe('partial_refund');
    expect(out.dispute.resolution_amount_paise).toBe(20000);
    expect(mockHolder.razorpay.payments.refund).toHaveBeenCalledTimes(1);
    expect(mockHolder.razorpay.payments.refund).toHaveBeenCalledWith('pay_razor2', { amount: 20000 });
    expect(db.refunds).toHaveLength(1);
    expect(db.refunds[0]).toMatchObject({ order_id: 'order2', status: 'REFUNDED', amount: 200 });
    // The order is NOT fully refunded: still PAID, payment still HELD.
    expect(db.orders.find((o) => o.id === 'order2').status).toBe('PAID');
    expect(db.payments.find((p) => p.id === 'pay2').status).toBe('HELD');
  });

  test('partial refund validation: missing, zero, or over-total amount -> 422', async () => {
    const d = await service.fileDispute('buyer1', { order_id: 'order2', category: 'quantity', description: 'short' });
    await expect(service.resolveDispute('admin1', d.id, { outcome: 'partial_refund', note: 'x' }))
      .rejects.toMatchObject({ status: 422 });
    await expect(service.resolveDispute('admin1', d.id, { outcome: 'partial_refund', amount_paise: 0, note: 'x' }))
      .rejects.toMatchObject({ status: 422 });
    await expect(service.resolveDispute('admin1', d.id, { outcome: 'partial_refund', amount_paise: 50001, note: 'x' }))
      .rejects.toMatchObject({ status: 422 });
    expect(mockHolder.razorpay.payments.refund).not.toHaveBeenCalled();
  });

  test('replacement creates a new order row and NO payment row', async () => {
    const d = await service.fileDispute('buyer1', { order_id: 'order1', category: 'quality', description: 'damp' });
    const paymentsBefore = db.payments.length;
    const out = await service.resolveDispute('admin1', d.id, { outcome: 'replacement', note: 'Sending a fresh lot.' });
    expect(out.dispute.status).toBe('resolved');
    expect(out.dispute.resolution).toBe('replacement');
    expect(out.dispute.replacement_order_id).toBeTruthy();
    const replacement = db.orders.find((o) => o.id === out.dispute.replacement_order_id);
    expect(replacement).toMatchObject({ buyer_id: 'buyer1', farmer_id: 'farmer1', product_id: 'prod1', quantity: 1, status: 'PENDING' });
    expect(db.payments).toHaveLength(paymentsBefore);
    expect(mockHolder.razorpay.orders.create).not.toHaveBeenCalled();
    expect(mockHolder.razorpay.payments.refund).not.toHaveBeenCalled();
  });

  test('rejected needs a note (422 without); with a note no money moves', async () => {
    const d = await service.fileDispute('buyer1', { order_id: 'order1', category: 'quality', description: 'damp' });
    await expect(service.resolveDispute('admin1', d.id, { outcome: 'rejected' }))
      .rejects.toMatchObject({ status: 422 });
    const out = await service.resolveDispute('admin1', d.id, { outcome: 'rejected', note: 'No fault found.' });
    expect(out.dispute.resolution).toBe('rejected');
    expect(db.refunds).toHaveLength(0);
    expect(db.orders.find((o) => o.id === 'order1').status).toBe('PAID');
    expect(mockHolder.razorpay.payments.refund).not.toHaveBeenCalled();
  });

  test('buyer/farmer resolving their own dispute -> 403', async () => {
    const d = await service.fileDispute('buyer1', { order_id: 'order1', category: 'quality', description: 'damp' });
    await expect(service.resolveDispute('buyer1', d.id, { outcome: 'rejected', note: 'x' }))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await expect(service.resolveDispute('farmer1', d.id, { outcome: 'rejected', note: 'x' }))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  test('full refund on a COMPLETED (already released) order -> 409, no gateway call', async () => {
    const d = await service.fileDispute('buyer1', { order_id: 'order4', category: 'quality', description: 'late' });
    await expect(service.resolveDispute('admin1', d.id, { outcome: 'refund', note: 'Full.' }))
      .rejects.toMatchObject({ status: 409, code: 'REFUND_NOT_ELIGIBLE' });
    expect(mockHolder.razorpay.payments.refund).not.toHaveBeenCalled();
  });

  test('unknown outcome -> 422', async () => {
    const d = await service.fileDispute('buyer1', { order_id: 'order1', category: 'quality', description: 'damp' });
    await expect(service.resolveDispute('admin1', d.id, { outcome: 'store_credit', note: 'x' }))
      .rejects.toMatchObject({ status: 422 });
  });
});

describe('disputeService SLA + stats', () => {
  let service;
  let db;

  beforeEach(() => {
    ({ db, service } = setup());
  });

  test('breach escalates without resolving: escalated=true, is_overdue=true, status UNCHANGED', async () => {
    const d = await service.fileDispute('buyer1', { order_id: 'order1', category: 'quality', description: 'damp' });
    db.disputes.find((r) => r.id === d.id).sla_deadline = new Date(Date.now() - 60 * 1000).toISOString();
    const out = await service.checkSlaBreaches();
    expect(out).toEqual({ checked: 1, escalated: 1 });
    const read = await service.getDisputeDetail('buyer1', d.id);
    expect(read.dispute.escalated).toBe(true);
    expect(read.dispute.is_overdue).toBe(true);
    expect(read.dispute.status).toBe('filed');
    expect(db.audit_log.some((r) => r.event === 'dispute.escalated')).toBe(true);
  });

  test('in-deadline disputes are not escalated; resolved past-deadline disputes are not escalated', async () => {
    const d1 = await service.fileDispute('buyer1', { order_id: 'order1', category: 'quality', description: 'a' });
    const d2 = await service.fileDispute('buyer1', { order_id: 'order2', category: 'quality', description: 'b' });
    await service.resolveDispute('admin1', d2.id, { outcome: 'rejected', note: 'No fault.' });
    db.disputes.find((r) => r.id === d2.id).sla_deadline = new Date(Date.now() - 60 * 1000).toISOString();
    const out = await service.checkSlaBreaches();
    expect(out).toEqual({ checked: 0, escalated: 0 });
    expect(db.disputes.find((r) => r.id === d1.id).escalated).toBe(false);
    expect(db.disputes.find((r) => r.id === d2.id).escalated).toBe(false);
  });

  test('stats from real disputes only; NULL rates when there is nothing to compute', async () => {
    const empty = await service.getDisputeStats();
    expect(empty).toEqual({ total: 0, open: 0, resolved: 0, resolution_rate: null, avg_resolution_hours: null });
    const d1 = await service.fileDispute('buyer1', { order_id: 'order1', category: 'quality', description: 'a' });
    await service.fileDispute('buyer1', { order_id: 'order2', category: 'quantity', description: 'b' });
    // Pin the resolution time with literals: created 10:00, resolved next day 10:00 -> 24h.
    db.disputes.find((r) => r.id === d1.id).created_at = '2026-11-05T10:00:00.000Z';
    await service.resolveDispute('admin1', d1.id, { outcome: 'rejected', note: 'No fault.' });
    db.disputes.find((r) => r.id === d1.id).resolved_at = '2026-11-06T10:00:00.000Z';
    const stats = await service.getDisputeStats();
    expect(stats).toEqual({ total: 2, open: 1, resolved: 1, resolution_rate: 0.5, avg_resolution_hours: 24 });
  });
});

describe('disputeRoutes', () => {
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

  beforeEach(() => {
    jest.resetModules();
    mockHolder.supabase = makeSupabaseMock(seedDb());
    mockHolder.missingBuckets = new Set();
    mockHolder.uploads = [];
    setupRazorpay();
  });

  test('the router exposes exactly the nine dispute routes', () => {
    const routes = require('../routes/disputeRoutes');
    expect(routeList(routes)).toEqual([
      'GET /disputes',
      'GET /disputes/:id',
      'GET /disputes/stats',
      'POST /admin/disputes/:id/resolve',
      'POST /admin/disputes/:id/status',
      'POST /admin/disputes/check-sla',
      'POST /disputes',
      'POST /disputes/:id/evidence',
      'POST /disputes/:id/message',
    ].sort());
  });

  test('POST /disputes sits behind requireAuth; handler files and answers 201', async () => {
    const routes = require('../routes/disputeRoutes');
    const layer = findRoute(routes, 'POST', '/disputes');
    expect(layer.route.stack).toHaveLength(2);
    const [authLayer] = layer.route.stack;
    const nextAuth = jest.fn();
    await authLayer.handle({ headers: {} }, {}, nextAuth);
    expect(nextAuth.mock.calls[0][0]).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    const handler = layer.route.stack[1].handle;
    const res = mockRes();
    const next = jest.fn();
    await handler({ user: { id: 'buyer1' }, body: { order_id: 'order1', category: 'quality', description: 'damp' } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ dispute: expect.objectContaining({ status: 'filed' }) }));
  });

  test('admin routes sit behind requireAuth + requireAdmin', async () => {
    const routes = require('../routes/disputeRoutes');
    for (const [method, routePath] of [
      ['POST', '/admin/disputes/:id/status'],
      ['POST', '/admin/disputes/:id/resolve'],
      ['POST', '/admin/disputes/check-sla'],
    ]) {
      const layer = findRoute(routes, method, routePath);
      expect(layer.route.stack).toHaveLength(3);
      const [, adminLayer] = layer.route.stack;
      const nextRole = jest.fn();
      await adminLayer.handle({ user: { id: 'buyer1' } }, {}, nextRole);
      expect(nextRole.mock.calls[0][0]).toMatchObject({ status: 403, code: 'FORBIDDEN' });
      const nextAdmin = jest.fn();
      await adminLayer.handle({ user: { id: 'admin1' } }, {}, nextAdmin);
      expect(nextAdmin).toHaveBeenCalledWith();
    }
  });

  test('POST /disputes/:id/evidence parses multipart and answers 201 for a PNG', async () => {
    const { service } = setup();
    const d = await service.fileDispute('buyer1', { order_id: 'order1', category: 'quality', description: 'damp' });
    const routes = require('../routes/disputeRoutes');
    const layer = findRoute(routes, 'POST', '/disputes/:id/evidence');
    expect(layer.route.stack).toHaveLength(3);
    const handler = layer.route.stack[2].handle;
    const boundary = '----testboundary1234';
    const req = {
      user: { id: 'buyer1' },
      params: { id: d.id },
      body: multipartBody(boundary, 'photo.png', 'image/png', PNG_BYTES),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({ storage_path: expect.stringContaining('dispute-evidence/') }),
    }));
  });

  test('POST /disputes/:id/evidence answers 422 for a .txt payload', async () => {
    const { service } = setup();
    const d = await service.fileDispute('buyer1', { order_id: 'order1', category: 'quality', description: 'damp' });
    const routes = require('../routes/disputeRoutes');
    const layer = findRoute(routes, 'POST', '/disputes/:id/evidence');
    const handler = layer.route.stack[2].handle;
    const boundary = '----testboundary1234';
    const req = {
      user: { id: 'buyer1' },
      params: { id: d.id },
      body: multipartBody(boundary, 'note.txt', 'text/plain', Buffer.from('hello text')),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422, code: 'INVALID_IMAGE' }));
  });

  test('GET /disputes/stats handler answers the public aggregates', async () => {
    const { service } = setup();
    await service.fileDispute('buyer1', { order_id: 'order1', category: 'quality', description: 'damp' });
    const routes = require('../routes/disputeRoutes');
    const layer = findRoute(routes, 'GET', '/disputes/stats');
    const handler = layer.route.stack[1].handle;
    const res = mockRes();
    const next = jest.fn();
    await handler({ user: { id: 'buyer1' }, query: {} }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ total: 1, open: 1, resolved: 0, resolution_rate: 0, avg_resolution_hours: null });
  });
});
