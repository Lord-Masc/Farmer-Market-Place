require('dotenv').config();
const express = require('express');
const orderRoutes = require('./routes/orderRoutes');
const marketplaceOrders = require('./routes/marketplaceOrders');
const uploadRoutes = require('./routes/uploadRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const adminRoutes = require('./routes/adminRoutes');
const verificationRoutes = require('./routes/verificationRoutes');
const passportRoutes = require('./routes/passportRoutes');
const negotiationRoutes = require('./routes/negotiationRoutes');
const groupBuyRoutes = require('./routes/groupBuyRoutes');
const cron = require('node-cron');
const { autoRefundJob, reconcileRefunds } = require('./services/escrowService');
const { reconcileUnpaidOrders } = require('./jobs/reconcile');
const { corsMiddleware, securityHeaders, rateLimit } = require('./middleware/security');
const { errorHandler } = require('./utils/errors');

const app = express();
const PORT = process.env.PORT || 5001;

app.disable('x-powered-by');

// Render terminates TLS at its proxy, so req.ip is the proxy's IP unless
// Express trusts it — without this, every client shares one rate-limit
// bucket and no single abusive IP can be throttled (audit M1).
app.set('trust proxy', 1);

// Middleware — allowlisted CORS, security headers, rate limiting, JSON.
// (2026-11-08 security fix: the wildcard CORS + no headers + no rate limit
// that shipped before let any website call the escrow API.)
app.use(corsMiddleware);
app.use(securityHeaders);
// Razorpay webhook FIRST, with a raw body: the HMAC signature is verified
// over the exact bytes Razorpay sent — express.json() would re-serialise
// them and break verification. The webhook router has no JWT auth; the
// signature is its authentication.
app.use('/api/razorpay/webhook', express.raw({ type: 'application/json' }), webhookRoutes);
app.use(express.json());
app.use(rateLimit());

// Routes (every escrow route requires a verified Supabase JWT — see routes).
// Per-route limits (Stage 0, M5) sit under the global 300/15min cap: order
// creation and money actions get a tighter budget, uploads tighter still
// (5 MB each). The webhook is NOT limited — Razorpay retries must get
// through, and the HMAC signature is its authentication.
app.use('/api/escrow', rateLimit({ max: 100 }), orderRoutes);
app.use('/api/orders', rateLimit({ max: 60 }), marketplaceOrders); // Order creation (Stage 0, M2)
app.use('/api/uploads', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' }), rateLimit({ max: 30 }), uploadRoutes);
app.use('/api/admin', rateLimit({ max: 100 }), adminRoutes); // Admin review + roles (Stage 1)
app.use('/api/verification', rateLimit({ max: 60 }), verificationRoutes); // Farmer verification submit (Stage 1)
app.use('/api', rateLimit({ max: 60 }), passportRoutes); // Crop passports (Stage 2, module A)
app.use('/api', rateLimit({ max: 60 }), negotiationRoutes); // Negotiation (Stage 4, module C)
app.use('/api/group-buys', rateLimit({ max: 60 }), groupBuyRoutes); // Smart group selling (Stage 5, module D)

// Health Check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date() });
});

// NOTE: GET /debug/config was removed in the 2026-11-08 security fix — it
// disclosed environment-variable presence to unauthenticated callers.

// Central error handler (must be last; returns generic messages only).
app.use(errorHandler);

// Start Cron Job for Auto Refund (Every hour)
cron.schedule('0 * * * *', async () => {
    console.log('Running Auto Refund Job...');
    await autoRefundJob();
    // Reconcile refunds whose gateway call succeeded but a later write failed.
    await reconcileRefunds();
});

// Reconcile confirmed-but-unpaid orders (every 30 minutes): the backstop
// for payments the webhook and browser callback both missed.
cron.schedule('*/30 * * * *', async () => {
    console.log('Running Unpaid-Order Reconciliation Job...');
    const counts = await reconcileUnpaidOrders();
    console.log('Reconciliation result:', counts);
});

app.listen(PORT, () => {
    console.log(`\n✅ Escrow Backend running on http://localhost:${PORT}`);
    console.log(`📡 Health Check: http://localhost:${PORT}/health\n`);
});
