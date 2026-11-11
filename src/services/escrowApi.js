import { supabase } from './supabase';

// Escrow backend base URL. Override with VITE_ESCROW_API_URL in .env
// (e.g. the deployed backend URL); defaults to the local dev backend.
const ESCROW_API_URL = import.meta.env.VITE_ESCROW_API_URL || 'http://localhost:5001';

// Authenticated fetch against the escrow backend (/api/escrow/*).
// Attaches the caller's Supabase JWT as `Authorization: Bearer <token>`.
// Throws an Error (with the backend's message when available) on any
// failure, including when there is no signed-in session — callers surface
// the message through their existing login prompt / error UI instead of
// calling the backend anonymously.
export async function escrowFetch(path, { method = 'GET', body } = {}) {
  const { data: { session } } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Please log in to continue.');
  }

  const res = await fetch(`${ESCROW_API_URL}/api/escrow${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || data.message || `Request failed (${res.status})`);
  }

  return data;
}
