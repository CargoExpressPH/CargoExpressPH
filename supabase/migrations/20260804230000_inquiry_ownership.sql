-- ============================================================
-- 20260804230000_inquiry_ownership.sql
--
-- Customer Service restructure, Phase 1d — give contact inquiries an owner
-- and a response stamp.
--
-- SCOPE, by decision: the shared queue proposed as Phase 3 of the study is
-- CANCELLED. At 8 inquiries a quarter a unified queue is over-engineering,
-- and the Inbox stays exclusively for live chat. Inquiries keep their own
-- page; they just stop being anonymous work.
--
-- ── WHY ──────────────────────────────────────────────────────────────────
--
-- contact_inquiries carries `status` (new / read / resolved) and nothing
-- else. Two consequences:
--
--   * No owner. Nobody is answerable for an inquiry, and with more than one
--     admin nothing stops two people replying to the same person.
--   * `read` means "an admin opened it and did nothing yet" — the same
--     opened-but-not-acted-on ambiguity that `closed` had on conversations,
--     in the second channel. Live data shows 7 resolved inquiries averaging
--     29.7 days old, but there is no way to tell how much of that was
--     waiting on us because no response time was ever recorded.
--
-- ── DELIBERATELY NOT TOUCHED ─────────────────────────────────────────────
--
-- The anonymous INSERT policy. "Anyone can submit inquiry" WITH CHECK (true)
-- is what makes the public contact form work; it was reviewed in the
-- security audit and is correct for its purpose. This migration is additive
-- only — new nullable columns, no policy changes.
-- ============================================================

ALTER TABLE public.contact_inquiries
  ADD COLUMN IF NOT EXISTS assigned_admin_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_at       TIMESTAMPTZ;

COMMENT ON COLUMN public.contact_inquiries.assigned_admin_id IS
  'Who owns this inquiry. NULL = unclaimed.';
COMMENT ON COLUMN public.contact_inquiries.first_response_at IS
  'When an admin first actioned it. Stamped by trigger on the move out of ''new''.';


-- ============================================================
-- Stamp the timestamps from the status transition, server-side.
--
-- Same principle as the conversations triggers: a derived value is computed
-- by the database, not written by whichever client happens to make the call.
-- 'read' is treated as the first response because that is the only signal
-- this table has — an admin opened it. It is a weak signal, but a recorded
-- weak signal beats an unrecorded one, and it becomes accurate the moment
-- the page stamps a real reply.
-- ============================================================

CREATE OR REPLACE FUNCTION public.stamp_inquiry_service_state()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status <> 'new' THEN
      NEW.first_response_at := COALESCE(NEW.first_response_at, now());
    END IF;

    IF NEW.status = 'resolved' THEN
      NEW.resolved_at := COALESCE(NEW.resolved_at, now());
    ELSE
      NEW.resolved_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contact_inquiries_stamp_service_state ON public.contact_inquiries;
CREATE TRIGGER contact_inquiries_stamp_service_state
  BEFORE UPDATE OF status ON public.contact_inquiries
  FOR EACH ROW EXECUTE FUNCTION public.stamp_inquiry_service_state();


-- ============================================================
-- Backfill what history allows.
--
-- There is no response record to reconstruct from — unlike conversations,
-- which had chat_messages to scan. The table has no updated_at either, so
-- the only timestamp in existence is created_at.
--
-- Historical rows are therefore left with resolved_at NULL and
-- first_response_at NULL. Backfilling created_at into resolved_at would
-- assert every inquiry was answered the instant it arrived — a fabricated
-- zero response time that would silently flatter the first service report.
-- An absent number is honest; a wrong one is not. These 8 rows simply
-- predate the instrumentation.
-- ============================================================

-- (no backfill — see above)


-- ============================================================
-- VERIFY:
--   SELECT status, COUNT(*), COUNT(assigned_admin_id) AS owned,
--          COUNT(first_response_at) AS stamped
--     FROM contact_inquiries GROUP BY status;
--
-- ROLLBACK:
--   DROP TRIGGER contact_inquiries_stamp_service_state ON contact_inquiries;
--   ALTER TABLE contact_inquiries
--     DROP COLUMN assigned_admin_id, DROP COLUMN first_response_at,
--     DROP COLUMN resolved_at;
-- ============================================================
