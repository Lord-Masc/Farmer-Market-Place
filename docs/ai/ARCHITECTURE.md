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
