-- Stage 1, trust foundation (2026-11-12): verification status on profiles,
-- an admin role, and the verification-submissions table with RLS.
--
-- FIRST-ADMIN BOOTSTRAP (human step, run in the Supabase SQL Editor after
-- this file is applied — there is no admin user until it runs; admin routes
-- simply 403 until then):
--   UPDATE public.profiles SET role = 'admin' WHERE id = '<admin-user-uuid>';
-- Use Rishabh's own user UUID (from auth.users / the profiles table). The
-- system works with zero admins until this runs (review queue empty,
-- admin routes 403). Never guess or hardcode a UUID here.
--
-- WHAT THIS FILE DOES
--  1. profiles.verification_status ('unverified' | 'pending' | 'verified' |
--     'rejected', default 'unverified') + verified_at + verified_by.
--  2. profiles.role CHECK widened to ('buyer', 'farmer', 'admin'). The old
--     check is dropped by name lookup, so the file is safe to re-run.
--  3. A BEFORE UPDATE trigger blocks direct PostgREST self-promotion of the
--     trust fields (role, verification_status, verified_at, verified_by):
--     only the backend (service role) and the SQL Editor (postgres) may
--     change them. This is what stops the M1 regression (role changed via
--     PostgREST) — the Stage 0 WITH CHECK policy alone cannot compare the
--     old row with the new row, so a trigger is the enforcement point.
--  4. verification_submissions: one row per verification attempt; a partial
--     unique index allows at most one 'pending' submission per farmer.
--  5. RLS: a farmer reads/inserts only their own submissions; an admin
--     reads all (via the is_admin() helper); no anon access; nobody updates
--     submissions through PostgREST — approve/reject go through the backend
--     (service role), which is also what writes profiles trust fields.
--  6. Storage policies extended for the new verification-docs/ prefix
--     (verification documents upload through the hardened backend endpoint;
--     the policies are the second layer for direct browser access).
--
-- FILE ONLY — apply in the Supabase SQL Editor, after the Stage 0 files
-- (20261115_*.sql), in order. Never run by this stage.
-- Rollback: DROP TABLE public.verification_submissions; DROP FUNCTION
-- public.is_admin(); DROP TRIGGER prevent_trust_escalation ON public.profiles;
-- DROP FUNCTION public.prevent_trust_escalation(); ALTER TABLE public.profiles
-- DROP COLUMN verification_status, DROP COLUMN verified_at,
-- DROP COLUMN verified_by; re-create the old role CHECK (buyer/farmer only);
-- drop the verification-docs branches from the three storage policies
-- (see docs/ai/ROLLBACK.md, Stage 1).

-- ============ 1. profiles: verification columns ============
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS verification_status text
    CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected'))
    NOT NULL DEFAULT 'unverified';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS verified_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS verified_by uuid REFERENCES public.profiles(id);

-- ============ 2. profiles.role: allow 'admin' ============
-- Drop the old buyer/farmer-only CHECK by definition lookup (the base
-- schema gave it no explicit name, so Postgres auto-named it). The new
-- CHECK is named, so a re-run of this file leaves it alone.
DO $$
DECLARE _con text;
BEGIN
  SELECT conname INTO _con FROM pg_constraint
  WHERE conrelid = 'public.profiles'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%buyer%'
    AND pg_get_constraintdef(oid) LIKE '%farmer%'
    AND pg_get_constraintdef(oid) NOT LIKE '%admin%';
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
      ADD CONSTRAINT profiles_role_check CHECK (role IN ('buyer', 'farmer', 'admin'));
  END IF;
END $$;

-- ============ 3. Trust-field escalation guard ============
-- PostgREST connects JWT callers as 'authenticated' and the service-role
-- key as 'service_role'; the SQL Editor connects as 'postgres'. A trigger
-- is the only place that can compare the old row with the new row, so it
-- is where self-promotion is stopped.
CREATE OR REPLACE FUNCTION public.prevent_trust_escalation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role IS DISTINCT FROM NEW.role
     OR OLD.verification_status IS DISTINCT FROM NEW.verification_status
     OR OLD.verified_at IS DISTINCT FROM NEW.verified_at
     OR OLD.verified_by IS DISTINCT FROM NEW.verified_by THEN
    IF current_user NOT IN ('postgres', 'service_role') THEN
      RAISE EXCEPTION 'trust fields are managed by the platform';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS prevent_trust_escalation ON public.profiles;
CREATE TRIGGER prevent_trust_escalation
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_trust_escalation();

-- ============ 4. verification_submissions ============
CREATE TABLE IF NOT EXISTS public.verification_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  document_path text NOT NULL,
  status text CHECK (status IN ('pending', 'approved', 'rejected')) NOT NULL DEFAULT 'pending',
  review_note text,
  reviewed_by uuid REFERENCES public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.verification_submissions ENABLE ROW LEVEL SECURITY;

-- At most one pending submission per farmer (race-free; the backend also
-- checks, but the index is the enforcement point).
CREATE UNIQUE INDEX IF NOT EXISTS verification_submissions_one_pending_idx
  ON public.verification_submissions (farmer_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS verification_submissions_status_created_idx
  ON public.verification_submissions (status, created_at DESC);

-- ============ 5. RLS: farmer owns, admin reads all, no anon ============
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  );
$$;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, anon;

DROP POLICY IF EXISTS "Farmers can view their own submissions." ON public.verification_submissions;
CREATE POLICY "Farmers can view their own submissions."
  ON public.verification_submissions FOR SELECT
  USING (auth.uid() = farmer_id OR public.is_admin());

DROP POLICY IF EXISTS "Farmers can submit their own verification." ON public.verification_submissions;
CREATE POLICY "Farmers can submit their own verification."
  ON public.verification_submissions FOR INSERT
  WITH CHECK (auth.uid() = farmer_id AND status = 'pending');

-- No UPDATE/DELETE policy by design: approve/reject go through the backend
-- (service role), never through PostgREST.

-- ============ 6. Storage policies: verification-docs/ prefix ============
-- Same owner-prefix rule as the existing product/profile paths, extended
-- for verification documents (backend endpoint uploads them; these
-- policies are the second layer for direct browser access).
DROP POLICY IF EXISTS "Owners can upload their own product-images." ON storage.objects;
CREATE POLICY "Owners can upload their own product-images."
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'product-images'
    AND (
      name LIKE 'product-items/' || auth.uid()::text || '-%'
      OR name LIKE 'profile-' || auth.uid()::text || '-%'
      OR name LIKE 'verification-docs/' || auth.uid()::text || '-%'
    )
  );

DROP POLICY IF EXISTS "Owners can update their own product-images." ON storage.objects;
CREATE POLICY "Owners can update their own product-images."
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'product-images'
    AND (
      name LIKE 'product-items/' || auth.uid()::text || '-%'
      OR name LIKE 'profile-' || auth.uid()::text || '-%'
      OR name LIKE 'verification-docs/' || auth.uid()::text || '-%'
    )
  )
  WITH CHECK (
    bucket_id = 'product-images'
    AND (
      name LIKE 'product-items/' || auth.uid()::text || '-%'
      OR name LIKE 'profile-' || auth.uid()::text || '-%'
      OR name LIKE 'verification-docs/' || auth.uid()::text || '-%'
    )
  );

DROP POLICY IF EXISTS "Owners can delete their own product-images." ON storage.objects;
CREATE POLICY "Owners can delete their own product-images."
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'product-images'
    AND (
      name LIKE 'product-items/' || auth.uid()::text || '-%'
      OR name LIKE 'profile-' || auth.uid()::text || '-%'
      OR name LIKE 'verification-docs/' || auth.uid()::text || '-%'
    )
  );
