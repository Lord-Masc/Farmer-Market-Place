-- Security fixes (run-1 audit: findings 1, 3, 4, 5, 6 + finding 11 DB part)
-- (2026-11-13): close five direct-PostgREST RLS bypasses and add the
-- atomic per-user price-alert cap.
--
-- WHAT THIS FILE DOES
--  1. Finding 1 (HIGH, regression): drop the policy "Farmers can update
--     the status of their orders." on public.orders — migration
--     20261115 re-created it after 20261114 dropped it, letting any
--     farmer write PAID / COMPLETED / REFUNDED (and total_price,
--     quantity, buyer_id, ...) directly through PostgREST. No
--     replacement policy: the backend escrowService (service role,
--     bypasses RLS) is the only writer of orders.status, and the
--     frontend performs no direct orders UPDATE.
--  2. Finding 3 (HIGH): BEFORE UPDATE trigger on public.transporters
--     mirroring prevent_trust_escalation (20261116_trust_foundation):
--     a transporter may edit vehicle / rates on their own row, but a
--     change to verification_status raises unless the caller is
--     postgres / service_role. The UPDATE policy itself is untouched.
--  3. Finding 4 (HIGH): drop the policy "The assigned transporter
--     updates their own shipment." on public.shipments — it let the
--     assigned transporter set delivered and rewrite otp_hash /
--     otp_salt / otp_attempts with no column restriction. No
--     replacement policy: all shipment status / GPS / proof / OTP
--     writes go through backend logisticsService (service role).
--  4. Finding 5 (MEDIUM): rewrite the dispute_messages INSERT policy
--     "Dispute parties and admins can post messages." so author_role
--     is bound to the caller's real role (admin only with
--     public.is_admin(), buyer only if caller is the order buyer,
--     farmer only if caller is the order farmer) and messages cannot
--     be posted on a resolved dispute. The append-only trigger is
--     untouched.
--  5. Finding 6 (MEDIUM): rewrite the disputes INSERT policy
--     "Counterparties can file disputes." so a new dispute can only
--     be filed in the filing state: status = 'filed', resolution /
--     resolution_amount_paise / resolved_at / resolved_by all NULL,
--     escalated = false, sla_deadline in the future. Only the admin
--     resolve path can produce a resolved dispute.
--  6. Finding 11 (LOW, DB part): atomic per-user price-alert cap.
--     MAX 20 alerts per user, enforced by a BEFORE INSERT trigger on
--     public.price_alerts (a service-level count check alone is racy
--     under concurrent creates). The service-level check + DELETE
--     route + per-commodity sync batching are separate backend work.
--
-- APPLY ORDER: after all existing migrations (20261125_admin_views.sql
-- and earlier). FILE ONLY — apply in the Supabase SQL Editor.
-- ROLLBACK: forward-fix only once live — never edit this file after
-- applying.

-- ============ 1. Finding 1 — drop the re-introduced farmer orders UPDATE policy ============
DROP POLICY IF EXISTS "Farmers can update the status of their orders." ON public.orders;

-- ============ 2. Finding 3 — transporter self-verification trigger ============
-- Mirrors public.prevent_trust_escalation (20261116_trust_foundation):
-- verification_status changes only via the admin service-role flow
-- (verificationService approve path); the transporter keeps editing
-- vehicle, areas and rates on their own row through the UPDATE policy.
CREATE OR REPLACE FUNCTION public.prevent_transporter_self_verification()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.verification_status IS DISTINCT FROM NEW.verification_status THEN
    IF current_user NOT IN ('postgres', 'service_role') THEN
      RAISE EXCEPTION 'transporter verification_status is managed by the platform';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS prevent_transporter_self_verification ON public.transporters;
CREATE TRIGGER prevent_transporter_self_verification
  BEFORE UPDATE ON public.transporters
  FOR EACH ROW EXECUTE FUNCTION public.prevent_transporter_self_verification();

-- ============ 3. Finding 4 — drop the shipments UPDATE policy ============
DROP POLICY IF EXISTS "The assigned transporter updates their own shipment." ON public.shipments;

-- ============ 4. Finding 5 — dispute_messages INSERT: bind author_role, block resolved disputes ============
DROP POLICY IF EXISTS "Dispute parties and admins can post messages." ON public.dispute_messages;
CREATE POLICY "Dispute parties and admins can post messages."
  ON public.dispute_messages FOR INSERT
  WITH CHECK (
    auth.uid() = author_id
    AND EXISTS (
      SELECT 1 FROM public.disputes d
      WHERE d.id = dispute_id AND d.status <> 'resolved'
    )
    AND (
      (author_role = 'admin' AND public.is_admin())
      OR (author_role = 'buyer' AND EXISTS (
        SELECT 1 FROM public.disputes d
        JOIN public.orders o ON o.id = d.order_id
        WHERE d.id = dispute_id AND auth.uid() = o.buyer_id
      ))
      OR (author_role = 'farmer' AND EXISTS (
        SELECT 1 FROM public.disputes d
        JOIN public.orders o ON o.id = d.order_id
        WHERE d.id = dispute_id AND auth.uid() = o.farmer_id
      ))
    )
  );

-- ============ 5. Finding 6 — disputes INSERT: filing state only ============
DROP POLICY IF EXISTS "Counterparties can file disputes." ON public.disputes;
CREATE POLICY "Counterparties can file disputes."
  ON public.disputes FOR INSERT
  WITH CHECK (
    auth.uid() = filer_id
    AND (
      auth.uid() IN (SELECT buyer_id FROM public.orders WHERE id = order_id)
      OR auth.uid() IN (SELECT farmer_id FROM public.orders WHERE id = order_id)
    )
    AND status = 'filed'
    AND resolution IS NULL
    AND resolution_amount_paise IS NULL
    AND resolved_at IS NULL
    AND resolved_by IS NULL
    AND escalated = false
    AND sla_deadline > now()
  );

-- ============ 6. Finding 11 (DB part) — atomic per-user price-alert cap: MAX 20 ============
CREATE OR REPLACE FUNCTION public.enforce_price_alert_cap()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM public.price_alerts WHERE user_id = NEW.user_id) >= 20 THEN
    RAISE EXCEPTION 'ALERT_LIMIT_REACHED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS enforce_price_alert_cap ON public.price_alerts;
CREATE TRIGGER enforce_price_alert_cap BEFORE INSERT ON public.price_alerts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_price_alert_cap();
