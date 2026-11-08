const Razorpay = require('razorpay');
const { createClient } = require('@supabase/supabase-js');
const { AppError, notAccessible } = require('../utils/errors');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
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

// Helper: Retry logic for API calls (exponential backoff — delay doubles each attempt)
const retryAsync = async (fn, retries = 3, delay = 1000) => {
    let currentDelay = delay;
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i === retries - 1) throw err;
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

// Atomic stock decrement: optimistic conditional update — the write only
// succeeds if the quantity is still the value just read, so two concurrent
// confirms cannot both decrement from the same stock (lost update). Retries
// the read on contention (bounded).
async function decrementStockAtomic(productId, orderQty, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const { data: prodData, error: readErr } = await supabase
            .from('products').select('quantity').eq('id', productId);
        if (readErr) throw readErr;
        const product = getSingle(prodData);
        if (!product) throw notAccessible();
        const currentStock = Number(product.quantity || 0);
        if (currentStock < orderQty) {
            throw new AppError(400, 'INSUFFICIENT_STOCK', 'Insufficient stock for this order.');
        }
        const { data: updated, error: updErr } = await supabase
            .from('products')
            .update({ quantity: currentStock - orderQty })
            .eq('id', productId)
            .eq('quantity', currentStock)
            .select('*');
        if (updErr) throw updErr;
        if (updated && updated.length > 0) return currentStock - orderQty;
        // 0 rows: another writer changed the stock — re-read and retry.
        if (attempt === maxAttempts) {
            throw new AppError(409, 'STOCK_CONFLICT', 'Stock changed while confirming. Please try again.');
        }
    }
}

// 1. Create Razorpay Order.
// Price binding: the charge must equal the product's listed price x quantity.
// The product row is the source of truth — a forged client-side amount (or a
// forged seller) can never reach Razorpay. The stored total_price is always
// the server-validated amount, so a forged direct-insert total is corrected
// here before any money moves.
exports.createRazorpayOrder = async (buyer_id, seller_id, amount, product_id, quantity, unit, delivery_address, buyer_phone, existing_order_id = null) => {
    try {
        const amountNum = Number(amount);
        if (!Number.isFinite(amountNum) || amountNum <= 0) {
            throw new AppError(400, 'INVALID_AMOUNT', 'Invalid amount provided.');
        }

        // Existing-order branch: validate the order BEFORE creating a Razorpay
        // order, so a rejected call creates nothing. Only the order's buyer,
        // only while the order is still CREATED (unpaid).
        let existing = null;
        if (existing_order_id) {
            existing = await fetchOrder(existing_order_id);
            if (existing.buyer_id !== buyer_id) {
                throw new AppError(403, 'FORBIDDEN', 'You can only modify your own orders.');
            }
            if (existing.status !== 'CREATED') {
                throw new AppError(409, 'ORDER_NOT_EDITABLE', 'Only an unpaid order can be updated.');
            }
        }

        // Product lookup + price binding. product_id is required: without a
        // product there is nothing to bind the amount against.
        const effectiveProductId = product_id || (existing && existing.product_id);
        if (!effectiveProductId) {
            throw new AppError(400, 'INVALID_PRODUCT', 'A product is required to create an order.');
        }
        const { data: prodData, error: prodErr } = await supabase
            .from('products').select('*').eq('id', effectiveProductId);
        if (prodErr) throw prodErr;
        const product = getSingle(prodData);
        if (!product) throw notAccessible();
        if (product.farmer_id !== seller_id) {
            throw new AppError(400, 'INVALID_SELLER', 'The seller does not match this product.');
        }
        const unitPrice = Number(product.user_price ?? product.price);
        if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
            throw new AppError(400, 'INVALID_PRODUCT_PRICE', 'This product has no valid price.');
        }
        // The authoritative quantity is the stored one for an existing order,
        // the caller's (validated) quantity for a new order.
        const qty = existing ? validateQuantity(existing.quantity) : validateQuantity(quantity);
        if (existing && quantity !== undefined && quantity !== null && Number(quantity) !== qty) {
            throw new AppError(400, 'AMOUNT_MISMATCH', 'The quantity does not match the order.');
        }
        const expectedAmount = unitPrice * qty;
        if (Math.round(expectedAmount * 100) !== Math.round(amountNum * 100)) {
            throw new AppError(400, 'AMOUNT_MISMATCH', 'The amount does not match the product price.');
        }

        const options = {
            amount: Math.round(amountNum * 100), // paise
            currency: "INR",
            receipt: `receipt_${String(buyer_id).slice(0, 8)}_${Date.now()}`
        };

        console.log('📝 Creating Razorpay order with options:', options);

        let order;
        try {
            // Retry Razorpay order creation with exponential backoff
            order = await retryAsync(
                () => razorpay.orders.create(options),
                3,
                1500
            );
            console.log('✅ Razorpay order created successfully:', order.id);
        } catch (razorpayErr) {
            console.error('⚠️ Razorpay API failed:', razorpayErr.message);
            console.warn('FALLBACK: Using test order ID for development');

            // Fallback for development/testing
            order = {
                id: `order_test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                entity: 'order',
                amount: options.amount,
                amount_paid: 0,
                amount_due: options.amount,
                currency: options.currency,
                receipt: options.receipt,
                created_at: Math.floor(Date.now() / 1000)
            };
            console.log('📋 Using fallback test order:', order.id);
        }

        const deadline = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
        let data, error;
        if (existing) {
            // Existing-order branch: address/phone corrections ONLY. The
            // delivery deadline is set once at creation and NEVER reset here
            // (a reset would let a seller evade the auto-refund forever).
            // The stored total is corrected to the server-validated amount.
            ({ data, error } = await supabase
                .from('orders')
                .update({
                    delivery_address: delivery_address || '',
                    buyer_phone: buyer_phone || '',
                    total_price: expectedAmount,
                })
                .eq('id', existing_order_id)
                .eq('buyer_id', buyer_id)
                .eq('status', 'CREATED')
                .select('*'));
        } else {
            ({ data, error } = await supabase
                .from('orders')
                .insert({
                    buyer_id,
                    farmer_id: seller_id,
                    product_id: effectiveProductId,
                    total_price: expectedAmount,
                    status: 'CREATED',
                    quantity: qty,
                    unit_at_order: unit || 'kg',
                    delivery_address: delivery_address || '',
                    buyer_phone: buyer_phone || '',
                    delivery_deadline: deadline,
                })
                .select('*'));
        }

        if (error) throw error;
        const result = getSingle(data);
        if (!result) throw new AppError(500, 'ORDER_CREATE_FAILED', 'Order creation failed on database.');

        return {
            order_id: result.id,
            razorpay_order_id: order.id,
            amount: options.amount
        };
    } catch (err) {
        if (err instanceof AppError) throw err;
        console.error('❌ Razorpay Order Error Details:', {
            message: err.message,
            code: err.code,
            statusCode: err.statusCode,
            stack: err.stack
        });
        throw new AppError(500, 'ORDER_CREATE_FAILED', 'Order creation failed.');
    }
};

// 2. Verify a Razorpay payment server-side and mark the order PAID.
// Binds the payment to the order: the Razorpay signature is checked by the
// controller, then this verifies (a) the payment exists at Razorpay and is
// captured, (b) its amount equals the order total, (c) it belongs to the
// Razorpay order used at checkout, and (d) it has not already been used for
// another order (replay). Only CREATED orders can become PAID, and only by
// their own buyer. The recorded payment amount is the gateway-verified one.
exports.verifyAndMarkPaid = async (order_id, razorpay_order_id, razorpay_payment_id, buyer_id) => {
    const order = await fetchOrder(order_id);
    if (order.buyer_id !== buyer_id) {
        throw new AppError(403, 'FORBIDDEN', 'You can only pay for your own orders.');
    }
    if (order.status !== 'CREATED') {
        throw new AppError(409, 'ORDER_NOT_PAYABLE', 'Only an unpaid order can be paid.');
    }

    // The gateway is the source of truth, not the caller-supplied ids.
    let payment;
    try {
        payment = await razorpay.payments.fetch(razorpay_payment_id);
    } catch (err) {
        throw new AppError(400, 'PAYMENT_NOT_FOUND', 'The payment could not be verified with the gateway.');
    }
    if (!payment || payment.status !== 'captured') {
        throw new AppError(400, 'PAYMENT_NOT_CAPTURED', 'The payment is not captured.');
    }
    if (payment.order_id !== razorpay_order_id) {
        throw new AppError(400, 'PAYMENT_ORDER_MISMATCH', 'The payment does not belong to this checkout.');
    }
    const paidPaise = Number(payment.amount);
    const expectedPaise = Math.round(Number(order.total_price) * 100);
    if (!Number.isFinite(paidPaise) || paidPaise !== expectedPaise) {
        throw new AppError(400, 'AMOUNT_MISMATCH', 'The paid amount does not match the order total.');
    }

    // Replay guard: this payment id must not already be recorded.
    const { data: existing, error: exErr } = await supabase
        .from('payments').select('order_id').eq('razorpay_payment_id', razorpay_payment_id);
    if (exErr) throw exErr;
    if (existing && existing.length > 0) {
        throw new AppError(409, 'PAYMENT_ALREADY_USED', 'This payment has already been used for another order.');
    }

    // Mark PAID, gated on still being CREATED (a concurrent verify loses).
    // Backfill the delivery deadline if it was never set, so the auto-refund
    // can never miss this order.
    const updates = { status: 'PAID' };
    if (!order.delivery_deadline) {
        updates.delivery_deadline = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    }
    const { data: updatedData, error: orderError } = await supabase
        .from('orders').update(updates).eq('id', order_id).eq('status', 'CREATED').select('*');
    if (orderError) throw orderError;
    const updatedOrder = getSingle(updatedData);
    if (!updatedOrder) {
        throw new AppError(409, 'ORDER_NOT_PAYABLE', 'Only an unpaid order can be paid.');
    }

    const { error: payErr } = await supabase.from('payments').insert({
        order_id,
        amount: paidPaise / 100,
        status: 'HELD',
        // Stored so a refund can call the Razorpay gateway (see refunds migration).
        razorpay_payment_id,
    });
    if (payErr) throw payErr;

    return updatedOrder;
};

// 2b. Farmer Update Status Logic (with Stock Management).
// Allowed farmer transitions. COMPLETED is intentionally absent: it is only
// reachable via confirm-delivery, which also releases the escrow payment.
// There is no path back from 'confirmed'/'declined' — a revert would let a
// second confirm decrement stock again.
const ORDER_TRANSITIONS = {
    pending: ['confirmed', 'declined'],
    CREATED: ['confirmed', 'declined'],
};

exports.updateOrderStatusWithStock = async (orderId, farmerId, newStatus) => {
    const order = await fetchOrder(orderId);
    if (order.farmer_id !== farmerId) throw notAccessible();
    const allowed = ORDER_TRANSITIONS[order.status] || [];
    if (!allowed.includes(newStatus)) {
        throw new AppError(409, 'INVALID_TRANSITION', 'This status change is not allowed for the order.');
    }

    // Stock: only 'confirmed' decrements, at most once per order (the
    // transition map above makes a second confirm unreachable), and the
    // decrement is atomic (conditional update + retry on contention).
    if (newStatus === 'confirmed' && order.product_id) {
        const qty = validateQuantity(order.quantity);
        const orderQty = order.unit_at_order === 'quintal' ? qty * 100 : qty;
        await decrementStockAtomic(order.product_id, orderQty);
    }

    const { data: finalData, error: updateError } = await supabase
        .from('orders')
        .update({ status: newStatus })
        .eq('id', orderId)
        .select('*');

    if (updateError) throw updateError;
    const finalOrder = getSingle(finalData);
    if (!finalOrder) throw new AppError(500, 'STATUS_UPDATE_FAILED', 'Status update failed.');
    return finalOrder;
};

// 3. Mark Order as Shipped — farmer-only, and only from PAID or confirmed.
exports.markOrderAsShipped = async (order_id, farmer_id) => {
    const order = await fetchOrder(order_id);
    if (order.farmer_id !== farmer_id) throw notAccessible();
    const { data, error } = await supabase
        .from('orders')
        .update({ status: 'SHIPPED' })
        .eq('id', order_id)
        .eq('farmer_id', farmer_id)
        .in('status', ['PAID', 'confirmed'])
        .select('*');

    if (error) throw error;
    const updated = getSingle(data);
    if (!updated) {
        throw new AppError(409, 'ORDER_NOT_SHIPPABLE', 'Only a paid or confirmed order can be shipped.');
    }
    return updated;
};

// 4. Mark Order as Completed (RELEASES ESCROW) — buyer-only, only from PAID
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
    const { data, error: orderError } = await supabase
        .from('orders')
        .update({ status: 'COMPLETED' })
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
    if (paymentError) throw paymentError;
    if (!payData || payData.length === 0) {
        // No HELD payment to release — roll the order back and refuse.
        await supabase.from('orders').update({ status: prevStatus }).eq('id', order_id);
        throw new AppError(409, 'ORDER_NOT_RELEASABLE', 'Only a paid or shipped order can be completed.');
    }

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
    return getSingle(data);
};

// ---------------------------------------------------------------------------
// Refund processing (2026-11-08 security fix — reliability contract)
// ---------------------------------------------------------------------------

// Complete the post-gateway statuses. Every write is checked — a failure is
// thrown (post-gateway) instead of reported as success. The payment update
// tolerates a missing payment row (legacy data): the money is refunded and
// the ledger has it, so a missing row is logged, not fatal.
async function completeRefundStatuses(order_id, gatewayRefundId, message) {
    const { data: orderRows, error: orderErr } = await supabase
        .from('orders').update({ status: 'REFUNDED' }).eq('id', order_id).select('*');
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
                if (String(pendErr.message || '').includes('duplicate key')) {
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
        // same target state is harmless. A NULL deadline means the order
        // never got one — it is overdue by definition, so enqueue it too.
        const { error: enqueueError } = await supabase
            .from('orders')
            .update({ status: 'REFUND_PENDING' })
            .in('status', ['PAID', 'SHIPPED'])
            .lt('delivery_deadline', now);
        if (enqueueError) throw enqueueError;
        const { error: nullDeadlineError } = await supabase
            .from('orders')
            .update({ status: 'REFUND_PENDING' })
            .in('status', ['PAID', 'SHIPPED'])
            .is('delivery_deadline', null);
        if (nullDeadlineError) throw nullDeadlineError;

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
            const { data: pending, error: pendingError } = await supabase
                .from('orders')
                .select('id')
                .eq('status', 'REFUND_PENDING')
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
