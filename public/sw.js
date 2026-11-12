// Farmer Marketplace service worker (Stage 11, Unit B).
// Cache-first for same-origin static assets (JS/CSS/images/fonts);
// network-first for /api/* and Supabase calls. Auth and payment
// responses are never cached: any request with an Authorization header,
// and any /api/escrow or /api/razorpay request, is network-only.
const CACHE_NAME = 'farmer-marketplace-v1';
const STATIC_PATTERN = /\.(?:js|css|png|jpg|jpeg|webp|svg|woff2?|ttf)$/;

self.addEventListener('install', (event) => {
  // Activate immediately; no app-shell precache — runtime caching only,
  // so a stale shell can never be served ahead of a fresh deploy.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ).then(() => self.clients.claim()),
  );
});

function isNetworkOnly(request) {
  if (request.headers.has('Authorization')) return true;
  const url = new URL(request.url);
  return url.pathname.startsWith('/api/escrow') || url.pathname.startsWith('/api/razorpay');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (isNetworkOnly(request)) return; // network-only, never cached
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/') || url.hostname.endsWith('.supabase.co')) {
    // Network-first with NO caching: live data (orders, auth, payments)
    // must never be served stale from a cache, and auth/payment
    // responses are never stored. Offline order status is served from
    // localStorage by the app (OfflineOrderStatus), not from this worker.
    event.respondWith(fetch(request));
    return;
  }
  if (url.origin === self.location.origin && (url.pathname.startsWith('/assets/') || STATIC_PATTERN.test(url.pathname))) {
    // Cache-first for versioned static assets.
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
          }
          return response;
        });
      }),
    );
  }
});
