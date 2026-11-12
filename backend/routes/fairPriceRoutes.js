'use strict';
// FairPrice routes (Stage 3, module B). Mounted at /api/fairprice.
//
// GET /:commodity?state=&mandi= — PUBLIC (mandi prices are public
//   data, like the transparency endpoint — no login needed to see a
//   price). Latest price + nearby mandis + change vs yesterday + 7-day
//   average, in one call. A commodity with no data answers
//   { no_data: true } — never a filled-in number.
// GET /:commodity/history?days=&state=&mandi= — PUBLIC. Daily modal
//   series (one point per date), change vs yesterday, 7-day average.
// GET /:commodity/net-earnings?quantity=&unit= — PUBLIC. Net earnings
//   for a quantity (quintals, or kg with unit=kg): mandi modal minus
//   the itemised platform estimates. { no_params: true } when no admin
//   has set the cost parameters yet.
// GET /cost-params — PUBLIC read of the current cost parameters
//   (writes stay admin-only, on /api/admin/cost-params).
// GET /alerts — the caller's own price alerts (requireAuth).
// POST /alerts — create a price alert (requireAuth). Body
//   { commodity, threshold_pct, basis, direction }.
// NOTE: /alerts and /cost-params are defined BEFORE /:commodity —
// Express would otherwise match "alerts" / "cost-params" as a
// commodity name.
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { rateLimit } = require('../middleware/security');
const { AppError } = require('../utils/errors');
const fairPriceService = require('../services/fairPriceService');

function cleanParam(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function latestHandler(req, res, next) {
  try {
    const commodity = cleanParam(req.params.commodity);
    if (!commodity) throw new AppError(400, 'VALIDATION_ERROR', 'commodity is required.');
    const state = cleanParam(req.query.state) || undefined;
    const mandi = cleanParam(req.query.mandi) || undefined;
    const latest = await fairPriceService.getLatestPrice(commodity, { state, mandi });
    if (!latest) {
      return res.status(200).json({
        commodity: fairPriceService.normaliseCommodity(commodity),
        no_data: true,
        source: fairPriceService.SOURCE,
        message: 'no data reported today',
      });
    }
    const [nearby, history] = await Promise.all([
      fairPriceService.getNearbyMandis(commodity, { state, mandi, date: latest.date }),
      fairPriceService.getHistory(commodity, { state, mandi, days: 8 }),
    ]);
    return res.status(200).json({
      ...latest,
      no_data: false,
      nearby,
      change_pct_vs_yesterday: history.change_pct_vs_yesterday,
      avg7_modal: history.avg7_modal,
    });
  } catch (err) {
    return next(err);
  }
}

async function historyHandler(req, res, next) {
  try {
    const commodity = cleanParam(req.params.commodity);
    if (!commodity) throw new AppError(400, 'VALIDATION_ERROR', 'commodity is required.');
    const days = Number(req.query.days) || 30;
    const history = await fairPriceService.getHistory(commodity, {
      state: cleanParam(req.query.state) || undefined,
      mandi: cleanParam(req.query.mandi) || undefined,
      days,
    });
    return res.status(200).json({ ...history, source: fairPriceService.SOURCE });
  } catch (err) {
    return next(err);
  }
}

async function listAlertsHandler(req, res, next) {
  try {
    const alerts = await fairPriceService.listAlerts(req.user.id);
    return res.status(200).json({ alerts });
  } catch (err) {
    return next(err);
  }
}

async function createAlertHandler(req, res, next) {
  try {
    const alert = await fairPriceService.createAlert(req.user.id, req.body || {});
    return res.status(201).json({ alert });
  } catch (err) {
    return next(err);
  }
}

async function listCostParamsHandler(req, res, next) {
  try {
    const params = await fairPriceService.listCostParams();
    return res.status(200).json({ params });
  } catch (err) {
    return next(err);
  }
}

// Net earnings for a quantity of a commodity: mandi modal minus the
// itemised platform estimates (transport, commission, packaging,
// platform fee, wastage). The maths lives in the service — one
// implementation, pinned by literals in fairPriceService.test.js.
// quantity is in quintals unless unit=kg. { no_data: true } when there
// is no mandi price; { no_params: true } when no admin has set the
// cost parameters yet — both honest empty states, never a number.
async function netEarningsHandler(req, res, next) {
  try {
    const commodity = cleanParam(req.params.commodity);
    if (!commodity) throw new AppError(400, 'VALIDATION_ERROR', 'commodity is required.');
    const quantity = Number(req.query.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'quantity must be a number greater than 0.');
    }
    const unit = cleanParam(req.query.unit) || 'quintal';
    if (unit !== 'quintal' && unit !== 'kg') {
      throw new AppError(400, 'VALIDATION_ERROR', "unit must be 'quintal' or 'kg'.");
    }
    const quantityQuintals = unit === 'kg' ? quantity / 100 : quantity;
    const state = cleanParam(req.query.state) || undefined;
    const mandi = cleanParam(req.query.mandi) || undefined;
    const latest = await fairPriceService.getLatestPrice(commodity, { state, mandi });
    if (!latest || !latest.primary) {
      return res.status(200).json({
        commodity: fairPriceService.normaliseCommodity(commodity),
        no_data: true,
        source: fairPriceService.SOURCE,
        message: 'no data reported today',
      });
    }
    const params = await fairPriceService.getCostParams({ state });
    if (!params) {
      return res.status(200).json({
        commodity: latest.commodity,
        date: latest.date,
        modal_price: latest.primary.modal_price,
        no_params: true,
        source: fairPriceService.SOURCE,
        message: 'cost parameters not set yet — an admin sets them first',
      });
    }
    const earnings = fairPriceService.computeNetEarnings({
      modalPriceRupees: latest.primary.modal_price,
      quantityQuintals,
      costParams: params,
    });
    if (!earnings) throw new AppError(500, 'NET_EARNINGS_FAILED', 'Could not compute net earnings from the current cost parameters.');
    return res.status(200).json({
      commodity: latest.commodity,
      date: latest.date,
      source: latest.source,
      modal_price: latest.primary.modal_price,
      mandi: latest.primary.mandi,
      quantity_quintals: quantityQuintals,
      earnings,
    });
  } catch (err) {
    return next(err);
  }
}

router.get('/alerts', rateLimit({ max: 30 }), requireAuth, listAlertsHandler);
router.post('/alerts', rateLimit({ max: 30 }), requireAuth, createAlertHandler);
router.get('/cost-params', rateLimit({ max: 60 }), listCostParamsHandler);
router.get('/:commodity/net-earnings', rateLimit({ max: 60 }), netEarningsHandler);
router.get('/:commodity/history', rateLimit({ max: 60 }), historyHandler);
router.get('/:commodity', rateLimit({ max: 60 }), latestHandler);

module.exports = router;
