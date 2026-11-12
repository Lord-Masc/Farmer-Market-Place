'use strict';
// FairPrice anchor (Stage 4, module C) — the Stage 3 integration point.
//
// Stage 3 (FairPrice) is blocked: its mandi_prices table does NOT exist
// and no mandi price may be invented. Until Stage 3 wires this function
// to mandi_prices, it returns null and the negotiation core works fully
// without it — the thread response carries fairPriceAnchor: null.
function getFairPriceAnchor(/* crop */) {
  return null;
}

module.exports = { getFairPriceAnchor };
