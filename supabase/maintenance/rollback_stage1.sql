-- ============================================================================
-- supabase/maintenance/rollback_stage1.sql — NOT EXECUTED.
--
-- Reverts 20260926100000_simplify_stage1_derive_and_compat.sql, restoring the
-- function definitions exactly as they were LIVE on 2026-09-25 (generated
-- from scripts/db-simplification-pgtest/live-schema.sql). Valid ONLY while
-- stage 2 has NOT been applied (the stored columns must still exist).
--
-- If rolled back, the previous frontend and Edge Functions must be redeployed
-- as well (the new frontend calls update_order_contact_parts, which this
-- removes). Verified by scripts/db-simplification-pgtest/run.mjs.
-- ============================================================================
BEGIN;

-- contact_inquiries.phone was made nullable. The legacy function below needs
-- it again; rows written by the new submit-inquiry have phone NULL, so fill
-- them from the normalized columns before restoring NOT NULL.
UPDATE public.contact_inquiries
   SET phone = left(concat_ws(' | ', contact_phone, contact_email), 100)
 WHERE phone IS NULL;
ALTER TABLE public.contact_inquiries ALTER COLUMN phone SET NOT NULL;
ALTER TABLE public.contact_inquiries
  DROP CONSTRAINT IF EXISTS contact_inquiries_has_contact_channel,
  DROP CONSTRAINT IF EXISTS contact_inquiries_contact_phone_length,
  DROP CONSTRAINT IF EXISTS contact_inquiries_contact_email_length;
DROP INDEX IF EXISTS public.idx_contact_inquiries_created_at;

DROP TRIGGER IF EXISTS orders_zz_sync_legacy_display_columns ON public.orders;
DROP FUNCTION IF EXISTS private.sync_order_legacy_display_columns();
DROP FUNCTION IF EXISTS public.update_order_contact_parts(uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text);

-- Restored live definitions
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
CREATE OR REPLACE FUNCTION public.guard_customer_order_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip_status    TEXT;
  v_departure_date TIMESTAMPTZ;
  v_trip_capacity  NUMERIC;
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
    SELECT t.status, t.departure_date, t.capacity
      INTO v_trip_status, v_departure_date, v_trip_capacity
      FROM public.trips AS t
     WHERE t.id = NEW.trip_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected trip does not exist';
    END IF;

    -- Date-only cutoff: blocks once the PH calendar day has moved past the
    -- scheduled departure date, OR the moment status leaves 'scheduled'
    -- (Start Trip, or an admin cancelling/completing/arriving it) --
    -- whichever comes first. A same-day booking stays open all day no
    -- matter what time it currently is. ph_calendar_day() is the same
    -- PH-timezone helper the duplicate-route unique index already uses.
    IF v_trip_status <> 'scheduled'
       OR public.ph_calendar_day(now()) > public.ph_calendar_day(v_departure_date) THEN
      RAISE EXCEPTION 'This trip is no longer accepting bookings';
    END IF;

    -- ── Capacity enforcement (matches frontend TRIP_CAPACITY_ALLOWANCE_KG) ──
    IF COALESCE(v_trip_capacity, 0) > 0 THEN
      SELECT COALESCE(SUM(COALESCE(o.actual_weight, 0)), 0)
        INTO v_current_load
        FROM public.orders o
       WHERE o.trip_id = NEW.trip_id
         AND o.status <> 'Cancelled';

      IF v_current_load > (v_trip_capacity + v_capacity_allowance) THEN
        RAISE EXCEPTION
          'This trip is full and cannot accept more bookings.';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.guard_order_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  trip_row      public.trips%ROWTYPE;
  weight        NUMERIC;
  price         NUMERIC;
  v_current_load NUMERIC;
  v_capacity_allowance CONSTANT NUMERIC := 200;
  v_payable     NUMERIC;
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

  -- ── Sender/receiver first+last <-> full-name sync (NEW) ─────────────────
  -- Whichever side of the write actually changed wins: first/last changed
  -- -> recompute the full name; only the full name changed (an old caller,
  -- a script, update_order_contact_details() before it is migrated) ->
  -- re-derive first/last from it. Must run before the lock check below.
  IF (NEW.sender_first_name, NEW.sender_last_name) IS DISTINCT FROM
     (OLD.sender_first_name, OLD.sender_last_name) THEN
    NEW.sender_name := NULLIF(btrim(concat_ws(' ', NEW.sender_first_name, NEW.sender_last_name)), '');
  ELSIF NEW.sender_name IS DISTINCT FROM OLD.sender_name THEN
    NEW.sender_first_name := split_part(btrim(NEW.sender_name), ' ', 1);
    NEW.sender_last_name  := CASE
      WHEN position(' ' in btrim(NEW.sender_name)) = 0 THEN ''
      ELSE btrim(substring(btrim(NEW.sender_name) from position(' ' in btrim(NEW.sender_name)) + 1))
    END;
  END IF;

  IF (NEW.receiver_first_name, NEW.receiver_last_name) IS DISTINCT FROM
     (OLD.receiver_first_name, OLD.receiver_last_name) THEN
    NEW.receiver_name := NULLIF(btrim(concat_ws(' ', NEW.receiver_first_name, NEW.receiver_last_name)), '');
  ELSIF NEW.receiver_name IS DISTINCT FROM OLD.receiver_name THEN
    NEW.receiver_first_name := split_part(btrim(NEW.receiver_name), ' ', 1);
    NEW.receiver_last_name  := CASE
      WHEN position(' ' in btrim(NEW.receiver_name)) = 0 THEN ''
      ELSE btrim(substring(btrim(NEW.receiver_name) from position(' ' in btrim(NEW.receiver_name)) + 1))
    END;
  END IF;

  -- ── NEW (20260922160000) — sender/receiver name policy, on CHANGE only ──
  -- Placed AFTER the first/last <-> full-name sync above, so whichever side
  -- of the write the caller used, the values judged here are the fully
  -- resolved ones. Placed BEFORE the contact/address lock so an invalid
  -- name is refused for the same reason on every path.
  --
  -- Every check is gated on "IS DISTINCT FROM OLD": a booking carrying a
  -- historical name that predates this policy can still be assigned, picked
  -- up, paid, delivered, reweighed and cancelled. Only a write that CHANGES
  -- a name to a non-conforming value is refused. A blank last_name stays
  -- legal (legacy mononyms, see 20260922100000's backfill).
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

  -- ── Contact/address details lock (mirrors update_order_contact_details(),
  --    20260915120000) — see 20260915130000's header comment. ────────────
  IF (NEW.sender_name, NEW.sender_phone, NEW.sender_province, NEW.sender_city,
      NEW.sender_barangay, NEW.sender_street, NEW.sender_landmark, NEW.sender_address,
      NEW.receiver_name, NEW.receiver_phone, NEW.receiver_province, NEW.receiver_city,
      NEW.receiver_barangay, NEW.receiver_street, NEW.receiver_landmark, NEW.receiver_address)
     IS DISTINCT FROM
     (OLD.sender_name, OLD.sender_phone, OLD.sender_province, OLD.sender_city,
      OLD.sender_barangay, OLD.sender_street, OLD.sender_landmark, OLD.sender_address,
      OLD.receiver_name, OLD.receiver_phone, OLD.receiver_province, OLD.receiver_city,
      OLD.receiver_barangay, OLD.receiver_street, OLD.receiver_landmark, OLD.receiver_address)
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

    -- ── Capacity enforcement (matches frontend TRIP_CAPACITY_ALLOWANCE_KG) ──
    -- Only enforce when the trip has a positive capacity set and either the
    -- trip assignment changed or the actual_weight changed.
    IF trip_row.capacity > 0
       AND (OLD.trip_id IS DISTINCT FROM NEW.trip_id
            OR NEW.actual_weight IS DISTINCT FROM OLD.actual_weight)
    THEN
      SELECT COALESCE(SUM(COALESCE(o.actual_weight, 0)), 0)
        INTO v_current_load
        FROM public.orders o
       WHERE o.trip_id = NEW.trip_id
         AND o.id <> NEW.id
         AND o.status <> 'Cancelled';

      IF (v_current_load + COALESCE(NEW.actual_weight, 0)) > (trip_row.capacity + v_capacity_allowance) THEN
        RAISE EXCEPTION
          'Cannot accept booking: exceeds maximum van capacity of % kg (% kg planned + % kg allowance). This trip is carrying % kg.',
          trip_row.capacity + v_capacity_allowance,
          trip_row.capacity,
          v_capacity_allowance,
          v_current_load;
      END IF;
    END IF;

    IF OLD.trip_id IS DISTINCT FROM NEW.trip_id AND NEW.status = 'Pending' THEN
      NEW.status := 'Assigned';
    END IF;
  END IF;

  IF NEW.actual_weight IS DISTINCT FROM OLD.actual_weight
     OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
     OR NEW.amount_paid IS DISTINCT FROM OLD.amount_paid
     OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount THEN
    weight := COALESCE(NEW.actual_weight, 0);
    price := CASE
      WHEN NEW.trip_id IS NOT NULL THEN public.effective_trip_price(NEW.trip_id)
      ELSE public.global_price_per_kilo()
    END;
    NEW.shipping_cost := ROUND(weight * price, 2);

    -- ── Discount guard ────────────────────────────────────────────────────
    -- Fires only when discount_amount/reason/notes are ACTUALLY changing —
    -- not on the amount_paid-triggered recompute cascade that runs every time
    -- update_order_payment_totals writes a new total (see that function's own
    -- comment), which would otherwise re-enter this block on every payment.
    IF NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
       OR NEW.discount_reason IS DISTINCT FROM OLD.discount_reason
       OR NEW.discount_notes  IS DISTINCT FROM OLD.discount_notes THEN

      IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Admin access required to change a shipping discount.';
      END IF;

      -- Read-only once pickup is confirmed. record_pickup_payment() is the
      -- only place a discount is ever set, and it always does so from one of
      -- these three pre-pickup statuses — so this also rejects a raw
      -- `.update()` bypassing that RPC entirely, not only a second call to it.
      IF OLD.status NOT IN ('Pending Review', 'Pending', 'Assigned') THEN
        RAISE EXCEPTION 'A discount can only be set or changed before pickup is confirmed.';
      END IF;

      -- Belt-and-suspenders: even if some future status allowed this branch
      -- to run past pickup, a recorded payment blocks it outright.
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
        -- Toggled off before confirming: no reason, no notes, no audit stamp
        -- left behind for a discount that was never actually applied.
        NEW.discount_amount     := 0;
        NEW.discount_reason     := NULL;
        NEW.discount_notes      := NULL;
        NEW.discount_applied_by := NULL;
        NEW.discount_applied_at := NULL;
      END IF;
    END IF;

    v_payable := public.order_payable_amount(NEW.shipping_cost, NEW.discount_amount);
    NEW.remaining_balance := GREATEST(0, v_payable - COALESCE(NEW.amount_paid, 0));
    -- The badge follows the balance. Without this a re-weighed order kept a
    -- stale 'Paid' label while money was owing (20260805120000).
    NEW.payment_status := public.derive_payment_status(v_payable, NEW.amount_paid);
  END IF;

  -- ── Warehouse dispatch gate (20260804100000, 20260806030000) ─────────────
  -- Placed last so it sees the recomputed weight and remaining_balance above.
  IF NEW.status = 'Out for Delivery' AND OLD.status IS DISTINCT FROM NEW.status THEN

    -- (a) Priced? An unweighed parcel has no cost, so its ₱0.00 balance must
    -- not be read as "paid". Applies to every payer type.
    IF COALESCE(NEW.actual_weight, 0) <= 0 THEN
      RAISE EXCEPTION
        'Cannot dispatch order % — it has not been weighed, so it has no price yet. Record the actual weight first.',
        NEW.tracking_number;
    END IF;

    -- (b) Paid? Unpaid cargo is held at the destination warehouse and not
    -- dispatched for doorstep delivery. Freight Collect is exempt (payment is
    -- due at the door); a recorded Promise Date is the explicit override.
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
CREATE OR REPLACE FUNCTION public.update_order_contact_details(p_order_id uuid, p_sender_first_name text, p_sender_last_name text, p_sender_phone text, p_sender_province text, p_sender_city text, p_sender_barangay text, p_sender_street text, p_sender_landmark text, p_sender_address text, p_receiver_first_name text, p_receiver_last_name text, p_receiver_phone text, p_receiver_province text, p_receiver_city text, p_receiver_barangay text, p_receiver_street text, p_receiver_landmark text, p_receiver_address text)
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

  -- Customers: locked at Out for Delivery, Delivered, and Cancelled.
  -- Admins: locked at Out for Delivery and Delivered only.
  -- (Admins retain access to Cancelled bookings for archival/dispute corrections.)
  IF NOT v_is_admin THEN
    IF v_order.status IN ('Out for Delivery', 'Delivered', 'Cancelled') THEN
      RAISE EXCEPTION 'Customer details are locked once the booking is out for delivery. (current status: %)', v_order.status;
    END IF;
    IF v_order.user_id <> auth.uid() THEN
      RAISE EXCEPTION 'Only your own bookings can be edited';
    END IF;
  ELSE
    -- Admin is also locked at the final delivery stages
    IF v_order.status IN ('Out for Delivery', 'Delivered') THEN
      RAISE EXCEPTION 'Customer details are locked once the booking is out for delivery. (current status: %)', v_order.status;
    END IF;
  END IF;

  v_previous := jsonb_build_object(
    'sender_first_name', v_order.sender_first_name, 'sender_last_name', v_order.sender_last_name,
    'sender_phone', v_order.sender_phone,
    'sender_province', v_order.sender_province, 'sender_city', v_order.sender_city,
    'sender_barangay', v_order.sender_barangay, 'sender_street', v_order.sender_street,
    'sender_landmark', v_order.sender_landmark, 'sender_address', v_order.sender_address,
    'receiver_first_name', v_order.receiver_first_name, 'receiver_last_name', v_order.receiver_last_name,
    'receiver_phone', v_order.receiver_phone,
    'receiver_province', v_order.receiver_province, 'receiver_city', v_order.receiver_city,
    'receiver_barangay', v_order.receiver_barangay, 'receiver_street', v_order.receiver_street,
    'receiver_landmark', v_order.receiver_landmark, 'receiver_address', v_order.receiver_address
  );
  v_new := jsonb_build_object(
    'sender_first_name', btrim(p_sender_first_name), 'sender_last_name', btrim(p_sender_last_name),
    'sender_phone', btrim(p_sender_phone),
    'sender_province', btrim(p_sender_province), 'sender_city', btrim(p_sender_city),
    'sender_barangay', btrim(p_sender_barangay), 'sender_street', btrim(p_sender_street),
    'sender_landmark', btrim(p_sender_landmark), 'sender_address', btrim(p_sender_address),
    'receiver_first_name', btrim(p_receiver_first_name), 'receiver_last_name', btrim(p_receiver_last_name),
    'receiver_phone', btrim(p_receiver_phone),
    'receiver_province', btrim(p_receiver_province), 'receiver_city', btrim(p_receiver_city),
    'receiver_barangay', btrim(p_receiver_barangay), 'receiver_street', btrim(p_receiver_street),
    'receiver_landmark', btrim(p_receiver_landmark), 'receiver_address', btrim(p_receiver_address)
  );

  -- Nothing actually changed — return the row as-is with no write, no log.
  IF v_previous = v_new THEN
    RETURN v_order;
  END IF;

  -- sender_name/receiver_name are deliberately NOT set here — guard_order_update()
  -- derives them from the first/last pair on this same UPDATE (BEFORE trigger).
  UPDATE public.orders SET
    sender_first_name = btrim(p_sender_first_name),
    sender_last_name = btrim(p_sender_last_name),
    sender_phone = btrim(p_sender_phone),
    sender_province = btrim(p_sender_province),
    sender_city = btrim(p_sender_city),
    sender_barangay = btrim(p_sender_barangay),
    sender_street = btrim(p_sender_street),
    sender_landmark = btrim(p_sender_landmark),
    sender_address = btrim(p_sender_address),
    receiver_first_name = btrim(p_receiver_first_name),
    receiver_last_name = btrim(p_receiver_last_name),
    receiver_phone = btrim(p_receiver_phone),
    receiver_province = btrim(p_receiver_province),
    receiver_city = btrim(p_receiver_city),
    receiver_barangay = btrim(p_receiver_barangay),
    receiver_street = btrim(p_receiver_street),
    receiver_landmark = btrim(p_receiver_landmark),
    receiver_address = btrim(p_receiver_address)
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
CREATE OR REPLACE FUNCTION public.track_order_public(p_tracking_number text)
 RETURNS TABLE(tracking_number character varying, status character varying, sender_name text, receiver_name text, origin character varying, destination character varying, package_description text, actual_weight numeric, estimated_delivery timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone, trip_departure_date timestamp with time zone, trip_departure_at timestamp with time zone, trip_estimated_arrival_at timestamp with time zone, trip_arrived_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    o.tracking_number,
    o.status,
    public.mask_name(o.sender_name)   AS sender_name,
    public.mask_name(o.receiver_name) AS receiver_name,
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
CREATE OR REPLACE FUNCTION public.guard_contact_inquiry_rate_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ 
BEGIN
  IF NEW.ip IS NOT NULL AND btrim(NEW.ip) <> '' THEN
    IF (SELECT COUNT(*) FROM public.contact_inquiries WHERE ip = NEW.ip AND created_at > now() - interval '10 minutes') >= 5 THEN
      RAISE EXCEPTION 'Too many inquiries from your network. Please wait 10 minutes before submitting again.' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF (SELECT COUNT(*) FROM public.contact_inquiries WHERE phone = NEW.phone AND created_at > now() - interval '10 minutes') >= 3 THEN
      RAISE EXCEPTION 'Too many inquiries from this phone number. Please wait 10 minutes before submitting again.' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF (SELECT COUNT(*) FROM public.contact_inquiries WHERE created_at > now() - interval '1 minute') >= 15 THEN
    RAISE EXCEPTION 'Too many inquiries right now. Please try again in a minute.' USING ERRCODE = '42501';
  END IF;
  NEW.name := btrim(NEW.name);
  NEW.phone := btrim(NEW.phone);
  NEW.message := btrim(NEW.message);
  IF NEW.ip IS NOT NULL THEN NEW.ip := btrim(NEW.ip); END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.effective_trip_price(p_trip_id uuid)
 RETURNS numeric
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT NULLIF(price_per_kg, 0) FROM public.trips WHERE id = p_trip_id),
    public.global_price_per_kilo()
  );
$function$;
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
      COALESCE(o.receiver_name, o.sender_name)::text AS customer_name,
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
      COALESCE(o.receiver_name, o.sender_name)::text AS customer_name,
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
    SELECT o.id, o.tracking_number, o.sender_name, o.receiver_name, o.origin, o.destination,
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
    SELECT o.tracking_number, o.sender_name
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
      COALESCE(NULLIF(btrim(NEW.sender_name), ''), 'Customer')
    ),
    'order_update',
    NEW.id
  FROM public.profiles AS p
  WHERE p.role = 'admin'
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.sync_order_sender_receiver_names_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NULLIF(btrim(COALESCE(NEW.sender_first_name, '')), '') IS NULL
     AND NULLIF(btrim(COALESCE(NEW.sender_name, '')), '') IS NOT NULL THEN
    NEW.sender_first_name := split_part(btrim(NEW.sender_name), ' ', 1);
    NEW.sender_last_name  := CASE
      WHEN position(' ' in btrim(NEW.sender_name)) = 0 THEN ''
      ELSE btrim(substring(btrim(NEW.sender_name) from position(' ' in btrim(NEW.sender_name)) + 1))
    END;
  ELSE
    NEW.sender_name := NULLIF(btrim(concat_ws(' ', NEW.sender_first_name, NEW.sender_last_name)), '');
  END IF;

  IF NULLIF(btrim(COALESCE(NEW.receiver_first_name, '')), '') IS NULL
     AND NULLIF(btrim(COALESCE(NEW.receiver_name, '')), '') IS NOT NULL THEN
    NEW.receiver_first_name := split_part(btrim(NEW.receiver_name), ' ', 1);
    NEW.receiver_last_name  := CASE
      WHEN position(' ' in btrim(NEW.receiver_name)) = 0 THEN ''
      ELSE btrim(substring(btrim(NEW.receiver_name) from position(' ' in btrim(NEW.receiver_name)) + 1))
    END;
  ELSE
    NEW.receiver_name := NULLIF(btrim(concat_ws(' ', NEW.receiver_first_name, NEW.receiver_last_name)), '');
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER orders_sync_sender_receiver_names_insert BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION sync_order_sender_receiver_names_insert();

-- Stage-1 helpers and compatibility aliases
DROP FUNCTION IF EXISTS public.sender_name(public.orders);
DROP FUNCTION IF EXISTS public.receiver_name(public.orders);
DROP FUNCTION IF EXISTS public.sender_address(public.orders);
DROP FUNCTION IF EXISTS public.receiver_address(public.orders);
DROP FUNCTION IF EXISTS public.capacity(public.trips);
DROP FUNCTION IF EXISTS public.price_per_kg(public.trips);
DROP FUNCTION IF EXISTS public.company_default_capacity();
DROP FUNCTION IF EXISTS public.contact_phone_key(text);
DROP FUNCTION IF EXISTS public.format_address(text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.clean_address_part(text);
DROP FUNCTION IF EXISTS public.format_person_name(text, text);

COMMIT;
