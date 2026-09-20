# Storage Monitoring — Post-Change Audit

Scope: re-verify the Storage Monitoring simplification (commit `600904f`, migration
`20260915090000_simplify_storage_monitoring_gallery.sql`) against **current source code** and the
**live, linked Supabase project** (`duigaivxgxlnjmfienhg`). This is a read-only audit. No DROP,
DELETE, TRUNCATE, or destructive ALTER was run; nothing was deployed or undeployed; no photos or
customer data were touched. All database evidence below came from `supabase db query --linked`
(read-only SQL) and `supabase migration list` / `supabase functions list` (read-only CLI status
checks).

**Important correction to the record:** the prior `../operations/STORAGE_MONITORING_SIMPLIFICATION_IMPLEMENTATION.md`
stated the new migration and edge function were written but *not* deployed, pending approval. Live
evidence in this audit shows they **have since been deployed** — `supabase migration list` shows
`20260915090000` applied on the remote database, and `delete-storage-photos` is `ACTIVE` in
`supabase functions list` (version 1, deployed today). That deployment did not happen inside this
audit; it had already happened by the time this audit started. Section 3 covers exactly what is and
isn't live as a result.

---

## 1. Simple summary (for a non-technical owner)

The simplification shipped, and it is now live. The admin can see storage usage in plain language,
browse and search photos in one gallery, and delete selected photos with a clear confirmation. The
old manual "which storage to use" switch is gone from the screen, but the safety switch itself still
exists quietly in the database as an emergency-only tool an engineer can use during an incident — it
cannot be reached from the UI, and it currently sits on "automatic," so nothing behaves differently
today than what the admin sees.

One loose end was found: the old "Scan and Clean Orphaned Photos" function (`cleanup-orphaned-photos`)
was deleted from the codebase but was **never removed from the live server** — it's still sitting
there, unused by anything, reachable only if someone has its private URL and valid admin
credentials. It should be deleted from the server to finish the cleanup properly (see §5 and §10).
A second, smaller gap was found in the permissions on the two new database functions (§7) — not a
real security hole (the functions still correctly reject non-admins), but it doesn't match this
project's own established pattern for locking these functions down, and should be tidied up.

Nothing else found is worth removing. Every remaining table, column, and function still has a real
job — several of them (like the payment-time photo snapshot on `payment_attempts`) are easy to
mistake for leftovers but are actually protecting financial records.

---

## 2. Before-and-after changes

| Area | Before | After | Fully implemented? | Deployed? |
|---|---|---|---|---|
| Storage usage display | Manual/technical panel with provider selection, live-vs-estimated ambiguity | Plain usage card; `formatPercent()` shows `<1%` instead of misleading `0%`, decimals under 10% | Yes (code) | **Yes** — DB summary RPCs (`get_photo_storage_summary`, `get_photo_storage_live_usage`) unchanged and live; frontend card code is on `main` |
| Photo gallery, search, filters, pagination | None (no unified gallery existed) | New `list_evidence_photos()` RPC: filter (`all`/`can be deleted`/`still needed`), search by tracking number, paginated | Yes (code + DB) | **Yes** — `list_evidence_photos` confirmed present and grant-correct on live DB (§4) |
| Single/bulk deletion | "Scan and Clean Orphaned Photos" (orphans only, via `cleanup-orphaned-photos` + `list_orphaned_evidence_photos()`) | Unified `delete_evidence_photos()` covering orphans *and* expired evidence photos, called from new `delete-storage-photos` edge function, admin selects 1–N photos | Yes (code + DB) | **Yes** — migration applied, `delete-storage-photos` is `ACTIVE` v1 live (§3) |
| Manual storage selection | UI toggle + `getPhotoStorageMode`/`setPhotoStorageMode` client wrappers | UI control removed; `set_photo_storage_mode`/`get_effective_photo_storage_mode` kept DB-side only, as a documented operator safety valve (`src/lib/database.js:3379-3384`) | Yes | **Yes** — live `photo_storage_settings` row is `upload_mode = 'automatic'`, `force_firebase_expires_at = NULL` (confirmed §3) |
| Automatic main→fallback upload | Try Supabase Storage first, fall back to Firestore on failure, RLS-enforced mode | **Unchanged** — `src/lib/storage.js` and `src/lib/photoReference.js` were not touched by this commit (`git diff 600904f^ 600904f` on those files is empty) | Yes (was already correct) | Yes — this logic was already live before the simplification and remains untouched |
| Technical panels / activity tables | Provider health panel, raw upload-activity table, diagnostic explanations | Removed from `PhotoStorageTab.jsx` (953 lines changed, net −438) | Yes | Yes — frontend-only, ships with the next `npm run build` deploy of the SPA |
| Cleanup schedule / log retention | `purge_old_photo_storage_events` / `purge_old_photo_cleanup_queue` existed but were **not scheduled** (confirmed in the prior review) | New weekly cron job `purge_photo_storage_operational_logs` (`0 3 * * 0`) calls both | Yes | **Yes — confirmed live**: `cron.job` row `jobid=20`, `active=true` (§4) |

---

## 3. Local vs. deployed — what's actually true right now

Checked live via `supabase migration list --linked` and `supabase functions list`:

- **Migration `20260915090000_simplify_storage_monitoring_gallery.sql` is applied on the remote
  database.** Confirmed: it appears in the `remote` column of `supabase migration list`, and its
  concrete effects are independently observable — the new functions exist (§4), the new cron job is
  scheduled and `active` (§4), and `photo_storage_settings.upload_mode` reads `'automatic'` with no
  forced-Firebase value.
- **`delete-storage-photos` edge function is deployed and `ACTIVE`** (id `6c34ec5b…`, version 1,
  `created_at` ≈ 2026-09-15 03:37 UTC — about 28 minutes before this audit began). Its code was not
  re-inspected for drift beyond what was already reviewed in the implementation pass; there is no way
  from read-only DB access to diff the deployed bundle against the local file, so this audit trusts
  that the deploy matches `supabase/functions/delete-storage-photos/index.ts` on disk. If that
  assumption matters, `supabase functions download delete-storage-photos --linked` (also read-only,
  not run here) would confirm it byte-for-byte.
- **`cleanup-orphaned-photos` is still deployed and `ACTIVE` on the live project** (id `eec180cf…`,
  version 6) even though its source file was deleted from the repo in the same commit that added
  `delete-storage-photos`. A scoped `supabase functions deploy delete-storage-photos` pushes only the
  named function — it does not remove functions that no longer exist locally. This is a genuine,
  concrete leftover from an incomplete deploy step; see §7 and §10 for the fix.
- **No live database was mutated by anyone as part of this audit.** All checks used
  `supabase db query --linked` with `SELECT`/`information_schema` reads only.

What remains genuinely **unverified** (browser/runtime, not schema):
- Actual rendering of the new `PhotoStorageTab.jsx` in a browser (desktop or mobile) was not
  performed — no browser/staging access in this session.
- An end-to-end delete through the deployed `delete-storage-photos` function against a real photo
  was not performed — the task explicitly disallows deleting real customer images without separate
  approval, and the live bucket holds real, small-scale production-looking data (22 objects, ~3 MB —
  see §9), not disposable test fixtures.

---

## 4. Table-by-column dependency inventory (live evidence)

### `photo_storage_settings` — **KEEP, unchanged**
Live row: `{ id: true, upload_mode: 'automatic', force_firebase_expires_at: null, reason: 'Force
Firebase mode expired automatically.', updated_by: <uuid>, updated_at: '2026-09-03 22:26:24' }`.

| Column | Used by | Verdict |
|---|---|---|
| `upload_mode`, `force_firebase_expires_at` | Read directly by the storage RLS gate `is_supabase_evidence_upload_allowed(path)` (`supabase/schema.sql:1888-1903`) — **this is the actual enforcement point**, not just app logic. Also read by `get_effective_photo_storage_mode()`, called from `src/lib/storage.js:112` as an advisory client-side hint. Written by `set_photo_storage_mode()`. | KEEP — this is real, load-bearing authorization state, confirmed live to be `automatic` with no stale forced value. |
| `reason`, `updated_by`, `updated_at` | Audit trail for whoever last forced a mode change via `set_photo_storage_mode()`. | KEEP — small, cheap, and the only record of *why* a forced-Firebase incident happened if one ever does again. |

**On the removed UI control specifically:** removing the toggle from `PhotoStorageTab.jsx` did **not**
make this table or `set_photo_storage_mode()`/`get_effective_photo_storage_mode()` unused. They're
explicitly documented in `src/lib/database.js:3379-3384` as a deliberate "operator can still call
them directly by SQL during an incident" design decision, and the RLS policy genuinely depends on
the table's contents regardless of whether a UI exists. Do not remove these.

### `photo_storage_events` — **KEEP**
Live: 1 row total (`upload` / `supabase` / `success`, 2026-09-13). Columns: `event_type`, `provider`,
`outcome`, `photo_type`, `order_id`, `storage_path`, `size_bytes`, `message`, `metadata`,
`created_by`, `created_at` — all populated by real callers: `record-photo-storage-event` (invoked
from `src/lib/storage.js`'s `recordEvidenceUploadEvent`), `delete-storage-photos`,
`archive-expired-evidence-photos`, `photo-storage-health`. Now has a **confirmed live, active**
weekly purge (`purge_photo_storage_operational_logs`, `jobid=20`, `0 3 * * 0`) retaining 30 days.
Every column maps to a real reader or writer — no unused column found.

### `photo_cleanup_queue` — **KEEP**
Live: 0 rows (empty — nothing pending or stuck). Columns confirmed live: `id`, `provider`,
`storage_path` (unique pair — drives idempotent re-queuing), `queued_at`, `completed_at`,
`attempts`, `last_error`. Written by `delete_evidence_photos()` (queues), read/updated by
`record_photo_cleanup_queue_result()` (called from both `delete-storage-photos` and
`archive-expired-evidence-photos`), and now has a **confirmed live, active** 7-day purge for
completed rows via the same weekly job. No dead column.

### `orders.pickup_photos` / `orders.delivery_photos` (jsonb) — **KEEP**
Core evidence arrays. Read/written by `list_evidence_photos()`, `delete_evidence_photos()`,
`PickupModal.jsx`, both admin and customer `OrderDetailPage.jsx`. Unaffected by this change beyond
gaining a new, safer deletion path.

### `payment_transactions.receipt_url` (text) — **KEEP**
Parsed via `text_to_photo_ref()` inside `list_evidence_photos()`/`delete_evidence_photos()`.
Receipts are unconditionally `protected` in the eligibility logic (`'Receipt photo — kept as a
financial record'`) — this was a hard requirement from the task and is implemented correctly
(confirmed in the pgtest suite: *"a receipt is always rejected, even on an otherwise-eligible
order"*, passing).

### `payment_attempts.pickup_photos` (jsonb) — **KEEP — do not touch**
This is the item the task specifically warned about ("payment/reconciliation snapshots"), and it's
real:
- `createPaymentAttempt()` (`src/lib/database.js:1906-1929`) writes it when a GCash "weigh and
  charge" checkout is created.
- `reconcile_paymongo_payment_attempt()` (`supabase/schema.sql:2405-2492`) copies it onto
  `orders.pickup_photos` at reconciliation via `COALESCE(attempt_row.pickup_photos,
  order_row.pickup_photos)` — but **does not clear the source row**. It stays as a permanent,
  point-in-time financial snapshot with `reconciled_at` set.
- It is **never read for display anywhere** (grepped every `.from('payment_attempts')` call site —
  only `id/source_id/status/amount` or `status/payment_status` are ever selected back out).
- The new gallery/deletion logic (`list_evidence_photos`/`delete_evidence_photos`) does **not**
  reference `payment_attempts` at all — confirmed by grep of the migration file.

**A real, pre-existing gap, not a regression:** because orphan-detection matches by *tracking number
existing on any order* (not by "is this path actually inside that order's current photo array" —
see `orphaned_rows` CTE, `supabase/migrations/20260915090000...sql:284-310`), a photo referenced
*only* by a superseded/failed `payment_attempts` row (e.g., a second checkout attempt replaced the
first one's photos before reconciling) is invisible to both the old orphan scanner and the new
gallery — it's neither "referenced" (not in `orders.pickup_photos`) nor "orphaned" (the order still
exists). This exact matching logic already existed in the old `list_orphaned_evidence_photos()`
(`supabase/schema.sql:1907-1933`) before this change, so the simplification did not introduce or
worsen it. It's a storage-accounting completeness gap (a small number of superseded photos may sit
in Storage uncounted and unreachable through the admin UI), never a wrongful-deletion risk — nothing
can be deleted through this admin flow unless it's actually inside an order's current photo array or
genuinely has no matching order at all.

### Other tables/objects touched
- `storage.objects` (Supabase-managed) — read-only queries by `list_evidence_photos()`'s orphan
  branch and `list_orphaned_evidence_photos()`. Not modified by the migration.
- No views were added or removed by this change.

---

## 5. Confirmed removal candidates

Only one is safe to act on now, and it requires an ordering step first — **do not drop the SQL
function before the stale edge function is gone**, or the (currently unreachable-by-app, but still
live) endpoint would start erroring on every call instead of quietly doing nothing.

| Item | Type | Live dependents found | Action |
|---|---|---|---|
| `supabase/functions/cleanup-orphaned-photos` (deployed function, version 6) | Edge Function | **None from current app code** — no frontend caller, not in `config.toml`, no cron job invokes it (confirmed against the full live `cron.job` table, §"cron jobs" below). Its own body calls `list_orphaned_evidence_photos()`. | **REMOVE CANDIDATE** — undeploy from the live project. This is a deploy/config action, not run here per the task's constraints. |
| `public.list_orphaned_evidence_photos()` | DB function | Its **only** live caller is the stale `cleanup-orphaned-photos` function above. Nothing in current `src/` or any other deployed edge function calls it (grepped). | **REMOVE CANDIDATE, but only after** the edge function above is undeployed — otherwise that endpoint (still reachable, still admin-gated internally) breaks instead of being harmlessly unreachable. |

Everything else checked has a real, currently-exercised dependent (§4, §6) and is **not** a removal
candidate. In particular: `set_photo_storage_mode()`, `get_effective_photo_storage_mode()`,
`photo_storage_settings`, and `payment_attempts.pickup_photos` all *look* like leftovers of a removed
UI control but are not — see §4 and §6 for the specific evidence on each.

---

## 6. Objects that must remain, and why

- **`photo_storage_settings` + `set_photo_storage_mode()`/`get_effective_photo_storage_mode()`** —
  the actual Storage RLS enforcement point (`is_supabase_evidence_upload_allowed`) reads this table
  directly; removing it would remove a real authorization control, not just a UI convenience. Kept
  intentionally as an operator-only safety valve per an explicit code comment.
- **`payment_attempts` + `payment_attempts.pickup_photos`** — active financial reconciliation table;
  the photo column is a point-in-time snapshot consumed by `reconcile_paymongo_payment_attempt()`.
  Removing it would break GCash "weigh and charge" reconciliation, not just tidy up a gallery.
- **`photo_storage_events`, `photo_cleanup_queue`** — both now have real, live, scheduled retention
  (confirmed §4); they are working exactly as historical/audit logs should, not dead accumulation.
- **`is_featured_photo_path()`** — used both by `list_evidence_photos()`'s eligibility logic *and*
  directly by a Storage RLS policy (`supabase/schema.sql:4131`) — two independent live dependents.
- **`trigger_scheduled_old_photo_cleanup()`, `trigger_photo_storage_health_check()`** — both are
  `active=true` in the live `cron.job` table (jobs 9 and 10), running the pre-existing archive and
  health-check jobs, unrelated to and unaffected by this simplification.

---

## 7. Bugs or incomplete changes found

1. **Stale deployed edge function (`cleanup-orphaned-photos`), version 6, still `ACTIVE` on the live
   project.** Deleting the source file from the repo did not undeploy it — `supabase functions
   deploy <name>` only pushes the named function; it does not prune ones absent from
   `supabase/config.toml`/local source. Concretely reachable today: `POST
   https://duigaivxgxlnjmfienhg.supabase.co/functions/v1/cleanup-orphaned-photos` — internally still
   admin-gated (calls `list_orphaned_evidence_photos()`, which re-checks `is_admin()`), so this is
   not an authorization bypass, but it is unnecessary live attack surface and it is what's currently
   keeping `list_orphaned_evidence_photos()` from being a clean removal. **Severity: low-risk,
   moderate priority** (config-hygiene, not exploitable as-is).

2. **`list_evidence_photos()` and `delete_evidence_photos()` grant `EXECUTE` to `anon`, deviating
   from this codebase's own established convention.** Confirmed live via `pg_proc.proacl`:
   ```
   delete_evidence_photos: {postgres=X/postgres, anon=X/postgres, authenticated=X/postgres, service_role=X/postgres}
   list_evidence_photos:   {postgres=X/postgres, anon=X/postgres, authenticated=X/postgres, service_role=X/postgres}
   ```
   The migration only does `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO authenticated;`
   (`20260915090000...sql:342-343, 533-534`). Supabase's platform applies default `EXECUTE` grants to
   `anon`/`authenticated`/`service_role` on every new function in `public`; revoking from `PUBLIC`
   alone does not remove `anon`'s separate, already-granted privilege. This codebase's own prior
   pattern for the equivalent function it replaces does this correctly:
   ```sql
   -- supabase/schema.sql:3393-3397 (list_orphaned_evidence_photos, the function being superseded)
   REVOKE ALL ON FUNCTION public.list_orphaned_evidence_photos() FROM PUBLIC;
   REVOKE ALL ON FUNCTION public.list_orphaned_evidence_photos() FROM anon;
   REVOKE ALL ON FUNCTION public.list_orphaned_evidence_photos() FROM authenticated;
   GRANT EXECUTE ON FUNCTION public.list_orphaned_evidence_photos() TO service_role;
   GRANT EXECUTE ON FUNCTION public.list_orphaned_evidence_photos() TO authenticated;
   ```
   **Practical impact today: none observed** — both functions correctly `RAISE EXCEPTION 'Admin
   access required'` for a non-admin caller because `is_admin()` resolves to `FALSE` when
   `auth.uid()` is null (confirmed by reading `is_admin()`'s body, `supabase/schema.sql`). An
   unauthenticated caller can reach the function but gets nothing back except that exception. This is
   a **defense-in-depth gap, not a live vulnerability** — worth fixing to match the codebase's own
   standard, and cheap to fix (see §8).

3. No other logic bugs found. The 43-assertion local pgtest suite (`npm run test:photo-gallery`) and
   the full `npm test` chain both still pass against the exact migration file that is now live
   (re-run in this audit, all green — see §9).

---

## 8. Proposed SQL and deployment sequence

Two independent, small follow-ups. Neither is executed by this audit — both require your explicit
go-ahead before running against the live project, per the task's constraints.

### 8a. Tighten grants on the two new functions (fixes §7 item 2)

New migration, e.g. `supabase/migrations/20260916000000_restrict_photo_gallery_grants.sql`:

```sql
-- Match the anon-revocation pattern already used for the function these
-- replace (list_orphaned_evidence_photos, schema.sql:3393-3397). Both
-- functions already reject non-admins internally via is_admin() — this
-- closes the unnecessary anon EXECUTE grant Supabase's platform defaults
-- applied at CREATE FUNCTION time, which the original migration's
-- REVOKE ALL ... FROM PUBLIC did not remove.
REVOKE ALL ON FUNCTION public.list_evidence_photos(text, text, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.list_evidence_photos(text, text, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.list_evidence_photos(text, text, integer, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.delete_evidence_photos(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.delete_evidence_photos(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.delete_evidence_photos(jsonb) TO authenticated;
```
- No caller changes required — `authenticated` keeps exactly the access it already has.
- No data migration, no downtime, no compatibility concern with the deployed
  `delete-storage-photos` function (it calls these via the caller's JWT, which is always
  `authenticated`, never `anon`).
- Deploy with `supabase db push` whenever you're ready; safe to apply independently of 8b.

### 8b. Remove the stale `cleanup-orphaned-photos` function and its now-orphaned DB function

Order matters — **undeploy the edge function first**, confirm it's gone, then drop the SQL function
in a second migration:

1. Undeploy the function (your call/approval — a deploy/config action):
   ```bash
   supabase functions delete cleanup-orphaned-photos --linked
   ```
   or remove it from the dashboard. Confirm with `supabase functions list` that it no longer appears
   (or shows `REMOVED`/absent, per whatever your CLI/dashboard reports).

2. Only after that's confirmed, add a new migration to drop the now-fully-unused SQL function:
   ```sql
   -- supabase/migrations/20260916010000_drop_legacy_orphan_photo_scan.sql
   -- list_orphaned_evidence_photos() is superseded by list_evidence_photos()'s
   -- orphan branch (20260915090000_simplify_storage_monitoring_gallery.sql).
   -- Its only caller, the cleanup-orphaned-photos edge function, was removed
   -- from the codebase in 600904f and undeployed from the live project on
   -- <date you actually run step 1>. Do not run this migration before that
   -- undeploy is confirmed, or the (still admin-gated, but reachable) stale
   -- endpoint would start erroring instead of quietly not being called.
   DROP FUNCTION IF EXISTS public.list_orphaned_evidence_photos();
   ```

- No caller changes needed elsewhere — nothing else in the current codebase references either
  object.
- This does not touch `photo_cleanup_queue`, `photo_storage_events`, or any photo data; it only
  removes a superseded scanning function.
- No data recovery concern: `list_orphaned_evidence_photos()` is a pure read function with no
  underlying data of its own.

---

## 9. Verification performed and remaining gaps

**Performed in this audit (read-only, live database + current source):**
- `supabase migration list` — confirmed `20260915090000` applied remotely.
- `supabase functions list` — confirmed `delete-storage-photos` `ACTIVE` v1; confirmed
  `cleanup-orphaned-photos` still `ACTIVE` v6 despite source deletion.
- Live `SELECT` against `photo_storage_settings` — confirmed `upload_mode='automatic'`, no stale
  forced-Firebase value.
- Live `SELECT` against `cron.job` (full table, not just photo-filtered) — confirmed the new weekly
  purge job is `active=true`, and confirmed no cron job anywhere calls `cleanup-orphaned-photos`.
- Live `SELECT` against `photo_storage_events` (1 row) and `photo_cleanup_queue` (0 rows) — both
  healthy, empty/light as expected for a low-volume project.
- Live `information_schema.columns` queries across every table with a photo/receipt-related column,
  including the `payment_attempts.pickup_photos` column the task specifically asked about.
- Live `pg_proc`/`pg_get_function_identity_arguments` listing of every `public` function with
  "photo" in its name, cross-referenced against `grep` of current `src/` and
  `supabase/functions/*` for callers.
- Live `pg_proc.proacl` inspection — found the `anon` grant gap in §7.
- Re-ran `npm run test:photo-gallery` (43/43 pass) and the full `npm test` chain (all green) against
  the current, now-live migration file.
- Read `src/lib/storage.js` end-to-end and confirmed via `git diff 600904f^ 600904f` that the
  upload/fallback logic was not touched by this change (validation errors never trigger fallback;
  both-fail surfaces the original Supabase error; force-Firebase and RLS enforcement both intact).
- Live bucket check: `cargo-photos` currently holds 22 objects / ~3 MB — real but small-scale data,
  not synthetic test fixtures, which is why no live deletion was attempted.

**Not verified (explicit gaps):**
- No browser/UI verification of `PhotoStorageTab.jsx` — no staging/browser access in this session.
  Desktop and mobile rendering, the confirmation modal copy, and the lightbox are unverified beyond
  code review.
- No end-to-end deletion test against the live `delete-storage-photos` function — disallowed by the
  task without separate, explicit approval to touch real photos, and the live bucket contains
  real-looking data rather than disposable fixtures.
- No byte-for-byte diff of the deployed `delete-storage-photos` bundle against the local file (no
  tooling run to download and compare it — see §3).
- Firestore fallback (`photoFallbacks` collection) was not queried directly — no Firebase
  credentials were used or should be used from this audit context; its behavior was inferred from
  code review only, consistent with the prior implementation pass.
- E2E/Playwright suite was not run in this audit (out of scope for a read-only re-verification pass;
  it also creates live data against a Supabase project per its own docs, which this task's
  constraints argue against running here without separate approval).

---

## 10. Prioritized next steps

1. **Undeploy `cleanup-orphaned-photos`** (§7 item 1, §8b step 1) — cheapest, highest-value cleanup;
   removes a live, reachable, fully-superseded endpoint. Requires your approval to run
   `supabase functions delete cleanup-orphaned-photos --linked` (or dashboard equivalent).
2. **Apply the grant-tightening migration** (§8a) — small, safe, matches existing convention, no
   caller impact. Requires your approval to `supabase db push`.
3. **Drop `list_orphaned_evidence_photos()`** (§8b step 2) — only after step 1 is confirmed done.
4. Optional, not urgent: verify the deployed `delete-storage-photos` bundle matches the local file
   (`supabase functions download`) if you want certainty beyond "no reason to believe it drifted."
5. Optional, not urgent: a staging-environment browser pass on `PhotoStorageTab.jsx` (desktop +
   mobile) whenever one is available — this remains the only meaningfully untested layer.

---

## Direct answers

**Did the simplification actually work?** Yes. The new gallery, search/filter/pagination, unified
selection-based deletion, and the honest usage-percentage display are all implemented in code *and*
now live on the database (confirmed independently of the prior report's claims). The 43-assertion
local regression suite and the full existing test chain both pass against the exact SQL now running
in production.

**Is automatic fallback working without manual selection?** Yes. `upload_mode` is confirmed live as
`'automatic'` with no stale forced-Firebase value, and the enforcement point
(`is_supabase_evidence_upload_allowed`, a Storage RLS policy) reads that same live setting — it isn't
just an app-level default. The upload/fallback code path itself (`src/lib/storage.js`) was not
touched by this change and was already correct (try-main-first, validation errors never fall back,
both-fail surfaces the real error).

**Can any tables or columns now be removed?** No table or column can be removed. Two *functions*
can, in sequence: the deployed-but-unused `cleanup-orphaned-photos` edge function, then the SQL
function `list_orphaned_evidence_photos()` that only it calls. Nothing else qualifies —
`photo_storage_settings`, `payment_attempts.pickup_photos`, and the two "manual mode" functions all
looked like plausible leftovers of the removed UI control but each has a real, currently-active
dependent traced with live evidence in §4/§6.

**Which exact items, and what must happen first?** `cleanup-orphaned-photos` (edge function) must be
undeployed from the live project before `list_orphaned_evidence_photos()` (SQL function) is dropped
— dropping the SQL function first would break the still-reachable stale endpoint instead of leaving
it harmlessly unused. Both steps are drafted as ready-to-run SQL/CLI commands in §8, awaiting your
approval to execute.

**Would removing them meaningfully simplify maintenance, or only reduce the visible column count?**
It removes a real, live, unnecessary attack-surface edge function and one redundant scanning
function — genuine simplification, not cosmetic. It changes zero visible admin-facing behavior
(nothing currently calls either object) and zero column counts. The separately-identified grant gap
(§7 item 2, §8a) is the other genuinely worthwhile fix from this audit — also not a column-count
change, but a real tightening of who can even attempt to call two admin-only functions.
