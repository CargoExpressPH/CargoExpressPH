-- Resolve current object sizes for a bounded, on-demand Storage egress estimate.
-- Only the service role used by the admin-checked Edge Function may call this.
CREATE OR REPLACE FUNCTION public.get_storage_object_sizes_for_egress(p_objects JSONB)
RETURNS TABLE(bucket_id TEXT, name TEXT, size_bytes BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_objects IS NULL OR pg_catalog.jsonb_typeof(p_objects) <> 'array'
     OR pg_catalog.jsonb_array_length(p_objects) > 1000 THEN
    RAISE EXCEPTION 'Invalid object list' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT o.bucket_id, o.name,
    (o.metadata ->> 'size')::BIGINT
  FROM pg_catalog.jsonb_to_recordset(p_objects) AS wanted(bucket_id TEXT, name TEXT)
  JOIN storage.objects AS o
    ON o.bucket_id = wanted.bucket_id AND o.name = wanted.name
  WHERE o.metadata ->> 'size' ~ '^[0-9]+$';
END;
$$;

REVOKE ALL ON FUNCTION public.get_storage_object_sizes_for_egress(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_storage_object_sizes_for_egress(JSONB) TO service_role;
