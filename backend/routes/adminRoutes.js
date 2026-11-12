'use strict';
// Admin routes (Stage 1, trust foundation). Mounted at /api/admin.
// Every route requires a verified JWT (requireAuth) AND the admin role
// (requireAdmin, which reads profiles.role fresh per request). No admin
// exists until the bootstrap UPDATE in 2026-11-16_trust_foundation.sql
// runs — until then every route here 403s.
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { requireAdmin } = require('../middleware/requireRole');
const { AppError } = require('../utils/errors');
const verificationService = require('../services/verificationService');
const adminMetricsService = require('../services/adminMetricsService');
const moderationService = require('../services/moderationService');
const fairPriceService = require('../services/fairPriceService');

router.use(requireAuth, requireAdmin);

// Review queue, newest first. ?status=pending|approved|rejected&page=&pageSize=
router.get('/verifications', async (req, res, next) => {
  try {
    const result = await verificationService.listVerifications({
      status: req.query.status,
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// Signed URL for one submission's document (Stage 2 hardening). The
// document lives in the private verification-docs bucket, so the admin
// queue fetches a 5-minute signed URL on demand instead of building a
// public URL. requireAuth + requireAdmin already apply to this router.
router.get('/verifications/:id/document', async (req, res, next) => {
  try {
    if (!req.params.id) throw new AppError(400, 'MISSING_FIELDS', 'Verification id is required.');
    const result = await verificationService.getDocumentSignedUrl(req.user.id, req.params.id);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// Approve a pending submission; the farmer becomes 'verified'.
router.post('/verifications/:id/approve', async (req, res, next) => {
  try {
    if (!req.params.id) throw new AppError(400, 'MISSING_FIELDS', 'Verification id is required.');
    const row = await verificationService.approveVerification(req.user.id, req.params.id);
    return res.json(row);
  } catch (err) {
    return next(err);
  }
});

// Reject a pending submission; the farmer becomes 'rejected'. A note is required.
router.post('/verifications/:id/reject', async (req, res, next) => {
  try {
    if (!req.params.id) throw new AppError(400, 'MISSING_FIELDS', 'Verification id is required.');
    const row = await verificationService.rejectVerification(req.user.id, req.params.id, req.body && req.body.note);
    return res.json(row);
  } catch (err) {
    return next(err);
  }
});

// User/role list, newest first. ?page=&pageSize=
router.get('/roles', async (req, res, next) => {
  try {
    const result = await verificationService.listRoles({
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// Change a user's role. Body: { role: 'buyer'|'farmer'|'admin' }.
router.post('/roles/:userId', async (req, res, next) => {
  try {
    if (!req.params.userId) throw new AppError(400, 'MISSING_FIELDS', 'User id is required.');
    const row = await verificationService.changeRole(req.user.id, req.params.userId, req.body && req.body.role);
    return res.json(row);
  } catch (err) {
    return next(err);
  }
});

// ---- Stage 10: Admin & Platform Intelligence (module I) ----
// All routes below sit under the same router.use(requireAuth,
// requireAdmin) above. The metrics are aggregated only — the service
// returns counts and sums, never per-user rows.

// Platform metrics (admin view — same shape as the public transparency
// endpoint, so one frontend component renders either source).
router.get('/metrics', async (req, res, next) => {
  try {
    const metrics = await adminMetricsService.getPlatformMetrics();
    return res.json({ metrics });
  } catch (err) {
    return next(err);
  }
});

// Stuck money: every order with money in a stuck state, from the
// admin_stuck_money view (migration 20261125_admin_views.sql).
router.get('/reconciliation', async (req, res, next) => {
  try {
    const stuck = await adminMetricsService.getStuckMoney();
    return res.json({ stuck });
  } catch (err) {
    return next(err);
  }
});

// Look up a user by UUID or by email, for the Moderation page's search
// box. The service returns the same generic 404 for every non-match,
// so the response never leaks which identifier was wrong.
router.get('/moderation/:query', async (req, res, next) => {
  try {
    if (!req.params.query) throw new AppError(400, 'MISSING_FIELDS', 'A user id or email is required.');
    const result = await moderationService.lookupUser(req.params.query);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// Suspend a user: sets profiles.suspended_at AND hides all of their
// products (that IS the takedown). See moderationService for semantics.
router.post('/moderation/:userId/suspend', async (req, res, next) => {
  try {
    if (!req.params.userId) throw new AppError(400, 'MISSING_FIELDS', 'User id is required.');
    const result = await moderationService.suspendUser(req.user.id, req.params.userId);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// Reinstate a user: clears suspended_at AND restores their products.
router.post('/moderation/:userId/reinstate', async (req, res, next) => {
  try {
    if (!req.params.userId) throw new AppError(400, 'MISSING_FIELDS', 'User id is required.');
    const result = await moderationService.reinstateUser(req.user.id, req.params.userId);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// ---- Stage 3: FairPrice cost parameters (module B) ----
// The net-earnings assumptions (transport, commission, packaging,
// platform fee, wastage). There is NO official dataset for these —
// they are platform estimates, set by an admin, labelled "estimated"
// everywhere they are shown. A PATCH never overwrites: it versions
// (new row, version+1; the old row stays for audit).
router.get('/cost-params', async (req, res, next) => {
  try {
    const params = await fairPriceService.listCostParams();
    return res.json({ params });
  } catch (err) {
    return next(err);
  }
});

// Create the first parameters for a scope (state + commodity_class;
// null = all). 409 when a current row already exists for that scope —
// PATCH it instead.
router.post('/cost-params', async (req, res, next) => {
  try {
    const param = await fairPriceService.createCostParams(req.user.id, req.body || {});
    return res.status(201).json({ param });
  } catch (err) {
    return next(err);
  }
});

// Version the parameters: supersedes row :id (must be current) with a
// new row carrying the merged values. Body: the five cost fields +
// optional state / commodity_class (unchanged when omitted).
router.patch('/cost-params/:id', async (req, res, next) => {
  try {
    if (!req.params.id) throw new AppError(400, 'MISSING_FIELDS', 'Cost parameters id is required.');
    const param = await fairPriceService.updateCostParams(req.params.id, req.user.id, req.body || {});
    return res.json({ param });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
