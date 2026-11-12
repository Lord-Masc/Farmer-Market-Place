'use strict';
// Verifies the caller's Supabase JWT and attaches req.user = { id, email }.
// Uses supabase.auth.getUser(token), which validates the token against the
// Supabase Auth server — no new secret is needed (the service-role client
// already talks to the same project). All escrow routes require this; the
// service layer then authorizes the caller against the order's buyer/farmer.
//
// Suspension enforcement (Stage 10): after the JWT validates, the
// caller's profiles.suspended_at is read FRESH per request (same
// fail-closed pattern as requireAdmin — a read error rejects the
// request, it never passes through). A non-NULL suspended_at is a 403
// ACCOUNT_SUSPENDED, so a suspended user cannot call ANY authenticated
// API — every route behind requireAuth is covered, including admin
// routes (a suspended admin cannot act either; another admin must
// reinstate them). A missing profile row cannot be suspended, so it
// passes — the role/service gates still apply where a role matters.
// Supabase Auth login itself is NOT blocked: login still works, the
// API rejects. The public transparency endpoint has no auth and is
// unaffected.
const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = require('../utils/supabaseAdmin');
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
    const { data: profiles, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('suspended_at')
      .eq('id', data.user.id);
    if (profileError) throw profileError;
    const profile = profiles && profiles[0];
    if (profile && profile.suspended_at) {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Your account is suspended. Contact support for help.');
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = requireAuth;
