-- ============================================================
-- 20260803110000_order_status_events.sql
--
-- P0-2 — Give shipment status history a permanent home.
--
-- BEFORE: the tracking timeline was reconstructed from activity_logs by fuzzy
-- string matching (20 hardcoded action strings, a "Status Changed to X" prefix
-- parse, and substring sniffing on `details`). activity_logs is purged after
-- 7 days by the purge-old-activity-logs cron job, so every shipment's timeline
-- silently collapsed to order.created_at once it aged out.
--
-- AFTER: an append-only event table fed by a trigger on orders. No retention
-- purge. A trigger cannot forget to log the way a logOrder() call site can.
--
-- This table is deliberately NOT unique on (order_id, status): a status can
-- legitimately be re-entered (e.g. reassignment bouncing an order back to
-- Assigned). Consumers take MIN(changed_at) per status for "first reached".
-- ============================================================


CREATE TABLE IF NOT EXISTS public.order_status_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  status     VARCHAR(30) NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by UUID DEFAULT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  note       TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_status_events_order_id
  ON public.order_status_events(order_id, changed_at);


-- ─── RLS ────────────────────────────────────────────────────
ALTER TABLE public.order_status_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users view own order status events" ON public.order_status_events;
CREATE POLICY "Users view own order status events" ON public.order_status_events
  FOR SELECT USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_status_events.order_id
        AND o.user_id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE policy: rows are written exclusively by the
-- SECURITY DEFINER trigger below. Nothing else may touch this table.


-- ─── Trigger ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.log_order_status_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.order_status_events (order_id, status, changed_at, changed_by)
    VALUES (NEW.id, NEW.status, COALESCE(NEW.created_at, NOW()), auth.uid());
    RETURN NEW;
  END IF;

  -- UPDATE: only when the status actually moved.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.order_status_events (order_id, status, changed_at, changed_by)
    VALUES (NEW.id, NEW.status, NOW(), auth.uid());
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_log_status_event ON public.orders;
CREATE TRIGGER orders_log_status_event
  AFTER INSERT OR UPDATE OF status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.log_order_status_event();


-- ─── Public tracking RPC ────────────────────────────────────
-- Anonymous visitors cannot read order_status_events directly (RLS above).
-- This returns ONLY status + timestamp — no names, no amounts, no ids.
--
-- Deliberately a separate function rather than an extension of
-- track_order_public(): that RPC's return signature is consumed positionally
-- by the frontend, and it does not return orders.id, which is why
-- TrackingPage's log fetch (guarded on `data?.id`) never actually ran.
CREATE OR REPLACE FUNCTION public.get_public_order_events(p_tracking_number TEXT)
RETURNS TABLE (
  status     VARCHAR,
  changed_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.status, MIN(e.changed_at) AS changed_at
  FROM public.order_status_events e
  JOIN public.orders o ON o.id = e.order_id
  WHERE o.tracking_number = UPPER(TRIM(p_tracking_number))
  GROUP BY e.status
  ORDER BY MIN(e.changed_at);
$$;

GRANT EXECUTE ON FUNCTION public.get_public_order_events(TEXT) TO anon, authenticated;


-- ============================================================
-- BACKFILL — one-time, idempotent.
--
-- HONEST LIMITATION: status history older than the 7-day activity_logs
-- retention window is already gone and cannot be recovered. This backfill
-- reconstructs what is still knowable:
--   (a) the creation event, from orders.created_at
--   (b) any surviving activity_logs row carrying an explicit
--       new_value->>'status' (the authoritative case — the fuzzy
--       action-string matching is deliberately NOT reproduced here)
--   (c) the current status, from orders.updated_at
-- Steps between (a) and (c) with no surviving log are left absent; the
-- client-side backfill in statusTimestamps.js fills them by inheriting the
-- previous completed step's timestamp, exactly as it does today.
--
-- Each insert is guarded by NOT EXISTS on (order_id, status) so re-running
-- this migration cannot create duplicates.
-- ============================================================

-- (a) Creation event.
INSERT INTO public.order_status_events (order_id, status, changed_at)
SELECT
  o.id,
  CASE WHEN o.service_area_status = 'for_review' THEN 'Pending Review' ELSE 'Pending' END,
  o.created_at
FROM public.orders o
WHERE NOT EXISTS (
  SELECT 1 FROM public.order_status_events e
  WHERE e.order_id = o.id
    AND e.status = CASE WHEN o.service_area_status = 'for_review' THEN 'Pending Review' ELSE 'Pending' END
);

-- (b) Surviving explicit status transitions from activity_logs.
INSERT INTO public.order_status_events (order_id, status, changed_at, changed_by, note)
SELECT DISTINCT ON (al.record_id, al.new_value->>'status')
  al.record_id,
  al.new_value->>'status',
  al.created_at,
  al.admin_id,
  'Backfilled from activity_logs'
FROM public.activity_logs al
JOIN public.orders o ON o.id = al.record_id
WHERE al.record_id IS NOT NULL
  AND al.new_value ? 'status'
  AND al.new_value->>'status' IN (
    'Pending Review', 'Pending', 'Assigned', 'Picked Up', 'In Transit',
    'Arrived at Hub', 'Out for Delivery', 'Delivered', 'Cancelled'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.order_status_events e
    WHERE e.order_id = al.record_id
      AND e.status = al.new_value->>'status'
  )
ORDER BY al.record_id, al.new_value->>'status', al.created_at ASC;

-- (c) Current status.
INSERT INTO public.order_status_events (order_id, status, changed_at, note)
SELECT o.id, o.status, COALESCE(o.updated_at, o.created_at), 'Backfilled from current order status'
FROM public.orders o
WHERE NOT EXISTS (
  SELECT 1 FROM public.order_status_events e
  WHERE e.order_id = o.id AND e.status = o.status
);
