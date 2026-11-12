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

## Stage 4 evidence (2026-11-12, branch `feat/stage4-negotiation`, HEAD `240530a`)
- Backend tests: `cd backend && npm test -- --runInBand` → 220/220 pass, 16 suites (baseline 188/188, 15 suites; +32 negotiation tests: 30 from Unit A + 2 list-endpoint tests added at merge). Run by the coordinator on the merged branch. The locked-price regression is hand-checked with literals (locked 2200, listing edited to 2600, order `price_at_order` stays 2200, `total_price` 22000).
- Frontend build: `npm run build` (repo root) → ✓ built in 1.73s (only the pre-existing chunk-size warning).
- Frontend lint: `npm run lint` → 1461 problems (1453 errors, 8 warnings) vs Stage 2 baseline 1234. All Stage 4 additions are the pre-existing `no-undef` class (eslint config defines only browser globals); scoped lint on all 6 touched frontend files exits 0. The 21 `no-unused-vars` are all in pre-existing files (escrowController, escrowService:316/614, auditLog.test.js, errors.js, refund-concurrency-test script, BuyerDashboard, FarmerDashboard) — zero in Stage 4 files. (One unused eslint-disable directive found by the coordinator in the merged thread page was removed; the RAZORPAY_KEY_SECRET grep hit is the test dummy `'test-secret'` fallback, same pattern as orderCreation.test.js.)
- SQL: `python3 -c "from pglast import parse_sql; ..."` → `20261119_negotiation.sql` parse ok, 28 statements. Migration FILE ONLY — never applied live. Apply order: after `20261116` (defines `is_admin()`) and `20261117`.
- Secrets: grep over the `d7b9fb6..HEAD` diff for keys/secrets → clean (only `Idempotency-Key` / `idempotency_key` / `service_role` mentions and the test dummy above).
- Contract check (coordinator, by reading code): frontend URLs match backend routes exactly (`GET /api/requirements` added at merge — the original contract had no list endpoint; `GET /api/negotiations/:id` is keyed by requirement id); request bodies are house-style snake_case (`price_tiers`, `product_id`, `expires_at`, `delivery_window_start/end`, `target_price`); accept sends `{ delivery_address, buyer_phone? }` (backend 400s without an address — the thread now collects it in an inline form); agreement reads `locked_price`/`locked_quantity`; thread response carries `fairPriceAnchor: null`; error shape is the repo's flat `{ error, code }` (frontend reads `data.error`).
- Merge fixes (coordinator, commits `b7126c9` + `240530a`, TDD for the backend one — 3 new tests watched RED first): `GET /api/requirements` list endpoint (buyer's own, each row with `offer_count`); quote form now picks one of the farmer's own listings (`product_id` — backend 403s without it, since acceptance creates a real order and `orders.product_id` is NOT NULL); tiers sent/read as `price_tiers`; accept collects the delivery address.
- NOT verified: migration never applied to a real Postgres (trigger/RLS/policies parse-checked only); no end-to-end negotiation flow against a live backend; no live browser check of `/requirements` or `/negotiations/:id`. Acceptance is claim-first, not a single DB transaction (see HANDOVER.md flags) — a crash between the offer claim and the agreement insert is self-healing on a same-key retry; a keyless retry after a partial accept gets 409 by design.

## Stage 5 evidence (2026-11-12, branch `feat/stage5-group-selling`, HEAD `34b6ddf`)
- Backend tests: `cd backend && npm test -- --runInBand` → 260/260 pass, 17 suites (baseline 220/220, 16 suites; +39 group-buy tests from Unit A + 1 merge-fix test for `status=all`). Run by the coordinator on the merged branch. Hand-checked literals pinned: remainder split 100 paise over 1:1:1 → 34/33/33; realistic 100,000 paise over 100:200:300 → 16667/33333/50000; pooled close 600 kg × ₹2300 → order ₹1,380,000, settlements 23,000,000/46,000,000/69,000,000 paise summing exactly to 138,000,000.
- Frontend build: `npm run build` (repo root) → ✓ built in ~1.7s (only the pre-existing chunk-size warning).
- Frontend lint: `npm run lint` → 1740 problems (1732 errors, 8 warnings) vs Stage 4 baseline 1461. Rule breakdown verified by the coordinator: the 7 backend files in scope report 301 problems, ALL `no-undef` (the pre-existing eslint-config class — config defines only browser globals); the 5 frontend files report 0 problems. Zero `no-unused-vars` in Stage 5 files.
- SQL: `python3 -c "from pglast import parse_sql; ..."` → `20261120_group_selling.sql` parse ok, 23 statements. Migration FILE ONLY — never applied live. Apply order: after `20261116` (defines `is_admin()`) and `20261119` (defines `requirements`).
- Secrets: grep over the `dea155f..HEAD` diff for keys/secrets → clean (only `Idempotency-Key` / `idempotency_key` / `service_role` mentions and the test dummy `'test-secret'`, same pattern as orderCreation.test.js).
- Contract check (coordinator, by reading code): frontend URLs match backend routes exactly (`POST /api/group-buys`, `GET /api/group-buys?status=`, `GET /:id`, `POST /:id/join|negotiate|close`, `GET /:id/settlement`); request bodies are house-style snake_case; `share` is a fraction (contribution/total) on both sides (frontend renders ×100); close sends `Idempotency-Key: group-buy-close-<id>` (added at merge — the backend replays only for that key); negotiated-close detection reads the Stage 4 thread's `agreement` field (owner is the buyer, so the read is allowed); direct-close product picker uses the BuyerDashboard direct Supabase query, excluding the owner's own listings.
- Merge fixes (coordinator, commit `34b6ddf`, TDD for the backend one — 3 tests watched RED first): list `status=all` (the "All" tab sent no param and silently got open-only) + `status=mine` now owned-or-joined (was owner-only); close replay key in `closeGroupBuy`; `settlement.created` audit event now carries the closing owner as actor (was null); migration header comment corrected (participants RLS: self + owner + admin for direct reads, full list via API).
- NOT verified: migration never applied to a real Postgres (trigger/RLS/policies parse-checked only); no end-to-end group flow against a live backend; no live browser check of `/group-buys` or `/group-buys/:id`. Close is claim-first, not a single DB transaction (see HANDOVER.md flags) — a crash between order creation and the status claim resumes via the derived key; a different-key retry after a partial close gets 409 by design.
