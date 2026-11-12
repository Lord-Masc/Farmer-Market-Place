'use strict';
// Admin & Platform Intelligence (Stage 10, module I) — read models.
//
// GMV is defined here, once: the sum of total_price over orders with a
// CAPTURED payment (payments.status HELD or RELEASED), in paise
// (orders.total_price is RUPEES, so x 100). A REFUNDED payment is not
// captured money — its order contributes nothing to GMV. Median farmer
// realisation is the median over those same orders of
// (total_price x 100 / quantity) in paise per unit; it mixes
// unit_at_order values (kg vs quintal), so the mandi comparison is only
// meaningful per unit — a per-unit breakdown is a follow-up, not a
// silent filter.
//
// Honesty rule (same as Stages 7/8): a measurement with no underlying
// data is NULL, never 0. Counts (total_orders, dispute_count,
// groups_total, notification buckets) are 0 when the table is empty —
// zero rows IS a real measurement for a count.
//
// MANDI COMPARISON NEEDS STAGE 3: the mandi_prices table does NOT exist
// (Stage 3 is blocked on the data.gov.in API key). The read below is
// GUARDED (same isTableMissing pattern as the Stage 8 price tool): a
// missing table returns null, never an invented number. When Stage 3
// lands, this lights up with no other change — EXCEPT the row shape:
// the modal is read from mandi_prices.price, assumed to be RUPEES per
// unit (the Stage 8 assumption: price x 100 = paise). If Stage 3's
// price column turns out to be paise already, drop the x 100 here.
//
// Reconciliation reads the admin_stuck_money view (migration
// 20261125_admin_views.sql). The live metrics below compute from the
// base tables so they are always fresh; platform_metrics_daily is the
// daily rollup for reporting, not the endpoint source.
const supabaseAdmin = require('../utils/supabaseAdmin');

const CAPTURED_PAYMENT_STATUSES = ['HELD', 'RELEASED'];
const KNOWN_STUCK_CATEGORIES = ['confirmed_unpaid', 'completed_held', 'refund_reconcile'];
const DELIVERED_STATUSES = ['DELIVERED', 'COMPLETED'];

// Same table-missing detector as the Stage 8 price tool: PostgREST
// 42P01 / PGRST205, or a "does not exist" message.
function isTableMissing(error) {
  if (!error) return false;
  return error.code === '42P01'
    || error.code === 'PGRST205'
    || /does not exist/i.test(String(error.message || ''));
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function fetchAll(table, columns) {
  const { data, error } = await supabaseAdmin.from(table).select(columns);
  if (error) throw error;
  return data || [];
}

// Modal mandi price in paise, or null: no table (Stage 3 not landed),
// no rows, or no finite prices. Ties keep the first most-frequent price.
async function getMandiModalPaise() {
  try {
    const { data, error } = await supabaseAdmin.from('mandi_prices').select('price');
    if (error) {
      if (isTableMissing(error)) return null;
      throw error;
    }
    const prices = (data || []).map((r) => Number(r.price)).filter(Number.isFinite);
    if (prices.length === 0) return null;
    const counts = new Map();
    for (const p of prices) counts.set(p, (counts.get(p) || 0) + 1);
    let modal = null;
    let best = 0;
    for (const [p, c] of counts) {
      if (c > best) { best = c; modal = p; }
    }
    return Math.round(modal * 100);
  } catch (err) {
    if (isTableMissing(err)) return null;
    throw err;
  }
}

async function getPlatformMetrics() {
  const [orders, payments, groups, participants, notifications, disputes] = await Promise.all([
    fetchAll('orders', 'id,total_price,quantity,status,created_at,completed_at,delivery_deadline'),
    fetchAll('payments', 'order_id,status'),
    fetchAll('group_buys', 'id,status,order_id'),
    fetchAll('group_buy_participants', 'group_buy_id,contribution_quantity'),
    fetchAll('notifications', 'delivery_status'),
    fetchAll('disputes', 'status,created_at,resolved_at'),
  ]);

  // Dispute stats, computed here from the disputes table directly (same
  // definitions as disputeService.getDisputeStats) so this read-only
  // service does not drag in the escrow/Razorpay load chain — requiring
  // disputeService would pull escrowService, which constructs a Razorpay
  // client at load time and breaks suites that never set Razorpay env.
  const disputeCount = disputes.length;
  const resolutionHours = disputes
    .filter((d) => d.status === 'resolved' && d.created_at && d.resolved_at)
    .map((d) => (new Date(d.resolved_at).getTime() - new Date(d.created_at).getTime()) / 3600000);
  const avgResolutionHours = resolutionHours.length === 0
    ? null
    : Math.round((resolutionHours.reduce((a, b) => a + b, 0) / resolutionHours.length) * 100) / 100;
  const mandiModalPaise = await getMandiModalPaise();

  const paidOrderIds = new Set(
    payments
      .filter((p) => CAPTURED_PAYMENT_STATUSES.includes(p.status))
      .map((p) => p.order_id),
  );
  const paidOrders = orders.filter((o) => paidOrderIds.has(o.id));

  const gmvPaise = paidOrders.length === 0
    ? null
    : paidOrders.reduce((sum, o) => sum + Math.round(Number(o.total_price) * 100), 0);
  const realisations = paidOrders
    .map((o) => {
      const qty = Number(o.quantity);
      if (!Number.isFinite(qty) || qty <= 0) return null;
      return Math.round((Number(o.total_price) * 100) / qty);
    })
    .filter((v) => v !== null);

  const disputeRate = orders.length === 0 ? null : round4(disputeCount / orders.length);

  const eligible = orders.filter(
    (o) => DELIVERED_STATUSES.includes(o.status) && o.delivery_deadline && o.completed_at,
  );
  const onTimeRate = eligible.length === 0
    ? null
    : round4(eligible.filter((o) => new Date(o.completed_at) <= new Date(o.delivery_deadline)).length / eligible.length);

  const closedGroups = groups.filter((g) => g.status === 'closed');
  const closedIds = new Set(closedGroups.map((g) => g.id));
  const closedParticipants = participants.filter((p) => closedIds.has(p.group_buy_id));
  const pooledQuantity = closedGroups.length === 0
    ? null
    : closedParticipants.reduce((sum, p) => sum + Number(p.contribution_quantity || 0), 0);
  const linkedOrders = closedGroups
    .map((g) => orders.find((o) => o.id === g.order_id))
    .filter(Boolean);
  const pooledGmvPaise = linkedOrders.length === 0
    ? null
    : linkedOrders.reduce((sum, o) => sum + Math.round(Number(o.total_price) * 100), 0);

  const notificationDelivery = { sent: 0, failed: 0, deferred: 0, pending: 0 };
  for (const n of notifications) {
    if (Object.prototype.hasOwnProperty.call(notificationDelivery, n.delivery_status)) {
      notificationDelivery[n.delivery_status] += 1;
    }
  }

  return {
    total_orders: orders.length,
    gmv_paise: gmvPaise,
    median_realisation_paise: median(realisations),
    mandi_modal_paise: mandiModalPaise,
    dispute_rate: disputeRate,
    dispute_count: disputeCount,
    avg_resolution_hours: avgResolutionHours,
    on_time_rate: onTimeRate,
    group_selling: {
      groups_total: groups.length,
      groups_closed: closedGroups.length,
      pooled_quantity: pooledQuantity,
      pooled_gmv_paise: pooledGmvPaise,
    },
    notification_delivery: notificationDelivery,
  };
}

// Stuck money, straight from the admin_stuck_money view. Rows with a
// category outside the three the view defines are dropped, not surfaced.
async function getStuckMoney() {
  const { data, error } = await supabaseAdmin
    .from('admin_stuck_money')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || [])
    .filter((r) => KNOWN_STUCK_CATEGORIES.includes(r.category))
    .map((r) => ({
      order_id: r.order_id,
      category: r.category,
      amount_paise: r.amount_paise,
      order_status: r.order_status,
      payment_status: r.payment_status ?? null,
      created_at: r.created_at,
    }));
}

module.exports = { getPlatformMetrics, getStuckMoney };
