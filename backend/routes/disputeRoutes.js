'use strict';
// Disputes & Trust Management (Stage 7, module F). Mounted at /api
// (the paths below are full paths, matching the negotiationRoutes
// pattern): party routes under /api/disputes, admin routes under
// /api/admin/disputes. Auth: every route requires a verified JWT.
// Admin routes add the Stage 1 requireAdmin (fresh DB role read,
// fail-closed); the service re-checks the admin role too.
// Counterparty checks live in the service (a role gate cannot express
// "the order's buyer or farmer").
// Evidence upload is multipart (field `file`): the route parses the
// raw multipart body with a small Buffer-based parser (no new
// dependency — the repo ships no multer/busboy) and validates the
// bytes with the Stage 0 upload validator (MIME + magic bytes, 5 MB
// cap) inside the service. A non-image file is a 422 per the contract.
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const { AppError } = require('../utils/errors');
const disputeService = require('../services/disputeService');

const requireAdmin = requireRole('admin');

// Minimal single-file multipart parser (Buffer-based, binary-safe):
// finds the part named "file" and returns { filename, contentType,
// data }. Only the shape browsers produce via FormData is supported
// (CRLF part separators, headers ending in a blank line); anything
// else is a 422, never a crash.
function parseMultipartFile(buffer, contentType) {
  const noFile = () => new AppError(422, 'INVALID_IMAGE', 'No file attached.');
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(contentType || '');
  if (!match || !Buffer.isBuffer(buffer) || buffer.length === 0) throw noFile();
  const delimiter = Buffer.from(`--${(match[1] || match[2]).trim()}`);
  const crlf = Buffer.from('\r\n');
  const dblCrlf = Buffer.from('\r\n\r\n');
  const dashdash = Buffer.from('--');
  let start = buffer.indexOf(delimiter);
  while (start !== -1) {
    let pos = start + delimiter.length;
    if (buffer.subarray(pos, pos + 2).equals(dashdash)) break;
    if (buffer.subarray(pos, pos + 2).equals(crlf)) pos += 2;
    const next = buffer.indexOf(delimiter, pos);
    if (next === -1) break;
    let part = buffer.subarray(pos, next);
    if (part.length >= 2 && part.subarray(part.length - 2).equals(crlf)) {
      part = part.subarray(0, part.length - 2);
    }
    const headerEnd = part.indexOf(dblCrlf);
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      if (/name="file"/.test(headers)) {
        const filename = (/filename="([^"]*)"/.exec(headers) || [])[1] || 'file';
        const type = (/content-type:\s*([^\r\n]+)/i.exec(headers) || [])[1];
        return { filename, contentType: (type || '').trim() || null, data: part.subarray(headerEnd + 4) };
      }
    }
    start = next;
  }
  throw noFile();
}

// Buyer/farmer files a dispute on their order.
// Body: { order_id, category, description }.
router.post('/disputes', requireAuth, async (req, res, next) => {
  try {
    const dispute = await disputeService.fileDispute(req.user.id, req.body || {});
    return res.status(201).json({ dispute });
  } catch (err) {
    return next(err);
  }
});

// Public aggregates from real disputes only (registered BEFORE /:id).
router.get('/disputes/stats', requireAuth, async (req, res, next) => {
  try {
    const stats = await disputeService.getDisputeStats();
    return res.json(stats);
  } catch (err) {
    return next(err);
  }
});

// Caller's own disputes as buyer/farmer; admin gets all (+ ?status=).
router.get('/disputes', requireAuth, async (req, res, next) => {
  try {
    const result = await disputeService.listDisputes(req.user.id, req.query || {});
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// One dispute: dispute + evidence (signed urls) + messages + shipment.
router.get('/disputes/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await disputeService.getDisputeDetail(req.user.id, req.params.id);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// Attach photo evidence (multipart, field `file`). Counterparty or
// admin only; non-image -> 422.
router.post('/disputes/:id/evidence', requireAuth, express.raw({ type: 'multipart/form-data', limit: '5mb' }), async (req, res, next) => {
  try {
    const file = parseMultipartFile(req.body, req.headers['content-type']);
    const result = await disputeService.addEvidence(req.user.id, req.params.id, {
      buffer: file.data, mime: file.contentType, filename: file.filename,
    });
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

// Post to the dispute thread. Counterparty or admin only.
router.post('/disputes/:id/message', requireAuth, async (req, res, next) => {
  try {
    const result = await disputeService.postMessage(req.user.id, req.params.id, (req.body || {}).body);
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

// Admin: move a dispute forward (filed -> under_review ->
// evidence_requested -> under_review). Body: { status }.
router.post('/admin/disputes/:id/status', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const result = await disputeService.updateStatus(req.user.id, req.params.id, (req.body || {}).status);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// Admin: resolve a dispute. Body: { outcome, amount_paise?, note }.
router.post('/admin/disputes/:id/resolve', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const result = await disputeService.resolveDispute(req.user.id, req.params.id, req.body || {});
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// Admin: run the SLA breach check now.
router.post('/admin/disputes/check-sla', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const result = await disputeService.checkSlaBreaches();
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports.parseMultipartFile = parseMultipartFile;
