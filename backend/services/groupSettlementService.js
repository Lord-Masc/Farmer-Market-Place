'use strict';
// Group settlements (Stage 5, module D).
//
// COORDINATOR SEMANTICS — the group is a DEMAND pool: farmers pool
// quantities of the same crop to buy wholesale as one buyer. A settlement
// row records a participant's SHARE OF THE POOLED ORDER TOTAL in integer
// paise (what they owe toward the pooled order) — never a "payout".
// Collection/reconciliation is a later stage; no money moves here.
//
// splitPayment is PURE: integer paise in, integer paise out, the parts
// sum EXACTLY to the total. Each participant's exact share is
// contribution / total * totalPaise; every part is floored, and the
// leftover paise go one each to the largest fractional remainders
// (largest-remainder method). Ties break deterministically by
// participant created_at, then id — the same split always yields the
// same rows.
const supabaseAdmin = require('../utils/supabaseAdmin');
const { AppError } = require('../utils/errors');
const { logAudit } = require('../utils/auditLog');

const getSingle = (data) => (data && data.length > 0 ? data[0] : null);

function validationError(message) {
  return new AppError(422, 'VALIDATION_ERROR', message);
}

function isDuplicateKey(error) {
  return error && (error.code === '23505' || String(error.message || '').includes('duplicate key'));
}

// contributions: [{ participant_id, contribution_quantity, created_at, id }]
// Returns [{ participant_id, amount_paise }] in (created_at, id) order.
function splitPayment(totalPaise, contributions) {
  if (!Number.isInteger(totalPaise) || totalPaise < 0) {
    throw validationError('totalPaise must be an integer number of paise greater than or equal to 0.');
  }
  if (!Array.isArray(contributions) || contributions.length === 0) {
    throw validationError('at least one contribution is required to split a payment.');
  }
  const ordered = [...contributions].sort((a, b) => {
    const aCreated = a.created_at || '';
    const bCreated = b.created_at || '';
    if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1;
    const aId = a.id || a.participant_id || '';
    const bId = b.id || b.participant_id || '';
    if (aId === bId) return 0;
    return aId < bId ? -1 : 1;
  });
  const totalContribution = ordered.reduce((sum, c) => sum + Number(c.contribution_quantity), 0);
  if (!Number.isFinite(totalContribution) || totalContribution <= 0) {
    throw validationError('contributions must sum to a number greater than 0.');
  }
  const parts = ordered.map((c) => {
    const exact = (Number(c.contribution_quantity) / totalContribution) * totalPaise;
    if (!Number.isFinite(exact) || exact < 0) {
      throw validationError('contribution_quantity must be a number greater than 0.');
    }
    return { participant_id: c.participant_id, amount_paise: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  let remainder = totalPaise - parts.reduce((sum, p) => sum + p.amount_paise, 0);
  // Largest remainder first; the ordered array is already the tie-break
  // order, so a stable sort keeps (created_at, id) order among equals.
  const byRemainder = [...parts].sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; remainder > 0 && i < byRemainder.length; i += 1) {
    byRemainder[i].amount_paise += 1;
    remainder -= 1;
  }
  return parts.map(({ participant_id, amount_paise }) => ({ participant_id, amount_paise }));
}

// Inserts one settlement row per participant for a closed group.
// Idempotent: a 23505 on the UNIQUE(group_buy_id, participant_id)
// backstop (a concurrent or retried close already wrote the rows) re-reads
// the existing rows instead of duplicating them. One summary audit event
// per group — never one per participant.
async function createSettlements(groupId, orderTotalPaise, participants, actorId = null) {
  const amounts = splitPayment(
    orderTotalPaise,
    participants.map((p) => ({
      participant_id: p.id, contribution_quantity: p.contribution_quantity, created_at: p.created_at, id: p.id,
    })),
  );
  const byParticipant = new Map(amounts.map((a) => [a.participant_id, a.amount_paise]));
  const rows = [];
  for (const participant of participants) {
    const { data: inserted, error } = await supabaseAdmin
      .from('group_settlements')
      .insert({
        group_buy_id: groupId,
        participant_id: participant.id,
        user_id: participant.user_id,
        amount_paise: byParticipant.get(participant.id),
        status: 'pending',
      })
      .select('*');
    if (error) {
      if (isDuplicateKey(error)) {
        const { data: existing, error: readError } = await supabaseAdmin
          .from('group_settlements')
          .select('*')
          .eq('group_buy_id', groupId);
        if (readError) throw readError;
        return existing || [];
      }
      throw error;
    }
    rows.push(getSingle(inserted));
  }
  await logAudit(actorId, 'settlement.created', {
    group_buy_id: groupId, participant_count: rows.length, total_paise: orderTotalPaise,
  });
  return rows;
}

module.exports = { splitPayment, createSettlements };
