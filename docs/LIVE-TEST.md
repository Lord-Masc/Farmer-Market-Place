# Live Test Runbook — Refund Idempotency (Before / After)

Run this from a machine that can reach the live Supabase host
(e.g. Rishabh's laptop). **Do NOT run it from this VM** — the live
Supabase host is unreachable from the VM (curl returns 000, "Empty
reply from server"), so the script fails before sending a single
request there. Razorpay's API is reachable from the VM, but the
Supabase block stops the test.

## Commits

- Pre-fix commit (BEFORE): `45cff5cb368815eac5147bdf49163eae0c9fef05`
  (`45cff5c` — "Add refund concurrency test and BEFORE result")
- Fix commit (AFTER): `b83a11b706a7c9008265fc44a5e7e9ca267f260f`
  (`b83a11b` — "Make refunds idempotent: atomic claim, refunds ledger,
  gateway call with retry")

## Prerequisite — apply the migration first

1. Open the Supabase dashboard → SQL editor.
2. Paste the contents of `supabase/migrations/20261108_create_refunds.sql`
   and run it. This creates the `refunds` table (UNIQUE on `order_id`),
   adds `payments.razorpay_payment_id`, and creates the
   `claim_pending_refunds` function (FOR UPDATE SKIP LOCKED).
3. Confirm the table exists: `SELECT * FROM public.refunds LIMIT 1;`
   should return 0 rows (empty table, no error).

Do NOT skip this step. The fixed code assumes the migration is applied;
without it the AFTER run will fail on the missing `refunds` table.

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

- Live Supabase host unreachable from this VM (curl 000). Run the
  script from a machine that can reach it.
- `TEST_RAZORPAY_PAYMENT_ID` must be set, or the AFTER run lands in
  `REFUND_FAILED`.
- The migration must be applied before the AFTER run, or the script
  fails on the missing `refunds` table.
