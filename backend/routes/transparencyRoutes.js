'use strict';
// Public transparency dashboard (Stage 10, module I). No auth: the
// metrics are aggregated platform totals only — no names, emails,
// phones, addresses, and no per-user rows. Same shape as GET
// /api/admin/metrics so the frontend renders one component from either
// source. Mounted at /api/transparency with its own rate limit in
// server.js — never behind requireAuth, so a suspended user's block
// cannot hide public numbers, and there is no user to check here.
//
// Small-N rule (audit finding 8): the public path suppresses exact
// amounts and rates while fewer than 5 rows underlie them
// (suppressSmallN: gmv / median realisation / pooled GMV /
// avg_resolution_hours / dispute_rate / on_time_rate are null below
// the threshold); counts stay exact. The admin endpoint calls the
// same service without the flag and always returns exact values.
const express = require('express');
const router = express.Router();
const adminMetricsService = require('../services/adminMetricsService');

router.get('/', async (req, res, next) => {
  try {
    const metrics = await adminMetricsService.getPlatformMetrics({ suppressSmallN: true });
    return res.json({ metrics });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
