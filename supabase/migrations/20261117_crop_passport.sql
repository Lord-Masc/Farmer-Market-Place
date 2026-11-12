-- Stage 2, module A — Digital Crop Passport (2026-11-12): the crop_passports
-- table, the farmer_stats view, and orders.completed_at.
--
-- WHAT THIS FILE DOES
--  1. crop_passports: one lot row per product (UNIQUE product_id), written
--     by the backend only. A passport is only ever shown publicly for a
--     VERIFIED farmer — that gate lives in the backend (service role), not
--     here: PostgREST has no anon SELECT and no cross-farmer SELECT.
--  2. farmer_stats: a PLAIN VIEW (always fresh, never hand-entered),
--     computed ONLY from public.orders. dispute_rate is refund-flow-based
--     until Stage 7 disputes exist (see note below). on_time_rate excludes
--     orders completed before completed_at existed (NULL completed_at).
--  3. orders.completed_at: nullable timestamp set by
--     escrowService.markOrderAsCompleted; NULL for orders completed before
--     this change (their on-time status is unknowable, so the view excludes
--     them instead of guessing).
--  4. RLS on crop_passports: a farmer reads/inserts/updates only their own
--     rows; an admin reads all (via the existing public.is_admin() helper
--     from 20261116_trust_foundation.sql). No DELETE policy by design.
--
-- APPLY ORDER: after 20261116_trust_foundation.sql (it defines is_admin()).
-- FILE ONLY — apply in the Supabase SQL Editor. Never run by this stage.
-- Rollback: DROP VIEW public.farmer_stats; DROP TABLE public.crop_passports;
-- ALTER TABLE public.orders DROP COLUMN completed_at; (the farmer_stats
-- REVOKE/GRANT below vanish with the view; see docs/ai/ROLLBACK.md,
-- Stage 2 module A).
--
-- farmer_stats notes (hand-checked against the Stage 2 fixture):
--  - total_orders: every order for the farmer, any status.
--  - deliveries: orders in DELIVERED or COMPLETED.
--  - on_time_rate: among DELIVERED/COMPLETED orders that have BOTH a
--    delivery_deadline and a completed_at, the share with
--    completed_at <= delivery_deadline; NULL when that denominator is 0.
--    Orders completed before completed_at existed have NULL completed_at
--    and are excluded — never counted on time or late.
--  - dispute_rate: among paid-or-beyond orders (PAID, SHIPPED, DELIVERED,
--    COMPLETED, REFUNDED, REFUND_PENDING, REFUND_PROCESSING, REFUND_FAILED,
--    REFUND_RECONCILE), the share in a refund-flow state (REFUNDED,
--    REFUND_PENDING, REFUND_PROCESSING); NULL when that denominator is 0.
--    This is a refund-flow proxy, NOT a real dispute count: no disputes
--    table exists yet (Stage 7 adds one), so a refunded order is the only
--    signal available. Revisit the definition when disputes land.
--  - Rates are double precision (bigint / bigint would be integer division).
--  - The view has no RLS of its own: anon/authenticated are revoked below
--    and only service_role is granted SELECT, so it is readable only
--    through the backend, which enforces the verified-farmer gate.

-- ============ 1. crop_passports ============
CREATE TABLE IF NOT EXISTS public.crop_passports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL UNIQUE REFERENCES public.products(id) ON DELETE CASCADE,
  farmer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  crop text NOT NULL,
  variety text,
  quantity numeric NOT NULL CHECK (quantity > 0),
  unit text NOT NULL DEFAULT 'kg',
  harvest_date date NOT NULL,
  quality_grade text NOT NULL CHECK (quality_grade IN ('A', 'B', 'C', 'ungraded')),
  photos text[] NOT NULL DEFAULT '{}',
  mandi_price_reference numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crop_passports_farmer_id_idx
  ON public.crop_passports (farmer_id);

ALTER TABLE public.crop_passports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Farmers can view their own passports." ON public.crop_passports;
CREATE POLICY "Farmers can view their own passports."
  ON public.crop_passports FOR SELECT
  USING (auth.uid() = farmer_id OR public.is_admin());

DROP POLICY IF EXISTS "Farmers can insert their own passports." ON public.crop_passports;
CREATE POLICY "Farmers can insert their own passports."
  ON public.crop_passports FOR INSERT
  WITH CHECK (auth.uid() = farmer_id);

DROP POLICY IF EXISTS "Farmers can update their own passports." ON public.crop_passports;
CREATE POLICY "Farmers can update their own passports."
  ON public.crop_passports FOR UPDATE
  USING (auth.uid() = farmer_id)
  WITH CHECK (auth.uid() = farmer_id);

-- No DELETE policy and no anon SELECT by design: passports are created
-- through the backend (service role) and read publicly only through the
-- backend, which enforces the verified-farmer gate.

-- ============ 2. orders.completed_at ============
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- ============ 3. farmer_stats view ============
CREATE OR REPLACE VIEW public.farmer_stats AS
SELECT
  farmer_id,
  COUNT(*)::bigint AS total_orders,
  COUNT(*) FILTER (WHERE status IN ('DELIVERED', 'COMPLETED'))::bigint AS deliveries,
  CASE
    WHEN COUNT(*) FILTER (
      WHERE status IN ('DELIVERED', 'COMPLETED')
        AND delivery_deadline IS NOT NULL
        AND completed_at IS NOT NULL
    ) = 0 THEN NULL
    ELSE (
      COUNT(*) FILTER (
        WHERE status IN ('DELIVERED', 'COMPLETED')
          AND delivery_deadline IS NOT NULL
          AND completed_at IS NOT NULL
          AND completed_at <= delivery_deadline
      )::double precision
      / COUNT(*) FILTER (
        WHERE status IN ('DELIVERED', 'COMPLETED')
          AND delivery_deadline IS NOT NULL
          AND completed_at IS NOT NULL
      )
    )
  END AS on_time_rate,
  CASE
    WHEN COUNT(*) FILTER (
      WHERE status IN (
        'PAID', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'REFUNDED',
        'REFUND_PENDING', 'REFUND_PROCESSING', 'REFUND_FAILED', 'REFUND_RECONCILE'
      )
    ) = 0 THEN NULL
    ELSE (
      COUNT(*) FILTER (
        WHERE status IN ('REFUNDED', 'REFUND_PENDING', 'REFUND_PROCESSING')
      )::double precision
      / COUNT(*) FILTER (
        WHERE status IN (
          'PAID', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'REFUNDED',
          'REFUND_PENDING', 'REFUND_PROCESSING', 'REFUND_FAILED', 'REFUND_RECONCILE'
        )
      )
    )
  END AS dispute_rate
FROM public.orders
GROUP BY farmer_id;

-- Aggregate stats only: no lot or personal data, and readable only via the
-- backend (service role), which enforces the verified-farmer gate.
REVOKE ALL ON public.farmer_stats FROM anon, authenticated;
GRANT SELECT ON public.farmer_stats TO service_role;
