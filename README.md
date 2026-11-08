# Farmer Marketplace

2-sided agri marketplace connecting farmers and buyers with escrow-based payments.
**Live:** https://farmer-market-place-mu.vercel.app

## Features
- Two roles: Farmers (list products, manage inventory) and Buyers (browse, order)
- Escrow flow: order creation, payment verification, shipping, delivery confirmation, refunds
- Group buying module
- Live mandi price data via data.gov.in API
- Auto-refund processing with Node.js Cron
- Supabase Auth + PostgreSQL Row Level Security

## Tech Stack
React.js, Tailwind CSS, Node.js, Express.js, Supabase, PostgreSQL

## My Contribution
Backend and database:
- Escrow REST endpoints — `backend/routes/orderRoutes.js` + `backend/controllers/escrowController.js`: `POST /create-order`, `/verify-payment`, `/update-status`, `/ship-order`, `/confirm-delivery`, `/refund`
- Escrow service logic — `backend/services/escrowService.js`: payment verification, order status transitions, `refundOrder` (idempotent — see Refund safety)
- Auto-refund cron — `backend/server.js` + `backend/services/escrowService.js`: `node-cron` schedule (`0 * * * *`, hourly) that auto-refunds expired/unconfirmed orders
- Express API — `Server/index.js`: order status updates (`POST /api/orders/update-status`), farmer analytics (`GET /api/farmer/:id/analytics`)
- Database + security — `supabase_backend/schema.sql`: tables plus 10 Row Level Security policies

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
| GET | /debug/config | Env-var presence check (names only, no values) |

Server API (`Server/index.js`, default port 5000).

| Method | Endpoint | Description |
|---|---|---|
| POST | /api/orders/update-status | Order status update with stock sync |
| GET | /api/farmer/:id/analytics | Farmer revenue, average order value, transactions |
| GET | /api | Server API health check |

## Refund safety

- One refund per order: the `refunds` table enforces `UNIQUE(order_id)`.
- Atomic claim: only the caller that flips `REFUND_PENDING` to `REFUND_PROCESSING` proceeds; every other caller gets 0 rows.
- The gateway refund id is stored; if it already exists for an order, the gateway is never called again.
- The hourly cron claims a batch with `FOR UPDATE SKIP LOCKED`, so overlapping runs never pick the same order.
- Gateway failures move the order to `REFUND_FAILED` (never stuck), with retry and exponential backoff.

## Setup
1. `git clone` the repo and run `npm install` (root, `backend/`, and `Server/` each have their own `package.json` where applicable)
2. Copy each `.env.example` to `.env` and add your own keys — root `.env.example` (frontend), `Server/.env.example`, `backend/.env.example`. Never commit a real `.env`.
3. Apply `supabase/migrations/20261108_create_refunds.sql` in the Supabase SQL editor (refunds ledger + `claim_pending_refunds` function).
4. Run the frontend with `npm run dev`; run the escrow backend with `npm run dev` in `backend/` (port 5001) and the Server API with `node index.js` in `Server/` (port 5000).

## Screenshots
![Homepage — hero and marketplace](docs/screenshots/homepage.png)
![Fresh Today — product listings](docs/screenshots/marketplace.png)
![Farmer and Buyer sections](docs/screenshots/features.png)
