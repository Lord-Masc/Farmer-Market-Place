-- Stage 5, module D — Smart Group Selling (2026-11-12): group_buys,
-- group_buy_participants, group_settlements.
--
-- COORDINATOR SEMANTICS — the group is a DEMAND pool. Farmers (acting as
-- buyers) pool quantities of the same crop to buy wholesale as one buyer
-- — this matches the original placeholder ("Combine orders with your
-- neighbors to unlock wholesale bulk pricing directly from farms!") and
-- the roadmap's "group buying negotiates as one buyer". The owner places
-- the pooled order as buyer-representative. Settlement rows record each
-- participant's SHARE OF THE POOLED ORDER TOTAL in integer paise (what
-- they owe toward the pooled order) — never a "payout"; collection /
-- reconciliation is a later stage. No transport is built here (Stage 6).
--
-- WHAT THIS FILE DOES
--  1. group_buys: a farmer opens a pool for one crop (threshold quantity,
--     unit kg/quintal, deadline). Status 'open' until the owner closes it
--     (threshold met, exactly one pooled order), or 'cancelled'.
--     requirement_id links the Stage 4 requirement the group negotiates
--     through; order_id links the pooled order created at close.
--  2. group_buy_participants: one row per farmer in the pool, with their
--     contribution quantity and their share (contribution / total, set at
--     close). UNIQUE(group_buy_id, user_id): joining twice is impossible.
--  3. group_settlements: one row per participant at close, recording
--     that participant's share of the pooled order total in integer
--     paise. UNIQUE(group_buy_id, participant_id): a second close can
--     only ever replay. Status 'pending' until a later stage reconciles
--     collection; 'settled' is the terminal state.
--  4. requirements.group_buy_id: the reverse link so a Stage 4
--     requirement knows it speaks for a group (the group requirement's
--     offers must match the pooled quantity — enforced in the backend).
--  5. RLS: group_buys are readable by any authenticated user (a pool must
--     be discoverable to join); participants are readable by the
--     participant themselves, the owner, and admins; settlements are
--     readable by the participant themselves, the owner, and admins (via
--     the existing public.is_admin() helper from
--     20261116_trust_foundation.sql). No anon access. No
--     INSERT/UPDATE/DELETE policies by design — rows are written only
--     through the backend (service role). The full participants list is
--     served via the API (service role); direct PostgREST reads see only
--     the caller's own rows by design.
--  6. Trigger backstops (service role bypasses RLS but NOT triggers):
--     participants cannot change once the parent group leaves 'open';
--     'closed' is terminal for a group, and order_id / requirement_id
--     are immutable once set.
--
-- APPLY ORDER: after 20261119_negotiation.sql (it defines requirements,
-- which this file references and alters) and 20261116_trust_foundation.sql
-- (it defines is_admin()). FILE ONLY — apply in the Supabase SQL Editor.
-- Never run by this stage.
-- Rollback: DROP TABLE public.group_settlements;
-- DROP TABLE public.group_buy_participants; DROP TABLE public.group_buys;
-- ALTER TABLE public.requirements DROP COLUMN group_buy_id;
-- DROP FUNCTION public.prevent_group_participant_change_when_closed();
-- DROP FUNCTION public.prevent_closed_group_buy_edit();
-- (the policies vanish with the tables; see docs/ai/ROLLBACK.md.)

-- ============ 1. group_buys ============
CREATE TABLE IF NOT EXISTS public.group_buys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  crop text NOT NULL,
  threshold_quantity numeric NOT NULL CHECK (threshold_quantity > 0),
  unit text NOT NULL DEFAULT 'kg' CHECK (unit IN ('kg', 'quintal')),
  deadline timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  requirement_id uuid NULL REFERENCES public.requirements(id) ON DELETE SET NULL,
  order_id uuid NULL REFERENCES public.orders(id) ON DELETE SET NULL,
  closed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS group_buys_owner_id_idx
  ON public.group_buys (owner_id);
CREATE INDEX IF NOT EXISTS group_buys_status_idx
  ON public.group_buys (status);

ALTER TABLE public.group_buys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Any authenticated user can view group buys." ON public.group_buys;
CREATE POLICY "Any authenticated user can view group buys."
  ON public.group_buys FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- No INSERT/UPDATE/DELETE policy by design: groups change only through
-- the backend (service role), and the trigger below blocks edits to a
-- closed group.

-- ============ 2. group_buy_participants ============
CREATE TABLE IF NOT EXISTS public.group_buy_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_buy_id uuid NOT NULL REFERENCES public.group_buys(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  contribution_quantity numeric NOT NULL CHECK (contribution_quantity > 0),
  share numeric NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(group_buy_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_buy_participants_group_buy_id_idx
  ON public.group_buy_participants (group_buy_id);

ALTER TABLE public.group_buy_participants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Group members, the owner and admins can view participants." ON public.group_buy_participants;
CREATE POLICY "Group members, the owner and admins can view participants."
  ON public.group_buy_participants FOR SELECT
  USING (
    auth.uid() = user_id
    OR public.is_admin()
    OR auth.uid() IN (
      SELECT owner_id FROM public.group_buys WHERE id = group_buy_id
    )
  );

-- No INSERT/UPDATE/DELETE policy by design (see group_buys above).

-- ============ 3. group_settlements ============
-- amount_paise is the participant's SHARE OF THE POOLED ORDER TOTAL in
-- integer paise — what they owe toward the pooled order. It is NOT a
-- payout: no money moves here, and collection/reconciliation is a later
-- stage.
CREATE TABLE IF NOT EXISTS public.group_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_buy_id uuid NOT NULL REFERENCES public.group_buys(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES public.group_buy_participants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount_paise integer NOT NULL CHECK (amount_paise >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'settled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(group_buy_id, participant_id)
);
CREATE INDEX IF NOT EXISTS group_settlements_group_buy_id_idx
  ON public.group_settlements (group_buy_id);

ALTER TABLE public.group_settlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "The participant, the owner and admins can view settlements." ON public.group_settlements;
CREATE POLICY "The participant, the owner and admins can view settlements."
  ON public.group_settlements FOR SELECT
  USING (
    auth.uid() = user_id
    OR public.is_admin()
    OR auth.uid() IN (
      SELECT owner_id FROM public.group_buys WHERE id = group_buy_id
    )
  );

-- No INSERT/UPDATE/DELETE policy by design (see group_buys above).

-- ============ 4. requirements.group_buy_id ============
-- The reverse link: a Stage 4 requirement created for a group records
-- which group it speaks for. group_buys must exist first (section 1),
-- hence this ALTER sits after the tables above.
ALTER TABLE public.requirements ADD COLUMN group_buy_id uuid NULL REFERENCES public.group_buys(id) ON DELETE SET NULL;

-- ============ 5. Trigger backstops ============
-- Service role bypasses RLS but NOT triggers, so these are the backstops
-- against a backend bug changing a pool after it closes. Participants are
-- frozen once the parent group leaves 'open' (shares are written while
-- the group is still open, at close time); a closed group never reopens,
-- and its order/requirement links never change once set.
CREATE OR REPLACE FUNCTION public.prevent_group_participant_change_when_closed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO parent_status FROM public.group_buys WHERE id = OLD.group_buy_id;
  ELSE
    SELECT status INTO parent_status FROM public.group_buys WHERE id = NEW.group_buy_id;
  END IF;
  IF parent_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'group_buy_participants cannot change when the group is not open';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_participant_change_when_closed ON public.group_buy_participants;
CREATE TRIGGER prevent_participant_change_when_closed
  BEFORE INSERT OR UPDATE OR DELETE ON public.group_buy_participants
  FOR EACH ROW EXECUTE FUNCTION public.prevent_group_participant_change_when_closed();

CREATE OR REPLACE FUNCTION public.prevent_closed_group_buy_edit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'closed' AND NEW.status IS DISTINCT FROM 'closed' THEN
    RAISE EXCEPTION 'a closed group buy is terminal and cannot be reopened';
  END IF;
  IF OLD.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION 'group_buy order_id is immutable once set';
  END IF;
  IF OLD.requirement_id IS NOT NULL AND NEW.requirement_id IS DISTINCT FROM OLD.requirement_id THEN
    RAISE EXCEPTION 'group_buy requirement_id is immutable once set';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_closed_group_buy_edit ON public.group_buys;
CREATE TRIGGER prevent_closed_group_buy_edit
  BEFORE UPDATE ON public.group_buys
  FOR EACH ROW EXECUTE FUNCTION public.prevent_closed_group_buy_edit();
