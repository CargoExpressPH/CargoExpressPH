-- ======================================================================
-- 20260801000000_drop_business_hours.sql
--
-- Remove the Business Hours feature (admin editor tab, 24/7 toggle).
-- Dropping both columns; nothing renders business_hours/always_open
-- anywhere in the app (verified: only the admin editor used them).
-- ======================================================================

ALTER TABLE public.company_information
  DROP COLUMN IF EXISTS always_open,
  DROP COLUMN IF EXISTS business_hours;
