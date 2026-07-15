-- Enable realtime sidebar badge updates for new public contact inquiries.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.contact_inquiries;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
