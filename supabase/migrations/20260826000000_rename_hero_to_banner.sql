-- ============================================================
-- Rename hero columns in company_information to banner
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='company_information' AND column_name='hero_image_url') THEN
    ALTER TABLE public.company_information RENAME COLUMN hero_image_url TO banner_image_url;
    ALTER TABLE public.company_information RENAME COLUMN hero_title TO banner_title;
    ALTER TABLE public.company_information RENAME COLUMN hero_description TO banner_description;
    ALTER TABLE public.company_information RENAME COLUMN hero_button_text TO banner_button_text;
    ALTER TABLE public.company_information RENAME COLUMN hero_button_link TO banner_button_link;
  END IF;
END $$;
