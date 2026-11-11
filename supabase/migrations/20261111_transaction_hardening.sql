-- Apply after 20261109_security_hardening.sql.
CREATE OR REPLACE FUNCTION public.confirm_order_and_reserve_stock(p_order_id uuid, p_farmer_id uuid)
RETURNS SETOF public.orders
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_order public.orders; v_quantity numeric;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.farmer_id <> p_farmer_id THEN RAISE EXCEPTION 'ORDER_NOT_ACCESSIBLE'; END IF;
  IF v_order.status NOT IN ('pending', 'CREATED') THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
  v_quantity := v_order.quantity * CASE WHEN v_order.unit_at_order = 'quintal' THEN 100 ELSE 1 END;
  IF v_quantity <= 0 THEN RAISE EXCEPTION 'INVALID_QUANTITY'; END IF;
  UPDATE public.products SET quantity = quantity - v_quantity
    WHERE id = v_order.product_id AND farmer_id = p_farmer_id AND quantity >= v_quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSUFFICIENT_STOCK'; END IF;
  UPDATE public.orders SET status = 'confirmed' WHERE id = p_order_id RETURNING * INTO v_order;
  RETURN NEXT v_order;
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_order_and_reserve_stock(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_order_and_reserve_stock(uuid, uuid) TO service_role;

-- Honour next_retry_at instead of retrying every pending refund hourly.
CREATE OR REPLACE FUNCTION public.claim_pending_refunds(p_limit int DEFAULT 50)
RETURNS SETOF public.orders
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.orders SET status = 'REFUND_PROCESSING'
  WHERE id IN (
    SELECT id FROM public.orders
    WHERE status = 'REFUND_PENDING'
      AND (next_retry_at IS NULL OR next_retry_at <= now())
    ORDER BY created_at LIMIT GREATEST(p_limit, 0)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;
REVOKE ALL ON FUNCTION public.claim_pending_refunds(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_refunds(int) TO service_role;
