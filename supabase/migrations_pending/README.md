# Pending (NOT APPROVED) migrations

Files here are **not** picked up by `supabase db push`. Move a file into
`supabase/migrations/` only when its preconditions in
`DATABASE_SIMPLIFICATION_AND_RESET_REVIEW.md` are met and the owner has
approved it.

- `20260926110000_simplify_stage2_drop_columns.sql` — destructive column drops
  (stage 2). Requires stage 1 applied, new frontend + Edge Functions deployed,
  the old-client compatibility period elapsed, and a verified backup.
