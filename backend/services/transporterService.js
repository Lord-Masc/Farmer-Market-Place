'use strict';
// Transporter registration + verification (Stage 6, module E). Reuses
// the Stage 1 trust flow — there is NO second admin queue: registration
// creates a verification_submissions row so the existing admin queue
// sees it, and the Stage 1 approve/reject service flips the
// transporters.verification_status alongside the profile.
//
// Registration sets the caller's role to 'transporter' (service role —
// the Stage 1 trigger blocks PostgREST role changes, backend
// service-role writes are allowed). A transporter has no verification
// document in this stage, so the submission's document_path is empty;
// the admin reviews vehicle details, not a document. At most one
// pending submission per user (partial unique index): if one already
// exists — e.g. a farmer verification filed before registering — it is
// reused instead of inserting a second.
const supabaseAdmin = require('../utils/supabaseAdmin');
const { AppError } = require('../utils/errors');
const { logAudit } = require('../utils/auditLog');

const getSingle = (data) => (data && data.length > 0 ? data[0] : null);
const isDuplicateKey = (error) => error && error.code === '23505';

function validationError(message) {
  return new AppError(422, 'VALIDATION_ERROR', message);
}

function publicTransporter(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    verification_status: row.verification_status,
    vehicle_type: row.vehicle_type,
    vehicle_number: row.vehicle_number,
    service_areas: row.service_areas,
    rate_paise_per_km: row.rate_paise_per_km,
    flat_rate_paise: row.flat_rate_paise,
    rating: row.rating,
  };
}

// POST /api/transporters/register — any authenticated user. Second
// registration -> 409. At least one rate is required: a transporter
// with no rate cannot be quoted.
async function registerTransporter(userId, body = {}) {
  const vehicleType = typeof body.vehicle_type === 'string' ? body.vehicle_type.trim() : '';
  const vehicleNumber = typeof body.vehicle_number === 'string' ? body.vehicle_number.trim() : '';
  const areas = Array.isArray(body.service_areas)
    ? body.service_areas.map((a) => String(a).trim()).filter(Boolean)
    : [];
  const perKm = body.rate_paise_per_km;
  const flat = body.flat_rate_paise;
  const hasRate = (Number.isInteger(perKm) && perKm >= 0) || (Number.isInteger(flat) && flat >= 0);
  if (!vehicleType) throw validationError('vehicle_type is required.');
  if (!vehicleNumber) throw validationError('vehicle_number is required.');
  if (areas.length === 0) throw validationError('service_areas must be a non-empty array.');
  if (!hasRate) {
    throw validationError('At least one of rate_paise_per_km or flat_rate_paise is required.');
  }
  const { data: existing, error: existingError } = await supabaseAdmin
    .from('transporters')
    .select('*')
    .eq('user_id', userId);
  if (existingError) throw existingError;
  if (getSingle(existing)) {
    throw new AppError(409, 'TRANSPORTER_ALREADY_REGISTERED', 'You are already registered as a transporter.');
  }
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from('transporters')
    .insert({
      user_id: userId, verification_status: 'pending',
      vehicle_type: vehicleType, vehicle_number: vehicleNumber, service_areas: areas,
      rate_paise_per_km: Number.isInteger(perKm) ? perKm : null,
      flat_rate_paise: Number.isInteger(flat) ? flat : null,
      rating: null,
    })
    .select('*');
  if (insertError) {
    if (isDuplicateKey(insertError)) {
      throw new AppError(409, 'TRANSPORTER_ALREADY_REGISTERED', 'You are already registered as a transporter.');
    }
    throw insertError;
  }
  const transporter = getSingle(inserted);

  // One pending submission per user: reuse an existing one (e.g. a
  // farmer verification filed earlier) instead of a second row.
  const { data: pending, error: pendingError } = await supabaseAdmin
    .from('verification_submissions')
    .select('*')
    .eq('farmer_id', userId)
    .eq('status', 'pending');
  if (pendingError) throw pendingError;
  let submission = getSingle(pending);
  if (!submission) {
    const { data: subInserted, error: subError } = await supabaseAdmin
      .from('verification_submissions')
      .insert({ farmer_id: userId, document_path: '', status: 'pending' })
      .select('*');
    if (subError) {
      if (isDuplicateKey(subError)) {
        const { data: retry } = await supabaseAdmin
          .from('verification_submissions')
          .select('*')
          .eq('farmer_id', userId)
          .eq('status', 'pending');
        submission = getSingle(retry);
      } else {
        throw subError;
      }
    } else {
      submission = getSingle(subInserted);
    }
  }
  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .update({ role: 'transporter', verification_status: 'pending' })
    .eq('id', userId);
  if (profileError) throw profileError;
  await logAudit(userId, 'transporter.registered', { transporter_id: transporter.id, submission_id: submission && submission.id });
  return { transporter: publicTransporter(transporter), submission };
}

// GET /api/transporters — VERIFIED transporters only, for the shipper to
// choose from. Unverified transporters are never listed.
async function listTransporters() {
  const { data, error } = await supabaseAdmin
    .from('transporters')
    .select('*')
    .eq('verification_status', 'verified')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(publicTransporter);
}

// GET /api/transporters/mine — the caller's own row, whatever its status.
async function getMyTransporter(userId) {
  const { data, error } = await supabaseAdmin
    .from('transporters')
    .select('*')
    .eq('user_id', userId);
  if (error) throw error;
  const row = getSingle(data);
  if (!row) throw new AppError(404, 'TRANSPORTER_NOT_FOUND', 'You are not registered as a transporter.');
  return publicTransporter(row);
}

module.exports = { registerTransporter, listTransporters, getMyTransporter };
