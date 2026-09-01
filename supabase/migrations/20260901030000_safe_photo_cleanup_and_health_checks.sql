-- Make Photo Storage cleanup safe and keep capacity warnings running even
-- when no administrator has the Photo Storage page open.

-- Featured deliveries keep their selected public website photo. They can be
-- cleaned only after an administrator removes them from the website feature.
CREATE OR REPLACE FUNCTION public.get_expired_evidence_orders(p_cutoff TIMESTAMPTZ)
RETURNS TABLE (
  order_id UUID,
  tracking_number TEXT,
  status TEXT,
  terminal_status_at TIMESTAMPTZ,
  pickup_photos JSONB,
  delivery_photos JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.tracking_number, o.status, s.terminal_status_at, o.pickup_photos, o.delivery_photos
  FROM public.orders o
  JOIN LATERAL (
    SELECT max(e.changed_at) AS terminal_status_at
    FROM public.order_status_events e
    WHERE e.order_id = o.id AND e.status = o.status
  ) s ON TRUE
  WHERE o.status IN ('Delivered', 'Cancelled')
    AND COALESCE(o.featured_on_website, FALSE) = FALSE
    AND s.terminal_status_at IS NOT NULL
    AND s.terminal_status_at < p_cutoff
    AND (
      COALESCE(o.pickup_photos, '[]'::jsonb) <> '[]'::jsonb
      OR COALESCE(o.delivery_photos, '[]'::jsonb) <> '[]'::jsonb
    );
$$;

REVOKE ALL ON FUNCTION public.get_expired_evidence_orders(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_expired_evidence_orders(TIMESTAMPTZ) TO service_role;

-- The scheduled health check calls this with the service-role identity. The
-- normal Photo Storage screen remains restricted to administrators.
CREATE OR REPLACE FUNCTION public.get_photo_storage_live_usage()
RETURNS TABLE(
  total_size_bytes BIGINT,
  object_count BIGINT,
  buckets JSONB,
  measured_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() AND COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH bucket_usage AS (
    SELECT
      o.bucket_id,
      count(*)::BIGINT AS object_count,
      COALESCE(sum(
        CASE
          WHEN o.metadata ->> 'size' ~ '^[0-9]+$'
            THEN (o.metadata ->> 'size')::BIGINT
          ELSE 0
        END
      ), 0)::BIGINT AS size_bytes
    FROM storage.objects o
    GROUP BY o.bucket_id
  )
  SELECT
    COALESCE(sum(bu.size_bytes), 0)::BIGINT,
    COALESCE(sum(bu.object_count), 0)::BIGINT,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'bucket_id', bu.bucket_id,
          'size_bytes', bu.size_bytes,
          'object_count', bu.object_count
        ) ORDER BY bu.size_bytes DESC, bu.bucket_id
      ),
      '[]'::JSONB
    ),
    now()
  FROM bucket_usage bu;
END;
$$;

REVOKE ALL ON FUNCTION public.get_photo_storage_live_usage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_photo_storage_live_usage() TO authenticated, service_role;

-- Clearing an order and recording every managed file that must be removed are
-- one database transaction. If a storage provider is temporarily unavailable,
-- the queue remains pending and the next scheduled run retries it.
CREATE TABLE IF NOT EXISTS public.photo_cleanup_queue (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('supabase', 'firebase')),
  storage_path TEXT NOT NULL,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  UNIQUE (provider, storage_path)
);

ALTER TABLE public.photo_cleanup_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.photo_cleanup_queue FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.photo_cleanup_queue TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.photo_cleanup_queue_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.queue_expired_evidence_cleanup(
  p_order_ids UUID[],
  p_items JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_count INTEGER := 0;
  v_item JSONB;
  v_provider TEXT;
  v_path TEXT;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service access required' USING ERRCODE = '42501';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'Cleanup items must be an array' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_provider := v_item ->> 'provider';
    v_path := v_item ->> 'storage_path';
    IF v_provider = 'supabase' AND v_path ~ '^(pickup-proofs|delivery-proofs)/[^/]+/.+' THEN
      NULL;
    ELSIF v_provider = 'firebase' AND v_path ~ '^photoFallbacks/[^/]+$' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'Invalid cleanup item' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.photo_cleanup_queue (provider, storage_path)
    VALUES (v_provider, v_path)
    ON CONFLICT (provider, storage_path) DO UPDATE
      SET queued_at = now(), completed_at = NULL, attempts = 0, last_error = NULL;
  END LOOP;

  IF COALESCE(cardinality(p_order_ids), 0) > 0 THEN
    UPDATE public.orders
    SET pickup_photos = '[]'::JSONB,
        delivery_photos = '[]'::JSONB
    WHERE id = ANY(p_order_ids);
    GET DIAGNOSTICS v_order_count = ROW_COUNT;
    IF v_order_count <> cardinality(p_order_ids) THEN
      RAISE EXCEPTION 'Not every cleanup order could be updated' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN v_order_count;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_expired_evidence_cleanup(UUID[], JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_expired_evidence_cleanup(UUID[], JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.record_photo_cleanup_queue_result(
  p_ids BIGINT[],
  p_error TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service access required' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(cardinality(p_ids), 0) = 0 THEN
    RETURN;
  END IF;

  UPDATE public.photo_cleanup_queue
  SET attempts = attempts + 1,
      completed_at = CASE WHEN p_error IS NULL THEN now() ELSE NULL END,
      last_error = CASE WHEN p_error IS NULL THEN NULL ELSE left(p_error, 500) END
  WHERE id = ANY(p_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.record_photo_cleanup_queue_result(BIGINT[], TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_photo_cleanup_queue_result(BIGINT[], TEXT) TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

-- Plainly named replacement for the original archive trigger. This operation
-- permanently removes old photos; it does not move them to another archive.
CREATE OR REPLACE FUNCTION public.trigger_scheduled_old_photo_cleanup()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $$
DECLARE
  v_project_url text;
  v_service_key text;
BEGIN
  SELECT decrypted_secret INTO v_project_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_service_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

  IF v_project_url IS NULL OR v_service_key IS NULL THEN
    RAISE WARNING 'Scheduled old-photo cleanup skipped because its server credentials are not configured.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_project_url || '/functions/v1/archive-expired-evidence-photos',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body    := '{}'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_scheduled_old_photo_cleanup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_scheduled_old_photo_cleanup() TO service_role;

SELECT CASE WHEN EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'evidence_photo_archive')
  THEN cron.unschedule('evidence_photo_archive') END;
SELECT CASE WHEN EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'scheduled_old_photo_cleanup')
  THEN cron.unschedule('scheduled_old_photo_cleanup') END;

SELECT cron.schedule(
  'scheduled_old_photo_cleanup',
  '30 1 * * *',
  $cron$SELECT public.trigger_scheduled_old_photo_cleanup()$cron$
);

CREATE OR REPLACE FUNCTION public.trigger_photo_storage_health_check()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $$
DECLARE
  v_project_url text;
  v_service_key text;
BEGIN
  SELECT decrypted_secret INTO v_project_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_service_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

  IF v_project_url IS NULL OR v_service_key IS NULL THEN
    RAISE WARNING 'Photo storage warning check skipped because its server credentials are not configured.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_project_url || '/functions/v1/photo-storage-health',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body    := '{}'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_photo_storage_health_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_photo_storage_health_check() TO service_role;

SELECT CASE WHEN EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'photo_storage_health_check')
  THEN cron.unschedule('photo_storage_health_check') END;

-- Four checks per day are enough to warn administrators without depending on
-- somebody keeping the Photo Storage page open.
SELECT cron.schedule(
  'photo_storage_health_check',
  '15 */6 * * *',
  $cron$SELECT public.trigger_photo_storage_health_check()$cron$
);

DROP FUNCTION IF EXISTS public.trigger_evidence_photo_archive();
