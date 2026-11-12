const Razorpay = require('razorpay');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { AppError, notAccessible } = require('../utils/errors');
const { logAudit } = require('../utils/auditLog');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Validate Razorpay credentials
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    console.error('❌ Missing Razorpay credentials in .env file');
    console.error('RAZORPAY_KEY_ID:', process.env.RAZORPAY_KEY_ID ? '✅ Set' : '❌ Missing');
    console.error('RAZORPAY_KEY_SECRET:', process.env.RAZORPAY_KEY_SECRET ? '✅ Set' : '❌ Missing');
} else {
    console.log('✅ Razorpay credentials loaded successfully');
}

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Helper: Handle supabase .single() safely
const getSingle = (data) => (data && data.length > 0 ? data[0] : null);

// NULL-deadline grace period (M4): legacy orders never got a deadline
// (it is set when the payment is marked PAID). A NULL deadline alone must
// never trigger a refund — only orders older than this, WITH a payments
// row, are enqueued. Younger rows may simply not have reached payment yet;
// rows with no payment have no money to refund.
const NULL_DEADLINE_GRACE_DAYS = 7;

// Helper: Retry logic for API calls (exponential backoff — delay doubles each attempt).
// Only transient failures are retried: network errors (no statusCode) and
// 5xx gateway failures. A 4xx means the request itself is wrong — retrying
// after an ambiguous timeout could create a second gateway order while the
// first already exists (orphan). (Audit L2.)
const retryAsync = async (fn, retries = 3, delay = 1000) => {
    let currentDelay = delay;
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            const transient = !err.statusCode || err.statusCode >= 500;
            if (!transient || i === retries - 1) throw err;
            console.warn(`Attempt ${i + 1} failed, retrying in ${currentDelay}ms...`);
            await new Promise(r => setTimeout(r, currentDelay));
            currentDelay *= 2;
        }
    }
};

// ---------------------------------------------------------------------------
// Shared guards (2026-11-08 security fix)
// ---------------------------------------------------------------------------

// Positive-quantity validation: quantity must be a finite number > 0. A
// negative quantity used to increase farmer stock on confirm.
function validateQuantity(quantity) {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
        throw new AppError(400, 'INVALID_QUANTITY', 'Quantity must be a positive number.');
    }
    return qty;
}

// Fetch an order or throw the generic not-accessible error. The message is
// deliberately identical for a missing order and someone else's order, so
// callers cannot tell the two apart (no existence/ownership oracle).
async function fetchOrder(order_id) {
    const { data, error } = await supabase.from('orders').select('*').eq('id', order_id);
    if (error) throw error;
    const order = getSingle(data);
    if (!order) throw notAccessible();
    return order;
}

// 0. Create a marketplace order server-side (Stage 0, M2/R2).
// The buyer only names a product, a quantity, a unit and a delivery
// address. Price, farmer, counterparty contact details and the total are
// derived from the product + profiles rows; anything the client sends for
// those fields is ignored. The unit price is snapshotted (price_at_order)
// so a later farmer price edit cannot brick payment. Stock is checked here
// as a fast fail; the reservation still happens atomically on confirm.
const ORDER_UNITS = ['kg', 'quintal'];

async function fetchProfile(userId) {
    const { data, error } = await supabase.from('profiles')
        .select('first_name,last_name,phone_number').eq('id', userId);
    if (error) throw error;
    return getSingle(data);
}

exports.createMarketplaceOrder = async (buyerId, input = {}, idempotencyKey) => {
    const { product_id, quantity, unit = 'kg', delivery_address, buyer_phone } = input;
    if (!product_id || quantity === undefined || quantity === null ||
        !delivery_address || !String(delivery_address).trim()) {
        throw new AppError(400, 'MISSING_FIELDS', 'Product, quantity and delivery address are required.');
    }
    const qty = validateQuantity(quantity);
    if (!ORDER_UNITS.includes(unit)) {
        throw new AppError(422, 'VALIDATION_ERROR', 'Unit must be kg or quintal.');
    }
    const address = String(delivery_address).trim();

    // Idempotency: the key is claimed atomically via the UNIQUE(key, user_id)
    // constraint — a check-then-insert would race under retries.
    let requestHash = null;
    if (idempotencyKey) {
        requestHash = crypto.createHash('sha256')
            .update(JSON.stringify({ buyerId, product_id, quantity: qty, unit, delivery_address: address, buyer_phone: buyer_phone ? String(buyer_phone).trim() : '' }))
            .digest('hex');
        const { error: claimError } = await supabase.from('idempotency_keys')
            .insert({ key: idempotencyKey, user_id: buyerId, request_hash: requestHash, status: 'in_progress' })
            .select('*');
        if (claimError) {
            if (claimError.code === '23505' || String(claimError.message || '').includes('duplicate key')) {
                const { data: existing, error: readError } = await supabase.from('idempotency_keys')
                    .select('*').eq('key', idempotencyKey).eq('user_id', buyerId);
                if (readError) throw readError;
                const prior = getSingle(existing);
                if (!prior) throw claimError;
                if (prior.request_hash !== requestHash) {
                    throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used with a different order.');
                }
                if (prior.status === 'completed' && prior.response_body) return prior.response_body;
                if (prior.status === 'failed') {
                    // A previous attempt failed after claiming: reclaim the
                    // key (gated on still-failed, so only one retry wins).
                    const { data: reclaimed, error: reclaimError } = await supabase.from('idempotency_keys')
                        .update({ status: 'in_progress' })
                        .eq('key', idempotencyKey).eq('user_id', buyerId).eq('status', 'failed').select('*');
                    if (reclaimError) throw reclaimError;
                    if (!reclaimed || !reclaimed.length) {
                        throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'An order with this idempotency key is already being created.');
                    }
                } else {
                    throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'An order with this idempotency key is already being created.');
                }
            } else {
                throw claimError;
            }
        }
    }

    try {
        const { data: productRows, error: productError } = await supabase.from('products')
            .select('id,farmer_id,user_price,price,quantity').eq('id', product_id);
        if (productError) throw productError;
        const product = getSingle(productRows);
        if (!product) throw notAccessible();
        if (product.farmer_id === buyerId) {
            throw new AppError(403, 'FORBIDDEN', 'You cannot order your own product.');
        }
        const multiplier = unit === 'quintal' ? 100 : 1;
        if (Number(product.quantity) < qty * multiplier) {
            throw new AppError(409, 'INSUFFICIENT_STOCK', 'Insufficient stock for this order.');
        }
        const unitPrice = Number(product.user_price ?? product.price);
        const total = unitPrice * qty * multiplier;
        if (!Number.isFinite(total) || total <= 0) {
            throw new AppError(409, 'AMOUNT_MISMATCH', 'This product has no valid price.');
        }
        const [buyer, farmer] = await Promise.all([fetchProfile(buyerId), fetchProfile(product.farmer_id)]);
        const farmerName = [farmer && farmer.first_name, farmer && farmer.last_name].filter(Boolean).join(' ');
        // buyer_phone is the buyer's own delivery contact: an explicit value
        // from the checkout form wins, otherwise the profile phone. (Only
        // the buyer's own phone is ever accepted — farmer/buyer names and
        // prices always come from the server's rows, never the client.)
        const deliveryPhone = (buyer_phone && String(buyer_phone).trim())
            || (buyer && buyer.phone_number) || '';
        const { data: inserted, error: insertError } = await supabase.from('orders').insert({
            buyer_id: buyerId,
            farmer_id: product.farmer_id,
            product_id: product.id,
            quantity: qty,
            unit_at_order: unit,
            total_price: total,
            price_at_order: unitPrice,
            status: 'PENDING',
            delivery_address: address,
            buyer_phone: deliveryPhone,
            farmer_name: farmerName || 'Merchant',
            farmer_phone: (farmer && farmer.phone_number) || '',
        }).select('*');
        if (insertError) throw insertError;
        const order = getSingle(inserted);
        if (!order) throw new Error('Order creation returned no row.');
        if (idempotencyKey) {
            await supabase.from('idempotency_keys').update({
                status: 'completed', response_status: 201, response_body: order,
            }).eq('key', idempotencyKey).eq('user_id', buyerId);
        }
        await logAudit(buyerId, 'order.created', { order_id: order.id, product_id: product.id });
        return order;
    } catch (err) {
        // A failed attempt frees the key so the client can retry with it.
        // shortcut: a crash between claim and this cleanup leaves a stuck
        // in_progress row; no sweeper exists yet — retry with a new key.
        if (idempotencyKey) {
            await supabase.from('idempotency_keys').update({ status: 'failed' })
                .eq('key', idempotencyKey).eq('user_id', buyerId).catch(() => {});
        }
        throw err;
    }
};

// 1. Create Razorpay Order.
// Price binding: the charge must equal the price snapshot taken at order
// time (price_at_order) x quantity — never the live listing, so a farmer
// price edit after confirmation cannot brick payment (R2). Legacy orders
// without a snapshot fall back to the live product price.
exports.createRazorpayOrder = async (buyerId, orderId) => {
    if (!orderId) throw new AppError(400, 'MISSING_ORDER', 'An approved order is required.');
    const order = await fetchOrder(orderId);
    if (order.buyer_id !== buyerId) throw new AppError(403, 'FORBIDDEN', 'You can only pay for your own orders.');
    if (order.status !== 'CONFIRMED') throw new AppError(409, 'ORDER_NOT_PAYABLE', 'The farmer must approve this order before payment.');

    const { data, error } = await supabase.from('products')
        .select('farmer_id,user_price,price').eq('id', order.product_id);
    if (error) throw error;
    const product = getSingle(data);
    if (!product || product.farmer_id !== order.farmer_id) throw notAccessible();

    const quantity = validateQuantity(order.quantity);
    const multiplier = order.unit_at_order === 'quintal' ? 100 : 1;
    const unitPrice = order.price_at_order != null
        ? Number(order.price_at_order)
        : Number(product.user_price ?? product.price);
    const expected = unitPrice * quantity * multiplier;
    if (!Number.isFinite(expected) || expected <= 0 ||
        Math.round(expected * 100) !== Math.round(Number(order.total_price) * 100)) {
        throw new AppError(409, 'AMOUNT_MISMATCH', 'The product price changed. Please contact the farmer and place a new order.');
    }

    let razorpayOrder;
    try {
        razorpayOrder = order.razorpay_order_id
            ? await razorpay.orders.fetch(order.razorpay_order_id)
            : await retryAsync(() => razorpay.orders.create({
                amount: Math.round(expected * 100),
                currency: 'INR',
                receipt: `order_${String(order.id).replace(/-/g, '').slice(0, 20)}`,
            }), 3, 1000);
    } catch (err) {
        console.error('Razorpay order request failed:', err.message);
        throw new AppError(503, 'PAYMENT_GATEWAY_UNAVAILABLE', 'Payment gateway is temporarily unavailable. Please try again.');
    }
    if (Number(razorpayOrder.amount) !== Math.round(expected * 100)) {
        throw new AppError(409, 'AMOUNT_MISMATCH', 'The gateway order amount does not match this marketplace order.');
    }
    if (razorpayOrder.status === 'paid') {
        try {
            const { items = [] } = await razorpay.orders.fetchPayments(order.razorpay_order_id);
            const captured = items.find(item => item.status === 'captured' && Number(item.amount) === Math.round(expected * 100));
            if (!captured) throw new Error('Captured payment not found');
            await exports.verifyAndMarkPaid(order.id, order.razorpay_order_id, captured.id, buyerId);
            return { order_id: order.id, amount: Math.round(expected * 100), alreadyPaid: true };
        } catch (err) {
            if (err instanceof AppError) throw err;
            throw new AppError(503, 'PAYMENT_RECONCILIATION_PENDING', 'Payment was received by the gateway. Refresh your orders shortly while we reconcile it.');
        }
    }
    if (!['created', 'attempted'].includes(razorpayOrder.status)) {
        throw new AppError(409, 'PAYMENT_ORDER_UNAVAILABLE', 'This payment attempt is no longer available. Contact support.');
    }
    if (!order.razorpay_order_id) {
        const { data: saved, error: saveError } = await supabase.from('orders')
            .update({ razorpay_order_id: razorpayOrder.id })
            .eq('id', order.id).eq('status', 'CONFIRMED').is('razorpay_order_id', null).select('id');
        if (saveError) throw saveError;
        if (!saved?.length) throw new AppError(409, 'PAYMENT_ORDER_CONFLICT', 'A payment attempt is already being created. Please refresh and try again.');
    }
    return { order_id: order.id, razorpay_order_id: razorpayOrder.id, amount: Math.round(expected * 100) };
};

// 2. Verify a Razorpay payment server-side and mark the order PAID.
// Binds the payment to the order: the Razorpay signature is checked by the
// controller, then this verifies (a) the payment exists at Razorpay and is
// captured, (b) its amount equals the order total, (c) it belongs to the
// Razorpay order used at checkout, and (d) it has not already been used for
// another order (replay). Only a farmer-approved order can become PAID,
// and only by its own buyer. The recorded amount comes from Razorpay.
exports.verifyAndMarkPaid = async (order_id, razorpay_order_id, razorpay_payment_id, buyer_id) => {
    const order = await fetchOrder(order_id);
    if (order.buyer_id !== buyer_id) throw new AppError(403, 'FORBIDDEN', 'You can only pay for your own orders.');
    if (!['CONFIRMED', 'PAID'].includes(order.status)) {
        throw new AppError(409, 'ORDER_NOT_PAYABLE', 'Only a farmer-approved order can be paid.');
    }
    if (!order.razorpay_order_id || order.razorpay_order_id !== razorpay_order_id) {
        throw new AppError(400, 'PAYMENT_ORDER_MISMATCH', 'This payment does not belong to the selected order.');
    }

    let payment;
    try {
        payment = await razorpay.payments.fetch(razorpay_payment_id);
    } catch (_) {
        throw new AppError(400, 'PAYMENT_NOT_FOUND', 'The payment could not be verified with the gateway.');
    }
    if (!payment || payment.status !== 'captured') {
        throw new AppError(400, 'PAYMENT_NOT_CAPTURED', 'The payment is not captured.');
    }
    if (payment.order_id !== razorpay_order_id) {
        throw new AppError(400, 'PAYMENT_ORDER_MISMATCH', 'The payment does not belong to this checkout.');
    }
    if (Number(payment.amount) !== Math.round(Number(order.total_price) * 100)) {
        throw new AppError(400, 'AMOUNT_MISMATCH', 'The paid amount does not match the order total.');
    }

    const { data: existing, error: readError } = await supabase.from('payments')
        .select('*').eq('razorpay_payment_id', razorpay_payment_id);
    if (readError) throw readError;
    const used = getSingle(existing);
    if (used && used.order_id !== order_id) {
        throw new AppError(409, 'PAYMENT_ALREADY_USED', 'This payment has already been used for another order.');
    }
    // One ledger row per order. A second, different payment for the same
    // order is a duplicate charge (buyer paid twice): refund it at the
    // gateway and keep the first payment as the ledger row — never record
    // two HELD rows, or completion would release both (L4).
    if (!used) {
        const { data: orderPayments, error: orderPayError } = await supabase.from('payments')
            .select('*').eq('order_id', order_id);
        if (orderPayError) throw orderPayError;
        const recorded = getSingle(orderPayments);
        if (recorded) {
            await refundDuplicatePayment(razorpay_payment_id, Number(payment.amount), order_id);
        } else {
            const { error: insertError } = await supabase.from('payments').insert({
                order_id, amount: Number(payment.amount) / 100, status: 'HELD', razorpay_payment_id,
            });
            if (insertError) {
                // Lost a race: re-read; a row for this order now exists.
                const { data: raced, error: raceError } = await supabase.from('payments')
                    .select('*').eq('order_id', order_id);
                if (raceError) throw raceError;
                const saved = getSingle(raced);
                if (!saved) throw insertError;
                if (saved.razorpay_payment_id !== razorpay_payment_id) {
                    await refundDuplicatePayment(razorpay_payment_id, Number(payment.amount), order_id);
                }
            }
        }
    }

    if (order.status === 'PAID') return order;
    const updates = { status: 'PAID' };
    if (!order.delivery_deadline) {
        updates.delivery_deadline = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    }
    const { data: updated, error: updateError } = await supabase.from('orders')
        .update(updates).eq('id', order_id).eq('status', 'CONFIRMED').select('*');
    if (updateError) throw updateError;
    const paidOrder = getSingle(updated);
    // Only the transition that actually flipped CONFIRMED -> PAID is
    // logged; a replay (order already PAID) returns below without a row.
    if (paidOrder) {
        await logAudit(buyer_id, 'order.paid', { order_id });
        return paidOrder;
    }

    const latest = await fetchOrder(order_id);
    if (latest.status === 'PAID') return latest;
    throw new AppError(409, 'ORDER_NOT_PAYABLE', 'This order is no longer awaiting payment.');
};

// 2c. Webhook entry: a payment.captured event for a Razorpay order. Finds
// the internal order by its stored razorpay_order_id and marks it PAID
// through the same idempotent path as the browser callback. Returns null
// when the Razorpay order is not ours — logged, not an error, so the
// webhook is acknowledged instead of retried forever.
exports.handlePaymentCaptured = async (payment) => {
    if (!payment || !payment.order_id || !payment.id) return null;
    const { data, error } = await supabase.from('orders')
        .select('*').eq('razorpay_order_id', payment.order_id);
    if (error) throw error;
    const order = getSingle(data);
    if (!order) {
        console.warn(`Webhook payment.captured for unknown Razorpay order ${payment.order_id}; no internal order.`);
        return null;
    }
    return exports.verifyAndMarkPaid(order.id, payment.order_id, payment.id, order.buyer_id);
};

// 2b. Farmer Update Status Logic (with Stock Management).
// Allowed farmer transitions. COMPLETED is intentionally absent: only the
// buyer's delivery confirmation can complete an order and update payment status.
// There is no path back from 'CONFIRMED'/'DECLINED' — a revert would let a
// second confirm decrement stock again.
const ORDER_TRANSITIONS = {
    PENDING: ['CONFIRMED', 'DECLINED'],
    CREATED: ['CONFIRMED', 'DECLINED'],
};

exports.updateOrderStatusWithStock = async (orderId, farmerId, newStatus) => {
    const order = await fetchOrder(orderId);
    if (order.farmer_id !== farmerId) throw notAccessible();
    if (!(ORDER_TRANSITIONS[order.status] || []).includes(newStatus)) {
        throw new AppError(409, 'INVALID_TRANSITION', 'This status change is not allowed for the order.');
    }

    if (newStatus === 'CONFIRMED') {
        const { data, error } = await supabase.rpc('confirm_order_and_reserve_stock', {
            p_order_id: orderId, p_farmer_id: farmerId,
        });
        if (error) {
            if (/ORDER_NOT_ACCESSIBLE/.test(error.message)) throw notAccessible();
            if (/INSUFFICIENT_STOCK/.test(error.message)) throw new AppError(409, 'INSUFFICIENT_STOCK', 'Insufficient stock for this order.');
            if (/INVALID_QUANTITY/.test(error.message)) throw new AppError(400, 'INVALID_QUANTITY', 'Quantity must be a positive number.');
            if (/INVALID_TRANSITION/.test(error.message)) throw new AppError(409, 'INVALID_TRANSITION', 'This order has already been processed.');
            throw error;
        }
        const confirmed = getSingle(Array.isArray(data) ? data : data ? [data] : null);
        await logAudit(farmerId, 'order.confirmed', { order_id: orderId });
        return confirmed;
    }

    const { data, error } = await supabase.from('orders').update({ status: newStatus })
        .eq('id', orderId).eq('farmer_id', farmerId).eq('status', order.status).select('*');
    if (error) throw error;
    const updated = getSingle(data);
    if (!updated) throw new AppError(409, 'INVALID_TRANSITION', 'This order has already been processed.');
    await logAudit(farmerId, 'order.declined', { order_id: orderId });
    return updated;
};

// 3. Mark Order as Shipped — farmer-only, and only after payment.
exports.markOrderAsShipped = async (order_id, farmer_id) => {
    const order = await fetchOrder(order_id);
    if (order.farmer_id !== farmer_id) throw notAccessible();
    const { data, error } = await supabase
        .from('orders')
        .update({ status: 'SHIPPED' })
        .eq('id', order_id)
        .eq('farmer_id', farmer_id)
        .eq('status', 'PAID')
        .select('*');

    if (error) throw error;
    const updated = getSingle(data);
    if (!updated) {
        throw new AppError(409, 'ORDER_NOT_SHIPPABLE', 'Only a paid order can be shipped.');
    }
    await logAudit(farmer_id, 'order.shipped', { order_id });
    return updated;
};

// 4. Mark Order as Completed — buyer-only, only from PAID
// or SHIPPED, and only with a HELD payment. The order update is the
// serialization point (gated on PAID/SHIPPED); if the payment release then
// finds no HELD payment, the order is rolled back to its previous status.
exports.markOrderAsCompleted = async (order_id, buyer_id) => {
    const order = await fetchOrder(order_id);
    if (order.buyer_id !== buyer_id) throw notAccessible();
    if (!['PAID', 'SHIPPED'].includes(order.status)) {
        throw new AppError(409, 'ORDER_NOT_RELEASABLE', 'Only a paid or shipped order can be completed.');
    }

    // Capture the previous status BEFORE the update: the fetched row is a
    // live reference, so order.status changes once the update applies.
    const prevStatus = order.status;
    const completedAt = new Date().toISOString();
    const { data, error: orderError } = await supabase
        .from('orders')
        .update({ status: 'COMPLETED', completed_at: completedAt })
        .eq('id', order_id)
        .in('status', ['PAID', 'SHIPPED'])
        .select('*');
    if (orderError) throw orderError;
    const updated = getSingle(data);
    if (!updated) {
        throw new AppError(409, 'ORDER_NOT_RELEASABLE', 'Only a paid or shipped order can be completed.');
    }

    const { data: payData, error: paymentError } = await supabase
        .from('payments')
        .update({ status: 'RELEASED' })
        .eq('order_id', order_id)
        .eq('status', 'HELD')
        .select('*');
    if (paymentError) {
        // The order is already COMPLETED — roll it back, otherwise the
        // payment stays HELD forever with no reconciler (audit H2). The
        // completion timestamp is cleared too: the order never completed.
        const { error: rollbackError } = await supabase.from('orders')
            .update({ status: prevStatus, completed_at: null }).eq('id', order_id);
        if (rollbackError) console.error('Failed to roll back order after payment-release error:', rollbackError.message);
        throw paymentError;
    }
    if (!payData || payData.length === 0) {
        // No HELD payment to release — roll the order back and refuse.
        // The completion timestamp is cleared with it.
        const { error: rollbackError } = await supabase.from('orders')
            .update({ status: prevStatus, completed_at: null }).eq('id', order_id);
        if (rollbackError) console.error('Failed to roll back order after unreleasable payment:', rollbackError.message);
        throw new AppError(409, 'ORDER_NOT_RELEASABLE', 'Only a paid or shipped order can be completed.');
    }

    await logAudit(buyer_id, 'order.completed', { order_id });
    return updated;
};

// 5a. Move an order into the refund queue (REFUND_PENDING).
// Manual calls (buyerId given): only the order's buyer, only from PAID /
// SHIPPED / REFUND_FAILED, and a SHIPPED order only after its delivery
// deadline has passed (a shipped order must not be refunded while the goods
// are still in transit). System calls (no buyerId — the auto-refund cron)
// skip the ownership/deadline checks; the cron enqueues only past-deadline
// orders itself. Idempotent: an order already REFUND_PENDING, REFUNDED,
// COMPLETED or CREATED is untouched (returns null).
exports.markRefundPending = async (order_id, opts = {}) => {
    const { buyerId = null } = opts;
    const order = await fetchOrder(order_id);
    if (buyerId !== null) {
        if (order.buyer_id !== buyerId) {
            throw new AppError(403, 'FORBIDDEN', 'You can only request a refund for your own orders.');
        }
        if (order.status === 'SHIPPED' && order.delivery_deadline && new Date(order.delivery_deadline) > new Date()) {
            throw new AppError(409, 'REFUND_NOT_ELIGIBLE', 'A shipped order can only be refunded after its delivery deadline has passed.');
        }
    }
    const { data, error } = await supabase
        .from('orders')
        .update({ status: 'REFUND_PENDING' })
        .in('status', ['PAID', 'SHIPPED', 'REFUND_FAILED'])
        .eq('id', order_id)
        .select('*');
    if (error) throw error;
    // A null row is the idempotent no-op (already REFUND_PENDING, REFUNDED,
    // COMPLETED or CREATED) — nothing changed, nothing to record. Only a
    // manual (buyer) request is logged; the cron's enqueue is a system
    // action covered by the order.refunded row when it completes.
    const requested = getSingle(data);
    if (requested && buyerId !== null) {
        await logAudit(buyerId, 'order.refund_requested', { order_id });
    }
    return requested;
};

// ---------------------------------------------------------------------------
// Refund processing (2026-11-08 security fix — reliability contract)
// ---------------------------------------------------------------------------

// Complete the post-gateway statuses. Every write is checked — a failure is
// thrown (post-gateway) instead of reported as success. The payment update
// tolerates a missing payment row (legacy data): the money is refunded and
// the ledger has it, so a missing row is logged, not fatal.
async function completeRefundStatuses(order_id, gatewayRefundId, message) {
    // Status-gated: only an order this caller claimed (REFUND_PROCESSING)
    // or the reconciler owns (REFUND_RECONCILE) may flip to REFUNDED, so
    // completion stays atomic with the claim (audit L5).
    const { data: orderRows, error: orderErr } = await supabase
        .from('orders').update({ status: 'REFUNDED' }).eq('id', order_id)
        .in('status', ['REFUND_PROCESSING', 'REFUND_RECONCILE']).select('*');
    if (orderErr) {
        throw Object.assign(new Error('Refund Failed: ' + orderErr.message), { postGateway: true, gateway_refund_id: gatewayRefundId });
    }
    if (!orderRows || orderRows.length === 0) {
        throw Object.assign(new Error('Refund Failed: order status update affected no rows'), { postGateway: true, gateway_refund_id: gatewayRefundId });
    }
    const { error: payErr } = await supabase
        .from('payments').update({ status: 'REFUNDED' }).eq('order_id', order_id).select('*');
    if (payErr) {
        throw Object.assign(new Error('Refund Failed: ' + payErr.message), { postGateway: true, gateway_refund_id: gatewayRefundId });
    }
    // The single completion point for every refund path (manual, cron,
    // reconciler) — actor is null: the initiator is not known here, and
    // the gateway refund id is the traceable handle.
    await logAudit(null, 'order.refunded', { order_id, gateway_refund_id: gatewayRefundId });
    return { success: true, message, gateway_refund_id: gatewayRefundId };
}

// List the gateway refunds for a payment and return the one for the full
// amount, if any. Used to avoid creating a duplicate refund after an
// ambiguous earlier attempt (the Razorpay SDK exposes no idempotency key).
async function findExistingGatewayRefund(paymentId, amountPaise) {
    try {
        const res = await razorpay.payments.fetchMultipleRefund(paymentId);
        const items = (res && res.items) || [];
        return items.find((r) => Number(r.amount) === Number(amountPaise)) || null;
    } catch (err) {
        // Listing is best-effort: if it fails, the caller still proceeds to
        // the refund call (the ledger's UNIQUE(order_id) is the backstop).
        console.warn('Could not list existing gateway refunds:', err.message);
        return null;
    }
}

// Refund a duplicate capture: the buyer paid twice for one order, so the
// second payment goes back to them in full. A failed refund is a 409 with
// a clear code — never a raw 500 with money captured and no ledger row.
async function refundDuplicatePayment(razorpayPaymentId, amountPaise, orderId) {
    try {
        await refundWithIdempotentRetry(razorpayPaymentId, amountPaise);
    } catch (err) {
        throw new AppError(409, 'PAYMENT_DUPLICATE', 'A second payment was captured for this order and its refund failed. Contact support with the payment id.');
    }
    console.warn(`Duplicate payment ${razorpayPaymentId} for order ${orderId} refunded at gateway; first payment remains the ledger row.`);
}

// Call the gateway refund with retries, re-checking for an existing refund
// before each retry so an ambiguous failure never creates a duplicate.
// A final failure is tagged transient: the gateway may have been briefly
// unavailable, and the refund must stay retryable.
async function refundWithIdempotentRetry(paymentId, amountPaise) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
            const found = await findExistingGatewayRefund(paymentId, amountPaise);
            if (found) return found;
            await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        }
        try {
            return await razorpay.payments.refund(paymentId, { amount: amountPaise });
        } catch (err) {
            lastErr = err;
            console.warn(`Refund gateway attempt ${attempt + 1} failed:`, err.message);
        }
    }
    throw Object.assign(
        new Error('Refund Failed: ' + (lastErr && lastErr.message)),
        { transient: true }
    );
}

// Best-effort retry bookkeeping (refund_attempts / next_retry_at — added by
// the 20261109 migration). If the columns do not exist yet the update fails
// and is ignored; the refund still returns to REFUND_PENDING for the cron.
async function setRefundRetryState(order_id) {
    const { data, error } = await supabase
        .from('orders').select('refund_attempts').eq('id', order_id);
    if (error) throw error;
    const order = getSingle(data);
    const attempts = Number((order && order.refund_attempts) || 0) + 1;
    const backoffHours = Math.min(Math.pow(2, attempts - 1), 24);
    const { error: updErr } = await supabase
        .from('orders')
        .update({
            refund_attempts: attempts,
            next_retry_at: new Date(Date.now() + backoffHours * 60 * 60 * 1000).toISOString(),
        })
        .eq('id', order_id);
    if (updErr) throw updErr;
}

// Internal: process a refund for an order ALREADY claimed
// (status = REFUND_PROCESSING, held by this caller). Reliability contract:
//  - A pending ledger row is written BEFORE the gateway call, so the gateway
//    refund id is never lost even if a later write fails.
//  - Before calling the gateway, list the gateway refunds for the payment:
//    if a full-amount refund already exists, reuse it.
//  - Transient gateway failures return the order to REFUND_PENDING (with a
//    retry counter + backoff) so the cron retries it; they are never terminal.
//  - Post-gateway failures go to REFUND_RECONCILE with the gateway refund id
//    preserved on the error, so reconcileRefunds can complete the ledger.
//  - Permanent (data) failures go to REFUND_FAILED; a buyer can re-enqueue
//    those manually via markRefundPending.
async function processClaimedRefund(order) {
    const order_id = order.id;
    let gatewayRefundId = null;
    try {
        // 1. Pending ledger row FIRST. If a row already exists with a gateway
        //    refund id, the refund already happened — complete the statuses
        //    and return without touching the gateway.
        const { data: existing, error: refErr } = await supabase
            .from('refunds')
            .select('*')
            .eq('order_id', order_id);
        if (refErr) throw refErr;
        const existingRefund = getSingle(existing);
        if (existingRefund && existingRefund.gateway_refund_id) {
            return await completeRefundStatuses(order_id, existingRefund.gateway_refund_id, 'Refund already processed');
        }
        if (!existingRefund) {
            const { error: pendErr } = await supabase.from('refunds').insert({
                order_id,
                gateway_refund_id: null,
                status: 'PENDING',
                amount: order.total_price,
            });
            if (pendErr) {
                // A concurrent insert won the UNIQUE(order_id) race — re-read.
                // Prefer the stable Postgres code 23505; keep the message
                // check as a fallback for clients that do not surface it.
                if (pendErr.code === '23505' || String(pendErr.message || '').includes('duplicate key')) {
                    const { data: dup, error: dupErr } = await supabase
                        .from('refunds').select('*').eq('order_id', order_id);
                    if (dupErr) throw dupErr;
                    const dupRow = getSingle(dup);
                    if (dupRow && dupRow.gateway_refund_id) {
                        return await completeRefundStatuses(order_id, dupRow.gateway_refund_id, 'Refund already processed');
                    }
                    // A PENDING row exists but no gateway id yet — proceed to
                    // the gateway call; the post-gateway update fills it in.
                } else {
                    throw pendErr;
                }
            }
        }

        // 2. Get the payment (Razorpay payment id + amount) for the gateway call.
        const { data: paymentData, error: fetchError } = await supabase
            .from('payments')
            .select('*')
            .eq('order_id', order_id);
        if (fetchError) throw fetchError;
        const payment = getSingle(paymentData);
        if (!payment) throw new Error('Payment not found for order');
        if (!payment.razorpay_payment_id) throw new Error('No Razorpay payment id stored for this order (cannot refund at gateway)');

        // 3. Gateway refund (full amount, paise), idempotent across retries.
        const amountPaise = Math.round(Number(payment.amount || order.total_price) * 100);
        const existingGateway = await findExistingGatewayRefund(payment.razorpay_payment_id, amountPaise);
        const refund = existingGateway
            || await refundWithIdempotentRetry(payment.razorpay_payment_id, amountPaise);
        gatewayRefundId = refund.id;

        // 4. Record the gateway refund id on the pending ledger row.
        const { data: ledgerRows, error: ledgerErr } = await supabase
            .from('refunds')
            .update({ gateway_refund_id: refund.id, status: 'REFUNDED', amount: payment.amount || order.total_price })
            .eq('order_id', order_id)
            .select('*');
        if (ledgerErr) {
            throw Object.assign(new Error('Refund Failed: ' + ledgerErr.message), { postGateway: true, gateway_refund_id: refund.id });
        }
        if (!ledgerRows || ledgerRows.length === 0) {
            throw Object.assign(new Error('Refund Failed: ledger row missing for order'), { postGateway: true, gateway_refund_id: refund.id });
        }

        // 5. Complete the statuses (errors checked — never silent success).
        return await completeRefundStatuses(order_id, refund.id, 'Refund Processed (Status Updated)');
    } catch (err) {
        // Post-gateway failures: the money already left at the gateway, so
        // the order goes to REFUND_RECONCILE (never a terminal state) with
        // the gateway refund id preserved for the reconciler.
        if (err && err.postGateway) {
            await supabase.from('orders').update({ status: 'REFUND_RECONCILE' }).eq('id', order_id);
            throw Object.assign(
                new Error('Refund Failed: ' + err.message),
                { postGateway: true, gateway_refund_id: err.gateway_refund_id || gatewayRefundId }
            );
        }
        // Transient gateway failures: back to REFUND_PENDING so the cron
        // retries it (retry counter + backoff, best-effort).
        if (err && err.transient) {
            await supabase.from('orders').update({ status: 'REFUND_PENDING' }).eq('id', order_id);
            await setRefundRetryState(order_id).catch(() => {});
            throw new Error('Refund Failed: ' + err.message);
        }
        // Permanent (data) failures: terminal REFUND_FAILED. A buyer can
        // re-enqueue these manually via markRefundPending.
        await supabase.from('orders').update({ status: 'REFUND_FAILED' }).eq('id', order_id);
        throw new Error('Refund Failed: ' + err.message);
    }
}

// 5. Refund Order (idempotent).
// Atomic claim first: only the caller that flips REFUND_PENDING ->
// REFUND_PROCESSING proceeds. A caller that cannot claim gets an HONEST
// answer: success=true only when the refund already completed earlier;
// any other state is success=false with a code (the refund did not happen).
exports.refundOrder = async (order_id) => {
    const { data: claimed, error: claimError } = await supabase
        .from('orders')
        .update({ status: 'REFUND_PROCESSING' })
        .eq('id', order_id)
        .eq('status', 'REFUND_PENDING')
        .select('*');
    if (claimError) throw new Error('Refund Failed: ' + claimError.message);
    const order = getSingle(claimed);
    if (!order) {
        const current = await fetchOrder(order_id);
        if (current.status === 'REFUNDED') {
            return { success: true, message: 'Refund already processed', alreadyHandled: true };
        }
        if (current.status === 'REFUND_PROCESSING') {
            return { success: false, message: 'Refund already in progress', code: 'REFUND_IN_PROGRESS', alreadyHandled: true };
        }
        if (current.status === 'REFUND_RECONCILE') {
            return { success: false, message: 'Refund needs reconciliation. Please contact support.', code: 'REFUND_NEEDS_RECONCILE', alreadyHandled: true };
        }
        return { success: false, message: 'Refund not processed. The order is not awaiting a refund.', code: 'REFUND_NOT_PENDING', alreadyHandled: true };
    }
    return processClaimedRefund(order);
};

// 5b. Reconcile orders stuck in REFUND_RECONCILE: the gateway refund
// succeeded but a later write failed. Re-read the gateway refund (from the
// ledger row, or by listing the payment's refunds) and complete the ledger +
// statuses. Never calls the gateway refund again.
exports.reconcileRefunds = async () => {
    try {
        const { data: stuck, error } = await supabase
            .from('orders').select('*').eq('status', 'REFUND_RECONCILE').limit(50);
        if (error) throw error;
        for (const order of stuck || []) {
            try {
                await reconcileOneRefund(order);
                console.log(`Reconciled refund for order ${order.id}`);
            } catch (err) {
                console.error(`Reconcile failed for order ${order.id}:`, err.message);
            }
        }
    } catch (err) {
        console.error('Reconcile Refunds Job Error:', err);
    }
};

async function reconcileOneRefund(order) {
    const order_id = order.id;
    const { data: existing, error: refErr } = await supabase
        .from('refunds').select('*').eq('order_id', order_id);
    if (refErr) throw refErr;
    const refund = getSingle(existing);
    let gatewayRefundId = refund && refund.gateway_refund_id;

    if (!gatewayRefundId) {
        // No gateway id on the ledger: find it at the gateway by listing the
        // payment's refunds.
        const { data: paymentData, error: payErr } = await supabase
            .from('payments').select('*').eq('order_id', order_id);
        if (payErr) throw payErr;
        const payment = getSingle(paymentData);
        if (!payment || !payment.razorpay_payment_id) {
            throw new Error('Cannot reconcile: no payment record for order');
        }
        const amountPaise = Math.round(Number(payment.amount || order.total_price) * 100);
        const found = await findExistingGatewayRefund(payment.razorpay_payment_id, amountPaise);
        if (!found) throw new Error('Cannot reconcile: no gateway refund found for this payment');
        gatewayRefundId = found.id;
        if (refund) {
            const { error: updErr } = await supabase.from('refunds')
                .update({ gateway_refund_id: gatewayRefundId, status: 'REFUNDED', amount: payment.amount || order.total_price })
                .eq('order_id', order_id);
            if (updErr) throw updErr;
        } else {
            const { error: insErr } = await supabase.from('refunds').insert({
                order_id, gateway_refund_id: gatewayRefundId, status: 'REFUNDED', amount: payment.amount || order.total_price,
            });
            if (insErr) throw insErr;
        }
    } else if (refund.status !== 'REFUNDED') {
        const { error: updErr } = await supabase.from('refunds')
            .update({ status: 'REFUNDED' }).eq('order_id', order_id);
        if (updErr) throw updErr;
    }

    await completeRefundStatuses(order_id, gatewayRefundId, 'Refund reconciled');
}

// 6. Auto Refund Job (cron-safe: overlapping runs cannot refund the same order twice)
exports.autoRefundJob = async () => {
    try {
        const now = new Date().toISOString();

        // Step 1: Move past-deadline refundable orders into the refund queue.
        // Idempotent (PAID/SHIPPED -> REFUND_PENDING); two runs setting the
        // same target state is harmless.
        const { error: enqueueError } = await supabase
            .from('orders')
            .update({ status: 'REFUND_PENDING' })
            .in('status', ['PAID', 'SHIPPED'])
            .lt('delivery_deadline', now);
        if (enqueueError) throw enqueueError;
        // NULL-deadline rows (M4): enqueue only those older than the grace
        // period WITH a payments row, one at a time — a bulk update cannot
        // express the payments-row check, and a row with no payment has no
        // money to refund (it would only fail as REFUND_FAILED).
        const graceCutoff = new Date(Date.now() - NULL_DEADLINE_GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();
        const { data: nullDeadline, error: nullDeadlineError } = await supabase
            .from('orders')
            .select('id')
            .in('status', ['PAID', 'SHIPPED'])
            .is('delivery_deadline', null)
            .lt('created_at', graceCutoff)
            .limit(100);
        if (nullDeadlineError) throw nullDeadlineError;
        for (const row of nullDeadline || []) {
            const { data: payRows, error: payError } = await supabase.from('payments')
                .select('id').eq('order_id', row.id).limit(1);
            if (payError) throw payError;
            if (!payRows || payRows.length === 0) continue;
            const { error: enqueueOneError } = await supabase.from('orders')
                .update({ status: 'REFUND_PENDING' })
                .eq('id', row.id).in('status', ['PAID', 'SHIPPED']);
            if (enqueueOneError) throw enqueueOneError;
        }

        // Step 2: Atomically claim a batch with FOR UPDATE SKIP LOCKED.
        // Only this run's claimed rows are returned; a concurrent run skips them.
        let claimed = [];
        let claimedViaRpc = false;
        const { data: rpcData, error: rpcError } = await supabase.rpc('claim_pending_refunds', { p_limit: 50 });
        if (rpcError) {
            // The migration function is not applied yet: fall back to a plain
            // select. Safety still holds — refundOrder atomically claims each
            // order (REFUND_PENDING -> REFUND_PROCESSING), so only one caller
            // per order proceeds to the gateway.
            console.warn('claim_pending_refunds RPC unavailable, falling back to per-order claim:', rpcError.message);
            // Filter + order in the query: selecting the first 50 rows and
            // filtering in JS starves due refunds when the first 50 are all
            // future-retry (audit L3).
            const now = new Date().toISOString();
            const { data: pending, error: pendingError } = await supabase
                .from('orders')
                .select('id, next_retry_at')
                .eq('status', 'REFUND_PENDING')
                .or(`next_retry_at.is.null,next_retry_at.lte.${now}`)
                .order('created_at', { ascending: true })
                .limit(50);
            if (pendingError) throw pendingError;
            claimed = pending || [];
        } else {
            claimed = rpcData || [];
            claimedViaRpc = true;
        }

        // Step 3: Refund each claimed order. Rows claimed via the RPC are
        // already REFUND_PROCESSING, so process them directly (no re-claim).
        // Rows from the fallback select go through refundOrder's atomic claim.
        for (let order of claimed) {
            console.log(`Auto refunding Order ID: ${order.id}...`);
            try {
                const res = claimedViaRpc
                    ? await processClaimedRefund(order)
                    : await exports.refundOrder(order.id);
                console.log(`Auto refund ${order.id}: ${res.message}`);
            } catch (jobErr) {
                console.error(`Error refunding order ${order.id} in cron job:`, jobErr.message);
            }
        }
    } catch (err) {
        console.error("Auto Refund Job Error:", err);
    }
};
