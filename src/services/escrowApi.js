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

// Admin & platform intelligence (Stage 10, module I). Contract shapes:
// GET /api/admin/metrics → { metrics: { total_orders, gmv_paise,
// median_realisation_paise, mandi_modal_paise, dispute_rate,
// dispute_count, avg_resolution_hours, on_time_rate, group_selling:
// { groups_total, groups_closed, pooled_quantity, pooled_gmv_paise },
// notification_delivery: { sent, failed, deferred, pending } } } —
// every value a real number or null (null = no data; mandi_modal_paise
// is null until Stage 3 FairPrice lands).
export async function adminMetricsFetch() {
  return adminFetch('/metrics');
}

// GET /api/admin/reconciliation → { stuck: [ { order_id, category,
// amount_paise, order_status, payment_status, created_at } ] } with
// category in ('confirmed_unpaid','completed_held','refund_reconcile').
export async function adminReconciliationFetch() {
  return adminFetch('/reconciliation');
}

// Moderation (/api/admin/moderation/*). The suspend/reinstate POSTs are
// the contract: suspend → { user: { id, role, suspended_at },
// listings_hidden: n }; reinstate → { user: { id, role,
// suspended_at: null }, listings_restored: n }.
// The lookup GET below was not in the original brief's contract (it listed
// only the two POSTs); the coordinator confirmed Unit A ships
// GET /api/admin/moderation/:query (id or email) returning
// { user: { id, role, suspended_at } }. If it 404s, the page shows the
// lookup error honestly and the buttons still work from the entered id,
// since the POSTs return the user themselves.
export async function moderationFetch(path, opts = {}) {
  return adminFetch(`/moderation${path}`, opts);
}

export async function getModerationUser(query) {
  return moderationFetch(`/${encodeURIComponent(query)}`);
}

export async function suspendUser(userId) {
  return moderationFetch(`/${encodeURIComponent(userId)}/suspend`, { method: 'POST' });
}

export async function reinstateUser(userId) {
  return moderationFetch(`/${encodeURIComponent(userId)}/reinstate`, { method: 'POST' });
}

// Public transparency metrics (Stage 10). No session required:
// GET /api/transparency → { metrics: { <same aggregated fields as
// /api/admin/metrics> } } — aggregated only, never per-user data.
export async function transparencyFetch() {
  const res = await fetch(`${ESCROW_API_URL}/api/transparency`);

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const error = new Error(data.error || data.message || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }

  return data;
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

// Notifications (Stage 9, module H). Contract: GET /api/notifications
// returns { notifications, unread_count }; PATCH /:id/read returns
// { notification }; GET/PATCH /preferences carry { preferences } with
// one row per event type the user has set — missing rows use the
// defaults (enabled, in_app only, Hindi, no quiet hours), which the
// page renders, never invented server-side.
export async function notificationFetch(path, opts = {}) {
  return authedFetch('/api/notifications', path, opts);
}

export async function listNotifications({ unreadOnly = false, limit = 20, offset = 0 } = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (unreadOnly) params.set('unread_only', 'true');
  return notificationFetch(`?${params.toString()}`);
}

export async function markNotificationRead(id) {
  return notificationFetch(`/${encodeURIComponent(id)}/read`, { method: 'PATCH' });
}

export async function getNotificationPreferences() {
  return notificationFetch('/preferences');
}

export async function updateNotificationPreferences(preferences) {
  return notificationFetch('/preferences', { method: 'PATCH', body: { preferences } });
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
