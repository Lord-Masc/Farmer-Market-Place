# Rollback and Recovery Plan

Create a task-specific rollback plan before risky changes. This file is a checklist, not permission to execute rollback.

## Code rollback
1. Identify the last known-good commit SHA and the exact commits/files being reverted.
2. Prefer a focused revert commit over force-pushing or rewriting shared history.
3. Check dependent commits and migrations before reverting application code.
4. Re-run the relevant build, tests, and security checks after revert.
5. Verify the intended branch and PR state; never push to `main` unless explicitly authorized.

## Database rollback
- Treat applied migrations as potentially irreversible.
- Before applying a migration, confirm the target Supabase project, backup/PITR availability, migration order, data impact, and a tested recovery plan.
- Prefer a forward-fix migration when dropping/reversing schema could destroy data.
- Do not execute production SQL or migrations without explicit approval.
- Record migration name, execution time, target environment, operator, and verification result without recording credentials.

## Payment and inventory incidents
- Stop retries or further state transitions only through an approved operational procedure.
- Preserve gateway IDs, internal order IDs, and audit evidence; never manually fabricate payment states.
- Reconcile Razorpay captured/refunded state with the internal ledger before any repair.
- For stock discrepancies, compare order history and transactional reservation records before adjusting inventory.

## Task-specific rollback record
- **Change / PR:**
- **Last known-good SHA:**
- **Files / migrations affected:**
- **Recovery steps:**
- **Data-loss risks:**
- **Post-rollback checks:**
- **Approval / execution record:**

### Stage 0, unit 2 — POST /api/orders + price snapshot + status enum (2026-11-12)
- **Change:** `POST /api/orders` (server-derived totals, `price_at_order` snapshot, `Idempotency-Key`), canonical uppercase `orders.status` CHECK + normalisation, buyer INSERT policy dropped, farmer UPDATE policy + `confirm_order_and_reserve_stock` RPC rewritten to uppercase, frontend order creation moved off direct PostgREST inserts. Commits `e2c3dc4` + `318ad0d` on branch `feat/stage0-foundations`.
- **Last known-good SHA:** `231f0b9` (origin/main).
- **Files / migrations affected:** `backend/{services/escrowService.js,controllers/escrowController.js,routes/marketplaceOrders.js,server.js}`, `backend/tests/{orderCreation,escrowController,escrow-security,orderStatus}.test.js`, `src/{pages/{BuyerDashboard,Checkout,ConfirmedOrders,FarmerDashboard,PendingOrders,RewardPoints}.jsx,services/escrowApi.js}`, `supabase/migrations/20261115_price_snapshot_and_status_enum.sql` (FILE ONLY — not applied live in this stage).
- **Recovery steps (code):** `git revert e2c3dc4 318ad0d` (or reset the branch to `231f0b9` — branch is local-only, never pushed). Re-run backend tests + frontend build.
- **Recovery steps (if the migration was already applied live):** forward-fix migration only — never edit the applied file. Drop the `orders_status_canonical` CHECK; re-create the buyer INSERT policy (`status = 'pending'`, buyer-bound, positive quantity/price, farmer-matches-product) and the farmer UPDATE policy with the mixed-case allowlist from `20261109`; restore the `20261111` RPC text (`'pending'`/`'confirmed'`); `DROP TABLE public.idempotency_keys`; `ALTER TABLE public.orders DROP COLUMN price_at_order`. Code and migration rollbacks must land together — old code writes lowercase statuses, which the CHECK forbids.
- **Data-loss risks:** status normalisation is casing-only, but the original mixed-case spellings are unrecoverable after the UPDATE (only casing differs — no semantic loss). `price_at_order` backfill is derived from `total_price` and is droppable without loss.
- **Post-rollback checks:** backend tests green, frontend build green, one order placed end-to-end on a staging project (direct-insert path works again), `orders.status` accepts the legacy mixed-case values.
- **Approval / execution record:** not executed; local branch only.

### Stage 0, unit 3 — Razorpay webhook + unpaid-order reconciler + payments UNIQUE (2026-11-12)
- **Change:** `POST /api/razorpay/webhook` (HMAC over raw body, `payment.captured` → idempotent `verifyAndMarkPaid`), `backend/jobs/reconcile.js` (30-min cron for CONFIRMED-but-unpaid orders), second-payment edge fixed in `verifyAndMarkPaid` (duplicate capture refunded at gateway, never a second HELD row), `RAZORPAY_WEBHOOK_SECRET` in `.env.example`. Commit `9943fdf` on branch `feat/stage0-foundations`.
- **Last known-good SHA:** `318ad0d` (previous unit-3 commit on this branch; `231f0b9` origin/main).
- **Files / migrations affected:** `backend/{services/escrowService.js,controllers/escrowController.js,routes/webhookRoutes.js,server.js,jobs/reconcile.js}`, `backend/tests/{webhook,reconcile}.test.js`, `supabase/migrations/20261115_payments_order_unique.sql` (FILE ONLY — not applied live in this stage), `.env.example`.
- **Recovery steps (code):** `git revert 9943fdf`. Restart the backend. Payments fall back to the browser callback only (H1 reopens); the reconciler stops.
- **Recovery steps (if the migration was already applied live):** forward-fix migration only — `ALTER TABLE public.payments DROP CONSTRAINT payments_order_id_unique`. Dropping it re-opens the double-HELD-row hole; the code-level duplicate refund remains as the guard. Remove the webhook URL from the Razorpay dashboard (human step) so Razorpay stops delivering to a dead endpoint.
- **Data-loss risks:** none — no data migration; the constraint migration fails loudly (DO-block pre-check) if duplicate payments rows already exist, and applies nothing in that case.
- **Post-rollback checks:** backend tests green, frontend build green, `/health` 200, webhook route returns 404 (gone), hourly auto-refund cron still scheduled.
- **Approval / execution record:** not executed; local branch only.

### Stage 0, unit 4 — Ship/refund UI wiring + NULL-deadline auto-refund guard (2026-11-12)
- **Change:** ship button in FarmerDashboard (PAID → SHIPPED via existing `/ship-order`), buyer refund-request button in BuyerDashboard order view (SHIPPED + past deadline via existing `/refund`), `autoRefundJob` NULL-deadline rule fixed (only orders older than 7 days WITH a payments row are enqueued), backfill-deadlines migration file. Commit `1c95531` on branch `feat/stage0-foundations`. Note: `refund.test.js` test (8) was updated to the new specified M4 behaviour (fresh NULL-deadline order is NOT refunded; old + payments row IS) — the old assertion encoded the bug.
- **Last known-good SHA:** `9943fdf` (previous commit on this branch; `231f0b9` origin/main).
- **Files / migrations affected:** `backend/{services/escrowService.js,tests/{autoRefund,refund}.test.js}`, `src/pages/{FarmerDashboard,BuyerDashboard}.jsx`, `supabase/migrations/20261115_backfill_delivery_deadlines.sql` (FILE ONLY — not applied live in this stage).
- **Recovery steps (code):** `git revert 1c95531`. Restart the backend; ship/refund buttons disappear, auto-refund reverts to the old NULL-deadline behaviour.
- **Recovery steps (if the migration was already applied live):** no inverse needed — the backfill only fills NULL deadlines on rows that have a payments row; to undo, `UPDATE public.orders SET delivery_deadline = NULL WHERE delivery_deadline = created_at + interval '48 hours'` is NOT safe (it would also null genuine deadlines). Leave the backfilled values; they are consistent with the platform's own 48h rule. Forward-fix instead if the rule changes.
- **Data-loss risks:** none — backfill only writes a derived deadline; no rows deleted.
- **Post-rollback checks:** backend tests green, frontend build green, ship/refund buttons absent, auto-refund cron still scheduled.
- **Approval / execution record:** not executed; local branch only.

### Stage 0, unit 5 — Fake-data DELETE (2026-11-12, Rishabh's order)
- **Change:** deleted all fabricated content per his "real data with real numbers" order — CommunityDeals (mock deals + fake people), GroupBuying placeholder page, RewardPoints derivation + milestone/badge, Testimonials (fake people/quotes/income claims), Product sample fallback (4 fake products) + card fixed to real DB fields (`image_url_1`, `user_price`, `address`), fake helpline 1800-XXX-XXXX, self-asserted "Verified" labels, hardcoded "12 Active", "Farmer Rating 4.8", Hero "Ramesh Patel ⭐ 4.9", HowItWorks "Fresh Today" fake farm prices. SpentAnalysis now counts only paid statuses (PAID/SHIPPED/DELIVERED/COMPLETED). Empty states are honest (empty catalogue / no points history). Group-buy TABLES untouched (drop-vs-harden on hold, his call). Commit pending on branch `feat/stage0-foundations`.
- **Last known-good SHA:** `1c95531` (previous commit on this branch; `231f0b9` origin/main).
- **Files affected:** deleted `src/pages/{CommunityDeals,GroupBuying,RewardPoints}.jsx`, `src/components/Testimonials.jsx`; edited `src/{App.jsx,pages/{BuyerDashboard,FarmerDashboard,Product,SpentAnalysis,UserProfile,Home}.jsx,components/{Footer,Hero,HowItWorks}.jsx}`. No migrations, no backend changes.
- **Recovery steps (code):** `git revert <unit-5 commit>`. Restart/redeploy frontend. Deleted pages/routes return; fake content returns with them.
- **Data-loss risks:** none — frontend-only deletion; no DB rows touched. Deleted files remain recoverable from git history on this branch.
- **Post-rollback checks:** frontend build green, deleted routes resolve again, no console errors on Home / Products.
- **Approval / execution record:** not executed; local branch only.

### Stage 0, unit 6 — Hardening: profiles WITH CHECK, storage RLS, upload endpoint, rate limits, login hardening, audit log, legacy alias removal, vercel headers (2026-11-12)
- **Change:** profiles UPDATE policy gains WITH CHECK (M1); storage RLS policies for product-images bucket (owner-prefix INSERT/UPDATE/DELETE) + new POST /api/uploads/image (requireAuth, server-side MIME/magic-byte/5 MB checks, rejects svg/html, service-role upload under the caller's prefix) with all 4 frontend upload sites switched to it (H2); per-route rate limits — /api/orders 60, /api/escrow 100, /api/uploads 30 per 15 min under the global 300 cap, webhook unlimited (M5); Login signs out on role mismatch + generic message, "Forgot?" sends a reset email, new /reset-password page (M6); append-only audit_log table migration file (no policies by design); legacy /api/orders → orderRoutes alias removed (L1, no callers — all escrow calls go through /api/escrow); vercel.json with HSTS + nosniff + DENY + no-referrer (L5; no CSP — the SPA loads Razorpay checkout.js, a wrong CSP breaks checkout). Commit pending on branch `feat/stage0-foundations`.
- **Last known-good SHA:** `9e45352` (previous commit on this branch; `231f0b9` origin/main).
- **Files / migrations affected:** `backend/{server.js,routes/{uploadRoutes,marketplaceOrders}.js,utils/{errors,supabaseAdmin}.js}`, `backend/tests/{upload,rateLimit}.test.js`, `src/{App.jsx,pages/{Login,ResetPassword,BuyerDashboard,FarmerDashboard,UserProfile}.jsx,services/escrowApi.js}`, `vercel.json`, `supabase/migrations/20261115_{profiles_update_with_check,storage_product_images,audit_log}.sql` (FILES ONLY — not applied live in this stage).
- **Recovery steps (code):** `git revert <unit-6 commit>`. Restart the backend; uploads revert to direct browser-to-storage (storage policies still gate paths if their migration was applied), login reverts to the old role-mismatch behaviour, per-route limits disappear (global 300 cap remains).
- **Recovery steps (if migrations were already applied live):** forward-fix migrations only — profiles: re-create the UPDATE policy without WITH CHECK; storage: `DROP POLICY "Owners can ..." ON storage.objects` (all three); audit_log: `DROP TABLE public.audit_log`.
- **Data-loss risks:** none — no data migration; the audit_log table is empty until insert calls are wired (Stage 1 follow-up).
- **Post-rollback checks:** backend tests green, frontend build green, /health 200, POST /api/uploads/image without auth → 401, legacy POST /api/orders/create-order with a valid token → 404 (alias gone).
- **Approval / execution record:** not executed; local branch only.

### Stage 0, group-buy DROP decision (Rishabh's word 2026-11-12)
- **Change:** migration file dropping the orphaned `group_buy_participants` + `group_buys` tables (their RLS policies drop with them), with a DO-block guard that RAISES if either table holds rows. Dead code was already gone: `src/services/groupService.js` was deleted upstream (commit f7b3a9b) and the GroupBuying page + route were deleted in unit 5 — verified zero references remain in src/ or backend/. Commit pending on branch `feat/stage0-foundations`.
- **Last known-good SHA:** `411c9c1` (previous commit on this branch; `231f0b9` origin/main).
- **Files / migrations affected:** `supabase/migrations/20261115_group_buy_tables_decision.sql` (FILE ONLY — not applied live in this stage). No code changes.
- **Recovery steps (code):** `git revert <drop commit>`. No code to restore.
- **Recovery steps (if the migration was already applied live):** re-create both tables from `20261108_base_schema.sql` (group_buys + group_buy_participants definitions) plus the 20261109 §6 RLS policies. Data cannot be recovered — the guard only allows the drop when both tables are empty.
- **Data-loss risks:** none when the guard holds (empty tables only). If someone applies it with the guard bypassed, all group-buy rows are lost — the guard is the protection, do not remove it.
- **Post-rollback checks:** tables exist again with RLS on, policies from 20261109 §6 present.
- **Approval / execution record:** not executed; local branch only.

### Stage 0, unit 7 — gitleaks secret scan in CI (2026-11-12)
- **Change:** new `gitleaks` job in `.github/workflows/ci.yml` (pinned CLI 8.28.0, no license needed; scans the working tree only with `--no-git`). Verified locally: clean tree passes (exit 0, no leaks); a scratch copy with a planted fake AWS key fails (exit 1, 1 leak). Commit `b223e72` on branch `feat/stage0-foundations`.
- **Last known-good SHA:** `736bd1c` (previous commit on this branch; `231f0b9` origin/main).
- **Files affected:** `.github/workflows/ci.yml` only.
- **Recovery steps:** `git revert b223e72`. The verify job is untouched; only the secret scan disappears.
- **Data-loss risks:** none.
- **Post-rollback checks:** `verify` job still runs; no gitleaks job in the workflow.
- **Approval / execution record:** not executed; local branch only. The workflow itself has not run on GitHub yet — it runs on the next push/PR.
