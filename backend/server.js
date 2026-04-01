require('dotenv').config();
const express = require('express');
const cors = require('cors');
const orderRoutes = require('./routes/orderRoutes');
const cron = require('node-cron');
const { autoRefundJob } = require('./services/escrowService');

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/escrow', orderRoutes);
app.use('/api/orders', orderRoutes); // Legacy support for farmer dashboard

// Health Check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date() });
});

// Debug endpoint to check env vars
app.get('/debug/config', (req, res) => {
    res.json({
        razorpay_key_id: process.env.RAZORPAY_KEY_ID ? '✅ Set' : '❌ Missing',
        razorpay_key_secret: process.env.RAZORPAY_KEY_SECRET ? '✅ Set' : '❌ Missing',
        supabase_url: process.env.SUPABASE_URL ? '✅ Set' : '❌ Missing',
        node_env: process.env.NODE_ENV || 'development'
    });
});

// Start Cron Jab for Auto Refund (Every hour)
cron.schedule('0 * * * *', async () => {
    console.log('Running Auto Refund Job...');
    await autoRefundJob();
});

app.listen(PORT, () => {
    console.log(`\n✅ Escrow Backend running on http://localhost:${PORT}`);
    console.log(`📡 Health Check: http://localhost:${PORT}/health\n`);
});
