-- Make browser-originated audit events durable and make the admin log screen
-- update without a manual refresh.

BEGIN;

ALTER TABLE public.activity_logs
  ADD COLUMN IF NOT EXISTS client_event_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_logs_actor_client_event
  ON public.activity_logs (admin_id, client_event_id);

CREATE OR REPLACE FUNCTION public.record_activity(
  p_client_event_id UUID,
  p_module TEXT,
  p_action TEXT,
  p_record_type TEXT DEFAULT NULL,
  p_record_id UUID DEFAULT NULL,
  p_record_ref TEXT DEFAULT NULL,
  p_previous_value JSONB DEFAULT NULL,
  p_new_value JSONB DEFAULT NULL,
  p_details TEXT DEFAULT NULL,
  p_occurred_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_is_admin BOOLEAN;
  v_admin_name TEXT;
  v_log_id UUID;
  v_occurred_at TIMESTAMPTZ;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_client_event_id IS NULL THEN
    RAISE EXCEPTION 'A client event ID is required';
  END IF;

  IF NULLIF(btrim(p_module), '') IS NULL OR NULLIF(btrim(p_action), '') IS NULL THEN
    RAISE EXCEPTION 'Module and action are required';
  END IF;

  v_is_admin := public.is_admin();
  IF NOT v_is_admin AND p_module NOT IN ('Orders', 'Authentication', 'Chat') THEN
    RAISE EXCEPTION 'Not allowed to write % activity logs', p_module;
  END IF;

  SELECT COALESCE(NULLIF(btrim(p.name), ''), 'Unknown Admin')
    INTO v_admin_name
    FROM public.profiles p
   WHERE p.id = v_uid;

  -- Keep the real time of a temporarily queued event, but do not accept a
  -- future timestamp or preserve an event beyond the screen's retention.
  v_occurred_at := GREATEST(
    now() - INTERVAL '7 days',
    LEAST(COALESCE(p_occurred_at, now()), now())
  );

  INSERT INTO public.activity_logs (
    admin_id,
    admin_name,
    module,
    action,
    record_type,
    record_id,
    record_ref,
    previous_value,
    new_value,
    details,
    created_at,
    client_event_id
  ) VALUES (
    v_uid,
    COALESCE(v_admin_name, 'Unknown Admin'),
    btrim(p_module),
    btrim(p_action),
    NULLIF(btrim(p_record_type), ''),
    p_record_id,
    NULLIF(btrim(p_record_ref), ''),
    p_previous_value,
    p_new_value,
    NULLIF(btrim(p_details), ''),
    v_occurred_at,
    p_client_event_id
  )
  ON CONFLICT (admin_id, client_event_id) DO NOTHING
  RETURNING id INTO v_log_id;

  IF v_log_id IS NULL THEN
    SELECT id
      INTO v_log_id
      FROM public.activity_logs
     WHERE admin_id = v_uid
       AND client_event_id = p_client_event_id;
  END IF;

  RETURN v_log_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_activity(UUID, TEXT, TEXT, TEXT, UUID, TEXT, JSONB, JSONB, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_activity(UUID, TEXT, TEXT, TEXT, UUID, TEXT, JSONB, JSONB, TEXT, TIMESTAMPTZ)
  TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'activity_logs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.activity_logs;
  END IF;
END;
$$;

COMMIT;
