-- Stage 0, unit 6: append-only audit log for security events.
-- No policies at all, on purpose: RLS is ON and anon/authenticated get
-- nothing — only the service role (which bypasses RLS) inserts rows, and
-- there is deliberately NO UPDATE or DELETE policy, so rows can never be
-- modified or removed through the API. Wiring insert calls for security
-- events (failed auth, refunds, role changes) is a Stage 1 follow-up; this
-- file only creates the table.
-- FILE ONLY — apply in the Supabase SQL Editor; never run by this stage.
-- Rollback: DROP TABLE public.audit_log (see docs/ai/ROLLBACK.md, unit 6).

CREATE TABLE IF NOT EXISTS public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid,
  event text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS audit_log_event_created_idx
  ON public.audit_log (event, created_at DESC);
