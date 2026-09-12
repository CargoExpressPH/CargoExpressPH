-- ============================================================
-- F-007 — service_area_status / service_area_remarks are never trusted
-- from the client at INSERT time.
--
-- Root cause (see audit_reports/F-007-service-area-mass-assignment-fix-plan.md):
-- the out-of-coverage workflow (20260625010000) added the columns and a
-- CHECK on their allowed VALUES ('standard'/'for_review'/'approved'/
-- 'rejected'), but never added the authorization layer that decides WHO may
-- set which value on INSERT. The customer INSERT policy constrains status,
-- actual_weight, payment fields and photos, but never these two columns, and
-- neither prepare_order_insert() nor guard_customer_order_insert() resets
-- them the way both already reset featured_*/discount_* fields. A tampered
-- customer request could therefore submit service_area_status: 'approved'
-- directly, skipping the staff review queue entirely — OrdersPage/
-- OrderDetailPage key EXCLUSIVELY on service_area_status to gate that queue.
--
-- Fix, following the exact pattern already established for discount_* and
-- featured_* on this same trigger: derive the value server-side from the
-- booking's own sender_province, so a booking is never born approved/
-- rejected/carrying remarks — 'approved' and 'rejected' remain reachable
-- ONLY through the existing admin-only UPDATE path
-- (handleApproveReview/handleRejectReview), exactly like a discount is only
-- ever set through record_pickup_payment(), never at INSERT. The RLS check
-- is added too as belt-and-suspenders (consistent with how the same policy
-- already constrains status/actual_weight/payment fields), even though the
-- trigger alone is sufficient to close the gap regardless of what any
-- future caller sends.
-- ============================================================

-- ============================================================
-- 1. is_standard_service_area_province() — server-side mirror of
--    src/constants/phLocations.js's BOHOL_PROVINCES + MANILA_PROVINCES.
--    Keep both lists in sync if the service area ever expands/contracts.
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_standard_service_area_province(p_province TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(p_province, '') IN (
    'Bohol', 'Metro Manila', 'Cavite', 'Batangas', 'Laguna', 'Bulacan'
  );
$$;

REVOKE ALL ON FUNCTION public.is_standard_service_area_province(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_standard_service_area_province(TEXT) TO authenticated, service_role;


-- ============================================================
-- 2. prepare_order_insert() — full current body (from 20260911020000)
--    plus the service-area derivation. Never a partial/older body, so
--    nothing already fixed (capacity enforcement, discount zeroing,
--    cancellation-detail clearing) regresses.
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


-- ============================================================
-- 3. RLS — belt-and-suspenders. The trigger above is what actually closes
--    the gap (it runs before this WITH CHECK is evaluated and unconditionally
--    overwrites both fields), but the existing policy already constrains
--    several other insert-time fields the trigger also fully controls
--    (status, actual_weight, payment_*), so this keeps the same posture.
-- ============================================================
DROP POLICY IF EXISTS "Users can create own orders" ON public.orders;
CREATE POLICY "Users can create own orders" ON public.orders
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND status IN ('Pending', 'Assigned')
    AND actual_weight IS NULL
    AND payment_method IS NULL
    AND payment_status = 'unpaid'
    AND amount_paid = 0
    AND pickup_photos = '[]'::jsonb
    AND delivery_photos = '[]'::jsonb
    AND service_area_status IN ('standard', 'for_review')
    AND service_area_remarks IS NULL
  );

-- ============================================================
-- VERIFY (must return 0 on any database):
--   SELECT COUNT(*) FROM orders WHERE service_area_status NOT IN ('standard','for_review','approved','rejected');
--   -- Every existing 'for_review'/'approved'/'rejected' order was reached
--   -- through this same trigger at creation or the admin UPDATE path
--   -- afterward, so no backfill is needed — this migration only changes
--   -- what a FUTURE insert may do.
-- ============================================================
