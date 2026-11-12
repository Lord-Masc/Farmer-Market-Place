'use strict';
// Digital Crop Passport (Stage 2, module A). Mounted at /api (the paths
// below are full paths: the farmer routes live under /api/passports, the
// public reads under /api/farmers/:id/passport and
// /api/products/:id/passport, matching the frontend's passportFetch /
// publicPassportFetch helpers). The farmer routes require a verified JWT
// AND the farmer role (requireRole reads profiles.role fresh per request);
// the two public reads have no auth — the service enforces the
// verified-farmer gate and answers the same generic 404 for a missing
// farmer and an unverified one.
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const passportService = require('../services/passportService');

const requireFarmer = requireRole('farmer');

// Create a passport lot for one of the caller's own products.
// Body: { product_id, crop, variety?, quantity, unit, harvest_date,
// quality_grade, photos? } — mandi_price_reference is snapshotted
// server-side from the product's gov_price, never taken from the client.
router.post('/passports', requireAuth, requireFarmer, async (req, res, next) => {
  try {
    const row = await passportService.createPassport(req.user.id, req.body || {});
    return res.status(201).json(row);
  } catch (err) {
    return next(err);
  }
});

// The caller's own lots (with product names) plus their farmer_stats row.
router.get('/passports/mine', requireAuth, requireFarmer, async (req, res, next) => {
  try {
    const result = await passportService.listMyPassports(req.user.id);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// Public: a verified farmer's passport (farmer fields, stats, lots).
router.get('/farmers/:id/passport', async (req, res, next) => {
  try {
    const result = await passportService.getFarmerPassport(req.params.id);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// Public: a product's passport — null when the farmer is unverified or
// no lot exists; farmer_verified says which.
router.get('/products/:id/passport', async (req, res, next) => {
  try {
    const result = await passportService.getProductPassport(req.params.id);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
