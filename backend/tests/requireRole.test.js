'use strict';
/**
 * requireRole middleware (Stage 1, trust foundation): only a caller whose
 * profiles row carries the required role may proceed. Fail closed — a
 * missing profile row is a 403, never a pass-through.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

// Holder for the per-test admin-client mock. Jest allows "mock"-prefixed
// vars in mock factories.
const mockHolder = { admin: null };

jest.mock('../utils/supabaseAdmin', () => ({
  // Proxy: the middleware captures this object at require time, so delegate
  // to whatever mock the current test installed in mockHolder.admin.
  from: (...args) => mockHolder.admin.from(...args),
}));

function makeAdminMock(rows) {
  return {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(async () => ({ data: rows, error: null })),
      })),
    })),
  };
}

describe('requireRole', () => {
  let requireRole;

  beforeEach(() => {
    jest.resetModules();
    requireRole = require('../middleware/requireRole');
  });

  function callMiddleware(middleware, userId) {
    const req = userId === undefined ? {} : { user: { id: userId } };
    const res = {};
    const next = jest.fn();
    return { req, res, next, promise: middleware(req, res, next) };
  }

  test('an admin passes requireRole("admin")', async () => {
    mockHolder.admin = makeAdminMock([{ role: 'admin' }]);
    const { next, promise } = callMiddleware(requireRole('admin'), 'admin1');
    await promise;
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  test('a buyer gets 403 from requireRole("admin")', async () => {
    mockHolder.admin = makeAdminMock([{ role: 'buyer' }]);
    const { next, promise } = callMiddleware(requireRole('admin'), 'buyer1');
    await promise;
    expect(next.mock.calls[0][0]).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  test('a farmer gets 403 from requireRole("admin")', async () => {
    mockHolder.admin = makeAdminMock([{ role: 'farmer' }]);
    const { next, promise } = callMiddleware(requireRole('admin'), 'farmer1');
    await promise;
    expect(next.mock.calls[0][0]).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  test('a missing profile row fails closed with 403', async () => {
    mockHolder.admin = makeAdminMock([]);
    const { next, promise } = callMiddleware(requireRole('admin'), 'ghost1');
    await promise;
    expect(next.mock.calls[0][0]).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  test('no req.user is 401, not 403', async () => {
    mockHolder.admin = makeAdminMock([{ role: 'admin' }]);
    const { next, promise } = callMiddleware(requireRole('admin'), undefined);
    await promise;
    expect(next.mock.calls[0][0]).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });

  test('requireAdmin passes an admin and 403s a buyer', async () => {
    mockHolder.admin = makeAdminMock([{ role: 'admin' }]);
    const pass = callMiddleware(requireRole.requireAdmin, 'admin1');
    await pass.promise;
    expect(pass.next).toHaveBeenCalledWith();

    mockHolder.admin = makeAdminMock([{ role: 'buyer' }]);
    const fail = callMiddleware(requireRole.requireAdmin, 'buyer1');
    await fail.promise;
    expect(fail.next.mock.calls[0][0]).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });
});
