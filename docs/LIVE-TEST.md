# Live Test Runbook — Refund Idempotency (Before / After)

Run this against the NEW Supabase project (`prrshenqceqijkfapthl`,
created 2026-11-08 on the 14426 account). The VM **can** reach the
new project's host (verified 2026-11-08: `/` returns 404,
`/auth/v1/health` returns 401 — real HTTP responses), so this script
can run from the VM now. (The OLD project's host,
`ibelaipphuggkncovptw.supabase.co`, was unreachable from the VM —
curl 000, "Empty reply from server" — which is why this runbook used
to say "run it from a laptop".) Razorpay's API is reachable from the
VM.

## Commits

- Pre-fix commit (BEFORE): `45cff5cb368815eac5147bdf49163eae0c9fef05`
  (`45cff5c` — "Add refund concurrency test and BEFORE result")
- Fix commit (AFTER): `b83a11b706a7c9008265fc44a5e7e9ca267f260f`
  (`b83a11b` — "Make refunds idempotent: atomic claim, refunds ledger,
  gateway call with retry")

## Prerequisite — apply the migrations first

On a FRESH Supabase project, apply all three migrations in
`supabase/migrations/` in order in the SQL editor:

1. `20261108_base_schema.sql` — profiles, products, orders,
   payments, group_buys, group_buy_participants (+ RLS).
2. `20261108_create_refunds.sql` — the `refunds` table (UNIQUE on
   `order_id`), `payments.razorpay_payment_id`, and the
   `claim_pending_refunds` function (FOR UPDATE SKIP LOCKED).
3. `20261109_security_hardening.sql` — service-role-only RPC lock,
   refund retry columns, payments UNIQUE, policy replacements, CHECKs.

On the new project (`prrshenqceqijkfapthl`) all three are already
applied (2026-11-08) — just confirm the tables exist:
`SELECT * FROM public.refunds LIMIT 1;` should return 0 rows
(empty table, no error).

Do NOT skip this step. The fixed code assumes the migrations are
applied; without them the AFTER run will fail on the missing tables.

## Prerequisite — a Razorpay TEST-mode payment id

Set the environment variable `TEST_RAZORPAY_PAYMENT_ID` to a real
Razorpay **TEST-mode** payment id (from a test payment made with a
`rzp_test_` key). Never use a live key or a live payment id here.

```sh
export TEST_RAZORPAY_PAYMENT_ID=pay_test_xxxxxxxxxxxxxx
```

Without it, the AFTER run has no payment id to refund and the order
lands in `REFUND_FAILED` (the script records that honestly — it is not
a pass).

## Step 1 — BEFORE numbers (pre-fix code)

```sh
cd ~/workspace/farmer-marketplace-clone
git stash push -m "live-test-wip" --keep-index   # stash any uncommitted work first
git checkout 45cff5cb368815eac5147bdf49163eae0c9fef05
node scripts/refund-concurrency-test.js
```

Save the full output. It should show the original (non-idempotent)
behaviour: 50 parallel refund requests plus 2 overlapping cron runs,
and how many refund operations succeeded.

## Step 2 — AFTER numbers (fixed code)

```sh
git checkout b83a11b706a7c9008265fc44a5e7e9ca267f260f
node scripts/refund-concurrency-test.js
```

Save the full output. It should show exactly 1 refund processed and
0 duplicates.

## Step 3 — Restore your work and record the results

```sh
git checkout main
git stash pop   # restores the work stashed in Step 1, if any
```

Paste both outputs (BEFORE and AFTER) into `docs/refund-report.md`,
in the "Step 2 — BEFORE result" and "Step 4 — AFTER result" sections,
and fill the before/after table with the real measured numbers:
requests sent, duplicate refunds, total over-refunded amount,
p95 latency. Never invent or estimate a figure — only what the
script printed.

## Cleanup

The script creates one test order in the live Supabase and deletes
its test rows (order, payment, refund rows) after each run. Verify
no test order remains:

```sql
SELECT id, status FROM public.orders
WHERE status IN ('REFUND_PENDING', 'REFUND_PROCESSING', 'REFUND_FAILED')
ORDER BY created_at DESC LIMIT 5;
```

If a test order is left behind, delete its rows manually (order,
then its payments row, then its refunds row).

## Known blockers

- `TEST_RAZORPAY_PAYMENT_ID` must be set, or the AFTER run lands in
  `REFUND_FAILED`.
- The migrations must be applied before the AFTER run, or the script
  fails on the missing tables.
- The BEFORE/AFTER commits below are from the refund-fix work
  (2026-11-08). They predate the rebuild: the fix code they test is
  the same, but the live database is now the NEW Supabase project
  (`prrshenqceqijkfapthl`), not the old one.
