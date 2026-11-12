'use strict';
// Smart Group Selling (Stage 5, module D).
//
// COORDINATOR SEMANTICS — the group is a DEMAND pool. Farmers (acting as
// buyers) pool quantities of the same crop to buy wholesale as one buyer.
// The owner places the pooled order as buyer-representative. Settlement
// rows record each participant's SHARE OF THE POOLED ORDER TOTAL in
// integer paise (what they owe toward the pooled order) — never a
// "payout"; collection/reconciliation is a later stage. No transport is
// built here (Stage 6) — group detail carries transport: null via the
// groupTransport stub.
//
// Service layer only — authorization lives in the route middleware
// (requireAuth / requireRole for the farmer routes); the ownership and
// party checks live here because they depend on the row being acted on.
// All reads/writes go through the service-role client; PostgREST has no
// INSERT/UPDATE/DELETE policy on these tables, so there is no other path
// to a row.
//
// Close (claim-first, mirroring Stage 4 acceptOffer): the pooled order
// is created (or reused from the negotiated agreement) FIRST, shares are
// computed and settlement rows inserted while the group is still 'open',
// and only then is the close claimed with a gated update
// (status open -> closed, setting order_id + closed_at). The escrow order
// uses a key DERIVED from the group id, so a crash between order creation
// and the claim resumes to the same order on retry instead of creating a
// second one. A second close with that same derived key replays the
// existing order + settlements; any other second close is a 409 — the
// UNIQUE(group_buy_id, participant_id) backstop on settlements means a
// duplicate close can never duplicate a settlement row. The migration's
// BEFORE UPDATE trigger is the backstop: 'closed' is terminal and
// order_id / requirement_id are immutable once set.
const supabaseAdmin = require('../utils/supabaseAdmin');
const { AppError } = require('../utils/errors');
const { logAudit } = require('../utils/auditLog');
const negotiationService = require('./negotiationService');
const escrowService = require('./escrowService');
const { createSettlements } = require('./groupSettlementService');
const { getTransportBooking } = require('./groupTransport');

const getSingle = (data) => (data && data.length > 0 ? data[0] : null);

function validationError(message) {
  return new AppError(422, 'VALIDATION_ERROR', message);
}

function isDuplicateKey(error) {
  return error && (error.code === '23505' || String(error.message || '').includes('duplicate key'));
}

function isNonEmptyString(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isFutureDateTime(value) {
  if (typeof value !== 'string') return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time > Date.now();
}

// The close's idempotency key is derived from the group id — it is the
// key the escrow order is created under, and the key a client retries a
// close with. A retry replays; any other second close is a 409.
function derivedCloseKey(groupId) {
  return `group-buy-close-${groupId}`;
}

async function fetchGroup(groupId) {
  const { data, error } = await supabaseAdmin
    .from('group_buys')
    .select('*')
    .eq('id', groupId);
  if (error) throw error;
  const group = getSingle(data);
  if (!group) {
    throw new AppError(404, 'GROUP_BUY_NOT_FOUND', 'Group buy not found.');
  }
  return group;
}

async function fetchParticipants(groupId) {
  const { data, error } = await supabaseAdmin
    .from('group_buy_participants')
    .select('*')
    .eq('group_buy_id', groupId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// The in-memory mock has no SUM — totals are summed in JS, same as the
// Stage 5 offer guard in negotiationService.
function pooledTotal(participants) {
  return (participants || []).reduce((sum, p) => sum + Number(p.contribution_quantity), 0);
}

async function isAdmin(callerId) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', callerId);
  if (error) throw error;
  return getSingle(data)?.role === 'admin';
}

function assertOwner(callerId, group) {
  if (callerId !== group.owner_id) {
    throw new AppError(403, 'FORBIDDEN', 'Only the group owner can perform this action.');
  }
}

async function fetchOrder(orderId) {
  const { data, error } = await supabaseAdmin
    .from('orders')
    .select('*')
    .eq('id', orderId);
  if (error) throw error;
  return getSingle(data);
}

async function fetchSettlements(groupId) {
  const { data, error } = await supabaseAdmin
    .from('group_settlements')
    .select('*')
    .eq('group_buy_id', groupId);
  if (error) throw error;
  return data || [];
}

async function createGroup(ownerId, body = {}) {
  const { crop, threshold_quantity, deadline, unit } = body;
  if (!isNonEmptyString(crop, 120)) {
    throw validationError('crop must be a non-empty string of at most 120 characters.');
  }
  const threshold = positiveNumber(threshold_quantity);
  if (threshold === null) throw validationError('threshold_quantity must be a number greater than 0.');
  if (!isFutureDateTime(deadline)) {
    throw validationError('deadline must be a future date and time.');
  }
  const groupUnit = unit === undefined || unit === null ? 'kg' : unit;
  if (groupUnit !== 'kg' && groupUnit !== 'quintal') {
    throw validationError('unit must be kg or quintal.');
  }
  const { data: inserted, error } = await supabaseAdmin
    .from('group_buys')
    .insert({
      owner_id: ownerId,
      crop: crop.trim(),
      threshold_quantity: threshold,
      unit: groupUnit,
      deadline,
      status: 'open',
    })
    .select('*');
  if (error) throw error;
  const group = getSingle(inserted);
  await logAudit(ownerId, 'group_buy.created', { group_buy_id: group.id, crop: group.crop });
  return { ...group, total_quantity: 0, participant_count: 0 };
}

// Any authenticated user; ?status=open|closed|mine|all (default open). Each
// row carries the pooled total and the participant count. Newest first.
// 'mine' is owned-or-joined (the "My groups" tab) — it spans two tables,
// so it filters in JS after the fetch. 'all' is no filter.
async function listGroups(callerId, query = {}) {
  const status = query.status === undefined || query.status === null ? 'open' : query.status;
  let joinedIds = null;
  if (status === 'mine') {
    const { data: myParts, error: partsError } = await supabaseAdmin
      .from('group_buy_participants')
      .select('group_buy_id')
      .eq('user_id', callerId);
    if (partsError) throw partsError;
    joinedIds = new Set((myParts || []).map((p) => p.group_buy_id));
  }
  let builder = supabaseAdmin
    .from('group_buys')
    .select('*')
    .order('created_at', { ascending: false });
  if (status === 'open' || status === 'closed') {
    builder = builder.eq('status', status);
  } else if (status !== 'mine' && status !== 'all') {
    throw validationError('status must be open, closed, mine or all.');
  }
  const { data: groups, error } = await builder;
  if (error) throw error;
  let rows = groups || [];
  if (status === 'mine') {
    rows = rows.filter((g) => g.owner_id === callerId || joinedIds.has(g.id));
  }
  const totals = {};
  if (rows.length > 0) {
    const { data: participants, error: participantsError } = await supabaseAdmin
      .from('group_buy_participants')
      .select('*')
      .in('group_buy_id', rows.map((g) => g.id));
    if (participantsError) throw participantsError;
    for (const p of participants || []) {
      const entry = totals[p.group_buy_id] || (totals[p.group_buy_id] = { total: 0, count: 0 });
      entry.total += Number(p.contribution_quantity);
      entry.count += 1;
    }
  }
  return {
    group_buys: rows.map((g) => ({
      ...g,
      total_quantity: totals[g.id] ? totals[g.id].total : 0,
      participant_count: totals[g.id] ? totals[g.id].count : 0,
    })),
  };
}

async function getGroupDetail(callerId, groupId) {
  const group = await fetchGroup(groupId);
  const participants = await fetchParticipants(groupId);
  return {
    group_buy: group,
    participants: participants.map((p) => ({
      id: p.id,
      user_id: p.user_id,
      contribution_quantity: p.contribution_quantity,
      share: p.share,
      created_at: p.created_at,
    })),
    total_quantity: pooledTotal(participants),
    transport: await getTransportBooking(group),
  };
}

async function joinGroup(callerId, groupId, body = {}) {
  const contribution = positiveNumber(body.contribution_quantity);
  if (contribution === null) {
    throw validationError('contribution_quantity must be a number greater than 0.');
  }
  const group = await fetchGroup(groupId);
  if (group.status !== 'open') {
    throw new AppError(409, 'GROUP_NOT_OPEN', 'This group buy is no longer open.');
  }
  if (new Date(group.deadline).getTime() <= Date.now()) {
    throw new AppError(409, 'GROUP_DEADLINE_PASSED', 'The deadline for this group buy has passed.');
  }
  const { data: inserted, error } = await supabaseAdmin
    .from('group_buy_participants')
    .insert({ group_buy_id: group.id, user_id: callerId, contribution_quantity: contribution })
    .select('*');
  if (error) {
    // Lost a race with a concurrent join (or a plain double join): the
    // UNIQUE(group_buy_id, user_id) backstop means at most one row exists.
    if (isDuplicateKey(error)) {
      throw new AppError(409, 'GROUP_ALREADY_JOINED', 'You have already joined this group buy.');
    }
    throw error;
  }
  const participant = getSingle(inserted);
  await logAudit(callerId, 'group_buy.joined', { group_buy_id: group.id, participant_id: participant.id });
  return participant;
}

// Owner only. The group negotiates as ONE buyer through a Stage 4
// requirement whose quantity is the pooled total; the requirement is
// linked back to the group on both sides.
async function negotiateAsGroup(callerId, groupId, body = {}) {
  const group = await fetchGroup(groupId);
  assertOwner(callerId, group);
  if (group.status !== 'open') {
    throw new AppError(409, 'GROUP_NOT_OPEN', 'This group buy is no longer open.');
  }
  const participants = await fetchParticipants(groupId);
  const total = pooledTotal(participants);
  if (total < Number(group.threshold_quantity)) {
    throw new AppError(409, 'GROUP_THRESHOLD_NOT_MET', 'The pooled quantity has not reached the threshold yet.');
  }
  if (group.requirement_id) {
    throw new AppError(409, 'GROUP_REQUIREMENT_EXISTS', 'This group buy already has a requirement.');
  }
  const requirement = await negotiationService.createRequirement(callerId, {
    crop: group.crop,
    quantity: total,
    quality: body.quality,
    delivery_window_start: body.delivery_window_start,
    delivery_window_end: body.delivery_window_end,
    target_price: body.target_price,
    group_buy_id: group.id,
  });
  // Claim the link (gated on still-open with no requirement): a
  // concurrent negotiate cannot overwrite the link — the migration
  // trigger also blocks changing a set requirement_id.
  const { data: claimed, error: claimError } = await supabaseAdmin
    .from('group_buys')
    .update({ requirement_id: requirement.id })
    .eq('id', group.id)
    .eq('status', 'open')
    .is('requirement_id', null)
    .select('*');
  if (claimError) throw claimError;
  if (!claimed || claimed.length === 0) {
    throw new AppError(409, 'GROUP_REQUIREMENT_EXISTS', 'This group buy already has a requirement.');
  }
  await logAudit(callerId, 'group_buy.negotiated', { group_buy_id: group.id, requirement_id: requirement.id });
  return { requirement };
}

// Owner only. Ends 'closed' with exactly one order_id and exactly one
// settlement row per participant. Two paths, one outcome:
// - Negotiated: the group's requirement has an agreement — reuse its
//   order (verified: buyer is the owner, quantity is the pooled total).
//   No new order is created.
// - Direct: no agreement — the owner buys the pooled quantity from a
//   listing via the escrow path (stock check, cannot buy own product),
//   at an optional locked unit_price. A requirement with no agreement
//   yet and no product_id is a 409: the negotiation is still pending.
async function closeGroup(callerId, groupId, body = {}, idempotencyKey) {
  const group = await fetchGroup(groupId);
  assertOwner(callerId, group);

  // Already closed: a retry with the same derived key replays the
  // existing order + settlements; any other second close is a 409.
  // Nothing is duplicated either way.
  if (group.status === 'closed') {
    if (idempotencyKey && idempotencyKey === derivedCloseKey(group.id)) {
      const order = await fetchOrder(group.order_id);
      const settlements = await fetchSettlements(group.id);
      return { group_buy: group, order, settlements };
    }
    throw new AppError(409, 'GROUP_ALREADY_CLOSED', 'This group buy is already closed.');
  }
  if (group.status !== 'open') {
    throw new AppError(409, 'GROUP_ALREADY_CLOSED', 'This group buy is already closed.');
  }

  const participants = await fetchParticipants(groupId);
  const total = pooledTotal(participants);
  if (total < Number(group.threshold_quantity)) {
    throw new AppError(409, 'GROUP_THRESHOLD_NOT_MET', 'The pooled quantity has not reached the threshold yet.');
  }

  let order;
  if (group.requirement_id) {
    const { data: agreements, error: agreementError } = await supabaseAdmin
      .from('agreements')
      .select('*')
      .eq('requirement_id', group.requirement_id);
    if (agreementError) throw agreementError;
    const agreement = getSingle(agreements);
    if (agreement) {
      order = await fetchOrder(agreement.order_id);
      if (!order || order.buyer_id !== callerId || Number(order.quantity) !== total) {
        throw new AppError(409, 'GROUP_ORDER_MISMATCH', 'The negotiated order does not match the pooled quantity.');
      }
    } else if (!body.product_id) {
      throw new AppError(409, 'GROUP_NEGOTIATION_PENDING', 'The group negotiation has no agreement yet.');
    }
  }

  if (!order) {
    if (body.unit_price !== undefined && body.unit_price !== null
      && positiveNumber(body.unit_price) === null) {
      throw validationError('unit_price must be a number greater than 0.');
    }
    order = await escrowService.createMarketplaceOrder(
      callerId,
      {
        product_id: body.product_id,
        quantity: total,
        unit: group.unit,
        delivery_address: body.delivery_address,
        buyer_phone: body.buyer_phone,
      },
      derivedCloseKey(group.id),
      { unitPriceOverride: body.unit_price === undefined ? undefined : body.unit_price },
    );
  }

  // Shares are stored while the group is still 'open' (the participant
  // trigger freezes rows once the group leaves 'open').
  for (const participant of participants) {
    const { error: shareError } = await supabaseAdmin
      .from('group_buy_participants')
      .update({ share: Number(participant.contribution_quantity) / total })
      .eq('id', participant.id);
    if (shareError) throw shareError;
  }
  const totalPaise = Math.round(Number(order.total_price) * 100);
  const settlements = await createSettlements(group.id, totalPaise, participants, callerId);

  // Claim the close (gated on still-open): a concurrent close cannot
  // flip the group twice. If the claim finds no open row, re-read — the
  // other close won and its order + settlements are the replay.
  const { data: claimed, error: claimError } = await supabaseAdmin
    .from('group_buys')
    .update({ status: 'closed', order_id: order.id, closed_at: new Date().toISOString() })
    .eq('id', group.id)
    .eq('status', 'open')
    .select('*');
  if (claimError) throw claimError;
  if (!claimed || claimed.length === 0) {
    const closed = await fetchGroup(groupId);
    if (closed.status === 'closed' && closed.order_id === order.id) {
      return { group_buy: closed, order, settlements: await fetchSettlements(group.id) };
    }
    throw new AppError(409, 'GROUP_ALREADY_CLOSED', 'This group buy is already closed.');
  }
  const closedGroup = getSingle(claimed);
  await logAudit(callerId, 'group_buy.closed', {
    group_buy_id: group.id, order_id: order.id, participant_count: participants.length, total_paise: totalPaise,
  });
  return { group_buy: closedGroup, order, settlements };
}

// Owner, participant, or admin — anyone else gets the same generic 404
// as a missing group (no existence oracle).
async function getSettlement(callerId, groupId) {
  const group = await fetchGroup(groupId);
  const participants = await fetchParticipants(groupId);
  const isParticipant = participants.some((p) => p.user_id === callerId);
  const isOwner = callerId === group.owner_id;
  if (!isOwner && !isParticipant && !(await isAdmin(callerId))) {
    throw new AppError(404, 'GROUP_BUY_NOT_FOUND', 'Group buy not found.');
  }
  const settlements = await fetchSettlements(groupId);
  const byParticipant = new Map(participants.map((p) => [p.id, p]));
  let totalPaise = 0;
  if (group.order_id) {
    const order = await fetchOrder(group.order_id);
    if (order) totalPaise = Math.round(Number(order.total_price) * 100);
  }
  return {
    group_buy_id: group.id,
    order_id: group.order_id,
    total_paise: totalPaise,
    settlements: settlements.map((s) => {
      const participant = byParticipant.get(s.participant_id) || {};
      return {
        participant_id: s.participant_id,
        user_id: s.user_id,
        contribution_quantity: participant.contribution_quantity,
        share: participant.share,
        amount_paise: s.amount_paise,
        status: s.status,
      };
    }),
  };
}

module.exports = {
  createGroup,
  listGroups,
  getGroupDetail,
  joinGroup,
  negotiateAsGroup,
  closeGroup,
  getSettlement,
  derivedCloseKey,
};
