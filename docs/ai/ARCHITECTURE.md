# System Architecture

> High-level map only. Confirm implementation in source before relying on a detail.

## Components
- **Frontend:** React 19 + Vite; source under `src/`. Pages, reusable components, context, hooks, services, utilities, and assets are separated by responsibility.
- **Backend API:** Express under `backend/`; entry point `backend/server.js`; routes, controllers, services, middleware, tests, and utilities are separated.
- **Database/auth:** Supabase Auth and PostgreSQL with Row Level Security; SQL migrations under `supabase/migrations/`.
- **Payment provider:** Razorpay integration in backend services.
- **Hosting:** Vercel frontend and Render backend, as documented in root README.

## Main boundaries
- Frontend handles presentation and user interaction; it must not be trusted for payment amount, buyer identity, authorization, or final order state.
- Backend verifies authenticated identity and payment-provider responses.
- Database constraints, RLS, and transactional RPCs enforce data integrity and access boundaries.
- Supabase service-role credentials are backend-only and must never enter frontend bundles.

## Data/security principles
- Treat browser input as untrusted.
- Enforce ownership and role checks on server/database boundaries.
- Keep public directory data separate from private profile data.
- Bind external payment orders to internal order IDs and verify amount/status/signature.
- Make payment and refund operations retry-safe and concurrency-safe.
- Never equate internal payment labels with actual custody or payout.

## Verify before expanding
This file is intentionally high-level. Update it only after inspecting relevant source, SQL migrations, environment configuration, and deployment manifests.

## Admin & platform intelligence (Stage 10, verified in source)

- **Read models:** migration `20261125_admin_views.sql` (FILE ONLY) adds
  `admin_stuck_money` + `platform_metrics_daily` views and two nullable
  columns on existing tables (`profiles.suspended_at`,
  `products.status` CHECK active/hidden) — no new tables.
- **Services:** `backend/services/adminMetricsService.js` (GMV = sum of
  `total_price`×100 over orders with a captured HELD/RELEASED payment;
  median realisation; dispute rate + avg resolution; on-time rate;
  group-selling; notification delivery; `mandi_modal_paise` GUARDED —
  wired to Stage 3 (live shape: `modal_price` in rupees per quintal,
  ×100 → paise); null when no data, never invented; null — never 0 —
  when no data) and `backend/services/moderationService.js` (`suspendUser` /
  `reinstateUser` / `lookupUser`; suspend sets `suspended_at` + hides all
  products, reinstate clears + restores; both audit-logged).
- **Enforcement:** `requireAuth` rejects suspended accounts with 403
  `ACCOUNT_SUSPENDED` on EVERY authenticated API (fresh read per request,
  fail-closed on read error; login itself still works).
- **Transparency:** `GET /api/transparency` is a PUBLIC mount (own rate
  limit 60, no auth) serving the same aggregated metrics shape with no
  personal data; the frontend `/transparency` page renders it via the
  shared `PlatformMetrics.jsx`. Admin pages: `/admin` (dashboard),
  `/admin/metrics`, `/admin/moderation`, `/admin/reconciliation`,
  `/admin/verifications`.
- **Known limits (see HANDOVER.md flags):** suspend/reinstate are two
  writes, not one transaction; median realisation mixes kg/quintal units;
  `mandi_modal_paise` reads Stage 3's `modal_price` in rupees per quintal (×100 → paise, confirmed by the landed schema).

## PWA layer (Stage 11 — NOT PRESENT, UNVERIFIED)

- Verified 2026-11-12 in this branch: there is NO PWA layer. No web
  manifest, no service worker, no workbox/vite-plugin-pwa, no
  install/offline code anywhere in `src/`, `public/` (only `favicon.svg`),
  `index.html`, `vite.config.js`, or `package.json`. The other Stage 11
  unit branches (`feat/stage11-design`, `feat/stage11-pwa-a11y`,
  `feat/stage11-regression`) sit at the same tip with no commits, so no
  PWA work has landed anywhere yet.
- Stage 11 scope calls for PWA basics (offline order status, installable).
  Until that work lands and is verified here, do not claim the app is
  installable or works offline.

## Accessibility posture (Stage 11 — minimal, UNVERIFIED)

- Verified 2026-11-12: exactly ONE `aria-` attribute exists in the whole
  frontend (`aria-label` on the notification bell,
  `src/components/NotificationBell.jsx:26`). No systematic WCAG audit has
  run; no axe/Lighthouse accessibility result exists for this repo.
- Stage 11 targets (from the transformation assessment, NOT yet run):
  WCAG AA on the transactional flows, Lighthouse mobile ≥ 90 on the
  transactional pages, axe audit 0 critical. Until those checks run and
  are recorded in TEST_CHECKLIST.md, the a11y posture is UNVERIFIED —
  do not claim AA conformance.

## Regression approach (Stage 11)

- **Backend:** Jest, `cd backend && npm test -- --runInBand`. Baseline at
  Stage 10 merge: 457/457 pass, 25 suites. Every stage's evidence records
  the exact count; a docs-only change must not move it.
- **Frontend:** `npm run build` (Vite production build; only the
  pre-existing chunk-size warning is expected). No frontend test runner
  exists in this repo.
- **Lint:** `npm run lint`. The count is large and pre-existing
  (Stage 10: 3039 problems, 3007 `no-undef` — the eslint config defines
  only browser globals, so every backend file trips it). Report the count
  per change; fixing the eslint config is a follow-up, not a stage.
- **Contract checks:** frontend/backend route and response-shape agreement
  is verified by reading code (no live backend in the loop); see the
  per-stage evidence in TEST_CHECKLIST.md.
- **Stage 11 targets (NOT yet run):** Playwright happy paths on staging
  (signup → list → order → pay → ship → deliver → release;
  dispute → resolve; group buy → settle), Lighthouse mobile ≥ 90,
  axe 0 critical, live smoke test by Rishabh (login on -six, one order
  end-to-end, one real webhook delivery to prove HMAC).
- **What tests never prove:** passing unit tests do not establish live
  Razorpay or Supabase integration. No e2e runs against live
  Supabase/Razorpay (see CONSTRAINTS.md).
