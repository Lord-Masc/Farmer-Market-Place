-- Stage 7, module F — Dispute & Trust Management (2026-11-12):
-- disputes, dispute_evidence, dispute_messages, plus the farmer_stats
-- view rewired to real disputes.
--
-- WHAT THIS FILE DOES
--  1. disputes: one row per filed dispute. order_id FK, filer_id,
--     category (quality / quantity / non_delivery / payment), status
--     (filed / under_review / evidence_requested / resolved), SLA
--     deadline, escalated flag, resolution (refund / partial_refund /
--     replacement / rejected, NULL until resolved) + resolution_note,
--     resolution_amount_paise (integer paise, NULL unless a refund
--     outcome), replacement_order_id (FK to orders, NULL unless the
--     outcome is replacement), resolved_at / resolved_by.
--     ONE open dispute per order: partial UNIQUE index on (order_id)
--     WHERE status <> 'resolved'. A second dispute on the same order
--     is allowed only after the first is resolved (the backend
--     returns 409 for the open case; this index is the race backstop).
--     There is deliberately NO description column: the filing text is
--     stored as the first dispute_messages row (the thread IS the
--     complaint), so the contract shape needs no extra field.
--  2. dispute_evidence: storage refs (storage_path is a
--     'dispute-evidence/<uid>-<uuid>.<ext>' path in the PRIVATE
--     bucket, section 5) + uploader. Served only via 5-minute signed
--     URLs minted by the backend for the two counterparties + admin.
--  3. dispute_messages: append-only thread (author_id, author_role
--     buyer/farmer/admin, body). No UPDATE/DELETE policies, and a
--     trigger raises on UPDATE/DELETE — history is never rewritten
--     (same pattern as Stage 6 shipment_events).
--  4. farmer_stats: CREATE OR REPLACE VIEW. The old refund-flow
--     `dispute_rate` CASE is kept BYTE-FOR-BYTE but renamed to
--     `refund_rate` (labelled "Refund rate" in the UI) — history is
--     NOT relabelled: orders completed before disputes existed keep
--     the refund-flow basis for refund_rate, while `dispute_rate` is
--     now the REAL-dispute source going forward (real disputes for
--     the farmer's orders / total orders, NULL when the farmer has
--     no orders), alongside the new `dispute_count` (integer). The
--     passport display reads BOTH columns (Unit B's job — the
--     existing pages read `stats.dispute_rate` under the "Refund
--     rate" label today and must switch that label to `refund_rate`
--     when this migration lands, and render `dispute_rate` /
--     `dispute_count` as the real dispute figures).
--  5. STORAGE — DASHBOARD STEP (do NOT attempt in SQL; bucket creation
--     is not SQL): before go-live, create the PRIVATE
--     'dispute-evidence' bucket in the Supabase Dashboard (Storage
--     -> New bucket -> 'dispute-evidence', Public OFF, NO policies)
--     — same pattern as Stage 2's 'verification-docs' and Stage 6's
--     'delivery-proofs' buckets. Only the service-role client can
--     read it; evidence photos are served via 5-minute signed URLs
--     (GET /api/disputes/:id). The backend answers 503 (not a crash)
--     when the bucket does not exist yet.
--
-- SLA: sla_deadline = created_at + 7 days (DISPUTE_SLA_DAYS = 7 in
-- backend/services/disputeService.js). Breach sets escalated = true
-- via checkSlaBreaches() (hourly reconciler pattern, Stage 0) and
-- via the live is_overdue computation on read — a breach NEVER
-- auto-resolves a dispute.
--
-- APPLY ORDER: after 20261116_trust_foundation.sql (it defines
-- is_admin()) and 20261117_crop_passport.sql (it defines
-- farmer_stats). FILE ONLY — apply in the Supabase SQL Editor.
-- Never run by this stage.
-- Rollback: DROP VIEW public.farmer_stats; re-create it from
-- 20261117_crop_passport.sql (the refund-flow `dispute_rate`
-- version); DROP TABLE public.dispute_messages;
-- DROP TABLE public.dispute_evidence; DROP TABLE public.disputes;
-- DROP FUNCTION public.prevent_dispute_message_change(); delete the
-- 'dispute-evidence' bucket in the Dashboard
-- (see docs/ai/ROLLBACK.md, Stage 7).

-- ============ 1. disputes ============
CREATE TABLE IF NOT EXISTS public.disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  filer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category text NOT NULL
    CHECK (category IN ('quality', 'quantity', 'non_delivery', 'payment')),
  status text NOT NULL DEFAULT 'filed'
    CHECK (status IN ('filed', 'under_review', 'evidence_requested', 'resolved')),
  sla_deadline timestamptz NOT NULL,
  escalated boolean NOT NULL DEFAULT false,
  resolution text
    CHECK (resolution IS NULL OR resolution IN ('refund', 'partial_refund', 'replacement', 'rejected')),
  resolution_note text,
  resolution_amount_paise integer CHECK (resolution_amount_paise IS NULL OR resolution_amount_paise > 0),
  replacement_order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One OPEN dispute per order (resolved disputes do not block a new filing).
CREATE UNIQUE INDEX IF NOT EXISTS disputes_one_open_idx
  ON public.disputes (order_id) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS disputes_order_id_idx ON public.disputes (order_id);
CREATE INDEX IF NOT EXISTS disputes_status_idx ON public.disputes (status);
CREATE INDEX IF NOT EXISTS disputes_sla_deadline_idx ON public.disputes (sla_deadline);

ALTER TABLE public.disputes ENABLE ROW LEVEL SECURITY;

-- Only the two counterparties (buyer + farmer of the order) and admins
-- may read a dispute. No anon access.
DROP POLICY IF EXISTS "Order parties and admins can view disputes." ON public.disputes;
CREATE POLICY "Order parties and admins can view disputes."
  ON public.disputes FOR SELECT
  USING (
    public.is_admin()
    OR auth.uid() IN (SELECT buyer_id FROM public.orders WHERE id = order_id)
    OR auth.uid() IN (SELECT farmer_id FROM public.orders WHERE id = order_id)
  );

-- A counterparty files their own dispute (filer_id must be the caller).
DROP POLICY IF EXISTS "Counterparties can file disputes." ON public.disputes;
CREATE POLICY "Counterparties can file disputes."
  ON public.disputes FOR INSERT
  WITH CHECK (
    auth.uid() = filer_id
    AND (
      auth.uid() IN (SELECT buyer_id FROM public.orders WHERE id = order_id)
      OR auth.uid() IN (SELECT farmer_id FROM public.orders WHERE id = order_id)
    )
  );

-- Only admins resolve / transition disputes (the backend enforces this
-- too — RLS alone is not the check). No DELETE policy by design.
DROP POLICY IF EXISTS "Admins can update disputes." ON public.disputes;
CREATE POLICY "Admins can update disputes."
  ON public.disputes FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ============ 2. dispute_evidence ============
CREATE TABLE IF NOT EXISTS public.dispute_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id uuid NOT NULL REFERENCES public.disputes(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dispute_evidence_dispute_id_idx
  ON public.dispute_evidence (dispute_id, created_at);

ALTER TABLE public.dispute_evidence ENABLE ROW LEVEL SECURITY;

-- Same party check as disputes (via the parent dispute's order).
DROP POLICY IF EXISTS "Dispute parties and admins can view evidence." ON public.dispute_evidence;
CREATE POLICY "Dispute parties and admins can view evidence."
  ON public.dispute_evidence FOR SELECT
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.disputes d
      JOIN public.orders o ON o.id = d.order_id
      WHERE d.id = dispute_id
        AND (auth.uid() = o.buyer_id OR auth.uid() = o.farmer_id)
    )
  );

-- A counterparty (or admin) attaches evidence as themselves.
DROP POLICY IF EXISTS "Dispute parties and admins can add evidence." ON public.dispute_evidence;
CREATE POLICY "Dispute parties and admins can add evidence."
  ON public.dispute_evidence FOR INSERT
  WITH CHECK (
    auth.uid() = uploaded_by
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.disputes d
        JOIN public.orders o ON o.id = d.order_id
        WHERE d.id = dispute_id
          AND (auth.uid() = o.buyer_id OR auth.uid() = o.farmer_id)
      )
    )
  );

-- No UPDATE/DELETE policy by design: evidence is never edited or removed
-- through the API.

-- ============ 3. dispute_messages (append-only) ============
CREATE TABLE IF NOT EXISTS public.dispute_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id uuid NOT NULL REFERENCES public.disputes(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  author_role text NOT NULL CHECK (author_role IN ('buyer', 'farmer', 'admin')),
  body text NOT NULL CHECK (char_length(body) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dispute_messages_dispute_id_idx
  ON public.dispute_messages (dispute_id, created_at);

ALTER TABLE public.dispute_messages ENABLE ROW LEVEL SECURITY;

-- Same party check as disputes (via the parent dispute's order).
DROP POLICY IF EXISTS "Dispute parties and admins can view messages." ON public.dispute_messages;
CREATE POLICY "Dispute parties and admins can view messages."
  ON public.dispute_messages FOR SELECT
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.disputes d
      JOIN public.orders o ON o.id = d.order_id
      WHERE d.id = dispute_id
        AND (auth.uid() = o.buyer_id OR auth.uid() = o.farmer_id)
    )
  );

-- A counterparty (or admin) writes as themselves.
DROP POLICY IF EXISTS "Dispute parties and admins can post messages." ON public.dispute_messages;
CREATE POLICY "Dispute parties and admins can post messages."
  ON public.dispute_messages FOR INSERT
  WITH CHECK (
    auth.uid() = author_id
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.disputes d
        JOIN public.orders o ON o.id = d.order_id
        WHERE d.id = dispute_id
          AND (auth.uid() = o.buyer_id OR auth.uid() = o.farmer_id)
      )
    )
  );

-- No UPDATE/DELETE policy by design, and the trigger below raises on
-- any UPDATE/DELETE — the thread is append-only even for the service role.

CREATE OR REPLACE FUNCTION public.prevent_dispute_message_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'dispute_messages is append-only';
END;
$$;

DROP TRIGGER IF EXISTS prevent_dispute_message_change ON public.dispute_messages;
CREATE TRIGGER prevent_dispute_message_change
  BEFORE UPDATE OR DELETE ON public.dispute_messages
  FOR EACH ROW EXECUTE FUNCTION public.prevent_dispute_message_change();

-- ============ 4. farmer_stats: real dispute figures ============
-- The refund-flow CASE below is byte-identical to the 20261117
-- `dispute_rate` definition, only renamed to `refund_rate`.
-- `dispute_rate` is now real disputes / total orders, and
-- `dispute_count` is the real dispute count for the farmer's orders.
-- Postgres cannot rename a view column via CREATE OR REPLACE VIEW
-- (42P16: cannot change name of view column "dispute_rate" to
-- "refund_rate") — drop first, then create fresh. The view is a leaf
-- (read only by the backend service role); DROP + CREATE is idempotent.
DROP VIEW IF EXISTS public.farmer_stats;
CREATE VIEW public.farmer_stats AS
SELECT
  orders.farmer_id,
  COUNT(*)::bigint AS total_orders,
  COUNT(*) FILTER (WHERE status IN ('DELIVERED', 'COMPLETED'))::bigint AS deliveries,
  CASE
    WHEN COUNT(*) FILTER (
      WHERE status IN ('DELIVERED', 'COMPLETED')
        AND delivery_deadline IS NOT NULL
        AND completed_at IS NOT NULL
    ) = 0 THEN NULL
    ELSE (
      COUNT(*) FILTER (
        WHERE status IN ('DELIVERED', 'COMPLETED')
          AND delivery_deadline IS NOT NULL
          AND completed_at IS NOT NULL
          AND completed_at <= delivery_deadline
      )::double precision
      / COUNT(*) FILTER (
        WHERE status IN ('DELIVERED', 'COMPLETED')
          AND delivery_deadline IS NOT NULL
          AND completed_at IS NOT NULL
      )
    )
  END AS on_time_rate,
  CASE
    WHEN COUNT(*) FILTER (
      WHERE status IN (
        'PAID', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'REFUNDED',
        'REFUND_PENDING', 'REFUND_PROCESSING', 'REFUND_FAILED', 'REFUND_RECONCILE'
      )
    ) = 0 THEN NULL
    ELSE (
      COUNT(*) FILTER (
        WHERE status IN ('REFUNDED', 'REFUND_PENDING', 'REFUND_PROCESSING')
      )::double precision
      / COUNT(*) FILTER (
        WHERE status IN (
          'PAID', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'REFUNDED',
          'REFUND_PENDING', 'REFUND_PROCESSING', 'REFUND_FAILED', 'REFUND_RECONCILE'
        )
      )
    )
  END AS refund_rate,
  COALESCE(dc.dispute_count, 0)::bigint AS dispute_count,
  CASE
    WHEN COUNT(*) = 0 THEN NULL
    ELSE COALESCE(dc.dispute_count, 0)::double precision / COUNT(*)
  END AS dispute_rate
FROM public.orders
LEFT JOIN (
  SELECT o.farmer_id, COUNT(*)::bigint AS dispute_count
  FROM public.disputes d
  JOIN public.orders o ON o.id = d.order_id
  GROUP BY o.farmer_id
) dc ON dc.farmer_id = orders.farmer_id
GROUP BY orders.farmer_id, dc.dispute_count;

-- Aggregate stats only: no lot or personal data, and readable only via the
-- backend (service role), which enforces the verified-farmer gate.
REVOKE ALL ON public.farmer_stats FROM anon, authenticated;
GRANT SELECT ON public.farmer_stats TO service_role;
