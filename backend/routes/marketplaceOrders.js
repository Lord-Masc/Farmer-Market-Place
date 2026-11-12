const express = require('express');
const router = express.Router();
const escrowController = require('../controllers/escrowController');
const requireAuth = require('../middleware/requireAuth');

// Marketplace order creation (Stage 0, M2): the only order-creation path.
// Mounted at /api/orders. Every route requires a verified Supabase JWT;
// identity comes from req.user, never the body.
router.use(requireAuth);

// Create an order — price, farmer and totals are derived server-side.
router.post('/', escrowController.createMarketplaceOrder);

module.exports = router;
