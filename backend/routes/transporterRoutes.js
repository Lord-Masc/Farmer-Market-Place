'use strict';
// Transporter registration + listing (Stage 6, module E). Mounted at
// /api/transporters (the paths below are relative). Auth: every route
// requires a verified JWT. Registration is open to any authenticated
// user (the role flips to 'transporter' on register); the list shows
// VERIFIED transporters only — unverified transporters are never listed.
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const transporterService = require('../services/transporterService');

// Register as a transporter. Body: { vehicle_type, vehicle_number,
// service_areas, rate_paise_per_km?, flat_rate_paise? }.
router.post('/register', requireAuth, async (req, res, next) => {
  try {
    const result = await transporterService.registerTransporter(req.user.id, req.body || {});
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

// Verified transporters, for the shipper to choose from.
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const rows = await transporterService.listTransporters();
    return res.json({ transporters: rows });
  } catch (err) {
    return next(err);
  }
});

// The caller's own transporter row, whatever its status.
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const row = await transporterService.getMyTransporter(req.user.id);
    return res.json(row);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
