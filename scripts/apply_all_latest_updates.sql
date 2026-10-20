-- ==============================================================================
-- CARGOEXPRESS PH: COMPREHENSIVE UPDATE SCRIPT (OCTOBER 20, 2026)
-- ==============================================================================
-- Kasama sa script na ito ang lahat ng bagong updates para sa field operations:
-- 1. Supervisor-Approved Loading Shortfall Exceptions & Departure Release
-- 2. Box Scan Audit Events Table & Updated record_box_verification RPC (Option B)
-- 3. Automatic Trip Completion Trigger (Auto-complete pag Delivered na lahat)
-- 4. Status Correction para sa mga premature 'completed' trips (e.g. TRIP-20261019-678)
-- ==============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ==============================================================================
-- SEKSYON 1: SUPERVISOR APPROVAL CODES & LOADING SHORTFALL EXCEPTIONS
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.supervisor_pins (
  profile_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  pin_hash   TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.supervisor_pins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supervisor_pins FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.supervisor_code_attempts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supervisor_code_attempts_recent_idx
  ON public.supervisor_code_attempts (profile_id, attempted_at DESC);
ALTER TABLE public.supervisor_code_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supervisor_code_attempts FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.loading_shortfall_exceptions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id                 UUID NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  order_id                UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  box_number              INT  NOT NULL CHECK (box_number >= 1),
  reason                  TEXT NOT NULL
    CHECK (reason IN ('missing_from_staging', 'damaged_at_hub', 'held_by_customs', 'other')),
  supervisor_id           UUID REFERENCES public.profiles(id),
  supervisor_approval_code VARCHAR(20) NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'approved'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  reported_by             UUID REFERENCES public.profiles(id),
  created_at              TIMESTAMPTZ DEFAULT now(),
  UNIQUE (trip_id, order_id, box_number)
);
CREATE INDEX IF NOT EXISTS loading_shortfall_exceptions_trip_idx
  ON public.loading_shortfall_exceptions (trip_id);

ALTER TABLE public.loading_shortfall_exceptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.loading_shortfall_exceptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.loading_shortfall_exceptions TO authenticated;
DROP POLICY IF EXISTS "Admins read loading shortfall exceptions" ON public.loading_shortfall_exceptions;
CREATE POLICY "Admins read loading shortfall exceptions"
  ON public.loading_shortfall_exceptions FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

-- Trip start guard: approved shortfalls count as resolved
CREATE OR REPLACE FUNCTION public.require_box_verification_before_trip_start()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_unverified_count INT;
  v_example          TEXT;
BEGIN
  SELECT COUNT(*), MIN(o.tracking_number)
    INTO v_unverified_count, v_example
    FROM public.orders AS o
   WHERE o.trip_id = NEW.id
     AND o.status NOT IN ('Cancelled', 'Pending Cancellation', 'Pending', 'Assigned')
     AND NOT (
       (
         COALESCE(o.verified_boxes, '{}')
         || COALESCE((
              SELECT array_agg(e.box_number)
                FROM public.loading_shortfall_exceptions AS e
               WHERE e.trip_id = NEW.id
                 AND e.order_id = o.id
                 AND e.status = 'approved'
            ), '{}')
       ) @> ARRAY(SELECT generate_series(1, o.package_quantity))
     );

  IF v_unverified_count > 0 THEN
    RAISE EXCEPTION 'Cannot start trip: % booking(s) have boxes whose package QR code has not been scanned (e.g. %). Scan every box, or report a supervisor-approved shortfall, before departure.',
      v_unverified_count, v_example
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_supervisor_pin(p_pin TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin privileges required' USING ERRCODE = '42501';
  END IF;
  IF p_pin IS NULL OR length(btrim(p_pin)) < 6 THEN
    RAISE EXCEPTION 'A supervisor code must be at least 6 characters.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.supervisor_pins (profile_id, pin_hash)
  VALUES (auth.uid(), crypt(btrim(p_pin), gen_salt('bf')))
  ON CONFLICT (profile_id) DO UPDATE
    SET pin_hash = EXCLUDED.pin_hash, updated_at = now();
END;
$function$;

REVOKE ALL ON FUNCTION public.set_supervisor_pin(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_supervisor_pin(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.report_and_approve_shortfall(
  p_trip_id         UUID,
  p_order_id        UUID,
  p_box             INT,
  p_reason          TEXT,
  p_supervisor_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid     UUID := auth.uid();
  v_trip    public.trips;
  v_order   public.orders;
  v_sup     UUID;
  v_row_id  UUID;
  v_recent  INT;
BEGIN
  IF v_uid IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin privileges required' USING ERRCODE = '42501';
  END IF;

  IF p_reason IS NULL OR p_reason NOT IN ('missing_from_staging', 'damaged_at_hub', 'held_by_customs', 'other') THEN
    RAISE EXCEPTION 'Choose a valid shortfall reason.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trip not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_trip.status <> 'scheduled' THEN
    RAISE EXCEPTION 'A loading shortfall can only be reported before the trip starts.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.trip_id IS DISTINCT FROM p_trip_id THEN
    RAISE EXCEPTION 'That booking is not assigned to this trip.' USING ERRCODE = '22023';
  END IF;
  IF v_order.status IN ('Cancelled', 'Pending Cancellation', 'Pending', 'Assigned') THEN
    RAISE EXCEPTION 'That booking is not part of this trip''s cargo.' USING ERRCODE = '22023';
  END IF;
  IF p_box IS NULL OR p_box < 1 OR p_box > v_order.package_quantity THEN
    RAISE EXCEPTION 'Box % does not belong to this booking (it has % box(es)).',
      p_box, v_order.package_quantity USING ERRCODE = '22023';
  END IF;
  IF p_box = ANY (COALESCE(v_order.verified_boxes, '{}')) THEN
    RAISE EXCEPTION 'Box % is already scanned; it is not a shortfall.', p_box USING ERRCODE = '22023';
  END IF;

  SELECT COUNT(*) INTO v_recent
    FROM public.supervisor_code_attempts
   WHERE profile_id = v_uid AND attempted_at > now() - interval '15 minutes';
  IF v_recent >= 5 THEN
    RAISE EXCEPTION 'Too many incorrect supervisor codes. Try again in 15 minutes.' USING ERRCODE = '42501';
  END IF;

  SELECT sp.profile_id INTO v_sup
    FROM public.supervisor_pins AS sp
    JOIN public.profiles AS pr ON pr.id = sp.profile_id
   WHERE pr.role = 'admin'
     AND sp.profile_id <> v_uid
     AND sp.pin_hash = crypt(btrim(COALESCE(p_supervisor_code, '')), sp.pin_hash)
   LIMIT 1;

  IF v_sup IS NULL THEN
    INSERT INTO public.supervisor_code_attempts (profile_id) VALUES (v_uid);
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_supervisor_code');
  END IF;

  DELETE FROM public.supervisor_code_attempts WHERE profile_id = v_uid;

  INSERT INTO public.loading_shortfall_exceptions
    (trip_id, order_id, box_number, reason, supervisor_id, supervisor_approval_code, status, reported_by)
  VALUES
    (p_trip_id, p_order_id, p_box, p_reason, v_sup,
     'SUP-' || upper(left(replace(v_sup::text, '-', ''), 8)), 'approved', v_uid)
  ON CONFLICT (trip_id, order_id, box_number) DO NOTHING
  RETURNING id INTO v_row_id;

  IF v_row_id IS NULL THEN
    SELECT id INTO v_row_id FROM public.loading_shortfall_exceptions
     WHERE trip_id = p_trip_id AND order_id = p_order_id AND box_number = p_box;
  END IF;

  RETURN jsonb_build_object('ok', true, 'exception_id', v_row_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.report_and_approve_shortfall(UUID, UUID, INT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_and_approve_shortfall(UUID, UUID, INT, TEXT, TEXT) TO authenticated;


-- ==============================================================================
-- SEKSYON 2: BOX SCAN EVENTS AUDIT TABLE & UPDATED record_box_verification (OPTION B)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.box_scan_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  trip_id     UUID REFERENCES public.trips(id) ON DELETE SET NULL,
  box_number  INT  NOT NULL CHECK (box_number >= 1),
  phase       TEXT NOT NULL CHECK (phase IN ('load', 'deliver')),
  method      TEXT NOT NULL CHECK (method IN ('qr', 'manual_fallback')),
  reason      TEXT CHECK (reason IN (
                'torn_label', 'wet_smudged', 'low_light', 'camera_issue',
                'unidentified_label', 'other')),
  actor_id    UUID REFERENCES public.profiles(id),
  scanned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT box_scan_events_reason_matches_method CHECK (
    (method = 'manual_fallback' AND reason IS NOT NULL)
    OR (method = 'qr' AND reason IS NULL))
);
CREATE INDEX IF NOT EXISTS box_scan_events_trip_idx  ON public.box_scan_events (trip_id, scanned_at);
CREATE INDEX IF NOT EXISTS box_scan_events_order_idx ON public.box_scan_events (order_id);

ALTER TABLE public.box_scan_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.box_scan_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.box_scan_events TO authenticated;
DROP POLICY IF EXISTS "Admins read box scan events" ON public.box_scan_events;
CREATE POLICY "Admins read box scan events"
  ON public.box_scan_events FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

-- Palitan ang lumang 2-argument record_box_verification
DROP FUNCTION IF EXISTS public.record_box_verification(UUID, INTEGER);

CREATE OR REPLACE FUNCTION public.record_box_verification(
  p_order_id UUID,
  p_box      INTEGER,
  p_method   TEXT DEFAULT 'qr',
  p_reason   TEXT DEFAULT NULL
)
RETURNS INTEGER[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order  public.orders;
  v_boxes  INTEGER[];
  v_new    BOOLEAN;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin privileges required' USING ERRCODE = '42501';
  END IF;

  IF p_method NOT IN ('qr', 'manual_fallback') THEN
    RAISE EXCEPTION 'Unknown verification method.' USING ERRCODE = '22023';
  END IF;
  IF p_method = 'manual_fallback' AND p_reason IS NULL THEN
    RAISE EXCEPTION 'Choose why the QR could not be scanned.' USING ERRCODE = '22023';
  END IF;
  IF p_method = 'qr' THEN
    p_reason := NULL;
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_order.status NOT IN ('Picked Up', 'Out for Delivery') THEN
    RAISE EXCEPTION 'Boxes can only be verified after pickup and before delivery.'
      USING ERRCODE = '22023';
  END IF;

  IF p_box IS NULL OR p_box < 1 OR p_box > v_order.package_quantity THEN
    RAISE EXCEPTION 'Box % does not belong to this booking (it has % box(es)).',
      p_box, v_order.package_quantity
      USING ERRCODE = '22023';
  END IF;

  v_new := NOT (p_box = ANY (COALESCE(v_order.verified_boxes, '{}')));

  UPDATE public.orders
     SET verified_boxes = ARRAY(
           SELECT DISTINCT b FROM unnest(verified_boxes || p_box) AS b ORDER BY b
         )
   WHERE id = p_order_id
  RETURNING verified_boxes INTO v_boxes;

  IF v_new THEN
    INSERT INTO public.box_scan_events (order_id, trip_id, box_number, phase, method, reason, actor_id)
    VALUES (
      p_order_id, v_order.trip_id, p_box,
      CASE WHEN v_order.status = 'Out for Delivery' THEN 'deliver' ELSE 'load' END,
      p_method, p_reason, auth.uid()
    );
  END IF;

  RETURN v_boxes;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_box_verification(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_box_verification(UUID, INTEGER, TEXT, TEXT) TO authenticated;


-- ==============================================================================
-- SEKSYON 3: AUTOMATIC TRIP COMPLETION TRIGGER
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.auto_complete_trip_on_all_orders_delivered()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_undelivered_or_unpaid INT;
  v_trip_status TEXT;
BEGIN
  IF NEW.trip_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT status INTO v_trip_status
  FROM public.trips
  WHERE id = NEW.trip_id;

  -- Kung aktibo sa destination hub ('arrived'):
  IF v_trip_status = 'arrived' THEN
    SELECT COUNT(*) INTO v_undelivered_or_unpaid
    FROM public.orders
    WHERE trip_id = NEW.trip_id
      AND (
        status NOT IN ('Delivered', 'Cancelled')
        OR COALESCE(remaining_balance, 0) > 0
      );

    IF v_undelivered_or_unpaid = 0 THEN
      UPDATE public.trips
      SET status = 'completed'
      WHERE id = NEW.trip_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_auto_complete_trip ON public.orders;
CREATE TRIGGER orders_auto_complete_trip
AFTER UPDATE OF status, remaining_balance ON public.orders
FOR EACH ROW
WHEN (NEW.status = 'Delivered' OR (NEW.status IN ('Delivered', 'Cancelled') AND COALESCE(NEW.remaining_balance, 0) <= 0))
EXECUTE FUNCTION public.auto_complete_trip_on_all_orders_delivered();


-- ==============================================================================
-- SEKSYON 4: STATUS CORRECTION PARA SA PREMATURE 'COMPLETED' TRIPS
-- ==============================================================================

-- Pansamantalang i-disable ang triggers upang payagan ang status rollback
ALTER TABLE public.trips DISABLE TRIGGER USER;

-- 4a. Kung nakarating na sa hub (may arrived_at) pero may kargamento pang hindi Delivered/Cancelled:
--     Ibalik sa 'arrived' upang lumitaw sa "Arrived at Destination Hub" at maging aktibo!
UPDATE public.trips t
SET status = 'arrived'
WHERE t.arrived_at IS NOT NULL
  AND EXISTS (
    SELECT 1 
    FROM public.orders o 
    WHERE o.trip_id = t.id 
      AND o.status NOT IN ('Delivered', 'Cancelled')
  );

-- 4b. Kung nakaalis na pero wala pang arrived_at at may orders pang hindi Delivered:
--     Ibalik sa 'in_progress'
UPDATE public.trips t
SET status = 'in_progress'
WHERE t.departure_at IS NOT NULL
  AND t.arrived_at IS NULL
  AND EXISTS (
    SELECT 1 
    FROM public.orders o 
    WHERE o.trip_id = t.id 
      AND o.status NOT IN ('Delivered', 'Cancelled')
  );

-- 4c. Kung DELIVERED o CANCELLED na talaga ang LAHAT ng kargamento:
--     DAPAT 'completed' ito
UPDATE public.trips t
SET status = 'completed'
WHERE t.id IN (SELECT DISTINCT trip_id FROM public.orders WHERE trip_id IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 
    FROM public.orders o 
    WHERE o.trip_id = t.id 
      AND o.status NOT IN ('Delivered', 'Cancelled')
  );

-- Ibalik ang triggers sa trips
ALTER TABLE public.trips ENABLE TRIGGER USER;

COMMIT;

-- I-verify ang updated statuses:
SELECT 
  id, 
  trip_number, 
  status, 
  arrived_at,
  (SELECT count(*) FROM public.orders WHERE trip_id = trips.id) AS total_orders,
  (SELECT count(*) FROM public.orders WHERE trip_id = trips.id AND status = 'Delivered') AS delivered_orders,
  (SELECT count(*) FROM public.orders WHERE trip_id = trips.id AND status = 'Out for Delivery') AS out_for_delivery_orders
FROM public.trips
ORDER BY created_at DESC
LIMIT 10;
