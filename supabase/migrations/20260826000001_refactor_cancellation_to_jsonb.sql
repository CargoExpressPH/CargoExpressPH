-- 1. Add the new JSONB column
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cancellation_details JSONB;

-- 2. Migrate existing data

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='cancellation_reason') THEN
    EXECUTE '
    UPDATE public.orders
    SET cancellation_details = jsonb_strip_nulls(jsonb_build_object(
      ''reason'', cancellation_reason,
      ''requested_at'', cancellation_requested_at,
      ''previous_status'', cancellation_previous_status,
      ''reviewed_at'', cancellation_reviewed_at,
      ''reviewed_by'', cancellation_reviewed_by,
      ''review_notes'', cancellation_review_notes
    ))
    WHERE cancellation_reason IS NOT NULL OR cancellation_requested_at IS NOT NULL';
  END IF;
END $$;

-- 3. Update the request_order_cancellation RPC
CREATE OR REPLACE FUNCTION public.request_order_cancellation(p_order_id uuid, p_reason text)
 RETURNS public.orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order public.orders;
  v_notes text;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF auth.uid() IS NULL OR v_order.user_id != auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_order.status = 'Pending Cancellation' THEN
    RAISE EXCEPTION 'A cancellation request is already pending for this order.';
  END IF;
  IF v_order.status = 'Cancelled' THEN
    RAISE EXCEPTION 'Order is already cancelled.';
  END IF;
  IF v_order.status IN ('Picked Up', 'In Transit', 'Arrived at Hub', 'Out for Delivery', 'Delivered') THEN
    RAISE EXCEPTION 'Too late to cancel: this order is already in the delivery network.';
  END IF;

  UPDATE public.orders
     SET status = 'Pending Cancellation',
         cancellation_details = jsonb_build_object(
           'reason', p_reason,
           'requested_at', now(),
           'previous_status', v_order.status
         )
   WHERE id = p_order_id
   RETURNING * INTO v_order;

  INSERT INTO public.activity_logs (module, action, record_type, record_id, record_ref, previous_value, new_value, details)
  VALUES ('Orders', 'Cancellation Requested', 'order', v_order.id, v_order.tracking_number,
          jsonb_build_object('status', v_order.cancellation_details->>'previous_status'),
          jsonb_build_object('status', 'Pending Cancellation'),
          'Customer requested to cancel the booking. Reason: ' || p_reason);

  RETURN v_order;
END;
$function$;

-- 4. Update the review_order_cancellation RPC
CREATE OR REPLACE FUNCTION public.review_order_cancellation(p_order_id uuid, p_approve boolean, p_notes text DEFAULT NULL::text)
 RETURNS public.orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order public.orders;
  v_restore varchar;
  v_notes text;
BEGIN
  v_notes := NULLIF(trim(p_notes), '');

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_order.status != 'Pending Cancellation' THEN
    RAISE EXCEPTION 'Order is not pending cancellation';
  END IF;

  v_restore := COALESCE(v_order.cancellation_details->>'previous_status', 'Pending');

  UPDATE public.orders
     SET status = CASE WHEN p_approve THEN 'Cancelled' ELSE v_restore END,
         cancellation_details = COALESCE(v_order.cancellation_details, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
           'reviewed_at', now(),
           'reviewed_by', auth.uid(),
           'review_notes', v_notes
         ))
   WHERE id = p_order_id
   RETURNING * INTO v_order;

  INSERT INTO public.notifications (user_id, title, message, type, reference_id)
  VALUES (v_order.user_id,
          CASE WHEN p_approve THEN 'Cancellation Approved' ELSE 'Cancellation Declined' END,
          CASE WHEN p_approve
               THEN 'Order ' || v_order.tracking_number || ' has been cancelled as you requested.'
               ELSE 'Order ' || v_order.tracking_number || ' was not cancelled and is back to "' || v_restore || '".'
          END
          || COALESCE(' Note: ' || v_notes, ''),
          'order_update', v_order.id);

  INSERT INTO public.activity_logs (module, action, record_type, record_id, record_ref, previous_value, new_value, details)
  VALUES ('Orders',
          CASE WHEN p_approve THEN 'Cancellation Approved' ELSE 'Cancellation Rejected' END,
          'order',
          v_order.id,
          v_order.tracking_number,
          jsonb_build_object('status', 'Pending Cancellation'),
          jsonb_build_object('status', v_order.status),
          CASE WHEN p_approve
               THEN 'Approved the customer''s cancellation request; order cancelled.'
               ELSE 'Rejected the customer''s cancellation request; order restored to "' || v_restore || '".'
          END
          || COALESCE(' Note: ' || v_notes, '')
          || COALESCE(' Customer''s stated reason: ' || (v_order.cancellation_details->>'reason'), ''));

  RETURN v_order;
END;
$function$;

-- 5. Drop the old columns
ALTER TABLE public.orders
  DROP COLUMN IF EXISTS cancellation_reason,
  DROP COLUMN IF EXISTS cancellation_requested_at,
  DROP COLUMN IF EXISTS cancellation_previous_status,
  DROP COLUMN IF EXISTS cancellation_reviewed_at,
  DROP COLUMN IF EXISTS cancellation_reviewed_by,
  DROP COLUMN IF EXISTS cancellation_review_notes;

-- 6. Recreate the index using updated_at since JSONB ordering can be slow and we just need pending ones
DROP INDEX IF EXISTS idx_orders_pending_cancellation;
CREATE INDEX idx_orders_pending_cancellation ON public.orders (updated_at) WHERE status = 'Pending Cancellation';

