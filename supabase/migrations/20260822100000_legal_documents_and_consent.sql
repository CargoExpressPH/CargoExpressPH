-- ============================================================================
-- Legal documents and immutable registration consent
-- ============================================================================
-- The web client publishes the current document version and acceptance flags
-- in auth.users.raw_user_meta_data during sign-up. This trigger records the
-- event server-side so the audit does not depend on a second browser write.

CREATE TABLE IF NOT EXISTS public.legal_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('terms_of_service', 'privacy_policy')),
  document_version TEXT NOT NULL CHECK (length(trim(document_version)) > 0),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'registration' CHECK (source IN ('registration', 'account_update')),
  UNIQUE (user_id, document_type, document_version)
);

CREATE INDEX IF NOT EXISTS idx_legal_consents_user_accepted
  ON public.legal_consents (user_id, accepted_at DESC);

ALTER TABLE public.legal_consents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own legal consents" ON public.legal_consents;
CREATE POLICY "Users can view own legal consents" ON public.legal_consents
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Admins can view legal consents" ON public.legal_consents;
CREATE POLICY "Admins can view legal consents" ON public.legal_consents
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- Consent rows are append-only and are written by the auth trigger below.
-- There are deliberately no client INSERT, UPDATE, or DELETE policies.
GRANT SELECT ON TABLE public.legal_consents TO authenticated;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_policy_version TEXT;
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

  v_policy_version := NULLIF(trim(NEW.raw_user_meta_data->>'legal_policy_version'), '');

  IF v_policy_version IS NOT NULL
     AND COALESCE(NEW.raw_user_meta_data->>'legal_terms_accepted', 'false') = 'true'
     AND COALESCE(NEW.raw_user_meta_data->>'legal_privacy_accepted', 'false') = 'true' THEN
    INSERT INTO public.legal_consents (user_id, document_type, document_version, source)
    VALUES
      (NEW.id, 'terms_of_service', v_policy_version, 'registration'),
      (NEW.id, 'privacy_policy', v_policy_version, 'registration')
    ON CONFLICT (user_id, document_type, document_version) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$function$;

-- Supabase projects commonly use this trigger name. Recreating it makes the
-- consent guarantee explicit and keeps fresh environments aligned with live
-- environments where the trigger may previously have been dashboard-created.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
