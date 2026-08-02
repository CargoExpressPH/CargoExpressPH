-- Sync email changes from auth.users into public.profiles.
-- The `profiles.email` column is the app's single source of truth, but the
-- actual email lives in Supabase Auth. When a user changes their email via
-- supabase.auth.updateUser() and confirms it, the auth.users.email column is
-- updated — this trigger keeps profiles.email in sync automatically,
-- regardless of which device/browser confirmed the change.

CREATE OR REPLACE FUNCTION public.sync_auth_email_to_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.profiles
    SET email = NEW.email,
        updated_at = NOW()
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_email_change ON auth.users;
CREATE TRIGGER on_auth_user_email_change
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.sync_auth_email_to_profile();
