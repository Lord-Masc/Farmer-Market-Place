'use strict';
// Negotiation (Stage 4, module C).
// Service layer only — authorization lives in the route middleware
// (requireAuth / requireRole for the buyer/farmer routes); the
// counterparty checks live here because they depend on the row being
// acted on. All reads/writes go through the service-role client;
// PostgREST has no UPDATE policy on these tables, so there is no other
// path to a row.
//
// Immutability: there are no edit endpoints — a negotiation moves only by
// status transitions (open -> countered / accepted / rejected). The
// migration's BEFORE UPDATE trigger is the backstop: any update to an
// 'accepted' requirement/offer, or any update to an agreement, raises.
//
// Acceptance: the order is created through escrowService
// .createMarketplaceOrder with the LOCKED price as a unit-price override,
// so the order's price_at_order is the agreed price even if the farmer
// later edits the listing (Stage 0 price snapshot, regression on R2).
// The offer is claimed first (open -> accepted, gated on still-open);
// the agreement insert is second, keyed by a UNIQUE(offer_id), so a
// duplicate accept with the same Idempotency-Key replays the same
// agreement and order instead of creating a second one. Accepting one
// offer rejects the requirement's other open offers.
const supabaseAdmin = require('../utils/supabaseAdmin');
const { AppError } = require('../utils/errors');
const { logAudit } = require('../utils/auditLog');
const escrowService = require('./escrowService');
const { getFairPriceAnchor } = require('./fairPriceAnchor');

const getSingle = (data) => (data && data.length > 0 ? data[0] : null);

function validationError(message) {
  return new AppError(422, 'VALIDATION_ERROR', message);
}

function isNonEmptyString(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// A real calendar date (2026-13-40 passes Date.parse's leniency in some
// engines, so the components are checked back).
function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
  );
}

function isFutureDateTime(value) {
  if (typeof value !== 'string') return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time > Date.now();
}

function isExpired(offer) {
  const time = new Date(offer.expires_at).getTime();
  return !Number.isFinite(time) || time <= Date.now();
}

function validatePriceTiers(tiers) {
  if (tiers === undefined || tiers === null) return [];
  if (!Array.isArray(tiers) || tiers.length > 10) {
    throw validationError('price_tiers must be an array of at most 10 tiers.');
  }
  for (const tier of tiers) {
    if (
      !tier || typeof tier !== 'object'
      || positiveNumber(tier.min_quantity) === null
      || positiveNumber(tier.price) === null
    ) {
      throw validationError('each price tier needs a min_quantity and a price greater than 0.');
    }
  }
  return tiers;
}

function validateRequirementInput(body = {}) {
  const { crop, quantity, quality, delivery_window_start, delivery_window_end, target_price } = body;
  if (!isNonEmptyString(crop, 120)) {
    throw validationError('crop must be a non-empty string of at most 120 characters.');
  }
  const qty = positiveNumber(quantity);
  if (qty === null) throw validationError('quantity must be a number greater than 0.');
  if (quality !== undefined && quality !== null && (typeof quality !== 'string' || quality.length > 120)) {
    throw validationError('quality must be a string of at most 120 characters.');
  }
  if (!isValidDate(delivery_window_start) || !isValidDate(delivery_window_end)) {
    throw validationError('delivery window dates must be valid YYYY-MM-DD dates.');
  }
  if (delivery_window_end < delivery_window_start) {
    throw validationError('delivery_window_end must be on or after delivery_window_start.');
  }
  if (delivery_window_start < new Date().toISOString().slice(0, 10)) {
    throw validationError('delivery_window_start must not be in the past.');
  }
  const target = positiveNumber(target_price);
  if (target === null) throw validationError('target_price must be a number greater than 0.');
  return {
    crop: crop.trim(),
    quantity: qty,
    quality: quality === undefined || quality === null || quality === '' ? null : quality,
    delivery_window_start,
    delivery_window_end,
    target_price: target,
  };
}

function validateOfferInput(body = {}) {
  const { product_id, price, quantity, price_tiers, expires_at } = body;
  if (typeof product_id !== 'string' || !product_id.trim()) {
    throw validationError('product_id is required.');
  }
  const offerPrice = positiveNumber(price);
  if (offerPrice === null) throw validationError('price must be a number greater than 0.');
  const qty = positiveNumber(quantity);
  if (qty === null) throw validationError('quantity must be a number greater than 0.');
  const tiers = validatePriceTiers(price_tiers);
  if (!isFutureDateTime(expires_at)) {
    throw validationError('expires_at must be a future date and time.');
  }
  return { product_id: product_id.trim(), price: offerPrice, quantity: qty, price_tiers: tiers, expires_at };
}

async function fetchRequirement(requirementId) {
  const { data, error } = await supabaseAdmin
    .from('requirements')
    .select('*')
    .eq('id', requirementId);
  if (error) throw error;
  const requirement = getSingle(data);
  if (!requirement) {
    throw new AppError(404, 'NEGOTIATION_NOT_FOUND', 'Negotiation not found.');
  }
  return requirement;
}

async function fetchOffer(offerId) {
  const { data, error } = await supabaseAdmin
    .from('offers')
    .select('*')
    .eq('id', offerId);
  if (error) throw error;
  const offer = getSingle(data);
  if (!offer) {
    throw new AppError(404, 'NEGOTIATION_NOT_FOUND', 'Negotiation not found.');
  }
  return offer;
}

async function fetchAgreementByOffer(offerId) {
  const { data, error } = await supabaseAdmin
    .from('agreements')
    .select('*')
    .eq('offer_id', offerId);
  if (error) throw error;
  return getSingle(data);
}

async function fetchAgreementByRequirement(requirementId) {
  const { data, error } = await supabaseAdmin
    .from('agreements')
    .select('*')
    .eq('requirement_id', requirementId);
  if (error) throw error;
  return getSingle(data);
}

async function fetchOrder(orderId) {
  const { data, error } = await supabaseAdmin
    .from('orders')
    .select('*')
    .eq('id', orderId);
  if (error) throw error;
  return getSingle(data);
}

// The caller must be one of the two negotiating parties and must not be
// the maker of the latest offer — you cannot counter or accept your own
// offer. Anything else is a 403 (a missing row and a wrong party are
// indistinguishable here only in that both are never a 404: the offer
// itself was already fetched, so the caller knows it exists).
function assertCounterparty(callerId, requirement, offer) {
  const isParty = callerId === requirement.buyer_id || callerId === offer.farmer_id;
  if (!isParty || callerId === offer.created_by) {
    throw new AppError(403, 'FORBIDDEN', 'Only the counterparty can act on this offer.');
  }
}

async function createRequirement(buyerId, body) {
  const input = validateRequirementInput(body);
  const { data: inserted, error } = await supabaseAdmin
    .from('requirements')
    .insert({ buyer_id: buyerId, ...input, status: 'open' })
    .select('*');
  if (error) throw error;
  const requirement = getSingle(inserted);
  await logAudit(buyerId, 'requirement.created', { requirement_id: requirement.id, crop: requirement.crop });
  return requirement;
}

// A quote names the farmer's own listing: acceptance creates a real order
// through the escrow path, and orders.product_id is NOT NULL. The product
// lookup and the ownership check share one 403 so a missing product and
// someone else's product are indistinguishable (no existence oracle).
// No verified gate here: the codebase gates seller actions on the farmer
// role only (passport creation is the precedent) — verification_status
// gates public passport reads, not seller actions. Inventing a gate
// would block unverified farmers from quoting with no spec behind it.
async function createOffer(farmerId, requirementId, body) {
  const requirement = await fetchRequirement(requirementId);
  if (requirement.status !== 'open') {
    throw new AppError(409, 'REQUIREMENT_NOT_OPEN', 'This requirement is no longer open for offers.');
  }
  const input = validateOfferInput(body);
  const { data: productRows, error: productError } = await supabaseAdmin
    .from('products')
    .select('id,farmer_id')
    .eq('id', input.product_id);
  if (productError) throw productError;
  const product = getSingle(productRows);
  if (!product || product.farmer_id !== farmerId) {
    throw new AppError(403, 'FORBIDDEN', 'You can only quote on your own product.');
  }
  const { data: inserted, error } = await supabaseAdmin
    .from('offers')
    .insert({
      requirement_id: requirement.id,
      farmer_id: farmerId,
      created_by: farmerId,
      product_id: input.product_id,
      price: input.price,
      quantity: input.quantity,
      price_tiers: input.price_tiers,
      expires_at: input.expires_at,
      status: 'open',
    })
    .select('*');
  if (error) throw error;
  const offer = getSingle(inserted);
  await logAudit(farmerId, 'offer.created', { requirement_id: requirement.id, offer_id: offer.id });
  return offer;
}

// A counter is a NEW offer row from the counterparty; the previous offer
// becomes 'countered' — invalidated, never editable. The old offer is
// claimed first (open -> countered, gated on still-open), so a concurrent
// counter cannot leave two live offers.
async function counterOffer(callerId, offerId, body) {
  const offer = await fetchOffer(offerId);
  const requirement = await fetchRequirement(offer.requirement_id);
  assertCounterparty(callerId, requirement, offer);
  if (offer.status !== 'open') {
    throw new AppError(409, 'OFFER_NOT_OPEN', 'This offer is no longer open.');
  }
  if (isExpired(offer)) {
    throw new AppError(409, 'OFFER_EXPIRED', 'This offer has expired.');
  }
  const input = validateOfferInput({ ...body, product_id: offer.product_id });
  const { data: claimed, error: claimError } = await supabaseAdmin
    .from('offers')
    .update({ status: 'countered' })
    .eq('id', offer.id)
    .eq('status', 'open')
    .select('*');
  if (claimError) throw claimError;
  if (!claimed || claimed.length === 0) {
    throw new AppError(409, 'OFFER_NOT_OPEN', 'This offer is no longer open.');
  }
  const { data: inserted, error } = await supabaseAdmin
    .from('offers')
    .insert({
      requirement_id: requirement.id,
      farmer_id: offer.farmer_id,
      created_by: callerId,
      product_id: offer.product_id,
      price: input.price,
      quantity: input.quantity,
      price_tiers: input.price_tiers,
      expires_at: input.expires_at,
      status: 'open',
    })
    .select('*');
  if (error) throw error;
  const counter = getSingle(inserted);
  await logAudit(callerId, 'offer.countered', { requirement_id: requirement.id, offer_id: offer.id, counter_offer_id: counter.id });
  await logAudit(callerId, 'offer.created', { requirement_id: requirement.id, offer_id: counter.id });
  return counter;
}

async function acceptOffer(callerId, offerId, body = {}, idempotencyKey) {
  const offer = await fetchOffer(offerId);
  const requirement = await fetchRequirement(offer.requirement_id);
  assertCounterparty(callerId, requirement, offer);

  // Already accepted: replay the same agreement when the caller retries
  // with the same Idempotency-Key (or when no agreement exists yet, the
  // earlier claim succeeded but the order insert did not — resume below).
  // Any other second accept is a 409, never a second order.
  let claimed = false;
  if (offer.status === 'accepted') {
    const existing = await fetchAgreementByOffer(offer.id);
    if (existing) {
      if (idempotencyKey && existing.idempotency_key === idempotencyKey) {
        return { agreement: existing, order: await fetchOrder(existing.order_id) };
      }
      throw new AppError(409, 'OFFER_ALREADY_ACCEPTED', 'This offer has already been accepted.');
    }
    if (!idempotencyKey) {
      throw new AppError(409, 'OFFER_ALREADY_ACCEPTED', 'This offer has already been accepted.');
    }
    claimed = true;
  } else if (offer.status !== 'open') {
    throw new AppError(409, 'OFFER_NOT_OPEN', 'This offer is no longer open.');
  }

  if (!claimed) {
    if (isExpired(offer)) {
      throw new AppError(409, 'OFFER_EXPIRED', 'This offer has expired.');
    }
    // Validated BEFORE the claim: a missing address must not leave the
    // offer stuck 'accepted' with no order behind it.
    if (!body || typeof body.delivery_address !== 'string' || !body.delivery_address.trim()) {
      throw new AppError(400, 'MISSING_FIELDS', 'Product, quantity and delivery address are required.');
    }
    const { data: claimedRows, error: claimError } = await supabaseAdmin
      .from('offers')
      .update({ status: 'accepted' })
      .eq('id', offer.id)
      .eq('status', 'open')
      .select('*');
    if (claimError) throw claimError;
    if (!claimedRows || claimedRows.length === 0) {
      const existing = await fetchAgreementByOffer(offer.id);
      if (existing && idempotencyKey && existing.idempotency_key === idempotencyKey) {
        return { agreement: existing, order: await fetchOrder(existing.order_id) };
      }
      throw new AppError(409, 'OFFER_ALREADY_ACCEPTED', 'This offer has already been accepted.');
    }
  }

  // The order is created at the LOCKED price: the escrow path takes the
  // override instead of re-deriving from the listing, and the key + locked
  // price join the idempotency hash, so a retry replays the same order.
  const order = await escrowService.createMarketplaceOrder(
    requirement.buyer_id,
    {
      product_id: offer.product_id,
      quantity: offer.quantity,
      unit: 'kg',
      delivery_address: String(body.delivery_address).trim(),
      buyer_phone: body.buyer_phone,
    },
    idempotencyKey,
    { unitPriceOverride: offer.price },
  );

  // A retry that already created the order but not the agreement finds
  // the agreement here instead of inserting a second one.
  let agreement = await fetchAgreementByOffer(offer.id);
  if (!agreement) {
    const { data: inserted, error } = await supabaseAdmin
      .from('agreements')
      .insert({
        offer_id: offer.id,
        requirement_id: requirement.id,
        buyer_id: requirement.buyer_id,
        farmer_id: offer.farmer_id,
        locked_price: offer.price,
        locked_quantity: offer.quantity,
        delivery_window_start: requirement.delivery_window_start,
        delivery_window_end: requirement.delivery_window_end,
        order_id: order.id,
        idempotency_key: idempotencyKey || null,
      })
      .select('*');
    if (error) {
      // Lost a race with a concurrent accept: re-read; the UNIQUE(offer_id)
      // backstop means at most one agreement exists.
      if (error.code === '23505' || String(error.message || '').includes('duplicate key')) {
        agreement = await fetchAgreementByOffer(offer.id);
      }
      if (!agreement) throw error;
    } else {
      agreement = getSingle(inserted);
    }
  }

  await supabaseAdmin
    .from('requirements')
    .update({ status: 'accepted' })
    .eq('id', requirement.id)
    .eq('status', 'open');

  // Accepting one offer rejects the requirement's other open offers —
  // the accepted offer already flipped, so it is not matched here.
  const { data: rejected } = await supabaseAdmin
    .from('offers')
    .update({ status: 'rejected' })
    .eq('requirement_id', requirement.id)
    .eq('status', 'open')
    .select('*');
  for (const row of rejected || []) {
    await logAudit(callerId, 'offer.rejected', { requirement_id: requirement.id, offer_id: row.id });
  }

  await logAudit(callerId, 'offer.accepted', { requirement_id: requirement.id, offer_id: offer.id, agreement_id: agreement.id, order_id: order.id });
  await logAudit(callerId, 'agreement.created', { requirement_id: requirement.id, offer_id: offer.id, agreement_id: agreement.id, order_id: order.id });
  return { agreement, order };
}

// Buyer's own requirements, newest first, each with its offer_count —
// the Requirements page list. One offers query for all rows, not one
// per requirement.
async function listRequirements(buyerId) {
  const { data: requirements, error } = await supabaseAdmin
    .from('requirements')
    .select('*')
    .eq('buyer_id', buyerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const rows = requirements || [];
  const counts = {};
  if (rows.length > 0) {
    const { data: offers, error: offersError } = await supabaseAdmin
      .from('offers')
      .select('requirement_id')
      .in('requirement_id', rows.map((r) => r.id));
    if (offersError) throw offersError;
    for (const offer of offers || []) {
      counts[offer.requirement_id] = (counts[offer.requirement_id] || 0) + 1;
    }
  }
  return { requirements: rows.map((r) => ({ ...r, offer_count: counts[r.id] || 0 })) };
}

// Thread view: requirement + its offers + agreement if any. Only the
// buyer, a quoting farmer, or an admin — anyone else gets the same
// generic 404 as a missing requirement (no existence oracle). The
// FairPrice anchor is null until Stage 3 wires it to mandi_prices.
async function getNegotiationThread(callerId, requirementId) {
  const requirement = await fetchRequirement(requirementId);
  const { data: offers, error: offersError } = await supabaseAdmin
    .from('offers')
    .select('*')
    .eq('requirement_id', requirement.id)
    .order('created_at', { ascending: true });
  if (offersError) throw offersError;
  const isParty = callerId === requirement.buyer_id
    || (offers || []).some((o) => o.farmer_id === callerId);
  if (!isParty) {
    const { data: profileRows, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', callerId);
    if (profileError) throw profileError;
    const profile = getSingle(profileRows);
    if (!profile || profile.role !== 'admin') {
      throw new AppError(404, 'NEGOTIATION_NOT_FOUND', 'Negotiation not found.');
    }
  }
  const agreement = await fetchAgreementByRequirement(requirement.id);
  return {
    requirement,
    offers: offers || [],
    agreement: agreement || null,
    fairPriceAnchor: getFairPriceAnchor(requirement.crop),
  };
}

module.exports = {
  createRequirement,
  listRequirements,
  createOffer,
  counterOffer,
  acceptOffer,
  getNegotiationThread,
};
