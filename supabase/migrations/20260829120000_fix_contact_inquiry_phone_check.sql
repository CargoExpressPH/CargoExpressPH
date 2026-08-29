-- Fix: legacy phone column CHECK 7-20 blocked valid emails >20 chars.
-- Edge validates 7-100, DB must match. See AboutPage.jsx dual-write.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.check_constraints WHERE constraint_name='contact_inquiries_phone_check') THEN
    ALTER TABLE public.contact_inquiries DROP CONSTRAINT contact_inquiries_phone_check;
  END IF;
END $$;
ALTER TABLE public.contact_inquiries ADD CONSTRAINT contact_inquiries_phone_check CHECK (char_length(btrim(phone)) BETWEEN 7 AND 100);
