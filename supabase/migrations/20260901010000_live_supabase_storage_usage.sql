-- Live, admin-only storage object usage for the Photo Storage monitor.
-- Counts the bytes currently represented in this project's storage.objects;
-- it does not estimate from order rows or expose individual object metadata.
BEGIN;

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
  IF NOT public.is_admin() THEN
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
GRANT EXECUTE ON FUNCTION public.get_photo_storage_live_usage() TO authenticated;

COMMIT;
