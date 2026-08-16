-- ============================================================
-- Customer cancellation becomes a REQUEST, not an act.
--
-- Before this, `cancel_own_pending_order()` let a customer flip their own
-- booking straight to 'Cancelled' with no reason recorded and nobody told.
-- Two things were wrong with that:
--
--   1. The slot was released the instant the customer tapped the button, so a
--      booking already worked into a trip manifest vanished from under the
--      admin who had planned around it.
--   2. Nothing captured WHY. "Cancelled" with no reason is the one fact about
--      a cancellation that is worth keeping, and it was the one being thrown
--      away — there was no field to put it in and no box to type it into.
--
-- So cancellation now has two halves: the customer STATES a reason and the
-- order moves to 'Pending Cancellation'; an admin then approves (→ Cancelled)
-- or rejects (→ back to exactly where it was). The order keeps travelling and
-- keeps its trip slot in the meantime, because a request is not a decision.
--
-- 'Pending Cancellation' is deliberately a STATUS and not a flag beside one.
-- The whole point is that the order stops moving forward while a human looks
-- at it, and every surface in this codebase — the badges, the admin advance
-- button, the tabs, STATUS_FLOW — already keys off `status`. A boolean would
-- have needed every one of them taught about it separately, which is how you
-- get an order that is "awaiting cancellation review" and also being marched
-- to Out for Delivery.
--
-- `cancellation_previous_status` exists so a REJECTION is lossless. Without
-- it, rejecting could only guess where to put the order back, and an Assigned
-- booking would have come back as Pending — silently detached from a trip it
-- was still physically on.
-- ============================================================

-- ── 1. The request itself ───────────────────────────────────────────────────

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS cancellation_reason          TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_requested_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_previous_status VARCHAR(30),
  ADD COLUMN IF NOT EXISTS cancellation_reviewed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_reviewed_by     UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancellation_review_notes    TEXT;

COMMENT ON COLUMN public.orders.cancellation_reason IS
  'Customer-stated reason for the cancellation request. Required — a cancellation with no reason is the case this column exists to stop.';
COMMENT ON COLUMN public.orders.cancellation_previous_status IS
  'Where the order was standing when the request was made, so a rejection can put it back exactly there rather than guessing.';

-- ── 2. Admit the new status ─────────────────────────────────────────────────

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_status_check CHECK (
  status::text = ANY (ARRAY[
    'Pending Review',
    'Pending',
    'Assigned',
    'Picked Up',
    'Pending Cancellation',
    'In Transit',
    'Arrived at Hub',
    'Out for Delivery',
    'Delivered',
    'Cancelled'
  ])
);

-- ── 3. A fresh booking carries no cancellation state ────────────────────────

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
  NEW.cancellation_reason          := NULL;
  NEW.cancellation_requested_at    := NULL;
  NEW.cancellation_previous_status := NULL;
  NEW.cancellation_reviewed_at     := NULL;
  NEW.cancellation_reviewed_by     := NULL;
  NEW.cancellation_review_notes    := NULL;

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

-- ── 4. An order under review does not move ──────────────────────────────────
--
-- Only two exits from 'Pending Cancellation': approved (→ Cancelled) or
-- rejected (→ back to cancellation_previous_status). Both are written by
-- review_order_cancellation(). Anything else — an admin hitting Advance, a
-- trip cascade — is refused here, because the client-side STATUS_FLOW that
-- hides the Advance button is UX, not enforcement.

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
     AND NEW.status NOT IN ('Cancelled', COALESCE(OLD.cancellation_previous_status, 'Pending'))
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

-- ── 5. Customer: state a reason, ask for review ─────────────────────────────

CREATE OR REPLACE FUNCTION public.request_order_cancellation(p_order_id uuid, p_reason text)
 RETURNS public.orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order  public.orders;
  v_reason TEXT := btrim(COALESCE(p_reason, ''));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF char_length(v_reason) < 5 THEN
    RAISE EXCEPTION 'Please tell us why you are cancelling (at least 5 characters).';
  END IF;

  SELECT * INTO v_order
    FROM public.orders
   WHERE id = p_order_id AND user_id = auth.uid()
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only your own bookings can be cancelled';
  END IF;

  IF v_order.status = 'Pending Cancellation' THEN
    RAISE EXCEPTION 'A cancellation request for this booking is already awaiting review.';
  END IF;

  IF v_order.status = 'Cancelled' THEN
    RAISE EXCEPTION 'This booking is already cancelled.';
  END IF;

  -- Mirrors IN_NETWORK_STATUSES in src/constants/status.js. Past this line the
  -- parcel is on a vehicle or in a hub, and "cancel" no longer describes
  -- anything that can physically happen — that is a return, not a cancellation.
  IF v_order.status IN ('In Transit', 'Arrived at Hub', 'Out for Delivery', 'Delivered') THEN
    RAISE EXCEPTION
      'This shipment is already "%" and is on its way. Please contact support instead.',
      v_order.status;
  END IF;

  UPDATE public.orders
     SET status                       = 'Pending Cancellation',
         cancellation_reason          = v_reason,
         cancellation_requested_at    = now(),
         cancellation_previous_status = v_order.status,
         cancellation_reviewed_at     = NULL,
         cancellation_reviewed_by     = NULL,
         cancellation_review_notes    = NULL
   WHERE id = p_order_id
   RETURNING * INTO v_order;

  -- Every admin is told. A request nobody sees is a booking frozen forever.
  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  SELECT p.id,
         'Cancellation Requested',
         'Order ' || v_order.tracking_number || ': the customer asked to cancel. Reason: ' || v_reason,
         'order_update',
         v_order.id
    FROM public.profiles p
   WHERE p.role = 'admin';

  INSERT INTO public.activity_logs (module, action, record_type, record_id, record_ref, previous_value, new_value, details)
  VALUES ('Orders',
          'Cancellation Requested',
          'order',
          v_order.id,
          v_order.tracking_number,
          jsonb_build_object('status', v_order.cancellation_previous_status),
          jsonb_build_object('status', 'Pending Cancellation'),
          'Customer requested cancellation. Reason: ' || v_reason);

  RETURN v_order;
END;
$function$;

-- ── 6. Admin: approve or reject ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.review_order_cancellation(
  p_order_id uuid,
  p_approve  boolean,
  p_notes    text DEFAULT NULL
)
 RETURNS public.orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order   public.orders;
  v_restore TEXT;
  v_notes   TEXT := NULLIF(btrim(COALESCE(p_notes, '')), '');
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin privileges required';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.status <> 'Pending Cancellation' THEN
    RAISE EXCEPTION 'Order % has no cancellation request awaiting review.', v_order.tracking_number;
  END IF;

  -- 'Pending' is the fallback only for rows that predate this migration and so
  -- have no recorded previous status. It is a guess, and it is confined to the
  -- one case where nothing better is knowable.
  v_restore := COALESCE(v_order.cancellation_previous_status, 'Pending');

  UPDATE public.orders
     SET status                    = CASE WHEN p_approve THEN 'Cancelled' ELSE v_restore END,
         cancellation_reviewed_at  = now(),
         cancellation_reviewed_by  = auth.uid(),
         cancellation_review_notes = v_notes
   WHERE id = p_order_id
   RETURNING * INTO v_order;

  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  VALUES (v_order.user_id,
          CASE WHEN p_approve THEN 'Cancellation Approved' ELSE 'Cancellation Declined' END,
          CASE WHEN p_approve
               THEN 'Order ' || v_order.tracking_number || ' has been cancelled as you requested.'
               ELSE 'Order ' || v_order.tracking_number || ' was not cancelled and is back to "' || v_restore || '".'
          END
          || COALESCE(' Note from our team: ' || v_notes, ''),
          'order_update',
          v_order.id);

  INSERT INTO public.activity_logs (module, action, record_type, record_id, record_ref, previous_value, new_value, details)
  VALUES ('Orders',
          CASE WHEN p_approve THEN 'Cancellation Approved' ELSE 'Cancellation Rejected' END,
          'order',
          v_order.id,
          v_order.tracking_number,
          jsonb_build_object('status', 'Pending Cancellation'),
          jsonb_build_object('status', v_order.status),
          CASE WHEN p_approve
               THEN 'Approved the customer''s cancellation request; order cancelled.'
               ELSE 'Rejected the customer''s cancellation request; order restored to "' || v_restore || '".'
          END
          || COALESCE(' Note: ' || v_notes, '')
          || COALESCE(' Customer''s stated reason: ' || v_order.cancellation_reason, ''));

  RETURN v_order;
END;
$function$;

-- ── 7. Retire the immediate-cancel RPC ──────────────────────────────────────
--
-- Kept as a named function rather than dropped: it is a public PostgREST
-- endpoint, and an old cached bundle calling it must get a clear message, not
-- a 404 that reads as "the network is down". It can no longer cancel anything.

CREATE OR REPLACE FUNCTION public.cancel_own_pending_order(p_order_id uuid)
 RETURNS public.orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION
    'Bookings are no longer cancelled instantly. Submit a cancellation request with a reason — an admin reviews it before the booking is cancelled.';
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_own_pending_order(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_own_pending_order(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.cancel_own_pending_order(uuid) FROM authenticated;

REVOKE ALL ON FUNCTION public.request_order_cancellation(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_order_cancellation(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.request_order_cancellation(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.review_order_cancellation(uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_order_cancellation(uuid, boolean, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.review_order_cancellation(uuid, boolean, text) TO authenticated;

CREATE INDEX IF NOT EXISTS idx_orders_pending_cancellation
  ON public.orders (cancellation_requested_at)
  WHERE status = 'Pending Cancellation';
