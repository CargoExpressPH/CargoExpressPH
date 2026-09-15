-- Simplify the admin Storage Monitoring page into a searchable photo gallery
-- with select-and-delete, per STORAGE_MONITORING_SIMPLIFICATION_IMPLEMENTATION.md.
--
-- This migration is ADDITIVE ONLY. Nothing is dropped:
--   - photo_storage_settings / photo_storage_events / photo_cleanup_queue keep
--     every existing column. force_firebase_expires_at / reason / updated_by
--     remain necessary: is_supabase_evidence_upload_allowed() (storage RLS)
--     still enforces the force_firebase routing at the Storage layer, and
--     set_photo_storage_mode()/get_effective_photo_storage_mode() remain a
--     backend safety valve an operator can still call directly by SQL during
--     an incident. Only the admin-facing manual toggle UI is being removed.
--   - list_orphaned_evidence_photos(), get_expired_evidence_orders(),
--     get_photo_storage_summary(), get_photo_storage_live_usage(),
--     queue_expired_evidence_cleanup(), record_photo_cleanup_queue_result(),
--     purge_old_photo_*() are all reused as-is (called from the new
--     functions below, or unchanged).
--
-- What this migration adds:
--   1. classify_evidence_photo_ref() / text_to_photo_ref() — SQL-side mirrors
--      of src/lib/photoReference.js's normalizePhotoReference(), used to read
--      provider + path + size out of a stored photo descriptor (current or
--      legacy shape) without a network call.
--   2. list_evidence_photos() — paginated, searchable, filterable read of
--      every shipment-evidence photo (referenced + orphaned), each tagged
--      eligible/protected with a plain-English reason. Backs the new gallery.
--   3. delete_evidence_photos() — re-verifies eligibility from scratch for
--      each requested photo (active-shipment check, featured check, receipt
--      check, 6-month cutoff, and that the exact reference still exists on
--      the order) before queuing it in the existing photo_cleanup_queue.
--      Never trusts a client-supplied "this is eligible" flag.
--   4. Schedules the two retention functions added in 20260908112100 and
--      secured in 20260911075700 — they existed but were never scheduled.
--   5. Resets photo_storage_settings to 'automatic' if it is not already
--      (idempotent; live value was already 'automatic' as of this writing —
--      see the review's live-verification note in the implementation doc).

-- ============================================================================
-- 1. Descriptor classifiers (pure functions, no table access)
-- ============================================================================

-- Mirrors photoReference.js's text-column handling: a TEXT column (only
-- payment_transactions.receipt_url uses this) may hold a JSON-serialized
-- descriptor, a legacy raw path, or a legacy absolute/data/blob URL.
CREATE OR REPLACE FUNCTION public.text_to_photo_ref(p_text text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $function$
BEGIN
  IF p_text IS NULL OR btrim(p_text) = '' THEN
    RETURN NULL;
  END IF;
  IF left(btrim(p_text), 1) = '{' THEN
    BEGIN
      RETURN btrim(p_text)::jsonb;
    EXCEPTION WHEN OTHERS THEN
      RETURN to_jsonb(p_text);
    END;
  END IF;
  RETURN to_jsonb(p_text);
END;
$function$;

COMMENT ON FUNCTION public.text_to_photo_ref(text) IS
  'Normalizes a legacy TEXT photo column (e.g. payment_transactions.receipt_url) into the same jsonb shape orders.pickup_photos/delivery_photos already use, mirroring src/lib/photoReference.js.';

-- Mirrors archive-expired-evidence-photos/index.ts's classifyPhoto(), scoped
-- to the two provider kinds this app can act on (supabase_storage,
-- firestore_fallback). Anything else (direct_url, embedded data: URL,
-- unrecognized shape) returns no rows on purpose — those are shown to the
-- admin as "legacy format" and are never individually selectable for
-- deletion, exactly like archive-expired-evidence-photos already treats an
-- "unknown" reference as unsafe to touch automatically.
CREATE OR REPLACE FUNCTION public.classify_evidence_photo_ref(p_ref jsonb)
RETURNS TABLE(provider text, storage_path text, size_bytes bigint, content_type text, taken_at timestamptz)
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_path text;
BEGIN
  IF p_ref IS NULL THEN
    RETURN;
  END IF;

  IF jsonb_typeof(p_ref) = 'object' THEN
    IF (p_ref ->> 'type') = 'firestore_fallback' OR p_ref ? 'firestore_path' THEN
      v_path := p_ref ->> 'firestore_path';
      IF v_path ~ '^photoFallbacks/[^/]+$' THEN
        RETURN QUERY SELECT
          'firebase'::text,
          v_path,
          NULLIF(p_ref ->> 'size_bytes', '')::bigint,
          p_ref ->> 'content_type',
          NULLIF(p_ref ->> 'created_at', '')::timestamptz;
      END IF;
      RETURN;
    END IF;

    IF (p_ref ->> 'type') = 'supabase_storage' OR p_ref ? 'path' THEN
      v_path := p_ref ->> 'path';
      -- Includes receipts/ so receipt descriptors classify correctly for
      -- display; deletion eligibility for receipts is still always denied,
      -- decided separately in delete_evidence_photos(), not by this shape
      -- check.
      IF v_path ~ '^(pickup-proofs|delivery-proofs|receipts)/[^/]+/.+' THEN
        RETURN QUERY SELECT
          'supabase'::text,
          v_path,
          NULLIF(p_ref ->> 'size_bytes', '')::bigint,
          p_ref ->> 'content_type',
          NULLIF(p_ref ->> 'created_at', '')::timestamptz;
      END IF;
      RETURN;
    END IF;

    RETURN; -- direct_url / embedded / unrecognized object shape
  END IF;

  IF jsonb_typeof(p_ref) = 'string' THEN
    v_path := p_ref #>> '{}';
    IF v_path IS NULL OR btrim(v_path) = '' THEN
      RETURN;
    END IF;
    v_path := btrim(v_path);

    -- Legacy double-encoded case: a jsonb array element that is itself a
    -- JSON-serialized descriptor string (mirrors photoReference.js's
    -- parseJsonReference, applied there to every string element regardless
    -- of source column).
    IF left(v_path, 1) = '{' THEN
      BEGIN
        RETURN QUERY SELECT * FROM public.classify_evidence_photo_ref(v_path::jsonb);
      EXCEPTION WHEN OTHERS THEN
        NULL; -- not actually valid JSON — treated as unclassified, same as any other unrecognized shape
      END;
      RETURN;
    END IF;

    IF v_path ~ '^photoFallbacks/[^/]+$' THEN
      RETURN QUERY SELECT 'firebase'::text, v_path, NULL::bigint, NULL::text, NULL::timestamptz;
      RETURN;
    END IF;
    IF v_path ~ '^https?:' OR v_path ~ '^data:image/' OR v_path ~ '^(blob:|error:)' THEN
      RETURN; -- legacy absolute URL / embedded image — not path-addressable
    END IF;

    v_path := regexp_replace(v_path, '^/+', '');
    IF v_path ~ '^(pickup-proofs|delivery-proofs|receipts)/[^/]+/.+' THEN
      RETURN QUERY SELECT 'supabase'::text, v_path, NULL::bigint, NULL::text, NULL::timestamptz;
    END IF;
    RETURN;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.classify_evidence_photo_ref(jsonb) IS
  'Reads provider/path/size/date out of one pickup_photos or delivery_photos array element (current or legacy shape), mirroring src/lib/photoReference.js''s normalizePhotoReference(). Display/parsing helper only — never the source of a deletion-eligibility decision.';

-- ============================================================================
-- 2. list_evidence_photos — backs the simplified gallery
-- ============================================================================

CREATE OR REPLACE FUNCTION public.list_evidence_photos(
  p_filter text DEFAULT 'all',
  p_search text DEFAULT NULL,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 20
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
  v_cutoff timestamptz := now() - INTERVAL '6 months';
  v_page integer := GREATEST(1, COALESCE(p_page, 1));
  v_page_size integer := LEAST(60, GREATEST(1, COALESCE(p_page_size, 20)));
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;
  IF p_filter NOT IN ('all', 'eligible', 'protected') THEN
    RAISE EXCEPTION 'Invalid filter' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH order_refs AS (
    SELECT
      o.id AS order_id,
      o.tracking_number::text AS tracking_number,
      o.status::text AS order_status,
      o.featured_on_website,
      ts.terminal_status_at,
      field.photo_field,
      elem.value AS raw_ref
    FROM public.orders o
    JOIN LATERAL (
      SELECT max(e.changed_at) AS terminal_status_at
      FROM public.order_status_events e
      WHERE e.order_id = o.id AND e.status = o.status
    ) ts ON TRUE
    CROSS JOIN LATERAL (VALUES ('pickup', o.pickup_photos), ('delivery', o.delivery_photos))
      AS field(photo_field, arr)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(field.arr, '[]'::jsonb)) AS elem(value)
  ),
  receipt_refs AS (
    SELECT
      o.id AS order_id,
      o.tracking_number::text AS tracking_number,
      o.status::text AS order_status,
      o.featured_on_website,
      ts.terminal_status_at,
      'receipt'::text AS photo_field,
      public.text_to_photo_ref(t.receipt_url) AS raw_ref
    FROM public.payment_transactions t
    JOIN public.orders o ON o.id = t.order_id
    JOIN LATERAL (
      SELECT max(e.changed_at) AS terminal_status_at
      FROM public.order_status_events e
      WHERE e.order_id = o.id AND e.status = o.status
    ) ts ON TRUE
    WHERE t.receipt_url IS NOT NULL AND btrim(t.receipt_url) <> ''
  ),
  referenced AS (
    SELECT * FROM order_refs
    UNION ALL
    SELECT * FROM receipt_refs
  ),
  classified_referenced AS (
    SELECT
      r.order_id, r.tracking_number, r.photo_field, r.terminal_status_at,
      r.featured_on_website, r.order_status,
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
        WHEN cr.terminal_status_at IS NULL OR cr.terminal_status_at >= v_cutoff THEN 'protected'
        ELSE 'eligible'
      END AS status,
      CASE
        WHEN cr.photo_field = 'receipt' THEN 'Receipt photo — kept as a financial record'
        WHEN cr.featured_on_website THEN 'Featured on the public website'
        WHEN cr.order_status NOT IN ('Delivered', 'Cancelled') THEN 'Shipment is still in progress'
        WHEN cr.terminal_status_at IS NULL OR cr.terminal_status_at >= v_cutoff
          THEN 'Delivered/cancelled recently — kept for 6 months'
        ELSE 'Delivered/cancelled over 6 months ago'
      END AS reason
    FROM classified_referenced cr
  ),
  orphaned_rows AS (
    SELECT
      ('supabase:' || o.name) AS item_key,
      'orphan'::text AS source,
      NULL::uuid AS order_id,
      (storage.foldername(o.name))[2]::text AS tracking_number,
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
  ),
  combined AS (
    SELECT * FROM referenced_rows
    UNION ALL
    SELECT * FROM orphaned_rows
  ),
  filtered AS (
    -- Table-qualified even though "combined" is the only table in scope:
    -- bare status / tracking_number here are ambiguous against this
    -- function's own RETURNS TABLE column names, which PL/pgSQL treats as
    -- implicitly declared variables (the exact bug class already fixed once
    -- for this module in 20260831200000_fix_ambiguous_upload_mode.sql and
    -- 20260831204600_fix_ambiguous_set_photo_storage_mode.sql).
    SELECT *
    FROM combined c
    WHERE (p_filter = 'all' OR c.status = p_filter)
      AND (v_search IS NULL OR c.tracking_number ILIKE ('%' || v_search || '%'))
  )
  SELECT
    f.item_key, f.source, f.order_id, f.tracking_number, f.photo_field,
    f.provider, f.storage_path, f.size_bytes, f.content_type, f.taken_at,
    f.status, f.reason,
    count(*) OVER ()::bigint AS total_count
  FROM filtered f
  ORDER BY f.taken_at DESC NULLS LAST, f.item_key
  LIMIT v_page_size OFFSET (v_page - 1) * v_page_size;
END;
$function$;

COMMENT ON FUNCTION public.list_evidence_photos(text, text, integer, integer) IS
  'Admin-only. Paginated, searchable, filterable list of every shipment-evidence photo (pickup/delivery/receipt, referenced or orphaned), each tagged eligible/protected with a plain-English reason. Backs the simplified Storage Monitoring gallery. Read-only — does not delete or modify anything.';

REVOKE ALL ON FUNCTION public.list_evidence_photos(text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_evidence_photos(text, text, integer, integer) TO authenticated;

-- ============================================================================
-- 3. delete_evidence_photos — re-verifies eligibility, queues real deletion
-- ============================================================================

CREATE OR REPLACE FUNCTION public.delete_evidence_photos(p_items jsonb)
RETURNS TABLE(item_key text, queue_id bigint, queued boolean, reason text, size_bytes bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cutoff timestamptz := now() - INTERVAL '6 months';
  v_item jsonb;
  v_order_id uuid;
  v_photo_field text;
  v_provider text;
  v_storage_path text;
  v_key text;
  v_order RECORD;
  v_terminal_status_at timestamptz;
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
    -- never trust that the client's earlier list_evidence_photos() read is
    -- still true (an order could have been created since, or the file could
    -- already be gone).
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

    SELECT max(e.changed_at) INTO v_terminal_status_at
      FROM public.order_status_events e
     WHERE e.order_id = v_order_id AND e.status = v_order.status;

    IF v_terminal_status_at IS NULL OR v_terminal_status_at >= v_cutoff THEN
      item_key := v_key; queued := false; reason := 'Delivered/cancelled recently — kept for 6 months';
      queue_id := NULL; size_bytes := NULL; RETURN NEXT; CONTINUE;
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
  'Admin-only. For each requested photo, re-derives eligibility from scratch (order status, featured flag, 6-month cutoff, receipt exclusion, and that the reference still exists on the order) rather than trusting the caller''s claim. Eligible photos are removed from the order''s pickup_photos/delivery_photos array (only that one element — orphans have no order to touch) and upserted into the existing photo_cleanup_queue for the caller to physically delete. Never deletes the storage object or Firestore document itself — that happens in the delete-storage-photos Edge Function using service-role credentials, exactly like the existing scheduled archive job.';

REVOKE ALL ON FUNCTION public.delete_evidence_photos(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_evidence_photos(jsonb) TO authenticated;

-- ============================================================================
-- 4. Schedule the retention functions added 2026-09-08 and secured 2026-09-11.
--    They were never scheduled — see STORAGE_MONITORING_SIMPLIFICATION_REVIEW.md
--    §8. Weekly is enough: purge_old_photo_storage_events only removes rows
--    older than 30 days, purge_old_photo_cleanup_queue only removes COMPLETED
--    rows older than 7 days (pending/failed/retrying rows are never touched).
-- ============================================================================

SELECT cron.schedule(
  'purge_photo_storage_operational_logs',
  '0 3 * * 0', -- Sundays 03:00 UTC
  $cron$
    SELECT public.purge_old_photo_storage_events(30);
    SELECT public.purge_old_photo_cleanup_queue(7);
  $cron$
);

-- ============================================================================
-- 5. Idempotent safety transition: if the admin-facing manual routing toggle
--    (now removed from the UI) happened to be mid-override at deploy time,
--    return it to Automatic instead of leaving it stuck until its own
--    (already ≤24h-capped) expiry. No-op if already 'automatic', which is
--    the live value as of this migration being written.
-- ============================================================================

UPDATE public.photo_storage_settings
   SET upload_mode = 'automatic',
       force_firebase_expires_at = NULL,
       reason = 'Reset to Automatic — manual override control removed from the admin page.',
       updated_by = NULL,
       updated_at = now()
 WHERE id = TRUE AND upload_mode <> 'automatic';
