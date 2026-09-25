-- ============================================================================
-- 20260926110000_simplify_stage2_drop_columns.sql
--
-- STAGE 2 of the database simplification. DESTRUCTIVE: drops columns.
-- Kept in supabase/migrations_pending/ so `supabase db push` cannot apply it
-- together with stage 1. Move it into supabase/migrations/ only when approved.
-- Apply ONLY after (see DATABASE_SIMPLIFICATION_AND_RESET_REVIEW.md):
--   1. 20260926100000_simplify_stage1_derive_and_compat.sql is applied,
--   2. the new frontend is deployed and older PWA builds have had time to
--      update (they must no longer INSERT sender_address/receiver_address or
--      trips.capacity/price_per_kg — PostgREST rejects unknown columns),
--   3. submit-inquiry and paymongo-create-payment Edge Functions are
--      redeployed without `phone`, `description` and `estimated_cost`,
--   4. a verified backup exists.
--
-- No CASCADE anywhere: if anything unexpected still depends on a column,
-- the DROP fails and the whole migration rolls back.
-- ============================================================================

BEGIN;

-- ─── Pre-flight: no database function may still read a dropped column ─────
-- Function bodies are not dependency-tracked by Postgres, so a DROP COLUMN
-- would "succeed" and leave a function that fails at run time. Refuse instead.
DO $$
DECLARE
  v_offenders text;
BEGIN
  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY 1)
    INTO v_offenders
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'private')
     AND p.prokind = 'f'
     AND NOT (n.nspname = 'private' AND p.proname = 'sync_order_legacy_display_columns')
     AND (
          p.prosrc ~ '\.(sender_name|receiver_name|sender_address|receiver_address)\M'
       OR p.prosrc ~ '\.(price_per_kg|estimated_cost)\M'
       OR p.prosrc ~ 'trip_row\.capacity|t\.capacity\M'
       OR (p.prosrc ~ 'contact_inquiries' AND p.prosrc ~ '(NEW|OLD|ci)\.phone\M')
       OR (p.prosrc ~ 'contact_inquiries' AND p.prosrc ~ 'WHERE phone =')
     );
  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Stage 2 aborted: these functions still reference columns being dropped: %', v_offenders;
  END IF;
END $$;

-- ─── Remove the stage-1 compatibility shadow ────────────────────────────────
DROP TRIGGER IF EXISTS orders_zz_sync_legacy_display_columns ON public.orders;
DROP FUNCTION IF EXISTS private.sync_order_legacy_display_columns();

-- ─── orders: full names and full addresses are now derived ──────────────────
-- Still selectable by name through the PostgREST computed fields
-- public.sender_name(orders), receiver_name(orders), sender_address(orders),
-- receiver_address(orders) created in stage 1.
ALTER TABLE public.orders
  DROP COLUMN sender_name,
  DROP COLUMN receiver_name,
  DROP COLUMN sender_address,
  DROP COLUMN receiver_address;

-- ─── trips: company_information owns rate and capacity ─────────────────────
-- Still selectable through public.capacity(trips) / public.price_per_kg(trips).
ALTER TABLE public.trips
  DROP COLUMN capacity,
  DROP COLUMN price_per_kg;

DROP FUNCTION public.effective_trip_price(uuid);

-- ─── payment_attempts: unused local copies ─────────────────────────────────
-- The charge description is still sent to PayMongo by paymongo-create-payment;
-- only the unread local copy is removed. estimated_cost was never populated.
ALTER TABLE public.payment_attempts
  DROP COLUMN estimated_cost,
  DROP COLUMN description;

-- ─── contact_inquiries: legacy combined contact field ──────────────────────
ALTER TABLE public.contact_inquiries DROP CONSTRAINT IF EXISTS contact_inquiries_phone_check;
ALTER TABLE public.contact_inquiries DROP COLUMN phone;

COMMIT;
