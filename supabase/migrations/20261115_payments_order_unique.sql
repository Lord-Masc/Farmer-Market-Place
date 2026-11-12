-- Stage 0 (2026-11-12): one payments row per order (L4).
-- The application assumes a single payment per order everywhere: refunds,
-- release and reconciliation all read the payment by order_id and take the
-- first row. Without this constraint a second capture could create a
-- second HELD row, and completion would release both — a double payout
-- for one order. The service also refunds a duplicate capture at the
-- gateway (see escrowService.verifyAndMarkPaid); this constraint is the
-- database backstop for the same invariant.
--
-- PRE-CHECK — run before applying, in the Supabase SQL Editor:
--   SELECT order_id, count(*) FROM public.payments
--   GROUP BY order_id HAVING count(*) > 1;
-- If that returns rows, resolve the duplicates first (refund the extra
-- capture at the Razorpay dashboard, keep the first row). This migration
-- fails loudly instead of half-applying.
--
-- NOTE (2026-11-12, live application): migration 20261113_payment_binding.sql
-- already created a unique INDEX named payments_order_id_unique on live
-- (2026-11-11). The ADD CONSTRAINT below therefore skips itself when an
-- index or constraint of that name already exists, so re-applying this
-- file is a no-op. The enforcement (one payments row per order) is identical
-- either way.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.payments GROUP BY order_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'payments has duplicate rows per order_id; resolve them before applying this migration (see header)';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'payments_order_id_unique')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_order_id_unique') THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_order_id_unique UNIQUE (order_id);
  END IF;
END $$;
