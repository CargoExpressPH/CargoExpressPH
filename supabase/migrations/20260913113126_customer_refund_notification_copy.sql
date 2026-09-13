-- Keep provider details in admin/internal surfaces while making refund
-- notifications clear and customer-facing. Provider success and wallet
-- posting are related but not instantaneous events.

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

  INSERT INTO public.notifications (
    user_id, title, message, type, reference_id, payment_refund_id
  ) VALUES (
    v_order.user_id,
    'Refund Completed',
    format(
      'Your %s refund for order %s was successfully processed. The remaining balance for this order is now %s. It may take additional time for the refund to appear in your original GCash account.',
      v_amount_text, v_order.tracking_number, v_balance_text
    ),
    'payment_update', v_order.id, NEW.id
  ) ON CONFLICT (payment_refund_id) WHERE payment_refund_id IS NOT NULL DO NOTHING;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.notify_refund_succeeded()
  FROM PUBLIC, anon, authenticated;

-- Existing rows were created by the immediately preceding customer
-- notification function. Rewrite only that exact template, preserving the
-- recorded refund amount, order number, and balance.
UPDATE public.notifications
SET message = regexp_replace(
  message,
  '^PayMongo confirmed the (.+) refund for order ([^ ]+) as succeeded\. The order balance is now (.+)\. Posting to the original GCash account may take additional time\.$',
  'Your \1 refund for order \2 was successfully processed. The remaining balance for this order is now \3. It may take additional time for the refund to appear in your original GCash account.'
)
WHERE payment_refund_id IS NOT NULL
  AND message ~ '^PayMongo confirmed the .+ refund for order [^ ]+ as succeeded\. The order balance is now .+\. Posting to the original GCash account may take additional time\.$';
