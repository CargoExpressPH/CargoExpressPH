-- A small, read-only metric for the admin resource monitoring page.
-- Keep the database-size query behind an explicit admin check.
CREATE OR REPLACE FUNCTION public.get_admin_database_usage()
RETURNS TABLE(size_bytes BIGINT, measured_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT pg_catalog.pg_database_size(pg_catalog.current_database()), pg_catalog.clock_timestamp();
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_database_usage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_database_usage() TO authenticated;
