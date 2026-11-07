# AgroConnect — Farmer Marketplace

A two-sided farm marketplace connecting farmers directly with buyers — no middlemen, fair prices, and fresh produce from India's fields.

**Live:** https://farmer-market-place-mu.vercel.app

## Features

- **Two-sided marketplace** — separate Farmer and Buyer dashboards
- **Product listings** — farmers list crops and produce with prices, search and filters for buyers
- **Escrow checkout** — orders are held in escrow until delivery is confirmed
- **Group buying** — buyers pool orders for better prices
- **Community deals and reward points**
- **Live order dashboard** — track orders from listing to delivery
- **Direct messaging** between farmers and buyers
- **Secure payments** via Razorpay
- **Reviews and ratings, inventory management, delivery and pickup**
- **Supabase Auth** with row-level security; government market-price data via data.gov.in

## Tech stack

- **Frontend:** React + Vite, React Router, Tailwind CSS
- **Backend:** Node.js + Express — `Server/` (API) and `backend/` (escrow service)
- **Database / Auth:** Supabase (PostgreSQL + Auth + RLS)
- **Payments:** Razorpay
- **Maps:** Google Maps Places

## Setup

### Prerequisites

- Node.js 18+ and npm
- A Supabase project, a Razorpay account, and a data.gov.in API key

### 1. Clone and install

```bash
git clone https://github.com/r1shabhsharma05/Farmer-Market-Place.git
cd Farmer-Market-Place
npm install
npm install --prefix Server
npm install --prefix backend
```

### 2. Environment variables

Copy the template and fill in your own keys. Never commit a real `.env` — it is git-ignored.

```bash
cp .env.example .env
# Frontend keys: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_GOV_DATA_API_KEY
# Backend keys (Server/ and backend/): SUPABASE_URL, SUPABASE_ANON_KEY,
# SUPABASE_SERVICE_ROLE_KEY, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, PORT, NODE_ENV
```

### 3. Run

```bash
npm run dev
```

This starts the client (Vite), the API server, and the escrow service together. The app runs at http://localhost:5173.

### Build

```bash
npm run build
npm run preview
```

## Project structure

```
├── src/            # React frontend (pages, components, services, context)
├── Server/         # Express API server
├── backend/        # Escrow service (controllers, routes, services)
├── public/         # Static assets
└── .env.example    # Environment variable template (no real values)
```

## Secrets handling

Secrets live only in local `.env` files and in the deployment platform's environment variables (Vercel). No real key is committed to this repo — see `.env.example` for the full list of variable names.
