CREATE OR REPLACE FUNCTION private.notify_payment_recorded()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order public.orders%ROWTYPE;
  v_payment_amount TEXT;
  v_remaining_balance TEXT;
BEGIN
  IF NEW.payment_status NOT IN ('paid', 'partial') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_order
  FROM public.orders
  WHERE id = NEW.order_id;

  IF NOT FOUND OR v_order.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_payment_amount := chr(8369) || to_char(
    COALESCE(NEW.amount, 0)::numeric,
    'FM999,999,999,990.00'
  );
  v_remaining_balance := chr(8369) || to_char(
    GREATEST(COALESCE(v_order.remaining_balance, 0), 0)::numeric,
    'FM999,999,999,990.00'
  );

  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  VALUES (
    v_order.user_id,
    CASE
      WHEN COALESCE(v_order.remaining_balance, 0) <= 0 THEN 'Payment Complete'
      ELSE 'Payment Received'
    END,
    CASE
      WHEN COALESCE(v_order.remaining_balance, 0) <= 0 THEN format(
        'We received your %s payment for order %s. Your balance is fully paid.',
        v_payment_amount,
        v_order.tracking_number
      )
      ELSE format(
        'We received your %s payment for order %s. Your remaining balance is %s.',
        v_payment_amount,
        v_order.tracking_number,
        v_remaining_balance
      )
    END,
    'payment_update',
    v_order.id
  );

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.notify_payment_recorded() FROM PUBLIC, anon, authenticated;
