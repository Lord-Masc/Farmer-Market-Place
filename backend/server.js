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
const logisticsRoutes = require('./routes/logisticsRoutes');
const transporterRoutes = require('./routes/transporterRoutes');
const disputeRoutes = require('./routes/disputeRoutes');
const assistantRoutes = require('./routes/assistantRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const transparencyRoutes = require('./routes/transparencyRoutes');
const fairPriceRoutes = require('./routes/fairPriceRoutes');
const cron = require('node-cron');
const { autoRefundJob, reconcileRefunds } = require('./services/escrowService');
const { reconcileUnpaidOrders } = require('./jobs/reconcile');
const { processPending: processPendingNotifications } = require('./jobs/notificationWorker');
const { runMandiSync } = require('./jobs/mandiSync');
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
app.use('/api/shipments', rateLimit({ max: 60 }), logisticsRoutes); // Logistics & delivery (Stage 6, module E)
app.use('/api/transporters', rateLimit({ max: 60 }), transporterRoutes); // Transporter registration (Stage 6, module E)
app.use('/api', rateLimit({ max: 60 }), disputeRoutes); // Disputes & trust (Stage 7, module F)
app.use('/api/assistant', assistantRoutes); // AI farmer assistant (Stage 8, module G; chat 30 / voice 10 limits live on the routes)
app.use('/api/notifications', notificationRoutes); // Notifications & communication (Stage 9, module H; per-route limits live in the router)
app.use('/api/transparency', rateLimit({ max: 60 }), transparencyRoutes); // Public transparency dashboard (Stage 10, module I; no auth — aggregated metrics only)
app.use('/api/fairprice', rateLimit({ max: 60 }), fairPriceRoutes); // FairPrice (Stage 3, module B; public price reads, authed alerts — per-route limits live in the router)

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

// Deliver pending notifications (every 5 minutes): email/sms rows emit()
// left 'pending' (in-app rows are already 'sent' — the inbox IS the
// delivery). The worker re-checks preferences and quiet hours before
// every attempt and retries failures with backoff, so a run that finds
// nothing due is a cheap no-op.
cron.schedule('*/5 * * * *', async () => {
    console.log('Running Notification Delivery Job...');
    const counts = await processPendingNotifications();
    console.log('Notification delivery result:', counts);
});

// Sync mandi prices from data.gov.in (twice daily, ~11:00 + ~20:30 IST):
// the job is idempotent (UNIQUE + ON CONFLICT DO NOTHING), so a
// re-run inserts nothing new; a failed run leaves yesterday's snapshot
// in place and returns ok:false. Without DATA_GOV_API_KEY it logs a
// clear error and no-ops — it never crashes the server.
for (const time of ['30 11 * * *', '30 20 * * *']) {
    cron.schedule(time, async () => {
        console.log('Running Mandi Price Sync Job...');
        const summary = await runMandiSync();
        console.log('Mandi sync result:', JSON.stringify(summary));
    }, { timezone: 'Asia/Kolkata' });
}

app.listen(PORT, () => {
    console.log(`\n✅ Escrow Backend running on http://localhost:${PORT}`);
    console.log(`📡 Health Check: http://localhost:${PORT}/health\n`);
});
