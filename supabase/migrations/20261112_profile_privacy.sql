-- Protect private profile fields while keeping a small public farmer directory.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS buyer_name text;

DROP POLICY IF EXISTS "Public profiles are viewable by everyone." ON public.profiles;
DROP POLICY IF EXISTS "Users can view own profile." ON public.profiles;
CREATE POLICY "Users can view own profile."
  ON public.profiles FOR SELECT USING (auth.uid() = id);

CREATE OR REPLACE VIEW public.public_farmer_profiles WITH (security_invoker = false) AS
SELECT id, first_name, last_name, role, state, city, phone_number, photo_url
FROM public.profiles
WHERE role = 'farmer';
-- security_invoker = false (Postgres 15+): the view runs as its owner, so the
-- own-profile-only RLS policy on profiles does not make the directory empty.
-- Without it the view would return 0 rows to every buyer (audit F1).
GRANT SELECT ON public.public_farmer_profiles TO authenticated;

-- Signup trigger: create the private profile from verified Auth user metadata.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.profiles (id, first_name, last_name, email_address, phone_number, role, state)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'first_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'last_name', ''),
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'phone_number', ''),
    CASE WHEN NEW.raw_user_meta_data->>'role' IN ('buyer', 'farmer')
      THEN NEW.raw_user_meta_data->>'role' ELSE 'buyer' END,
    NEW.raw_user_meta_data->>'state'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block auth signup because the profile insert failed; the
  -- failure is logged (Postgres log) so it can be fixed, and the
  -- profile can be backfilled. The normal path (correct metadata)
  -- always creates the profile. (Restored — audit F2; the 20261109
  -- version of this trigger had this block.)
  RAISE WARNING 'handle_new_user failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
