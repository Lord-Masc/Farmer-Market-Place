import { supabase } from './supabase';

// Escrow backend base URL. Override with VITE_ESCROW_API_URL in .env
// (e.g. the deployed backend URL); defaults to the local dev backend.
const ESCROW_API_URL = import.meta.env.VITE_ESCROW_API_URL || 'http://localhost:5001';

// Authenticated fetch against the backend. Attaches the caller's Supabase
// JWT as `Authorization: Bearer <token>`. Throws an Error (with the
// backend's message when available) on any failure, including when there
// is no signed-in session — callers surface the message through their
// existing login prompt / error UI instead of calling the backend
// anonymously.
async function authedFetch(base, path, { method = 'GET', body, headers = {} } = {}) {
  const { data: { session } } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Please log in to continue.');
  }

  const res = await fetch(`${ESCROW_API_URL}${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Attach the HTTP status so callers can tell a 403 (no access) from a
    // real error without matching the backend message string (the brittle
    // pattern VerificationQueue.jsx still uses — do not copy it).
    const error = new Error(data.error || data.message || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }

  return data;
}

// Escrow backend calls (/api/escrow/*).
export async function escrowFetch(path, opts = {}) {
  return authedFetch('/api/escrow', path, opts);
}

// Marketplace order creation (/api/orders/*) — the only order-creation path.
export async function ordersFetch(path, opts = {}) {
  return authedFetch('/api/orders', path, opts);
}

// Farmer verification (/api/verification/*).
export async function verificationFetch(path, opts = {}) {
  return authedFetch('/api/verification', path, opts);
}

// Admin review + roles (/api/admin/*).
export async function adminFetch(path, opts = {}) {
  return authedFetch('/api/admin', path, opts);
}

// Public passport reads (/api/farmers/:id/passport, /api/products/:id/passport).
// No session required: anyone may view a verified farmer's passport. Throws
// the backend's message on failure; the HTTP status is attached to the
// error so callers can tell a 404 (no verified passport) from a real error.
export async function publicPassportFetch(path) {
  const res = await fetch(`${ESCROW_API_URL}/api${path}`);

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const error = new Error(data.error || data.message || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }

  return data;
}

// Farmer's own passports (/api/passports/*): create + list own lots.
export async function passportFetch(path, opts = {}) {
  return authedFetch('/api/passports', path, opts);
}

// Negotiation (Stage 4, module C). Request bodies use the repo's house
// style (snake_case, as in passport/order calls) — the contract's
// camelCase names map: deliveryWindowStart → delivery_window_start,
// deliveryWindowEnd → delivery_window_end, targetPrice → target_price,
// expiresAt → expires_at. Response reads tolerate both casings.
export async function requirementsFetch(path, opts = {}) {
  return authedFetch('/api/requirements', path, opts);
}

// Counter / accept act on one offer (/api/offers/:id/*).
export async function offersFetch(path, opts = {}) {
  return authedFetch('/api/offers', path, opts);
}

// One negotiation thread (/api/negotiations/:id).
export async function negotiationsFetch(path, opts = {}) {
  return authedFetch('/api/negotiations', path, opts);
}

// Group buys (Stage 5, module D). Request bodies use the repo's house
// style (snake_case): threshold_quantity, contribution_quantity,
// target_price, delivery_window_start/end, product_id, unit_price,
// delivery_address, buyer_phone. Settlement amounts arrive in integer
// paise (amount_paise) — callers render them as rupees (paise / 100).
export async function groupBuysFetch(path, opts = {}) {
  return authedFetch('/api/group-buys', path, opts);
}

export async function listGroupBuys(status) {
  return groupBuysFetch(status ? `?status=${encodeURIComponent(status)}` : '/');
}

export async function getGroupBuy(id) {
  return groupBuysFetch(`/${id}`);
}

export async function createGroupBuy(body) {
  return groupBuysFetch('/', { method: 'POST', body });
}

export async function joinGroupBuy(id, body) {
  return groupBuysFetch(`/${id}/join`, { method: 'POST', body });
}

export async function negotiateGroupBuy(id, body) {
  return groupBuysFetch(`/${id}/negotiate`, { method: 'POST', body });
}

export async function closeGroupBuy(id, body) {
  // The backend replays the close only for this derived key — a retry
  // after a network failure returns the same order + settlements
  // instead of a 409, and nothing is ever duplicated.
  return groupBuysFetch(`/${id}/close`, {
    method: 'POST',
    body,
    headers: { 'Idempotency-Key': `group-buy-close-${id}` },
  });
}

export async function getGroupBuySettlement(id) {
  return groupBuysFetch(`/${id}/settlement`);
}

// Transporters + shipments (Stage 6, module E). Request bodies use the
// repo's house style (snake_case): vehicle_type, vehicle_number,
// service_areas, rate_paise_per_km, flat_rate_paise, order_id,
// transporter_id, price_paise, delivery_window_start/end, otp,
// proof_photo_path. Money arrives in integer paise — callers render it
// as rupees (paise / 100). The booking response carries no OTP; the
// track response carries `otp` only for the buyer.
export async function transporterFetch(path, opts = {}) {
  return authedFetch('/api/transporters', path, opts);
}

// Shipments (/api/shipments/*): quote, book, status, verify-otp, track.
export async function shipmentFetch(path, opts = {}) {
  return authedFetch('/api/shipments', path, opts);
}

// Verified-transporter list without a session (same unauthenticated
// pattern as publicPassportFetch); the list itself is public data.
export async function publicTransporterFetch(path) {
  const res = await fetch(`${ESCROW_API_URL}/api${path}`);

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const error = new Error(data.error || data.message || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }

  return data;
}

export async function listTransporters() {
  return transporterFetch('/');
}

export async function getMyTransporter() {
  return transporterFetch('/mine');
}

export async function registerTransporter(body) {
  return transporterFetch('/register', { method: 'POST', body });
}

export async function quoteShipment(body) {
  return shipmentFetch('/quote', { method: 'POST', body });
}

export async function createShipment(body) {
  return shipmentFetch('/', { method: 'POST', body });
}

export async function updateShipmentStatus(id, body) {
  return shipmentFetch(`/${id}/status`, { method: 'PATCH', body });
}

export async function verifyShipmentOtp(id, body) {
  return shipmentFetch(`/${id}/verify-otp`, { method: 'POST', body });
}

export async function getShipmentTrack(id) {
  return shipmentFetch(`/${id}/track`);
}

// Disputes (Stage 7, module F). Request bodies use the repo's house
// style (snake_case): order_id, category, description, status, outcome,
// amount_paise, note, body. Money arrives in integer paise — callers
// render it as rupees (paise / 100). Every dispute response carries
// is_overdue; evidence entries carry a 5-minute signed url — callers
// never construct a storage URL themselves.
export async function disputeFetch(path, opts = {}) {
  return authedFetch('/api/disputes', path, opts);
}

// Admin dispute actions (/api/admin/disputes/:id/*).
export async function adminDisputeFetch(path, opts = {}) {
  return authedFetch('/api/admin', path, opts);
}

export async function listDisputes(status) {
  return disputeFetch(status ? `?status=${encodeURIComponent(status)}` : '/');
}

export async function getDispute(id) {
  return disputeFetch(`/${id}`);
}

export async function createDispute(body) {
  return disputeFetch('/', { method: 'POST', body });
}

export async function postDisputeMessage(id, body) {
  return disputeFetch(`/${id}/message`, { method: 'POST', body });
}

export async function setDisputeStatus(id, body) {
  return adminDisputeFetch(`/disputes/${id}/status`, { method: 'POST', body });
}

export async function resolveDispute(id, body) {
  return adminDisputeFetch(`/disputes/${id}/resolve`, { method: 'POST', body });
}

export async function getDisputeStats() {
  // Aggregates only, but the route sits behind requireAuth — every viewer
  // of the Disputes page is logged in, so the authed fetch is correct.
  // resolution_rate / avg_resolution_hours are NULL when nothing is
  // resolved yet; callers render "No disputes yet", never an invented 0.
  return disputeFetch('/stats');
}

// AI Farmer Assistant (Stage 8, module G). Contract: POST
// /api/assistant/chat takes { message, conversation_id? } and returns
// { conversation_id, intent, entities, answer, sources[], no_data }.
// sources[] entries are { type, id, ... } — callers render only the
// fields the backend sent, never invented values. no_data means the
// answer is an explicit "no data / I don't know" — render it as such.
export async function assistantFetch(path, opts = {}) {
  return authedFetch('/api/assistant', path, opts);
}

export async function sendAssistantMessage(message, conversationId) {
  return assistantFetch('/chat', {
    method: 'POST',
    body: conversationId ? { message, conversation_id: conversationId } : { message },
  });
}

// Voice input (multipart, field `audio`). NO STT provider is configured
// — the backend answers 503 with a "voice input is not configured yet"
// message; callers surface that message honestly, never a fake
// transcript. FormData sets its own Content-Type (boundary), so no
// Content-Type header here — unlike authedFetch.
export async function sendAssistantVoice(formData) {
  const { data: { session } } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Please log in to continue.');
  }

  const res = await fetch(`${ESCROW_API_URL}/api/assistant/voice`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
    body: formData,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const error = new Error(data.error || data.message || `Voice request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }

  return data;
}

// Dispute evidence upload (multipart, field `file`, image only — the
// backend 422s non-images; the client checks the MIME type first as a
// hint only). FormData sets its own Content-Type (boundary), so no
// Content-Type header here — unlike authedFetch.
export async function uploadDisputeEvidence(id, file) {
  const { data: { session } } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Please log in to continue.');
  }

  const form = new FormData();
  form.append('file', file);

  const res = await fetch(`${ESCROW_API_URL}/api/disputes/${id}/evidence`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
    body: form,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const error = new Error(data.error || data.message || `Upload failed (${res.status})`);
    error.status = res.status;
    throw error;
  }

  return data;
}

// Delivery-proof upload (/api/uploads/image?kind=proof): same raw-body
// upload as uploadVerificationDocument, returns the storage path too —
// the transporter submits that path (not just the URL) to verify-otp.
// The path starts with `delivery-proofs/`.
export async function uploadProofPhoto(file) {
  const { data: { session } } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Please log in to continue.');
  }

  const res = await fetch(`${ESCROW_API_URL}/api/uploads/image?kind=proof`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: file,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || data.message || `Upload failed (${res.status})`);
  }

  return { publicUrl: data.publicUrl, path: data.path };
}

// Image upload (/api/uploads/*): the file goes as the raw request body so
// the backend can verify its real bytes (MIME + magic bytes) before it
// reaches storage. Client-side validateImageFile stays as the first gate.
export async function uploadImage(file, kind = 'product') {
  const { data: { session } } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Please log in to continue.');
  }

  const res = await fetch(`${ESCROW_API_URL}/api/uploads/image?kind=${kind}`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: file,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || data.message || `Upload failed (${res.status})`);
  }

  return data.publicUrl;
}

// Verification document upload (/api/uploads/image?kind=verification):
// same raw-body upload as uploadImage, but returns the storage path too —
// the farmer submits that path (not just the URL) to /api/verification/submit.
export async function uploadVerificationDocument(file) {
  const { data: { session } } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Please log in to continue.');
  }

  const res = await fetch(`${ESCROW_API_URL}/api/uploads/image?kind=verification`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: file,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || data.message || `Upload failed (${res.status})`);
  }

  return { publicUrl: data.publicUrl, path: data.path };
}
