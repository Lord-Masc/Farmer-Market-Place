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
