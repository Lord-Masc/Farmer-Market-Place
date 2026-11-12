'use strict';
// Dispute & Trust Management (Stage 7, module F). Buyer or farmer files
// a dispute on an order (quality / quantity / non-delivery / payment),
// attaches photo evidence, admin (Stage 1) adjudicates through a
// forward-only workflow (filed -> under_review -> evidence_requested
// -> resolved: refund / partial_refund / replacement / rejected),
// every transition in the audit log.
//
// Money rules (the brief's hard lines):
// - Full refunds go through the Stage 0 idempotent refund path
//   (escrowService.refundOrder, claimed REFUND_PENDING ->
//   REFUND_PROCESSING, UNIQUE(order_id) ledger backstop). A second
//   resolve attempt is 409-gated on the dispute row; the refund
//   path's idempotency is the backstop, never the primary guard.
// - Partial refunds use escrowService.refundPartialOrder — same
//   gateway idempotency + ledger, but NO order-status flip: the order
//   stays PAID/SHIPPED and the payment stays HELD for the remainder.
// - Replacement creates a NEW internal order via the existing escrow
//   order creation (idempotency key `dispute-replacement-<id>`), with
//   NO Razorpay order and NO charge — the replacement order is
//   PENDING and the farmer confirms it like any new order. No
//   payment row is ever created for a replacement.
// - Rejected moves no money. A note is required.
//
// SLA: sla_deadline = created_at + 7 days (DISPUTE_SLA_DAYS). A breach
// sets escalated = true via checkSlaBreaches() (Stage 0 reconciler
// pattern: best-effort, never throws, never auto-resolves) and the
// read path computes is_overdue live, so the UI is never stale.
//
// Evidence privacy: photos go to the PRIVATE 'dispute-evidence'
// bucket (dashboard step, see the migration header) and are served
// only as 5-minute signed URLs to the two counterparties + admin.
// The bucket does not exist until the dashboard step is done — the
// code answers 503 then, never crashes.
//
// The filing description has no column on disputes by design: it is
// stored as the first dispute_messages row (the thread IS the
// complaint). Non-parties get the generic 404 everywhere (never
// leak an order or a dispute). Admin checks are enforced HERE, in
// the service, as well as by the requireAdmin route middleware —
// RLS alone is not the check.
const crypto = require('crypto');
const supabaseAdmin = require('../utils/supabaseAdmin');
const { AppError } = require('../utils/errors');
const { logAudit } = require('../utils/auditLog');
const notificationService = require('./notificationService');
const { validateImageBuffer } = require('../routes/uploadRoutes');
const {
  markRefundPending,
  refundOrder,
  refundPartialOrder,
  createMarketplaceOrder,
  findPartialRefundRow,
  partialRefundError,
} = require('./escrowService');

const DISPUTE_SLA_DAYS = 7;
const MIN_POPULATION = 5;
const EVIDENCE_BUCKET = 'dispute-evidence';
const SIGNED_URL_TTL_SECONDS = 300;
const DISPUTE_CATEGORIES = ['quality', 'quantity', 'non_delivery', 'payment'];
const RESOLUTIONS = ['refund', 'partial_refund', 'replacement', 'rejected'];
const STATUS_TARGETS = ['under_review', 'evidence_requested'];

// Forward-only transitions. 'resolved' is terminal and is set only by
// resolveDispute, never by this table.
const ALLOWED_TRANSITIONS = {
  filed: ['under_review'],
  under_review: ['evidence_requested'],
  evidence_requested: ['under_review'],
  resolved: [],
};

const getSingle = (data) => (data && data.length > 0 ? data[0] : null);
const notAccessibleDispute = () =>
  new AppError(404, 'DISPUTE_NOT_ACCESSIBLE', 'Dispute not found or not accessible.');
const isOverdue = (row) =>
  row.status !== 'resolved' && new Date(row.sla_deadline).getTime() < Date.now();
const orderTotalPaise = (order) => Math.round(Number(order.total_price) * 100);

async function fetchOrder(orderId) {
  const { data, error } = await supabaseAdmin.from('orders').select('*').eq('id', orderId);
  if (error) throw error;
  return getSingle(data);
}

async function fetchDispute(disputeId) {
  const { data, error } = await supabaseAdmin.from('disputes').select('*').eq('id', disputeId);
  if (error) throw error;
  const row = getSingle(data);
  if (!row) throw notAccessibleDispute();
  return row;
}

async function fetchProductTitle(productId) {
  const { data, error } = await supabaseAdmin.from('products').select('id,name').eq('id', productId);
  if (error) throw error;
  const product = getSingle(data);
  return product ? product.name : null;
}

async function fetchCallerRole(callerId) {
  const { data, error } = await supabaseAdmin.from('profiles').select('role').eq('id', callerId);
  if (error) throw error;
  const profile = getSingle(data);
  return profile ? profile.role : null;
}

async function requireAdminRole(callerId) {
  const role = await fetchCallerRole(callerId);
  if (role !== 'admin') {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
  }
}

// Public dispute shape (the fixed contract — Unit B builds against this).
function publicDispute(row, order, productTitle) {
  return {
    id: row.id,
    order_id: row.order_id,
    filer_id: row.filer_id,
    category: row.category,
    status: row.status,
    sla_deadline: row.sla_deadline,
    escalated: !!row.escalated,
    resolution: row.resolution || null,
    resolution_note: row.resolution_note || null,
    resolution_amount_paise: row.resolution_amount_paise ?? null,
    replacement_order_id: row.replacement_order_id || null,
    resolved_at: row.resolved_at || null,
    resolved_by: row.resolved_by || null,
    created_at: row.created_at,
    is_overdue: isOverdue(row),
    order: order
      ? { id: order.id, product_title: productTitle ?? null, total_price_paise: orderTotalPaise(order) }
      : null,
  };
}

// Caller must be a counterparty (or admin). Returns { order, isAdmin }.
async function requireParty(dispute, callerId) {
  const order = await fetchOrder(dispute.order_id);
  if (!order) throw notAccessibleDispute();
  const isAdmin = (await fetchCallerRole(callerId)) === 'admin';
  if (!isAdmin && order.buyer_id !== callerId && order.farmer_id !== callerId) {
    throw notAccessibleDispute();
  }
  return { order, isAdmin };
}

function roleFor(order, callerId, isAdmin) {
  if (isAdmin) return 'admin';
  return order.buyer_id === callerId ? 'buyer' : 'farmer';
}

async function fetchOrdersByIds(ids) {
  if (!ids.length) return new Map();
  const { data, error } = await supabaseAdmin.from('orders').select('*').in('id', ids);
  if (error) throw error;
  return new Map((data || []).map((o) => [o.id, o]));
}

async function fetchTitlesByIds(productIds) {
  if (!productIds.length) return new Map();
  const { data, error } = await supabaseAdmin.from('products').select('id,name').in('id', productIds);
  if (error) throw error;
  return new Map((data || []).map((p) => [p.id, p.name]));
}

// POST /api/disputes — caller must be buyer or farmer of the order.
async function fileDispute(callerId, { order_id, category, description } = {}) {
  if (!DISPUTE_CATEGORIES.includes(category)) {
    throw new AppError(422, 'VALIDATION_ERROR', 'category must be quality, quantity, non_delivery or payment.');
  }
  const body = typeof description === 'string' ? description.trim() : '';
  if (!body) throw new AppError(422, 'VALIDATION_ERROR', 'description is required.');
  const order = await fetchOrder(order_id);
  if (!order || (order.buyer_id !== callerId && order.farmer_id !== callerId)) {
    throw notAccessibleDispute();
  }
  const { data: existing, error: existingError } = await supabaseAdmin
    .from('disputes').select('*').eq('order_id', order_id);
  if (existingError) throw existingError;
  if ((existing || []).some((d) => d.status !== 'resolved')) {
    throw new AppError(409, 'DISPUTE_ALREADY_OPEN', 'This order already has an open dispute.');
  }
  const now = new Date();
  const createdAt = now.toISOString();
  const slaDeadline = new Date(now.getTime() + DISPUTE_SLA_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: inserted, error: insertError } = await supabaseAdmin.from('disputes').insert({
    order_id, filer_id: callerId, category, status: 'filed',
    sla_deadline: slaDeadline, escalated: false,
    resolution: null, resolution_note: null, resolution_amount_paise: null,
    replacement_order_id: null, resolved_at: null, resolved_by: null,
    created_at: createdAt, updated_at: createdAt,
  }).select('*');
  if (insertError) {
    if (insertError.code === '23505' || String(insertError.message || '').includes('duplicate key')) {
      throw new AppError(409, 'DISPUTE_ALREADY_OPEN', 'This order already has an open dispute.');
    }
    throw insertError;
  }
  const dispute = getSingle(inserted);
  // The filing text is the first thread message (no description column).
  await supabaseAdmin.from('dispute_messages').insert({
    dispute_id: dispute.id, author_id: callerId,
    author_role: roleFor(order, callerId, false), body, created_at: createdAt,
  });
  await logAudit(callerId, 'dispute.filed', { dispute_id: dispute.id, order_id, category });
  // Stage 9: the counterparty learns a dispute was filed, and so do
  // the admins (zero admins = no admin rows, by design).
  const counterparty = callerId === order.buyer_id ? order.farmer_id : order.buyer_id;
  await notificationService.emit({
    eventId: `dispute:${dispute.id}:filed`, type: 'dispute_filed',
    userIds: [counterparty], includeAdmins: true,
    payload: { dispute_id: dispute.id, order_id, category },
  });
  return publicDispute(dispute, order, await fetchProductTitle(order.product_id));
}

// GET /api/disputes — caller's own as buyer/farmer; admin gets all (+ ?status=).
async function listDisputes(callerId, { status } = {}) {
  const isAdmin = (await fetchCallerRole(callerId)) === 'admin';
  let rows;
  if (isAdmin) {
    let query = supabaseAdmin.from('disputes').select('*');
    if (status) query = query.eq('status', status);
    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    rows = data || [];
  } else {
    const { data: buyerOrders, error: buyerError } = await supabaseAdmin
      .from('orders').select('id').eq('buyer_id', callerId);
    if (buyerError) throw buyerError;
    const { data: farmerOrders, error: farmerError } = await supabaseAdmin
      .from('orders').select('id').eq('farmer_id', callerId);
    if (farmerError) throw farmerError;
    const orderIds = [...new Set([...(buyerOrders || []), ...(farmerOrders || [])].map((o) => o.id))];
    if (!orderIds.length) return { disputes: [] };
    const { data, error } = await supabaseAdmin
      .from('disputes').select('*').in('order_id', orderIds)
      .order('created_at', { ascending: false });
    if (error) throw error;
    rows = (data || []).filter((d) => !status || d.status === status);
  }
  const orders = await fetchOrdersByIds([...new Set(rows.map((d) => d.order_id))]);
  const titles = await fetchTitlesByIds([...new Set([...orders.values()].map((o) => o.product_id))]);
  return {
    disputes: rows.map((d) => {
      const order = orders.get(d.order_id);
      return publicDispute(d, order, order ? titles.get(order.product_id) : null);
    }),
  };
}

// GET /api/disputes/:id — dispute + evidence (5-min signed urls) +
// messages + the order's shipment ({ id, status } | null).
async function getDisputeDetail(callerId, disputeId) {
  const dispute = await fetchDispute(disputeId);
  const { order } = await requireParty(dispute, callerId);
  const { data: evidenceRows, error: evidenceError } = await supabaseAdmin
    .from('dispute_evidence').select('*').eq('dispute_id', disputeId)
    .order('created_at', { ascending: true });
  if (evidenceError) throw evidenceError;
  const evidence = [];
  for (const row of evidenceRows || []) {
    const innerPath = row.storage_path.startsWith(`${EVIDENCE_BUCKET}/`)
      ? row.storage_path.slice(EVIDENCE_BUCKET.length + 1)
      : row.storage_path;
    const { data, error } = await supabaseAdmin.storage
      .from(EVIDENCE_BUCKET)
      .createSignedUrl(innerPath, SIGNED_URL_TTL_SECONDS);
    if (error || !data || !data.signedUrl) {
      throw new AppError(503, 'EVIDENCE_UNAVAILABLE', 'Could not generate evidence links. Please try again.');
    }
    evidence.push({ id: row.id, storage_path: row.storage_path, uploaded_by: row.uploaded_by, created_at: row.created_at, url: data.signedUrl });
  }
  const { data: messages, error: messagesError } = await supabaseAdmin
    .from('dispute_messages').select('*').eq('dispute_id', disputeId)
    .order('created_at', { ascending: true });
  if (messagesError) throw messagesError;
  const { data: shipments, error: shipmentError } = await supabaseAdmin
    .from('shipments').select('id,status').eq('order_id', order.id);
  if (shipmentError) throw shipmentError;
  const shipment = getSingle(shipments);
  // The filing description has no column (it is the first thread message);
  // surface it on the dispute so the detail page can show what went wrong
  // at a glance instead of only inside the thread.
  const description = (messages || [])[0]?.body ?? null;
  return {
    dispute: { ...publicDispute(dispute, order, await fetchProductTitle(order.product_id)), description },
    evidence,
    messages: (messages || []).map((m) => ({
      id: m.id, author_id: m.author_id, author_role: m.author_role, body: m.body, created_at: m.created_at,
    })),
    shipment: shipment ? { id: shipment.id, status: shipment.status } : null,
  };
}

// POST /api/disputes/:id/evidence — counterparty or admin only. The
// file bytes are validated exactly like the Stage 0 upload endpoint
// (MIME + magic bytes, 5 MB cap); a non-image is a 422 per the
// contract, never the upload endpoint's 415.
async function addEvidence(callerId, disputeId, { buffer, mime } = {}) {
  const dispute = await fetchDispute(disputeId);
  const { order } = await requireParty(dispute, callerId);
  if (dispute.status === 'resolved') {
    throw new AppError(409, 'DISPUTE_RESOLVED', 'This dispute is resolved and takes no more evidence.');
  }
  let ext;
  try {
    ({ ext } = validateImageBuffer(buffer, mime));
  } catch (err) {
    if (err instanceof AppError) throw new AppError(422, 'INVALID_IMAGE', err.message);
    throw err;
  }
  const innerPath = `${callerId}-${crypto.randomUUID()}.${ext}`;
  const storagePath = `${EVIDENCE_BUCKET}/${innerPath}`;
  const { error: uploadError } = await supabaseAdmin.storage
    .from(EVIDENCE_BUCKET)
    .upload(innerPath, buffer, { contentType: mime, upsert: false });
  if (uploadError) {
    throw new AppError(503, 'EVIDENCE_BUCKET_MISSING', 'The dispute-evidence storage bucket is not set up yet. Please try again later.');
  }
  const createdAt = new Date().toISOString();
  const { data: inserted, error: insertError } = await supabaseAdmin.from('dispute_evidence').insert({
    dispute_id: disputeId, storage_path: storagePath, uploaded_by: callerId, created_at: createdAt,
  }).select('*');
  if (insertError) throw insertError;
  const row = getSingle(inserted);
  await logAudit(callerId, 'dispute.evidence_added', { dispute_id: disputeId, order_id: order.id });
  return { evidence: { id: row.id, storage_path: row.storage_path, created_at: row.created_at } };
}

// POST /api/disputes/:id/message — counterparty or admin only. A
// resolved dispute takes no more messages.
async function postMessage(callerId, disputeId, body) {
  const dispute = await fetchDispute(disputeId);
  const { order, isAdmin } = await requireParty(dispute, callerId);
  if (dispute.status === 'resolved') {
    throw new AppError(409, 'DISPUTE_RESOLVED', 'This dispute is resolved and takes no more messages.');
  }
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) throw new AppError(422, 'VALIDATION_ERROR', 'body is required.');
  const createdAt = new Date().toISOString();
  const { data: inserted, error: insertError } = await supabaseAdmin.from('dispute_messages').insert({
    dispute_id: disputeId, author_id: callerId,
    author_role: roleFor(order, callerId, isAdmin), body: text, created_at: createdAt,
  }).select('*');
  if (insertError) throw insertError;
  const row = getSingle(inserted);
  await logAudit(callerId, 'dispute.message_added', { dispute_id: disputeId, order_id: order.id });
  return { message: { id: row.id, author_id: row.author_id, author_role: row.author_role, body: row.body, created_at: row.created_at } };
}

// POST /api/admin/disputes/:id/status — admin only, forward-only.
async function updateStatus(adminId, disputeId, status) {
  await requireAdminRole(adminId);
  if (!STATUS_TARGETS.includes(status)) {
    throw new AppError(422, 'VALIDATION_ERROR', 'status must be under_review or evidence_requested.');
  }
  const dispute = await fetchDispute(disputeId);
  if (!(ALLOWED_TRANSITIONS[dispute.status] || []).includes(status)) {
    throw new AppError(409, 'INVALID_TRANSITION', 'This status change is not allowed for the dispute.');
  }
  const { data: updated, error } = await supabaseAdmin.from('disputes')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', disputeId).eq('status', dispute.status).select('*');
  if (error) throw error;
  const row = getSingle(updated);
  if (!row) {
    throw new AppError(409, 'INVALID_TRANSITION', 'This status change is not allowed for the dispute.');
  }
  const order = await fetchOrder(row.order_id);
  await logAudit(adminId, 'dispute.status_changed', { dispute_id: disputeId, status });
  // Stage 9: both parties learn the dispute moved forward.
  await notificationService.emit({
    eventId: `dispute:${disputeId}:status:${status}`, type: 'dispute_status',
    userIds: [order.buyer_id, order.farmer_id],
    payload: { dispute_id: disputeId, order_id: row.order_id, status },
  });
  return { dispute: publicDispute(row, order, order ? await fetchProductTitle(order.product_id) : null) };
}

// POST /api/admin/disputes/:id/resolve — admin only. The dispute row
// is the status gate (409 on a resolved dispute); the money paths
// are the backstop. Refund first, then mark resolved, so a retry
// after a partial success self-heals (refundOrder replays an already
// REFUNDED order; the replacement key replays the same order).
async function resolveDispute(adminId, disputeId, { outcome, amount_paise, note } = {}) {
  await requireAdminRole(adminId);
  if (!RESOLUTIONS.includes(outcome)) {
    throw new AppError(422, 'VALIDATION_ERROR', 'outcome must be refund, partial_refund, replacement or rejected.');
  }
  const noteText = typeof note === 'string' ? note.trim() : '';
  if (outcome === 'rejected' && !noteText) {
    throw new AppError(422, 'VALIDATION_ERROR', 'note is required when rejecting a dispute.');
  }
  const dispute = await fetchDispute(disputeId);
  if (dispute.status === 'resolved') {
    throw new AppError(409, 'DISPUTE_RESOLVED', 'This dispute is already resolved.');
  }
  const order = await fetchOrder(dispute.order_id);
  if (!order) throw notAccessibleDispute();
  const totalPaise = orderTotalPaise(order);
  if (outcome === 'partial_refund') {
    if (!Number.isInteger(amount_paise) || amount_paise <= 0 || amount_paise > totalPaise) {
      throw new AppError(422, 'VALIDATION_ERROR', 'amount_paise must be a positive integer no larger than the order total.');
    }
  }

  let resolutionAmountPaise = null;
  let replacementOrderId = null;
  try {
    if (outcome === 'refund') {
      // A completed partial refund blocks the full path BEFORE the order
      // leaves PAID: the remainder is gateway-only, so the order stays
      // PAID and the payment stays HELD.
      const partial = await findPartialRefundRow(order.id, totalPaise);
      if (partial) throw partialRefundError();
      // Enqueue through the Stage 0 path, then run the idempotent refund.
      await markRefundPending(order.id);
      const res = await refundOrder(order.id);
      if (!res.success) {
        throw new AppError(409, 'REFUND_NOT_ELIGIBLE', res.message || 'This order cannot be refunded.');
      }
      resolutionAmountPaise = totalPaise;
    } else if (outcome === 'partial_refund') {
      await refundPartialOrder(order.id, amount_paise);
      resolutionAmountPaise = amount_paise;
    } else if (outcome === 'replacement') {
      const replacement = await createMarketplaceOrder(
        order.buyer_id,
        {
          product_id: order.product_id,
          quantity: order.quantity,
          unit: order.unit_at_order,
          delivery_address: order.delivery_address,
          buyer_phone: order.buyer_phone,
        },
        `dispute-replacement-${disputeId}`,
      );
      replacementOrderId = replacement.id;
    }
    // 'rejected' moves no money.
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(503, 'REFUND_FAILED', 'The refund could not be completed. Please try again.');
  }

  const now = new Date().toISOString();
  const { data: updated, error } = await supabaseAdmin.from('disputes').update({
    status: 'resolved', resolution: outcome,
    resolution_note: noteText || null,
    resolution_amount_paise: resolutionAmountPaise,
    replacement_order_id: replacementOrderId,
    resolved_at: now, resolved_by: adminId, updated_at: now,
  }).eq('id', disputeId).eq('status', dispute.status).select('*');
  if (error) throw error;
  const row = getSingle(updated);
  if (!row) {
    throw new AppError(409, 'DISPUTE_RESOLVED', 'This dispute is already resolved.');
  }
  await logAudit(adminId, 'dispute.resolved', {
    dispute_id: disputeId, order_id: order.id, outcome,
    amount_paise: resolutionAmountPaise, replacement_order_id: replacementOrderId,
  });
  // Stage 9: both parties learn the dispute resolved (and, for a
  // refund outcome, the escrow path already emitted refund_requested
  // + refunded alongside this one — each is a true event).
  await notificationService.emit({
    eventId: `dispute:${disputeId}:resolved`, type: 'dispute_resolved',
    userIds: [order.buyer_id, order.farmer_id],
    payload: { dispute_id: disputeId, order_id: order.id, outcome, amount_paise: resolutionAmountPaise },
  });
  return { dispute: publicDispute(row, order, await fetchProductTitle(order.product_id)) };
}

// GET /api/disputes/stats — public aggregates from real disputes only.
// Rates are NULL when there is nothing to compute (never 0-by-invention),
// and NULL while fewer than MIN_POPULATION disputes exist: at N=1 the
// rate and the average duration ARE one dispute's exact outcome.
async function getDisputeStats() {
  const { data, error } = await supabaseAdmin.from('disputes').select('*');
  if (error) throw error;
  const rows = data || [];
  const resolved = rows.filter((d) => d.status === 'resolved');
  const hours = resolved
    .filter((d) => d.created_at && d.resolved_at)
    .map((d) => (new Date(d.resolved_at).getTime() - new Date(d.created_at).getTime()) / 3600000);
  return {
    total: rows.length,
    open: rows.length - resolved.length,
    resolved: resolved.length,
    resolution_rate: rows.length < MIN_POPULATION ? null : resolved.length / rows.length,
    avg_resolution_hours: rows.length < MIN_POPULATION || hours.length === 0
      ? null
      : Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 100) / 100,
  };
}

// POST /api/admin/disputes/check-sla — admin only. Best-effort, never
// throws: a breach escalates the dispute, never auto-resolves it.
async function checkSlaBreaches() {
  try {
    const { data, error } = await supabaseAdmin.from('disputes').select('*');
    if (error) throw error;
    const now = Date.now();
    const breached = (data || []).filter(
      (d) => d.status !== 'resolved' && !d.escalated && new Date(d.sla_deadline).getTime() < now,
    );
    let escalated = 0;
    for (const d of breached) {
      try {
        const { data: updated, error: updateError } = await supabaseAdmin.from('disputes')
          .update({ escalated: true, updated_at: new Date().toISOString() })
          .eq('id', d.id).eq('escalated', false).select('*');
        if (updateError) throw updateError;
        if (getSingle(updated)) {
          escalated += 1;
          await logAudit(null, 'dispute.escalated', { dispute_id: d.id, order_id: d.order_id });
        }
      } catch (err) {
        console.error(`SLA escalation failed for dispute ${d.id}:`, err.message);
      }
    }
    return { checked: breached.length, escalated };
  } catch (err) {
    console.error('SLA check failed:', err.message);
    return { checked: 0, escalated: 0 };
  }
}

module.exports = {
  DISPUTE_SLA_DAYS,
  EVIDENCE_BUCKET,
  fileDispute,
  listDisputes,
  getDisputeDetail,
  addEvidence,
  postMessage,
  updateStatus,
  resolveDispute,
  getDisputeStats,
  checkSlaBreaches,
};
