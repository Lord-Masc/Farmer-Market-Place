'use strict';
// Verification + admin role management (Stage 1, trust foundation).
// Service layer only — authorization lives in the route middleware
// (requireAuth / requireAdmin); these functions assume the caller was
// already authorized, except submitVerification, which checks the
// caller's own farmer role (a buyer must not be able to file a
// verification for themselves). All trust-field writes go through the
// service-role client, which is what the prevent_trust_escalation trigger
// allows; direct PostgREST writes to those fields stay blocked. Trust
// decisions write one audit_log row each (best effort — a failing audit
// insert never breaks the decision).
const supabaseAdmin = require('../utils/supabaseAdmin');
const { AppError } = require('../utils/errors');
const { logAudit } = require('../utils/auditLog');

const ROLES = ['buyer', 'farmer', 'admin'];
const VERIFICATION_STATUSES = ['pending', 'approved', 'rejected'];

// Stage 2 hardening: verification documents live in the PRIVATE
// 'verification-docs' bucket (created in the Supabase Dashboard — bucket
// creation is not SQL). No storage policies exist on that bucket, so only
// the service-role client can read it; admins view a document through a
// short-lived signed URL minted here.
const DOCUMENT_BUCKET = 'verification-docs';
const SIGNED_URL_TTL_SECONDS = 300;

// Same getSingle shape as escrowService: supabase-js returns arrays.
const getSingle = (data) => (data && data.length > 0 ? data[0] : null);

function parsePage({ page, pageSize } = {}) {
  const p = Number.parseInt(page, 10);
  const ps = Number.parseInt(pageSize, 10);
  return {
    page: Number.isFinite(p) && p > 0 ? p : 1,
    pageSize: Number.isFinite(ps) && ps > 0 ? Math.min(ps, 100) : 20,
  };
}

function paginationResult(page, pageSize, totalItems) {
  return { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) };
}

async function fetchProfile(userId, columns = 'id,role,verification_status') {
  const { data, error } = await supabaseAdmin.from('profiles').select(columns).eq('id', userId);
  if (error) throw error;
  return getSingle(data);
}

async function fetchSubmission(submissionId) {
  const { data, error } = await supabaseAdmin
    .from('verification_submissions')
    .select('*')
    .eq('id', submissionId);
  if (error) throw error;
  const row = getSingle(data);
  if (!row) throw new AppError(404, 'VERIFICATION_NOT_FOUND', 'Verification not found.');
  return row;
}

// Farmer files a verification, referencing a document they uploaded via
// POST /api/uploads/image?kind=verification. The path must start with
// their own prefix — a farmer may only reference their own upload.
async function submitVerification(farmerId, documentPath) {
  const profile = await fetchProfile(farmerId, 'id,role');
  if (!profile || profile.role !== 'farmer') {
    throw new AppError(403, 'FORBIDDEN', 'Only farmers can submit verification.');
  }
  if (typeof documentPath !== 'string' || !documentPath.startsWith(`verification-docs/${farmerId}-`)) {
    throw new AppError(422, 'VALIDATION_ERROR', 'document_path must be your own verification document upload.');
  }
  const { data: pending, error: pendingError } = await supabaseAdmin
    .from('verification_submissions')
    .select('id')
    .eq('farmer_id', farmerId)
    .eq('status', 'pending');
  if (pendingError) throw pendingError;
  // The partial unique index is the race backstop; this check gives the
  // clean 409 instead of a constraint error.
  if (pending && pending.length > 0) {
    throw new AppError(409, 'VERIFICATION_PENDING', 'A verification submission is already pending.');
  }
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from('verification_submissions')
    .insert({ farmer_id: farmerId, document_path: documentPath, status: 'pending' })
    .select('*');
  if (insertError) throw insertError;
  const submission = getSingle(inserted);
  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .update({ verification_status: 'pending' })
    .eq('id', farmerId);
  if (profileError) throw profileError;
  await logAudit(farmerId, 'verification.submitted', { submission_id: submission.id, farmer_id: farmerId });
  return submission;
}

// Admin review queue, newest first. Farmer names come from a second
// query (no PostgREST embed — keeps the mock-friendly select shape).
async function listVerifications({ status, page, pageSize } = {}) {
  const { page: p, pageSize: ps } = parsePage({ page, pageSize });
  if (status !== undefined && !VERIFICATION_STATUSES.includes(status)) {
    throw new AppError(422, 'VALIDATION_ERROR', 'status must be pending, approved or rejected.');
  }
  let query = supabaseAdmin
    .from('verification_submissions')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data: rows, count, error } = await query.range((p - 1) * ps, p * ps - 1);
  if (error) throw error;
  const farmerIds = [...new Set((rows || []).map((r) => r.farmer_id))];
  let names = {};
  if (farmerIds.length > 0) {
    const { data: profiles, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id,first_name,last_name')
      .in('id', farmerIds);
    if (profileError) throw profileError;
    names = Object.fromEntries((profiles || []).map((pr) => [pr.id, pr]));
  }
  const data = (rows || []).map((r) => ({
    ...r,
    farmer: names[r.farmer_id]
      ? { first_name: names[r.farmer_id].first_name, last_name: names[r.farmer_id].last_name }
      : null,
  }));
  return { data, pagination: paginationResult(p, ps, count ?? data.length) };
}

async function approveVerification(adminId, submissionId) {
  const submission = await fetchSubmission(submissionId);
  if (submission.status !== 'pending') {
    throw new AppError(409, 'VERIFICATION_NOT_PENDING', 'Only a pending verification can be approved.');
  }
  const now = new Date().toISOString();
  const { data: updated, error } = await supabaseAdmin
    .from('verification_submissions')
    .update({ status: 'approved', reviewed_by: adminId, reviewed_at: now })
    .eq('id', submissionId)
    .select('*');
  if (error) throw error;
  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .update({ verification_status: 'verified', verified_at: now, verified_by: adminId })
    .eq('id', submission.farmer_id);
  if (profileError) throw profileError;
  // Stage 6: approving a transporter submission also verifies the
  // transporters row for that user (no second admin queue). No row
  // exists for a farmer approval — the update then matches nothing.
  const { data: transporterRows, error: transporterError } = await supabaseAdmin
    .from('transporters')
    .update({ verification_status: 'verified' })
    .eq('user_id', submission.farmer_id)
    .select('id');
  if (transporterError) throw transporterError;
  if (transporterRows && transporterRows.length > 0) {
    await logAudit(adminId, 'transporter.approved', { submission_id: submission.id, user_id: submission.farmer_id });
  }
  await logAudit(adminId, 'verification.approved', { submission_id: submission.id, farmer_id: submission.farmer_id });
  return getSingle(updated);
}

async function rejectVerification(adminId, submissionId, note) {
  if (typeof note !== 'string' || !note.trim()) {
    throw new AppError(422, 'VALIDATION_ERROR', 'A review note is required to reject a verification.');
  }
  const submission = await fetchSubmission(submissionId);
  if (submission.status !== 'pending') {
    throw new AppError(409, 'VERIFICATION_NOT_PENDING', 'Only a pending verification can be rejected.');
  }
  const now = new Date().toISOString();
  const { data: updated, error } = await supabaseAdmin
    .from('verification_submissions')
    .update({ status: 'rejected', review_note: note.trim(), reviewed_by: adminId, reviewed_at: now })
    .eq('id', submissionId)
    .select('*');
  if (error) throw error;
  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .update({ verification_status: 'rejected' })
    .eq('id', submission.farmer_id);
  if (profileError) throw profileError;
  // Stage 6: rejecting a transporter submission also rejects the
  // transporters row for that user (no second admin queue).
  const { data: transporterRows, error: transporterError } = await supabaseAdmin
    .from('transporters')
    .update({ verification_status: 'rejected' })
    .eq('user_id', submission.farmer_id)
    .select('id');
  if (transporterError) throw transporterError;
  if (transporterRows && transporterRows.length > 0) {
    await logAudit(adminId, 'transporter.rejected', { submission_id: submission.id, user_id: submission.farmer_id });
  }
  await logAudit(adminId, 'verification.rejected', { submission_id: submission.id, farmer_id: submission.farmer_id });
  return getSingle(updated);
}

// Admin views a farmer's document via a short-lived signed URL from the
// private bucket. A submission whose document is not under
// verification-docs/ (e.g. a Stage 1-era public-bucket path) is refused
// with 422 — it is never served as a public URL. The audit write is best
// effort: a failing insert must never break the response.
async function getDocumentSignedUrl(adminId, submissionId) {
  const submission = await fetchSubmission(submissionId);
  if (typeof submission.document_path !== 'string'
    || !submission.document_path.startsWith(`${DOCUMENT_BUCKET}/`)) {
    throw new AppError(422, 'VALIDATION_ERROR', 'document is not stored in the private bucket.');
  }
  const { data, error } = await supabaseAdmin.storage
    .from(DOCUMENT_BUCKET)
    .createSignedUrl(submission.document_path, SIGNED_URL_TTL_SECONDS);
  if (error || !data || !data.signedUrl) {
    throw new AppError(500, 'DOCUMENT_URL_FAILED', 'Could not generate a document link. Please try again.');
  }
  await logAudit(adminId, 'verification.document_viewed', { submission_id: submission.id });
  return { signedUrl: data.signedUrl, expiresIn: SIGNED_URL_TTL_SECONDS };
}

// Admin user list, newest first. Only the fields the admin UI needs.
async function listRoles({ page, pageSize } = {}) {
  const { page: p, pageSize: ps } = parsePage({ page, pageSize });
  const { data: rows, count, error } = await supabaseAdmin
    .from('profiles')
    .select('id,first_name,last_name,email_address,role,verification_status,created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((p - 1) * ps, p * ps - 1);
  if (error) throw error;
  const data = (rows || []).map((r) => ({
    id: r.id,
    first_name: r.first_name,
    last_name: r.last_name,
    email_address: r.email_address,
    role: r.role,
    verification_status: r.verification_status,
    created_at: r.created_at,
  }));
  return { data, pagination: paginationResult(p, ps, count ?? data.length) };
}

// Admin changes a user's role. The caller is NOT checked here — the admin
// router's requireAdmin is the authorization point (see the M1 test in
// verification.test.js). Self-change is refused so an admin cannot lock
// themselves out of the admin routes.
async function changeRole(adminId, userId, role) {
  if (!ROLES.includes(role)) {
    throw new AppError(422, 'VALIDATION_ERROR', 'role must be buyer, farmer or admin.');
  }
  if (userId === adminId) {
    throw new AppError(409, 'ROLE_SELF_CHANGE', 'An admin cannot change their own role.');
  }
  const target = await fetchProfile(userId);
  if (!target) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  const { data: updated, error } = await supabaseAdmin
    .from('profiles')
    .update({ role })
    .eq('id', userId)
    .select('id,role,verification_status');
  if (error) throw error;
  const row = getSingle(updated);
  await logAudit(adminId, 'role.changed', { user_id: userId, role });
  return { id: row.id, role: row.role, verification_status: row.verification_status };
}

module.exports = {
  submitVerification,
  listVerifications,
  approveVerification,
  rejectVerification,
  getDocumentSignedUrl,
  listRoles,
  changeRole,
};
