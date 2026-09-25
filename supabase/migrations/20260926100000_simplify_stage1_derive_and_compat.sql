-- ============================================================================
-- 20260926100000_simplify_stage1_derive_and_compat.sql
--
-- STAGE 1 of the database simplification (see
-- DATABASE_SIMPLIFICATION_AND_RESET_REVIEW.md). Additive and backward
-- compatible: NO column is dropped here. After this migration:
--
--   * Company Information owns the freight rate and trip capacity.
--     trips.capacity / trips.price_per_kg are no longer read by any database
--     function (they are dropped in stage 2).
--   * orders.shipping_cost is priced from the CURRENT company rate only when
--     the recorded weight changes. Payments, refunds, discounts and trip
--     reassignments preserve the recorded charge.
--   * Sender/receiver full names and full addresses are DERIVED from the
--     structured columns by one SQL rule each. The stored sender_name /
--     receiver_name / sender_address / receiver_address columns become a
--     read-only compatibility shadow, recomputed from the parts on every
--     write, until stage 2 drops them.
--   * Admin/customer contact editing takes structured address parts
--     (including lot/block) — there is no free-text full-address input any
--     more that could disagree with the parts.
--   * contact_inquiries rate limiting no longer depends on the legacy
--     combined `phone` column, applies every limit together, and serializes
--     concurrent submissions.
--
-- PostgREST computed fields (functions taking the table row) keep the old
-- names selectable for older cached PWA clients after stage 2:
--   orders.sender_name, orders.receiver_name, orders.sender_address,
--   orders.receiver_address, trips.capacity, trips.price_per_kg
-- ============================================================================

BEGIN;

-- ─── 1. One formatting rule for person names ────────────────────────────────
-- Blank/NULL parts are skipped; any run of whitespace (inside or between the
-- parts) becomes one space; the result is trimmed; an all-blank name is NULL.
-- src/lib/orderParties.js formatPersonName() implements the identical rule.
CREATE OR REPLACE FUNCTION public.format_person_name(p_first text, p_last text)
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path TO ''
AS $$
  SELECT NULLIF(btrim(regexp_replace(concat_ws(' ', p_first, p_last), '[[:space:]]+', ' ', 'g')), '')
$$;

-- ─── 2. One formatting rule for addresses ───────────────────────────────────
-- Exact SQL port of src/lib/address.js buildFullAddress():
--   each part: strip leading/trailing whitespace and commas, collapse ",,"
--   drop empty parts; drop a part equal (case-insensitive) to the previous one
--   join as "lot/block, street, barangay, city, province"
--   append " (Landmark: <landmark>)" when a landmark exists
-- Free-text "Other Area" locations are stored in *_province, so they are
-- carried through unchanged.
CREATE OR REPLACE FUNCTION public.clean_address_part(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path TO ''
AS $$
  SELECT regexp_replace(
           regexp_replace(COALESCE(p, ''), '^[[:space:],]+|[[:space:],]+$', '', 'g'),
           ',+', ',', 'g')
$$;

CREATE OR REPLACE FUNCTION public.format_address(
  p_lot_block text, p_street text, p_barangay text, p_city text, p_province text, p_landmark text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE PARALLEL SAFE
SET search_path TO ''
AS $$
DECLARE
  v_part     text;
  v_prev     text := NULL;
  v_kept     text[] := ARRAY[]::text[];
  v_address  text;
  v_landmark text := public.clean_address_part(p_landmark);
BEGIN
  FOREACH v_part IN ARRAY ARRAY[p_lot_block, p_street, p_barangay, p_city, p_province] LOOP
    v_part := public.clean_address_part(v_part);
    CONTINUE WHEN v_part = '';
    IF v_prev IS NULL OR lower(v_part) <> lower(v_prev) THEN
      v_kept := v_kept || v_part;
    END IF;
    v_prev := v_part;
  END LOOP;

  v_address := array_to_string(v_kept, ', ');
  IF v_landmark = '' THEN
    RETURN v_address;
  END IF;
  IF v_address = '' THEN
    RETURN '(Landmark: ' || v_landmark || ')';
  END IF;
  RETURN v_address || ' (Landmark: ' || v_landmark || ')';
END;
$$;

-- ─── 3. Company-owned rate and capacity ─────────────────────────────────────
-- global_price_per_kilo() already reads company_information.default_price_per_kg
-- (fallback 70). The capacity counterpart:
CREATE OR REPLACE FUNCTION public.company_default_capacity()
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    (SELECT default_capacity FROM public.company_information
      WHERE id = '00000000-0000-0000-0000-000000000001' LIMIT 1),
    0)
$$;

-- No longer reads trips.price_per_kg. Kept (same signature) only so nothing
-- that might still call it breaks before stage 2 drops it.
CREATE OR REPLACE FUNCTION public.effective_trip_price(p_trip_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.global_price_per_kilo()
$$;

-- ─── 4. PostgREST computed fields (compatibility aliases) ───────────────────
-- While the stored columns still exist (stage 1) the column wins; after stage
-- 2 these functions answer `select=sender_name,...` / embedded
-- `trips(capacity,price_per_kg)` requests from older clients. They are NOT
-- included in `select=*`, which is why the current frontend derives these
-- values itself (src/lib/orderParties.js, attachCompanyTripDefaults()).
CREATE OR REPLACE FUNCTION public.sender_name(o public.orders)
RETURNS text LANGUAGE sql STABLE SET search_path TO '' AS
$$ SELECT public.format_person_name(o.sender_first_name, o.sender_last_name) $$;

CREATE OR REPLACE FUNCTION public.receiver_name(o public.orders)
RETURNS text LANGUAGE sql STABLE SET search_path TO '' AS
$$ SELECT public.format_person_name(o.receiver_first_name, o.receiver_last_name) $$;

CREATE OR REPLACE FUNCTION public.sender_address(o public.orders)
RETURNS text LANGUAGE sql STABLE SET search_path TO '' AS
$$ SELECT public.format_address(o.sender_lot_block, o.sender_street, o.sender_barangay,
                                o.sender_city, o.sender_province, o.sender_landmark) $$;

CREATE OR REPLACE FUNCTION public.receiver_address(o public.orders)
RETURNS text LANGUAGE sql STABLE SET search_path TO '' AS
$$ SELECT public.format_address(o.receiver_lot_block, o.receiver_street, o.receiver_barangay,
                                o.receiver_city, o.receiver_province, o.receiver_landmark) $$;

CREATE OR REPLACE FUNCTION public.capacity(t public.trips)
RETURNS integer LANGUAGE sql STABLE SET search_path TO '' AS
$$ SELECT public.company_default_capacity() $$;

CREATE OR REPLACE FUNCTION public.price_per_kg(t public.trips)
RETURNS numeric LANGUAGE sql STABLE SET search_path TO '' AS
$$ SELECT public.global_price_per_kilo() $$;

-- ─── 5. Legacy display-column shadow (removed in stage 2) ───────────────────
-- Replaces sync_order_sender_receiver_names_insert (INSERT-only, two-way
-- sync). Now ONE-way: the structured parts are authoritative on every
-- insert/update; the stored full name/address columns are recomputed from
-- them so older clients reading `select=*` still see correct values. A value
-- an older client writes into a legacy column is overwritten, never trusted
-- — except the insert-only case of a client that sends ONLY a combined name
-- (no first/last), which is split exactly as before and validated.
-- Named orders_zz_* so it fires after every other BEFORE trigger.
CREATE OR REPLACE FUNCTION private.sync_order_legacy_display_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NULLIF(btrim(COALESCE(NEW.sender_first_name, '')), '') IS NULL
       AND NULLIF(btrim(COALESCE(NEW.sender_name, '')), '') IS NOT NULL THEN
      IF NOT public.is_valid_person_name(NEW.sender_name) THEN
        RAISE EXCEPTION 'Sender name may only contain letters, spaces, periods, hyphens and apostrophes.'
          USING ERRCODE = '22023';
      END IF;
      NEW.sender_first_name := split_part(btrim(NEW.sender_name), ' ', 1);
      NEW.sender_last_name  := CASE
        WHEN position(' ' in btrim(NEW.sender_name)) = 0 THEN ''
        ELSE btrim(substring(btrim(NEW.sender_name) from position(' ' in btrim(NEW.sender_name)) + 1))
      END;
    END IF;
    IF NULLIF(btrim(COALESCE(NEW.receiver_first_name, '')), '') IS NULL
       AND NULLIF(btrim(COALESCE(NEW.receiver_name, '')), '') IS NOT NULL THEN
      IF NOT public.is_valid_person_name(NEW.receiver_name) THEN
        RAISE EXCEPTION 'Receiver name may only contain letters, spaces, periods, hyphens and apostrophes.'
          USING ERRCODE = '22023';
      END IF;
      NEW.receiver_first_name := split_part(btrim(NEW.receiver_name), ' ', 1);
      NEW.receiver_last_name  := CASE
        WHEN position(' ' in btrim(NEW.receiver_name)) = 0 THEN ''
        ELSE btrim(substring(btrim(NEW.receiver_name) from position(' ' in btrim(NEW.receiver_name)) + 1))
      END;
    END IF;
  END IF;

  NEW.sender_name      := COALESCE(public.format_person_name(NEW.sender_first_name, NEW.sender_last_name), '');
  NEW.receiver_name    := COALESCE(public.format_person_name(NEW.receiver_first_name, NEW.receiver_last_name), '');
  NEW.sender_address   := public.format_address(NEW.sender_lot_block, NEW.sender_street, NEW.sender_barangay,
                                                NEW.sender_city, NEW.sender_province, NEW.sender_landmark);
  NEW.receiver_address := public.format_address(NEW.receiver_lot_block, NEW.receiver_street, NEW.receiver_barangay,
                                                NEW.receiver_city, NEW.receiver_province, NEW.receiver_landmark);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_sync_sender_receiver_names_insert ON public.orders;
DROP FUNCTION IF EXISTS public.sync_order_sender_receiver_names_insert();
DROP TRIGGER IF EXISTS orders_zz_sync_legacy_display_columns ON public.orders;
CREATE TRIGGER orders_zz_sync_legacy_display_columns
  BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION private.sync_order_legacy_display_columns();

-- Bring existing rows' shadow columns onto the single rule (verified 11/11
-- identical on 2026-09-25, so this is expected to change nothing). The
-- UPDATE fires guard_order_update, whose details lock only reacts to a
-- change in the structured parts, which this statement does not touch.
UPDATE public.orders
   SET sender_name = sender_name
 WHERE sender_name IS DISTINCT FROM COALESCE(public.format_person_name(sender_first_name, sender_last_name), '')
    OR receiver_name IS DISTINCT FROM COALESCE(public.format_person_name(receiver_first_name, receiver_last_name), '')
    OR sender_address IS DISTINCT FROM public.format_address(sender_lot_block, sender_street, sender_barangay, sender_city, sender_province, sender_landmark)
    OR receiver_address IS DISTINCT FROM public.format_address(receiver_lot_block, receiver_street, receiver_barangay, receiver_city, receiver_province, receiver_landmark);

-- ─── 6. Order insert guards: company capacity; no legacy-name references ───
CREATE OR REPLACE FUNCTION public.prepare_order_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  trip_row       public.trips%ROWTYPE;
  v_current_load NUMERIC;
  v_capacity     NUMERIC;
  v_capacity_allowance CONSTANT NUMERIC := 200;
BEGIN
  IF auth.uid() IS NOT NULL AND NEW.user_id <> auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Cannot create orders for another user';
  END IF;

  -- Name policy (20260922160000). A blank last_name is tolerated (mononyms);
  -- a non-blank part must be valid. A legacy combined-name-only insert is
  -- split and validated by orders_zz_sync_legacy_display_columns (stage 1).
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

  NEW.tracking_number := public.generate_order_tracking_number();
  NEW.actual_weight := NULL;
  NEW.payment_method := NULL;
  NEW.payment_status := 'unpaid';
  NEW.amount_paid := 0;
  NEW.promised_payment_date := NULL;
  NEW.payment_reference := NULL;
  NEW.pickup_photos := '[]'::jsonb;
  NEW.delivery_photos := '[]'::jsonb;
  NEW.cancellation_details := NULL;
  NEW.discount_amount     := 0;
  NEW.discount_reason     := NULL;
  NEW.discount_notes      := NULL;
  NEW.discount_applied_by := NULL;
  NEW.discount_applied_at := NULL;

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

    -- Capacity: company_information.default_capacity + the unchanged 200 kg
    -- allowance (frontend TRIP_CAPACITY_ALLOWANCE_KG).
    v_capacity := public.company_default_capacity();
    IF v_capacity > 0 THEN
      SELECT COALESCE(SUM(COALESCE(o.actual_weight, 0)), 0)
        INTO v_current_load
        FROM public.orders o
       WHERE o.trip_id = NEW.trip_id
         AND o.status <> 'Cancelled';

      IF v_current_load > (v_capacity + v_capacity_allowance) THEN
        RAISE EXCEPTION
          'Cannot accept booking: exceeds maximum van capacity of % kg (% kg planned + % kg allowance). This trip is carrying % kg.',
          v_capacity + v_capacity_allowance, v_capacity, v_capacity_allowance, v_current_load;
      END IF;
    END IF;

    NEW.status := 'Assigned';
    NEW.origin := trip_row.origin;
    NEW.destination := trip_row.destination;
  ELSE
    NEW.status := 'Pending';
  END IF;

  -- No weight, no price. guard_order_update prices the order the moment an
  -- admin records actual_weight at pickup.
  NEW.shipping_cost := 0;
  NEW.remaining_balance := 0;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_customer_order_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip_status    TEXT;
  v_departure_date TIMESTAMPTZ;
  v_capacity       NUMERIC;
  v_current_load   NUMERIC;
  v_capacity_allowance CONSTANT NUMERIC := 200;
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  NEW.featured_on_website := false;
  NEW.featured_title := NULL;
  NEW.featured_caption := NULL;
  NEW.featured_image_type := NULL;
  NEW.featured_at := NULL;

  IF NEW.trip_id IS NOT NULL THEN
    SELECT t.status, t.departure_date
      INTO v_trip_status, v_departure_date
      FROM public.trips AS t
     WHERE t.id = NEW.trip_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected trip does not exist';
    END IF;

    IF v_trip_status <> 'scheduled'
       OR public.ph_calendar_day(now()) > public.ph_calendar_day(v_departure_date) THEN
      RAISE EXCEPTION 'This trip is no longer accepting bookings';
    END IF;

    v_capacity := public.company_default_capacity();
    IF v_capacity > 0 THEN
      SELECT COALESCE(SUM(COALESCE(o.actual_weight, 0)), 0)
        INTO v_current_load
        FROM public.orders o
       WHERE o.trip_id = NEW.trip_id
         AND o.status <> 'Cancelled';

      IF v_current_load > (v_capacity + v_capacity_allowance) THEN
        RAISE EXCEPTION 'This trip is full and cannot accept more bookings.';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- ─── 7. Order update guard: pricing, capacity, details lock ─────────────────
CREATE OR REPLACE FUNCTION public.guard_order_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  trip_row       public.trips%ROWTYPE;
  v_current_load NUMERIC;
  v_capacity     NUMERIC;
  v_capacity_allowance CONSTANT NUMERIC := 200;
  v_payable      NUMERIC;
BEGIN
  -- ── Cancellation review hold ──────────────────────────────────────────────
  IF OLD.status = 'Pending Cancellation'
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status NOT IN ('Cancelled', COALESCE(OLD.cancellation_details->>'previous_status', 'Pending'))
  THEN
    RAISE EXCEPTION
      'Order % has a cancellation request awaiting review. Approve or reject it before changing its status.',
      NEW.tracking_number;
  END IF;

  -- ── Name policy (20260922160000), on CHANGE only ─────────────────────────
  IF NEW.sender_first_name IS DISTINCT FROM OLD.sender_first_name
     AND NULLIF(btrim(NEW.sender_first_name), '') IS NOT NULL
     AND NOT public.is_valid_person_name(NEW.sender_first_name) THEN
    RAISE EXCEPTION 'Sender first name may only contain letters, spaces, periods, hyphens and apostrophes.'
      USING ERRCODE = '22023';
  END IF;
  IF NEW.sender_last_name IS DISTINCT FROM OLD.sender_last_name
     AND NULLIF(btrim(NEW.sender_last_name), '') IS NOT NULL
     AND NOT public.is_valid_person_name(NEW.sender_last_name) THEN
    RAISE EXCEPTION 'Sender last name may only contain letters, spaces, periods, hyphens and apostrophes.'
      USING ERRCODE = '22023';
  END IF;
  IF NEW.receiver_first_name IS DISTINCT FROM OLD.receiver_first_name
     AND NULLIF(btrim(NEW.receiver_first_name), '') IS NOT NULL
     AND NOT public.is_valid_person_name(NEW.receiver_first_name) THEN
    RAISE EXCEPTION 'Receiver first name may only contain letters, spaces, periods, hyphens and apostrophes.'
      USING ERRCODE = '22023';
  END IF;
  IF NEW.receiver_last_name IS DISTINCT FROM OLD.receiver_last_name
     AND NULLIF(btrim(NEW.receiver_last_name), '') IS NOT NULL
     AND NOT public.is_valid_person_name(NEW.receiver_last_name) THEN
    RAISE EXCEPTION 'Receiver last name may only contain letters, spaces, periods, hyphens and apostrophes.'
      USING ERRCODE = '22023';
  END IF;

  -- ── Contact/address details lock — now keyed on the authoritative parts
  --    (lot/block included; previously covered only via the full address).
  IF (NEW.sender_first_name, NEW.sender_last_name, NEW.sender_phone, NEW.sender_province,
      NEW.sender_city, NEW.sender_barangay, NEW.sender_street, NEW.sender_lot_block, NEW.sender_landmark,
      NEW.receiver_first_name, NEW.receiver_last_name, NEW.receiver_phone, NEW.receiver_province,
      NEW.receiver_city, NEW.receiver_barangay, NEW.receiver_street, NEW.receiver_lot_block, NEW.receiver_landmark)
     IS DISTINCT FROM
     (OLD.sender_first_name, OLD.sender_last_name, OLD.sender_phone, OLD.sender_province,
      OLD.sender_city, OLD.sender_barangay, OLD.sender_street, OLD.sender_lot_block, OLD.sender_landmark,
      OLD.receiver_first_name, OLD.receiver_last_name, OLD.receiver_phone, OLD.receiver_province,
      OLD.receiver_city, OLD.receiver_barangay, OLD.receiver_street, OLD.receiver_lot_block, OLD.receiver_landmark)
  THEN
    IF public.is_admin() THEN
      IF OLD.status IN ('Out for Delivery', 'Delivered') THEN
        RAISE EXCEPTION 'Customer details are locked once the booking is out for delivery. (current status: %)', OLD.status;
      END IF;
    ELSE
      IF OLD.status IN ('Out for Delivery', 'Delivered', 'Cancelled') THEN
        RAISE EXCEPTION 'Customer details are locked once the booking is out for delivery. (current status: %)', OLD.status;
      END IF;
    END IF;
  END IF;

  IF NEW.trip_id IS NOT NULL AND NEW.status <> 'Cancelled' THEN
    SELECT * INTO trip_row FROM public.trips WHERE id = NEW.trip_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected trip does not exist';
    END IF;

    NEW.origin := trip_row.origin;
    NEW.destination := trip_row.destination;

    -- ── Capacity: company default + unchanged 200 kg allowance ──────────────
    -- Checked when cargo is ADDED to a trip: a (re)assignment, or a weight
    -- INCREASE. A weight correction that keeps or lowers the order's weight
    -- is always allowed, so an admin who lowers the company capacity below a
    -- trip's recorded load can still correct weights, pick up and deliver
    -- the cargo already on it — nothing is unassigned or deleted; only new
    -- load is refused until the trip is back under the limit.
    v_capacity := public.company_default_capacity();
    IF v_capacity > 0
       AND (OLD.trip_id IS DISTINCT FROM NEW.trip_id
            OR COALESCE(NEW.actual_weight, 0) > COALESCE(OLD.actual_weight, 0))
    THEN
      SELECT COALESCE(SUM(COALESCE(o.actual_weight, 0)), 0)
        INTO v_current_load
        FROM public.orders o
       WHERE o.trip_id = NEW.trip_id
         AND o.id <> NEW.id
         AND o.status <> 'Cancelled';

      IF (v_current_load + COALESCE(NEW.actual_weight, 0)) > (v_capacity + v_capacity_allowance) THEN
        RAISE EXCEPTION
          'Cannot accept booking: exceeds maximum van capacity of % kg (% kg planned + % kg allowance). This trip is carrying % kg.',
          v_capacity + v_capacity_allowance, v_capacity, v_capacity_allowance, v_current_load;
      END IF;
    END IF;

    IF OLD.trip_id IS DISTINCT FROM NEW.trip_id AND NEW.status = 'Pending' THEN
      NEW.status := 'Assigned';
    END IF;
  END IF;

  -- ── Pricing ──────────────────────────────────────────────────────────────
  -- The charge is recorded when the weight is recorded, at the CURRENT
  -- company rate. Every other update — a payment or refund (amount_paid via
  -- update_order_payment_totals), a discount, a trip reassignment, a status
  -- change, or a direct write attempt — keeps the recorded shipping_cost.
  IF NEW.actual_weight IS DISTINCT FROM OLD.actual_weight THEN
    NEW.shipping_cost := ROUND(COALESCE(NEW.actual_weight, 0) * public.global_price_per_kilo(), 2);
  ELSE
    NEW.shipping_cost := OLD.shipping_cost;
  END IF;

  IF NEW.actual_weight IS DISTINCT FROM OLD.actual_weight
     OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
     OR NEW.amount_paid IS DISTINCT FROM OLD.amount_paid
     OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount THEN

    -- ── Discount guard (unchanged) ──────────────────────────────────────────
    IF NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
       OR NEW.discount_reason IS DISTINCT FROM OLD.discount_reason
       OR NEW.discount_notes  IS DISTINCT FROM OLD.discount_notes THEN

      IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Admin access required to change a shipping discount.';
      END IF;

      IF OLD.status NOT IN ('Pending Review', 'Pending', 'Assigned') THEN
        RAISE EXCEPTION 'A discount can only be set or changed before pickup is confirmed.';
      END IF;

      IF EXISTS (
        SELECT 1 FROM public.payment_transactions
         WHERE order_id = NEW.id AND payment_status IN ('paid', 'partial')
      ) THEN
        RAISE EXCEPTION 'This order already has a recorded payment; its discount can no longer be changed.';
      END IF;

      IF COALESCE(NEW.discount_amount, 0) < 0 THEN
        RAISE EXCEPTION 'Discount cannot be negative.';
      END IF;

      IF NEW.discount_amount > NEW.shipping_cost THEN
        RAISE EXCEPTION 'Discount of ₱% cannot exceed the original shipping fee of ₱%.',
          TO_CHAR(NEW.discount_amount, 'FM999999990.00'), TO_CHAR(NEW.shipping_cost, 'FM999999990.00');
      END IF;

      IF NEW.discount_amount > 0 THEN
        IF NEW.discount_reason IS NULL OR NEW.discount_reason NOT IN ('Regular customer', 'Negotiated price', 'Other') THEN
          RAISE EXCEPTION 'A discount requires a reason: Regular customer, Negotiated price, or Other.';
        END IF;
        IF NEW.discount_reason = 'Other' AND NULLIF(btrim(NEW.discount_notes), '') IS NULL THEN
          RAISE EXCEPTION 'Please explain the discount reason when "Other" is selected.';
        END IF;
        NEW.discount_applied_by := auth.uid();
        NEW.discount_applied_at := now();
      ELSE
        NEW.discount_amount     := 0;
        NEW.discount_reason     := NULL;
        NEW.discount_notes      := NULL;
        NEW.discount_applied_by := NULL;
        NEW.discount_applied_at := NULL;
      END IF;
    END IF;

    v_payable := public.order_payable_amount(NEW.shipping_cost, NEW.discount_amount);
    NEW.remaining_balance := GREATEST(0, v_payable - COALESCE(NEW.amount_paid, 0));
    NEW.payment_status := public.derive_payment_status(v_payable, NEW.amount_paid);
  END IF;

  -- ── Warehouse dispatch gate (unchanged) ──────────────────────────────────
  IF NEW.status = 'Out for Delivery' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF COALESCE(NEW.actual_weight, 0) <= 0 THEN
      RAISE EXCEPTION
        'Cannot dispatch order % — it has not been weighed, so it has no price yet. Record the actual weight first.',
        NEW.tracking_number;
    END IF;

    IF COALESCE(NEW.payer_type, 'sender') <> 'receiver'
       AND COALESCE(NEW.remaining_balance, 0) > 0
       AND NEW.promised_payment_date IS NULL
    THEN
      RAISE EXCEPTION
        'Cannot dispatch order % — ₱% is still owing. Settle the balance, or record a Promise Date to dispatch anyway.',
        NEW.tracking_number,
        TO_CHAR(COALESCE(NEW.remaining_balance, 0), 'FM999999990.00');
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- ─── 8. Contact-details editing: structured parts only ──────────────────────
-- New RPC: lot/block added, full-address parameters removed. It has a new
-- name because its argument types (uuid + 18 text) are identical to the old
-- function's, so Postgres could not hold both under one name.
CREATE OR REPLACE FUNCTION public.update_order_contact_parts(
  p_order_id uuid,
  p_sender_first_name text, p_sender_last_name text, p_sender_phone text,
  p_sender_province text, p_sender_city text, p_sender_barangay text,
  p_sender_street text, p_sender_lot_block text, p_sender_landmark text,
  p_receiver_first_name text, p_receiver_last_name text, p_receiver_phone text,
  p_receiver_province text, p_receiver_city text, p_receiver_barangay text,
  p_receiver_street text, p_receiver_lot_block text, p_receiver_landmark text
)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_order public.orders%ROWTYPE;
  v_is_admin BOOLEAN;
  v_actor TEXT;
  v_previous JSONB;
  v_new JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- Lot/block is optional (not every address has one); everything else is required.
  IF NULLIF(btrim(p_sender_first_name), '') IS NULL OR NULLIF(btrim(p_sender_last_name), '') IS NULL
     OR NULLIF(btrim(p_sender_phone), '') IS NULL
     OR NULLIF(btrim(p_sender_province), '') IS NULL OR NULLIF(btrim(p_sender_city), '') IS NULL
     OR NULLIF(btrim(p_sender_barangay), '') IS NULL OR NULLIF(btrim(p_sender_street), '') IS NULL
     OR NULLIF(btrim(p_sender_landmark), '') IS NULL
     OR NULLIF(btrim(p_receiver_first_name), '') IS NULL OR NULLIF(btrim(p_receiver_last_name), '') IS NULL
     OR NULLIF(btrim(p_receiver_phone), '') IS NULL
     OR NULLIF(btrim(p_receiver_province), '') IS NULL OR NULLIF(btrim(p_receiver_city), '') IS NULL
     OR NULLIF(btrim(p_receiver_barangay), '') IS NULL OR NULLIF(btrim(p_receiver_street), '') IS NULL
     OR NULLIF(btrim(p_receiver_landmark), '') IS NULL THEN
    RAISE EXCEPTION 'First name, last name, phone, province, city, barangay, street and landmark are all required for both sender and receiver.';
  END IF;

  v_is_admin := public.is_admin();

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;

  IF NOT v_is_admin THEN
    IF v_order.status IN ('Out for Delivery', 'Delivered', 'Cancelled') THEN
      RAISE EXCEPTION 'Customer details are locked once the booking is out for delivery. (current status: %)', v_order.status;
    END IF;
    IF v_order.user_id <> auth.uid() THEN
      RAISE EXCEPTION 'Only your own bookings can be edited';
    END IF;
  ELSE
    IF v_order.status IN ('Out for Delivery', 'Delivered') THEN
      RAISE EXCEPTION 'Customer details are locked once the booking is out for delivery. (current status: %)', v_order.status;
    END IF;
  END IF;

  v_previous := jsonb_build_object(
    'sender_first_name', v_order.sender_first_name, 'sender_last_name', v_order.sender_last_name,
    'sender_phone', v_order.sender_phone,
    'sender_province', v_order.sender_province, 'sender_city', v_order.sender_city,
    'sender_barangay', v_order.sender_barangay, 'sender_street', v_order.sender_street,
    'sender_lot_block', COALESCE(v_order.sender_lot_block, ''), 'sender_landmark', v_order.sender_landmark,
    'receiver_first_name', v_order.receiver_first_name, 'receiver_last_name', v_order.receiver_last_name,
    'receiver_phone', v_order.receiver_phone,
    'receiver_province', v_order.receiver_province, 'receiver_city', v_order.receiver_city,
    'receiver_barangay', v_order.receiver_barangay, 'receiver_street', v_order.receiver_street,
    'receiver_lot_block', COALESCE(v_order.receiver_lot_block, ''), 'receiver_landmark', v_order.receiver_landmark
  );
  v_new := jsonb_build_object(
    'sender_first_name', btrim(p_sender_first_name), 'sender_last_name', btrim(p_sender_last_name),
    'sender_phone', btrim(p_sender_phone),
    'sender_province', btrim(p_sender_province), 'sender_city', btrim(p_sender_city),
    'sender_barangay', btrim(p_sender_barangay), 'sender_street', btrim(p_sender_street),
    'sender_lot_block', COALESCE(btrim(p_sender_lot_block), ''), 'sender_landmark', btrim(p_sender_landmark),
    'receiver_first_name', btrim(p_receiver_first_name), 'receiver_last_name', btrim(p_receiver_last_name),
    'receiver_phone', btrim(p_receiver_phone),
    'receiver_province', btrim(p_receiver_province), 'receiver_city', btrim(p_receiver_city),
    'receiver_barangay', btrim(p_receiver_barangay), 'receiver_street', btrim(p_receiver_street),
    'receiver_lot_block', COALESCE(btrim(p_receiver_lot_block), ''), 'receiver_landmark', btrim(p_receiver_landmark)
  );

  IF v_previous = v_new THEN
    RETURN v_order;
  END IF;

  UPDATE public.orders SET
    sender_first_name = btrim(p_sender_first_name),
    sender_last_name = btrim(p_sender_last_name),
    sender_phone = btrim(p_sender_phone),
    sender_province = btrim(p_sender_province),
    sender_city = btrim(p_sender_city),
    sender_barangay = btrim(p_sender_barangay),
    sender_street = btrim(p_sender_street),
    sender_lot_block = COALESCE(btrim(p_sender_lot_block), ''),
    sender_landmark = btrim(p_sender_landmark),
    receiver_first_name = btrim(p_receiver_first_name),
    receiver_last_name = btrim(p_receiver_last_name),
    receiver_phone = btrim(p_receiver_phone),
    receiver_province = btrim(p_receiver_province),
    receiver_city = btrim(p_receiver_city),
    receiver_barangay = btrim(p_receiver_barangay),
    receiver_street = btrim(p_receiver_street),
    receiver_lot_block = COALESCE(btrim(p_receiver_lot_block), ''),
    receiver_landmark = btrim(p_receiver_landmark)
  WHERE id = p_order_id
  RETURNING * INTO v_order;

  v_actor := CASE WHEN v_is_admin THEN 'Admin' ELSE 'Customer' END;

  INSERT INTO public.activity_logs (
    module, action, record_type, record_id, record_ref,
    previous_value, new_value, details
  ) VALUES (
    'Orders',
    v_actor || ' Updated Sender/Receiver Details',
    'order',
    v_order.id,
    v_order.tracking_number,
    v_previous,
    v_new,
    format('%s updated sender/receiver contact and address details.', v_actor)
  );

  RETURN v_order;
END;
$function$;

-- Old 19-argument signature (with free-text p_*_address) — compatibility for
-- cached older clients only. The free-text addresses are IGNORED (they can no
-- longer disagree with the parts); the order's current lot/block is kept.
-- Remove in a later cleanup once no old client can call it.
CREATE OR REPLACE FUNCTION public.update_order_contact_details(
  p_order_id uuid, p_sender_first_name text, p_sender_last_name text, p_sender_phone text,
  p_sender_province text, p_sender_city text, p_sender_barangay text, p_sender_street text,
  p_sender_landmark text, p_sender_address text, p_receiver_first_name text, p_receiver_last_name text,
  p_receiver_phone text, p_receiver_province text, p_receiver_city text, p_receiver_barangay text,
  p_receiver_street text, p_receiver_landmark text, p_receiver_address text
)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_lot_s text;
  v_lot_r text;
BEGIN
  SELECT o.sender_lot_block, o.receiver_lot_block INTO v_lot_s, v_lot_r
    FROM public.orders o WHERE o.id = p_order_id;
  RETURN public.update_order_contact_parts(
    p_order_id => p_order_id,
    p_sender_first_name => p_sender_first_name, p_sender_last_name => p_sender_last_name,
    p_sender_phone => p_sender_phone, p_sender_province => p_sender_province,
    p_sender_city => p_sender_city, p_sender_barangay => p_sender_barangay,
    p_sender_street => p_sender_street, p_sender_lot_block => v_lot_s,
    p_sender_landmark => p_sender_landmark,
    p_receiver_first_name => p_receiver_first_name, p_receiver_last_name => p_receiver_last_name,
    p_receiver_phone => p_receiver_phone, p_receiver_province => p_receiver_province,
    p_receiver_city => p_receiver_city, p_receiver_barangay => p_receiver_barangay,
    p_receiver_street => p_receiver_street, p_receiver_lot_block => v_lot_r,
    p_receiver_landmark => p_receiver_landmark);
END;
$function$;

REVOKE ALL ON FUNCTION public.update_order_contact_parts(uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_order_contact_parts(uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text) TO authenticated;

-- ─── 9. Public tracking: masked names derived from the parts ────────────────
-- Same return shape and same masking as before (first word + last-word initial).
CREATE OR REPLACE FUNCTION public.track_order_public(p_tracking_number text)
 RETURNS TABLE(tracking_number character varying, status character varying, sender_name text, receiver_name text, origin character varying, destination character varying, package_description text, actual_weight numeric, estimated_delivery timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone, trip_departure_date timestamp with time zone, trip_departure_at timestamp with time zone, trip_estimated_arrival_at timestamp with time zone, trip_arrived_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    o.tracking_number,
    o.status,
    public.mask_name(public.format_person_name(o.sender_first_name, o.sender_last_name))     AS sender_name,
    public.mask_name(public.format_person_name(o.receiver_first_name, o.receiver_last_name)) AS receiver_name,
    o.origin,
    o.destination,
    CASE
      WHEN length(o.package_description) > 40
        THEN left(o.package_description, 40) || '…'
      ELSE o.package_description
    END                               AS package_description,
    o.actual_weight,
    t.arrival_date                    AS estimated_delivery,
    o.created_at,
    o.updated_at,
    t.departure_date                  AS trip_departure_date,
    t.departure_at                    AS trip_departure_at,
    t.estimated_arrival_at            AS trip_estimated_arrival_at,
    t.arrived_at                      AS trip_arrived_at
  FROM public.orders AS o
  LEFT JOIN public.trips AS t ON t.id = o.trip_id
  WHERE o.tracking_number = UPPER(TRIM(p_tracking_number))
  LIMIT 1;
$function$;

-- ─── 10. Contact inquiries: rate limiting without the legacy `phone` ────────
-- Limits (all applied together; previously the phone limit was skipped
-- whenever an IP was present):
--   * per network (server-derived ip, set only by submit-inquiry): 5 / 10 min
--   * per phone (digits, last 10 — 0917… and +63917… are one number): 3 / 10 min
--   * per email (lower-cased, trimmed):                                 3 / 10 min
--   * global:                                                           15 / 1 min
-- A transaction-scoped advisory lock serializes inquiry inserts so two
-- concurrent submissions cannot both read the same pre-insert count.
CREATE OR REPLACE FUNCTION public.contact_phone_key(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path TO ''
AS $$ SELECT NULLIF(right(regexp_replace(COALESCE(p, ''), '[^0-9]', '', 'g'), 10), '') $$;

CREATE OR REPLACE FUNCTION public.guard_contact_inquiry_rate_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_phone_key text;
  v_email_key text;
BEGIN
  NEW.name := btrim(NEW.name);
  NEW.message := btrim(NEW.message);
  NEW.contact_phone := NULLIF(btrim(NEW.contact_phone), '');
  NEW.contact_email := NULLIF(btrim(NEW.contact_email), '');
  IF NEW.ip IS NOT NULL THEN NEW.ip := NULLIF(btrim(NEW.ip), ''); END IF;

  v_phone_key := public.contact_phone_key(NEW.contact_phone);
  v_email_key := lower(NEW.contact_email);

  PERFORM pg_advisory_xact_lock(hashtext('public.contact_inquiries:rate_limit'));

  IF NEW.ip IS NOT NULL THEN
    IF (SELECT COUNT(*) FROM public.contact_inquiries
         WHERE ip = NEW.ip AND created_at > now() - interval '10 minutes') >= 5 THEN
      RAISE EXCEPTION 'Too many inquiries from your network. Please wait 10 minutes before submitting again.' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_phone_key IS NOT NULL THEN
    IF (SELECT COUNT(*) FROM public.contact_inquiries
         WHERE public.contact_phone_key(contact_phone) = v_phone_key
           AND created_at > now() - interval '10 minutes') >= 3 THEN
      RAISE EXCEPTION 'Too many inquiries from this phone number. Please wait 10 minutes before submitting again.' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_email_key IS NOT NULL THEN
    IF (SELECT COUNT(*) FROM public.contact_inquiries
         WHERE lower(btrim(contact_email)) = v_email_key
           AND created_at > now() - interval '10 minutes') >= 3 THEN
      RAISE EXCEPTION 'Too many inquiries from this email address. Please wait 10 minutes before submitting again.' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF (SELECT COUNT(*) FROM public.contact_inquiries WHERE created_at > now() - interval '1 minute') >= 15 THEN
    RAISE EXCEPTION 'Too many inquiries right now. Please try again in a minute.' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE INDEX IF NOT EXISTS idx_contact_inquiries_created_at
  ON public.contact_inquiries (created_at);

-- The normalized columns are now the only contact channel. `phone` stops
-- being required (dropped in stage 2 once submit-inquiry stops writing it).
ALTER TABLE public.contact_inquiries ALTER COLUMN phone DROP NOT NULL;

ALTER TABLE public.contact_inquiries
  DROP CONSTRAINT IF EXISTS contact_inquiries_has_contact_channel,
  ADD CONSTRAINT contact_inquiries_has_contact_channel
    CHECK (contact_phone IS NOT NULL OR contact_email IS NOT NULL) NOT VALID;
ALTER TABLE public.contact_inquiries
  DROP CONSTRAINT IF EXISTS contact_inquiries_contact_phone_length,
  ADD CONSTRAINT contact_inquiries_contact_phone_length
    CHECK (contact_phone IS NULL OR char_length(contact_phone) BETWEEN 6 AND 30) NOT VALID;
ALTER TABLE public.contact_inquiries
  DROP CONSTRAINT IF EXISTS contact_inquiries_contact_email_length,
  ADD CONSTRAINT contact_inquiries_contact_email_length
    CHECK (contact_email IS NULL OR char_length(contact_email) BETWEEN 6 AND 254) NOT VALID;
ALTER TABLE public.contact_inquiries VALIDATE CONSTRAINT contact_inquiries_has_contact_channel;
ALTER TABLE public.contact_inquiries VALIDATE CONSTRAINT contact_inquiries_contact_phone_length;
ALTER TABLE public.contact_inquiries VALIDATE CONSTRAINT contact_inquiries_contact_email_length;

-- ─── 11. Report / notification functions: names derived from the parts ─────

CREATE OR REPLACE FUNCTION public.evidence_photo_rows()
 RETURNS TABLE(item_key text, source text, order_id uuid, tracking_number text, customer_name text, order_status text, photo_field text, provider text, storage_path text, size_bytes bigint, content_type text, taken_at timestamp with time zone, status text, reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Not granted to anon/authenticated directly (see grants at the bottom) —
  -- only list_evidence_folders()/list_folder_photos() call it, and a
  -- SECURITY DEFINER caller's own admin check below is what actually gates
  -- this, same defense-in-depth reasoning as every other function here.
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH order_refs AS (
    SELECT
      o.id AS order_id,
      o.tracking_number::text AS tracking_number,
      COALESCE(public.format_person_name(o.receiver_first_name, o.receiver_last_name), public.format_person_name(o.sender_first_name, o.sender_last_name))::text AS customer_name,
      o.status::text AS order_status,
      o.featured_on_website,
      field.photo_field,
      elem.value AS raw_ref,
      -- payment_attempts has no delivery_photos column, so this can only
      -- ever matter for a pickup photo. Compared by classified
      -- (provider, storage_path) identity, not raw jsonb equality, so a
      -- descriptor carrying extra/reordered fields still matches correctly
      -- — same reasoning as the array-rebuild loop in delete_evidence_photos.
      (field.photo_field = 'pickup' AND EXISTS (
        SELECT 1
        FROM public.payment_attempts pa
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pa.pickup_photos, '[]'::jsonb)) pe(value)
        CROSS JOIN LATERAL public.classify_evidence_photo_ref(pe.value) pc
        CROSS JOIN LATERAL public.classify_evidence_photo_ref(elem.value) oc
        WHERE pa.order_id = o.id
          AND pa.status IN ('pending', 'chargeable')
          AND pc.provider = oc.provider
          AND pc.storage_path = oc.storage_path
      )) AS has_pending_payment_attempt
    FROM public.orders o
    CROSS JOIN LATERAL (VALUES ('pickup', o.pickup_photos), ('delivery', o.delivery_photos))
      AS field(photo_field, arr)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(field.arr, '[]'::jsonb)) AS elem(value)
  ),
  receipt_refs AS (
    SELECT
      o.id AS order_id,
      o.tracking_number::text AS tracking_number,
      COALESCE(public.format_person_name(o.receiver_first_name, o.receiver_last_name), public.format_person_name(o.sender_first_name, o.sender_last_name))::text AS customer_name,
      o.status::text AS order_status,
      o.featured_on_website,
      'receipt'::text AS photo_field,
      public.text_to_photo_ref(t.receipt_url) AS raw_ref,
      false AS has_pending_payment_attempt
    FROM public.payment_transactions t
    JOIN public.orders o ON o.id = t.order_id
    WHERE t.receipt_url IS NOT NULL AND btrim(t.receipt_url) <> ''
  ),
  referenced AS (
    SELECT * FROM order_refs
    UNION ALL
    SELECT * FROM receipt_refs
  ),
  classified_referenced AS (
    SELECT
      r.order_id, r.tracking_number, r.customer_name, r.photo_field,
      r.featured_on_website, r.order_status, r.has_pending_payment_attempt,
      c.provider, c.storage_path, c.size_bytes, c.content_type, c.taken_at
    FROM referenced r
    CROSS JOIN LATERAL public.classify_evidence_photo_ref(r.raw_ref) c
    WHERE c.provider IS NOT NULL
  ),
  referenced_rows AS (
    SELECT
      (cr.provider || ':' || cr.storage_path) AS item_key,
      'order'::text AS source,
      cr.order_id,
      cr.tracking_number,
      cr.customer_name,
      cr.order_status,
      cr.photo_field,
      cr.provider,
      cr.storage_path,
      cr.size_bytes,
      cr.content_type,
      cr.taken_at,
      CASE
        WHEN cr.photo_field = 'receipt' THEN 'protected'
        WHEN cr.featured_on_website THEN 'protected'
        WHEN cr.order_status NOT IN ('Delivered', 'Cancelled') THEN 'protected'
        WHEN cr.has_pending_payment_attempt THEN 'protected'
        ELSE 'eligible'
      END AS status,
      CASE
        WHEN cr.photo_field = 'receipt' THEN 'Receipt photo — kept as a financial record'
        WHEN cr.featured_on_website THEN 'Featured on the public website'
        WHEN cr.order_status NOT IN ('Delivered', 'Cancelled') THEN 'Shipment is still in progress'
        WHEN cr.has_pending_payment_attempt THEN 'A payment for this booking is still being reconciled'
        ELSE 'Delivered/Cancelled — can be deleted manually'
      END AS reason
    FROM classified_referenced cr
  ),
  orphaned_rows AS (
    SELECT
      ('supabase:' || o.name) AS item_key,
      'orphan'::text AS source,
      NULL::uuid AS order_id,
      NULL::text AS tracking_number,
      NULL::text AS customer_name,
      NULL::text AS order_status,
      CASE (storage.foldername(o.name))[1]
        WHEN 'pickup-proofs' THEN 'pickup'
        WHEN 'delivery-proofs' THEN 'delivery'
        WHEN 'receipts' THEN 'receipt'
        ELSE NULL
      END AS photo_field,
      'supabase'::text AS provider,
      o.name AS storage_path,
      CASE WHEN o.metadata ->> 'size' ~ '^[0-9]+$' THEN (o.metadata ->> 'size')::bigint ELSE NULL END AS size_bytes,
      o.metadata ->> 'mimetype' AS content_type,
      o.created_at AS taken_at,
      'eligible'::text AS status,
      'No matching booking was found for this photo'::text AS reason
    FROM storage.objects o
    WHERE o.bucket_id = 'cargo-photos'
      AND (storage.foldername(o.name))[1] IN ('pickup-proofs', 'delivery-proofs', 'receipts')
      AND (storage.foldername(o.name))[2] IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.orders ord WHERE ord.tracking_number = (storage.foldername(o.name))[2]
      )
  )
  SELECT * FROM referenced_rows
  UNION ALL
  SELECT * FROM orphaned_rows;
END;
$function$;
CREATE OR REPLACE FUNCTION public.get_financial_report_data(p_start_date timestamp with time zone, p_end_date timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  payload JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  WITH payments AS (
    SELECT id, order_id, amount, LOWER(TRIM(payment_method)) as method, created_at as event_date, payment_status, transaction_reference
    FROM payment_transactions
    WHERE payment_status IN ('paid', 'partial')
      AND created_at >= p_start_date AND created_at < p_end_date
  ),
  refunds AS (
    SELECT pr.id, pr.order_id, pr.amount, LOWER(TRIM(pt.payment_method)) as method,
           COALESCE(pr.succeeded_at, pr.provider_updated_at, pr.updated_at) as event_date,
           pr.payment_id, pr.refund_id
    FROM payment_refunds pr
    JOIN payment_transactions pt ON pr.payment_transaction_id = pt.id
    WHERE pr.status = 'succeeded'
      AND COALESCE(pr.succeeded_at, pr.provider_updated_at, pr.updated_at) >= p_start_date
      AND COALESCE(pr.succeeded_at, pr.provider_updated_at, pr.updated_at) < p_end_date
  ),
  delivered_orders AS (
    SELECT o.id, o.tracking_number, public.format_person_name(o.sender_first_name, o.sender_last_name) AS sender_name, public.format_person_name(o.receiver_first_name, o.receiver_last_name) AS receiver_name, o.origin, o.destination,
           o.shipping_cost, o.discount_amount, o.amount_paid, o.payment_status,
           GREATEST(o.shipping_cost - COALESCE(o.discount_amount, 0), 0) AS final_fee,
           GREATEST(GREATEST(o.shipping_cost - COALESCE(o.discount_amount, 0), 0) - COALESCE(o.amount_paid, 0), 0) AS balance,
           (SELECT MAX(changed_at) FROM order_status_events ose WHERE ose.order_id = o.id AND ose.status = 'Delivered') as delivered_at
    FROM orders o
    WHERE o.status = 'Delivered'
      AND EXISTS (
        SELECT 1 FROM order_status_events ose
        WHERE ose.order_id = o.id
          AND ose.status = 'Delivered'
          AND ose.changed_at >= p_start_date
          AND ose.changed_at < p_end_date
      )
  ),
  gross_collected AS (
    SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE method != 'paylater'
  ),
  successful_refunds AS (
    SELECT COALESCE(SUM(amount), 0) as total FROM refunds
  ),
  delivered_value AS (
    SELECT COALESCE(SUM(final_fee), 0) as total FROM delivered_orders
  ),
  method_union AS (
    SELECT method, amount as gross, 1 as p_count, 0 as ref_amt, 0 as r_count FROM payments WHERE method != 'paylater'
    UNION ALL
    SELECT method, 0 as gross, 0 as p_count, amount as ref_amt, 1 as r_count FROM refunds
  ),
  method_totals AS (
    SELECT method,
           SUM(gross) as gross,
           SUM(p_count) as payment_count,
           SUM(ref_amt) as refunds,
           SUM(r_count) as refund_count,
           SUM(gross) - SUM(ref_amt) as net
    FROM method_union
    GROUP BY method
  ),
  daily_union AS (
    SELECT (created_at AT TIME ZONE 'Asia/Manila')::date as day, amount as gross, 0 as ref_amt
    FROM payment_transactions
    WHERE payment_status IN ('paid', 'partial') AND LOWER(TRIM(payment_method)) != 'paylater'
      AND created_at >= p_start_date AND created_at < p_end_date
    UNION ALL
    SELECT (COALESCE(succeeded_at, provider_updated_at, updated_at) AT TIME ZONE 'Asia/Manila')::date as day, 0 as gross, amount as ref_amt
    FROM payment_refunds
    WHERE status = 'succeeded'
      AND COALESCE(succeeded_at, provider_updated_at, updated_at) >= p_start_date
      AND COALESCE(succeeded_at, provider_updated_at, updated_at) < p_end_date
  ),
  daily_chart AS (
    SELECT day, SUM(gross) - SUM(ref_amt) as net
    FROM daily_union
    GROUP BY day
    ORDER BY day
  ),
  combined_details AS (
    SELECT 'payment' as type, id, order_id, amount, method, event_date, transaction_reference as ref_id
    FROM payments
    UNION ALL
    SELECT 'refund' as type, id, order_id, amount, method, event_date, refund_id as ref_id
    FROM refunds
    ORDER BY event_date DESC
  )
  SELECT jsonb_build_object(
    'grossCollected', (SELECT total FROM gross_collected),
    'successfulRefunds', (SELECT total FROM successful_refunds),
    'netCollected', (SELECT total FROM gross_collected) - (SELECT total FROM successful_refunds),
    'deliveredShipmentValue', (SELECT total FROM delivered_value),
    'methodTotals', COALESCE((SELECT jsonb_agg(to_jsonb(mt)) FROM method_totals mt), '[]'::jsonb),
    'dailyChart', COALESCE((SELECT jsonb_agg(to_jsonb(dc)) FROM daily_chart dc), '[]'::jsonb),
    'completedDeliveries', COALESCE((SELECT jsonb_agg(to_jsonb(do_rows)) FROM delivered_orders do_rows), '[]'::jsonb),
    'paymentRefundDetail', COALESCE((SELECT jsonb_agg(to_jsonb(cd)) FROM combined_details cd), '[]'::jsonb)
  ) INTO payload;

  RETURN payload;
END;
$function$;
CREATE OR REPLACE FUNCTION public.create_admin_notifications_rpc(p_title text, p_message text, p_type text, p_reference_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(admin_id uuid, notification_id uuid, notification_title text, notification_message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_title TEXT;
  v_message TEXT;
  v_tracking_number TEXT;
  v_sender_name TEXT;
  v_rating INTEGER;
  v_feedback_message TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_type = 'order_update' THEN
    SELECT o.tracking_number, public.format_person_name(o.sender_first_name, o.sender_last_name)
      INTO v_tracking_number, v_sender_name
      FROM public.orders AS o
     WHERE o.id = p_reference_id
       AND o.user_id = auth.uid();

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Notification reference is not owned by the caller';
    END IF;

    v_title := 'New Booking';
    v_message := format(
      'New order %s from %s',
      v_tracking_number,
      COALESCE(NULLIF(btrim(v_sender_name), ''), 'Customer')
    );
  ELSIF p_type = 'feedback' THEN
    SELECT f.rating, f.message
      INTO v_rating, v_feedback_message
      FROM public.customer_feedback AS f
      JOIN public.orders AS o ON o.id = f.order_id
     WHERE f.order_id = p_reference_id
       AND f.customer_id = auth.uid()
       AND o.user_id = auth.uid()
       AND o.status = 'Delivered';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Notification reference is not an owned delivered-order feedback';
    END IF;

    v_title := 'New Customer Feedback';
    v_message := format(
      '%s? rating%s',
      v_rating,
      CASE
        WHEN NULLIF(btrim(v_feedback_message), '') IS NULL THEN ''
        ELSE ': ' || left(btrim(v_feedback_message), 60)
      END
    );
  ELSE
    RAISE EXCEPTION 'Unsupported customer notification event';
  END IF;

  -- One notification fan-out per event key. The advisory lock closes the
  -- race where two browser callbacks arrive in the same millisecond.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_type || ':' || COALESCE(p_reference_id::TEXT, ''), 0)
  );
  IF EXISTS (
    SELECT 1
      FROM public.notifications AS n
     WHERE n.type = p_type
       AND n.reference_id = p_reference_id
       AND n.created_at > now() - INTERVAL '10 minutes'
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH inserted AS (
    INSERT INTO public.notifications (user_id, title, message, type, reference_id)
    SELECT p.id, v_title, v_message, p_type, p_reference_id
      FROM public.profiles AS p
     WHERE p.role = 'admin'
    RETURNING id, user_id
  )
  SELECT user_id, id, v_title, v_message FROM inserted;
END;
$function$;
CREATE OR REPLACE FUNCTION private.notify_new_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  SELECT
    p.id,
    'Booking Received',
    format('Your booking %s was received. We will keep you updated as it moves.', NEW.tracking_number),
    'general',
    NEW.id
  FROM public.profiles AS p
  WHERE p.id = NEW.user_id
    AND p.role = 'customer'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  SELECT
    p.id,
    'New Booking',
    format(
      'New order %s from %s',
      NEW.tracking_number,
      COALESCE(public.format_person_name(NEW.sender_first_name, NEW.sender_last_name), 'Customer')
    ),
    'order_update',
    NEW.id
  FROM public.profiles AS p
  WHERE p.role = 'admin'
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$function$;
COMMIT;
