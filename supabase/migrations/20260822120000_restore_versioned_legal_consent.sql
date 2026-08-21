-- ============================================================================
-- Versioned legal documents and immutable registration consent
-- ============================================================================
-- This replaces the reverted 20260822100000 migration with a stricter model:
-- the auth trigger accepts only the current, server-published versions and
-- writes the evidence atomically with account creation. Browser code cannot
-- insert, alter, or delete consent records.

CREATE TABLE IF NOT EXISTS public.legal_documents (
  document_type TEXT NOT NULL CHECK (document_type IN ('terms_of_service', 'privacy_policy')),
  version TEXT NOT NULL CHECK (length(trim(version)) > 0),
  url_path TEXT NOT NULL CHECK (url_path IN ('/terms', '/privacy')),
  effective_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_current BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (document_type, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS legal_documents_one_current_version
  ON public.legal_documents (document_type)
  WHERE is_current;

-- The document body is intentionally published in the version-controlled web
-- application. These rows are the authoritative server-side version registry
-- used to validate consent during signup.
UPDATE public.legal_documents
SET is_current = false
WHERE document_type IN ('terms_of_service', 'privacy_policy')
  AND is_current = true;

INSERT INTO public.legal_documents (document_type, version, url_path, effective_at, is_current)
VALUES
  ('terms_of_service', '2026-08-22', '/terms', '2026-08-22T00:00:00+08:00', true),
  ('privacy_policy', '2026-08-22', '/privacy', '2026-08-22T00:00:00+08:00', true)
ON CONFLICT (document_type, version) DO UPDATE
  SET url_path = EXCLUDED.url_path,
      effective_at = EXCLUDED.effective_at,
      is_current = EXCLUDED.is_current;

CREATE TABLE IF NOT EXISTS public.legal_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('terms_of_service', 'privacy_policy')),
  document_version TEXT NOT NULL CHECK (length(trim(document_version)) > 0),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'registration' CHECK (source IN ('registration', 'account_update')),
  CONSTRAINT legal_consents_document_version_fk
    FOREIGN KEY (document_type, document_version)
    REFERENCES public.legal_documents (document_type, version),
  CONSTRAINT legal_consents_one_acceptance_per_version
    UNIQUE (user_id, document_type, document_version)
);

CREATE INDEX IF NOT EXISTS idx_legal_consents_user_accepted
  ON public.legal_consents (user_id, accepted_at DESC);

ALTER TABLE public.legal_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legal_consents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Published legal documents are public" ON public.legal_documents;
CREATE POLICY "Published legal documents are public" ON public.legal_documents
  FOR SELECT
  TO anon, authenticated
  USING (is_current);

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

-- No write privileges or RLS write policies are granted. The auth trigger is
-- SECURITY DEFINER and is therefore the sole normal writer of consent evidence.
REVOKE ALL ON TABLE public.legal_documents FROM anon, authenticated;
REVOKE ALL ON TABLE public.legal_consents FROM anon, authenticated;
GRANT SELECT ON TABLE public.legal_documents TO anon, authenticated;
GRANT SELECT ON TABLE public.legal_consents TO authenticated;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_terms_version TEXT;
  v_privacy_version TEXT;
  v_requested_version TEXT;
BEGIN
  SELECT version INTO v_terms_version
  FROM public.legal_documents
  WHERE document_type = 'terms_of_service' AND is_current = true;

  SELECT version INTO v_privacy_version
  FROM public.legal_documents
  WHERE document_type = 'privacy_policy' AND is_current = true;

  v_requested_version := NULLIF(trim(NEW.raw_user_meta_data->>'legal_policy_version'), '');

  IF v_terms_version IS NULL OR v_privacy_version IS NULL THEN
    RAISE EXCEPTION 'Account creation is temporarily unavailable because legal documents are not published.'
      USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(NEW.raw_user_meta_data->>'legal_terms_accepted', 'false') <> 'true'
     OR COALESCE(NEW.raw_user_meta_data->>'legal_privacy_accepted', 'false') <> 'true'
     OR v_requested_version IS DISTINCT FROM v_terms_version
     OR v_requested_version IS DISTINCT FROM v_privacy_version THEN
    RAISE EXCEPTION 'The current Terms of Service and Privacy Policy must be accepted to create an account.'
      USING ERRCODE = '22023';
  END IF;

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

  INSERT INTO public.legal_consents (user_id, document_type, document_version, source)
  VALUES
    (NEW.id, 'terms_of_service', v_terms_version, 'registration'),
    (NEW.id, 'privacy_policy', v_privacy_version, 'registration');

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
