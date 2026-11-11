-- Security hardening migration (Farmer Marketplace escrow).
-- APPLY IN THE SUPABASE SQL EDITOR AFTER DEPLOYING THE 2026-11-08 SECURITY FIX.
-- Run the statements top to bottom; if one fails, read its comment — the
-- statements were written against the live column list (reconstructed in
-- 20261108_base_schema.sql), so a failure means a column is missing.
-- Fix that section against the live column list and re-run the rest.
--
-- What this does:
--  1. Locks the claim_pending_refunds RPC to the service role (it was
--     callable by anon/authenticated callers, who could strand refunds).
--  2. Adds refund retry bookkeeping columns used by the backend
--     (refund_attempts / next_retry_at). The code works without them
--     (best-effort), but the cron backoff needs them.
--  3. Adds a UNIQUE on payments.razorpay_payment_id (replay defense in
--     depth) — only if no duplicates exist.
--  4. Products: owner-only DELETE policy + UPDATE policy that cannot
--     transfer ownership (WITH CHECK farmer_id = auth.uid()).
--  5. Orders: INSERT policy that binds buyer + pending status + positive
--     quantity/price + the seller to the product's farmer; UPDATE policy
--     with a status allowlist so arbitrary statuses cannot be written
--     through PostgREST.
--  6. RLS on payments (service-role only; the frontend never reads it
--     directly) and on group_buys / group_buy_participants.
--  7. Value CHECKs (NOT VALID, so legacy rows do not block the migration).
--
-- Deliberately NOT changed here: the profiles SELECT policy (USING true).
-- Restricting it to authenticated users would hide farmer names/locations
-- from anonymous marketplace visitors. The login/signup existence oracle
-- is fixed in code instead (generic errors). Revisit only as a product
-- decision.

-- ============ 1. claim_pending_refunds: service role only ============
-- The function flips REFUND_PENDING orders to REFUND_PROCESSING. As written
-- it was SECURITY INVOKER with no EXECUTE restriction, so any anon or
-- authenticated PostgREST caller could claim (and strand) refunds.
-- SECURITY DEFINER makes it run as the owner; revoking EXECUTE from anon /
-- authenticated leaves only the service role (and postgres) able to call it.
ALTER FUNCTION public.claim_pending_refunds(int) SECURITY DEFINER;
REVOKE EXECUTE ON FUNCTION public.claim_pending_refunds(int) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_refunds(int) TO service_role;

-- ============ 2. Refund retry bookkeeping columns ============
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS refund_attempts int NOT NULL DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;

-- ============ 3. payments.razorpay_payment_id UNIQUE (replay defense) ============
-- Only added when no duplicate non-null payment id exists; if this block is
-- skipped, list the duplicates and clean them up first.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.payments
    WHERE razorpay_payment_id IS NOT NULL
    GROUP BY razorpay_payment_id
    HAVING COUNT(*) > 1
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_razorpay_payment_id_key'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_razorpay_payment_id_key UNIQUE (razorpay_payment_id);
  END IF;
END $$;

-- ============ 4. Products: owner-only DELETE + ownership-locked UPDATE ============
-- No DELETE policy existed, so the outcome depended entirely on the live
-- configuration. Now only the owning farmer can delete, and an update can
-- never reassign the row to another farmer.
DROP POLICY IF EXISTS "Farmers can delete their own products." ON public.products;
CREATE POLICY "Farmers can delete their own products."
  ON public.products FOR DELETE
  USING ( auth.uid() = farmer_id );

DROP POLICY IF EXISTS "Farmers can update own products." ON public.products;
CREATE POLICY "Farmers can update own products."
  ON public.products FOR UPDATE
  USING ( auth.uid() = farmer_id )
  WITH CHECK ( farmer_id = auth.uid() );

-- ============ 5. Orders: bound INSERT + status-allowlisted UPDATE ============
-- INSERT: the buyer must be the caller, the status must be 'pending', the
-- quantity and total must be positive, and the farmer must be the product's
-- farmer. (The charge amount itself is bound server-side in create-order;
-- this policy is the PostgREST backstop.)
DROP POLICY IF EXISTS "Buyers can insert their own orders." ON public.orders;
CREATE POLICY "Buyers can insert their own orders."
  ON public.orders FOR INSERT
  WITH CHECK (
    auth.uid() = buyer_id
    AND status = 'pending'
    AND quantity > 0
    AND total_price > 0
    AND farmer_id IN (SELECT farmer_id FROM public.products WHERE id = product_id)
  );

-- UPDATE: only the farmer of the order's product may update, and the new
-- status must be one the application actually uses. (The backend enforces
-- the transition map; this stops direct PostgREST writes of arbitrary
-- statuses such as 'delivered' on an unpaid order.)
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
      'pending', 'confirmed', 'declined', 'delivered', 'cancelled',
      'CREATED', 'PAID', 'SHIPPED', 'COMPLETED',
      'REFUNDED', 'REFUND_PENDING', 'REFUND_PROCESSING',
      'REFUND_FAILED', 'REFUND_RECONCILE'
    )
  );

-- ============ 6. RLS on payments / group_buys / group_buy_participants ============
-- payments: only the backend (service role) touches this table — the
-- frontend never reads it directly. Enabling RLS with no anon/authenticated
-- policy denies it to them by default.
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

-- group_buys: anyone may read active buys (marketplace listing); only a
-- signed-in user may create one. (No owner column could be verified from
-- source, so the INSERT check is authenticated-only, not owner-bound.)
ALTER TABLE public.group_buys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can view active group buys." ON public.group_buys;
CREATE POLICY "Anyone can view active group buys."
  ON public.group_buys FOR SELECT
  USING ( status = 'active' );
DROP POLICY IF EXISTS "Signed-in users can create group buys." ON public.group_buys;
CREATE POLICY "Signed-in users can create group buys."
  ON public.group_buys FOR INSERT
  WITH CHECK ( auth.role() = 'authenticated' );

-- group_buy_participants: anyone may read a group's participants; a user may
-- only join as themselves.
ALTER TABLE public.group_buy_participants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can view group participants." ON public.group_buy_participants;
CREATE POLICY "Anyone can view group participants."
  ON public.group_buy_participants FOR SELECT
  USING ( true );
DROP POLICY IF EXISTS "Users can only join as themselves." ON public.group_buy_participants;
CREATE POLICY "Users can only join as themselves."
  ON public.group_buy_participants FOR INSERT
  WITH CHECK ( auth.uid() = user_id );

-- ============ 7. Value CHECKs (NOT VALID: enforced for new/changed rows, ============
-- legacy rows are not re-validated so the migration cannot fail on them).
-- Guarded by column-existence checks because the live schema has drifted.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'quantity')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_quantity_positive') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_quantity_positive CHECK (quantity > 0) NOT VALID;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'total_price')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_total_price_positive') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_total_price_positive CHECK (total_price > 0) NOT VALID;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'user_price')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_user_price_positive') THEN
    ALTER TABLE public.products ADD CONSTRAINT products_user_price_positive CHECK (user_price > 0) NOT VALID;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'quantity')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_quantity_nonnegative') THEN
    ALTER TABLE public.products ADD CONSTRAINT products_quantity_nonnegative CHECK (quantity >= 0) NOT VALID;
  END IF;
END $$;
