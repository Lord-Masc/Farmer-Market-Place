-- Stage 0 (2026-11-12): order-via-backend + canonical order statuses.
-- Closes M2 (client-computed totals), R2 (no price snapshot) and P12
-- (14 mixed-case status strings, no CHECK).
--
-- DEPLOY ORDER: apply only together with the code in this PR — the buyer
-- INSERT policy is dropped below, so direct PostgREST order creation stops
-- working the moment this migration lands; the frontend must already call
-- POST /api/orders by then. Rollback: docs/ai/ROLLBACK.md (Stage 0, unit 2).
--
-- ============ 1. Price snapshot ============
-- price_at_order: the product's unit price at order time. The backend
-- writes it on every new order; createRazorpayOrder charges against it,
-- so a farmer price edit after confirmation can no longer brick payment.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS price_at_order numeric;

-- Backfill legacy rows from their stored total (total was computed as
-- unit_price * quantity * quintal-multiplier at insert time). Rows whose
-- quantity is 0 or unusable keep NULL and fall back to the live price.
UPDATE public.orders
  SET price_at_order = total_price / NULLIF(quantity * CASE WHEN unit_at_order = 'quintal' THEN 100 ELSE 1 END, 0)
  WHERE price_at_order IS NULL
    AND total_price IS NOT NULL
    AND quantity > 0;

-- ============ 2. Canonical uppercase status enum ============
-- Normalise every existing row first (UPPER covers 'pending' ->
-- 'PENDING', 'confirmed' -> 'CONFIRMED', 'declined' -> 'DECLINED',
-- 'delivered' -> 'DELIVERED', 'cancelled' -> 'CANCELLED'; the other nine
-- values are already uppercase), then forbid anything else.
UPDATE public.orders
  SET status = UPPER(status)
  WHERE status <> UPPER(status);

ALTER TABLE public.orders
  ADD CONSTRAINT orders_status_canonical
  CHECK (status IN (
    'PENDING', 'CREATED', 'CONFIRMED', 'DECLINED', 'PAID', 'SHIPPED',
    'COMPLETED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'REFUND_PENDING',
    'REFUND_PROCESSING', 'REFUND_FAILED', 'REFUND_RECONCILE'
  ));

-- ============ 3. Idempotency keys for POST /api/orders ============
-- Claimed atomically via UNIQUE(key, user_id); the service stores the
-- completed response so a retried request replays it instead of creating
-- a second order. RLS on, no policies: service-role only (the backend
-- never exposes this table to the frontend).
CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  key text NOT NULL,
  user_id uuid NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
  response_status int,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, user_id)
);

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

-- ============ 4. Orders are created by the backend only ============
-- Drop the buyer INSERT policy: direct PostgREST order creation (with
-- client-computed totals and spoofable counterparty fields) is no longer
-- allowed. The backend inserts with the service-role key, which bypasses
-- RLS, so POST /api/orders is unaffected.
DROP POLICY IF EXISTS "Buyers can insert their own orders." ON public.orders;

-- Farmer UPDATE policy: same ownership rule, allowlist rewritten to the
-- canonical uppercase statuses (the 20261109 allowlist named the
-- mixed-case values, which the CHECK above now forbids).
DROP POLICY IF EXISTS "Farmers can update the status of their orders." ON public.orders;
CREATE POLICY "Farmers can update the status of their orders."
  ON public.orders FOR UPDATE
  USING (
    auth.uid() IN (
      SELECT farmer_id FROM public.products WHERE id = product_id
    )
  )
  WITH CHECK (
    status IN (
      'PENDING', 'CONFIRMED', 'DECLINED', 'DELIVERED', 'CANCELLED',
      'CREATED', 'PAID', 'SHIPPED', 'COMPLETED',
      'REFUNDED', 'REFUND_PENDING', 'REFUND_PROCESSING',
      'REFUND_FAILED', 'REFUND_RECONCILE'
    )
  );

-- ============ 5. confirm_order_and_reserve_stock: uppercase statuses ============
-- Same logic as 20261111, with 'pending' -> 'PENDING' and 'confirmed' ->
-- 'CONFIRMED' so the RPC keeps working under the new CHECK.
CREATE OR REPLACE FUNCTION public.confirm_order_and_reserve_stock(p_order_id uuid, p_farmer_id uuid)
RETURNS SETOF public.orders
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_order public.orders; v_quantity numeric;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.farmer_id <> p_farmer_id THEN RAISE EXCEPTION 'ORDER_NOT_ACCESSIBLE'; END IF;
  IF v_order.status NOT IN ('PENDING', 'CREATED') THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
  v_quantity := v_order.quantity * CASE WHEN v_order.unit_at_order = 'quintal' THEN 100 ELSE 1 END;
  IF v_quantity <= 0 THEN RAISE EXCEPTION 'INVALID_QUANTITY'; END IF;
  UPDATE public.products SET quantity = quantity - v_quantity
    WHERE id = v_order.product_id AND farmer_id = p_farmer_id AND quantity >= v_quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSUFFICIENT_STOCK'; END IF;
  UPDATE public.orders SET status = 'CONFIRMED' WHERE id = p_order_id RETURNING * INTO v_order;
  RETURN NEXT v_order;
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_order_and_reserve_stock(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_order_and_reserve_stock(uuid, uuid) TO service_role;
