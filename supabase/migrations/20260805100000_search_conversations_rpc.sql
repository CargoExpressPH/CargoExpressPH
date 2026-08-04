-- ============================================================
-- 20260805100000_search_conversations_rpc.sql
--
-- Deep message search for the admin inbox.
--
-- The sidebar search only ever matched customer name and email, so an admin
-- who remembered a shipment by what was said about it ("motor") had no way
-- to find the thread. This adds the missing half: search the message bodies
-- and return the conversations they belong to, with the matching line so the
-- admin can see WHY a row came back.
--
--
-- ── WHY ILIKE AND NOT to_tsvector ────────────────────────────────────────
--
-- Postgres full-text search stems and matches whole lexemes: 'motor' would
-- NOT find "motorcycle", and 'CE-2026' would be mangled by the parser.
-- The admins here search for fragments — part of a tracking number, part of
-- a word, a phone number — so substring matching is the behaviour they
-- actually expect. At 169 messages the cost is irrelevant, and the trigram
-- index below keeps it that way well past the point where it would matter.
--
--
-- ── SECURITY ─────────────────────────────────────────────────────────────
--
-- SECURITY DEFINER + an is_admin() gate. This reads EVERY customer's chat
-- history, so it must never be reachable by a customer: RLS on chat_messages
-- restricts customers to their own conversations, and a definer function
-- bypasses RLS by design. The gate is what replaces it.
--
-- The search term is escaped before it reaches ILIKE. Without that, a query
-- containing % or _ would silently behave as a wildcard — typing "50%" would
-- match every conversation rather than none, which reads as a broken search.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Substring search over message bodies. GIN + trigram is the index type that
-- can actually serve ILIKE '%term%'; a btree cannot.
CREATE INDEX IF NOT EXISTS chat_messages_message_trgm_idx
  ON public.chat_messages USING GIN (message gin_trgm_ops);


CREATE OR REPLACE FUNCTION public.search_conversation_messages(p_query TEXT)
RETURNS TABLE (
  conversation_id UUID,
  match_count     INTEGER,
  snippet         TEXT,
  matched_at      TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_term TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  v_term := btrim(COALESCE(p_query, ''));
  IF length(v_term) < 2 THEN
    RETURN;   -- one character matches everything; not a search
  END IF;

  -- Treat the input as literal text: escape the LIKE metacharacters, and the
  -- escape character itself first so it is not double-processed.
  v_term := replace(v_term, '\', '\\');
  v_term := replace(v_term, '%', '\%');
  v_term := replace(v_term, '_', '\_');

  RETURN QUERY
  WITH hits AS (
    SELECT m.conversation_id AS conv_id,
           m.message,
           m.created_at,
           ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY m.created_at DESC) AS rn,
           COUNT(*)     OVER (PARTITION BY m.conversation_id) AS total
      FROM public.chat_messages m
     WHERE m.message ILIKE '%' || v_term || '%' ESCAPE '\'
  )
  SELECT h.conv_id,
         h.total::INTEGER,
         -- The most recent matching line, trimmed for a one-line preview.
         CASE WHEN length(h.message) > 140
              THEN left(h.message, 140) || '…'
              ELSE h.message
         END,
         h.created_at
    FROM hits h
   WHERE h.rn = 1
   ORDER BY h.created_at DESC
   LIMIT 50;
END;
$$;

REVOKE ALL ON FUNCTION public.search_conversation_messages(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_conversation_messages(TEXT) TO authenticated;


-- ============================================================
-- VERIFY (as an ADMIN session):
--   SELECT * FROM search_conversation_messages('motor');
--
--   -- literal, not wildcard: should return 0 rows, not everything
--   SELECT count(*) FROM search_conversation_messages('%');
--
--   -- as a CUSTOMER session: must raise
--   SELECT * FROM search_conversation_messages('motor');
--   -- ERROR: Admin access required
-- ============================================================
