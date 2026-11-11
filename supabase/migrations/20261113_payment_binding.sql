-- Persist the exact Razorpay order created for each marketplace order.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS razorpay_order_id text;
CREATE UNIQUE INDEX IF NOT EXISTS orders_razorpay_order_id_unique
  ON public.orders (razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL;

-- One captured payment record per marketplace order; verification can safely retry.
CREATE UNIQUE INDEX IF NOT EXISTS payments_order_id_unique
  ON public.payments (order_id);
