-- Splits sender_name/receiver_name into first/last name columns, DRAFT for
-- review — see conversation. Deprecate-not-drop strategy: sender_name and
-- receiver_name remain real, NOT NULL columns, kept in sync automatically,
-- so every existing SECURITY DEFINER function that reads them
-- (track_order_public, create_admin_notifications_rpc,
-- update_order_contact_details) and every pgtest harness that scaffolds its
-- own copy of this table keeps working UNCHANGED. Only the write paths this
-- task actually touches (booking creation, recent contacts) need to start
-- writing the new columns.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS sender_first_name   TEXT,
  ADD COLUMN IF NOT EXISTS sender_last_name     TEXT,
  ADD COLUMN IF NOT EXISTS receiver_first_name TEXT,
  ADD COLUMN IF NOT EXISTS receiver_last_name  TEXT;

-- ── Backfill existing rows ──────────────────────────────────────────────
-- Split on the FIRST space: "Juan Dela Cruz" -> first="Juan",
-- last="Dela Cruz". A single-word name (no space) becomes first_name only,
-- last_name = '' — this is real, unavoidable legacy data (Filipino
-- single-word/mononym entries exist in this dataset) and is why last_name
-- is NOT required at the column level below.
UPDATE public.orders
SET sender_first_name = split_part(btrim(sender_name), ' ', 1),
    sender_last_name  = CASE
      WHEN position(' ' in btrim(sender_name)) = 0 THEN ''
      ELSE btrim(substring(btrim(sender_name) from position(' ' in btrim(sender_name)) + 1))
    END
WHERE sender_first_name IS NULL;

UPDATE public.orders
SET receiver_first_name = split_part(btrim(receiver_name), ' ', 1),
    receiver_last_name  = CASE
      WHEN position(' ' in btrim(receiver_name)) = 0 THEN ''
      ELSE btrim(substring(btrim(receiver_name) from position(' ' in btrim(receiver_name)) + 1))
    END
WHERE receiver_first_name IS NULL;

ALTER TABLE public.orders
  ALTER COLUMN sender_first_name   SET NOT NULL,
  ALTER COLUMN sender_first_name   SET DEFAULT '',
  ALTER COLUMN sender_last_name    SET NOT NULL,
  ALTER COLUMN sender_last_name    SET DEFAULT '',
  ALTER COLUMN receiver_first_name SET NOT NULL,
  ALTER COLUMN receiver_first_name SET DEFAULT '',
  ALTER COLUMN receiver_last_name  SET NOT NULL,
  ALTER COLUMN receiver_last_name  SET DEFAULT '';

-- first_name must be non-blank (mirrors sender_name's own NOT NULL — a
-- blank name was never valid before either); last_name is allowed blank to
-- tolerate the legacy single-word backfill above. New writes going through
-- update_order_contact_details() / createOrder() are expected to require
-- both non-blank at the application layer — see the follow-up RPC change.
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_sender_first_name_not_blank;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_sender_first_name_not_blank CHECK (btrim(sender_first_name) <> '');
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_receiver_first_name_not_blank;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_receiver_first_name_not_blank CHECK (btrim(receiver_first_name) <> '');

-- ── INSERT-time sync ─────────────────────────────────────────────────────
-- A fresh row sets one side or the other (old callers write sender_name;
-- new callers write sender_first_name/sender_last_name) — resolve whichever
-- is missing from whichever is present. No ordering conflict on INSERT
-- (nothing else inspects these columns on insert), so this stays a small
-- standalone trigger.
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

DROP TRIGGER IF EXISTS orders_sync_sender_receiver_names_insert ON public.orders;
CREATE TRIGGER orders_sync_sender_receiver_names_insert
  BEFORE INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.sync_order_sender_receiver_names_insert();

-- ── UPDATE-time sync ─────────────────────────────────────────────────────
-- NOT a separate trigger. The existing UPDATE trigger is named
-- "orders_guard_update" (see 20260915130000); Postgres fires same-event
-- triggers in NAME order, and any new trigger name would almost certainly
-- sort after "orders_guard_update" (e.g. "orders_sync_..."), running its
-- name-resolution AFTER guard_order_update()'s contact-details lock already
-- read NEW.sender_name/NEW.receiver_name. That would let a caller bypass
-- the lock entirely by writing only sender_first_name/sender_last_name
-- while a booking is Out for Delivery/Delivered — the exact "raw .update()
-- bypassing the guard" gap 20260915130000 itself was written to close.
--
-- So the resolution step is folded directly into guard_order_update(),
-- BEFORE the contact/address details lock block, guaranteeing
-- NEW.sender_name/NEW.receiver_name are always fully resolved by the time
-- the lock's tuple comparison runs — no trigger-ordering assumption
-- involved. Everything else in this function is reproduced VERBATIM from
-- 20260915130000_guard_contact_details_lock_at_trigger_level.sql; only the
-- new block (marked below) and this comment are added.
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

-- ============================================================
-- VERIFY (must return exactly 1 row each):
--   SELECT COUNT(*) FROM pg_proc WHERE proname = 'guard_order_update';
--   SELECT COUNT(*) FROM pg_proc WHERE proname = 'sync_order_sender_receiver_names_insert';
-- ============================================================
