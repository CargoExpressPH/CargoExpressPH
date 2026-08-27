-- Restore the notification_id column promised by the push-delivery contract.
-- 20260824012000 is already recorded as applied, so this correction must be a
-- new migration rather than an edit to that historical file.

DROP FUNCTION IF EXISTS public.create_admin_notifications_rpc(TEXT, TEXT, TEXT, UUID);

CREATE OR REPLACE FUNCTION public.create_admin_notifications_rpc(
  p_title TEXT,
  p_message TEXT,
  p_type TEXT,
  p_reference_id UUID DEFAULT NULL
)
RETURNS TABLE (
  admin_id UUID,
  notification_id UUID,
  notification_title TEXT,
  notification_message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
      '%s★ rating%s',
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
$$;

REVOKE ALL ON FUNCTION public.create_admin_notifications_rpc(TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_admin_notifications_rpc(TEXT, TEXT, TEXT, UUID) TO authenticated, service_role;
