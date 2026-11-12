'use strict';
// Typed application errors: services/controllers throw these for expected
// failures. The central error middleware turns them into safe client
// responses — no internal state, no existence oracle.
class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Generic "not found or not accessible" — deliberately the SAME message for
// a missing order and an order belonging to someone else, so callers cannot
// distinguish the two (no existence/ownership oracle).
const notAccessible = () =>
  new AppError(404, 'ORDER_NOT_ACCESSIBLE', 'Order not found or not accessible.');

// Central error handler (last middleware in server.js). Logs the full error
// server-side; the client only ever sees a generic message + stable code.
// (`_next` is unused but required: Express only treats a 4-arg function as
// an error handler.)
function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  // body-parser size limits (e.g. the 5 MB raw-image cap on /api/uploads):
  // answer 413, not a generic 500.
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large.', code: 'BODY_TOO_LARGE' });
  }
  console.error('Unhandled error:', err);
  return res.status(500).json({ error: 'Internal server error.', code: 'INTERNAL_ERROR' });
}

module.exports = { AppError, notAccessible, errorHandler };
