'use strict';
/**
 * Verification + admin role management (Stage 1, trust foundation).
 * Service functions are tested against the same in-memory Supabase mock
 * pattern as webhook.test.js, extended with order()/range() and exact-count
 * selects for pagination. Route tests assert the guards are actually
 * mounted (requireAdmin on every admin route, requireAuth on the farmer
 * submit route) — no supertest dependency is added.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const mockHolder = { supabase: null };

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => mockHolder.supabase,
}));

function makeSupabaseMock(db) {
  function matches(row, filters) {
    for (const f of filters) {
      if (f.type === 'eq' && row[f.col] !== f.val) return false;
      if (f.type === 'in' && !f.val.includes(row[f.col])) return false;
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
      // Exact count is the total before the page window is applied.
      const count = q.countExact ? rows.length : null;
      if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
      if (q.limit != null) rows = rows.slice(0, q.limit);
      return { data: rows, count, error: null };
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
    const q = { table, op: null, fields: null, row: null, filters: [], limit: null, orderBy: null, range: null, countExact: false };
    const api = {
      // .select() after .update()/.insert() only means "return the rows"
      // (supabase-js semantics) — it must NOT overwrite the operation.
      select(_cols, opts) { if (!q.op) q.op = 'select'; if (opts && opts.count === 'exact') q.countExact = true; return api; },
      update(fields) { q.op = 'update'; q.fields = fields; return api; },
      insert(row) { q.op = 'insert'; q.row = row; return api; },
      eq(col, val) { q.filters.push({ type: 'eq', col, val }); return api; },
      in(col, val) { q.filters.push({ type: 'in', col, val }); return api; },
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
      // Signed URLs for the private verification-docs bucket. Records
      // which bucket each call targeted so tests can prove no public
      // product-images URL is ever built for a verification document.
      from: (bucket) => {
        mockHolder.lastStorageBucket = bucket;
        return {
          createSignedUrl: jest.fn(async (path, expiresIn) => ({
            data: { signedUrl: `https://example.test/signed/${bucket}/${path}?expires=${expiresIn}` },
            error: null,
          })),
        };
      },
    },
  };
}

function seedDb() {
  return {
    profiles: [
      { id: 'admin1', first_name: 'Admin', last_name: 'User', email_address: 'admin@example.com', role: 'admin', verification_status: 'unverified', verified_at: null, verified_by: null, created_at: '2026-11-01T00:00:00.000Z' },
      { id: 'farmer1', first_name: 'Suresh', last_name: 'Singh', email_address: 'farmer1@example.com', role: 'farmer', verification_status: 'unverified', verified_at: null, verified_by: null, created_at: '2026-11-02T00:00:00.000Z' },
      { id: 'farmer2', first_name: 'Meena', last_name: 'Devi', email_address: 'farmer2@example.com', role: 'farmer', verification_status: 'unverified', verified_at: null, verified_by: null, created_at: '2026-11-03T00:00:00.000Z' },
      { id: 'buyer1', first_name: 'Ramesh', last_name: 'Kumar', email_address: 'buyer1@example.com', role: 'buyer', verification_status: 'unverified', verified_at: null, verified_by: null, created_at: '2026-11-04T00:00:00.000Z' },
    ],
    verification_submissions: [],
    // Stage 6: approve/reject also update the transporters row when one
    // exists for the submission's user (no row here = farmer approvals).
    transporters: [],
    audit_log: [],
  };
}

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

describe('verificationService.submitVerification', () => {
  let service;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    service = require('../services/verificationService');
  });

  test('happy path creates a pending submission and flips the profile to pending', async () => {
    const row = await service.submitVerification('farmer1', 'verification-docs/farmer1-abc123.jpg');
    expect(row.status).toBe('pending');
    expect(row.farmer_id).toBe('farmer1');
    expect(row.document_path).toBe('verification-docs/farmer1-abc123.jpg');
    expect(db.verification_submissions).toHaveLength(1);
    expect(db.profiles.find((p) => p.id === 'farmer1').verification_status).toBe('pending');
  });

  test('a buyer cannot submit — 403', async () => {
    await expect(service.submitVerification('buyer1', 'verification-docs/buyer1-abc.jpg'))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(db.verification_submissions).toHaveLength(0);
  });

  test('an unknown caller cannot submit — 403 fail closed', async () => {
    await expect(service.submitVerification('ghost', 'verification-docs/ghost-abc.jpg'))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  test('a document path under another farmer is rejected — 422', async () => {
    await expect(service.submitVerification('farmer1', 'verification-docs/farmer2-abc.jpg'))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    expect(db.verification_submissions).toHaveLength(0);
  });

  test('a document path outside verification-docs/ is rejected — 422', async () => {
    await expect(service.submitVerification('farmer1', 'product-items/farmer1-abc.jpg'))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
  });

  test('an empty document path is rejected — 422', async () => {
    await expect(service.submitVerification('farmer1', ''))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.submitVerification('farmer1', null))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
  });

  test('a second pending submission is a 409', async () => {
    await service.submitVerification('farmer1', 'verification-docs/farmer1-abc.jpg');
    await expect(service.submitVerification('farmer1', 'verification-docs/farmer1-def.jpg'))
      .rejects.toMatchObject({ status: 409, code: 'VERIFICATION_PENDING' });
    expect(db.verification_submissions).toHaveLength(1);
  });

  test('a new submission is allowed after the previous one was decided', async () => {
    const first = await service.submitVerification('farmer1', 'verification-docs/farmer1-abc.jpg');
    await service.approveVerification('admin1', first.id);
    const second = await service.submitVerification('farmer1', 'verification-docs/farmer1-def.jpg');
    expect(second.status).toBe('pending');
    expect(db.verification_submissions).toHaveLength(2);
  });
});

describe('verificationService approve/reject', () => {
  let service;
  let db;
  let pending;

  beforeEach(async () => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    service = require('../services/verificationService');
    pending = await service.submitVerification('farmer1', 'verification-docs/farmer1-abc.jpg');
  });

  test('approve marks the submission approved and the farmer verified', async () => {
    const row = await service.approveVerification('admin1', pending.id);
    expect(row.status).toBe('approved');
    expect(row.reviewed_by).toBe('admin1');
    expect(row.reviewed_at).toBeTruthy();
    const profile = db.profiles.find((p) => p.id === 'farmer1');
    expect(profile.verification_status).toBe('verified');
    expect(profile.verified_by).toBe('admin1');
    expect(profile.verified_at).toBeTruthy();
  });

  test('approve of a non-pending submission is a 409', async () => {
    await service.approveVerification('admin1', pending.id);
    await expect(service.approveVerification('admin1', pending.id))
      .rejects.toMatchObject({ status: 409, code: 'VERIFICATION_NOT_PENDING' });
  });

  test('approve of a missing submission is a 404', async () => {
    await expect(service.approveVerification('admin1', 'no-such-id'))
      .rejects.toMatchObject({ status: 404, code: 'VERIFICATION_NOT_FOUND' });
  });

  test('reject with a note marks the submission rejected and the farmer rejected', async () => {
    const row = await service.rejectVerification('admin1', pending.id, 'Document is unreadable.');
    expect(row.status).toBe('rejected');
    expect(row.review_note).toBe('Document is unreadable.');
    expect(row.reviewed_by).toBe('admin1');
    const profile = db.profiles.find((p) => p.id === 'farmer1');
    expect(profile.verification_status).toBe('rejected');
    expect(profile.verified_at).toBeNull();
    expect(profile.verified_by).toBeNull();
  });

  test('reject without a note is a 422 and changes nothing', async () => {
    await expect(service.rejectVerification('admin1', pending.id, ''))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    await expect(service.rejectVerification('admin1', pending.id))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    expect(db.verification_submissions[0].status).toBe('pending');
    expect(db.profiles.find((p) => p.id === 'farmer1').verification_status).toBe('pending');
  });

  test('reject of a non-pending submission is a 409', async () => {
    await service.rejectVerification('admin1', pending.id, 'Bad document.');
    await expect(service.rejectVerification('admin1', pending.id, 'Again.'))
      .rejects.toMatchObject({ status: 409, code: 'VERIFICATION_NOT_PENDING' });
  });
});

describe('verificationService.getDocumentSignedUrl (Stage 2 hardening)', () => {
  let service;
  let db;
  let pending;

  beforeEach(async () => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    mockHolder.lastStorageBucket = null;
    service = require('../services/verificationService');
    pending = await service.submitVerification('farmer1', 'verification-docs/farmer1-abc.jpg');
  });

  test('happy path returns a signed URL valid for 300s from the private bucket', async () => {
    const result = await service.getDocumentSignedUrl('admin1', pending.id);
    expect(mockHolder.lastStorageBucket).toBe('verification-docs');
    expect(result.expiresIn).toBe(300);
    expect(result.signedUrl).toBe(
      'https://example.test/signed/verification-docs/verification-docs/farmer1-abc.jpg?expires=300',
    );
    expect(result).not.toHaveProperty('publicUrl');
    expect(db.audit_log).toHaveLength(2);
    expect(db.audit_log[1]).toMatchObject({ event: 'verification.document_viewed', actor_id: 'admin1' });
  });

  test('missing submission is a 404', async () => {
    await expect(service.getDocumentSignedUrl('admin1', 'no-such-id'))
      .rejects.toMatchObject({ status: 404, code: 'VERIFICATION_NOT_FOUND' });
  });

  test('a document outside the private bucket is a 422 — never served publicly', async () => {
    db.verification_submissions.push({
      id: 'legacy-public', farmer_id: 'farmer1',
      document_path: 'product-items/farmer1-old.jpg', status: 'pending',
    });
    await expect(service.getDocumentSignedUrl('admin1', 'legacy-public'))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    expect(mockHolder.lastStorageBucket).toBeNull();
  });

  test('a failing audit insert never breaks the signed-URL response', async () => {
    delete db.audit_log;
    const result = await service.getDocumentSignedUrl('admin1', pending.id);
    expect(result.expiresIn).toBe(300);
    expect(result.signedUrl).toContain('verification-docs/farmer1-abc.jpg');
  });

  test('no public URL is ever constructed for a verification document', () => {
    const fs = require('fs');
    const path = require('path');
    for (const file of ['../services/verificationService.js', '../routes/adminRoutes.js']) {
      const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(src).not.toContain('getPublicUrl');
      expect(src).not.toContain('/object/public/');
    }
    const queue = fs.readFileSync(
      path.join(__dirname, '../../src/pages/admin/VerificationQueue.jsx'), 'utf8',
    );
    expect(queue).not.toContain('/object/public/');
    expect(queue).not.toContain('getPublicUrl');
  });
});

describe('verificationService listVerifications / listRoles / changeRole', () => {
  let service;
  let db;

  beforeEach(async () => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
    service = require('../services/verificationService');
    const s1 = await service.submitVerification('farmer1', 'verification-docs/farmer1-a.jpg');
    const s2 = await service.submitVerification('farmer2', 'verification-docs/farmer2-a.jpg');
    await service.approveVerification('admin1', s2.id);
    // Newest submission first: give the farmer1 row the latest timestamp.
    db.verification_submissions.find((s) => s.id === s1.id).created_at = '2026-11-05T00:00:00.000Z';
    db.verification_submissions.find((s) => s.id === s2.id).created_at = '2026-11-04T00:00:00.000Z';
  });

  test('list returns newest first with pagination shape and farmer names embedded', async () => {
    const result = await service.listVerifications({ page: 1, pageSize: 1 });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].farmer_id).toBe('farmer1');
    expect(result.data[0].farmer).toEqual({ first_name: 'Suresh', last_name: 'Singh' });
    expect(result.pagination).toEqual({ page: 1, pageSize: 1, totalItems: 2, totalPages: 2 });
  });

  test('list filters by status', async () => {
    const result = await service.listVerifications({ status: 'approved', page: 1, pageSize: 20 });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].status).toBe('approved');
    expect(result.pagination.totalItems).toBe(1);
  });

  test('pageSize is capped at 100', async () => {
    const result = await service.listVerifications({ page: 1, pageSize: 500 });
    expect(result.pagination.pageSize).toBe(100);
    expect(result.data).toHaveLength(2);
  });

  test('listRoles returns the allowlisted profile fields, newest first, paginated', async () => {
    const result = await service.listRoles({ page: 1, pageSize: 2 });
    expect(result.pagination).toEqual({ page: 1, pageSize: 2, totalItems: 4, totalPages: 2 });
    expect(result.data.map((p) => p.id)).toEqual(['buyer1', 'farmer2']);
    expect(Object.keys(result.data[0]).sort()).toEqual(
      ['created_at', 'email_address', 'first_name', 'id', 'last_name', 'role', 'verification_status'].sort(),
    );
  });

  test('changeRole updates the role and returns the updated profile', async () => {
    const row = await service.changeRole('admin1', 'buyer1', 'farmer');
    expect(row).toEqual({ id: 'buyer1', role: 'farmer', verification_status: 'unverified' });
    expect(db.profiles.find((p) => p.id === 'buyer1').role).toBe('farmer');
  });

  test('changeRole rejects an invalid role — 422', async () => {
    await expect(service.changeRole('admin1', 'buyer1', 'superuser'))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    expect(db.profiles.find((p) => p.id === 'buyer1').role).toBe('buyer');
  });

  test('changeRole rejects an admin changing their own role — 409', async () => {
    await expect(service.changeRole('admin1', 'admin1', 'buyer'))
      .rejects.toMatchObject({ status: 409, code: 'ROLE_SELF_CHANGE' });
    expect(db.profiles.find((p) => p.id === 'admin1').role).toBe('admin');
  });

  test('changeRole of a missing user is a 404', async () => {
    await expect(service.changeRole('admin1', 'ghost', 'farmer'))
      .rejects.toMatchObject({ status: 404, code: 'USER_NOT_FOUND' });
  });

  test('M1 regression: changeRole itself does not check the caller — the route guard does', async () => {
    // Authorization lives in requireRole (mounted on the admin router, see
    // the route tests below), not in the service: a non-admin id passed
    // here still changes the row. The route test proves a non-admin JWT
    // never reaches this function.
    const row = await service.changeRole('buyer1', 'farmer1', 'admin');
    expect(row.role).toBe('admin');
  });
});

describe('routes mount the right guards', () => {
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = seedDb();
    mockHolder.supabase = makeSupabaseMock(db);
  });

  test('every admin route sits behind requireAdmin', () => {
    const adminRoutes = require('../routes/adminRoutes');
    const { requireAdmin } = require('../middleware/requireRole');
    const guardLayer = adminRoutes.stack.find((l) => !l.route && l.handle === requireAdmin);
    expect(guardLayer).toBeDefined();
    // requireAuth is mounted first, requireAdmin second — both before any route.
    const firstRouteIndex = adminRoutes.stack.findIndex((l) => l.route);
    const guardIndex = adminRoutes.stack.findIndex((l) => !l.route && l.handle === requireAdmin);
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(firstRouteIndex);
    expect(adminRoutes.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).sort())
      .toEqual([
        'GET /roles',
        'GET /verifications',
        'GET /verifications/:id/document',
        'POST /roles/:userId',
        'POST /verifications/:id/approve',
        'POST /verifications/:id/reject',
      ].sort());
  });

  test('GET /verifications/:id/document handler returns the signed URL', async () => {
    const service = require('../services/verificationService');
    const pending = await service.submitVerification('farmer1', 'verification-docs/farmer1-abc.jpg');
    const adminRoutes = require('../routes/adminRoutes');
    const layer = adminRoutes.stack.find((l) => l.route && l.route.path === '/verifications/:id/document');
    expect(layer).toBeDefined();
    const handler = layer.route.stack[0].handle;
    const req = { user: { id: 'admin1' }, params: { id: pending.id } };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ expiresIn: 300 }));
    expect(res.json.mock.calls[0][0].signedUrl).toContain('verification-docs/farmer1-abc.jpg');
  });

  test('GET /verifications/:id/document handler passes a missing submission to next(err) as 404', async () => {
    const adminRoutes = require('../routes/adminRoutes');
    const layer = adminRoutes.stack.find((l) => l.route && l.route.path === '/verifications/:id/document');
    const handler = layer.route.stack[0].handle;
    const req = { user: { id: 'admin1' }, params: { id: 'no-such-id' } };
    const next = jest.fn();
    await handler(req, mockRes(), next);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 404, code: 'VERIFICATION_NOT_FOUND' });
  });

  test('GET /verifications/:id/document handler passes a public-bucket document to next(err) as 422', async () => {
    db.verification_submissions.push({
      id: 'legacy-public', farmer_id: 'farmer1',
      document_path: 'product-items/farmer1-old.jpg', status: 'pending',
    });
    const adminRoutes = require('../routes/adminRoutes');
    const layer = adminRoutes.stack.find((l) => l.route && l.route.path === '/verifications/:id/document');
    const handler = layer.route.stack[0].handle;
    const req = { user: { id: 'admin1' }, params: { id: 'legacy-public' } };
    const next = jest.fn();
    await handler(req, mockRes(), next);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
  });

  test('the admin guard rejects a non-admin before any handler runs', async () => {
    const adminRoutes = require('../routes/adminRoutes');
    const { requireAdmin } = require('../middleware/requireRole');
    const guardLayer = adminRoutes.stack.find((l) => !l.route && l.handle === requireAdmin);
    const req = { user: { id: 'buyer1' } };
    const next = jest.fn();
    await guardLayer.handle(req, {}, next);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  test('the verification submit route sits behind requireAuth', () => {
    const verificationRoutes = require('../routes/verificationRoutes');
    const requireAuth = require('../middleware/requireAuth');
    const guardLayer = verificationRoutes.stack.find((l) => !l.route && l.handle === requireAuth);
    expect(guardLayer).toBeDefined();
    expect(verificationRoutes.stack.filter((l) => l.route).map((l) => l.route.path)).toEqual(['/submit']);
  });

  test('POST /submit handler creates the submission and answers 201', async () => {
    const verificationRoutes = require('../routes/verificationRoutes');
    const submitLayer = verificationRoutes.stack.find((l) => l.route && l.route.path === '/submit');
    const handler = submitLayer.route.stack[0].handle;
    const req = { user: { id: 'farmer1' }, body: { document_path: 'verification-docs/farmer1-abc.jpg' } };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending' }));
    expect(db.verification_submissions).toHaveLength(1);
  });

  test('POST /submit handler rejects a bad document path via next(err)', async () => {
    const verificationRoutes = require('../routes/verificationRoutes');
    const submitLayer = verificationRoutes.stack.find((l) => l.route && l.route.path === '/submit');
    const handler = submitLayer.route.stack[0].handle;
    const req = { user: { id: 'farmer1' }, body: { document_path: 'product-items/farmer1-x.jpg' } };
    const res = mockRes();
    const next = jest.fn();
    await handler(req, res, next);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    expect(db.verification_submissions).toHaveLength(0);
  });
});
