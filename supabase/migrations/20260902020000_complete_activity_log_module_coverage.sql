-- Make Activity Logs module filters reflect authoritative database activity.
-- Payment ledger inserts can come from admin pickup/delivery, counter
-- collection, or PayMongo reconciliation, so the database is the only place
-- that can guarantee every successful payment receives one audit entry.

BEGIN;

CREATE OR REPLACE FUNCTION public.log_payment_transaction_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tracking_number TEXT;
  v_action TEXT;
  v_admin_name TEXT;
  v_method TEXT;
BEGIN
  SELECT o.tracking_number
    INTO v_tracking_number
    FROM public.orders o
   WHERE o.id = NEW.order_id;

  v_action := CASE
    WHEN lower(COALESCE(NEW.payment_type, '')) LIKE '%initial%'
      THEN 'Initial Payment Recorded'
    WHEN lower(COALESCE(NEW.payment_type, '')) LIKE '%settlement%'
      OR lower(COALESCE(NEW.payment_status, '')) = 'paid'
      THEN 'Payment Completed'
    ELSE 'Additional Payment Recorded'
  END;

  SELECT COALESCE(
           NULLIF(btrim(p.name), ''),
           NULLIF(btrim(NEW.admin_name), ''),
           CASE WHEN NEW.admin_id IS NULL THEN 'System' ELSE 'Unknown Admin' END
         )
    INTO v_admin_name
    FROM (SELECT 1) seed
    LEFT JOIN public.profiles p ON p.id = NEW.admin_id;

  v_method := initcap(replace(COALESCE(NULLIF(btrim(NEW.payment_method), ''), 'unspecified method'), '_', ' '));

  INSERT INTO public.activity_logs (
    admin_id, admin_name, module, action, record_type, record_id, record_ref,
    new_value, details, created_at
  ) VALUES (
    NEW.admin_id,
    v_admin_name,
    'Payments',
    v_action,
    'payment',
    NEW.id,
    v_tracking_number,
    jsonb_build_object(
      'amount', NEW.amount,
      'payment_method', NEW.payment_method,
      'payment_status', NEW.payment_status,
      'payment_type', NEW.payment_type,
      'payment_date', NEW.payment_date
    ),
    'Recorded ' || chr(8369) || to_char(NEW.amount, 'FM999999990.00') ||
      ' via ' || v_method || '. ' ||
      CASE
        WHEN lower(COALESCE(NEW.payment_status, '')) = 'paid' THEN 'Payment is complete.'
        WHEN lower(COALESCE(NEW.payment_status, '')) = 'partial' THEN 'A balance is still due.'
        ELSE 'Payment status: ' || COALESCE(NEW.payment_status, 'not specified') || '.'
      END,
    COALESCE(NEW.created_at, now())
  );

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.log_payment_transaction_activity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payment_transactions_log_activity ON public.payment_transactions;
CREATE TRIGGER payment_transactions_log_activity
  AFTER INSERT ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.log_payment_transaction_activity();

-- Older PWA bundles may remain open during rollout and still send their old
-- order-shaped Payments log immediately after the transaction insert. The
-- canonical trigger row above is payment-shaped. Skip only that narrow legacy
-- duplicate so mixed client versions cannot produce two entries.
CREATE OR REPLACE FUNCTION public.guard_activity_log_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_is_admin BOOLEAN;
  v_name TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  v_is_admin := public.is_admin();

  IF NOT v_is_admin AND NEW.module NOT IN ('Orders', 'Authentication', 'Chat') THEN
    RAISE EXCEPTION 'Not allowed to write % activity logs', NEW.module;
  END IF;

  IF NEW.module = 'Payments'
     AND NEW.record_type = 'order'
     AND EXISTS (
       SELECT 1
       FROM public.activity_logs existing
       WHERE existing.module = 'Payments'
         AND existing.record_type = 'payment'
         AND existing.record_ref IS NOT DISTINCT FROM NEW.record_ref
         AND existing.created_at BETWEEN
           COALESCE(NEW.created_at, now()) - INTERVAL '5 minutes'
           AND COALESCE(NEW.created_at, now()) + INTERVAL '5 minutes'
     ) THEN
    RETURN NULL;
  END IF;

  SELECT name INTO v_name FROM public.profiles WHERE id = v_uid;
  NEW.admin_id := v_uid;
  NEW.admin_name := COALESCE(NULLIF(btrim(v_name), ''), 'Unknown Admin');

  RETURN NEW;
END;
$$;

-- The Activity Logs page retains seven days. Backfill that same visible window
-- so the Payments filter works immediately after this migration, without
-- manufacturing history older than the screen itself keeps.
INSERT INTO public.activity_logs (
  admin_id, admin_name, module, action, record_type, record_id, record_ref,
  new_value, details, created_at
)
SELECT
  t.admin_id,
  COALESCE(NULLIF(btrim(p.name), ''), NULLIF(btrim(t.admin_name), ''),
           CASE WHEN t.admin_id IS NULL THEN 'System' ELSE 'Unknown Admin' END),
  'Payments',
  CASE
    WHEN lower(COALESCE(t.payment_type, '')) LIKE '%initial%' THEN 'Initial Payment Recorded'
    WHEN lower(COALESCE(t.payment_type, '')) LIKE '%settlement%'
      OR lower(COALESCE(t.payment_status, '')) = 'paid' THEN 'Payment Completed'
    ELSE 'Additional Payment Recorded'
  END,
  'payment',
  t.id,
  o.tracking_number,
  jsonb_build_object(
    'amount', t.amount,
    'payment_method', t.payment_method,
    'payment_status', t.payment_status,
    'payment_type', t.payment_type,
    'payment_date', t.payment_date
  ),
  'Recorded ' || chr(8369) || to_char(t.amount, 'FM999999990.00') ||
    ' via ' || initcap(replace(COALESCE(NULLIF(btrim(t.payment_method), ''), 'unspecified method'), '_', ' ')) || '. ' ||
    CASE
      WHEN lower(COALESCE(t.payment_status, '')) = 'paid' THEN 'Payment is complete.'
      WHEN lower(COALESCE(t.payment_status, '')) = 'partial' THEN 'A balance is still due.'
      ELSE 'Payment status: ' || COALESCE(t.payment_status, 'not specified') || '.'
    END,
  t.created_at
FROM public.payment_transactions t
JOIN public.orders o ON o.id = t.order_id
LEFT JOIN public.profiles p ON p.id = t.admin_id
WHERE t.created_at >= now() - INTERVAL '7 days'
  AND NOT EXISTS (
    SELECT 1
    FROM public.activity_logs a
    WHERE a.module = 'Payments'
      AND a.record_type = 'payment'
      AND a.record_id = t.id
  );

-- Feedback visibility is an admin moderation decision. Record it next to the
-- data change, rather than relying on a fire-and-forget browser request.
CREATE OR REPLACE FUNCTION public.log_feedback_visibility_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tracking_number TEXT;
  v_admin_name TEXT;
BEGIN
  IF NEW.is_hidden IS NOT DISTINCT FROM OLD.is_hidden THEN
    RETURN NEW;
  END IF;

  SELECT o.tracking_number
    INTO v_tracking_number
    FROM public.orders o
   WHERE o.id = NEW.order_id;

  SELECT COALESCE(NULLIF(btrim(p.name), ''), 'Unknown Admin')
    INTO v_admin_name
    FROM public.profiles p
   WHERE p.id = auth.uid();

  INSERT INTO public.activity_logs (
    admin_id, admin_name, module, action, record_type, record_id, record_ref,
    previous_value, new_value, details
  ) VALUES (
    auth.uid(),
    COALESCE(v_admin_name, 'System'),
    'Feedback',
    CASE WHEN NEW.is_hidden THEN 'Feedback Hidden' ELSE 'Feedback Unhidden' END,
    'feedback',
    NEW.id,
    v_tracking_number,
    jsonb_build_object('is_hidden', OLD.is_hidden),
    jsonb_build_object('is_hidden', NEW.is_hidden),
    CASE WHEN NEW.is_hidden
      THEN 'Hid this review from the public website.'
      ELSE 'Restored this review to the public website.'
    END
  );

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.log_feedback_visibility_activity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS customer_feedback_log_visibility_activity ON public.customer_feedback;
CREATE TRIGGER customer_feedback_log_visibility_activity
  AFTER UPDATE OF is_hidden ON public.customer_feedback
  FOR EACH ROW EXECUTE FUNCTION public.log_feedback_visibility_activity();

COMMIT;
