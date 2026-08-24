-- =============================================================================
-- 20260824110000_purge_test_announcements.sql
--
-- Removes the test/dummy announcements accumulated during development, and the
-- notification fan-out they produced, ahead of the final presentation.
--
-- WHAT IS ACTUALLY BEING CLEANED
--
-- The announcement rows themselves were already invisible: getAnnouncements()
-- filters on is_active, and every row targeted here is already soft-deleted by
-- deleteAnnouncement(). Deleting them changes nothing on screen.
--
-- The notifications are the visible problem. createAnnouncement() fans a
-- notification out to EVERY customer, and that fan-out is not undone when the
-- announcement is soft-deleted — so 37 automated E2E announcements and three
-- hand-typed placeholders ("Sjejdjd", "Hdehdh", "Nffnfn") left ~243 rows in the
-- customer Notifications page reading "New Announcement / Sjejdjd". Those are
-- what a demo account shows today.
--
-- SELECTION, and why it is narrow
--
-- Two predicates, both deliberately specific:
--   1. title LIKE 'E2E Announcement %' AND the exact self-describing content
--      the fixture writes. Title alone would be looser than it needs to be.
--   2. Three placeholder rows named by explicit id, because "Sjejdjd" has no
--      pattern to match on and guessing at one risks a real announcement.
--
-- The `is_active = false` guard is a belt on top of both: a live announcement
-- cannot be removed by this migration even if a predicate were wrong. Verified
-- before writing — 42 rows total, 40 selected, 0 of them active. The two kept
-- are the real Bohol→Manila cargo run notice and its earlier revision.
--
-- IRREVERSIBLE. These are hard DELETEs; there is no down-migration. The rows
-- carry no information anyone needs — the announcements are test fixtures and
-- the notifications are their echoes.
-- =============================================================================

BEGIN;

CREATE TEMP TABLE doomed_announcements ON COMMIT DROP AS
SELECT id
FROM public.announcements
WHERE is_active = false
  AND (
    (title LIKE 'E2E Announcement %'
      AND content = 'Automated end-to-end test announcement. Safe to delete.')
    OR id IN (
      'c4c3b9a3-b7db-4b14-af61-549bf970a222',  -- "Sjejdjd"
      'ee008757-434c-4362-bbc2-00909219fbe1',  -- "Hdehdh"
      'e8d76afb-e14d-4b7b-ae43-2263ba8116ef'   -- "Nffnfn"
    )
  );

-- Notifications first. reference_id carries no foreign key to announcements,
-- so nothing would clean these up on its own — and dropping the announcements
-- first would leave the notifications un-selectable by this predicate.
DELETE FROM public.notifications n
USING doomed_announcements d
WHERE n.reference_id = d.id
  AND n.type = 'announcement';

DELETE FROM public.announcements a
USING doomed_announcements d
WHERE a.id = d.id;

COMMIT;
