-- Admin-controlled routing for NEW shipment-evidence uploads.
-- This never changes the bucket or existing photo descriptors.
BEGIN;

CREATE TABLE public.photo_storage_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  upload_mode TEXT NOT NULL DEFAULT 'automatic'
    CHECK (upload_mode IN ('automatic', 'force_firebase')),
  force_firebase_expires_at TIMESTAMPTZ,
  reason TEXT,
  updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT force_firebase_requires_expiry CHECK (
    (upload_mode = 'automatic' AND force_firebase_expires_at IS NULL)
    OR (upload_mode = 'force_firebase' AND force_firebase_expires_at IS NOT NULL)
  ),
  CONSTRAINT photo_storage_settings_reason_length CHECK (char_length(COALESCE(reason, '')) <= 500)
);

INSERT INTO public.photo_storage_settings (id, upload_mode)
VALUES (TRUE, 'automatic')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE public.photo_storage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL CHECK (event_type IN ('upload', 'mode_change', 'health_check')),
  provider TEXT NOT NULL CHECK (provider IN ('supabase', 'firebase', 'system')),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'expired')),
  photo_type TEXT CHECK (photo_type IN ('pickup', 'delivery', 'receipt')),
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  storage_path TEXT,
  size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT photo_storage_events_message_length CHECK (char_length(COALESCE(message, '')) <= 500)
);

CREATE INDEX photo_storage_events_created_at_idx ON public.photo_storage_events (created_at DESC);
CREATE INDEX photo_storage_events_order_id_idx ON public.photo_storage_events (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX photo_storage_events_provider_outcome_idx ON public.photo_storage_events (provider, outcome, created_at DESC);

CREATE OR REPLACE FUNCTION public.get_effective_photo_storage_mode()
RETURNS TABLE(upload_mode TEXT, force_firebase_expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, updated_by UUID, reason TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settings public.photo_storage_settings%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_settings FROM public.photo_storage_settings WHERE id = TRUE FOR UPDATE;

  IF v_settings.upload_mode = 'force_firebase'
     AND v_settings.force_firebase_expires_at <= now() THEN
    UPDATE public.photo_storage_settings
       SET upload_mode = 'automatic',
           force_firebase_expires_at = NULL,
           reason = 'Force Firebase mode expired automatically.',
           updated_by = NULL,
           updated_at = now()
     WHERE id = TRUE
     RETURNING * INTO v_settings;

    INSERT INTO public.photo_storage_events (
      event_type, provider, outcome, message, metadata
    ) VALUES (
      'mode_change', 'system', 'expired', 'Force Firebase mode expired and Automatic mode resumed.',
      jsonb_build_object('upload_mode', 'automatic')
    );
  END IF;

  RETURN QUERY
  SELECT v_settings.upload_mode, v_settings.force_firebase_expires_at,
         v_settings.updated_at, v_settings.updated_by, v_settings.reason;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_supabase_evidence_upload_allowed(p_path TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_admin()
    AND (
      (storage.foldername(p_path))[1] NOT IN ('pickup', 'delivery', 'receipts', 'pickup-proofs', 'delivery-proofs')
      OR COALESCE((SELECT upload_mode = 'automatic'
                    OR force_firebase_expires_at <= now()
                   FROM public.photo_storage_settings WHERE id = TRUE), TRUE)
    );
$$;

CREATE OR REPLACE FUNCTION public.set_photo_storage_mode(
  p_upload_mode TEXT,
  p_reason TEXT DEFAULT NULL,
  p_force_firebase_expires_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE(upload_mode TEXT, force_firebase_expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, updated_by UUID, reason TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  SELECT upload_mode INTO v_previous_mode FROM public.photo_storage_settings WHERE id = TRUE FOR UPDATE;

  UPDATE public.photo_storage_settings
     SET upload_mode = p_upload_mode,
         force_firebase_expires_at = p_force_firebase_expires_at,
         reason = NULLIF(btrim(p_reason), ''),
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = TRUE
   RETURNING * INTO v_settings;

  INSERT INTO public.photo_storage_events (
    event_type, provider, outcome, message, metadata, created_by
  ) VALUES (
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
$$;

CREATE OR REPLACE FUNCTION public.get_photo_storage_summary()
RETURNS TABLE(
  supabase_photo_count BIGINT,
  firebase_photo_count BIGINT,
  legacy_photo_count BIGINT,
  pickup_photo_count BIGINT,
  delivery_photo_count BIGINT,
  receipt_photo_count BIGINT,
  failures_last_24h BIGINT,
  fallbacks_last_24h BIGINT,
  last_supabase_upload_at TIMESTAMPTZ,
  last_firebase_upload_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH refs AS (
    SELECT 'pickup'::TEXT AS photo_type, jsonb_array_elements(COALESCE(o.pickup_photos, '[]'::jsonb)) AS ref
    FROM public.orders o
    UNION ALL
    SELECT 'delivery'::TEXT AS photo_type, jsonb_array_elements(COALESCE(o.delivery_photos, '[]'::jsonb)) AS ref
    FROM public.orders o
    UNION ALL
    SELECT 'receipt'::TEXT AS photo_type, to_jsonb(t.receipt_url) AS ref
    FROM public.payment_transactions t
    WHERE t.receipt_url IS NOT NULL AND btrim(t.receipt_url) <> ''
  ), classified AS (
    SELECT photo_type,
      CASE
        WHEN jsonb_typeof(ref) = 'object' AND ref ->> 'type' = 'firestore_fallback' THEN 'firebase'
        WHEN jsonb_typeof(ref) = 'object' AND ref ? 'firestore_path' THEN 'firebase'
        WHEN jsonb_typeof(ref) = 'string' AND ref #>> '{}' LIKE 'photoFallbacks/%' THEN 'firebase'
        WHEN jsonb_typeof(ref) = 'string' AND ref #>> '{}' LIKE '%"firestore_path"%' THEN 'firebase'
        WHEN jsonb_typeof(ref) = 'object' AND (ref ->> 'type' = 'supabase_storage' OR ref ? 'path') THEN 'supabase'
        WHEN jsonb_typeof(ref) = 'string' AND (ref #>> '{}') LIKE '{%' THEN 'legacy'
        WHEN jsonb_typeof(ref) = 'string' THEN 'legacy'
        ELSE 'legacy'
      END AS provider
    FROM refs
  )
  SELECT
    (SELECT count(*) FROM classified WHERE provider = 'supabase'),
    (SELECT count(*) FROM classified WHERE provider = 'firebase'),
    (SELECT count(*) FROM classified WHERE provider = 'legacy'),
    (SELECT count(*) FROM classified WHERE photo_type = 'pickup'),
    (SELECT count(*) FROM classified WHERE photo_type = 'delivery'),
    (SELECT count(*) FROM classified WHERE photo_type = 'receipt'),
    (SELECT count(*) FROM public.photo_storage_events WHERE event_type = 'upload' AND outcome = 'failure' AND created_at >= now() - INTERVAL '24 hours'),
    (SELECT count(*) FROM public.photo_storage_events WHERE event_type = 'upload' AND provider = 'firebase' AND outcome = 'success' AND created_at >= now() - INTERVAL '24 hours'),
    (SELECT max(created_at) FROM public.photo_storage_events WHERE event_type = 'upload' AND provider = 'supabase' AND outcome = 'success'),
    (SELECT max(created_at) FROM public.photo_storage_events WHERE event_type = 'upload' AND provider = 'firebase' AND outcome = 'success');
END;
$$;

ALTER TABLE public.photo_storage_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photo_storage_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins view photo storage events" ON public.photo_storage_events
  FOR SELECT TO authenticated USING (public.is_admin());

GRANT SELECT ON public.photo_storage_events TO authenticated;
REVOKE ALL ON public.photo_storage_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.photo_storage_events FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_effective_photo_storage_mode() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_supabase_evidence_upload_allowed(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_photo_storage_mode(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_photo_storage_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_effective_photo_storage_mode() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_supabase_evidence_upload_allowed(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_photo_storage_mode(TEXT, TEXT, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_photo_storage_summary() TO authenticated;

ALTER PUBLICATION supabase_realtime ADD TABLE public.photo_storage_events;

-- Force Firebase applies only to NEW evidence writes. Existing evidence stays
-- readable and deletable by admins, and company assets are unaffected.
DROP POLICY IF EXISTS "Admins manage cargo photos" ON storage.objects;
CREATE POLICY "Admins read or delete cargo photos" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'cargo-photos' AND public.is_admin());
CREATE POLICY "Admins delete cargo photos" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'cargo-photos' AND public.is_admin());
CREATE POLICY "Admins insert cargo photos under active upload routing" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'cargo-photos' AND public.is_supabase_evidence_upload_allowed(name));
CREATE POLICY "Admins update cargo photos under active upload routing" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'cargo-photos' AND public.is_admin())
  WITH CHECK (bucket_id = 'cargo-photos' AND public.is_supabase_evidence_upload_allowed(name));

COMMIT;
