-- Lock Sender/Receiver Contact Details at Out for Delivery and Delivered
--
-- Previously, admins were fully exempt from the status-lock check in
-- update_order_contact_details(). Customers were already blocked at
-- Out for Delivery / Delivered / Cancelled.
--
-- Per the booking UI change spec: once a booking reaches Out for Delivery
-- or Delivered, its sender/receiver details must be read-only for everyone,
-- including admins. The rationale is that the physical delivery package is
-- already in transit or has been handed off — the contact/address on the
-- booking is a historical record of what was actually delivered, not a live
-- mutable field.
--
-- Cancelled bookings remain locked for customers (unchanged) but NOT for
-- admins — a cancelled booking may legitimately need address correction for
-- archival purposes or dispute resolution.
--
-- The only change is the expansion of the lock condition to include admins
-- when status IN ('Out for Delivery', 'Delivered').
-- All other guard conditions (authentication, ownership for customers,
-- field-level scope, nothing-changed no-op, audit log) are untouched.

CREATE OR REPLACE FUNCTION public.update_order_contact_details(
  p_order_id UUID,
  p_sender_name TEXT,
  p_sender_phone TEXT,
  p_sender_province TEXT,
  p_sender_city TEXT,
  p_sender_barangay TEXT,
  p_sender_street TEXT,
  p_sender_landmark TEXT,
  p_sender_address TEXT,
  p_receiver_name TEXT,
  p_receiver_phone TEXT,
  p_receiver_province TEXT,
  p_receiver_city TEXT,
  p_receiver_barangay TEXT,
  p_receiver_street TEXT,
  p_receiver_landmark TEXT,
  p_receiver_address TEXT
)
RETURNS public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order public.orders%ROWTYPE;
  v_is_admin BOOLEAN;
  v_actor TEXT;
  v_previous JSONB;
  v_new JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NULLIF(btrim(p_sender_name), '') IS NULL OR NULLIF(btrim(p_sender_phone), '') IS NULL
     OR NULLIF(btrim(p_sender_province), '') IS NULL OR NULLIF(btrim(p_sender_city), '') IS NULL
     OR NULLIF(btrim(p_sender_barangay), '') IS NULL OR NULLIF(btrim(p_sender_street), '') IS NULL
     OR NULLIF(btrim(p_sender_landmark), '') IS NULL
     OR NULLIF(btrim(p_receiver_name), '') IS NULL OR NULLIF(btrim(p_receiver_phone), '') IS NULL
     OR NULLIF(btrim(p_receiver_province), '') IS NULL OR NULLIF(btrim(p_receiver_city), '') IS NULL
     OR NULLIF(btrim(p_receiver_barangay), '') IS NULL OR NULLIF(btrim(p_receiver_street), '') IS NULL
     OR NULLIF(btrim(p_receiver_landmark), '') IS NULL THEN
    RAISE EXCEPTION 'Name, phone, province, city, barangay, street and landmark are all required for both sender and receiver.';
  END IF;

  v_is_admin := public.is_admin();

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;

  -- Customers: locked at Out for Delivery, Delivered, and Cancelled.
  -- Admins: locked at Out for Delivery and Delivered only.
  -- (Admins retain access to Cancelled bookings for archival/dispute corrections.)
  IF NOT v_is_admin THEN
    IF v_order.status IN ('Out for Delivery', 'Delivered', 'Cancelled') THEN
      RAISE EXCEPTION 'Customer details are locked once the booking is out for delivery. (current status: %)', v_order.status;
    END IF;
    IF v_order.user_id <> auth.uid() THEN
      RAISE EXCEPTION 'Only your own bookings can be edited';
    END IF;
  ELSE
    -- Admin is also locked at the final delivery stages
    IF v_order.status IN ('Out for Delivery', 'Delivered') THEN
      RAISE EXCEPTION 'Customer details are locked once the booking is out for delivery. (current status: %)', v_order.status;
    END IF;
  END IF;

  v_previous := jsonb_build_object(
    'sender_name', v_order.sender_name, 'sender_phone', v_order.sender_phone,
    'sender_province', v_order.sender_province, 'sender_city', v_order.sender_city,
    'sender_barangay', v_order.sender_barangay, 'sender_street', v_order.sender_street,
    'sender_landmark', v_order.sender_landmark, 'sender_address', v_order.sender_address,
    'receiver_name', v_order.receiver_name, 'receiver_phone', v_order.receiver_phone,
    'receiver_province', v_order.receiver_province, 'receiver_city', v_order.receiver_city,
    'receiver_barangay', v_order.receiver_barangay, 'receiver_street', v_order.receiver_street,
    'receiver_landmark', v_order.receiver_landmark, 'receiver_address', v_order.receiver_address
  );
  v_new := jsonb_build_object(
    'sender_name', btrim(p_sender_name), 'sender_phone', btrim(p_sender_phone),
    'sender_province', btrim(p_sender_province), 'sender_city', btrim(p_sender_city),
    'sender_barangay', btrim(p_sender_barangay), 'sender_street', btrim(p_sender_street),
    'sender_landmark', btrim(p_sender_landmark), 'sender_address', btrim(p_sender_address),
    'receiver_name', btrim(p_receiver_name), 'receiver_phone', btrim(p_receiver_phone),
    'receiver_province', btrim(p_receiver_province), 'receiver_city', btrim(p_receiver_city),
    'receiver_barangay', btrim(p_receiver_barangay), 'receiver_street', btrim(p_receiver_street),
    'receiver_landmark', btrim(p_receiver_landmark), 'receiver_address', btrim(p_receiver_address)
  );

  -- Nothing actually changed — return the row as-is with no write, no log.
  IF v_previous = v_new THEN
    RETURN v_order;
  END IF;

  UPDATE public.orders SET
    sender_name = btrim(p_sender_name),
    sender_phone = btrim(p_sender_phone),
    sender_province = btrim(p_sender_province),
    sender_city = btrim(p_sender_city),
    sender_barangay = btrim(p_sender_barangay),
    sender_street = btrim(p_sender_street),
    sender_landmark = btrim(p_sender_landmark),
    sender_address = btrim(p_sender_address),
    receiver_name = btrim(p_receiver_name),
    receiver_phone = btrim(p_receiver_phone),
    receiver_province = btrim(p_receiver_province),
    receiver_city = btrim(p_receiver_city),
    receiver_barangay = btrim(p_receiver_barangay),
    receiver_street = btrim(p_receiver_street),
    receiver_landmark = btrim(p_receiver_landmark),
    receiver_address = btrim(p_receiver_address)
  WHERE id = p_order_id
  RETURNING * INTO v_order;

  v_actor := CASE WHEN v_is_admin THEN 'Admin' ELSE 'Customer' END;

  INSERT INTO public.activity_logs (
    module, action, record_type, record_id, record_ref,
    previous_value, new_value, details
  ) VALUES (
    'Orders',
    v_actor || ' Updated Sender/Receiver Details',
    'order',
    v_order.id,
    v_order.tracking_number,
    v_previous,
    v_new,
    format('%s updated sender/receiver contact and address details.', v_actor)
  );

  RETURN v_order;
END;
$function$;

-- Grants are unchanged: authenticated and service_role.
REVOKE ALL ON FUNCTION public.update_order_contact_details(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_order_contact_details(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO authenticated, service_role;
