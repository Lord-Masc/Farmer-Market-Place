const express = require('express');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();

// Shared middleware from the escrow backend (do not duplicate it here).
// These modules create their Supabase client at load time, so they must be
// required AFTER dotenv.config() above.
const requireAuth = require('../backend/middleware/requireAuth');
const { corsMiddleware, securityHeaders, rateLimit } = require('../backend/middleware/security');
const { AppError, errorHandler } = require('../backend/utils/errors');

const app = express();
const PORT = process.env.PORT || 5000;

// Supabase Setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

app.disable('x-powered-by');
app.use(corsMiddleware);
app.use(securityHeaders);
app.use(rateLimit());
app.use(express.json());

// --- ROUTES ---

// NOTE: POST /api/orders/update-status was REMOVED (audit 2026-11-08:
// it trusted caller-supplied farmerId, accepted any newStatus,
// double-decremented stock on re-confirm, and could set COMPLETED without
// releasing escrow). The escrow backend's POST /api/escrow/update-status
// (authenticated, state machine, atomic stock) is the single surviving
// status path. External callers of the legacy route now get 404.

// 1. Aggregated Farmer Dashboard Stats (Optimized Query)
// Authenticated: a farmer may only see their own analytics.
app.get('/api/farmer/:id/analytics', requireAuth, async (req, res, next) => {
    const { id } = req.params;
    try {
        if (id !== req.user.id) {
            throw new AppError(403, 'FORBIDDEN', 'Forbidden.');
        }

        const { data: orders, error } = await supabase
            .from('orders')
            .select('*')
            .eq('farmer_id', id);

        if (error) throw error;

        // Calculate business insights
        const deliveredOrders = orders.filter(o => o.status === 'delivered');
        const totalSales = deliveredOrders.reduce((acc, o) => acc + o.total_price, 0);
        const aov = deliveredOrders.length > 0 ? (totalSales / deliveredOrders.length) : 0;
        const lostRate = (orders.filter(o => o.status === 'declined').length / (orders.length || 1)) * 100;

        res.json({
            revenue: totalSales,
            avgOrderValue: Math.round(aov),
            totalTransactions: deliveredOrders.length,
            lostOpportunityRate: Math.round(lostRate)
        });
    } catch (err) {
        next(err);
    }
});

// 2. Health Check
app.get('/api', (req, res) => {
    res.json({
        name: "AgroConnect-Engine",
        version: "1.0.0",
        status: "Running 🚜",
        environment: process.env.NODE_ENV || 'development'
    });
});

// Central error handler (last middleware): AppErrors keep their status/code;
// anything else becomes a generic 500 with no internal detail echoed.
app.use(errorHandler);

app.listen(PORT, () => {
    console.log(`\n🚀 AgroConnect API is fully functional on http://localhost:${PORT}`);
    console.log(`📡 Access Health Check: http://localhost:${PORT}/api\n`);
});
