'use strict';
// Shared transport booking (Stage 6 integration point) — the Stage 5
// group detail response carries transport: null until Stage 6 wires this
// function to shared transport booking for a pooled lot.
//
// Stage 6 does not exist yet and no transport may be invented. Until it
// wires this function, it returns null and the group-selling core works
// fully without it — the detail response carries transport: null.
function getTransportBooking(/* group */) {
  return null;
}

module.exports = { getTransportBooking };
