# Project Handover

> Update this file at the end of every meaningful session. Keep it short and current.

## Current state
- Project: Farmer Marketplace, a React/Vite marketplace with an Express payment API and Supabase backend.
- Frontend: root package; `npm run dev`, `npm run build`.
- Backend: `backend/`; Jest tests via `npm test -- --runInBand`.
- Deploy targets documented in root README: Vercel frontend, Render API, Supabase database.
- Current known payment limitation: payment status tracking is implemented; automatic farmer split payout / legal escrow is not established by this codebase.

## Active work
- Stage 0 (Foundations & safety) of the agritech transformation — COMPLETE on local branch `feat/stage0-foundations`, HEAD `db8c37e`.
- 9 commits on the branch vs origin/main `231f0b9` (52 files, +2406/−655). NO push, NO merge, NO deploy, NO production migrations — presenting the branch to Rishabh for the push/deploy call is the parent agent's job.
- All 3 of Rishabh's Stage 0 decisions are made and applied: (1) credentials ROTATED by him, history purge SKIPPED; (2) fake data FULLY DELETED (not hidden); (3) group-buy tables DROP approved (migration file with empty-table guard). Live Supabase is the existing project `prrshenqceqijkfapthl` (14426, ap-south-1) — no newer project exists.
- PR #1 (branch `fix/checkout-security-hardening`) is pre-Stage-0 work; it is NOT this branch and is not authorized to merge by this handover. Check its live status and checks before acting.

## Important operational notes
- New Stage 0 migrations (FILES ONLY, never applied live in this stage): `20261115_price_snapshot_and_status_enum.sql`, `20261115_payments_order_unique.sql`, `20261115_backfill_delivery_deadlines.sql`, `20261115_profiles_update_with_check.sql`, `20261115_storage_product_images.sql`, `20261115_audit_log.sql`, `20261115_group_buy_tables_decision.sql`. Apply order + pre-checks are in each file header and docs/ai/ROLLBACK.md.
- Existing migrations must be applied first in the order documented in the root README.
- Never apply migrations to production without explicit approval, backup/rollback planning, and confirmation of target project.
- No live Razorpay/Supabase integration test is implied by passing unit tests.
- The live webhook (`POST /api/razorpay/webhook`) is implemented and unit-tested with signed payloads, but no real Razorpay delivery has been observed — needs Rishabh's dashboard (webhook URL + `RAZORPAY_WEBHOOK_SECRET` on Render).
- The `product-images` bucket must stay PUBLIC for getPublicUrl() to serve images (dashboard setting); uploads now go through the backend endpoint, which validates bytes server-side.
- Leaked-password protection (L6) is a Supabase dashboard setting — not attempted; see the Rishabh checklist in the Stage 0 report.
- Lint: 731 problems (701 no-undef — the eslint config defines only browser globals, so every backend file trips it; 19 no-unused-vars = baseline; 8 exhaustive-deps, down from 10). Fixing the eslint config is a follow-up, not part of Stage 0.

## Latest session handoff
- Done: Stage 0 units 1–8 complete (CONTRIBUTING + PR template; POST /api/orders with server-derived totals + price snapshot + status enum; Razorpay webhook + reconciler + second-payment refund; ship/refund UI + NULL-deadline guard; fake-data FULL DELETE; hardening — profiles WITH CHECK, storage RLS, upload endpoint, per-route rate limits, login hardening, audit log, legacy alias removal, vercel.json HSTS headers; group-buy DROP migration; gitleaks CI; final verification).
- Changed: 52 files, +2406/−655 vs origin/main 231f0b9; 7 new migration files (file-only); 96 backend tests (was 42).
- Checks: backend tests 96/96 pass; frontend build passes (2.41s); lint 731 problems, all pre-existing classes (no-undef config gap + baseline no-unused-vars); all 7 new migrations parse (pglast); gitleaks clean-tree scan passes, planted fake key blocked (exit 1); live smoke tests on dummy env — /health 200, legacy alias gone, upload endpoint 401s without auth, per-route limiter 429s after 60 orders; diff reviewed, no secrets in it.
- Remaining: Rishabh's call on push/deploy of this branch; applying the 7 migration files live (SQL Editor, in order, with the pre-checks in their headers); dashboard items — Razorpay webhook URL + secret on Render, confirm live Vercel/Render envs still point to `prrshenqceqijkfapthl`, product-images bucket public, leaked-password protection ON; live smoke test on his side (login, one order, one webhook delivery).
- Next action: parent presents branch `feat/stage0-foundations` to Rishabh; do NOT push, merge, deploy, or run any migration without his explicit word.
