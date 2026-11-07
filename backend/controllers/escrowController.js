const escrowService = require('../services/escrowService');
const crypto = require('crypto');

exports.createOrder = async (req, res) => {
    try {
        const { buyer_id, seller_id, amount, product_id, quantity, unit, delivery_address, buyer_phone, order_id } = req.body;
        if(!buyer_id || !seller_id || !amount) {
            return res.status(400).json({ error: 'Missing required fields: buyer_id, seller_id, amount' });
        }
        const orderData = await escrowService.createRazorpayOrder(buyer_id, seller_id, amount, product_id, quantity, unit, delivery_address, buyer_phone, order_id);
        res.status(201).json(orderData);
    } catch (err) {
        console.error("Create Order Controller Error:", err);
        res.status(500).json({ error: err.message });
    }
};

exports.verifyPayment = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, order_id } = req.body;
        const secret = process.env.RAZORPAY_KEY_SECRET;
        const hmac = crypto.createHmac('sha256', secret);
        hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
        const generated_signature = hmac.digest('hex');

        if (generated_signature === razorpay_signature) {
            const updatedOrder = await escrowService.markOrderAsPaid(order_id, razorpay_payment_id);
            res.status(200).json({ success: true, order: updatedOrder });
        } else {
            res.status(400).json({ error: 'Invalid signature' });
        }
    } catch (err) {
        console.error("Verify Payment Controller Error:", err);
        res.status(500).json({ error: err.message });
    }
};

exports.updateStatus = async (req, res) => {
    try {
        const { orderId, farmerId, newStatus } = req.body;
        const result = await escrowService.updateOrderStatusWithStock(orderId, farmerId, newStatus);
        res.status(200).json({ success: true, order: result });
    } catch (err) {
        console.error("Update Status Controller Error:", err);
        res.status(500).json({ error: err.message });
    }
};

exports.shipOrder = async (req, res) => {
    try {
        const { order_id } = req.body;
        const updatedOrder = await escrowService.markOrderAsShipped(order_id);
        res.status(200).json({ success: true, order: updatedOrder });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.confirmDelivery = async (req, res) => {
    try {
        const { order_id } = req.body;
        const updatedOrder = await escrowService.markOrderAsCompleted(order_id);
        res.status(200).json({ success: true, order: updatedOrder });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.refundOrder = async (req, res) => {
    try {
        const { order_id } = req.body;
        // Enqueue first (idempotent: PAID/SHIPPED -> REFUND_PENDING), then the
        // atomic claim inside refundOrder decides who actually processes it.
        // Response shape unchanged: { success, message } / { error }.
        await escrowService.markRefundPending(order_id);
        const result = await escrowService.refundOrder(order_id);
        res.status(200).json({ success: true, message: result.message });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
