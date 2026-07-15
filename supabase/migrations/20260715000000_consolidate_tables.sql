-- ============================================================
-- CargoExpress PH -- Table Consolidation Migration
-- 18 to 15 tables
-- Drops: global_settings, coverage_regions, coverage_municipalities
-- Run in: Supabase Dashboard -> SQL Editor -> New Query
-- ============================================================

-- STEP 1: Add coverage JSONB column to company_information
ALTER TABLE public.company_information
  ADD COLUMN IF NOT EXISTS coverage JSONB DEFAULT '[]'::jsonb;


-- STEP 2: Migrate existing coverage_regions + coverage_municipalities
--         data into the coverage JSONB column
DO $$
DECLARE
  v_coverage JSONB;
BEGIN
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', r.id,
        'name', r.name,
        'display_order', r.display_order,
        'municipalities', (
          SELECT COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'id', m.id,
                'name', m.name,
                'display_order', m.display_order
              ) ORDER BY m.display_order ASC, m.name ASC
            ),
            '[]'::jsonb
          )
          FROM public.coverage_municipalities m
          WHERE m.region_id = r.id
        )
      ) ORDER BY r.display_order ASC, r.name ASC
    ),
    '[]'::jsonb
  )
  INTO v_coverage
  FROM public.coverage_regions r;

  UPDATE public.company_information
  SET coverage = v_coverage
  WHERE id = '00000000-0000-0000-0000-000000000001';

  RAISE NOTICE 'Coverage migration complete. Migrated % regions.', jsonb_array_length(v_coverage);
END;
$$;


-- STEP 3: Update global_price_per_kilo() to read from company_information
CREATE OR REPLACE FUNCTION public.global_price_per_kilo()
RETURNS NUMERIC
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT default_price_per_kg FROM public.company_information
     WHERE id = '00000000-0000-0000-0000-000000000001' LIMIT 1),
    70
  );
$$;


-- STEP 4: Drop coverage tables (CASCADE drops FK constraints + policies)
DROP POLICY IF EXISTS "Allow public read access" ON public.coverage_municipalities;
DROP POLICY IF EXISTS "Allow admin full access" ON public.coverage_municipalities;
DROP POLICY IF EXISTS "Allow public read access" ON public.coverage_regions;
DROP POLICY IF EXISTS "Allow admin full access" ON public.coverage_regions;
DROP TABLE IF EXISTS public.coverage_municipalities CASCADE;
DROP TABLE IF EXISTS public.coverage_regions CASCADE;


-- STEP 5: Drop global_settings
DROP POLICY IF EXISTS "Anyone can view settings" ON public.global_settings;
DROP POLICY IF EXISTS "Admins can update settings" ON public.global_settings;
DROP POLICY IF EXISTS "Admins can insert settings" ON public.global_settings;
DROP TABLE IF EXISTS public.global_settings CASCADE;


-- Verify with:
-- SELECT coverage FROM public.company_information LIMIT 1;
-- SELECT default_price_per_kg FROM public.company_information LIMIT 1;
-- SELECT public.global_price_per_kilo();
