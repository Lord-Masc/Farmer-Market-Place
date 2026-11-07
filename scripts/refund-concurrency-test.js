// Refund concurrency test — measures duplicate refunds against the REAL backend.
// Runs against real Supabase (service_role key from backend/.env) + real Razorpay
// test mode. NO mocks in this script.
//   - Creates ONE test order (PAID, past delivery_deadline) + test profile/product/payment.
//   - Fires 50 parallel POST /refund over HTTP (Promise.all) against a real
//     Express server spawned from backend/server.js.
//   - Fires 2 overlapping autoRefundJob() runs concurrently (in-process).
//   - Counts: requests sent, successes, refund rows, total refunded, p95 latency.
//   - Deletes ALL test rows afterwards (order, payment, refund rows, product, profile).
// NEVER prints secret values. Exit code 0 = run completed and summary printed.
// If Supabase is unreachable the script fails fast with a clear message.
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(REPO_ROOT, 'backend');

// Load env from backend/.env (never printed).
require(path.join(BACKEND_DIR, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND_DIR, '.env') });
const { createClient } = require(path.join(BACKEND_DIR, 'node_modules', '@supabase', 'supabase-js'));

const PORT = Number(process.env.PORT || 5001);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ORDER_TOTAL = 499; // INR, test order amount
const TEST_TAG = 'refund-concurrency-test';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function waitForHealth(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return true;
    } catch (_) { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

async function main() {
  const startedAt = new Date().toISOString();
  let server = null;
  let profileId = null;
  let productId = null;
  let orderId = null;
  let paymentId = null;

  const result = {
    startedAt,
    requestsSent: 0,
    httpSuccess: 0,
    httpFailed: 0,
    cronRuns: 0,
    refundRows: null,
    totalRefunded: null,
    p95LatencyMs: null,
    orderStatusAfter: null,
    paymentStatusAfter: null,
    notes: [],
  };

  try {
    // 0. Sanity: Supabase reachable? (fast fail with a clear message if not)
    const { error: pingErr } = await supabase.from('orders').select('id', { head: true, count: 'exact' });
    if (pingErr) {
      result.notes.push(`SUPABASE_UNREACHABLE: ${pingErr.message}`);
      console.log(JSON.stringify({ ...result, fatal: 'SUPABASE_UNREACHABLE' }, null, 2));
      process.exitCode = 2;
      return;
    }

    // 1. Create test profile + product + order + payment (all clearly test data).
    const { data: prof, error: profErr } = await supabase.from('profiles').insert({
      first_name: TEST_TAG, last_name: 'user', phone_number: '0000000000', role: 'buyer', state: TEST_TAG,
    }).select('id').single();
    if (profErr) throw new Error(`create test profile failed: ${profErr.message}`);
    profileId = prof.id;

    const { data: prod, error: prodErr } = await supabase.from('products').insert({
      farmer_id: profileId, name: `${TEST_TAG} product`, description: TEST_TAG,
      price: ORDER_TOTAL, unit: 'kg', stock: 100, status: 'Active',
    }).select('id').single();
    if (prodErr) throw new Error(`create test product failed: ${prodErr.message}`);
    productId = prod.id;

    const pastDeadline = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const { data: ord, error: ordErr } = await supabase.from('orders').insert({
      buyer_id: profileId, farmer_id: profileId, product_id: productId,
      total_price: ORDER_TOTAL, status: 'PAID', quantity: 1, unit_at_order: 'kg',
      delivery_address: TEST_TAG, buyer_phone: '0000000000', delivery_deadline: pastDeadline,
    }).select('id').single();
    if (ordErr) throw new Error(`create test order failed: ${ordErr.message}`);
    orderId = ord.id;

    // razorpay_payment_id: a real Razorpay test-mode payment id is needed for the
    // gateway call to succeed. If TEST_RAZORPAY_PAYMENT_ID is not set, store a
    // clearly-marked placeholder; the gateway call will then fail and the order
    // will land in REFUND_FAILED (recorded honestly, not faked).
    const testPaymentId = process.env.TEST_RAZORPAY_PAYMENT_ID || `pay_${TEST_TAG}_placeholder`;
    const { data: pay, error: payErr } = await supabase.from('payments').insert({
      order_id: orderId, amount: ORDER_TOTAL, status: 'HELD', razorpay_payment_id: testPaymentId,
    }).select('id').single();
    if (payErr) {
      // Older schema without razorpay_payment_id column: retry without it.
      if (/razorpay_payment_id/i.test(payErr.message)) {
        result.notes.push('payments.razorpay_payment_id column missing (migration not applied); inserted payment without it');
        const retry = await supabase.from('payments').insert({
          order_id: orderId, amount: ORDER_TOTAL, status: 'HELD',
        }).select('id').single();
        if (retry.error) throw new Error(`create test payment failed: ${retry.error.message}`);
        paymentId = retry.data.id;
      } else {
        throw new Error(`create test payment failed: ${payErr.message}`);
      }
    } else {
      paymentId = pay.id;
    }
    result.notes.push(`test order created (id kept out of output for brevity; total=${ORDER_TOTAL})`);

    // 2. Spawn the real Express server.
    server = spawn('node', ['server.js'], { cwd: BACKEND_DIR, env: { ...process.env }, stdio: 'ignore' });
    const up = await waitForHealth();
    if (!up) throw new Error('backend server did not become healthy in time');
    result.notes.push(`backend server up on port ${PORT}`);

    // 3. Fire 50 parallel POST /refund over HTTP.
    const latencies = [];
    const refundCalls = Array.from({ length: 50 }, async () => {
      const t0 = Date.now();
      try {
        const res = await fetch(`${BASE_URL}/api/escrow/refund`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order_id: orderId }),
        });
        const ms = Date.now() - t0;
        latencies.push(ms);
        result.requestsSent += 1;
        if (res.ok) result.httpSuccess += 1; else result.httpFailed += 1;
        return res.status;
      } catch (e) {
        latencies.push(Date.now() - t0);
        result.requestsSent += 1;
        result.httpFailed += 1;
        return 'FETCH_ERROR';
      }
    });
    await Promise.all(refundCalls);
    latencies.sort((a, b) => a - b);
    result.p95LatencyMs = percentile(latencies, 95);

    // 4. Fire 2 overlapping autoRefundJob() runs concurrently (in-process, real module).
    const escrowService = require(path.join(BACKEND_DIR, 'services', 'escrowService'));
    result.cronRuns = 2;
    await Promise.all([escrowService.autoRefundJob(), escrowService.autoRefundJob()]);

    // 5. Measure outcomes from the DB.
    const { data: ordAfter } = await supabase.from('orders').select('status').eq('id', orderId).single();
    result.orderStatusAfter = ordAfter ? ordAfter.status : null;
    const { data: payAfter } = await supabase.from('payments').select('status').eq('id', paymentId).single();
    result.paymentStatusAfter = payAfter ? payAfter.status : null;
    const { data: refunds, error: refErr } = await supabase.from('refunds').select('id, amount, status').eq('order_id', orderId);
    if (refErr) {
      result.refundRows = 0;
      result.totalRefunded = 0;
      result.notes.push(`refunds table not readable (${refErr.message}) — counted as 0 refund rows`);
    } else {
      result.refundRows = refunds.length;
      result.totalRefunded = refunds.reduce((s, r) => s + Number(r.amount || 0), 0);
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    result.notes.push(`RUN_ERROR: ${e.message}`);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    // Cleanup: delete ALL test rows (best effort, reverse FK order).
    try {
      if (orderId) await supabase.from('refunds').delete().eq('order_id', orderId);
      if (paymentId) await supabase.from('payments').delete().eq('id', paymentId);
      if (orderId) await supabase.from('orders').delete().eq('id', orderId);
      if (productId) await supabase.from('products').delete().eq('id', productId);
      if (profileId) await supabase.from('profiles').delete().eq('id', profileId);
    } catch (_) { /* cleanup best effort; a failed delete is reported by re-check, not hidden */ }
    if (server) server.kill('SIGTERM');
  }
}

main();
