require('dotenv').config();
const express = require('express');
const orderRoutes = require('./routes/orderRoutes');
const cron = require('node-cron');
const { autoRefundJob, reconcileRefunds } = require('./services/escrowService');
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
app.use(express.json());
app.use(rateLimit());

// Routes (every escrow route requires a verified Supabase JWT — see routes).
app.use('/api/escrow', orderRoutes);
app.use('/api/orders', orderRoutes); // Legacy support for farmer dashboard

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

app.listen(PORT, () => {
    console.log(`\n✅ Escrow Backend running on http://localhost:${PORT}`);
    console.log(`📡 Health Check: http://localhost:${PORT}/health\n`);
});
