-- ============================================================
-- 20260803120000_public_data_rpcs.sql
--
-- P0-3 — Close the anonymous PII holes on the public About page.
--
-- HOLE 1 — orders:
--   CREATE POLICY "Public can read featured orders" ON orders
--     FOR SELECT TO anon USING (featured_on_website = true);
--   getFeaturedDeliveries() selects 10 safe columns, but the POLICY granted
--   anon EVERY column of every featured row. With only the anon key:
--     GET /rest/v1/orders?featured_on_website=eq.true&select=*
--   returned sender_phone, receiver_phone, sender_address, receiver_address,
--   amount_paid, payment_reference and user_id for every featured shipment.
--   The "…auth" twin granted the same to any signed-in customer.
--
-- HOLE 2 — customer_feedback:
--   Two byte-identical policies, neither with a TO clause, so both applied to
--   every role. anon could read customer_id for every visible testimonial —
--   a stable identifier linking a public review to a specific user account.
--
-- FIX: two SECURITY DEFINER RPCs returning explicitly whitelisted columns,
-- and the four policies dropped. This follows the rule already stated in
-- CLAUDE.md and already proven by track_order_public() and
-- get_public_business_profile(): never widen table-level anon access to serve
-- a public page — add an RPC.
--
-- Side benefit: public testimonials finally show an (masked) author name.
-- The old PostgREST embed profiles:customer_id(name) silently returned NULL
-- for anon, because profiles RLS blocks it — so every testimonial rendered
-- as "Customer".
-- ============================================================


-- ─── Featured deliveries (public gallery) ───────────────────
-- tracking_number and updated_at are deliberately NOT returned: the About page
-- never renders them, and a tracking number is a lookup key for
-- track_order_public().
CREATE OR REPLACE FUNCTION public.get_featured_deliveries()
RETURNS TABLE (
  id                  UUID,
  featured_title      TEXT,
  featured_caption    TEXT,
  featured_image_type TEXT,
  featured_at         TIMESTAMPTZ,
  pickup_photos       JSONB,
  delivery_photos     JSONB,
  receiver_city       TEXT,
  receiver_province   TEXT
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
    o.pickup_photos,
    o.delivery_photos,
    o.receiver_city,
    o.receiver_province
  FROM public.orders o
  WHERE o.featured_on_website = true
  ORDER BY o.featured_at DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.get_featured_deliveries() TO anon, authenticated;


-- ─── Public feedback / testimonials ─────────────────────────
-- customer_id is NEVER returned. The author name is masked through the same
-- mask_name() helper the public tracking RPC uses ("Juan Dela Cruz" → "Juan C.").
CREATE OR REPLACE FUNCTION public.get_public_feedback()
RETURNS TABLE (
  id                  UUID,
  rating              INTEGER,
  message             TEXT,
  created_at          TIMESTAMPTZ,
  customer_name       TEXT,
  featured_on_website BOOLEAN,
  featured_image_type TEXT,
  pickup_photos       JSONB,
  delivery_photos     JSONB,
  receiver_city       TEXT,
  receiver_province   TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    f.id,
    f.rating,
    f.message,
    f.created_at,
    public.mask_name(p.name) AS customer_name,
    COALESCE(o.featured_on_website, false) AS featured_on_website,
    o.featured_image_type,
    o.pickup_photos,
    o.delivery_photos,
    o.receiver_city,
    o.receiver_province
  FROM public.customer_feedback f
  LEFT JOIN public.profiles p ON p.id = f.customer_id
  LEFT JOIN public.orders   o ON o.id = f.order_id
  WHERE f.is_hidden = false
  ORDER BY f.rating DESC, f.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_feedback() TO anon, authenticated;


-- ─── Drop the over-broad policies ───────────────────────────
-- orders: anon now has NO table-level access at all. Public reads go through
-- track_order_public(), get_public_order_events() and get_featured_deliveries(),
-- all SECURITY DEFINER with whitelisted columns.
DROP POLICY IF EXISTS "Public can read featured orders" ON public.orders;
DROP POLICY IF EXISTS "Public can read featured orders auth" ON public.orders;

-- customer_feedback: the remaining policies still cover every non-public path —
--   "Admins can manage all feedback"    → admin FeedbackPage
--   "Customers can insert own feedback" → submitFeedback()
--   "Customers can read own feedback"   → checkIfFeedbackExists()
DROP POLICY IF EXISTS "Public can read non-hidden feedback" ON public.customer_feedback;
DROP POLICY IF EXISTS "Public can read non-hidden feedback auth" ON public.customer_feedback;


-- ============================================================
-- VERIFY (run manually after applying):
--
--   -- Should now return 0 rows / permission denied with the ANON key:
--   select * from orders where featured_on_website = true;
--   select customer_id from customer_feedback;
--
--   -- Should both still work with the ANON key:
--   select * from get_featured_deliveries();
--   select * from get_public_feedback();
-- ============================================================
