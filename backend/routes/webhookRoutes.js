const express = require('express');
const router = express.Router();
const escrowController = require('../controllers/escrowController');

// Razorpay webhook (Stage 0, H1). Deliberately NO requireAuth: Razorpay
// has no Supabase JWT — the HMAC signature over the raw body IS the auth
// (verified in the controller). Mounted with express.raw() in server.js,
// before the JSON parser.
router.post('/', escrowController.handleRazorpayWebhook);

module.exports = router;
