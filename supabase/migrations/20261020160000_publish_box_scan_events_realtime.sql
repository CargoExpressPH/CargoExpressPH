-- Trip detail shows "Manual xn" badges from box_scan_events; publish the table
-- so admins watching a trip see manual fallbacks live. RLS (admins read only)
-- still gates which rows Realtime delivers.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'box_scan_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.box_scan_events;
  END IF;
END;
$$;
