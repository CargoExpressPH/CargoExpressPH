BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ── Supervisor approval codes ────────────────────────────────────────────────
-- A shortfall release needs a code that belongs to a DIFFERENT admin than the
-- one reporting it. Only a bcrypt hash is stored, nothing here ships a default
-- code, and the table is unreadable from the client (RLS on, no policies):
-- codes are set through set_supervisor_pin() and checked inside
-- report_and_approve_shortfall().
CREATE TABLE IF NOT EXISTS public.supervisor_pins (
  profile_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  pin_hash   TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.supervisor_pins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supervisor_pins FROM PUBLIC, anon, authenticated;

-- Wrong-code log used to lock a reporter out after repeated guesses. It has to
-- live in its own table (and the RPC returns a result instead of raising for a
-- wrong code) because a raised exception would roll the attempt back.
CREATE TABLE IF NOT EXISTS public.supervisor_code_attempts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supervisor_code_attempts_recent_idx
  ON public.supervisor_code_attempts (profile_id, attempted_at DESC);
ALTER TABLE public.supervisor_code_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supervisor_code_attempts FROM PUBLIC, anon, authenticated;

-- ── Loading shortfall exceptions ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.loading_shortfall_exceptions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id                 UUID NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  order_id                UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  box_number              INT  NOT NULL CHECK (box_number >= 1),
  reason                  TEXT NOT NULL
    CHECK (reason IN ('missing_from_staging', 'damaged_at_hub', 'held_by_customs', 'other')),
  supervisor_id           UUID REFERENCES public.profiles(id),
  -- Non-secret reference to the approving supervisor ("SUP-" + 8 hex of their
  -- profile id). The code itself is never stored.
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
-- No INSERT/UPDATE/DELETE policy: rows are written only by the RPC below.

-- ── Trip start guard: approved shortfalls count as resolved ──────────────────
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

-- ── Supervisor code management ───────────────────────────────────────────────
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

-- ── Report + approve a shortfall in one step ─────────────────────────────────
-- The box stays on its booking (it is HELD, not de-assigned), so the booking
-- still cannot be marked Delivered until that box is actually found and
-- scanned. All this releases is the trip departure.
--
-- Returns jsonb: {ok: true, exception_id} or {ok: false, error: 'invalid_supervisor_code'}.
-- Every other problem raises.
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

  -- The approving code must belong to someone other than the reporter.
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

COMMIT;
