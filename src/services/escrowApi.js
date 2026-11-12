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
    throw new Error(data.error || data.message || `Request failed (${res.status})`);
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
