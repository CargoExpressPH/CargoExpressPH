-- ============================================================================
-- Restore profiles.address
--
-- 20260802000000_schema_cleanup.sql dropped this column, but the client still
-- writes it in two places:
--   src/contexts/AuthContext.jsx   (register -> createProfile)
--   src/pages/customer/PersonalInfoPage.jsx (profile save)
-- PostgREST rejects the whole statement when a column is missing, so BOTH
-- registration and profile updates failed with:
--   "Could not find the 'address' column of 'profiles' in the schema cache"
--
-- The six granular address_* columns remain the source of truth for anything
-- that reads structured parts (booking prefill, coverage checks). This column
-- holds the pre-joined single-line form written by buildProfileAddress().
-- ============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS address TEXT DEFAULT NULL;

COMMENT ON COLUMN public.profiles.address IS
  'Pre-joined single-line address built from the address_* columns by buildProfileAddress(). Derived/denormalized: address_* remain the source of truth.';

-- Backfill existing rows so the column is not null for anyone who already has
-- structured address parts.
UPDATE public.profiles
SET address = NULLIF(
  concat_ws(', ',
    NULLIF(btrim(address_lot_block), ''),
    NULLIF(btrim(address_street),    ''),
    NULLIF(btrim(address_barangay),  ''),
    NULLIF(btrim(address_city),      ''),
    NULLIF(btrim(address_province),  ''),
    NULLIF(btrim(address_landmark),  '')
  ), '')
WHERE address IS NULL;

NOTIFY pgrst, 'reload schema';
