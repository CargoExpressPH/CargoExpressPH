-- Email confirmation for sign-ups: signUp() no longer returns a session until
-- the customer clicks the link in their inbox, so the browser can no longer
-- write the profile details (phone, address, ...) itself right after signUp.
-- RegisterPage now sends them as user metadata and this trigger saves them in
-- the same transaction that creates the account.
--
-- Unchanged from the previous definition: the legal-consent checks, the base
-- profile row and the consent records. New: the detail UPDATE, which runs in
-- its own sub-block so a bad optional value (say, an over-long address) is
-- logged and skipped instead of failing the whole sign-up.
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
  v_meta JSONB := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
BEGIN
  SELECT version INTO v_terms_version
  FROM public.legal_documents
  WHERE document_type = 'terms_of_service' AND is_current = true;

  SELECT version INTO v_privacy_version
  FROM public.legal_documents
  WHERE document_type = 'privacy_policy' AND is_current = true;

  v_requested_terms_version := NULLIF(trim(v_meta->>'legal_terms_version'), '');
  v_requested_privacy_version := NULLIF(trim(v_meta->>'legal_privacy_version'), '');

  IF v_terms_version IS NULL OR v_privacy_version IS NULL THEN
    RAISE EXCEPTION 'Account creation is temporarily unavailable because legal documents are not published.'
      USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(v_meta->>'legal_terms_accepted', 'false') <> 'true'
     OR COALESCE(v_meta->>'legal_privacy_accepted', 'false') <> 'true'
     OR v_requested_terms_version IS DISTINCT FROM v_terms_version
     OR v_requested_privacy_version IS DISTINCT FROM v_privacy_version THEN
    RAISE EXCEPTION 'The current Terms of Service and Privacy Policy must be accepted to create an account.'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.profiles (id, email, name, role, created_at, updated_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NULLIF(v_meta->>'name', ''), initcap(split_part(NEW.email, '@', 1))),
    'customer',
    now(),
    now()
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.legal_consents (user_id, document_type, document_version, source)
  VALUES
    (NEW.id, 'terms_of_service', v_terms_version, 'registration'),
    (NEW.id, 'privacy_policy', v_privacy_version, 'registration');

  -- Registration details. Only keys that were sent are written, so an older
  -- client that still saves them itself after signUp keeps working.
  BEGIN
    UPDATE public.profiles SET
      phone             = COALESCE(NULLIF(btrim(v_meta->>'phone'), ''), phone),
      facebook_name     = COALESCE(NULLIF(btrim(v_meta->>'facebook_name'), ''), facebook_name),
      address_province  = COALESCE(NULLIF(btrim(v_meta->>'address_province'), ''), address_province),
      address_city      = COALESCE(NULLIF(btrim(v_meta->>'address_city'), ''), address_city),
      address_barangay  = COALESCE(NULLIF(btrim(v_meta->>'address_barangay'), ''), address_barangay),
      address_street    = COALESCE(NULLIF(btrim(v_meta->>'address_street'), ''), address_street),
      address_lot_block = COALESCE(NULLIF(btrim(v_meta->>'address_lot_block'), ''), address_lot_block),
      address_landmark  = COALESCE(NULLIF(btrim(v_meta->>'address_landmark'), ''), address_landmark),
      wants_announcements = CASE
        WHEN v_meta ? 'wants_announcements' THEN COALESCE((v_meta->>'wants_announcements')::boolean, false)
        ELSE wants_announcements
      END,
      updated_at = now()
    WHERE id = NEW.id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'handle_new_user: registration details not saved for %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$function$;
