-- Fix "column reference upload_mode is ambiguous" in set_photo_storage_mode().
-- The RETURNS TABLE(upload_mode TEXT, ...) output columns clash with bare column
-- references to photo_storage_settings.upload_mode. Qualify with table alias.
BEGIN;

CREATE OR REPLACE FUNCTION public.set_photo_storage_mode(
  p_upload_mode TEXT,
  p_reason TEXT DEFAULT NULL,
  p_force_firebase_expires_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE(upload_mode TEXT, force_firebase_expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, updated_by UUID, reason TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_previous_mode TEXT;
  v_settings public.photo_storage_settings%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;
  IF p_upload_mode NOT IN ('automatic', 'force_firebase') THEN
    RAISE EXCEPTION 'Invalid upload mode' USING ERRCODE = '22023';
  END IF;
  IF char_length(COALESCE(p_reason, '')) > 500 THEN
    RAISE EXCEPTION 'Reason is too long' USING ERRCODE = '22001';
  END IF;
  IF p_upload_mode = 'force_firebase' THEN
    IF p_force_firebase_expires_at IS NULL
       OR p_force_firebase_expires_at <= now()
       OR p_force_firebase_expires_at > now() + INTERVAL '24 hours' THEN
      RAISE EXCEPTION 'Force Firebase expiry must be within the next 24 hours' USING ERRCODE = '22023';
    END IF;
  ELSE
    p_force_firebase_expires_at := NULL;
  END IF;

  SELECT pss.upload_mode INTO v_previous_mode
    FROM public.photo_storage_settings pss WHERE pss.id = TRUE FOR UPDATE;

  UPDATE public.photo_storage_settings
     SET upload_mode = p_upload_mode,
         force_firebase_expires_at = p_force_firebase_expires_at,
         reason = NULLIF(btrim(p_reason), ''),
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = TRUE
   RETURNING * INTO v_settings;

  INSERT INTO public.photo_storage_events (event_type, provider, outcome, message, metadata, created_by) VALUES (
    'mode_change', 'system', 'success',
    CASE WHEN p_upload_mode = 'force_firebase'
      THEN 'New evidence uploads are routed directly to Firebase fallback.'
      ELSE 'New evidence uploads use Supabase first with Firebase fallback.'
    END,
    jsonb_build_object(
      'previous_mode', COALESCE(v_previous_mode, 'automatic'),
      'upload_mode', p_upload_mode,
      'force_firebase_expires_at', p_force_firebase_expires_at,
      'reason', NULLIF(btrim(p_reason), '')
    ),
    auth.uid()
  );

  RETURN QUERY
  SELECT v_settings.upload_mode, v_settings.force_firebase_expires_at,
         v_settings.updated_at, v_settings.updated_by, v_settings.reason;
END;
$function$;

COMMIT;
