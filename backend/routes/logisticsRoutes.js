'use strict';
// Logistics & Delivery (Stage 6, module E). Mounted at /api/shipments
// (the paths below are relative). Auth: every route requires a verified
// JWT. Ownership / party checks live in the service layer, keyed off
// req.user.id — a role gate cannot express "the order's farmer" or "the
// assigned transporter". The OTP endpoint gets a stricter limiter
// (10/min) on top of the mount-level 60/15min: it is the brute-force
// surface for a 6-digit code, and the service lockout is the second
// layer.
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { rateLimit } = require('../middleware/security');
const logisticsService = require('../services/logisticsService');

const otpLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

// Quote a shipment. Body: { order_id, transporter_id }.
router.post('/quote', requireAuth, async (req, res, next) => {
  try {
    const result = await logisticsService.quoteShipment(req.user.id, req.body || {});
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// Book a shipment. Body: { order_id, transporter_id?, price_paise,
// delivery_window_start, delivery_window_end }.
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const row = await logisticsService.bookShipment(req.user.id, req.body || {});
    return res.status(201).json(row);
  } catch (err) {
    return next(err);
  }
});

// Transporter status + GPS update. Body: { status, lat?, lng? }.
router.patch('/:id/status', requireAuth, async (req, res, next) => {
  try {
    const row = await logisticsService.updateShipmentStatus(req.user.id, req.params.id, req.body || {});
    return res.json(row);
  } catch (err) {
    return next(err);
  }
});

// Delivery: OTP + proof photo. Body: { otp, proof_photo_path }.
router.post('/:id/verify-otp', requireAuth, otpLimiter, async (req, res, next) => {
  try {
    const row = await logisticsService.verifyOtp(req.user.id, req.params.id, req.body || {});
    return res.json(row);
  } catch (err) {
    return next(err);
  }
});

// Tracking view: shipment + events + GPS trail + proof signed URLs.
// The buyer also sees the OTP here.
router.get('/:id/track', requireAuth, async (req, res, next) => {
  try {
    const result = await logisticsService.trackShipment(req.user.id, req.params.id);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
