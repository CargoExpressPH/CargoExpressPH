-- ============================================================
-- CargoExpress PH — Schema Cleanup Migration
-- Removes unused columns, duplicate indexes, and stale objects
-- Fixes get_public_business_profile() RPC (queried wrong table)
-- SAFE: Does not affect any active functionality
-- ============================================================

-- 1. Drop unused columns from profiles
ALTER TABLE public.profiles DROP COLUMN IF EXISTS address;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS fcm_token;

-- 2. Drop unused stat columns from company_information
ALTER TABLE public.company_information DROP COLUMN IF EXISTS stat_years;
ALTER TABLE public.company_information DROP COLUMN IF EXISTS stat_deliveries;
ALTER TABLE public.company_information DROP COLUMN IF EXISTS stat_customers;
ALTER TABLE public.company_information DROP COLUMN IF EXISTS stat_hubs;

-- 3. Drop stale index for removed fcm_token column
DROP INDEX IF EXISTS idx_profiles_fcm_token;

-- 4. Drop duplicate chat_messages index
DROP INDEX IF EXISTS idx_chat_messages_conv_id;

-- 5. Drop redundant trip_reassignments table (if it exists)
DROP TABLE IF EXISTS public.trip_reassignments CASCADE;

-- 6. Fix get_public_business_profile() to query correct table
--    Old version queried profiles for columns that don't exist (facebook_link,
--    smart_phone, etc.). Correct source is company_information.
--    Must DROP first because return type changes (VARCHAR → TEXT for name).
DROP FUNCTION IF EXISTS public.get_public_business_profile();

CREATE OR REPLACE FUNCTION public.get_public_business_profile()
RETURNS TABLE (
  name TEXT,
  smart_phone TEXT,
  globe_phone TEXT,
  facebook_link TEXT,
  manila_address TEXT,
  bohol_address TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.name,
    c.smart_phone,
    c.globe_phone,
    c.facebook AS facebook_link,
    c.manila_address,
    c.bohol_address
  FROM public.company_information c
  WHERE c.id = '00000000-0000-0000-0000-000000000001'
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_business_profile() TO anon, authenticated;

-- Verify:
-- SELECT * FROM get_public_business_profile();
