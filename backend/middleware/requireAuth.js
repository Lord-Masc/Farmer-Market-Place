'use strict';
// Verifies the caller's Supabase JWT and attaches req.user = { id, email }.
// Uses supabase.auth.getUser(token), which validates the token against the
// Supabase Auth server — no new secret is needed (the service-role client
// already talks to the same project). All escrow routes require this; the
// service layer then authorizes the caller against the order's buyer/farmer.
const { createClient } = require('@supabase/supabase-js');
const { AppError } = require('../utils/errors');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired session.');
    }
    req.user = { id: data.user.id, email: data.user.email || null };
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = requireAuth;
