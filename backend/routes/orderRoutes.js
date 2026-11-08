const express = require('express');
const router = express.Router();
const escrowController = require('../controllers/escrowController');
const requireAuth = require('../middleware/requireAuth');

// Every escrow route requires a verified Supabase JWT (2026-11-08 security
// fix: all six endpoints were unauthenticated, so any caller could release
// escrow, refund, or flip order state with just an order id). Ownership and
// state checks live in the service layer, keyed off req.user.id.
router.use(requireAuth);

// 1. Create Order
router.post('/create-order', escrowController.createOrder);

// 2. Verify Payment
router.post('/verify-payment', escrowController.verifyPayment);

// 2b. General Update Status (Used by Farmer Dashboard)
router.post('/update-status', escrowController.updateStatus);

// 3. Ship Order
router.post('/ship-order', escrowController.shipOrder);

// 4. Confirm Delivery
router.post('/confirm-delivery', escrowController.confirmDelivery);

// 5. Refund
router.post('/refund', escrowController.refundOrder);

module.exports = router;
