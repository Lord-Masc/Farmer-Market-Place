-- Refund idempotency migration (Farmer Marketplace escrow).
-- APPLY IN THE SUPABASE SQL EDITOR BEFORE DEPLOYING THE REFUND FIX.
-- The fix's code assumes this migration is applied (refunds table,
-- payments.razorpay_payment_id, claim_pending_refunds function).

-- 1. Refunds ledger: exactly one row per order, enforced by UNIQUE(order_id).
--    gateway_refund_id is the Razorpay refund id; status is REFUNDED / REFUND_FAILED.
CREATE TABLE IF NOT EXISTS public.refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE,
  gateway_refund_id text,
  status text NOT NULL,
  amount numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Keep the ledger behind RLS like the other tables (service_role bypasses RLS).
ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;

-- 2. Store the Razorpay payment id so a refund can call the gateway.
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS razorpay_payment_id text;

-- 3. Batch claim for the auto-refund cron: atomically flip up to p_limit
--    REFUND_PENDING orders to REFUND_PROCESSING, skipping rows already locked
--    by a concurrent run, and return only the claimed rows.
--    A concurrent cron run skips these rows (SKIP LOCKED), so the same order
--    is never claimed twice.
CREATE OR REPLACE FUNCTION public.claim_pending_refunds(p_limit int DEFAULT 50)
RETURNS SETOF public.orders
LANGUAGE sql
AS $$
  UPDATE public.orders
  SET status = 'REFUND_PROCESSING'
  WHERE id IN (
    SELECT id
    FROM public.orders
    WHERE status = 'REFUND_PENDING'
    ORDER BY created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;
