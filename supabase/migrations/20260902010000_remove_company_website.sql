-- Remove unused website column from company_information
ALTER TABLE public.company_information DROP COLUMN IF EXISTS website;
