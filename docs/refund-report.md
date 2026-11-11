# Refund Idempotency — Before/After Report

> Update 2026-11-08 19:19 IST: the AFTER live run is now MEASURED
> too (see Step 4) — the Before/After table below is complete with
> real live numbers on both sides. BEFORE: 50 requests, 49 duplicates,
> ₹0 moved (no gateway call). AFTER: 50 requests, 0 duplicates,
> ₹499 refunded exactly once (verified at Razorpay).

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

**Status: MEASURED — live run 2026-11-08 17:15 IST against the NEW Supabase project (`prrshenqceqijkfapthl`). Pre-fix code at commit `45cff5c`, run from a disposable git worktree (`~/workspace/tmp-work/live-test`) with the new project's service key (transient use only, never recorded).**

| Metric | Measured |
|---|---|
| Requests sent | 50 |
| HTTP success | 50 (all 50 refund requests for ONE order returned success) |
| HTTP failed | 0 |
| Overlapping cron runs | 2 |
| Refund rows created | 0 (no refunds ledger existed in the old code) |
| Total refunded | ₹0 (old code never called Razorpay — no money moved) |
| p95 latency | 26,704 ms |
| Order status after | REFUNDED |
| Payment status after | REFUNDED |

Reading: all 50 parallel refund requests for a single ₹499 order succeeded — 49 of them were duplicates. The old code kept no record (no ledger, no gateway id), so nothing stopped the 2nd…50th refund. No money moved only because the old code had no gateway call at all; had it called Razorpay once per success, it would have refunded 50 × ₹499 = ₹24,950 (₹24,451 over-refunded). That counterfactual is a projection, not a measurement — the measured over-refund is ₹0. Cleanup verified: 0 test rows and 0 test auth users left behind.

Harness notes (worktree-only, the committed script is untouched): the test script needed three small fixes to run against the new schema — profiles.id has no DEFAULT (it is a FK to auth.users, so the run creates a throwaway auth user and uses its id), profiles.email_address is NOT NULL (a per-run test email is used), and products has no `status`/`stock` columns (the run uses `quantity` + `user_price`, which the live schema has). The refund logic under measurement is unchanged. Full raw output saved at `~/workspace/tmp-work/live-test/BEFORE-result.json`.

*Earlier attempt 2026-11-08 ~02:03 IST (OLD project) — blocked, kept for the record:*

The script `scripts/refund-concurrency-test.js` was written and run (2026-11-08 ~02:03 IST). It failed fast at the first Supabase call:

- Result: `SUPABASE_UNREACHABLE: TypeError: fetch failed`, exit code 2.
- Requests sent: 0. No test order was created, no refund request was fired, no rows were written.
- Root cause (verified by curl, 2026-11-08): the VM's egress proxy establishes a CONNECT tunnel to the live Supabase project host (`ibelaipphuggkncovptw.supabase.co:443`, HTTP 200 Connection Established) but the host then returns **"Empty reply from server" (curl code 000)** on every path (`/`, `/rest/v1/`, `/auth/v1/health`), with and without a browser User-Agent, and on retry. The host is unreachable from this VM; it is not transient or path-specific.
- Control checks from the same VM: `api.supabase.com` reachable (401), `api.github.com` reachable (403), `example.com` reachable (200), Razorpay `api.razorpay.com` reachable (401). Only the project-specific `*.supabase.co` host is blocked.
- Consequence: the concurrency test cannot create test data, cannot run a working backend (every refund call needs Supabase), and cannot measure duplicate refunds against the live project from this VM. **No BEFORE numbers are reported — inventing them would be fabrication.**
- The script is committed and ready to run from any machine that can reach the live Supabase (e.g. Rishabh's laptop). It needs the migration (`supabase/migrations/20261108_create_refunds.sql`) applied first for the AFTER run, and a real Razorpay test-mode payment id (env `TEST_RAZORPAY_PAYMENT_ID`) for the gateway call to succeed.
- Security note: `Server/.env` and `backend/.env` are already tracked in git and publicly readable on GitHub (raw URLs return 200). No new secret files were added and no keys were rotated (per Rishabh's explicit order). The exposure is pre-existing.

## Step 4 — AFTER result (concurrency re-run after the fix)

**Status: MEASURED — live run 2026-11-08 19:19 IST against the NEW Supabase project (`prrshenqceqijkfapthl`). Fixed code at commit `b83a11b`, run from the same disposable git worktree (`~/workspace/tmp-work/live-test`) with the new project's service key (transient use only, never recorded) and a fresh Razorpay TEST payment (`pay_TxhbJ7SigSoSX0`, ₹499, captured 19:15 IST).**

| Metric | Measured |
|---|---|
| Requests sent | 50 |
| HTTP success | 50 (the refund endpoint queues idempotently and returns 200; the dedup happens at the claim + ledger, see below) |
| HTTP failed | 0 |
| Overlapping cron runs | 2 |
| Refund rows created | 1 |
| Total refunded | ₹499 (exactly once) |
| p95 latency | 19,744 ms |
| Order status after | REFUNDED |
| Payment status after | REFUNDED |

Reading: 50 parallel refund requests for a single ₹499 order produced exactly ONE refund row and ONE gateway refund — verified at Razorpay itself (payment `pay_TxhbJ7SigSoSX0` now shows status `refunded`, `amount_refunded` 49900, `refund_status` full; exactly one refund `rfnd_TxhfdaZRsSwf5v`, ₹499, processed). The atomic claim (`REFUND_PENDING` → `REFUND_PROCESSING`) let one caller through and the `UNIQUE(order_id)` ledger blocked every duplicate. p95 improved from 26,704 ms (BEFORE) to 19,744 ms — less row-lock contention once duplicates stop piling onto the same order. Cleanup verified: 0 test rows and 0 test auth users left behind.

Getting here took two environment fixes (worktree-only harness, not repo code): (1) the Razorpay SDK (axios) cannot reach `api.razorpay.com` from this VM — axios's built-in proxy handling breaks on Node 24 and direct egress is blocked — so the run preloads a proxy shim (`NODE_OPTIONS='-r proxy-preload.js'`) that sets `axios.defaults.proxy = false` plus an `HttpsProxyAgent` as the default `httpsAgent`; (2) the committed Razorpay test keys returned 401, so the test keys were regenerated on the user's order (new key id `rzp_test_TxfzQ4VHMWadYH`) and the first test payment's refund was capped by the test-mode balance (max refundable = payment − fee = ₹488.02), so two fresh ₹499 test payments were created to build enough balance for a full ₹499 refund. The first payment (`pay_TxfktzUtPVz8F5`) was fully refunded during diagnosis (₹1 + ₹487.02) and is not used for the AFTER numbers. Full raw output saved at `~/workspace/tmp-work/live-test/AFTER-result.json`.

*Earlier attempt 2026-11-08 ~02:07 IST (OLD project) — blocked, kept for the record:*

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

**Both live runs are now done (BEFORE 17:15 IST, AFTER 19:19 IST)** — see the table below. A fresh live run is only needed if the refund code changes; it needs a real Razorpay test-mode payment id in `TEST_RAZORPAY_PAYMENT_ID` and the VM proxy shim for the Razorpay SDK (see Step 4).

## Before / After table (live concurrency run)

| Metric | Before | After |
|---|---|---|
| Requests sent | 50 | 50 |
| Duplicate refunds | 50 successes for 1 order (49 duplicates) | 0 duplicates — exactly 1 refund row, 1 gateway refund |
| Total over-refunded amount | ₹0 measured (old code never called the gateway; 50 successes would have refunded ₹24,950) | ₹0 over-refunded — ₹499 refunded exactly once (verified at Razorpay: rfnd_TxhfdaZRsSwf5v) |
| p95 latency | 26,704 ms | 19,744 ms |

_Both columns are live measurements: BEFORE from the 2026-11-08 17:15 IST run (Step 2), AFTER from the 2026-11-08 19:19 IST run (Step 4). Nothing in this table is estimated or invented._

**Measured numbers that DO exist (Jest unit tests, mocked — see Step 4):** 4/4 tests passed; 50 parallel refund calls → exactly 1 gateway call, 1 refund row, 0 duplicates; 2 overlapping cron runs → 1 refund row, 1 gateway call; gateway failure → order REFUND_FAILED after 3 attempts. These are unit-test measurements, not live production numbers.

## Summary

- **Fix implemented and committed** (Step 3): atomic claim (`UPDATE … WHERE status='REFUND_PENDING'`), `refunds` ledger with `UNIQUE(order_id)`, real Razorpay refund call with retry + exponential backoff, cron batch claim via `FOR UPDATE SKIP LOCKED` (with per-order atomic-claim fallback), failure → `REFUND_FAILED`. API response shape unchanged (`{success, message}` / `{error}`).
- **Live concurrency numbers: BOTH measured (BEFORE 2026-11-08 17:15 IST, AFTER 2026-11-08 19:19 IST).** BEFORE: 50 requests sent, 50 succeeded (49 duplicates), 0 refund rows, ₹0 refunded (no gateway call in old code), p95 26,704 ms. AFTER: 50 requests sent, 50 succeeded, 1 refund row, ₹499 refunded exactly once (verified at Razorpay: one refund `rfnd_TxhfdaZRsSwf5v`, payment `refunded`/`full`), p95 19,744 ms. The fix works end to end.
- **Migration prerequisite:** all three migrations in `supabase/migrations/` are applied on the NEW Supabase project (`prrshenqceqijkfapthl`, 2026-11-08, all "Success. No rows returned", all 7 tables verified). The old note that the migration "was NOT applied" referred to the OLD project and no longer applies.
- **How the live AFTER number was obtained:** a real Razorpay test-mode payment id (`pay_TxhbJ7SigSoSX0`, ₹499) in `TEST_RAZORPAY_PAYMENT_ID`, run at the fix commit `b83a11b` (see `docs/LIVE-TEST.md` Step 2), with the VM proxy shim for the Razorpay SDK (see Step 4). Both runs are done; no further live run is needed unless the refund code changes.
