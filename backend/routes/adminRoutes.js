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

module.exports = router;
