-- Stage 10 (2026-11-12): admin read models + moderation persistence.
--
-- WHAT THIS FILE DOES
--  1. profiles.suspended_at (nullable timestamptz; NULL = not suspended).
--     Set by POST /api/admin/moderation/:userId/suspend, cleared by
--     .../reinstate. The API rejects every authenticated request from a
--     suspended account (requireAuth, fresh read per request).
--  2. products.status text CHECK (status IN ('active','hidden'))
--     DEFAULT 'active'. Suspension hides ALL of the user's products
--     (status = 'hidden') — that IS the takedown; reinstatement restores
--     them to 'active'. Existing rows all become 'active'.
--  3. products public SELECT policy: hidden products are invisible to
--     anon and to other buyers; the OWNER still sees their own hidden
--     listings (so a suspended farmer sees what was taken down, and a
--     reinstatement is verifiable). Admin reads go through the
--     service-role client, which bypasses RLS entirely. Policy name is
--     unchanged; only the USING clause changes.
--  4. admin_stuck_money (read-only view): one row per order with money
--     in a stuck state, computed from REAL orders/payments only.
--       confirmed_unpaid: order CONFIRMED with no captured (HELD or
--         RELEASED) payment row — the webhook/browser callback both
--         missed it (the Stage 0 reconciler's population).
--       completed_held: order COMPLETED while its payment is still
--         HELD — the release step (markOrderAsCompleted flips HELD to
--         RELEASED) never ran, so the farmer was never paid.
--       refund_reconcile: order status REFUND_RECONCILE — the gateway
--         refund succeeded but a later ledger/status write failed
--         (escrowService.reconcileRefunds owns these rows).
--     amount_paise = orders.total_price (RUPEES) x 100. payments has
--     UNIQUE(order_id), so the JOIN cannot duplicate an order.
--  5. platform_metrics_daily (read-only view): one row per day —
--     orders_count, gmv_paise (orders with a captured payment only),
--     paid_orders. A daily rollup for reporting; the live admin and
--     transparency endpoints compute fresh from the base tables via
--     adminMetricsService, never from hand-entered numbers.
--
-- DOCUMENTED DEVIATION (coordinator decision): the roadmap says
-- "read-only views, no new write paths", but moderation state must
-- persist somewhere. The minimal persistence is the two nullable
-- columns above on EXISTING tables — no new mutable tables, no other
-- columns. The views themselves remain read-only.
--
-- APPLY ORDER: after 20261116_trust_foundation.sql (it defines
-- is_admin()). FILE ONLY — apply in the Supabase SQL Editor.
-- Never run by this stage.
--
-- ROLLBACK (if applied live): DROP VIEW public.platform_metrics_daily;
-- DROP VIEW public.admin_stuck_money; ALTER TABLE public.products DROP
-- COLUMN status; ALTER TABLE public.profiles DROP COLUMN suspended_at;
-- restore the products SELECT policy to USING (true). The two columns
-- are nullable/additive, so dropping them loses only suspension state
-- (re-derivable: any user whose products are all 'hidden' by an admin
-- action) — see docs/ai/ROLLBACK.md.

-- ============ 1. Moderation persistence (deviation, see header) ============
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'hidden'));

-- ============ 2. Hidden products are invisible to everyone but the owner ============
DROP POLICY IF EXISTS "Products are viewable by everyone." ON public.products;
CREATE POLICY "Products are viewable by everyone."
  ON public.products FOR SELECT
  USING (status = 'active' OR auth.uid() = farmer_id);

-- ============ 3. Stuck-money view ============
CREATE OR REPLACE VIEW public.admin_stuck_money AS
SELECT
  o.id AS order_id,
  'confirmed_unpaid' AS category,
  (o.total_price * 100)::bigint AS amount_paise,
  o.status AS order_status,
  NULL::text AS payment_status,
  o.created_at AS created_at
FROM public.orders o
WHERE o.status = 'CONFIRMED'
  AND NOT EXISTS (
    SELECT 1 FROM public.payments p
    WHERE p.order_id = o.id
      AND p.status IN ('HELD', 'RELEASED')
  )
UNION ALL
SELECT
  o.id AS order_id,
  'completed_held' AS category,
  (o.total_price * 100)::bigint AS amount_paise,
  o.status AS order_status,
  p.status AS payment_status,
  o.created_at AS created_at
FROM public.orders o
JOIN public.payments p ON p.order_id = o.id
WHERE o.status = 'COMPLETED'
  AND p.status = 'HELD'
UNION ALL
SELECT
  o.id AS order_id,
  'refund_reconcile' AS category,
  (o.total_price * 100)::bigint AS amount_paise,
  o.status AS order_status,
  p.status AS payment_status,
  o.created_at AS created_at
FROM public.orders o
LEFT JOIN public.payments p ON p.order_id = o.id
WHERE o.status = 'REFUND_RECONCILE';

-- Service role only: the backend is the only reader (admin endpoints).
-- No anon/authenticated grant — stuck money must never leak to the
-- public API surface.
GRANT SELECT ON public.admin_stuck_money TO service_role;

-- ============ 4. Daily platform-metrics rollup view ============
CREATE OR REPLACE VIEW public.platform_metrics_daily AS
SELECT
  DATE(o.created_at) AS day,
  COUNT(*)::bigint AS orders_count,
  COALESCE(
    SUM(o.total_price * 100) FILTER (WHERE p.status IN ('HELD', 'RELEASED')),
    0
  )::bigint AS gmv_paise,
  COUNT(*) FILTER (WHERE p.status IN ('HELD', 'RELEASED'))::bigint AS paid_orders
FROM public.orders o
LEFT JOIN public.payments p ON p.order_id = o.id
GROUP BY DATE(o.created_at);

GRANT SELECT ON public.platform_metrics_daily TO service_role;
