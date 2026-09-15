-- ============================================================
-- Migration: 20260915150000_add_delivered_at_to_featured_deliveries.sql
-- Purpose  : Give the public Featured Shipments gallery an authoritative
--            "delivered on" date, without adding a new column or exposing
--            any new table to anon.
--
-- Why order_status_events, not a new orders.delivered_at column:
--   orders has no dedicated delivery-completion timestamp today (updated_at
--   moves on ANY column change — payment edits, contact-detail edits,
--   discount changes, etc. — so it is not a reliable "when was this
--   delivered" signal). order_status_events, however, already exists
--   specifically to record status transitions: log_order_status_event()
--   (trigger orders_log_status_event, AFTER INSERT OR UPDATE OF status ON
--   orders) inserts a row with the server's own clock every time
--   orders.status changes, including the move into 'Delivered'. That is
--   already the authoritative source get_public_order_events() uses for the
--   public tracking timeline (MIN(changed_at) GROUP BY status, in case a
--   status is ever re-entered) — this migration reuses the exact same
--   convention for the one status this feature needs, scoped to a single
--   already-featured order via a correlated subquery, so no new public
--   surface is added: order_status_events itself gains no new grant or RLS
--   policy, and get_featured_deliveries() (SECURITY DEFINER, already
--   anon-executable) exposes only the one derived timestamp, nothing else
--   from that table (no `note`, no `changed_by`).
--
-- Redelivery/reopening: orders has no reopen/re-deliver workflow today
-- ('Delivered' has no forward transition in STATUS_FLOW and no admin action
-- moves a Delivered order back a step) — but MIN() is used regardless, so if
-- 'Delivered' is ever re-entered for the same order, this keeps reporting
-- the FIRST time it was delivered, consistent with
-- get_public_order_events()'s own handling of repeated statuses. Never the
-- most recent status *edit* in general — only the first arrival at
-- 'Delivered' specifically.
-- ============================================================

DROP FUNCTION IF EXISTS public.get_featured_deliveries();

CREATE OR REPLACE FUNCTION public.get_featured_deliveries()
RETURNS TABLE (
  id                  UUID,
  featured_title      TEXT,
  featured_caption    TEXT,
  featured_image_type TEXT,
  featured_at         TIMESTAMPTZ,
  featured_photo      TEXT,   -- single admin-selected photo path
  receiver_city       TEXT,
  receiver_province   TEXT,
  delivered_at        TIMESTAMPTZ  -- first time this booking's status reached 'Delivered'; NULL if that event was never logged
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    o.id,
    o.featured_title,
    o.featured_caption,
    o.featured_image_type,
    o.featured_at,
    CASE
      WHEN o.featured_image_type = 'delivery'
           AND jsonb_array_length(COALESCE(o.delivery_photos, '[]'::jsonb)) > 0
        THEN o.delivery_photos ->> 0
      WHEN jsonb_array_length(COALESCE(o.pickup_photos, '[]'::jsonb)) > 0
        THEN o.pickup_photos ->> 0
      ELSE NULL
    END AS featured_photo,
    o.receiver_city,
    o.receiver_province,
    (
      SELECT MIN(e.changed_at)
      FROM public.order_status_events e
      WHERE e.order_id = o.id AND e.status = 'Delivered'
    ) AS delivered_at
  FROM public.orders o
  WHERE o.featured_on_website = true
    AND o.featured_title IS NOT NULL
    AND btrim(o.featured_title) <> ''
  ORDER BY o.featured_at DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.get_featured_deliveries() TO anon, authenticated;
