-- 20261109_profile_signup_trigger.sql
-- Fix: new-user signup failed with 'new row violates row-level security
-- policy for table "profiles"' (found live 2026-11-08).
-- Root cause: SignUp.jsx inserted the profile row immediately after
-- supabase.auth.signUp(). When email confirmation is on, there is no
-- session yet, so auth.uid() is NULL and the INSERT policy
-- (WITH CHECK auth.uid() = id) rejects the row.
-- Fix: create the profile row in a SECURITY DEFINER trigger on
-- auth.users, which runs as the function owner and bypasses RLS.
-- SignUp.jsx now passes the profile fields as user_metadata and no
-- longer inserts the profile directly.
-- Apply: paste in the Supabase SQL Editor (project prrshenqceqijkfapthl,
-- 14426 account). Idempotent: safe to re-run.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (
    id, first_name, last_name, email_address, phone_number, role, state
  ) VALUES (
    NEW.id,
    COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'first_name', ''), ''),
    COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'last_name', ''), ''),
    NEW.email,
    COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'phone_number', ''), ''),
    CASE WHEN NEW.raw_user_meta_data ->> 'role' = 'farmer' THEN 'farmer' ELSE 'buyer' END,
    NULLIF(NEW.raw_user_meta_data ->> 'state', '')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block auth signup because the profile insert failed; the
  -- failure is logged (Postgres log) so it can be fixed, and the
  -- profile can be backfilled. The normal path (correct metadata)
  -- always creates the profile.
  RAISE WARNING 'handle_new_user failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
