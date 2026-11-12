'use strict';
// Negotiation (Stage 4, module C). Mounted at /api (the paths below are
// full paths, matching the passportRoutes pattern). Auth: every route
// requires a verified JWT. Role gates: only buyers post requirements,
// only farmers quote — both via the Stage 1 requireRole pattern (fresh
// DB role read per request, fail-closed). Counter, accept and the thread
// view have requireAuth only: the service enforces the counterparty
// check against the row being acted on (a role gate cannot express it).
// There are NO edit endpoints for requirements/offers — history is
// immutable by construction (status transitions only).
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const negotiationService = require('../services/negotiationService');

const requireBuyer = requireRole('buyer');
const requireFarmer = requireRole('farmer');

// Buyer lists their own requirements, each with its offer_count.
router.get('/requirements', requireAuth, requireBuyer, async (req, res, next) => {
  try {
    const result = await negotiationService.listRequirements(req.user.id);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// Buyer posts a requirement. Body: { crop, quantity, quality?,
// delivery_window_start, delivery_window_end, target_price }.
router.post('/requirements', requireAuth, requireBuyer, async (req, res, next) => {
  try {
    const row = await negotiationService.createRequirement(req.user.id, req.body || {});
    return res.status(201).json(row);
  } catch (err) {
    return next(err);
  }
});

// Farmer quotes on a requirement. Body: { product_id, price, quantity,
// price_tiers?, expires_at } — product_id is the farmer's own listing
// the quote is tied to (acceptance creates the order from it).
router.post('/requirements/:id/offers', requireAuth, requireFarmer, async (req, res, next) => {
  try {
    const row = await negotiationService.createOffer(req.user.id, req.params.id, req.body || {});
    return res.status(201).json(row);
  } catch (err) {
    return next(err);
  }
});

// Counterparty posts a counter-offer. Body: { price, quantity,
// price_tiers?, expires_at }. The previous offer becomes 'countered'.
router.post('/offers/:id/counter', requireAuth, async (req, res, next) => {
  try {
    const row = await negotiationService.counterOffer(req.user.id, req.params.id, req.body || {});
    return res.status(201).json(row);
  } catch (err) {
    return next(err);
  }
});

// Counterparty accepts. Body: { delivery_address, buyer_phone? }.
// Creates the order atomically at the locked price; honour the
// Idempotency-Key so a retry replays the same agreement and order.
router.post('/offers/:id/accept', requireAuth, async (req, res, next) => {
  try {
    const result = await negotiationService.acceptOffer(
      req.user.id,
      req.params.id,
      req.body || {},
      req.headers['idempotency-key'],
    );
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

// Thread view: requirement + its offers + agreement if any.
router.get('/negotiations/:id', requireAuth, async (req, res, next) => {
  try {
    const thread = await negotiationService.getNegotiationThread(req.user.id, req.params.id);
    return res.json(thread);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
