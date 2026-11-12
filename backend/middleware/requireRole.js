'use strict';
// Role gate — runs AFTER requireAuth (req.user is set). Reads the caller's
// role fresh from profiles on every request (no caching: a role change
// must take effect immediately). Fail closed: no req.user, no profile row,
// or a non-matching role is a 401/403 — never a pass-through.
const supabaseAdmin = require('../utils/supabaseAdmin');
const { AppError } = require('../utils/errors');

function requireRole(role) {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      }
      const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('role')
        .eq('id', req.user.id);
      if (error) throw error;
      const profile = data && data[0];
      if (!profile || profile.role !== role) {
        throw new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = requireRole;
module.exports.requireAdmin = requireRole('admin');
