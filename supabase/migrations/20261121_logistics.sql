-- Stage 6, module E — Logistics & Delivery (2026-11-12): transporters,
-- shipments, shipment_events.
--
-- WHAT THIS FILE DOES
--  1. profiles.role CHECK widened to ('buyer', 'farmer', 'admin',
--     'transporter'). Same pattern Stage 1 used to add 'admin': drop the
--     old CHECK by definition lookup, add the named replacement.
--     A transporter IS a role (Stage 6 brief) — the Stage 1 trigger
--     prevent_trust_escalation already guards role changes (only
--     postgres / service_role may change trust fields), so no new
--     trigger is needed here.
--  2. transporters: one row per user (UNIQUE user_id). verification_status
--     mirrors Stage 1 ('unverified' | 'pending' | 'verified' |
--     'rejected', default 'unverified'); the Stage 1 admin approve/reject
--     flow sets it — there is NO second admin queue. vehicle_type /
--     vehicle_number / service_areas describe the vehicle; at least one
--     rate is required by the backend (a transporter with no rate cannot
--     be quoted). rating is NULL until real ratings exist in a later
--     stage — never invented.
--  3. shipments: one shipment per order (UNIQUE order_id). transporter_id
--     is nullable for self-delivery (the farmer delivers, no transporter
--     assigned). status enum booked / picked_up / in_transit /
--     out_for_delivery / delivered / cancelled. price_paise is the
--     server-recomputed quote (integer paise). delivery_window_start/end
--     is the transporter-committed window; booking sets
--     orders.delivery_deadline = delivery_window_end, replacing the
--     Stage 0 +48h default. otp_hash is SHA-256(salt+otp) and otp_salt
--     is the random salt — the plaintext OTP is NEVER stored and NEVER
--     logged; the buyer is shown it on their tracking page because the
--     OTP is derived from salt + shipment id (see the backend service
--     header). otp_attempts / otp_locked_until enforce the 5-failure,
--     15-minute lockout. proof_photo_paths are 'delivery-proofs/...'
--     paths in the PRIVATE bucket (section 6); gps_trail is a jsonb array
--     of { lat, lng, at } points the service only ever appends to.
--  4. shipment_events: append-only status history (shipment_id, status,
--     actor_id, lat/lng, note, created_at). No UPDATE/DELETE policies,
--     and a trigger raises on UPDATE/DELETE — history is never rewritten.
--  5. RLS: transporter reads/updates only own shipments; buyer/farmer
--     read shipments for their own orders; admin sees all via the Stage 1
--     is_admin() helper; no anon access. transporters rows are readable
--     by any authenticated user ONLY when verification_status='verified'
--     (unverified transporters are never listed); a transporter manages
--     their own row. No INSERT/DELETE policies by design — rows are
--     written only through the backend (service role).
--  6. STORAGE — DASHBOARD STEP (do NOT attempt in SQL; bucket creation
--     is not SQL): before go-live, create the PRIVATE 'delivery-proofs'
--     bucket in the Supabase Dashboard (Storage -> New bucket ->
--     'delivery-proofs', Public OFF, NO policies) — same pattern as
--     Stage 2's 'verification-docs' bucket. Only the service-role client
--     can read it; proof photos are served via 5-minute signed URLs
--     (GET /api/shipments/:id/track). The backend upload endpoint
--     (kind=proof) writes 'delivery-proofs/<uid>-<uuid>.<ext>'.
--
-- APPLY ORDER: after 20261116_trust_foundation.sql (it defines
-- is_admin() and the profiles_role_check this file widens). FILE ONLY —
-- apply in the Supabase SQL Editor. Never run by this stage.
-- Rollback: DROP TABLE public.shipment_events;
-- DROP TABLE public.shipments; DROP TABLE public.transporters;
-- DROP FUNCTION public.prevent_shipment_event_change();
-- re-create the old role CHECK (buyer/farmer/admin);
-- create the 'delivery-proofs' bucket deletion in the Dashboard
-- (see docs/ai/ROLLBACK.md, Stage 6).

-- ============ 1. profiles.role: allow 'transporter' ============
-- Drop the old buyer/farmer/admin CHECK by definition lookup (Stage 1
-- named it profiles_role_check; the lookup keeps this file safe to
-- re-run even if the name drifted).
DO $$
DECLARE _con text;
BEGIN
  SELECT conname INTO _con FROM pg_constraint
  WHERE conrelid = 'public.profiles'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%buyer%'
    AND pg_get_constraintdef(oid) LIKE '%farmer%'
    AND pg_get_constraintdef(oid) NOT LIKE '%transporter%';
  IF _con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', _con);
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_role_check' AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_role_check CHECK (role IN ('buyer', 'farmer', 'admin', 'transporter'));
  END IF;
END $$;

-- ============ 2. transporters ============
CREATE TABLE IF NOT EXISTS public.transporters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected')),
  vehicle_type text NOT NULL,
  vehicle_number text NOT NULL,
  service_areas text[] NOT NULL DEFAULT '{}',
  rate_paise_per_km integer CHECK (rate_paise_per_km IS NULL OR rate_paise_per_km >= 0),
  flat_rate_paise integer CHECK (flat_rate_paise IS NULL OR flat_rate_paise >= 0),
  -- NULL until real ratings exist in a later stage; never invented.
  rating numeric CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);
CREATE INDEX IF NOT EXISTS transporters_verification_status_idx
  ON public.transporters (verification_status);

ALTER TABLE public.transporters ENABLE ROW LEVEL SECURITY;

-- Any authenticated user may read a VERIFIED transporter (the shipper
-- choosing one); unverified transporters are never listed. A transporter
-- reads their own row whatever its status; admins read all.
DROP POLICY IF EXISTS "Verified transporters are listable; owners and admins read all." ON public.transporters;
CREATE POLICY "Verified transporters are listable; owners and admins read all."
  ON public.transporters FOR SELECT
  USING (
    verification_status = 'verified'
    OR auth.uid() = user_id
    OR public.is_admin()
  );

-- A transporter manages their own row (vehicle, areas, rates).
DROP POLICY IF EXISTS "Transporters update their own row." ON public.transporters;
CREATE POLICY "Transporters update their own row."
  ON public.transporters FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- No INSERT/DELETE policy by design: rows are created only through the
-- backend (service role) at registration.

-- ============ 3. shipments ============
CREATE TABLE IF NOT EXISTS public.shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  transporter_id uuid REFERENCES public.transporters(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'booked'
    CHECK (status IN ('booked', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'cancelled')),
  price_paise integer NOT NULL CHECK (price_paise >= 0),
  delivery_window_start timestamptz NOT NULL,
  delivery_window_end timestamptz NOT NULL,
  otp_hash text NOT NULL,
  otp_salt text NOT NULL,
  otp_attempts integer NOT NULL DEFAULT 0 CHECK (otp_attempts >= 0),
  otp_locked_until timestamptz,
  proof_photo_paths text[] NOT NULL DEFAULT '{}',
  gps_trail jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One shipment per order: a pooled lot books exactly one shared
  -- shipment, and a second booking for the same order is a 409.
  UNIQUE(order_id)
);
CREATE INDEX IF NOT EXISTS shipments_transporter_id_idx
  ON public.shipments (transporter_id);
CREATE INDEX IF NOT EXISTS shipments_status_idx
  ON public.shipments (status);

ALTER TABLE public.shipments ENABLE ROW LEVEL SECURITY;

-- Parties to the order (buyer, farmer), the assigned transporter, and
-- admins may read the shipment. No anon access.
DROP POLICY IF EXISTS "Order parties, the assigned transporter and admins can view shipments." ON public.shipments;
CREATE POLICY "Order parties, the assigned transporter and admins can view shipments."
  ON public.shipments FOR SELECT
  USING (
    public.is_admin()
    OR auth.uid() IN (SELECT buyer_id FROM public.orders WHERE id = order_id)
    OR auth.uid() IN (SELECT farmer_id FROM public.orders WHERE id = order_id)
    OR auth.uid() IN (SELECT user_id FROM public.transporters WHERE id = transporter_id)
  );

-- The assigned transporter updates their own shipment's status (the
-- backend enforces the transition table; this policy is the RLS layer).
DROP POLICY IF EXISTS "The assigned transporter updates their own shipment." ON public.shipments;
CREATE POLICY "The assigned transporter updates their own shipment."
  ON public.shipments FOR UPDATE
  USING (auth.uid() IN (SELECT user_id FROM public.transporters WHERE id = transporter_id))
  WITH CHECK (auth.uid() IN (SELECT user_id FROM public.transporters WHERE id = transporter_id));

-- No INSERT/DELETE policy by design: shipments are created only through
-- the backend (service role) at booking.

-- ============ 4. shipment_events (append-only) ============
CREATE TABLE IF NOT EXISTS public.shipment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
  status text NOT NULL
    CHECK (status IN ('booked', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'cancelled')),
  actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  lat double precision,
  lng double precision,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shipment_events_shipment_id_idx
  ON public.shipment_events (shipment_id, created_at);

ALTER TABLE public.shipment_events ENABLE ROW LEVEL SECURITY;

-- Same party check as shipments (via the parent shipment's order).
DROP POLICY IF EXISTS "Shipment parties and admins can view events." ON public.shipment_events;
CREATE POLICY "Shipment parties and admins can view events."
  ON public.shipment_events FOR SELECT
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.shipments s
      JOIN public.orders o ON o.id = s.order_id
      WHERE s.id = shipment_id
        AND (auth.uid() = o.buyer_id OR auth.uid() = o.farmer_id)
    )
    OR EXISTS (
      SELECT 1 FROM public.shipments s
      JOIN public.transporters t ON t.id = s.transporter_id
      WHERE s.id = shipment_id AND auth.uid() = t.user_id
    )
  );

-- No UPDATE/DELETE policy by design, and the trigger below raises on
-- any UPDATE/DELETE — history is append-only even for the service role.

CREATE OR REPLACE FUNCTION public.prevent_shipment_event_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'shipment_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS prevent_shipment_event_change ON public.shipment_events;
CREATE TRIGGER prevent_shipment_event_change
  BEFORE UPDATE OR DELETE ON public.shipment_events
  FOR EACH ROW EXECUTE FUNCTION public.prevent_shipment_event_change();
