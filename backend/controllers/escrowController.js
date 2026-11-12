const escrowService = require('../services/escrowService');
const crypto = require('crypto');
const { AppError } = require('../utils/errors');

// Errors are passed to the central error handler (server.js), which logs
// them server-side and returns only a generic message + stable code —
// controllers never echo err.message (that leaked order existence, ownership
// and exact stock levels). Caller identity always comes from req.user (the
// verified JWT), never from the request body.

exports.createOrder = async (req, res, next) => {
    try {
        const { order_id } = req.body;
        if (!order_id) throw new AppError(400, 'MISSING_ORDER', 'An approved order is required.');
        const orderData = await escrowService.createRazorpayOrder(req.user.id, order_id);
        res.status(201).json(orderData);
    } catch (err) {
        next(err);
    }
};

// Create a marketplace order server-side (Stage 0, M2). Only the product,
// quantity, unit and delivery address are accepted from the client —
// totals, farmer and contact details are derived by the service and any
// client-supplied values for them are dropped, never forwarded.
exports.createMarketplaceOrder = async (req, res, next) => {
    try {
        const { product_id, quantity, unit, delivery_address, buyer_phone } = req.body || {};
        if (!product_id || quantity === undefined || quantity === null || !delivery_address) {
            throw new AppError(400, 'MISSING_FIELDS', 'Product, quantity and delivery address are required.');
        }
        const order = await escrowService.createMarketplaceOrder(
            req.user.id,
            { product_id, quantity, unit, delivery_address, buyer_phone },
            req.headers['idempotency-key'],
        );
        res.status(201).json(order);
    } catch (err) {
        next(err);
    }
};

exports.verifyPayment = async (req, res, next) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, order_id } = req.body;
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !order_id) {
            throw new AppError(400, 'MISSING_FIELDS', 'Missing required payment fields.');
        }
        const secret = process.env.RAZORPAY_KEY_SECRET;
        if (!secret) throw new AppError(503, 'PAYMENT_UNAVAILABLE', 'Payment verification is temporarily unavailable.');
        const hmac = crypto.createHmac('sha256', secret);
        hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
        const generated_signature = hmac.digest('hex');
        const received = Buffer.from(String(razorpay_signature), 'hex');
        const expected = Buffer.from(generated_signature, 'hex');

        if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
            throw new AppError(400, 'INVALID_SIGNATURE', 'Invalid signature.');
        }
        // The service verifies the payment against Razorpay (captured status,
        // amount match, order binding, replay) before marking the order PAID.
        const updatedOrder = await escrowService.verifyAndMarkPaid(order_id, razorpay_order_id, razorpay_payment_id, req.user.id);
        res.status(200).json({ success: true, order: updatedOrder });
    } catch (err) {
        next(err);
    }
};

// Razorpay webhook (Stage 0, H1). The signature is verified over the RAW
// body — the route is mounted with express.raw() in server.js, before the
// JSON parser, because parsing re-serialises and breaks the signature.
// Only payment.captured is acted on; every other event is acknowledged
// and ignored. A 4xx inside the handler is acknowledged (retrying cannot
// fix it); a 5xx is passed on so Razorpay retries.
function verifyWebhookSignature(rawBody, signature, secret) {
    if (!signature || !Buffer.isBuffer(rawBody)) return false;
    let received;
    try {
        received = Buffer.from(String(signature), 'hex');
    } catch (_) {
        return false;
    }
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

exports.handleRazorpayWebhook = async (req, res, next) => {
    try {
        const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
        if (!secret) throw new AppError(503, 'PAYMENT_UNAVAILABLE', 'Payment webhook is temporarily unavailable.');
        const rawBody = req.body;
        if (!verifyWebhookSignature(rawBody, req.headers['x-razorpay-signature'], secret)) {
            throw new AppError(400, 'INVALID_SIGNATURE', 'Invalid webhook signature.');
        }
        let event;
        try {
            event = JSON.parse(rawBody.toString('utf8'));
        } catch (_) {
            throw new AppError(400, 'INVALID_PAYLOAD', 'Webhook payload is not valid JSON.');
        }
        if (!event || event.event !== 'payment.captured') {
            return res.status(200).json({ received: true, ignored: true });
        }
        const payment = event.payload && event.payload.payment && event.payload.payment.entity;
        if (!payment || !payment.id || !payment.order_id) {
            throw new AppError(400, 'INVALID_PAYLOAD', 'Webhook payment payload is incomplete.');
        }
        try {
            await escrowService.handlePaymentCaptured(payment);
        } catch (err) {
            // Unknown errors and 5xx: let Razorpay retry. 4xx: the event
            // cannot be applied — acknowledge it instead of retrying forever.
            if (!err || err.status === undefined || err.status >= 500) throw err;
            console.error('Webhook payment.captured could not be applied:', err.message);
        }
        return res.status(200).json({ received: true });
    } catch (err) {
        next(err);
    }
};

exports.updateStatus = async (req, res, next) => {
    try {
        const { orderId, newStatus } = req.body;
        if (!orderId || !newStatus) {
            throw new AppError(400, 'MISSING_FIELDS', 'Missing required fields: orderId, newStatus.');
        }
        // farmerId is derived from the JWT, never from the request body.
        const result = await escrowService.updateOrderStatusWithStock(orderId, req.user.id, newStatus);
        res.status(200).json({ success: true, order: result });
    } catch (err) {
        next(err);
    }
};

exports.shipOrder = async (req, res, next) => {
    try {
        const { order_id } = req.body;
        if (!order_id) throw new AppError(400, 'MISSING_FIELDS', 'Missing required field: order_id.');
        const updatedOrder = await escrowService.markOrderAsShipped(order_id, req.user.id);
        res.status(200).json({ success: true, order: updatedOrder });
    } catch (err) {
        next(err);
    }
};

exports.confirmDelivery = async (req, res, next) => {
    try {
        const { order_id } = req.body;
        if (!order_id) throw new AppError(400, 'MISSING_FIELDS', 'Missing required field: order_id.');
        const updatedOrder = await escrowService.markOrderAsCompleted(order_id, req.user.id);
        res.status(200).json({ success: true, order: updatedOrder });
    } catch (err) {
        next(err);
    }
};

exports.refundOrder = async (req, res, next) => {
    try {
        const { order_id } = req.body;
        if (!order_id) throw new AppError(400, 'MISSING_FIELDS', 'Missing required field: order_id.');
        // Manual refunds: buyer-only, and a SHIPPED order only after its
        // delivery deadline has passed. The service enforces both.
        await escrowService.markRefundPending(order_id, { buyerId: req.user.id });
        const result = await escrowService.refundOrder(order_id);
        // Honest responses: a refund that did not happen is an error, never
        // a success. success=true + alreadyHandled only means the refund
        // already completed earlier.
        if (!result.success) {
            return res.status(409).json({
                success: false,
                message: result.message,
                code: result.code || 'REFUND_NOT_PROCESSED',
                alreadyHandled: !!result.alreadyHandled,
            });
        }
        res.status(200).json({
            success: true,
            message: result.message,
            gateway_refund_id: result.gateway_refund_id || undefined,
            alreadyHandled: !!result.alreadyHandled,
        });
    } catch (err) {
        next(err);
    }
};
