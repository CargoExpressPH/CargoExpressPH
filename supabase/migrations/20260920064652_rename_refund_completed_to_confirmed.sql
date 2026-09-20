-- Keep customer-facing refund notification titles consistent with the
-- confirmed PayMongo/database state. Historical notification rows remain
-- unchanged; new succeeded refunds use the clearer title.
CREATE OR REPLACE FUNCTION private.notify_refund_succeeded()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order public.orders%ROWTYPE;
  v_amount_text TEXT;
  v_balance_text TEXT;
  v_message TEXT;
BEGIN
  IF NEW.status <> 'succeeded'
     OR (TG_OP = 'UPDATE' AND OLD.status = 'succeeded') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = NEW.order_id;
  IF NOT FOUND OR v_order.user_id IS NULL THEN RETURN NEW; END IF;

  v_amount_text := chr(8369) || to_char(NEW.amount, 'FM999,999,999,990.00');
  v_balance_text := chr(8369) || to_char(
    GREATEST(COALESCE(v_order.remaining_balance, 0), 0),
    'FM999,999,999,990.00'
  );

  v_message := CASE
    WHEN NEW.refund_channel = 'manual' AND NEW.return_method = 'cash' THEN
      format(
        'A %s cash refund for order %s was recorded. The remaining balance for this order is now %s.',
        v_amount_text, v_order.tracking_number, v_balance_text
      )
    WHEN NEW.refund_channel = 'manual' AND NEW.return_method = 'gcash' THEN
      format(
        'A %s GCash refund for order %s was recorded as returned by our team. The remaining balance for this order is now %s.',
        v_amount_text, v_order.tracking_number, v_balance_text
      )
    ELSE
      format(
        'Your %s refund for order %s was successfully processed. The remaining balance for this order is now %s. It may take additional time for the refund to appear in your original GCash account.',
        v_amount_text, v_order.tracking_number, v_balance_text
      )
  END;

  INSERT INTO public.notifications (
    user_id, title, message, type, reference_id, payment_refund_id
  ) VALUES (
    v_order.user_id,
    'Refund Confirmed',
    v_message,
    'payment_update', v_order.id, NEW.id
  ) ON CONFLICT (payment_refund_id) WHERE payment_refund_id IS NOT NULL DO NOTHING;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.notify_refund_succeeded()
  FROM PUBLIC, anon, authenticated;
