BEGIN;

-- Append-only audit of every box verification: how it was verified (camera QR
-- or the manual fallback), why the fallback was needed, who did it and when.
-- verified_boxes stays the source of truth for gating; this table is for review.
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
  -- A manual verification must say why; a camera scan has no reason.
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
-- No write policies: rows are inserted only by record_box_verification().

-- Replace the 2-argument function. Keeping it would make a 2-argument call
-- ambiguous with the new defaulted signature.
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

  -- Only a box that was newly counted is an event; an idempotent replay is not.
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

COMMIT;
