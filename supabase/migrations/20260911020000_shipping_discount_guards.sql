-- ============================================================
-- Admin-only shipping discount — guards & derived-balance rule (part 2 of 3)
--
-- Makes "what is owed" discount-aware in the ONE place both money triggers
-- already shared (public.derive_payment_status, added in
-- 20260805120000_payment_status_on_weight_edit.sql to stop exactly this kind
-- of two-trigger drift) and adds a matching order_payable_amount() helper for
-- "what is the final fee".
--
-- Three functions are replaced here, each with its FULL current body (copied
-- from the latest migration that defined it) plus the discount-specific
-- lines — never a partial/older body, so nothing already fixed (trip
-- capacity enforcement, the Pending-Cancellation hold, the dispatch gate,
-- the "badge follows the balance" fix) regresses:
--
--   1. order_payable_amount()      — NEW. shipping_cost minus discount_amount,
--                                     floored at 0. The one place "final fee"
--                                     is computed, so guard_order_update and
--                                     update_order_payment_totals cannot drift
--                                     into two different answers the way
--                                     shipping_cost/payment_status once did.
--
--   2. prepare_order_insert()      — a freshly INSERTed order can never carry
--                                     a discount; the five discount columns
--                                     are zeroed/nulled explicitly regardless
--                                     of what a crafted INSERT payload sends.
--
--   3. guard_order_update()        — (a) the recompute block that already
--                                     derives shipping_cost/remaining_balance/
--                                     payment_status now also fires on a
--                                     discount_amount change, and computes
--                                     remaining_balance/payment_status from
--                                     order_payable_amount() instead of bare
--                                     shipping_cost; (b) a new guard rejects
--                                     any change to discount_amount /
--                                     discount_reason / discount_notes unless
--                                     the caller is an admin, the order is
--                                     still in a pre-pickup status, and no
--                                     payment has been recorded yet — this is
--                                     the SERVER-SIDE enforcement of "discount
--                                     is read-only after pickup", independent
--                                     of which RPC (or a raw admin `.update()`)
--                                     is doing the writing.
--
-- record_pickup_payment() — the only sanctioned way to actually SET a
-- discount — is updated separately in 20260911030000, since it is a much
-- larger function; this migration only adds the invariant it must satisfy.
-- ============================================================


-- ============================================================
-- 1. order_payable_amount() — the one place "final fee" is computed
-- ============================================================
CREATE OR REPLACE FUNCTION public.order_payable_amount(
  p_shipping_cost NUMERIC,
  p_discount_amount NUMERIC
)
RETURNS NUMERIC
LANGUAGE SQL
IMMUTABLE
SET search_path = public
AS $$
  SELECT GREATEST(COALESCE(p_shipping_cost, 0) - COALESCE(p_discount_amount, 0), 0);
$$;

REVOKE ALL ON FUNCTION public.order_payable_amount(NUMERIC, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_payable_amount(NUMERIC, NUMERIC) TO authenticated, service_role;


-- ============================================================
-- 2. prepare_order_insert() — a new order is never born discounted
-- ============================================================
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


-- ============================================================
-- 3. guard_order_update() — discount-aware balance + read-only-after-pickup
-- ============================================================
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
-- 4. update_order_payment_totals() — the ledger trigger, discount-aware
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_order_payment_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_paid      DECIMAL(10,2);
  v_shipping_cost   DECIMAL(10,2);
  v_discount_amount DECIMAL(10,2);
  v_payable         DECIMAL(10,2);
  v_remaining       DECIMAL(10,2);
  v_order_id        UUID;
BEGIN
  v_order_id := COALESCE(NEW.order_id, OLD.order_id);

  SELECT COALESCE(SUM(amount), 0) INTO v_total_paid
  FROM public.payment_transactions
  WHERE order_id = v_order_id AND payment_status IN ('paid', 'partial');

  SELECT shipping_cost, discount_amount INTO v_shipping_cost, v_discount_amount
  FROM public.orders
  WHERE id = v_order_id;

  v_payable   := public.order_payable_amount(v_shipping_cost, v_discount_amount);
  v_remaining := GREATEST(0, v_payable - v_total_paid);

  UPDATE public.orders
  SET amount_paid       = v_total_paid,
      remaining_balance = v_remaining,
      payment_status    = public.derive_payment_status(v_payable, v_total_paid)
  WHERE id = v_order_id;

  RETURN NULL;
END;
$$;


-- ============================================================
-- 5. Repair pass — NO-OP for every existing order
--
-- discount_amount is 0 on every row that already exists (see the previous
-- migration), so order_payable_amount(shipping_cost, 0) = shipping_cost and
-- this WHERE clause matches exactly the rows the original
-- 20260805120000 repair would have matched — i.e. none, on a database where
-- that migration already ran. Kept as the same defensive repair pattern for
-- any environment restored from an older dump.
-- ============================================================

UPDATE public.orders o
   SET payment_status = public.derive_payment_status(
         public.order_payable_amount(o.shipping_cost, o.discount_amount), o.amount_paid
       )
 WHERE o.payment_status IS DISTINCT FROM
       public.derive_payment_status(
         public.order_payable_amount(o.shipping_cost, o.discount_amount), o.amount_paid
       );

-- ============================================================
-- VERIFY (must return 0 on any database):
--   SELECT COUNT(*) FROM orders
--    WHERE payment_status IS DISTINCT FROM
--          derive_payment_status(order_payable_amount(shipping_cost, discount_amount), amount_paid);
--
--   SELECT COUNT(*) FROM orders WHERE discount_amount <> 0; -- 0 on any pre-existing database
-- ============================================================
