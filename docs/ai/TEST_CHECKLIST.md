# Test and Verification Checklist

A change is not done until the relevant commands have actually run and results are recorded.

## Standard local checks
Run from repository root:
- [ ] Install frontend dependencies: `npm install` (only when needed).
- [ ] Production frontend build: `npm run build`.
- [ ] Frontend lint: `npm run lint` (report existing/unrelated failures separately).
- [ ] Install backend dependencies: `cd backend && npm install` (only when needed).
- [ ] Backend tests: `cd backend && npm test -- --runInBand`.

## Change-specific checks
- [ ] Add/update tests for changed behavior.
- [ ] Payment changes: verify ownership, amount derivation, signature comparison, captured status, order binding, duplicate/retry behavior, and failure paths.
- [ ] Order/stock changes: verify approval, insufficient stock, concurrent requests, and rollback/atomicity.
- [ ] Auth/profile changes: verify buyer/farmer roles, RLS, public/private data boundaries, and signup/login paths.
- [ ] SQL changes: inspect migration order, syntax, grants, RLS, constraints, indexes, trigger behavior, and rollback/recovery implications.
- [ ] API changes: verify frontend/backend request and response contracts, CORS, env vars, and error handling.
- [ ] CI/deployment: inspect actual GitHub Actions and Vercel/Render statuses; do not infer from local success.

## Evidence format
For each check record:
- Exact command or check name.
- Environment and commit SHA.
- Actual pass/fail/blocked result.
- Relevant output or failure summary.
- What remains unverified.

Never mark a check passed unless it was executed. Mocked tests do not establish live Razorpay or Supabase integration success.

## Stage 2 evidence (2026-11-12, branch `feat/stage2-passport`, HEAD `9b5dee8`)
- Backend tests: `cd backend && npm test -- --runInBand` → 188/188 pass, 15 suites (baseline 143/143; +34 passport, +3 order-completion `completed_at`, +8 hardening). Run by the coordinator on the merged branch.
- Frontend build: `npm run build` (repo root) → ✓ built in 1.68s (only the pre-existing chunk-size warning).
- Frontend lint: `npm run lint` → 1234 problems (1226 errors, 8 warnings) vs Stage 1 baseline 1000. All Stage 2 additions are the pre-existing `no-undef` class (eslint config defines only browser globals); the only non-`no-undef` problems in Stage 2 backend files are 2 pre-existing `no-unused-vars` in `escrowService.js:300,598` (outside Stage 2 hunks). The 4 new/changed frontend files (`FarmerProfile.jsx`, `CropPassportCard.jsx`, `escrowApi.js`, `Product.jsx`) are lint-clean. No frontend test runner exists in this repo.
- SQL: `python3 -c "from pglast import parse_sql; ..."` → `20261117_crop_passport.sql` parse ok, 13 statements; `20261117_verification_docs_private.sql` parse ok, 6 statements. View math NOT executed against a real Postgres — hand-checked fixture only (5 orders → total 5, deliveries 3, on_time 2/3, dispute 0.2); live check required on apply.
- Secrets: grep over the `c3d406b..HEAD` diff for keys/secrets → clean (only the `reset-password` route name and `service_role` grants in the migration).
- Contract check (coordinator, by reading code): frontend URLs match backend routes exactly (`publicPassportFetch('/farmers/:id/passport')` → `/api/farmers/:id/passport`, etc.); dashboard create-form fields match backend validation; rates are fractions from the view, rendered defensively on both pages.
- NOT verified: neither Stage 2 migration applied live; private `verification-docs` bucket not created; no end-to-end passport flow against a live backend; signed-URL flow verified only with mocks; no live browser check of `/farmers/:id`.
