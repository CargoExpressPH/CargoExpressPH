CREATE OR REPLACE FUNCTION public.prepare_order_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  trip_row public.trips%ROWTYPE;
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

  IF NEW.trip_id IS NOT NULL THEN
    SELECT * INTO trip_row FROM public.trips WHERE id = NEW.trip_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected trip does not exist';
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
CREATE OR REPLACE FUNCTION public.guard_order_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  trip_row public.trips%ROWTYPE;
  weight NUMERIC;
  price NUMERIC;
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
    -- Capacity check removed to allow administrators to manually exceed limits.

    IF OLD.trip_id IS DISTINCT FROM NEW.trip_id AND NEW.status = 'Pending' THEN
      NEW.status := 'Assigned';
    END IF;
  END IF;

  IF NEW.actual_weight IS DISTINCT FROM OLD.actual_weight
     OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
     OR NEW.amount_paid IS DISTINCT FROM OLD.amount_paid THEN
    weight := COALESCE(NEW.actual_weight, 0);
    price := CASE
      WHEN NEW.trip_id IS NOT NULL THEN public.effective_trip_price(NEW.trip_id)
      ELSE public.global_price_per_kilo()
    END;
    NEW.shipping_cost := ROUND(weight * price, 2);
    NEW.remaining_balance := GREATEST(0, NEW.shipping_cost - COALESCE(NEW.amount_paid, 0));
    -- The badge follows the balance. Without this a re-weighed order kept a
    -- stale 'Paid' label while money was owing (20260805120000).
    NEW.payment_status := public.derive_payment_status(NEW.shipping_cost, NEW.amount_paid);
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
CREATE OR REPLACE FUNCTION public.cancel_own_pending_order(p_order_id uuid)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION
    'Bookings are no longer cancelled instantly. Submit a cancellation request with a reason — an admin reviews it before the booking is cancelled.';
END;
$function$;
