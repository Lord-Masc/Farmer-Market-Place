-- Stage 3, module B — FairPrice Intelligence (2026-11-13):
-- mandi_prices + price_alerts + platform_cost_params.
--
-- WHAT THIS FILE DOES
--  1. mandi_prices: one row per (commodity, mandi, date, variety, grade)
--     from the data.gov.in OGD API ("Current Daily Price of Various
--     Commodities from Various Markets (Mandi)", resource
--     9ef84268-d588-465a-a308-a864a43d0070). Prices are NORMALISED to
--     ₹/quintal internally (min_price / max_price / modal_price); the
--     unit column records the normalised unit ('quintal'). The raw OGD
--     row is kept verbatim in `raw` (jsonb) so any normalisation can be
--     audited. APPEND-ONLY: the twice-daily sync inserts new rows; a
--     re-fetch of the same day is a no-op via the UNIQUE constraint +
--     ON CONFLICT DO NOTHING in the sync job. Nothing here overwrites
--     or deletes history.
--  2. price_alerts: one row per user alert — a percent move of a
--     commodity's modal price vs yesterday's modal or the 7-day average
--     modal (basis), in a direction (rise/fall). The sync job stamps
--     last_triggered_* when a real crossing fires; it never deletes.
--  3. platform_cost_params: the net-earnings assumptions (transport,
--     commission, packaging, platform fee, wastage). There is NO
--     official dataset for these — they are platform estimates, set by
--     an admin through the backend API, labelled "estimated" everywhere
--     they are shown. VERSIONED: a PATCH inserts a new row (version+1)
--     and flips the old current row off; history is kept. NO SEED ROWS:
--     until an admin sets parameters, net earnings reports "not
--     configured" — an invented default would be a fabricated number.
--  4. RLS: mandi_prices readable by all (public prices), writes go
--     through the backend (service role) only — NO insert/update/delete
--     policies, so the table is append-only even for authenticated
--     users. price_alerts are user-scoped (own rows only). Cost params
--     are readable by all, writable only through the backend (no write
--     policies at all).
--
-- COLUMN CONTRACT (readers depend on these names — do not rename):
--  mandi_prices.commodity is the NORMALISED canonical crop name
--  (Bhindi, not Lady Finger — see fairPriceService.js for the mapping);
--  modal_price is the representative mandi price in RUPEES per quintal
--  (the Stage 8 assistant price tool and the Stage 10
--  adminMetricsService read modal_price and treat it as rupees).
--  `date` is the ARRIVAL date (the day the price was reported), not the
--  sync date — freshness is computed from it.
--
-- APPLY ORDER: no dependency on other Stage 3 files; apply any time
-- after 20261117_crop_passport.sql. FILE ONLY — apply in the Supabase
-- SQL Editor. Rollback: DROP TABLE public.price_alerts;
-- DROP TABLE public.platform_cost_params; DROP TABLE public.mandi_prices;
-- (forward-fix only once live — never edit this file after applying.)

CREATE TABLE IF NOT EXISTS public.mandi_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commodity text NOT NULL,
  variety text NOT NULL DEFAULT '',
  grade text NOT NULL DEFAULT '',
  state text NOT NULL,
  district text,
  mandi text NOT NULL,
  date date NOT NULL,
  min_price numeric NOT NULL CHECK (min_price >= 0),
  max_price numeric NOT NULL CHECK (max_price >= 0),
  modal_price numeric NOT NULL CHECK (modal_price >= 0),
  unit text NOT NULL DEFAULT 'quintal',
  source text NOT NULL DEFAULT 'Agmarknet / data.gov.in',
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mandi_prices_one_row_per_cell
    UNIQUE (commodity, mandi, date, variety, grade)
);

CREATE INDEX IF NOT EXISTS mandi_prices_commodity_date_idx
  ON public.mandi_prices (commodity, date DESC);
CREATE INDEX IF NOT EXISTS mandi_prices_state_date_idx
  ON public.mandi_prices (state, date DESC);
CREATE INDEX IF NOT EXISTS mandi_prices_mandi_date_idx
  ON public.mandi_prices (mandi, date DESC);

ALTER TABLE public.mandi_prices ENABLE ROW LEVEL SECURITY;

-- Public prices: anyone (anon included) may read them. No INSERT /
-- UPDATE / DELETE policy exists on purpose — writes go through the
-- backend sync job (service role) only, so the table is append-only.
CREATE POLICY "Anyone reads mandi prices"
  ON public.mandi_prices FOR SELECT
  USING (true);

CREATE TABLE IF NOT EXISTS public.price_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  commodity text NOT NULL,
  threshold_pct numeric NOT NULL CHECK (threshold_pct > 0),
  basis text NOT NULL CHECK (basis IN ('yesterday', 'avg7')),
  direction text NOT NULL CHECK (direction IN ('rise', 'fall')),
  last_triggered_at timestamptz,
  last_triggered_price numeric CHECK (last_triggered_price IS NULL OR last_triggered_price >= 0),
  last_triggered_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_alerts_one_threshold_per_basis
    UNIQUE (user_id, commodity, basis, direction, threshold_pct)
);

CREATE INDEX IF NOT EXISTS price_alerts_commodity_idx
  ON public.price_alerts (commodity);
CREATE INDEX IF NOT EXISTS price_alerts_user_idx
  ON public.price_alerts (user_id);

ALTER TABLE public.price_alerts ENABLE ROW LEVEL SECURITY;

-- A user reads only their own alerts.
CREATE POLICY "Users read their own alerts"
  ON public.price_alerts FOR SELECT
  USING (auth.uid() = user_id);

-- A user creates only their own alerts.
CREATE POLICY "Users insert their own alerts"
  ON public.price_alerts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- A user updates only their own alerts (the sync job stamps
-- last_triggered_* through the service role, which bypasses RLS).
CREATE POLICY "Users update their own alerts"
  ON public.price_alerts FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- A user deletes only their own alerts.
CREATE POLICY "Users delete their own alerts"
  ON public.price_alerts FOR DELETE
  USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.platform_cost_params (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state text,
  commodity_class text,
  transport_paise_per_quintal integer NOT NULL CHECK (transport_paise_per_quintal >= 0),
  commission_pct numeric NOT NULL CHECK (commission_pct >= 0),
  packaging_paise_per_quintal integer NOT NULL CHECK (packaging_paise_per_quintal >= 0),
  platform_fee_paise_per_quintal integer NOT NULL CHECK (platform_fee_paise_per_quintal >= 0),
  wastage_pct numeric NOT NULL CHECK (wastage_pct >= 0 AND wastage_pct <= 100),
  version integer NOT NULL DEFAULT 1,
  is_current boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One current row per scope: a partial unique index (a table CONSTRAINT
-- cannot carry a WHERE clause). NULL state = all states; NULL
-- commodity_class = all classes. Postgres treats NULLs as distinct in a
-- unique index, so one current row per (state, class) combination can
-- coexist: global, per-state, per-class, and per-state-per-class.
CREATE UNIQUE INDEX IF NOT EXISTS platform_cost_params_one_current_per_scope
  ON public.platform_cost_params (state, commodity_class) WHERE is_current;

ALTER TABLE public.platform_cost_params ENABLE ROW LEVEL SECURITY;

-- Cost parameters are readable by all (the farmer sees the exact
-- assumptions behind their net-earnings figure). No INSERT / UPDATE /
-- DELETE policy: writes go through the backend admin API (service role)
-- only, so an admin PATCH can version rows instead of overwriting.
CREATE POLICY "Anyone reads cost parameters"
  ON public.platform_cost_params FOR SELECT
  USING (true);
