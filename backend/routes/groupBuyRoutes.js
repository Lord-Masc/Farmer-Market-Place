'use strict';
// Smart Group Selling (Stage 5, module D). Mounted at /api/group-buys
// (the paths below are relative). Auth: every route requires a verified
// JWT. Role gates: only farmers create groups, join, negotiate and close
// — via the Stage 1 requireRole pattern (fresh DB role read per request,
// fail-closed). Negotiate and close have the farmer role at the route;
// the service enforces the owner check against the row being acted on
// (a role gate cannot express it). List, detail and settlement reads have
// requireAuth only: the service enforces the party check (settlement
// reads are owner / participant / admin, with a generic 404 otherwise).
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const groupBuyService = require('../services/groupBuyService');

const requireFarmer = requireRole('farmer');

// List groups. Query: ?status=open|closed|mine (default open).
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const result = await groupBuyService.listGroups(req.user.id, req.query || {});
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// Farmer opens a group buy. Body: { crop, threshold_quantity, deadline, unit? }.
router.post('/', requireAuth, requireFarmer, async (req, res, next) => {
  try {
    const row = await groupBuyService.createGroup(req.user.id, req.body || {});
    return res.status(201).json(row);
  } catch (err) {
    return next(err);
  }
});

// Group detail: the group, its participants, the pooled total, transport null.
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const detail = await groupBuyService.getGroupDetail(req.user.id, req.params.id);
    return res.json(detail);
  } catch (err) {
    return next(err);
  }
});

// Farmer joins a group. Body: { contribution_quantity }.
router.post('/:id/join', requireAuth, requireFarmer, async (req, res, next) => {
  try {
    const row = await groupBuyService.joinGroup(req.user.id, req.params.id, req.body || {});
    return res.status(201).json({ participant: row });
  } catch (err) {
    return next(err);
  }
});

// Owner negotiates as one buyer. Body: { target_price,
// delivery_window_start, delivery_window_end, quality? }.
router.post('/:id/negotiate', requireAuth, requireFarmer, async (req, res, next) => {
  try {
    const result = await groupBuyService.negotiateAsGroup(req.user.id, req.params.id, req.body || {});
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

// Owner closes the group. Body (direct path): { product_id,
// delivery_address, buyer_phone?, unit_price? }. Honour the
// Idempotency-Key so a retry with the same derived key replays the same
// order + settlements instead of creating a second close.
router.post('/:id/close', requireAuth, requireFarmer, async (req, res, next) => {
  try {
    const result = await groupBuyService.closeGroup(
      req.user.id,
      req.params.id,
      req.body || {},
      req.headers['idempotency-key'],
    );
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// Settlement view: the pooled order total in paise + one row per participant.
router.get('/:id/settlement', requireAuth, async (req, res, next) => {
  try {
    const result = await groupBuyService.getSettlement(req.user.id, req.params.id);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
