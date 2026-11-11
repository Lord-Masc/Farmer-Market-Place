# Project Handover

> Update this file at the end of every meaningful session. Keep it short and current.

## Current state
- Project: Farmer Marketplace, a React/Vite marketplace with an Express payment API and Supabase backend.
- Frontend: root package; `npm run dev`, `npm run build`.
- Backend: `backend/`; Jest tests via `npm test -- --runInBand`.
- Deploy targets documented in root README: Vercel frontend, Render API, Supabase database.
- Current known payment limitation: payment status tracking is implemented; automatic farmer split payout / legal escrow is not established by this codebase.

## Active work
- PR #1: checkout, payment-binding, stock-reservation, and profile-privacy hardening.
- Branch: `fix/checkout-security-hardening`.
- PR URL: https://github.com/r1shabhsharma05/Farmer-Market-Place/pull/1
- PR is not authorized to merge by this handover. Check its live status and checks before acting.

## Important operational notes
- New migrations on the PR branch: `20261111_transaction_hardening.sql`, `20261112_profile_privacy.sql`, `20261113_payment_binding.sql`.
- Existing migrations must be applied first in the order documented in the root README.
- Never apply migrations to production without explicit approval, backup/rollback planning, and confirmation of target project.
- No live Razorpay/Supabase integration test is implied by passing unit tests.

## Latest session handoff
- Setup: AI collaboration documentation scaffold added.
- Checks: documentation-only change; application tests not run as no application code changed.
- Remaining: validate the docs against current source and keep this file updated as work progresses.
- Next: read the PR diff and run the pre-merge audit before any merge decision.
