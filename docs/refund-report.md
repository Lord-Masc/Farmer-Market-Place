# Refund Idempotency — Before/After Report

Repo: `r1shabhsharma05/Farmer-Market-Place` (branch `main`)
Date: 2026-11-08
Scope: `backend/` escrow refund flow — `POST /refund` + hourly auto-refund cron

## Step 1 — Current state (inspected, no code changed)

### Refund endpoint
- `POST /api/escrow/refund` (also mounted at `/api/orders/refund`)
  - route: `backend/routes/orderRoutes.js` — `router.post('/refund', escrowController.refundOrder)`
  - controller: `backend/controllers/escrowController.js` — `refundOrder(req, res)` → `escrowService.refundOrder(order_id)`
  - success response: `{ success: true, message: 'Refund Processed (Status Updated)' }`
  - error response: `{ error: err.message }` (HTTP 500)

### Refund function — `backend/services/escrowService.js` `refundOrder(order_id)`
1. `SELECT` payment row from `payments` WHERE `order_id = $1`
2. `UPDATE orders SET status='REFUNDED' WHERE id=$1` — **no status guard**
3. `UPDATE payments SET status='REFUNDED' WHERE order_id=$1`
4. Returns `{ success: true, message: 'Refund Processed (Status Updated)' }`

**What it does NOT do:**
- It does **NOT call Razorpay**. There is no `razorpay.payments.refund(...)` anywhere in the repo. The "refund" only flips DB status — **no money moves**.
- It does **NOT check the order's current status**. It refunds any order, even one already `REFUNDED`.
- It does **NOT store a gateway refund id** (no `gateway_refund_id` column, no `refunds` table).
- There is **no `REFUND_PENDING`, `REFUND_PROCESSING`, or `REFUND_FAILED` status** anywhere in the codebase.

### Auto-refund cron — `backend/services/escrowService.js` `autoRefundJob()`
- Schedule: `cron.schedule('0 * * * *', ...)` in `backend/server.js` (every hour).
- Select: orders WHERE `status NOT IN ('COMPLETED','REFUNDED','CREATED')` AND `delivery_deadline < now`.
- For each order it calls `refundOrder(order.id)` sequentially; per-order errors are caught and logged.
- **No row locking, no advisory lock, no "already claimed" check.** Two overlapping runs can select the same order.

### Tables (live code vs schema.sql)
- Live code uses `orders` (`id, buyer_id, farmer_id, product_id, total_price, quantity, unit_at_order, delivery_address, buyer_phone, delivery_deadline, status`) and `payments` (`order_id, amount, status` HELD/RELEASED/REFUNDED).
- `supabase_backend/schema.sql` is **STALE**: its `orders` table has only (`id, buyer_id, product_id, amount, status` Pending/Shipped/Delivered/Cancelled) and there is **no `payments` table at all**. The live tables were created outside this file. The new `refunds` migration will be a separate file, not an edit to `schema.sql`.
- No `refunds` table exists.
- `payments` has **no `razorpay_payment_id` column** (`markOrderAsPaid` receives it but does not store it — see the comment in `escrowService.js`). A real gateway refund needs this id.

### Current status flow
```
CREATED → PAID → SHIPPED → COMPLETED   (escrow released)
                   ↘ REFUNDED           (via POST /refund or cron, from any non-terminal state)
```
Farmer approval uses lowercase `pending`/`confirmed` (inconsistent casing, pre-existing).

### Where a duplicate refund can happen
1. **Manual double-call:** Two concurrent `POST /refund` for the same `order_id`. Both read the payment, both `UPDATE orders→REFUNDED` and `payments→REFUNDED`, both return success. Today this only double-flips status (no money moves, because there is no gateway call). The moment a gateway refund is added, both calls would refund money → the customer is paid twice.
2. **Cron overlap:** Two overlapping hourly runs both `SELECT` the same past-deadline order (no `FOR UPDATE SKIP LOCKED`, no lock). Both call `refundOrder` → duplicate.
3. **Cron + manual:** A manual `/refund` and a cron run overlap on the same order → duplicate.
4. **No idempotency key:** No `UNIQUE(order_id)` constraint and no stored `gateway_refund_id`, so nothing in the DB prevents a second refund.

### Test setup
- No Jest installed; no existing tests in `backend/` or `Server/`.
- `backend/package.json` has no `"test"` script.

## Step 2 — BEFORE result (concurrency reproduction)

**Status: BLOCKED — could not be measured from this VM. No BEFORE numbers exist.**

The script `scripts/refund-concurrency-test.js` was written and run (2026-11-08 ~02:03 IST). It failed fast at the first Supabase call:

- Result: `SUPABASE_UNREACHABLE: TypeError: fetch failed`, exit code 2.
- Requests sent: 0. No test order was created, no refund request was fired, no rows were written.
- Root cause (verified by curl, 2026-11-08): the VM's egress proxy establishes a CONNECT tunnel to the live Supabase project host (`ibelaipphuggkncovptw.supabase.co:443`, HTTP 200 Connection Established) but the host then returns **"Empty reply from server" (curl code 000)** on every path (`/`, `/rest/v1/`, `/auth/v1/health`), with and without a browser User-Agent, and on retry. The host is unreachable from this VM; it is not transient or path-specific.
- Control checks from the same VM: `api.supabase.com` reachable (401), `api.github.com` reachable (403), `example.com` reachable (200), Razorpay `api.razorpay.com` reachable (401). Only the project-specific `*.supabase.co` host is blocked.
- Consequence: the concurrency test cannot create test data, cannot run a working backend (every refund call needs Supabase), and cannot measure duplicate refunds against the live project from this VM. **No BEFORE numbers are reported — inventing them would be fabrication.**
- The script is committed and ready to run from any machine that can reach the live Supabase (e.g. Rishabh's laptop). It needs the migration (`supabase/migrations/20261108_create_refunds.sql`) applied first for the AFTER run, and a real Razorpay test-mode payment id (env `TEST_RAZORPAY_PAYMENT_ID`) for the gateway call to succeed.
- Security note: `Server/.env` and `backend/.env` are already tracked in git and publicly readable on GitHub (raw URLs return 200). No new secret files were added and no keys were rotated (per Rishabh's explicit order). The exposure is pre-existing.

## Step 4 — AFTER result (concurrency re-run after the fix)

**Live re-run status: BLOCKED — same as BEFORE. No AFTER numbers exist.**

The same script (`scripts/refund-concurrency-test.js`) was re-run against the FIXED code (2026-11-08 ~02:07 IST). It failed identically at the first Supabase call:

- Result: `SUPABASE_UNREACHABLE: TypeError: fetch failed`, exit code 2.
- Requests sent: 0. No test order was created, no refund request was fired, no rows were written.
- Root cause: unchanged — the live Supabase project host is unreachable from this VM (egress proxy returns "Empty reply from server"). See Step 2 for the evidence.
- **No AFTER numbers are reported — inventing them would be fabrication.** The before/after table below therefore has no live values; it records the block honestly.

**What WAS verified instead (Jest unit tests, mocked Supabase + mocked Razorpay):**

`backend/tests/refund.test.js` — 4/4 passed, `npm test` exit 0, 3.711s (2026-11-08):

| Test | Result | Time |
|---|---|---|
| (1) double call — second refund is a no-op, exactly 1 gateway call | PASS | 75 ms |
| (2) concurrent calls — 50 parallel, only 1 processes, 0 duplicates | PASS | 14 ms |
| (3) cron overlap — two concurrent autoRefundJob runs, no duplicate | PASS | 19 ms |
| (4) gateway failure — order ends REFUND_FAILED, not stuck (3 gateway attempts) | PASS | 3,023 ms |

These are unit tests, not the live concurrency run. The mock models Postgres semantics faithfully (the atomic `UPDATE … WHERE status='REFUND_PENDING'` executes synchronously in one tick, like a row-locked UPDATE), so the concurrency logic is genuinely exercised — but the numbers are from the mocked harness, not from live Supabase. They are labelled as such and must not be quoted as live production numbers.

**To get the live BEFORE/AFTER numbers**, run `node scripts/refund-concurrency-test.js` from a machine that can reach the live Supabase host (e.g. Rishabh's laptop), after applying `supabase/migrations/20261108_create_refunds.sql` in the Supabase SQL editor and setting a real Razorpay test-mode payment id in `TEST_RAZORPAY_PAYMENT_ID`.

## Before / After table (live concurrency run)

| Metric | Before | After |
|---|---|---|
| Requests sent | not measured (live Supabase unreachable from VM) | not measured (live Supabase unreachable from VM) |
| Duplicate refunds | not measured | not measured |
| Total over-refunded amount | not measured | not measured |
| p95 latency | not measured | not measured |

_No live numbers exist for this table. Both the BEFORE and AFTER live runs failed at the first Supabase call (`SUPABASE_UNREACHABLE`, exit 2, 0 requests sent) because this VM's egress proxy cannot reach the live Supabase project host. Nothing in this table is estimated or invented._

**Measured numbers that DO exist (Jest unit tests, mocked — see Step 4):** 4/4 tests passed; 50 parallel refund calls → exactly 1 gateway call, 1 refund row, 0 duplicates; 2 overlapping cron runs → 1 refund row, 1 gateway call; gateway failure → order REFUND_FAILED after 3 attempts. These are unit-test measurements, not live production numbers.
