# Farmer Marketplace

2-sided agri marketplace connecting farmers and buyers with escrow-based payments.
**Live:** https://farmer-market-place-six.vercel.app

## Project structure

```
.
├── src/                  # React frontend (Vite) — what the user sees
│   ├── components/       # Reusable UI pieces (Navbar, Hero, Features, Footer…)
│   ├── pages/            # One file per screen (Home, dashboards, checkout…)
│   ├── services/         # How the frontend talks out: Supabase client, escrow API calls, product queries
│   ├── context/          # AuthContext — who is signed in, buyer or farmer
│   ├── hooks/            # Shared React hooks
│   ├── utils/            # Small shared helpers
│   └── assets/           # Static images (currently empty)
├── backend/              # Escrow API (Express) — the money logic, runs on Render
│   ├── server.js         # Entry point: mounts routes, starts the hourly auto-refund cron
│   ├── routes/           # URL map: orderRoutes.js → /api/escrow/*
│   ├── controllers/      # escrowController.js — request in, response out
│   ├── services/         # escrowService.js — the real work: Razorpay, stock, refunds
│   ├── middleware/       # requireAuth (Supabase JWT) + security (CORS, headers, rate limit)
│   ├── tests/            # Jest tests (refund idempotency, escrow security)
│   └── utils/            # Shared errors
├── supabase/migrations/ # THE database source of truth — apply in order on a fresh project:
│   ├── 20261108_base_schema.sql        # tables: profiles, products, orders, payments…
│   ├── 20261108_create_refunds.sql     # refunds ledger + claim_pending_refunds()
│   └── 20261109_security_hardening.sql # RLS policies, retry columns, CHECKs
├── render.yaml           # Render Blueprint: how the backend deploys (rootDir backend)
├── docs/                 # Runbooks + the refund before/after report + screenshots
├── scripts/              # refund-concurrency-test.js — the live before/after test
├── .env.example          # Every env var (frontend + backend), names only — copy to .env, never commit real keys
├── package.json          # Frontend scripts: npm run dev, npm run build
└── backend/package.json  # Backend scripts: npm run dev / start (port 5001), npm test
```

How it fits together: Vercel (frontend) → Render (escrow backend) → Supabase (Auth + Postgres). The frontend also talks to Supabase directly for login, profiles, and product listings.
Run it locally: `npm run dev` in the root starts the frontend (port 5173) and the escrow backend (port 5001) together.
Note: there used to be a second backend in `Server/` — it was dead (nothing called it) and was deleted. The old stale-schema folder was deleted too; `supabase/migrations/` is the only schema.

## Features
- Two roles: Farmers (list products, manage inventory) and Buyers (browse, order)
- Payment flow: farmer-approved orders, Razorpay verification, payment status tracking and refunds
- Group buying UI prototype
- Auto-refund processing with Node.js Cron
- Supabase Auth + PostgreSQL Row Level Security

## Tech Stack
React.js, Tailwind CSS, Node.js, Express.js, Supabase, PostgreSQL

## My Contribution
Backend and database:
- Payment REST endpoints — `backend/routes/orderRoutes.js` + `backend/controllers/escrowController.js`: `POST /create-order`, `/verify-payment`, `/update-status`, `/ship-order`, `/confirm-delivery`, `/refund`
- Payment service logic — `backend/services/escrowService.js`: server-side amount checks, payment verification, order transitions and idempotent refunds
- Auto-refund cron — `backend/server.js` + `backend/services/escrowService.js`: `node-cron` schedule (`0 * * * *`, hourly) that auto-refunds expired/unconfirmed orders
- Database + security — `supabase/migrations/`: base schema (`20261108_base_schema.sql`), refunds ledger (`20261108_create_refunds.sql`), hardening (`20261109_security_hardening.sql`)

## API Endpoints

Escrow backend (`backend/server.js`, default port 5001). The same routes are
also mounted at `/api/orders/*` for legacy dashboard support.

| Method | Endpoint | Description |
|---|---|---|
| POST | /api/escrow/create-order | Create a Razorpay order and an order row |
| POST | /api/escrow/verify-payment | Verify Razorpay signature, mark paid, hold escrow |
| POST | /api/escrow/update-status | Farmer updates order status (with stock check) |
| POST | /api/escrow/ship-order | Mark order shipped |
| POST | /api/escrow/confirm-delivery | Mark delivered, release escrow to farmer |
| POST | /api/escrow/refund | Idempotent refund (see Refund safety) |
| GET | /health | Escrow backend health check |

## Refund safety

- One refund per order: the `refunds` table enforces `UNIQUE(order_id)`.
- Atomic claim: only the caller that flips `REFUND_PENDING` to `REFUND_PROCESSING` proceeds; every other caller gets 0 rows.
- The gateway refund id is stored; if it already exists for an order, the gateway is never called again.
- The hourly cron claims a batch with `FOR UPDATE SKIP LOCKED`, so overlapping runs never pick the same order.
- Transient gateway failures return the order to `REFUND_PENDING` with `next_retry_at` exponential backoff; permanent data failures become `REFUND_FAILED`.

## Setup
1. `git clone` the repo and run `npm install` (root and `backend/` each have their own `package.json` where applicable)
2. Copy each `.env.example` to `.env` and add your own keys — root `.env.example` (frontend), `backend/.env.example`. Never commit a real `.env`.
3. On a FRESH Supabase project, apply the migrations in `supabase/migrations/` in order in the SQL editor: `20261108_base_schema.sql`, `20261108_create_refunds.sql`, `20261109_security_hardening.sql`, then `20261111_transaction_hardening.sql` (atomic stock reservation + retry scheduling), then `20261112_profile_privacy.sql` (private profiles + farmer directory + signup trigger).
4. Run the frontend with `npm run dev`; run the escrow backend with `npm run dev` in `backend/` (port 5001).

## Deployment
- **Frontend — Vercel:** deploys from this repo. Set `VITE_ESCROW_API_URL` to the Render backend URL (see below), plus `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_RAZORPAY_KEY_ID`, `VITE_GOOGLE_MAPS_API_KEY`.
- **Escrow backend — Render:** live at https://farmer-escrow-backend.onrender.com. `render.yaml` (Blueprint) defines the web service — `rootDir: backend`, build `npm install`, start `node server.js`, health check `/health`. Node is a bounded range (`NODE_VERSION: ">=22 <25"`), not an exact pin. Set these in the Render dashboard (never in the repo): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`.
- **Database — Supabase (new project):** create a fresh project, apply the three migrations in order (see Setup step 3), and use its URL/keys in the Vercel and Render env vars above. The old project's keys are not used anywhere in this repo.

## Screenshots
![Homepage — hero and marketplace](docs/screenshots/homepage.png)
![Fresh Today — product listings](docs/screenshots/marketplace.png)
![Farmer and Buyer sections](docs/screenshots/features.png)


## Payment and payout limitation

The app verifies Razorpay payments and records internal payment states. A database status such as `HELD` or `RELEASED` does **not** place funds in a legal escrow account or trigger a farmer payout. Automatic split settlements require a separately configured Razorpay Route/linked-account setup and merchant approval. Until that integration exists, the UI describes payment verification and order completion rather than claiming funds were released to a farmer.
