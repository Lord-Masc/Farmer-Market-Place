# Project Handover

> Update this file at the end of every meaningful session. Keep it short and current.

## Current state
- Project: Farmer Marketplace, a React/Vite marketplace with an Express payment API and Supabase backend.
- Frontend: root package; `npm run dev`, `npm run build`.
- Backend: `backend/`; Jest tests via `npm test -- --runInBand`.
- Deploy targets documented in root README: Vercel frontend, Render API, Supabase database.
- Current known payment limitation: payment status tracking is implemented; automatic farmer split payout / legal escrow is not established by this codebase.

## Active work
- Stage 0 (Foundations & safety) of the agritech transformation — LIVE on main since 2026-11-12 18:13 IST. Pushed directly to main (browser web-UI, no branch/PR/merge): 20 commits `d186488` → `3c3b79f`, on top of origin/main `231f0b9` (backend 10 + frontend 5 + migrations 1 + 4 deletions). Local branch `feat/stage0-foundations` HEAD `4a3de7b` (11 commits: f06ec06 + idempotency fix for the payments migration).
- All 7 Stage 0 migrations applied live (Supabase SQL Editor, 2026-11-12): payments UNIQUE skipped as already-live (20261113 created the index); backfill 0 rows; profiles WITH CHECK; audit_log; group-buy tables dropped (were empty); storage policies; price_snapshot (column + status CHECK + idempotency_keys + buyer INSERT policy dropped + RPC updated). All verified by read-only checks.
- All 3 of Rishabh's Stage 0 decisions are made and applied: (1) credentials ROTATED by him, history purge SKIPPED; (2) fake data FULLY DELETED (not hidden); (3) group-buy tables DROP approved and executed live.
- Live Supabase is the existing project `prrshenqceqijkfapthl` (14426, ap-south-1) — no newer project exists. Render envs verified against the dashboard (URL + anon + service_role all match). Razorpay test key regenerated 2026-11-12 (new Key ID `rzp_test_TzFzY3gimFGlOs`) and webhook set up (payment.captured only, Active, secret on Render as `RAZORPAY_WEBHOOK_SECRET`, redeployed 18:25 IST, /health ok).
- Stage 1 (trust foundation) is COMPLETE on local branch `feat/stage1-trust`, HEAD `bcfa6c7` (5 commits, tests 143/143) — NOT pushed, NOT live. Its migration `20261116_trust_foundation.sql` is file-only; apply after Stage 0, then bootstrap the first admin with Rishabh's user UUID.
- PR #1 (branch `fix/checkout-security-hardening`) is pre-Stage-0 work; it is NOT this branch and is not authorized to merge by this handover. Check its live status and checks before acting.

## Important operational notes
- Stage 0 migrations are ALL LIVE as of 2026-11-12 (see Active work). The migration files in `supabase/migrations/20261115_*.sql` are the applied record; `20261115_payments_order_unique.sql` is idempotent (skips itself when the 20261113 index already exists). Apply order + pre-checks are in each file header and docs/ai/ROLLBACK.md.
- Existing migrations must be applied first in the order documented in the root README.
- Never apply migrations to production without explicit approval, backup/rollback planning, and confirmation of target project.
- No live Razorpay/Supabase integration test is implied by passing unit tests.
- The live webhook (`POST /api/razorpay/webhook`) is set up and Active in Razorpay Test Mode (payment.captured only, webhook ID `TzGnpuW2LrdSjY`), secret on Render as `RAZORPAY_WEBHOOK_SECRET`, backend redeployed 2026-11-12 18:25 IST, /health ok. End-to-end HMAC verification is NOT yet proven — it needs the first real test payment.captured delivery (Rishabh's smoke test).
- The `product-images` bucket now EXISTS and is PUBLIC (created 2026-11-12, was missing before); uploads go through the backend endpoint, which validates bytes server-side. Note: Stage 1 verification docs reuse this public bucket — identity docs would be URL-viewable; private bucket + signed URLs is a Stage 2 follow-up.
- Leaked-password protection (L6) CANNOT be enabled on the Free plan (Supabase: Pro Plans and up) — it stays OFF unless Rishabh upgrades the project to Pro.
- Lint: 731 problems at Stage 0 (701 no-undef — the eslint config defines only browser globals, so every backend file trips it; 19 no-unused-vars = baseline; 8 exhaustive-deps, down from 10). Stage 1 measured 1000 (same pre-existing classes). Fixing the eslint config is a follow-up, not part of Stage 0/1.

## Latest session handoff
- Done: Stage 0 main update (2026-11-12, Rishabh's approval "Ha kr de sab kuch up to date main me"): Supabase 14426 sign-in (he typed the password himself); key comparison — Render URL + anon + service_role all match the dashboard; `product-images` bucket created PUBLIC (was missing); 7 migrations applied live + verified (payments UNIQUE already-live via 20261113 index; backfill 0 rows; profiles WITH CHECK; audit_log; group-buy tables dropped; storage policies; price_snapshot); push to main — 20 commits `d186488` → `3c3b79f` (backend 10, frontend 5, migrations 1, deletions 4), verified via GitHub API (HEAD `3c3b79f`, chain intact on 231f0b9); Razorpay test key regenerated (`rzp_test_TzFzY3gimFGlOs`, Render updated + redeployed); webhook created (payment.captured only, Active) + secret on Render + redeployed 18:25 IST; live verify — frontend 200, backend /health ok, live bundle contains new routes (`/api/orders`, `reset-password`, `ship-order`) and zero references to the deleted fake pages or the fake helpline.
- Changed: local branch `feat/stage0-foundations` HEAD `4a3de7b` (11 commits — f06ec06 + idempotency fix for the payments migration, pglast-validated); this HANDOVER.md updated to the live state.
- Checks: backend tests 96/96 pass (Stage 0) / 143/143 (Stage 1, local); frontend build passes; all 7 migrations verified live by read-only SQL checks; push verified via GitHub API; live bundle inspected (new markers present, fake-page markers absent); webhook verified at config level (Active, secret on both sides, /health ok).
- Remaining: Rishabh's live smoke test (login on -six, one order end-to-end, one real webhook delivery to prove HMAC); Stage 1 push (branch `feat/stage1-trust`, migration file-only, first-admin bootstrap needs his user UUID); leaked-password protection OFF (Free plan — Pro upgrade is his call); verification docs in the public bucket (Stage 2 follow-up: private bucket + signed URLs); eslint config fix (follow-up).
- Next action: Rishabh runs the live smoke test and reports; then Stage 1 goes live (apply its migration, bootstrap admin, push its branch) on his word.
