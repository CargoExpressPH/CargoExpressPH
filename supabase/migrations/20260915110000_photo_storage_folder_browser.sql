-- Storage Monitoring: three-column booking-folder browser + corrected manual
-- deletion rule, per the redesign request that superseded the flat gallery
-- shipped in 20260915090000.
--
-- ============================================================================
-- A. Business rule correction (the actual reason this migration exists)
-- ============================================================================
-- The previous rule made a Delivered/Cancelled booking's pickup/delivery
-- photos undeletable by an admin for 6 months (list_evidence_photos /
-- delete_evidence_photos both hard-coded a `terminal_status_at >= now() -
-- 6 months -> protected` branch). That conflated two DIFFERENT rules:
--   * MANUAL deletion — an admin choosing to remove a specific photo now.
--   * AUTOMATIC cleanup — the unattended weekly-adjacent job that removes
--     photos on its own, which genuinely should wait 6 months so an admin
--     has a real window to notice and object before anything disappears
--     without a human decision behind it.
-- get_expired_evidence_orders() / queue_expired_evidence_cleanup() /
-- archive-expired-evidence-photos (20260901020000, 20260901030000) already
-- implement the AUTOMATIC 6-month rule as a fully separate code path that
-- never calls anything touched by this migration — that rule is UNCHANGED.
-- This migration only removes the 6-month wait from the MANUAL path; an
-- admin may now delete an eligible photo from a Delivered/Cancelled booking
-- immediately, with confirmation, same as any other manual deletion.
--
-- Receipt, featured-on-website, and active-shipment (status not yet
-- Delivered/Cancelled) protections are UNCHANGED and still absolute.
--
-- One protection is ADDED here that the previous rule never checked: a
-- pickup photo currently referenced by a payment_attempts row that has not
-- yet reconciled (status 'pending' or 'chargeable') is protected. That row
-- represents a payment whose reconciliation (reconcile_paymongo_payment_
-- attempt(), 20260531080000) will still COPY this exact photo array onto the
-- order the moment it completes — deleting the photo now would leave that
-- future copy pointing at a missing file. A RECONCILED or FAILED attempt is
-- pure history and never blocks anything, matching the task's instruction
-- not to assume "every payment reference blocks forever" either.
--
-- ============================================================================
-- B. New shape: booking folders instead of one flat filtered list
-- ============================================================================
-- evidence_photo_rows() factors out the "every shipment-evidence photo,
-- classified and eligibility-tagged" query that 20260915090000's
-- list_evidence_photos() used to do inline, so list_evidence_folders() (left
-- column: one row per tracking number, or one virtual "Photos Without
-- Bookings" row) and list_folder_photos() (middle column: one folder's
-- photos) share exactly one eligibility implementation — the same
-- reason this task called out avoiding a listing/deletion rule that can
-- drift apart. delete_evidence_photos() re-derives eligibility independently
-- at execution time (as before) rather than calling this function, because
-- it needs a FOR UPDATE lock on the order row before deciding, which a
-- read-only STABLE function must not take.
--
-- list_evidence_photos() (20260915090000) is DROPPED — nothing outside this
-- migration's own replacement functions and the rewritten PhotoStorageTab.jsx
-- called it (verified by repo-wide grep before writing this migration), and
-- leaving a superseded, un-called admin RPC around is exactly the kind of
-- leftover this task's database-cleanup section asks to avoid. Unlike
-- cleanup-orphaned-photos (a separately DEPLOYED Edge Function, which must be
-- undeployed before its own backing SQL function can be dropped — see the
-- report), this is a plain SQL function dropped and replaced in the same
-- migration as the frontend that called it, so there is no ordering hazard.
-- ============================================================================

DROP FUNCTION IF EXISTS public.list_evidence_photos(text, text, integer, integer);

-- ── evidence_photo_rows(): the one shared, eligibility-tagged photo list ────
CREATE OR REPLACE FUNCTION public.evidence_photo_rows()
RETURNS TABLE(
  item_key text,
  source text,
  order_id uuid,
  tracking_number text,
  customer_name text,
  order_status text,
  photo_field text,
  provider text,
  storage_path text,
  size_bytes bigint,
  content_type text,
  taken_at timestamptz,
  status text,
  reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Not granted to anon/authenticated directly (see grants at the bottom) —
  -- only list_evidence_folders()/list_folder_photos() call it, and a
  -- SECURITY DEFINER caller's own admin check below is what actually gates
  -- this, same defense-in-depth reasoning as every other function here.
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH order_refs AS (
    SELECT
      o.id AS order_id,
      o.tracking_number::text AS tracking_number,
      COALESCE(o.receiver_name, o.sender_name)::text AS customer_name,
      o.status::text AS order_status,
      o.featured_on_website,
      field.photo_field,
      elem.value AS raw_ref,
      -- payment_attempts has no delivery_photos column, so this can only
      -- ever matter for a pickup photo. Compared by classified
      -- (provider, storage_path) identity, not raw jsonb equality, so a
      -- descriptor carrying extra/reordered fields still matches correctly
      -- — same reasoning as the array-rebuild loop in delete_evidence_photos.
      (field.photo_field = 'pickup' AND EXISTS (
        SELECT 1
        FROM public.payment_attempts pa
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pa.pickup_photos, '[]'::jsonb)) pe(value)
        CROSS JOIN LATERAL public.classify_evidence_photo_ref(pe.value) pc
        CROSS JOIN LATERAL public.classify_evidence_photo_ref(elem.value) oc
        WHERE pa.order_id = o.id
          AND pa.status IN ('pending', 'chargeable')
          AND pc.provider = oc.provider
          AND pc.storage_path = oc.storage_path
      )) AS has_pending_payment_attempt
    FROM public.orders o
    CROSS JOIN LATERAL (VALUES ('pickup', o.pickup_photos), ('delivery', o.delivery_photos))
      AS field(photo_field, arr)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(field.arr, '[]'::jsonb)) AS elem(value)
  ),
  receipt_refs AS (
    SELECT
      o.id AS order_id,
      o.tracking_number::text AS tracking_number,
      COALESCE(o.receiver_name, o.sender_name)::text AS customer_name,
      o.status::text AS order_status,
      o.featured_on_website,
      'receipt'::text AS photo_field,
      public.text_to_photo_ref(t.receipt_url) AS raw_ref,
      false AS has_pending_payment_attempt
    FROM public.payment_transactions t
    JOIN public.orders o ON o.id = t.order_id
    WHERE t.receipt_url IS NOT NULL AND btrim(t.receipt_url) <> ''
  ),
  referenced AS (
    SELECT * FROM order_refs
    UNION ALL
    SELECT * FROM receipt_refs
  ),
  classified_referenced AS (
    SELECT
      r.order_id, r.tracking_number, r.customer_name, r.photo_field,
      r.featured_on_website, r.order_status, r.has_pending_payment_attempt,
      c.provider, c.storage_path, c.size_bytes, c.content_type, c.taken_at
    FROM referenced r
    CROSS JOIN LATERAL public.classify_evidence_photo_ref(r.raw_ref) c
    WHERE c.provider IS NOT NULL
  ),
  referenced_rows AS (
    SELECT
      (cr.provider || ':' || cr.storage_path) AS item_key,
      'order'::text AS source,
      cr.order_id,
      cr.tracking_number,
      cr.customer_name,
      cr.order_status,
      cr.photo_field,
      cr.provider,
      cr.storage_path,
      cr.size_bytes,
      cr.content_type,
      cr.taken_at,
      CASE
        WHEN cr.photo_field = 'receipt' THEN 'protected'
        WHEN cr.featured_on_website THEN 'protected'
        WHEN cr.order_status NOT IN ('Delivered', 'Cancelled') THEN 'protected'
        WHEN cr.has_pending_payment_attempt THEN 'protected'
        ELSE 'eligible'
      END AS status,
      CASE
        WHEN cr.photo_field = 'receipt' THEN 'Receipt photo — kept as a financial record'
        WHEN cr.featured_on_website THEN 'Featured on the public website'
        WHEN cr.order_status NOT IN ('Delivered', 'Cancelled') THEN 'Shipment is still in progress'
        WHEN cr.has_pending_payment_attempt THEN 'A payment for this booking is still being reconciled'
        ELSE 'Delivered/Cancelled — can be deleted manually'
      END AS reason
    FROM classified_referenced cr
  ),
  orphaned_rows AS (
    SELECT
      ('supabase:' || o.name) AS item_key,
      'orphan'::text AS source,
      NULL::uuid AS order_id,
      NULL::text AS tracking_number,
      NULL::text AS customer_name,
      NULL::text AS order_status,
      CASE (storage.foldername(o.name))[1]
        WHEN 'pickup-proofs' THEN 'pickup'
        WHEN 'delivery-proofs' THEN 'delivery'
        WHEN 'receipts' THEN 'receipt'
        ELSE NULL
      END AS photo_field,
      'supabase'::text AS provider,
      o.name AS storage_path,
      CASE WHEN o.metadata ->> 'size' ~ '^[0-9]+$' THEN (o.metadata ->> 'size')::bigint ELSE NULL END AS size_bytes,
      o.metadata ->> 'mimetype' AS content_type,
      o.created_at AS taken_at,
      'eligible'::text AS status,
      'No matching booking was found for this photo'::text AS reason
    FROM storage.objects o
    WHERE o.bucket_id = 'cargo-photos'
      AND (storage.foldername(o.name))[1] IN ('pickup-proofs', 'delivery-proofs', 'receipts')
      AND (storage.foldername(o.name))[2] IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.orders ord WHERE ord.tracking_number = (storage.foldername(o.name))[2]
      )
  )
  SELECT * FROM referenced_rows
  UNION ALL
  SELECT * FROM orphaned_rows;
END;
$function$;

COMMENT ON FUNCTION public.evidence_photo_rows() IS
  'Admin-only, internal. Every shipment-evidence photo (pickup/delivery/receipt, referenced or orphaned), each tagged eligible/protected with a plain-English reason under the current manual-deletion rule (no 6-month wait; receipt/featured/active-shipment/pending-payment-reconciliation still protected). Not granted directly to any role — called only by list_evidence_folders() and list_folder_photos(), which run as its SECURITY DEFINER caller.';

-- Deliberately no REVOKE/GRANT to authenticated/anon: this function is not
-- meant to be called directly by a client. Its own admin check is defense in
-- depth; PUBLIC has no default EXECUTE on a function created by a
-- non-superuser role that hasn't granted it, so no explicit REVOKE is needed
-- to keep it out of anon's reach — see the grants block for the two wrapper
-- functions this task's audit specifically asked to correct.

-- ── list_evidence_folders(): LEFT column — one row per booking, paginated ──
CREATE OR REPLACE FUNCTION public.list_evidence_folders(
  p_search text DEFAULT NULL,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 30
)
RETURNS TABLE(
  folder_key text,
  tracking_number text,
  customer_name text,
  order_status text,
  photo_count bigint,
  eligible_count bigint,
  total_size_bytes bigint,
  latest_taken_at timestamptz,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_page integer := GREATEST(1, COALESCE(p_page, 1));
  v_page_size integer := LEAST(60, GREATEST(1, COALESCE(p_page_size, 30)));
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH grouped AS (
    SELECT
      COALESCE(r.tracking_number, '__unbooked__') AS folder_key,
      r.tracking_number,
      max(r.customer_name) AS customer_name,
      max(r.order_status) AS order_status,
      count(*)::bigint AS photo_count,
      count(*) FILTER (WHERE r.status = 'eligible')::bigint AS eligible_count,
      sum(COALESCE(r.size_bytes, 0))::bigint AS total_size_bytes,
      max(r.taken_at) AS latest_taken_at
    FROM public.evidence_photo_rows() r
    GROUP BY COALESCE(r.tracking_number, '__unbooked__'), r.tracking_number
  ),
  filtered AS (
    SELECT *
    FROM grouped g
    WHERE v_search IS NULL
       OR g.tracking_number ILIKE ('%' || v_search || '%')
       OR (g.tracking_number IS NULL AND 'photos without bookings' ILIKE ('%' || lower(v_search) || '%'))
  )
  SELECT
    f.folder_key, f.tracking_number, f.customer_name, f.order_status,
    f.photo_count, f.eligible_count, f.total_size_bytes, f.latest_taken_at,
    count(*) OVER ()::bigint AS total_count
  FROM filtered f
  -- The unbooked catch-all sorts last — it is a fallback bucket, not a
  -- booking, and pinning it keeps the normal folder order (most recent
  -- activity first) stable regardless of how large it grows.
  ORDER BY (f.tracking_number IS NULL), f.latest_taken_at DESC NULLS LAST, f.folder_key
  LIMIT v_page_size OFFSET (v_page - 1) * v_page_size;
END;
$function$;

COMMENT ON FUNCTION public.list_evidence_folders(text, integer, integer) IS
  'Admin-only. Paginated, searchable list of booking folders (one per tracking number, plus one virtual "Photos Without Bookings" folder) backing the Storage Monitoring three-column browser''s left column. Read-only.';

REVOKE ALL ON FUNCTION public.list_evidence_folders(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_evidence_folders(text, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_evidence_folders(text, integer, integer) TO authenticated;

-- ── list_folder_photos(): MIDDLE column — one folder's photos, paginated ───
CREATE OR REPLACE FUNCTION public.list_folder_photos(
  p_folder_key text,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 100
)
RETURNS TABLE(
  item_key text,
  source text,
  order_id uuid,
  tracking_number text,
  photo_field text,
  provider text,
  storage_path text,
  size_bytes bigint,
  content_type text,
  taken_at timestamptz,
  status text,
  reason text,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_page integer := GREATEST(1, COALESCE(p_page, 1));
  -- Real booking folders are always small (a handful of photos); the higher
  -- cap exists for the "Photos Without Bookings" folder, which can be large
  -- after a bulk data reset and must still be paginated, not fetched whole.
  v_page_size integer := LEAST(200, GREATEST(1, COALESCE(p_page_size, 100)));
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(btrim(p_folder_key), '') = '' THEN
    RAISE EXCEPTION 'A folder must be specified' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH matched AS (
    SELECT r.*
    FROM public.evidence_photo_rows() r
    WHERE (p_folder_key = '__unbooked__' AND r.tracking_number IS NULL)
       OR r.tracking_number = p_folder_key
  )
  SELECT
    m.item_key, m.source, m.order_id, m.tracking_number, m.photo_field,
    m.provider, m.storage_path, m.size_bytes, m.content_type, m.taken_at,
    m.status, m.reason,
    count(*) OVER ()::bigint AS total_count
  FROM matched m
  ORDER BY m.taken_at DESC NULLS LAST, m.item_key
  LIMIT v_page_size OFFSET (v_page - 1) * v_page_size;
END;
$function$;

COMMENT ON FUNCTION public.list_folder_photos(text, integer, integer) IS
  'Admin-only. Paginated list of one folder''s photos (pickup + delivery + receipt for a tracking number, or every unmatched file when p_folder_key is the __unbooked__ sentinel) backing the Storage Monitoring three-column browser''s middle column. Read-only.';

REVOKE ALL ON FUNCTION public.list_folder_photos(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_folder_photos(text, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_folder_photos(text, integer, integer) TO authenticated;

-- ============================================================================
-- C. delete_evidence_photos(): same signature, corrected eligibility
-- ============================================================================
-- Identical to 20260915090000's version except:
--   * the unconditional 6-month v_terminal_status_at check is REMOVED —
--     Delivered/Cancelled is now sufficient on its own for manual deletion;
--   * a pending/chargeable payment_attempts check is ADDED, using the same
--     classify-and-compare pattern as evidence_photo_rows() above, so
--     listing and deletion can never disagree about this rule;
--   * order_status_events / terminal_status_at are no longer read at all —
--     nothing here needs them anymore.
-- Every other guard (admin check, item cap, invalid-reference checks,
-- receipt exclusion, orphan re-verification against live storage.objects and
-- live orders, order row lock, exact (provider, path) match against the
-- CURRENT array before removing only that one element, idempotent
-- photo_cleanup_queue upsert) is unchanged.
CREATE OR REPLACE FUNCTION public.delete_evidence_photos(p_items jsonb)
RETURNS TABLE(item_key text, queue_id bigint, queued boolean, reason text, size_bytes bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_item jsonb;
  v_order_id uuid;
  v_photo_field text;
  v_provider text;
  v_storage_path text;
  v_key text;
  v_order RECORD;
  v_array jsonb;
  v_new_array jsonb;
  v_found boolean;
  v_found_size bigint;
  v_elem jsonb;
  v_elem_provider text;
  v_elem_path text;
  v_elem_size bigint;
  v_queue_id bigint;
  v_orphan_size bigint;
  v_has_pending_attempt boolean;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one photo must be selected' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'Too many photos selected at once (100 max)' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_order_id := NULLIF(v_item ->> 'order_id', '')::uuid;
    v_photo_field := v_item ->> 'photo_field';
    v_provider := v_item ->> 'provider';
    v_storage_path := v_item ->> 'storage_path';
    v_key := COALESCE(v_provider, '') || ':' || COALESCE(v_storage_path, '');
    v_queue_id := NULL;

    IF v_provider NOT IN ('supabase', 'firebase') OR v_storage_path IS NULL THEN
      item_key := v_key; queued := false; reason := 'Invalid photo reference';
      queue_id := NULL; size_bytes := NULL; RETURN NEXT; CONTINUE;
    END IF;
    IF v_provider = 'supabase' AND v_storage_path !~ '^(pickup-proofs|delivery-proofs|receipts)/[^/]+/.+' THEN
      item_key := v_key; queued := false; reason := 'Invalid photo reference';
      queue_id := NULL; size_bytes := NULL; RETURN NEXT; CONTINUE;
    END IF;
    IF v_provider = 'firebase' AND v_storage_path !~ '^photoFallbacks/[^/]+$' THEN
      item_key := v_key; queued := false; reason := 'Invalid photo reference';
      queue_id := NULL; size_bytes := NULL; RETURN NEXT; CONTINUE;
    END IF;
    IF v_photo_field = 'receipt' THEN
      item_key := v_key; queued := false; reason := 'Receipt photos are always kept';
      queue_id := NULL; size_bytes := NULL; RETURN NEXT; CONTINUE;
    END IF;

    -- ── Orphan claim: no order_id supplied. Re-derive orphan status fresh —
    -- never trust that the client's earlier read is still true.
    IF v_order_id IS NULL THEN
      IF v_provider <> 'supabase' THEN
        item_key := v_key; queued := false; reason := 'Invalid photo reference';
        queue_id := NULL; size_bytes := NULL; RETURN NEXT; CONTINUE;
      END IF;

      SELECT CASE WHEN so.metadata ->> 'size' ~ '^[0-9]+$' THEN (so.metadata ->> 'size')::bigint ELSE NULL END
        INTO v_orphan_size
        FROM storage.objects so
       WHERE so.bucket_id = 'cargo-photos' AND so.name = v_storage_path;

      IF NOT FOUND THEN
        item_key := v_key; queued := false; reason := 'This photo could not be found';
        queue_id := NULL; size_bytes := NULL; RETURN NEXT; CONTINUE;
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.orders ord
        WHERE ord.tracking_number = (storage.foldername(v_storage_path))[2]
      ) THEN
        item_key := v_key; queued := false; reason := 'A booking now matches this photo — it is no longer unused';
        queue_id := NULL; size_bytes := NULL; RETURN NEXT; CONTINUE;
      END IF;

      INSERT INTO public.photo_cleanup_queue (provider, storage_path)
      VALUES (v_provider, v_storage_path)
      ON CONFLICT (provider, storage_path) DO UPDATE
        SET queued_at = now(), completed_at = NULL, attempts = 0, last_error = NULL
      RETURNING id INTO v_queue_id;

      item_key := v_key; queued := true; reason := NULL;
      queue_id := v_queue_id; size_bytes := v_orphan_size; RETURN NEXT; CONTINUE;
    END IF;

    -- ── Referenced claim: must be pickup or delivery (never receipt, handled above).
    IF v_photo_field NOT IN ('pickup', 'delivery') THEN
      item_key := v_key; queued := false; reason := 'Invalid photo reference';
      queue_id := NULL; size_bytes := NULL; RETURN NEXT; CONTINUE;
    END IF;

    SELECT o.id, o.status::text AS status, o.featured_on_website,
           CASE WHEN v_photo_field = 'pickup' THEN o.pickup_photos ELSE o.delivery_photos END AS photos
      INTO v_order
      FROM public.orders o
     WHERE o.id = v_order_id
     FOR UPDATE;

    IF NOT FOUND THEN
      item_key := v_key; queued := false; reason := 'Booking not found';
      queue_id := NULL; size_bytes := NULL; RETURN NEXT; CONTINUE;
    END IF;
    IF v_order.featured_on_website THEN
      item_key := v_key; queued := false; reason := 'Featured on the public website';
      queue_id := NULL; size_bytes := NULL; RETURN NEXT; CONTINUE;
    END IF;
    IF v_order.status NOT IN ('Delivered', 'Cancelled') THEN
      item_key := v_key; queued := false; reason := 'Shipment is still in progress';
      queue_id := NULL; size_bytes := NULL; RETURN NEXT; CONTINUE;
    END IF;

    -- Pending-reconciliation dependency (new — see section A above). Only
    -- pickup photos can ever be referenced by payment_attempts.
    IF v_photo_field = 'pickup' THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.payment_attempts pa
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pa.pickup_photos, '[]'::jsonb)) pe(value)
        CROSS JOIN LATERAL public.classify_evidence_photo_ref(pe.value) pc
        WHERE pa.order_id = v_order_id
          AND pa.status IN ('pending', 'chargeable')
          AND pc.provider = v_provider
          AND pc.storage_path = v_storage_path
      ) INTO v_has_pending_attempt;

      IF v_has_pending_attempt THEN
        item_key := v_key; queued := false; reason := 'A payment for this booking is still being reconciled';
        queue_id := NULL; size_bytes := NULL; RETURN NEXT; CONTINUE;
      END IF;
    END IF;

    -- Rebuild the array with only the matching element removed. Matching is
    -- by classified (provider, path) identity, not array position, so a
    -- concurrent edit that reordered the array can't cause the wrong photo
    -- to be dropped.
    v_array := COALESCE(v_order.photos, '[]'::jsonb);
    v_new_array := '[]'::jsonb;
    v_found := false;
    v_found_size := NULL;
    FOR v_elem IN SELECT value FROM jsonb_array_elements(v_array)
    LOOP
      SELECT c.provider, c.storage_path, c.size_bytes
        INTO v_elem_provider, v_elem_path, v_elem_size
        FROM public.classify_evidence_photo_ref(v_elem) c;
      IF NOT v_found AND v_elem_provider = v_provider AND v_elem_path = v_storage_path THEN
        v_found := true;
        v_found_size := v_elem_size;
      ELSE
        v_new_array := v_new_array || jsonb_build_array(v_elem);
      END IF;
    END LOOP;

    IF NOT v_found THEN
      item_key := v_key; queued := false; reason := 'Photo reference no longer matches this booking';
      queue_id := NULL; size_bytes := NULL; RETURN NEXT; CONTINUE;
    END IF;

    IF v_photo_field = 'pickup' THEN
      UPDATE public.orders SET pickup_photos = v_new_array WHERE id = v_order_id;
    ELSE
      UPDATE public.orders SET delivery_photos = v_new_array WHERE id = v_order_id;
    END IF;

    INSERT INTO public.photo_cleanup_queue (provider, storage_path)
    VALUES (v_provider, v_storage_path)
    ON CONFLICT (provider, storage_path) DO UPDATE
      SET queued_at = now(), completed_at = NULL, attempts = 0, last_error = NULL
    RETURNING id INTO v_queue_id;

    item_key := v_key; queued := true; reason := NULL;
    queue_id := v_queue_id; size_bytes := v_found_size; RETURN NEXT;
  END LOOP;

  RETURN;
END;
$function$;

COMMENT ON FUNCTION public.delete_evidence_photos(jsonb) IS
  'Admin-only. For each requested photo, re-derives eligibility from scratch (order status, featured flag, receipt exclusion, pending-payment-reconciliation dependency, and that the reference still exists on the order) rather than trusting the caller''s claim. No 6-month wait for manual deletion — that threshold applies only to the separate, unattended automatic-cleanup job (get_expired_evidence_orders/archive-expired-evidence-photos), which this function does not call and is not called by. Eligible photos are removed from the order''s pickup_photos/delivery_photos array (only that one element) and upserted into the existing photo_cleanup_queue for the caller to physically delete. Never deletes the storage object or Firestore document itself.';

REVOKE ALL ON FUNCTION public.delete_evidence_photos(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_evidence_photos(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_evidence_photos(jsonb) TO authenticated;

-- ============================================================================
-- D. Company Images (company-assets bucket) — eligibility check only.
-- ============================================================================
-- Listing and reading company-assets objects uses the Storage SDK directly
-- from the admin session (list()/createSignedUrl()) rather than a new RPC:
-- admins already have full SELECT/DELETE on this bucket via the existing
-- "Admins manage company assets" FOR ALL storage.objects policy
-- (20260804180000), and the bucket only ever holds a handful of small
-- website-decoration images (no Firestore fallback, no per-booking
-- structure to reconstruct) — inventing a parallel listing RPC here would
-- be exactly the unnecessary schema/API growth this task's cleanup section
-- warns against. The one thing the browser cannot safely decide on its own
-- is "is this the image currently live on the public website", which is
-- read from company_information — that check is what this function is for.
CREATE OR REPLACE FUNCTION public.check_company_asset_deletable(p_paths text[])
RETURNS TABLE(storage_path text, deletable boolean, reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_banner_path text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;
  IF p_paths IS NULL OR array_length(p_paths, 1) IS NULL THEN
    RAISE EXCEPTION 'At least one file must be selected' USING ERRCODE = '22023';
  END IF;
  IF array_length(p_paths, 1) > 100 THEN
    RAISE EXCEPTION 'Too many files selected at once (100 max)' USING ERRCODE = '22023';
  END IF;

  -- banner_image_url is stored as a full public URL with a cache-busting
  -- "?t=..." query string (CompanyInformationPage.jsx); reduce it to the
  -- bare storage path the same way the bucket itself addresses the object.
  SELECT regexp_replace(
           regexp_replace(ci.banner_image_url, '^.*/company-assets/', ''),
           '\?.*$', ''
         )
    INTO v_banner_path
    FROM public.company_information ci
   WHERE ci.id = '00000000-0000-0000-0000-000000000001';

  RETURN QUERY
  SELECT
    p AS storage_path,
    (v_banner_path IS NULL OR p <> v_banner_path) AS deletable,
    CASE WHEN v_banner_path IS NOT NULL AND p = v_banner_path
      THEN 'Currently used as the site banner image — replace it on Company Information first.'
      ELSE NULL
    END AS reason
  FROM unnest(p_paths) AS p;
END;
$function$;

COMMENT ON FUNCTION public.check_company_asset_deletable(text[]) IS
  'Admin-only. Re-checks each company-assets storage path against the LIVE company_information.banner_image_url before the client is allowed to delete it via the Storage SDK. The only company-assets image this codebase tracks as "currently in use" today; usage outside Company Information settings (e.g. a hardcoded reference elsewhere) cannot be automatically verified and is called out in the admin UI as a caution, not silently assumed safe.';

REVOKE ALL ON FUNCTION public.check_company_asset_deletable(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_company_asset_deletable(text[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.check_company_asset_deletable(text[]) TO authenticated;
