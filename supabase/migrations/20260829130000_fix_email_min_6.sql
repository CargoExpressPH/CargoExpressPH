-- Allow 6-char email a@b.co (was 7-100, blocked 6)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.check_constraints WHERE constraint_name='contact_inquiries_phone_check') THEN
    ALTER TABLE public.contact_inquiries DROP CONSTRAINT contact_inquiries_phone_check;
  END IF;
END $$;
ALTER TABLE public.contact_inquiries ADD CONSTRAINT contact_inquiries_phone_check CHECK (char_length(btrim(phone)) BETWEEN 6 AND 100);
