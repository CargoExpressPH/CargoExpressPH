-- ============================================================
-- Migration: 20260922160000_person_name_policy.sql
-- Purpose  : One shared, server-enforced character policy for human-name
--            fields, mirroring src/utils/validation.js :: validateName().
--
-- WHY (audit P-02)
--   validateName()'s comment claimed it allowed letters "including
--   diacritics", but its regex was ASCII plus a hand-picked Spanish subset,
--   so "Å" or "ł" were rejected while registration used a completely
--   different, laxer check (non-blank, 2+ characters). The same field asked
--   two different questions depending on which form you reached it through,
--   and NO check existed server-side at all — a direct PostgREST call could
--   write any string into a name column.
--
-- THE CHOSEN POLICY (this application's rule, NOT a definition of a valid
-- human name — real names contain characters this refuses):
--   ALLOW  Unicode letters of any script, plus combining marks
--          spaces between name parts
--          periods, for initials and suffixes  ("J. Santos", "Rizal Jr.")
--          hyphens and apostrophes             ("Santos-Reyes", "O'Brien"),
--          including the typographic apostrophe U+2019 that mobile
--          autocorrect produces
--   REJECT digits, emoji, every other symbol and punctuation mark
--          (commas and backticks WERE accepted by the old regex and are not
--          part of this policy)
--          anything containing no letter at all: "...", "   ", "--", emoji
--   TRIM   surrounding whitespace is ignored when judging the value
--
-- UNICODE NORMALISATION
--   The value is normalised to NFC before it is tested, so a decomposed
--   "José" (J-o-s-e + U+0301, which is what a Mac dead-key produces)
--   validates identically to the precomposed form. Postgres's POSIX
--   [[:alpha:]] class is fully Unicode-aware on a UTF-8 database — verified
--   empirically on PGlite/PG17: ñ, Ł and 日 all match it, an emoji does not.
--   NFC is used only for the TEST. Nothing here rewrites a stored value.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   * It does NOT rewrite, "correct" or delete any existing name. There is
--     no UPDATE statement in this migration.
--   * It does NOT block unrelated updates to legacy rows. Every check below
--     fires only when the name value is ACTUALLY CHANGING. A booking whose
--     historical sender_name predates this policy can still be paid,
--     assigned, picked up, delivered and cancelled; only an attempt to write
--     a NEW non-conforming name is refused.
--   * It does NOT apply to company names, emails, addresses, package
--     descriptions or Facebook handles. Those keep their own, looser rules.
--   * It does NOT require a last name. A blank last_name stays legal — the
--     20260922100000 backfill produced blanks for genuine Filipino mononyms,
--     and required-ness is decided per write path, not by this character
--     policy. Only a NON-BLANK value has to conform.
--   * It does NOT touch the signup path. public.profiles INSERT is left
--     unvalidated on purpose: the profile row is created by the auth-signup
--     trigger, and raising there would leave an auth.users record with no
--     profile — a half-finished account is worse than a badly formatted
--     name. Registration is validated in the browser (RegisterPage now uses
--     the shared validateName()), and any later edit goes through the
--     UPDATE check below.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. The policy itself — the single source of truth server-side.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_valid_person_name(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN NULLIF(btrim(p_name), '') IS NULL THEN FALSE
    ELSE
      -- every character is a letter, mark, space, period, hyphen or apostrophe
      normalize(btrim(p_name), NFC) ~ ('^[[:alpha:][:space:].' || chr(39) || chr(8217) || '-]+$')
      -- ...and at least one of them is a letter
      AND normalize(btrim(p_name), NFC) ~ '[[:alpha:]]'
      AND char_length(btrim(p_name)) BETWEEN 2 AND 100
  END;
$$;

COMMENT ON FUNCTION public.is_valid_person_name(TEXT) IS
  'CargoExpress PH human-name character policy. Mirrors src/utils/validation.js::validateName(). Letters (any script) + marks + space + . + - + apostrophe, at least one letter, 2-100 characters, NFC-normalised for the test. Not a definition of a valid human name.';

REVOKE ALL ON FUNCTION public.is_valid_person_name(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_valid_person_name(TEXT) TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- 2. New bookings — prepare_order_insert()
--    Reproduced VERBATIM from
--    20260912030000_restrict_service_area_customer_insert.sql except for the
--    block marked "NEW (20260922160000)".
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prepare_order_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  trip_row       public.trips%ROWTYPE;
  v_current_load NUMERIC;
  v_capacity_allowance CONSTANT NUMERIC := 200;
BEGIN
  IF auth.uid() IS NOT NULL AND NEW.user_id <> auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Cannot create orders for another user';
  END IF;

  -- ── NEW (20260922160000) — sender/receiver name policy ─────────────────
  -- A booking is created here for the first time, so there is no legacy
  -- value to grandfather: every name written must conform. A blank
  -- last_name is tolerated (mononyms); a non-blank one must be valid.
  IF NULLIF(btrim(NEW.sender_first_name), '') IS NOT NULL
     AND NOT public.is_valid_person_name(NEW.sender_first_name) THEN
    RAISE EXCEPTION 'Sender first name may only contain letters, spaces, periods, hyphens and apostrophes.'
      USING ERRCODE = '22023';
  END IF;
  IF NULLIF(btrim(NEW.sender_last_name), '') IS NOT NULL
     AND NOT public.is_valid_person_name(NEW.sender_last_name) THEN
    RAISE EXCEPTION 'Sender last name may only contain letters, spaces, periods, hyphens and apostrophes.'
      USING ERRCODE = '22023';
  END IF;
  IF NULLIF(btrim(NEW.receiver_first_name), '') IS NOT NULL
     AND NOT public.is_valid_person_name(NEW.receiver_first_name) THEN
    RAISE EXCEPTION 'Receiver first name may only contain letters, spaces, periods, hyphens and apostrophes.'
      USING ERRCODE = '22023';
  END IF;
  IF NULLIF(btrim(NEW.receiver_last_name), '') IS NOT NULL
     AND NOT public.is_valid_person_name(NEW.receiver_last_name) THEN
    RAISE EXCEPTION 'Receiver last name may only contain letters, spaces, periods, hyphens and apostrophes.'
      USING ERRCODE = '22023';
  END IF;
  -- An older client that still writes only the combined column is checked
  -- on that column instead, so neither shape of write escapes the policy.
  IF NULLIF(btrim(NEW.sender_first_name), '') IS NULL
     AND NULLIF(btrim(NEW.sender_name), '') IS NOT NULL
     AND NOT public.is_valid_person_name(NEW.sender_name) THEN
    RAISE EXCEPTION 'Sender name may only contain letters, spaces, periods, hyphens and apostrophes.'
      USING ERRCODE = '22023';
  END IF;
  IF NULLIF(btrim(NEW.receiver_first_name), '') IS NULL
     AND NULLIF(btrim(NEW.receiver_name), '') IS NOT NULL
     AND NOT public.is_valid_person_name(NEW.receiver_name) THEN
    RAISE EXCEPTION 'Receiver name may only contain letters, spaces, periods, hyphens and apostrophes.'
      USING ERRCODE = '22023';
  END IF;

  NEW.tracking_number := public.generate_order_tracking_number();
  NEW.actual_weight := NULL;
  NEW.payment_method := NULL;
  NEW.payment_status := 'unpaid';
  NEW.amount_paid := 0;
  NEW.promised_payment_date := NULL;
  NEW.payment_reference := NULL;
  NEW.pickup_photos := '[]'::jsonb;
  NEW.delivery_photos := '[]'::jsonb;

  -- A booking cannot be born already asking to be cancelled.
  NEW.cancellation_details         := NULL;

  -- A booking cannot be born already discounted — a discount is applied at
  -- pickup, by an admin, through record_pickup_payment(), never at creation.
  NEW.discount_amount     := 0;
  NEW.discount_reason     := NULL;
  NEW.discount_notes      := NULL;
  NEW.discount_applied_by := NULL;
  NEW.discount_applied_at := NULL;

  -- A booking's out-of-coverage review flag is derived from the sender's
  -- actual province, never trusted from the client request. 'approved' and
  -- 'rejected' are only ever reachable afterward, through the admin-only
  -- UPDATE path (OrderDetailPage's handleApproveReview/handleRejectReview).
  NEW.service_area_status := CASE
    WHEN public.is_standard_service_area_province(NEW.sender_province) THEN 'standard'
    ELSE 'for_review'
  END;
  NEW.service_area_remarks := NULL;

  IF NEW.trip_id IS NOT NULL THEN
    SELECT * INTO trip_row FROM public.trips WHERE id = NEW.trip_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected trip does not exist';
    END IF;

    -- ── Capacity enforcement (matches frontend TRIP_CAPACITY_ALLOWANCE_KG) ──
    IF trip_row.capacity > 0 THEN
      SELECT COALESCE(SUM(COALESCE(o.actual_weight, 0)), 0)
        INTO v_current_load
        FROM public.orders o
       WHERE o.trip_id = NEW.trip_id
         AND o.status <> 'Cancelled';

      IF v_current_load > (trip_row.capacity + v_capacity_allowance) THEN
        RAISE EXCEPTION
          'Cannot accept booking: exceeds maximum van capacity of % kg (% kg planned + % kg allowance). This trip is carrying % kg.',
          trip_row.capacity + v_capacity_allowance,
          trip_row.capacity,
          v_capacity_allowance,
          v_current_load;
      END IF;
    END IF;

    NEW.status := 'Assigned';
    NEW.origin := trip_row.origin;
    NEW.destination := trip_row.destination;
  ELSE
    NEW.status := 'Pending';
  END IF;

  -- No weight, no price. Both are set by guard_order_update the moment an
  -- admin records actual_weight at pickup.
  NEW.shipping_cost := 0;
  NEW.remaining_balance := 0;

  RETURN NEW;
END;
$function$;


-- ------------------------------------------------------------
-- 3. Profile self-service edits — guard_profile_write()
--    Reproduced VERBATIM from 20260524190000_production_hardening.sql
--    except for the block marked "NEW (20260922160000)".
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_profile_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
      NEW.role := 'customer';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    NEW.id := OLD.id;
    NEW.email := OLD.email;
    NEW.role := OLD.role;
    NEW.created_at := OLD.created_at;
  END IF;

  -- ── NEW (20260922160000) — name policy, on CHANGE only ─────────────────
  -- A profile whose name predates this policy keeps working: phone, address
  -- and every other self-service edit still saves, because this fires only
  -- when the name column itself is being written to a new value.
  IF TG_OP = 'UPDATE'
     AND NEW.name IS DISTINCT FROM OLD.name
     AND NULLIF(btrim(NEW.name), '') IS NOT NULL
     AND NOT public.is_valid_person_name(NEW.name) THEN
    RAISE EXCEPTION 'Name may only contain letters, spaces, periods, hyphens and apostrophes.'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;

-- ============================================================
-- NOTE ON guard_order_update()
--   The name policy for EXISTING bookings is enforced in
--   20260922170000_person_name_policy_order_updates.sql, which has to
--   reproduce the whole of guard_order_update() and is kept in its own file
--   so this one stays readable.
--
-- VERIFY:
--   SELECT public.is_valid_person_name('José Peña');        -- t
--   SELECT public.is_valid_person_name('Maria Santos-Reyes');-- t
--   SELECT public.is_valid_person_name('J. Santos');         -- t
--   SELECT public.is_valid_person_name('Juan123');           -- f
--   SELECT public.is_valid_person_name('...');               -- f
--   SELECT public.is_valid_person_name('   ');               -- f
-- ============================================================
