'use strict';
// Shared hardening for the escrow backend: allowlisted CORS, security
// headers, and a small in-memory rate limiter. No new dependencies.
// Used by backend/server.js.

const cors = require('cors');

// The deployed frontend + local dev origins. Extra origins come from
// ALLOWED_ORIGINS (comma-separated) or FRONTEND_URL in the environment.
const DEFAULT_ORIGINS = [
  'https://farmer-market-place-mu.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
];

function allowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || '';
  const extra = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_ORIGINS, ...extra])];
}

// Origin allowlist. Requests with no Origin header (same-origin / curl /
// server-to-server) are allowed; a disallowed browser origin simply gets no
// ACAO headers, so the browser blocks the read.
const corsMiddleware = cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    return cb(null, allowedOrigins().includes(origin));
  },
  credentials: true,
});

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  return next();
}

// In-memory per-IP rate limiter (single-instance; each backend runs as one
// process). Returns 429 with a Retry-After hint when the budget is spent.
function rateLimit({ windowMs = 15 * 60 * 1000, max = 300 } = {}) {
  const hits = new Map(); // ip -> { count, resetAt }
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    let entry = hits.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return res
        .status(429)
        .json({ error: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' });
    }
    return next();
  };
}

module.exports = { corsMiddleware, securityHeaders, rateLimit, allowedOrigins };
