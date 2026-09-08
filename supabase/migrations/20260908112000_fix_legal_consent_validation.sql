-- Fix handle_new_user trigger to validate legal versions independently
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_terms_version TEXT;
  v_privacy_version TEXT;
  v_requested_terms_version TEXT;
  v_requested_privacy_version TEXT;
BEGIN
  SELECT version INTO v_terms_version
  FROM public.legal_documents
  WHERE document_type = 'terms_of_service' AND is_current = true;

  SELECT version INTO v_privacy_version
  FROM public.legal_documents
  WHERE document_type = 'privacy_policy' AND is_current = true;

  v_requested_terms_version := NULLIF(trim(NEW.raw_user_meta_data->>'legal_terms_version'), '');
  v_requested_privacy_version := NULLIF(trim(NEW.raw_user_meta_data->>'legal_privacy_version'), '');

  IF v_terms_version IS NULL OR v_privacy_version IS NULL THEN
    RAISE EXCEPTION 'Account creation is temporarily unavailable because legal documents are not published.'
      USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(NEW.raw_user_meta_data->>'legal_terms_accepted', 'false') <> 'true'
     OR COALESCE(NEW.raw_user_meta_data->>'legal_privacy_accepted', 'false') <> 'true'
     OR v_requested_terms_version IS DISTINCT FROM v_terms_version
     OR v_requested_privacy_version IS DISTINCT FROM v_privacy_version THEN
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
