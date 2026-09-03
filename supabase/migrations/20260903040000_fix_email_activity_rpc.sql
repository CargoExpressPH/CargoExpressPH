BEGIN;

DROP FUNCTION IF EXISTS public.get_email_activity_log(INT, INT);

CREATE OR REPLACE FUNCTION public.get_email_activity_log(p_page INT DEFAULT 1, p_page_size INT DEFAULT 10)
RETURNS TABLE(
  id UUID,
  source TEXT,
  recipient_email TEXT,
  recipient_name TEXT,
  subject TEXT,
  status TEXT,
  order_id UUID,
  tracking_number TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ,
  total_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_page INT := GREATEST(COALESCE(p_page, 1), 1);
  v_page_size INT := LEAST(GREATEST(COALESCE(p_page_size, 10), 1), 100);
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    l.id, l.source, l.recipient_email, l.recipient_name, l.subject, l.status,
    l.order_id, o.tracking_number::TEXT, l.error_message, l.created_at,
    COUNT(*) OVER()::BIGINT AS total_count
  FROM public.email_activity_log l
  LEFT JOIN public.orders o ON o.id = l.order_id
  ORDER BY l.created_at DESC
  LIMIT v_page_size
  OFFSET (v_page - 1) * v_page_size;
END;
$$;

REVOKE ALL ON FUNCTION public.get_email_activity_log(INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_email_activity_log(INT, INT) TO authenticated;

COMMIT;
