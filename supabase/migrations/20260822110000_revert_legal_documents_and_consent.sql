-- ============================================================================
-- Revert legal documents and registration-consent tracking
-- ============================================================================
-- The original legal migration remains in migration history because it may
-- already have been applied to hosted environments. This compensating
-- migration removes its live schema objects and restores the prior signup
-- profile trigger behavior.

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (id, email, name, role, created_at, updated_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NULLIF(NEW.raw_user_meta_data->>'name', ''), initcap(split_part(NEW.email, '@', 1))),
    'customer',
    now(),
    now()
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

DROP TABLE IF EXISTS public.legal_consents;
