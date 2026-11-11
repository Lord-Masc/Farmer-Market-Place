-- Base schema for a FRESH Supabase project (Farmer Marketplace rebuild).
-- Reconstructed from the code that actually runs (backend/services/escrowService.js,
-- backend/controllers/, src/pages/, src/services/, src/context/AuthContext.jsx),
-- NOT from the old stale schema.sql (removed from the repo — its orders
-- table lacked farmer_id/total_price/quantity/delivery fields and there
-- was no payments table).
--
-- Migration order on a fresh project:
--   1. 20261108_base_schema.sql (this file)
--   2. 20261108_create_refunds.sql (refunds table, payments.razorpay_payment_id,
--      claim_pending_refunds function)
--   3. 20261109_security_hardening.sql (refund retry columns, payments UNIQUE,
--      products/orders policy replacements, RLS on payments/group tables, CHECKs)
-- Later migrations own what they add; this file deliberately does NOT create:
--   - refunds (20261108_create_refunds.sql)
--   - payments.razorpay_payment_id (added by 20261108_create_refunds.sql §2)
--   - orders.refund_attempts / next_retry_at (added by 20261109 §2)
--   - products UPDATE/DELETE policies and orders INSERT/UPDATE policies
--     (dropped and recreated by 20261109 §4/§5 — creating them here would
--     duplicate them; see the policy notes below)
--   - group_buys / group_buy_participants policies (created by 20261109 §6)
--
-- Deliberately omitted (no code reads or writes them):
--   - products.stock, products.status, products.image_url (stale schema only;
--     stock is tracked via products.quantity, images via image_url_1/_2)
--   - products.emoji / farm / rating (hardcoded fallback sample in
--     src/pages/Product.jsx only, never a DB write)
--   - orders has NO status CHECK: the stale check ('Pending','Shipped',
--     'Delivered','Cancelled') contradicts the values the code actually stores
--     ('pending','CREATED','PAID','SHIPPED','COMPLETED','confirmed','declined',
--     'delivered','cancelled','REFUNDED','REFUND_PENDING','REFUND_PROCESSING',
--     'REFUND_FAILED','REFUND_RECONCILE'). The 20261109 UPDATE policy
--     allowlists statuses for direct PostgREST writes instead.
--   - group_buys has only product_id/status/created_at: src/services/groupService.js
--     has no callers in the repo and no other field is evidenced anywhere
--     (the 20261109 migration itself notes no owner column could be verified).

-- ============ profiles ============
-- Written by src/pages/SignUp.jsx (insert); read by AuthContext, Login,
-- BuyerDashboard, FarmerDashboard, UserProfile, orderService (buyer embed).
CREATE TABLE public.profiles (
  id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL PRIMARY KEY,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email_address text NOT NULL UNIQUE,
  phone_number text NOT NULL,
  phone text,
  role text CHECK (role IN ('buyer', 'farmer')) NOT NULL,
  state text,
  city text,
  address text,
  latitude double precision,
  longitude double precision,
  photo_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Kept as-is: 20261109 deliberately does not change the profiles SELECT
-- policy (anonymous visitors must see farmer names/locations), and the
-- anon SELECTs in SignUp (email existence check) and Login (phone -> email
-- lookup) depend on USING (true).
CREATE POLICY "Public profiles are viewable by everyone."
  ON public.profiles FOR SELECT
  USING ( true );

CREATE POLICY "Users can insert their own profile."
  ON public.profiles FOR INSERT
  WITH CHECK ( auth.uid() = id );

CREATE POLICY "Users can update own profile."
  ON public.profiles FOR UPDATE
  USING ( auth.uid() = id );

-- ============ products ============
-- Written by src/pages/FarmerDashboard.jsx (insert/update/delete);
-- read by BuyerDashboard, FarmerDashboard, productService, orderService
-- (products(*) embed), groupService (products(*) embed), escrowService
-- (price binding via user_price ?? price, atomic stock decrement via quantity).
CREATE TABLE public.products (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  farmer_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  name text NOT NULL,
  description text,
  price numeric,
  user_price numeric NOT NULL,
  quantity numeric NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'kg',
  category text,
  address text,
  latitude double precision,
  longitude double precision,
  image_url_1 text,
  image_url_2 text,
  gov_price numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Products are viewable by everyone."
  ON public.products FOR SELECT
  USING ( true );

CREATE POLICY "Farmers can insert their own products."
  ON public.products FOR INSERT
  WITH CHECK ( auth.uid() = farmer_id );

-- No UPDATE/DELETE policy here: 20261109 §4 drops and recreates both
-- ("Farmers can update own products." with ownership-locked WITH CHECK,
-- "Farmers can delete their own products."). Creating them here would
-- duplicate that migration.

-- ============ orders ============
-- Written by escrowService.createRazorpayOrder / verifyAndMarkPaid /
-- updateOrderStatusWithStock / markOrderAsShipped / markOrderAsCompleted /
-- markRefundPending / refundOrder / autoRefundJob, and by
-- src/pages/BuyerDashboard.jsx (direct 'pending' insert);
-- read by both dashboards, ConfirmedOrders, PendingOrders, RewardPoints,
-- SpentAnalysis, orderService.
-- product_id has no ON DELETE action (NO ACTION): FarmerDashboard refuses
-- deletes while active orders exist and handles error 23503, i.e. the live
-- FK blocked the delete rather than nulling the reference.
CREATE TABLE public.orders (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  buyer_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  farmer_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  product_id uuid REFERENCES public.products(id) NOT NULL,
  quantity numeric NOT NULL,
  unit_at_order text NOT NULL DEFAULT 'kg',
  total_price numeric NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  delivery_address text,
  buyer_phone text,
  farmer_name text,
  farmer_phone text,
  delivery_deadline timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Buyers can view their own orders."
  ON public.orders FOR SELECT
  USING ( auth.uid() = buyer_id );

CREATE POLICY "Farmers can view orders for their products."
  ON public.orders FOR SELECT
  USING (
    auth.uid() IN (
      SELECT farmer_id FROM public.products WHERE id = product_id
    )
  );

-- No INSERT/UPDATE policy here: 20261109 §5 drops and recreates both
-- ("Buyers can insert their own orders." bound to buyer + 'pending' +
-- positive quantity/price + product's farmer; "Farmers can update the
-- status of their orders." with a status allowlist). Creating them here
-- would duplicate that migration.

-- ============ payments ============
-- Written/read only by the backend (service role): escrowService
-- verifyAndMarkPaid inserts (order_id, amount, status 'HELD'), the replay
-- guard reads by razorpay_payment_id, markOrderAsCompleted releases
-- HELD -> RELEASED, refunds set REFUNDED. The frontend never reads it.
-- razorpay_payment_id is NOT created here: 20261108_create_refunds.sql §2
-- adds it, and 20261109 §3 adds its UNIQUE constraint.
CREATE TABLE public.payments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL,
  amount numeric NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS on, no policies: service-role only (20261109 §6 re-issues the same
-- ENABLE ROW LEVEL SECURITY; no anon/authenticated policy exists either way).
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

-- ============ group_buys ============
-- Only used by src/services/groupService.js (no callers in the repo):
-- getActiveGroupBuys selects '*, products(*)' where status = 'active',
-- so product_id must FK to products for the embed to resolve.
CREATE TABLE public.group_buys (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id uuid REFERENCES public.products(id),
  status text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS on, no policies here: 20261109 §6 creates both group_buys policies.
ALTER TABLE public.group_buys ENABLE ROW LEVEL SECURITY;

-- ============ group_buy_participants ============
-- Only used by groupService.joinGroupBuy (insert group_buy_id, user_id,
-- quantity) and getParticipants (select '*, profiles(*)' by group_buy_id,
-- so user_id must FK to profiles for the embed to resolve).
CREATE TABLE public.group_buy_participants (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  group_buy_id uuid REFERENCES public.group_buys(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  quantity numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS on, no policies here: 20261109 §6 creates both participants policies.
ALTER TABLE public.group_buy_participants ENABLE ROW LEVEL SECURITY;
