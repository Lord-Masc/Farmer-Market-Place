'use strict';
// User moderation (Stage 10, module I).
//
// SEMANTICS (coordinator decision): suspend sets profiles.suspended_at
// = now() AND hides ALL of that user's products (products.status =
// 'hidden') — that IS the takedown. Reinstate clears suspended_at AND
// restores their products to 'active'. Both actions are audit-logged.
// A suspended user's authenticated API requests are rejected server-side
// by requireAuth, so suspension takes effect immediately on every route.
//
// The two writes (profile + products) are not a single transaction:
// a crash between them leaves the user suspended with listings still
// visible — the suspension block still holds (the user cannot act),
// and a re-run of suspend (409 ALREADY_SUSPENDED) does NOT re-hide, so
// the operator re-hides by reinstating and suspending again. A Postgres
// RPC would make this atomic — a hardening follow-up, same claim-first
// class as Stages 4/5/6.
const supabaseAdmin = require('../utils/supabaseAdmin');
const { AppError } = require('../utils/errors');
const { logAudit } = require('../utils/auditLog');

const getSingle = (data) => (data && data.length > 0 ? data[0] : null);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Email shape = local@domain; no TLD required (a bare host is still a
// deliverable shape, and the lookup only ever matches an exact stored
// email_address — a wrong shape can never return a user).
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

async function fetchProfile(userId) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id,role,suspended_at')
    .eq('id', userId);
  if (error) throw error;
  return getSingle(data);
}

async function suspendUser(adminId, userId) {
  if (userId === adminId) {
    throw new AppError(409, 'SELF_SUSPEND', 'An admin cannot suspend their own account.');
  }
  const target = await fetchProfile(userId);
  if (!target) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  if (target.suspended_at) {
    throw new AppError(409, 'ALREADY_SUSPENDED', 'This user is already suspended.');
  }
  const suspendedAt = new Date().toISOString();
  const { data: updated, error } = await supabaseAdmin
    .from('profiles')
    .update({ suspended_at: suspendedAt })
    .eq('id', userId)
    .select('id,role,suspended_at');
  if (error) throw error;
  const row = getSingle(updated);
  if (!row) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  const { data: hidden, error: hideError } = await supabaseAdmin
    .from('products')
    .update({ status: 'hidden' })
    .eq('farmer_id', userId)
    .eq('status', 'active')
    .select('id');
  if (hideError) throw hideError;
  const listingsHidden = (hidden || []).length;
  await logAudit(adminId, 'moderation.suspended', { user_id: userId, listings_hidden: listingsHidden });
  return { user: { id: row.id, role: row.role, suspended_at: row.suspended_at }, listings_hidden: listingsHidden };
}

async function reinstateUser(adminId, userId) {
  const target = await fetchProfile(userId);
  if (!target) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  if (!target.suspended_at) {
    throw new AppError(409, 'NOT_SUSPENDED', 'This user is not suspended.');
  }
  const { data: updated, error } = await supabaseAdmin
    .from('profiles')
    .update({ suspended_at: null })
    .eq('id', userId)
    .select('id,role,suspended_at');
  if (error) throw error;
  const row = getSingle(updated);
  if (!row) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  const { data: restored, error: restoreError } = await supabaseAdmin
    .from('products')
    .update({ status: 'active' })
    .eq('farmer_id', userId)
    .eq('status', 'hidden')
    .select('id');
  if (restoreError) throw restoreError;
  const listingsRestored = (restored || []).length;
  await logAudit(adminId, 'moderation.reinstated', { user_id: userId, listings_restored: listingsRestored });
  return { user: { id: row.id, role: row.role, suspended_at: row.suspended_at }, listings_restored: listingsRestored };
}

// Admin lookup by UUID or by email (the Moderation page's search box).
// Both shapes return the same { user } shape; anything else — unknown
// UUID, unknown email, or a query that is neither — gets the SAME
// generic 404, so the response never leaks which identifier was wrong.
async function lookupUser(query) {
  if (typeof query !== 'string' || query.length === 0) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  }
  let profile = null;
  if (UUID_RE.test(query)) {
    profile = await fetchProfile(query);
  } else if (EMAIL_RE.test(query)) {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id,role,suspended_at')
      .eq('email_address', query);
    if (error) throw error;
    profile = getSingle(data);
  } else {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  }
  if (!profile) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  return { user: { id: profile.id, role: profile.role, suspended_at: profile.suspended_at } };
}

module.exports = { suspendUser, reinstateUser, lookupUser };
