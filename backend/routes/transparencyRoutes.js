'use strict';
// Public transparency dashboard (Stage 10, module I). No auth: the
// metrics are aggregated platform totals only — no names, emails,
// phones, addresses, and no per-user rows. Same shape as GET
// /api/admin/metrics so the frontend renders one component from either
// source. Mounted at /api/transparency with its own rate limit in
// server.js — never behind requireAuth, so a suspended user's block
// cannot hide public numbers, and there is no user to check here.
const express = require('express');
const router = express.Router();
const adminMetricsService = require('../services/adminMetricsService');

router.get('/', async (req, res, next) => {
  try {
    const metrics = await adminMetricsService.getPlatformMetrics();
    return res.json({ metrics });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
