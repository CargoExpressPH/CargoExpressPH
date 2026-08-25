-- ============================================================================
-- Announcement comments
--
-- Customers interact with an announcement (reserving an item, asking a
-- question) by commenting on it. The thread is stored as a JSONB array on the
-- announcement row itself: one column, no join, and the whole thread arrives
-- with the announcement that `getAnnouncements` / `getAnnouncementById`
-- already fetch.
--
-- The trade-off is deliberate and worth stating: a JSONB array has no per-row
-- RLS, no index, and no cheap "delete one comment" — the whole array is
-- rewritten on every append, and the row grows without bound. That is
-- acceptable at this volume (a handful of comments on a 60-day-lived notice).
-- If comments ever need moderation, pagination, or per-comment reads, this
-- becomes a `announcement_comments` table; nothing else here assumes the
-- shape.
--
-- Customers have SELECT on announcements and nothing more — "Admins can manage
-- announcements" is the only write policy — so the append cannot happen from
-- the client. `add_announcement_comment` is SECURITY DEFINER and takes the
-- author from `auth.uid()`, never from an argument: the same rule as
-- `guard_chat_message_insert`, so a caller cannot post as somebody else.
-- ============================================================================

ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS comments JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.announcements.comments IS
  'Append-only array of {id, user_id, name, text, created_at}. Written only by add_announcement_comment().';

CREATE OR REPLACE FUNCTION public.add_announcement_comment(
  p_announcement_id UUID,
  p_text TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_name     TEXT;
  v_text     TEXT := btrim(COALESCE(p_text, ''));
  v_comment  JSONB;
  v_comments JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to comment.' USING ERRCODE = '42501';
  END IF;

  IF v_text = '' THEN
    RAISE EXCEPTION 'Comment cannot be empty.' USING ERRCODE = '22023';
  END IF;

  IF length(v_text) > 500 THEN
    RAISE EXCEPTION 'Comment must be 500 characters or less.' USING ERRCODE = '22023';
  END IF;

  -- The display name is read here, not passed in, for the same reason the id
  -- is: it is the author's identity and the client does not get to assert it.
  -- A profile with no name is left as the honest placeholder rather than
  -- backfilled with an email or an id.
  SELECT name INTO v_name FROM profiles WHERE id = v_user_id;

  v_comment := jsonb_build_object(
    'id',         gen_random_uuid(),
    'user_id',    v_user_id,
    'name',       COALESCE(NULLIF(btrim(v_name), ''), 'Customer'),
    'text',       v_text,
    'created_at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );

  -- Concurrent appends are safe: UPDATE locks the row and, under READ
  -- COMMITTED, the second writer re-reads the freshly committed array before
  -- concatenating. A read-then-write from the client could not make that
  -- promise — it would lose whichever comment landed first.
  UPDATE announcements
     SET comments = COALESCE(comments, '[]'::jsonb) || jsonb_build_array(v_comment)
   WHERE id = p_announcement_id
   RETURNING comments INTO v_comments;

  IF v_comments IS NULL THEN
    RAISE EXCEPTION 'Announcement not found.' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_comments;
END;
$$;

REVOKE ALL ON FUNCTION public.add_announcement_comment(UUID, TEXT) FROM public;
GRANT EXECUTE ON FUNCTION public.add_announcement_comment(UUID, TEXT) TO authenticated;
