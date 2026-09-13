-- Clarify the two GCash collection paths and make order activity history
-- include payment-ledger entries whose record_id is the payment id.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_activity_logs_record_ref
  ON public.activity_logs USING btree (record_ref);

CREATE OR REPLACE FUNCTION public.log_payment_transaction_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_tracking_number TEXT;
  v_action TEXT;
  v_admin_name TEXT;
  v_method_key TEXT;
  v_channel_key TEXT;
  v_method_label TEXT;
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

  v_method_key := lower(COALESCE(NULLIF(btrim(NEW.payment_method), ''), ''));
  v_channel_key := lower(COALESCE(NULLIF(btrim(NEW.gcash_channel), ''), ''));
  v_method_label := CASE
    WHEN v_method_key = 'gcash' AND v_channel_key = 'manual'
      THEN 'Direct GCash transfer (staff verified)'
    WHEN v_method_key = 'gcash' AND v_channel_key = 'paymongo'
      THEN 'GCash online payment (automatically verified)'
    WHEN v_method_key = 'gcash' THEN 'GCash'
    WHEN v_method_key = 'cash' THEN 'Cash'
    WHEN v_method_key = '' THEN 'Unspecified method'
    ELSE initcap(replace(v_method_key, '_', ' '))
  END;

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
      'gcash_channel', NEW.gcash_channel,
      'payment_status', NEW.payment_status,
      'payment_type', NEW.payment_type,
      'payment_date', NEW.payment_date
    ),
    'Payment recorded: ' || chr(8369) || to_char(NEW.amount, 'FM999,999,999,990.00') ||
      ' via ' || v_method_label || '. ' ||
      CASE
        WHEN lower(COALESCE(NEW.payment_status, '')) = 'paid' THEN 'Payment is complete.'
        WHEN lower(COALESCE(NEW.payment_status, '')) = 'partial' THEN 'A balance is still due.'
        ELSE 'Payment status: ' || COALESCE(NEW.payment_status, 'not specified') || '.'
      END,
    COALESCE(NEW.created_at, now())
  );

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.log_payment_transaction_activity() FROM PUBLIC, anon, authenticated;

-- Keep the canonical trigger attached after replacing its function body.
DROP TRIGGER IF EXISTS payment_transactions_log_activity ON public.payment_transactions;
CREATE TRIGGER payment_transactions_log_activity
  AFTER INSERT ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.log_payment_transaction_activity();

-- Normalize existing payment activity entries so the current seven-day
-- Activity History window uses the same labels as newly recorded payments.
UPDATE public.activity_logs AS al
SET details = 'Payment recorded: ' || chr(8369) || to_char(pt.amount, 'FM999,999,999,990.00') ||
  ' via ' || CASE
    WHEN lower(COALESCE(pt.payment_method, '')) = 'gcash'
      AND lower(COALESCE(pt.gcash_channel, '')) = 'manual'
      THEN 'Direct GCash transfer (staff verified)'
    WHEN lower(COALESCE(pt.payment_method, '')) = 'gcash'
      AND lower(COALESCE(pt.gcash_channel, '')) = 'paymongo'
      THEN 'GCash online payment (automatically verified)'
    WHEN lower(COALESCE(pt.payment_method, '')) = 'gcash' THEN 'GCash'
    WHEN lower(COALESCE(pt.payment_method, '')) = 'cash' THEN 'Cash'
    WHEN NULLIF(btrim(pt.payment_method), '') IS NULL THEN 'Unspecified method'
    ELSE initcap(replace(lower(btrim(pt.payment_method)), '_', ' '))
  END || '. ' || CASE
    WHEN lower(COALESCE(pt.payment_status, '')) = 'paid' THEN 'Payment is complete.'
    WHEN lower(COALESCE(pt.payment_status, '')) = 'partial' THEN 'A balance is still due.'
    ELSE 'Payment status: ' || COALESCE(pt.payment_status, 'not specified') || '.'
  END
FROM public.payment_transactions AS pt
WHERE al.module = 'Payments'
  AND al.record_type = 'payment'
  AND al.record_id = pt.id;

COMMIT;
