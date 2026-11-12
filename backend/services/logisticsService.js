'use strict';
// Logistics & Delivery (Stage 6, module E). Quote -> book -> track (GPS /
// status) -> proof of delivery (photo + OTP at handover). The ship button
// from Stage 0 now books a transporter instead of just flipping a status
// — but POST /api/escrow/ship-order is UNCHANGED (backward compat); book
// calls the same markOrderAsShipped internally.
//
// OTP (the brief's two requirements together force this shape): booking
// stores ONLY otp_hash (SHA-256 of salt+otp) + otp_salt — never the
// plaintext, never logged — AND the buyer must see the OTP on their
// tracking page. So the OTP is derived deterministically from the stored
// salt and the shipment id: deriveOtp(salt, id). The buyer track call
// recomputes it; verify hashes the candidate and compares in constant
// time. A 6-digit OTP is brute-forceable from a leaked hash anyway; the
// real guards are the 5-attempt / 15-minute lockout and that only the
// buyer ever sees the OTP in a response. The shipment id is generated
// here (randomUUID) so the OTP exists before the insert.
//
// Quote pricing is honest: flat_rate_paise if set, else
// rate_paise_per_km x haversine distance, rounded to integer paise.
// Pickup = farmer profile lat/lng; drop = buyer profile lat/lng (orders
// carry NO delivery coordinates — only delivery_address text — so the
// buyer profile is the only drop point in the schema). Missing
// coordinates + no flat rate -> 422 NO_ROUTE_DATA. The quote is
// ephemeral — NOT stored; booking recomputes it and 422s on mismatch.
//
// Delivery goes through verify-otp ONLY: PATCH /status rejects
// 'delivered' with 422. verify-otp calls the existing escrow release
// path (markOrderAsCompleted, buyer as actor — the OTP is the buyer's
// authorization at handover); an already-COMPLETED order is skipped so
// a retry after a partial success self-heals instead of 409ing.
// GPS trail: the service only ever appends one point per status update
// that carries coordinates; no API can rewrite the trail.
const crypto = require('crypto');
const supabaseAdmin = require('../utils/supabaseAdmin');
const { AppError, notAccessible } = require('../utils/errors');
const { logAudit } = require('../utils/auditLog');
const { markOrderAsShipped, markOrderAsCompleted } = require('./escrowService');

const EARTH_RADIUS_KM = 6371;
const OTP_MAX_ATTEMPTS = 5;
const OTP_LOCK_MINUTES = 15;
const PROOF_BUCKET = 'delivery-proofs';
const SIGNED_URL_TTL_SECONDS = 300;
const SHIPMENT_STATUSES = ['booked', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'cancelled'];

// Forward-only transitions. Cancel is allowed from booked/picked_up
// (by the transporter or the order's farmer); 'delivered' is absent on
// purpose — it goes through verify-otp only.
const ALLOWED_TRANSITIONS = {
  booked: ['picked_up', 'cancelled'],
  picked_up: ['in_transit', 'cancelled'],
  in_transit: ['out_for_delivery'],
  out_for_delivery: [],
  delivered: [],
  cancelled: [],
};

const getSingle = (data) => (data && data.length > 0 ? data[0] : null);
const isDuplicateKey = (error) => error && error.code === '23505';

// Haversine distance in km (R = 6371). Pure — hand-checked in tests.
function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

// 6-digit OTP derived from the stored salt + shipment id (see header).
function deriveOtp(salt, shipmentId) {
  const hex = crypto.createHash('sha256').update(`${salt}:${shipmentId}`).digest('hex');
  return String((parseInt(hex.slice(0, 8), 16) % 900000) + 100000);
}

function hashOtp(salt, otp) {
  return crypto.createHash('sha256').update(`${salt}${otp}`).digest('hex');
}

function publicShipment(row) {
  if (!row) return null;
  const out = { ...row };
  delete out.otp_hash;
  delete out.otp_salt;
  return out;
}

function validationError(message) {
  return new AppError(422, 'VALIDATION_ERROR', message);
}

async function fetchOrder(orderId) {
  const { data, error } = await supabaseAdmin.from('orders').select('*').eq('id', orderId);
  if (error) throw error;
  return getSingle(data);
}

// The order must exist AND belong to this farmer — same generic 404 as
// the escrow service, so callers cannot probe other farmers' orders.
async function fetchOrderForFarmer(orderId, farmerId) {
  const order = await fetchOrder(orderId);
  if (!order || order.farmer_id !== farmerId) throw notAccessible();
  return order;
}

async function fetchShipment(shipmentId) {
  const { data, error } = await supabaseAdmin.from('shipments').select('*').eq('id', shipmentId);
  if (error) throw error;
  const row = getSingle(data);
  if (!row) throw new AppError(404, 'SHIPMENT_NOT_FOUND', 'Shipment not found.');
  return row;
}

async function fetchTransporter(transporterId) {
  const { data, error } = await supabaseAdmin.from('transporters').select('*').eq('id', transporterId);
  if (error) throw error;
  const row = getSingle(data);
  if (!row) throw new AppError(404, 'TRANSPORTER_NOT_FOUND', 'Transporter not found.');
  return row;
}

async function fetchProfile(userId, columns = 'id,role,latitude,longitude') {
  const { data, error } = await supabaseAdmin.from('profiles').select(columns).eq('id', userId);
  if (error) throw error;
  return getSingle(data);
}

async function appendEvent(shipmentId, status, actorId, lat, lng) {
  const { error } = await supabaseAdmin.from('shipment_events').insert({
    shipment_id: shipmentId, status, actor_id: actorId || null,
    lat: lat ?? null, lng: lng ?? null, note: null,
  });
  if (error) throw error;
}

// Price for an order + transporter. Flat rate wins when set; otherwise
// per-km x haversine. Throws the 422s the quote/book contract names.
async function computeQuote(order, transporter) {
  if (transporter.flat_rate_paise !== null && transporter.flat_rate_paise !== undefined) {
    return { price_paise: transporter.flat_rate_paise, distance_km: null };
  }
  if (transporter.rate_paise_per_km === null || transporter.rate_paise_per_km === undefined) {
    throw new AppError(422, 'NO_RATE', 'This transporter has no rate set.');
  }
  const farmer = await fetchProfile(order.farmer_id);
  const buyer = await fetchProfile(order.buyer_id);
  const coords = [farmer && farmer.latitude, farmer && farmer.longitude, buyer && buyer.latitude, buyer && buyer.longitude];
  if (coords.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new AppError(422, 'NO_ROUTE_DATA', 'Pickup or delivery location is missing, so no distance can be computed.');
  }
  const distance = haversineKm(farmer.latitude, farmer.longitude, buyer.latitude, buyer.longitude);
  return {
    price_paise: Math.round(transporter.rate_paise_per_km * distance),
    distance_km: Math.round(distance * 100) / 100,
  };
}

// POST /api/shipments/quote — caller must be the order's farmer;
// transporter must be verified. Ephemeral: nothing is stored.
async function quoteShipment(farmerId, { order_id, transporter_id } = {}) {
  const order = await fetchOrderForFarmer(order_id, farmerId);
  const transporter = await fetchTransporter(transporter_id);
  if (transporter.verification_status !== 'verified') {
    throw new AppError(422, 'TRANSPORTER_NOT_VERIFIED', 'Only a verified transporter can be quoted.');
  }
  const { price_paise, distance_km } = await computeQuote(order, transporter);
  await logAudit(farmerId, 'shipment.quoted', { order_id, transporter_id, price_paise });
  return { price_paise, distance_km, currency: 'INR' };
}

// POST /api/shipments — caller is the order's farmer; order must be
// PAID. Server recomputes the quote (when a transporter is given) and
// 422s on price mismatch. Flips the order to SHIPPED via the existing
// escrow path and sets delivery_deadline to the committed window end.
async function bookShipment(farmerId, body = {}) {
  const { order_id, transporter_id, price_paise } = body;
  const windowStart = body.delivery_window_start;
  const windowEnd = body.delivery_window_end;
  if (!Number.isInteger(price_paise) || price_paise < 0) {
    throw validationError('price_paise must be a non-negative integer.');
  }
  const start = new Date(windowStart);
  const end = new Date(windowEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw validationError('delivery_window_end must be after delivery_window_start.');
  }
  const order = await fetchOrderForFarmer(order_id, farmerId);
  // One shipment per order: the UNIQUE backstop is the race guard, but
  // this read gives the clean 409 (the order is SHIPPED by now, so the
  // PAID check below would otherwise fire first on a re-booking).
  const { data: existing, error: existingError } = await supabaseAdmin
    .from('shipments')
    .select('id')
    .eq('order_id', order_id);
  if (existingError) throw existingError;
  if (getSingle(existing)) {
    throw new AppError(409, 'SHIPMENT_ALREADY_EXISTS', 'This order already has a shipment.');
  }
  if (order.status !== 'PAID') {
    throw new AppError(409, 'ORDER_NOT_SHIPPABLE', 'Only a paid order can be shipped.');
  }
  let transporter = null;
  if (transporter_id !== null && transporter_id !== undefined) {
    transporter = await fetchTransporter(transporter_id);
    if (transporter.verification_status !== 'verified') {
      throw new AppError(422, 'TRANSPORTER_NOT_VERIFIED', 'Only a verified transporter can be booked.');
    }
    const { price_paise: quoted } = await computeQuote(order, transporter);
    if (quoted !== price_paise) {
      throw new AppError(422, 'PRICE_MISMATCH', 'price_paise does not match the current quote.');
    }
  }

  const id = crypto.randomUUID();
  const salt = crypto.randomBytes(16).toString('hex');
  const otpHash = hashOtp(salt, deriveOtp(salt, id));
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from('shipments')
    .insert({
      id, order_id, transporter_id: transporter ? transporter.id : null,
      status: 'booked', price_paise,
      delivery_window_start: start.toISOString(), delivery_window_end: end.toISOString(),
      otp_hash: otpHash, otp_salt: salt, otp_attempts: 0, otp_locked_until: null,
      proof_photo_paths: [], gps_trail: [],
    })
    .select('*');
  if (insertError) {
    if (isDuplicateKey(insertError)) {
      throw new AppError(409, 'SHIPMENT_ALREADY_EXISTS', 'This order already has a shipment.');
    }
    throw insertError;
  }
  const shipment = getSingle(inserted);

  // Ship through the existing escrow path (PAID -> SHIPPED, farmer
  // ownership enforced there too). If it fails after the insert, remove
  // the orphan shipment so a retry can book cleanly.
  try {
    await markOrderAsShipped(order_id, farmerId);
  } catch (err) {
    await supabaseAdmin.from('shipments').delete().eq('id', id);
    throw err;
  }
  const { data: deadlineRows, error: deadlineError } = await supabaseAdmin
    .from('orders')
    .update({ delivery_deadline: end.toISOString() })
    .eq('id', order_id)
    .eq('status', 'SHIPPED')
    .select('*');
  if (deadlineError) throw deadlineError;
  if (!getSingle(deadlineRows)) {
    throw new AppError(500, 'ORDER_UPDATE_FAILED', 'Could not set the delivery deadline.');
  }
  await appendEvent(id, 'booked', farmerId);
  await logAudit(farmerId, 'shipment.booked', { shipment_id: id, order_id, transporter_id: shipment.transporter_id, price_paise });
  return publicShipment(shipment);
}

// The assigned transporter for a shipment (null when self-delivery).
async function shipmentTransporterUserId(shipment) {
  if (!shipment.transporter_id) return null;
  const transporter = await fetchTransporter(shipment.transporter_id);
  return transporter.user_id;
}

// PATCH /api/shipments/:id/status — transporter-only on own shipments
// (the order's farmer may cancel, and advances a self-delivery shipment
// — there the farmer IS the transporter). 'delivered' is rejected here.
async function updateShipmentStatus(callerId, shipmentId, { status, lat, lng } = {}) {
  const shipment = await fetchShipment(shipmentId);
  if (status === 'delivered') {
    throw new AppError(422, 'DELIVERY_REQUIRES_OTP', 'Delivery is confirmed through OTP verification only.');
  }
  if (!SHIPMENT_STATUSES.includes(status)) {
    throw validationError('status must be a valid shipment status.');
  }
  if (lat !== undefined || lng !== undefined) {
    const ok = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
    if (!ok(lat, -90, 90) || !ok(lng, -180, 180)) {
      throw validationError('lat must be between -90 and 90 and lng between -180 and 180.');
    }
  }
  const order = await fetchOrder(shipment.order_id);
  const transporterUserId = await shipmentTransporterUserId(shipment);
  const isTransporter = transporterUserId !== null && transporterUserId === callerId;
  const isFarmer = order && order.farmer_id === callerId;
  const isSelfDeliverer = shipment.transporter_id === null && isFarmer;
  if (status === 'cancelled') {
    if (!isTransporter && !isFarmer) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
    }
  } else if (!isTransporter && !isSelfDeliverer) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
  }
  if (!(ALLOWED_TRANSITIONS[shipment.status] || []).includes(status)) {
    throw new AppError(409, 'INVALID_TRANSITION', 'This status change is not allowed for the shipment.');
  }

  // GPS trail: append one point, never rewrite — the new value is the
  // old trail plus this point, nothing else.
  const trail = Array.isArray(shipment.gps_trail) ? shipment.gps_trail : [];
  const newTrail = (lat !== undefined && lng !== undefined)
    ? [...trail, { lat, lng, at: new Date().toISOString() }]
    : trail;
  const { data: updated, error } = await supabaseAdmin
    .from('shipments')
    .update({ status, gps_trail: newTrail })
    .eq('id', shipmentId)
    .eq('status', shipment.status)
    .select('*');
  if (error) throw error;
  const row = getSingle(updated);
  if (!row) {
    throw new AppError(409, 'INVALID_TRANSITION', 'This status change is not allowed for the shipment.');
  }
  await appendEvent(shipmentId, status, callerId, lat, lng);
  if (status === 'cancelled') {
    await logAudit(callerId, 'shipment.cancelled', { shipment_id: shipmentId, order_id: shipment.order_id });
  } else {
    await logAudit(callerId, 'shipment.status', { shipment_id: shipmentId, status });
  }
  return publicShipment(row);
}

// POST /api/shipments/:id/verify-otp — caller is the shipment's
// transporter (or the order's farmer for self-delivery). Requires BOTH a
// correct OTP and a proof photo path under delivery-proofs/. On success
// the payment releases through the existing escrow path, called with the
// order's buyer as actor (the OTP is the buyer's handover authorization).
async function verifyOtp(callerId, shipmentId, { otp, proof_photo_path } = {}) {
  const shipment = await fetchShipment(shipmentId);
  const order = await fetchOrder(shipment.order_id);
  const transporterUserId = await shipmentTransporterUserId(shipment);
  const isTransporter = transporterUserId !== null && transporterUserId === callerId;
  const isSelfDeliverer = shipment.transporter_id === null && order && order.farmer_id === callerId;
  if (!isTransporter && !isSelfDeliverer) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
  }
  if (shipment.status === 'delivered') {
    throw new AppError(409, 'SHIPMENT_ALREADY_DELIVERED', 'This shipment is already delivered.');
  }
  if (shipment.status === 'cancelled') {
    throw new AppError(409, 'INVALID_TRANSITION', 'A cancelled shipment cannot be delivered.');
  }
  if (shipment.otp_locked_until && new Date(shipment.otp_locked_until).getTime() > Date.now()) {
    throw new AppError(429, 'OTP_LOCKED', 'Too many failed attempts. Try again after the lockout ends.');
  }
  // Proof first: a missing photo never consumes an OTP attempt.
  if (typeof proof_photo_path !== 'string' || !proof_photo_path.startsWith(`${PROOF_BUCKET}/`)) {
    throw new AppError(422, 'PROOF_REQUIRED', 'A delivery proof photo is required.');
  }
  if (typeof otp !== 'string' || !otp) {
    throw validationError('otp is required.');
  }
  const candidateHash = hashOtp(shipment.otp_salt, otp);
  let matches = false;
  try {
    matches = crypto.timingSafeEqual(
      Buffer.from(candidateHash, 'hex'),
      Buffer.from(shipment.otp_hash, 'hex'),
    );
  } catch {
    matches = false;
  }
  if (!matches) {
    const attempts = (shipment.otp_attempts || 0) + 1;
    const locked = attempts >= OTP_MAX_ATTEMPTS
      ? new Date(Date.now() + OTP_LOCK_MINUTES * 60 * 1000).toISOString()
      : null;
    await supabaseAdmin
      .from('shipments')
      .update({ otp_attempts: attempts, otp_locked_until: locked })
      .eq('id', shipmentId);
    throw new AppError(401, 'INVALID_OTP', 'The OTP is incorrect.');
  }

  // Release the payment first: if the shipment update then fails, a
  // retry skips the escrow call (order already COMPLETED) and just
  // flips the shipment — the endpoint self-heals instead of stranding
  // the payment.
  if (!order || order.status !== 'COMPLETED') {
    if (!order) throw new AppError(404, 'ORDER_NOT_ACCESSIBLE', 'Order not found or not accessible.');
    await markOrderAsCompleted(order.id, order.buyer_id);
  }
  const { data: updated, error } = await supabaseAdmin
    .from('shipments')
    .update({
      status: 'delivered',
      proof_photo_paths: [...(shipment.proof_photo_paths || []), proof_photo_path],
      otp_attempts: 0,
      otp_locked_until: null,
    })
    .eq('id', shipmentId)
    .select('*');
  if (error) throw error;
  const row = getSingle(updated);
  await appendEvent(shipmentId, 'delivered', callerId);
  await logAudit(callerId, 'shipment.otp_verified', { shipment_id: shipmentId, order_id: shipment.order_id });
  await logAudit(callerId, 'shipment.delivered', { shipment_id: shipmentId, order_id: shipment.order_id });
  return publicShipment(row);
}

// GET /api/shipments/:id/track — buyer, farmer, assigned transporter,
// admin. Generic 404 for non-parties. Only the BUYER sees the OTP.
async function trackShipment(callerId, shipmentId) {
  const shipment = await fetchShipment(shipmentId).catch((err) => {
    if (err instanceof AppError && err.status === 404) {
      throw new AppError(404, 'SHIPMENT_NOT_ACCESSIBLE', 'Shipment not found or not accessible.');
    }
    throw err;
  });
  const order = await fetchOrder(shipment.order_id);
  const transporterUserId = await shipmentTransporterUserId(shipment);
  const profile = await fetchProfile(callerId, 'id,role');
  const isBuyer = order && order.buyer_id === callerId;
  const isFarmer = order && order.farmer_id === callerId;
  const isTransporter = transporterUserId !== null && transporterUserId === callerId;
  const isAdmin = profile && profile.role === 'admin';
  if (!isBuyer && !isFarmer && !isTransporter && !isAdmin) {
    throw new AppError(404, 'SHIPMENT_NOT_ACCESSIBLE', 'Shipment not found or not accessible.');
  }
  const { data: events, error: eventsError } = await supabaseAdmin
    .from('shipment_events')
    .select('*')
    .eq('shipment_id', shipmentId)
    .order('created_at', { ascending: true });
  if (eventsError) throw eventsError;
  const proofPhotoUrls = [];
  for (const path of shipment.proof_photo_paths || []) {
    // createSignedUrl takes the path INSIDE the bucket — strip the
    // 'delivery-proofs/' prefix the stored path carries.
    const innerPath = path.startsWith(`${PROOF_BUCKET}/`) ? path.slice(PROOF_BUCKET.length + 1) : path;
    const { data, error } = await supabaseAdmin.storage
      .from(PROOF_BUCKET)
      .createSignedUrl(innerPath, SIGNED_URL_TTL_SECONDS);
    if (error || !data || !data.signedUrl) {
      throw new AppError(500, 'PROOF_URL_FAILED', 'Could not generate a proof photo link. Please try again.');
    }
    proofPhotoUrls.push(data.signedUrl);
  }
  const out = {
    shipment: publicShipment(shipment),
    events: events || [],
    gps_trail: Array.isArray(shipment.gps_trail) ? shipment.gps_trail : [],
    proof_photos: proofPhotoUrls,
  };
  if (isBuyer) out.otp = deriveOtp(shipment.otp_salt, shipment.id);
  return out;
}

module.exports = {
  haversineKm,
  deriveOtp,
  hashOtp,
  quoteShipment,
  bookShipment,
  updateShipmentStatus,
  verifyOtp,
  trackShipment,
};
