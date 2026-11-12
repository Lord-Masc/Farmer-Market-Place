-- Stage 4, module C — Negotiation (2026-11-12): requirements, offers,
-- agreements.
--
-- WHAT THIS FILE DOES
--  1. requirements: a buyer posts a requirement (crop, quantity, quality,
--     delivery window, target price). Status 'open' until an agreement
--     forms, then 'accepted'.
--  2. offers: a farmer quotes on a requirement. product_id names the
--     farmer's own listing the quote is tied to — acceptance creates a
--     real order through the escrow path, and orders.product_id is
--     NOT NULL, so a quote without a listing could never become an order.
--     created_by records who made this offer row (farmer on the first
--     quote, buyer/farmer alternating on counters); the counterparty
--     check in the backend keys off it. Status: open / countered /
--     accepted / rejected / expired. price_tiers is JSONB
--     [{min_quantity, price}] — validated in the backend, never trusted
--     from the client at accept time (the locked price is the row's
--     price column).
--  3. agreements: the accepted offer frozen as locked price + quantity +
--     delivery window, with the order it created. UNIQUE(offer_id): one
--     agreement per offer, so a duplicate accept can only ever replay.
--     idempotency_key records the accept call's key so a retry with the
--     same key replays the same agreement instead of creating a second
--     order.
--  4. Post-acceptance immutability: a BEFORE UPDATE trigger raises on ANY
--     update to an 'accepted' requirement/offer and on ANY update to an
--     agreement. History is append-only by construction — there are no
--     edit endpoints, no UPDATE policies (PostgREST cannot update these
--     rows at all), and the trigger is the backstop for the service role.
--     The backend's own status flips (open -> accepted/countered/
--     rejected) all start from 'open', so they pass the trigger.
--  5. RLS: only the requirement's buyer and the quoting farmer(s) can
--     read their negotiation; an admin reads all (via the existing
--     public.is_admin() helper from 20261116_trust_foundation.sql). No
--     anon access. No UPDATE/DELETE policies by design — status
--     transitions go through the backend (service role).
--
-- APPLY ORDER: after 20261116_trust_foundation.sql (it defines is_admin())
-- and 20261117_crop_passport.sql (no dependency, order between them is
-- free). FILE ONLY — apply in the Supabase SQL Editor. Never run by this
-- stage.
-- Rollback: DROP TABLE public.agreements; DROP TABLE public.offers;
-- DROP TABLE public.requirements; DROP FUNCTION
-- public.prevent_accepted_negotiation_edit(); (the policies vanish with
-- the tables; see docs/ai/ROLLBACK.md, Stage 4 module C).
--
-- FairPrice anchor (Stage 3 integration point): Stage 3 is blocked and
-- its mandi_prices table does NOT exist. Nothing here references it and
-- no price is invented — the backend returns fairPriceAnchor: null until
-- Stage 3 wires it.

-- ============ 1. requirements ============
CREATE TABLE IF NOT EXISTS public.requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  crop text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity > 0),
  quality text,
  delivery_window_start date NOT NULL,
  delivery_window_end date NOT NULL CHECK (delivery_window_end >= delivery_window_start),
  target_price numeric NOT NULL CHECK (target_price > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS requirements_buyer_id_idx
  ON public.requirements (buyer_id);

ALTER TABLE public.requirements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Buyers can view their own requirements." ON public.requirements;
CREATE POLICY "Buyers can view their own requirements."
  ON public.requirements FOR SELECT
  USING (auth.uid() = buyer_id OR public.is_admin());

DROP POLICY IF EXISTS "Buyers can insert their own requirements." ON public.requirements;
CREATE POLICY "Buyers can insert their own requirements."
  ON public.requirements FOR INSERT
  WITH CHECK (auth.uid() = buyer_id);

-- No UPDATE/DELETE policy by design: requirements change only through the
-- backend (service role), and the trigger below blocks post-acceptance edits.

-- ============ 2. offers ============
CREATE TABLE IF NOT EXISTS public.offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id uuid NOT NULL REFERENCES public.requirements(id) ON DELETE CASCADE,
  farmer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  price numeric NOT NULL CHECK (price > 0),
  quantity numeric NOT NULL CHECK (quantity > 0),
  price_tiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'countered', 'accepted', 'rejected', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS offers_requirement_id_idx
  ON public.offers (requirement_id);
CREATE INDEX IF NOT EXISTS offers_farmer_id_idx
  ON public.offers (farmer_id);

ALTER TABLE public.offers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Negotiation parties can view offers." ON public.offers;
CREATE POLICY "Negotiation parties can view offers."
  ON public.offers FOR SELECT
  USING (
    auth.uid() = farmer_id
    OR public.is_admin()
    OR auth.uid() IN (
      SELECT buyer_id FROM public.requirements WHERE id = requirement_id
    )
  );

DROP POLICY IF EXISTS "Farmers can insert their own offers." ON public.offers;
CREATE POLICY "Farmers can insert their own offers."
  ON public.offers FOR INSERT
  WITH CHECK (auth.uid() = farmer_id);

-- No UPDATE/DELETE policy by design (see requirements above).

-- ============ 3. agreements ============
CREATE TABLE IF NOT EXISTS public.agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL UNIQUE REFERENCES public.offers(id) ON DELETE CASCADE,
  requirement_id uuid NOT NULL REFERENCES public.requirements(id) ON DELETE CASCADE,
  buyer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  farmer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  locked_price numeric NOT NULL CHECK (locked_price > 0),
  locked_quantity numeric NOT NULL CHECK (locked_quantity > 0),
  delivery_window_start date NOT NULL,
  delivery_window_end date NOT NULL CHECK (delivery_window_end >= delivery_window_start),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agreements_requirement_id_idx
  ON public.agreements (requirement_id);
CREATE INDEX IF NOT EXISTS agreements_order_id_idx
  ON public.agreements (order_id);

ALTER TABLE public.agreements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Negotiation parties can view agreements." ON public.agreements;
CREATE POLICY "Negotiation parties can view agreements."
  ON public.agreements FOR SELECT
  USING (auth.uid() = buyer_id OR auth.uid() = farmer_id OR public.is_admin());

-- No INSERT/UPDATE/DELETE policy by design: agreements are written only
-- through the backend (service role) when an offer is accepted.

-- ============ 4. Post-acceptance immutability guard ============
-- Service role bypasses RLS but NOT triggers, so this is the backstop
-- against any price/quantity change after acceptance — including a
-- backend bug. Accepted rows are frozen; agreements are frozen from birth.
CREATE OR REPLACE FUNCTION public.prevent_accepted_negotiation_edit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'agreements' THEN
    RAISE EXCEPTION 'agreements are immutable';
  END IF;
  IF OLD.status = 'accepted' THEN
    RAISE EXCEPTION '% is accepted and cannot be changed', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_requirement_edit_after_acceptance ON public.requirements;
CREATE TRIGGER prevent_requirement_edit_after_acceptance
  BEFORE UPDATE ON public.requirements
  FOR EACH ROW EXECUTE FUNCTION public.prevent_accepted_negotiation_edit();

DROP TRIGGER IF EXISTS prevent_offer_edit_after_acceptance ON public.offers;
CREATE TRIGGER prevent_offer_edit_after_acceptance
  BEFORE UPDATE ON public.offers
  FOR EACH ROW EXECUTE FUNCTION public.prevent_accepted_negotiation_edit();

DROP TRIGGER IF EXISTS prevent_agreement_edit ON public.agreements;
CREATE TRIGGER prevent_agreement_edit
  BEFORE UPDATE ON public.agreements
  FOR EACH ROW EXECUTE FUNCTION public.prevent_accepted_negotiation_edit();
