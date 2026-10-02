-- Refund audit entries belong to the authoritative ledger transaction, not
-- a browser callback. Webhooks/recovery must produce the same durable history.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_logs_refund_state
  ON public.activity_logs ((new_value->>'refund_ledger_id'), action)
  WHERE module = 'Payments' AND new_value ? 'refund_ledger_id';

CREATE OR REPLACE FUNCTION private.record_paymongo_refund_activity(
  p_refund public.payment_refunds,
  p_occurred_at TIMESTAMPTZ,
  p_previous_status TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_action TEXT;
  v_status TEXT;
  v_tracking TEXT;
BEGIN
  IF p_refund.refund_channel <> 'paymongo' THEN RETURN; END IF;
  v_status := CASE WHEN p_refund.outcome_uncertain THEN 'uncertain' ELSE p_refund.status END;
  v_action := CASE v_status
    WHEN 'creating' THEN 'Refund Requested'
    WHEN 'pending' THEN 'Refund Submitted'
    WHEN 'processing' THEN 'Refund Processing'
    WHEN 'uncertain' THEN 'Refund Confirmation Pending'
    WHEN 'succeeded' THEN 'Refund Confirmed'
    WHEN 'failed' THEN 'Refund Failed'
  END;
  IF v_action IS NULL THEN RETURN; END IF;
  SELECT tracking_number INTO v_tracking FROM public.orders WHERE id = p_refund.order_id;
  INSERT INTO public.activity_logs (
    admin_id, admin_name, module, action, record_type, record_id, record_ref,
    previous_value, new_value, details, created_at
  ) VALUES (
    p_refund.initiated_by,
    COALESCE(NULLIF(btrim(p_refund.initiated_by_name), ''),
      CASE WHEN p_refund.initiated_by IS NULL THEN 'System (PayMongo)' ELSE 'Unknown Admin' END),
    'Payments', v_action, 'order', p_refund.order_id, v_tracking,
    CASE WHEN p_previous_status IS NULL THEN NULL ELSE jsonb_build_object('refund_status', p_previous_status) END,
    jsonb_build_object('refund_ledger_id', p_refund.id, 'refund_id', p_refund.refund_id,
      'refund_status', v_status, 'amount', p_refund.amount),
    format('%s PayMongo refund of %s%s. %s', v_action,
      chr(8369) || to_char(p_refund.amount, 'FM999,999,999,990.00'),
      CASE WHEN p_refund.refund_id IS NULL THEN '' ELSE ' (' || p_refund.refund_id || ')' END,
      CASE v_status
        WHEN 'succeeded' THEN 'PayMongo confirmed success; the refund is deducted from collected totals.'
        WHEN 'failed' THEN 'The refund failed; no refund amount is deducted from collected totals.'
        ELSE 'The refund is not completed; no refund amount is deducted from collected totals.'
      END),
    p_occurred_at
  ) ON CONFLICT DO NOTHING;
END;
$function$;
REVOKE ALL ON FUNCTION private.record_paymongo_refund_activity(public.payment_refunds, TIMESTAMPTZ, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.log_paymongo_refund_activity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_previous TEXT;
BEGIN
  IF NEW.refund_channel <> 'paymongo' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.outcome_uncertain IS NOT DISTINCT FROM OLD.outcome_uncertain THEN
      RETURN NEW;
    END IF;
    v_previous := CASE WHEN OLD.outcome_uncertain THEN 'uncertain' ELSE OLD.status END;
  END IF;
  PERFORM private.record_paymongo_refund_activity(NEW, now(), v_previous);
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.log_paymongo_refund_activity() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS payment_refunds_log_activity ON public.payment_refunds;
CREATE TRIGGER payment_refunds_log_activity
  AFTER INSERT OR UPDATE OF status, outcome_uncertain ON public.payment_refunds
  FOR EACH ROW EXECUTE FUNCTION private.log_paymongo_refund_activity();

-- Keep identity validation. Only ordinary payment callbacks are duplicates
-- of payment ledger entries; refunds are distinct actions on the same order.
CREATE OR REPLACE FUNCTION public.guard_activity_log_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  v_name TEXT;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;
  IF NOT public.is_admin() AND NEW.module NOT IN ('Orders', 'Authentication', 'Chat') THEN
    RAISE EXCEPTION 'Not allowed to write % activity logs', NEW.module;
  END IF;
  -- Older open browser tabs may still send the former refund callback.
  -- Match the exact provider refund and action, never just a nearby payment.
  IF NEW.module = 'Payments' AND NEW.record_type = 'order'
     AND NEW.action LIKE 'Refund %' AND NOT (COALESCE(NEW.new_value, '{}'::jsonb) ? 'refund_ledger_id')
     AND EXISTS (
       SELECT 1 FROM public.activity_logs existing
       JOIN public.payment_refunds r ON r.id::text = existing.new_value->>'refund_ledger_id'
       WHERE existing.module = 'Payments' AND existing.action = NEW.action
         AND r.order_id = NEW.record_id AND r.refund_id IS NOT NULL
         AND r.refund_id = ANY(regexp_split_to_array(COALESCE(NEW.details, ''), '[^A-Za-z0-9_-]+'))
     ) THEN RETURN NULL; END IF;
  IF NEW.module = 'Payments' AND NEW.record_type = 'order'
     AND NEW.action IN ('Initial Payment Recorded', 'Additional Payment Recorded', 'Payment Completed')
     AND EXISTS (
       SELECT 1 FROM public.activity_logs existing
       WHERE existing.module = 'Payments' AND existing.record_type = 'payment'
         AND existing.record_ref IS NOT DISTINCT FROM NEW.record_ref
         AND existing.created_at BETWEEN COALESCE(NEW.created_at, now()) - INTERVAL '5 minutes'
           AND COALESCE(NEW.created_at, now()) + INTERVAL '5 minutes'
     ) THEN RETURN NULL; END IF;
  SELECT name INTO v_name FROM public.profiles WHERE id = v_uid;
  NEW.admin_id := v_uid;
  NEW.admin_name := COALESCE(NULLIF(btrim(v_name), ''), 'Unknown Admin');
  RETURN NEW;
END;
$function$;

-- Restore only the current ledger state within the existing retention window.
-- Do not invent intermediate transitions or rewrite the original event time.
DO $backfill$
DECLARE
  v_refund public.payment_refunds%ROWTYPE;
  v_time TIMESTAMPTZ;
BEGIN
  FOR v_refund IN SELECT * FROM public.payment_refunds WHERE refund_channel = 'paymongo' LOOP
    v_time := CASE WHEN v_refund.status = 'succeeded'
      THEN COALESCE(v_refund.succeeded_at, v_refund.provider_updated_at, v_refund.updated_at, v_refund.created_at)
      ELSE COALESCE(v_refund.provider_updated_at, v_refund.updated_at, v_refund.created_at) END;
    IF v_time < now() - INTERVAL '7 days' THEN CONTINUE; END IF;
    -- Respect legacy entries already written by the browser.
    IF EXISTS (
      SELECT 1 FROM public.activity_logs a
      WHERE a.module = 'Payments' AND a.record_id = v_refund.order_id
        AND a.action = CASE WHEN v_refund.outcome_uncertain THEN 'Refund Confirmation Pending'
          ELSE CASE v_refund.status WHEN 'succeeded' THEN 'Refund Confirmed' WHEN 'failed' THEN 'Refund Failed'
            WHEN 'creating' THEN 'Refund Requested' WHEN 'pending' THEN 'Refund Submitted'
            WHEN 'processing' THEN 'Refund Processing' END END
        AND (a.new_value->>'refund_ledger_id' = v_refund.id::text
          OR (v_refund.refund_id IS NOT NULL
            AND v_refund.refund_id = ANY(regexp_split_to_array(COALESCE(a.details, ''), '[^A-Za-z0-9_-]+'))))
    ) THEN CONTINUE; END IF;
    PERFORM private.record_paymongo_refund_activity(v_refund, v_time);
  END LOOP;
END;
$backfill$;
COMMIT;
