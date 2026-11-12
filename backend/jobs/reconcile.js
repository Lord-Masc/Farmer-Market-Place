'use strict';
// Reconciliation job (Stage 0, H1/R3/R4). Backstop for the webhook: orders
// stuck CONFIRMED with a gateway order id but no payments row are checked
// against Razorpay; only a gateway-paid order is marked PAID, through the
// same idempotent verifyAndMarkPaid the browser callback and webhook use.
// The job never invents a payment and never touches an order the gateway
// says is unpaid. Run on a schedule from server.js; safe to run often —
// every order it skips or reconciles is re-checked from live state.
const Razorpay = require('razorpay');
const { createClient } = require('@supabase/supabase-js');
const escrowService = require('../services/escrowService');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

async function reconcileUnpaidOrders({ olderThanMinutes = 15, limit = 50 } = {}) {
    const counts = { checked: 0, reconciled: 0, skipped: 0, failed: 0 };
    try {
        const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();
        const { data: orders, error } = await supabase.from('orders')
            .select('*').eq('status', 'CONFIRMED').lt('created_at', cutoff).limit(limit);
        if (error) throw error;
        const candidates = (orders || []).filter((o) => o.razorpay_order_id);
        counts.checked = candidates.length;
        for (const order of candidates) {
            try {
                const { data: payments, error: payError } = await supabase.from('payments')
                    .select('id').eq('order_id', order.id);
                if (payError) throw payError;
                if (payments && payments.length > 0) {
                    counts.skipped += 1;
                    continue;
                }
                const gatewayOrder = await razorpay.orders.fetch(order.razorpay_order_id);
                if (!gatewayOrder || gatewayOrder.status !== 'paid') continue;
                const { items = [] } = await razorpay.orders.fetchPayments(order.razorpay_order_id);
                const expectedPaise = Math.round(Number(order.total_price) * 100);
                const captured = items.find((item) =>
                    item.status === 'captured' && Number(item.amount) === expectedPaise);
                if (!captured) {
                    console.error(`Reconcile: gateway order ${order.razorpay_order_id} is paid but no captured payment matches order ${order.id}; leaving it.`);
                    counts.failed += 1;
                    continue;
                }
                await escrowService.verifyAndMarkPaid(order.id, order.razorpay_order_id, captured.id, order.buyer_id);
                console.log(`Reconciled unpaid order ${order.id} (payment ${captured.id}).`);
                counts.reconciled += 1;
            } catch (err) {
                console.error(`Reconcile failed for order ${order.id}:`, err.message);
                counts.failed += 1;
            }
        }
    } catch (err) {
        console.error('Reconcile Unpaid Orders Job Error:', err);
    }
    return counts;
}

module.exports = { reconcileUnpaidOrders };
