-- Splits update_order_contact_details()'s p_sender_name/p_receiver_name
-- params into first/last name pairs, matching the new
-- sender_first_name/sender_last_name/receiver_first_name/receiver_last_name
-- columns added in 20260922100000_split_sender_receiver_names.sql.
--
-- The RPC's own UPDATE statement only writes the four *_first_name/
-- *_last_name columns (plus phone/address as before) — it does NOT write
-- sender_name/receiver_name directly. guard_order_update() (which fires
-- BEFORE UPDATE on every write to this table, this RPC's own UPDATE
-- included — see 20260922100000's header comment) derives sender_name/
-- receiver_name from the first/last pair automatically, the same way it
-- already does for a raw client write. One resolution path, not two.
--
-- Both first AND last name are now required (not just a non-blank combined
-- name, as before) — this is the new, stricter standard this feature
-- introduces for anything written going forward; it does not touch already-
-- backfilled legacy rows, which may have a blank last_name from a legacy
-- single-word name (see 20260922100000's backfill comment).
--
-- Postgres does not "replace" a function whose argument list changed shape
-- (it would create a second, overloaded function instead) — the old
-- 17-argument signature is dropped explicitly before the new 19-argument
-- one is created.
DROP FUNCTION IF EXISTS public.update_order_contact_details(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
);

CREATE OR REPLACE FUNCTION public.update_order_contact_details(
  p_order_id UUID,
  p_sender_first_name TEXT,
  p_sender_last_name TEXT,
  p_sender_phone TEXT,
  p_sender_province TEXT,
  p_sender_city TEXT,
  p_sender_barangay TEXT,
  p_sender_street TEXT,
  p_sender_landmark TEXT,
  p_sender_address TEXT,
  p_receiver_first_name TEXT,
  p_receiver_last_name TEXT,
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

  IF NULLIF(btrim(p_sender_first_name), '') IS NULL OR NULLIF(btrim(p_sender_last_name), '') IS NULL
     OR NULLIF(btrim(p_sender_phone), '') IS NULL
     OR NULLIF(btrim(p_sender_province), '') IS NULL OR NULLIF(btrim(p_sender_city), '') IS NULL
     OR NULLIF(btrim(p_sender_barangay), '') IS NULL OR NULLIF(btrim(p_sender_street), '') IS NULL
     OR NULLIF(btrim(p_sender_landmark), '') IS NULL
     OR NULLIF(btrim(p_receiver_first_name), '') IS NULL OR NULLIF(btrim(p_receiver_last_name), '') IS NULL
     OR NULLIF(btrim(p_receiver_phone), '') IS NULL
     OR NULLIF(btrim(p_receiver_province), '') IS NULL OR NULLIF(btrim(p_receiver_city), '') IS NULL
     OR NULLIF(btrim(p_receiver_barangay), '') IS NULL OR NULLIF(btrim(p_receiver_street), '') IS NULL
     OR NULLIF(btrim(p_receiver_landmark), '') IS NULL THEN
    RAISE EXCEPTION 'First name, last name, phone, province, city, barangay, street and landmark are all required for both sender and receiver.';
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
    'sender_first_name', v_order.sender_first_name, 'sender_last_name', v_order.sender_last_name,
    'sender_phone', v_order.sender_phone,
    'sender_province', v_order.sender_province, 'sender_city', v_order.sender_city,
    'sender_barangay', v_order.sender_barangay, 'sender_street', v_order.sender_street,
    'sender_landmark', v_order.sender_landmark, 'sender_address', v_order.sender_address,
    'receiver_first_name', v_order.receiver_first_name, 'receiver_last_name', v_order.receiver_last_name,
    'receiver_phone', v_order.receiver_phone,
    'receiver_province', v_order.receiver_province, 'receiver_city', v_order.receiver_city,
    'receiver_barangay', v_order.receiver_barangay, 'receiver_street', v_order.receiver_street,
    'receiver_landmark', v_order.receiver_landmark, 'receiver_address', v_order.receiver_address
  );
  v_new := jsonb_build_object(
    'sender_first_name', btrim(p_sender_first_name), 'sender_last_name', btrim(p_sender_last_name),
    'sender_phone', btrim(p_sender_phone),
    'sender_province', btrim(p_sender_province), 'sender_city', btrim(p_sender_city),
    'sender_barangay', btrim(p_sender_barangay), 'sender_street', btrim(p_sender_street),
    'sender_landmark', btrim(p_sender_landmark), 'sender_address', btrim(p_sender_address),
    'receiver_first_name', btrim(p_receiver_first_name), 'receiver_last_name', btrim(p_receiver_last_name),
    'receiver_phone', btrim(p_receiver_phone),
    'receiver_province', btrim(p_receiver_province), 'receiver_city', btrim(p_receiver_city),
    'receiver_barangay', btrim(p_receiver_barangay), 'receiver_street', btrim(p_receiver_street),
    'receiver_landmark', btrim(p_receiver_landmark), 'receiver_address', btrim(p_receiver_address)
  );

  -- Nothing actually changed — return the row as-is with no write, no log.
  IF v_previous = v_new THEN
    RETURN v_order;
  END IF;

  -- sender_name/receiver_name are deliberately NOT set here — guard_order_update()
  -- derives them from the first/last pair on this same UPDATE (BEFORE trigger).
  UPDATE public.orders SET
    sender_first_name = btrim(p_sender_first_name),
    sender_last_name = btrim(p_sender_last_name),
    sender_phone = btrim(p_sender_phone),
    sender_province = btrim(p_sender_province),
    sender_city = btrim(p_sender_city),
    sender_barangay = btrim(p_sender_barangay),
    sender_street = btrim(p_sender_street),
    sender_landmark = btrim(p_sender_landmark),
    sender_address = btrim(p_sender_address),
    receiver_first_name = btrim(p_receiver_first_name),
    receiver_last_name = btrim(p_receiver_last_name),
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

-- Grants are unchanged in kind: authenticated and service_role.
REVOKE ALL ON FUNCTION public.update_order_contact_details(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_order_contact_details(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO authenticated, service_role;

-- ============================================================
-- VERIFY (must return exactly 1 row):
--   SELECT COUNT(*) FROM pg_proc WHERE proname = 'update_order_contact_details';
-- ============================================================
