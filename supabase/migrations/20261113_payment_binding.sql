-- Persist the exact Razorpay order created for each marketplace order.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS razorpay_order_id text;
CREATE UNIQUE INDEX IF NOT EXISTS orders_razorpay_order_id_unique
  ON public.orders (razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL;

-- One captured payment record per marketplace order; verification can safely retry.
-- Only added when no duplicate non-null order_id exists; if this block is
-- skipped, list the duplicates and clean them up first (pre-check P0a).
-- Same guard pattern as 20261109_security_hardening.sql section 3.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.payments
    WHERE order_id IS NOT NULL
    GROUP BY order_id
    HAVING COUNT(*) > 1
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'payments_order_id_unique'
  ) THEN
    CREATE UNIQUE INDEX payments_order_id_unique ON public.payments (order_id);
  END IF;
END $$;
