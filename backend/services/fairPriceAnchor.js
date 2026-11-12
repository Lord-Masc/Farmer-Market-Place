'use strict';
// FairPrice anchor (Stage 4, module C) — wired to Stage 3.
//
// The anchor is the latest modal mandi price for a crop, or null when
// there is no data (no rows, or the mandi_prices table not migrated
// yet). getAnchor already guards the missing table, so this stays a
// thin pass-through — the negotiation core never invents a price.
const { getAnchor } = require('./fairPriceService');

async function getFairPriceAnchor(crop) {
  return getAnchor(crop);
}

module.exports = { getFairPriceAnchor };
