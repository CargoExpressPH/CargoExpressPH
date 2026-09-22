-- Capacity summaries need prompt refreshes when trips are created,
-- rescheduled, started, arrived, completed, or cancelled. Public SELECT RLS on
-- trips is unchanged; this only adds the already-readable trip rows to the
-- existing Realtime publication. Order changes are already published.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'trips'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.trips;
  END IF;
END;
$$;
