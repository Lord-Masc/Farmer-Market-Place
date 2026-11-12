-- Stage 0, unit 6 (M1): profiles UPDATE was USING-only — a user could rewrite
-- their own row so the *result* no longer belongs to them (e.g. SET id to
-- another user's id, or escalate their own role). WITH CHECK forces the
-- updated row to still satisfy auth.uid() = id.
-- FILE ONLY — apply in the Supabase SQL Editor; never run by this stage.
-- Rollback: re-create the policy without the WITH CHECK clause (see
-- docs/ai/ROLLBACK.md, unit 6).

DROP POLICY IF EXISTS "Users can update own profile." ON public.profiles;
CREATE POLICY "Users can update own profile."
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);
