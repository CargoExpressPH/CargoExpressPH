-- Trip Reassignment Log and Reassign RPC

CREATE TABLE IF NOT EXISTS public.trip_reassignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  previous_trip_id UUID REFERENCES public.trips(id) ON DELETE SET NULL,
  new_trip_id UUID NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  admin_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_trip_reassignments_order_id ON public.trip_reassignments(order_id);

-- RLS Policies
ALTER TABLE public.trip_reassignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view trip reassignments"
  ON public.trip_reassignments
  FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Admins can insert trip reassignments"
  ON public.trip_reassignments
  FOR INSERT
  WITH CHECK (public.is_admin());

-- Reassignment RPC
CREATE OR REPLACE FUNCTION public.reassign_trip(
  p_order_id UUID,
  p_new_trip_id UUID,
  p_reason TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_trip_id UUID;
  v_admin_id UUID;
BEGIN
  v_admin_id := auth.uid();
  IF v_admin_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only administrators can reassign trips';
  END IF;

  -- Get current trip
  SELECT trip_id INTO v_old_trip_id
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE; -- Lock order row during reassignment

  -- Check if there's actually a change
  IF v_old_trip_id = p_new_trip_id THEN
    RAISE EXCEPTION 'The new trip must be different from the current trip';
  END IF;

  -- Check if order exists
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  -- Update the order's trip_id
  UPDATE public.orders
  SET trip_id = p_new_trip_id
  WHERE id = p_order_id;

  -- Log the reassignment
  INSERT INTO public.trip_reassignments (
    order_id,
    previous_trip_id,
    new_trip_id,
    reason,
    admin_id
  ) VALUES (
    p_order_id,
    v_old_trip_id,
    p_new_trip_id,
    p_reason,
    v_admin_id
  );
END;
$$;
