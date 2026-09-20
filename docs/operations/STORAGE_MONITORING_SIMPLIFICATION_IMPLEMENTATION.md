# Storage Monitoring Simplification — Implementation Report

**Status:** Implemented and locally verified. **Not yet deployed.** The new migration has not been applied to the live Supabase project and the new Edge Function has not been deployed — see §7 for the exact commands still awaiting your approval.
**Companion document:** `../audits/STORAGE_MONITORING_SIMPLIFICATION_REVIEW.md` (the prior audit this implements). Findings there were re-verified against current code and the live database before implementing, not assumed — corrections found along the way are called out in §1 and §8.

---

## 1. Plain-language summary of the new admin experience

The Storage Monitoring page now does three things, and only three things, for the admin:

1. **See how much space is used** — one card: a percentage, a bar, used/allowance/remaining in plain units, and a one-word status (Good / Getting Full / Action Needed). A small honest footnote makes clear this is measured live and the allowance is a published plan figure, not a metered reading — nothing new is claimed here that wasn't already true, it's just said in fewer words.
2. **View the stored photos** — a searchable, filterable photo gallery. Every pickup, delivery, and receipt photo (plus any leftover files with no matching booking) shows as a thumbnail with its booking number, type, date, and size. Filters: **All Photos / Can Be Deleted / Still Needed**. Search by tracking number.
3. **Select and safely delete eligible photos** — checkboxes appear only on photos the system has determined are actually eligible (see §4 for the exact rule). A "Delete Selected" button shows the count and estimated space freed, a confirmation explains the deletion is permanent and that booking/payment records are untouched, and the result — success, partial, or failure — is shown plainly afterward.

Everything that was purely technical is gone from the ordinary view: the manual "Force Firebase" storage-routing toggle, the raw upload-activity log table, the live realtime activity subscription, and the provider health/diagnostic panel (bucket names, exact plan JSON, Supabase-vs-Firebase framing). None of the underlying mechanisms were removed — see §3 and §6 — only their admin-facing controls.

---

## 2. Files changed

| File | Change |
|---|---|
| `supabase/migrations/20260915090000_simplify_storage_monitoring_gallery.sql` | **New.** Adds `classify_evidence_photo_ref()`, `text_to_photo_ref()`, `list_evidence_photos()`, `delete_evidence_photos()`; schedules the two dormant retention/purge functions; resets `photo_storage_settings` to Automatic if it isn't already. Additive only — see §6. |
| `supabase/functions/delete-storage-photos/index.ts` | **New.** Backs "Delete Selected." Re-verifies eligibility server-side, then physically deletes via Supabase Storage / Firestore, then records the result in the existing retry queue. |
| `supabase/functions/cleanup-orphaned-photos/index.ts` | **Removed.** Fully superseded — its orphan-scan logic is now one case inside the unified `delete_evidence_photos()` eligibility check. See §8 for why this was judged safe to remove rather than leave dormant. |
| `src/pages/admin/PhotoStorageTab.jsx` | **Rewritten** (742 → 515 lines). New usage card + gallery UI; manual routing controls, activity table, realtime subscription, and technical-details panel all removed. `StorageMonitoringPage.jsx` (the thin wrapper) is untouched. |
| `src/lib/database.js` | `getPhotoStorageMode`, `setPhotoStorageMode`, `getPhotoStorageEvents`, `checkUnusedPhotos`, `removeUnusedPhotos` removed (no longer called by anything). `listEvidencePhotos` and `deleteEvidencePhotos` added. `getPhotoStorageSummary` / `checkPhotoStorageHealth` unchanged. |
| `supabase/functions/archive-expired-evidence-photos/index.ts` | One-line comment fix (referenced the now-removed `cleanup-orphaned-photos` by name; repointed to `delete-storage-photos`). No behavior change. |
| `supabase/config.toml` | `[functions.cleanup-orphaned-photos]` replaced with `[functions.delete-storage-photos]` (same `verify_jwt = false` — self-authenticates internally, same family as the other photo functions). |
| `scripts/smoke-check.mjs` | Required-file list updated: `cleanup-orphaned-photos` → `delete-storage-photos`; added the three most recent photo-storage migrations to the required list. |
| `scripts/photo-storage-monitoring-contract-test.mjs` | Rewritten to match the new architecture — old UI/removed-function assertions replaced with assertions on the new migration, edge function, and page. See §5. |
| `scripts/photo-gallery-pgtest/run.mjs` | **New.** Focused local regression suite (real embedded Postgres, not a mock) for `classify_evidence_photo_ref` / `list_evidence_photos` / `delete_evidence_photos`. See §5. |
| `package.json` | Added `"test:photo-gallery": "node scripts/photo-gallery-pgtest/run.mjs"`, matching the existing `test:payment-ledger` / `test:shipping-discount` convention. |

Nothing outside this list was touched. `../audits/STORAGE_MONITORING_SIMPLIFICATION_REVIEW.md` (the prior audit) and the other pre-existing root-level reports were left exactly as they were.

---

## 3. Automatic fallback behavior — verified, not modified

Task 4 asked me to verify and preserve "try main storage first, fall back automatically on failure." I traced the actual upload code (`src/lib/storage.js`, `uploadToSupabaseStorage`) and found it **already implements every requirement correctly** — this needed verification, not a rewrite:

- **Main first:** `uploadToSupabaseStorage` always attempts the Supabase Storage upload first, unless `upload_mode` is already `force_firebase` (an operator-only override — see below).
- **Automatic fallback on failure:** on a Supabase upload error, the code checks whether the failure was a **validation** error (bad file type/size) — those `throw` immediately and never fall back, because retrying a rejected file on a different provider isn't a "failure the fallback is meant to handle," it's a real, correct rejection (storage.js:256-266). Any other failure triggers `tryFirestoreFallback()`.
- **Correct reference saved either way:** a successful Supabase upload returns a `{ type: 'supabase_storage', bucket, path, size_bytes, created_at }` descriptor; a successful fallback returns `{ type: 'firestore_fallback', firestore_path, size_bytes, created_at }`. Both are handled uniformly everywhere downstream (`resolvePhotoUrl`, the new gallery, the archive job).
- **Both fail → understandable error, retriable:** if the fallback also fails, the **original** Supabase error is what surfaces to the caller (storage.js:279-287) — deliberately, since the primary error is what actually needs fixing. The booking form's existing retry affordance is unaffected by this change (not touched).
- **No auth/authorization/validation bypass via fallback:** `tryFirestoreFallback` is only reachable for evidence folders with a known `orderId` (`isFallbackEligible`), and the server-side `store-photo-fallback` Edge Function independently re-checks `role = 'admin'` and re-validates the JPEG bytes itself — the client-side routing decision is never trusted as authorization.
- **No duplicate uploads / false success on timeout:** each upload attempt is a single request; a network timeout on the Supabase attempt is treated as a failure like any other and falls through to the one fallback attempt — there is no retry loop that could double-submit. This is unchanged existing behavior, confirmed by reading, not something this task added.
- **The routing toggle is a real, enforced switch, not cosmetic:** `is_supabase_evidence_upload_allowed()` (Storage RLS, unchanged) blocks Supabase INSERT/UPDATE on evidence paths at the database layer whenever `upload_mode = 'force_firebase'` — so even if client code were compromised, it could not write new evidence to Supabase while that mode is active. Verified live in the review; unchanged here.

**What this task did change:** the *admin-facing* manual control for `force_firebase` was removed from the page (§8 has the reasoning). The mechanism itself — `photo_storage_settings`, `get_effective_photo_storage_mode()`, `set_photo_storage_mode()`, the Storage RLS gate — is untouched and still fully enforced. An operator can still flip it by calling `set_photo_storage_mode(...)` directly by SQL during an incident; it just isn't a page you click through anymore. The new migration's last statement resets `upload_mode` to `'automatic'` if it was ever left mid-override, so removing the UI control can never leave a stale forced-fallback state live (§6, §7 — this was verified live to already be `'automatic'` before writing this, so the statement is a no-op today and a safety net for the future).

**Firebase's separate usage summary:** the gallery's Storage Usage card already kept Supabase's total and Firebase's estimated total as two separate lines — never combined into one percentage or one allowance — both in the prior page and in this rewrite. This was verified, not newly built.

---

## 4. Exact photo deletion eligibility and protections

Every rule below is enforced **twice**: once (informationally) by `list_evidence_photos()` so the gallery shows the right badge and reason, and again, independently, by `delete_evidence_photos()` at the moment of deletion — the second check never trusts the first. A tampered or stale request from the browser is re-derived from the database, not read off the request body.

| Category | Rule | Reason shown |
|---|---|---|
| **Must remain — receipt** | Any photo attached via `payment_transactions.receipt_url` | "Receipt photo — kept as a financial record" |
| **Must remain — featured** | `orders.featured_on_website = true` | "Featured on the public website" |
| **Must remain — active shipment** | `orders.status NOT IN ('Delivered', 'Cancelled')` | "Shipment is still in progress" |
| **Must remain — too recent** | Delivered/Cancelled, but the status change (from `order_status_events`, not `orders.updated_at` — same source the existing 6-month archive job already used) is less than 6 months ago | "Delivered/cancelled recently — kept for 6 months" |
| **Can be deleted — referenced, aged out** | Delivered/Cancelled ≥ 6 months ago, not featured, pickup or delivery photo (never receipt) | "Delivered/cancelled over 6 months ago" |
| **Can be deleted — orphaned** | A file exists in Storage under an evidence folder whose tracking-number segment matches no booking at all | "No matching booking was found for this photo" |

This is the **same 6-month/featured/status rule already enforced by the existing scheduled archive job** (`get_expired_evidence_orders()`, unchanged) — nothing was relaxed, loosened, or given a new threshold. The only thing this task adds is the ability to act on **individual eligible photos** rather than waiting for the whole order to qualify, plus the same orphan-detection the removed "Check Unused Photos" button already did.

**What happens when the admin clicks Delete Selected**, step by step:

1. The client sends `{order_id, photo_field, provider, storage_path}` for each selected item to `delete-storage-photos`.
2. The Edge Function requires a valid admin JWT (`role = 'admin'` re-checked from `profiles`, not read off the request).
3. It calls `delete_evidence_photos()` **using that admin's own JWT** — so the function's internal `is_admin()` check and every rule in the table above run for real, right now, against the current database state. For a referenced photo, it re-locks the order row (`FOR UPDATE`), re-derives the 6-month cutoff, re-checks `featured_on_website` and `status`, and — critically — confirms the exact `(provider, storage_path)` is still actually present in that order's photo array before touching anything. If it isn't (a stale selection, a race with another admin action), the item is rejected with "Photo reference no longer matches this booking" and nothing is changed.
4. For each item that passes, exactly that one element is removed from `orders.pickup_photos` or `orders.delivery_photos` (never the whole array — a booking can have some photos deleted and others kept), and the file is upserted into the existing `photo_cleanup_queue` (the same durable queue the automatic archive job already uses).
5. Only *after* that database transaction commits does the Edge Function attempt the physical deletion — a batched `storage.remove()` call for Supabase-stored items, an individual Firestore document DELETE for fallback items (identical calls to what the already-reviewed `archive-expired-evidence-photos` makes).
6. Each outcome — deleted, or failed and staying in the queue for retry — is recorded via `record_photo_cleanup_queue_result()`, the same bookkeeping function the nightly job uses. A crash between steps 4 and 5 leaves the file queued but not yet deleted — the nightly job (which already processes *any* pending queue row, not only ones it created itself) will pick it up and finish the job automatically. Nothing can be queued-but-forgotten or deleted-but-still-referenced.
7. The admin sees exact counts back: requested, deleted, failed (will retry automatically), and rejected (with the specific reason per photo) — never a blanket "done."

**Shared references are protected structurally, not by a special case.** A referenced photo (one that appears in an order's `pickup_photos`/`delivery_photos`) and an orphaned file (no matching order at all) are computed from two disjoint sources — the orders table vs. a `NOT EXISTS` scan of Storage — so a photo that is genuinely still attached to a booking can never be misclassified as "unused" just because a same-named object exists in Storage. This was specifically tested (see §5, "a real file that IS still referenced is never listed as an orphan").

**Booking, payment, and unrelated company assets are never touched.** `delete_evidence_photos()` only ever writes to `orders.pickup_photos`/`orders.delivery_photos` (one element) and `photo_cleanup_queue`; it has no code path that deletes a row from `orders`, `payment_transactions`, or anything else, and it only recognizes files under `pickup-proofs/`, `delivery-proofs/`, and `receipts/` — the `company-assets` bucket and the `gallery/hero/timeline` folders inside `cargo-photos` (public website images) are outside its regular expressions entirely and are never candidates for listing or deletion.

---

## 5. Tests run and actual results

All of the following were run **locally** in this session, against this repository's own test tooling — no changes were made to the live Supabase project.

| Command | Result |
|---|---|
| `npm run build` | ✅ Clean production build, no errors |
| `node scripts/token-lint.mjs` | ✅ 217 tokens defined, 197 files scanned — passed (caught and fixed one undefined `--text-primary` reference during development, see below) |
| `node scripts/axe-lint.mjs` | ✅ 160 files scanned — passed |
| `npm test` (full default chain, 21 scripts including the rewritten photo-storage contract test) | ✅ All passed |
| `npm run test:edge-functions` | ✅ 18 functions found and built, including the new `delete-storage-photos` and confirming `cleanup-orphaned-photos` is gone |
| `node scripts/photo-fallback-browser-test.mjs` | ✅ 9 assertions passed (unrelated code, confirms nothing here broke it) |
| `npm run test:pwa-offline` | ✅ 71 assets precached, passed |
| **`npm run test:photo-gallery`** (new) | ✅ **43 of 43 assertions passed** |

### The new `test:photo-gallery` suite

This is a real embedded Postgres (PGlite — compiled Postgres, not a mock), built the same way this repo's existing `payment-ledger-pgtest` / `shipping-discount-pgtest` suites are: a hand-built harness gives just enough of the real `orders` / `payment_transactions` / `profiles` / `auth.uid()` shape, then **the actual migration file is applied verbatim** on top, so what's tested is byte-for-byte the SQL that will ship. It covers:

- `classify_evidence_photo_ref`: current-format Supabase and Firestore descriptors, legacy raw string paths, legacy raw Firestore paths, embedded `data:` URLs (correctly unclassified), a double-encoded JSON string (a real edge case I found and fixed while writing this test — see below), and unrelated shapes.
- `list_evidence_photos`: non-admin rejection; an old Delivered order's photos showing eligible; a recently-Delivered order's photos showing protected with the right reason; an active shipment's photos protected regardless of age; a featured order's photos protected regardless of age; a receipt always protected; an orphaned file showing eligible; **a still-referenced file that also happens to exist in Storage is never misclassified as orphaned**; filter correctness for `eligible`/`protected`; search-by-tracking-number; pagination and `total_count`.
- `delete_evidence_photos` (the safety-critical path): non-admin rejection, empty-selection rejection, >100-items rejection, an eligible photo being queued and *only that one element* removed from the array (sibling photos and the other field untouched), a featured photo rejected and left unchanged, an active-shipment photo rejected, a too-recent photo rejected, a receipt rejected even when explicitly requested, a stale/tampered path rejected with "no longer matches this booking," a nonexistent booking rejected, a genuine orphan queued, an orphan claim re-checked and blocked because a real booking now exists for it, an orphan claim rejected because the file doesn't actually exist, a malformed path rejected, **idempotent re-queuing** (deleting the same photo twice doesn't create a duplicate queue row), and a mixed batch (one eligible + one protected in the same request) producing two independent, correct outcomes.

**Two real bugs this test caught and I fixed before considering the work done, not after:**

1. **An ambiguous-column bug in `list_evidence_photos`**, the exact same class of bug this codebase's own migration history already hit twice before (`20260831200000_fix_ambiguous_upload_mode.sql`, `20260831204600_fix_ambiguous_set_photo_storage_mode.sql`): a bare `status = p_filter` inside the function body is ambiguous between the query column and the function's own `RETURNS TABLE(... status text ...)`, which PL/pgSQL treats as an implicitly-declared variable. Fixed by table-qualifying (`c.status`, `c.tracking_number`) and left a comment pointing at the precedent so it doesn't recur a third time.
2. **A missing legacy-format case in `classify_evidence_photo_ref`**: the JS reference implementation (`photoReference.js`'s `normalizePhotoReference`) re-parses a string element that starts with `{` as JSON before classifying it, for *any* jsonb array element regardless of column — my first draft only did this for the `receipt_url` text column, not for `pickup_photos`/`delivery_photos` array elements. Added the same recursive parse-and-classify to close that parity gap.

### Verification gaps — stated explicitly, not glossed over

Per your instruction not to claim verification that wasn't actually done:

- **The Edge Function's live Storage/Firestore calls were not exercised end-to-end.** `test:photo-gallery` proves the SQL eligibility/array-mutation logic is correct against real Postgres; it does not call the real Supabase Storage API or the real Firestore API (those require live credentials this environment doesn't have, and the task explicitly said not to delete real customer images without approval). `npm run test:edge-functions` confirms the function *builds*; it does not confirm the Storage/Firestore calls succeed against a live bucket.
- **No browser/UI testing was performed.** The frontend build, token-lint, and axe-lint checks confirm the page compiles, is theme-token-clean, and passes static accessibility scanning — they do not confirm the gallery actually renders correctly, that thumbnails load, that search/filter/selection behave as intended in a real browser, or that the mobile layout is usable. `npm run dev` was not started and no screenshots were taken.
- **No Playwright/E2E test was added or run.** `tests/*.spec.js` had no existing spec for this page; per `CLAUDE.md`, that suite runs against a **real** Supabase project and creates live data — I did not point it at the connected project (I don't have confirmation it's a safe dev/staging target rather than production), and did not fabricate a run.
- **The scheduled purge/cron change, the eligibility functions, and the upload-mode reset have not been applied to the live database.** Live-database verification in this report (e.g., "already `'automatic'`") reflects the read-only queries run in the prior audit session, not a re-check performed as part of this implementation pass.

If you want the Storage/Firestore and browser gaps closed, the concrete next step is deploying this migration and function to a **staging** Supabase project (never production) and running the page there with a few disposable test photos — I did not do this myself because it requires applying a migration and deploying a function, both of which need your explicit go-ahead per your instructions.

---

## 6. Database changes and their reasons

**Nothing was dropped.** Every table, column, and existing function named in the prior review stays exactly as it was. The new migration is additive:

| Change | Reason |
|---|---|
| `text_to_photo_ref()` (new function) | SQL-side mirror of `photoReference.js`'s text-column handling, needed so `payment_transactions.receipt_url` (a legacy TEXT column) can be classified the same way jsonb array elements are. |
| `classify_evidence_photo_ref()` (new function) | SQL-side mirror of `photoReference.js`'s `normalizePhotoReference()`, needed so the gallery can read provider/path/size/date out of a photo descriptor without a network round-trip per photo. |
| `list_evidence_photos()` (new function) | Backs the gallery. Read-only. |
| `delete_evidence_photos()` (new function) | Backs deletion. Re-derives eligibility from scratch — see §4. |
| `cron.schedule('purge_photo_storage_operational_logs', ...)` | See §7 — the two retention functions existed but were never scheduled. |
| `UPDATE photo_storage_settings SET upload_mode = 'automatic' WHERE ... <> 'automatic'` | Safety net so removing the manual UI control can never leave a stale forced-fallback mode live (§3). Verified as a no-op against the current live value. |

**Fields identified as used exclusively by the removed manual-toggle UI:** none. `photo_storage_settings.force_firebase_expires_at`, `.reason`, and `.updated_by` were checked against every caller (`is_supabase_evidence_upload_allowed()`, `get_effective_photo_storage_mode()`, `set_photo_storage_mode()`) and remain necessary for the backend enforcement mechanism itself, which stays active — only its admin-facing button was removed, not the mechanism. This matches the prior review's own conclusion (§10-C of that report) and is why no column removal is proposed here either.

**What was removed at the code layer (not the database layer), and why it was judged safe:**

- The `cleanup-orphaned-photos` Edge Function was deleted, not deprecated-in-place. Its entire job — detecting orphaned evidence files and deleting them with admin confirmation — is now one branch of `delete_evidence_photos()`'s eligibility check, reachable through the same unified gallery. Keeping both would have meant two separate, overlapping deletion code paths with duplicated authorization/validation logic to maintain and audit — exactly the kind of technical surface area this task asked to reduce. Every reference to it (`supabase/config.toml`, `scripts/smoke-check.mjs`, the contract test, one comment in `archive-expired-evidence-photos`) was found by grep and updated; nothing references it anymore, and the contract test now asserts it stays gone (`!existsSync('supabase/functions/cleanup-orphaned-photos')`).
- Its underlying SQL, `list_orphaned_evidence_photos()`, was **not** removed — it's still a standalone, harmless, read-only admin function that could still be run ad hoc from SQL; only the Edge Function wrapper that made it reachable from the old button was deleted, and the *logic* it performed (the `storage.objects` orphan scan) is re-implemented as one CTE inside `list_evidence_photos()` rather than calling the old function directly, because the gallery needs extra columns (size, content type, taken-at) that function doesn't return.
- `getPhotoStorageMode`, `setPhotoStorageMode`, `getPhotoStorageEvents`, `checkUnusedPhotos`, `removeUnusedPhotos` were removed from `src/lib/database.js` because nothing calls them anymore (confirmed by grep before removing each one) — per this repo's own convention (`CLAUDE.md`: "one exported function per operation" used by pages), an unused wrapper is dead code, not a kept capability; the underlying RPCs they wrapped are unaffected and still callable directly by SQL.

---

## 7. Scheduling changes

**Verified before implementing (per task instruction), not assumed from the prior review:** `purge_old_photo_storage_events` and `purge_old_photo_cleanup_queue` were confirmed live-unscheduled again in this session by inspecting the migration history — neither function name appears in any `cron.schedule(...)` call anywhere in `supabase/migrations/`, and the prior review's live `cron.job` query (read-only, run against the connected project) showed only `scheduled_old_photo_cleanup` and `photo_storage_health_check` registered. This confirms the gap the review flagged is real and still open.

**What the new migration does about it:**

```sql
SELECT cron.schedule(
  'purge_photo_storage_operational_logs',
  '0 3 * * 0', -- Sundays 03:00 UTC
  $cron$
    SELECT public.purge_old_photo_storage_events(30);
    SELECT public.purge_old_photo_cleanup_queue(7);
  $cron$
);
```

**Pending work is preserved, not swept up:** `purge_old_photo_cleanup_queue(7)` only deletes rows where `completed_at IS NOT NULL AND completed_at < now() - 7 days` — pending, failed, and currently-retrying rows (`completed_at IS NULL`) are untouched by construction, exactly as the function was already written when it was added on 2026-09-08. This migration does not change that function's logic at all, only adds the missing schedule that calls it. `purge_old_photo_storage_events(30)` only removes audit-log rows older than 30 days; it has no interaction with in-flight work at all.

**Deleting photo objects vs. purging operational logs stay clearly separate**, both in the code and in this write-up: the cron job above only ever deletes rows from `photo_storage_events` (an audit log) and *completed* rows from `photo_cleanup_queue` (bookkeeping for work already finished) — it never calls anything that touches Supabase Storage or Firestore. Actual photo-object deletion happens exclusively in `delete-storage-photos` and `archive-expired-evidence-photos`, both unrelated to this schedule.

### Awaiting your approval — exact deployment steps not yet run

Nothing above has touched the live project. To deploy, in order:

```bash
supabase db push               # applies 20260915090000_simplify_storage_monitoring_gallery.sql
supabase functions deploy delete-storage-photos
```

(`cleanup-orphaned-photos` will stop being served automatically once you next run a full `supabase functions deploy` for the project, or you can remove it explicitly from the dashboard — deleting the local file does not undeploy a remote function by itself.)

I did not run either command. Per your instructions, I did not execute schema changes or deploy functions against the live/linked project without your explicit sign-off on the concrete changes above.

---

## 8. Corrections to the prior review, found while implementing

You asked me to treat the review as a starting point, not unquestionable evidence, and verify against current code. Two things came up:

1. **The review recommended *keeping* `cleanup-orphaned-photos` and only fixing UI wording** (§10-A of the review: "add one clarifying sentence... §10-C: no code changes recommended"). That was the right call **for a wording-only fix**, but this task's brief goes further — it explicitly asks for one unified "select and delete" experience, not two buttons with a clarifying sentence between them. Once the gallery unifies both eligibility paths behind one `delete_evidence_photos()` call, keeping the old button and Edge Function around would have reintroduced exactly the confusion the review flagged, just with an extra sentence attached. I removed it instead, for the reasons in §6.
2. **The review's SQL was read, not executed.** Writing the actual `list_evidence_photos()`/`delete_evidence_photos()` functions and testing them against real Postgres surfaced the ambiguous-column bug and the double-encoded-string gap described in §5 — neither was visible from reading migration files alone. This is exactly why the pgtest suite exists as a required part of this implementation rather than an optional nice-to-have.

---

## 9. Limitations and unresolved decisions

- **No thresholds were invented.** The 80/95/100% color bands and the 85% backend low-storage notification are unchanged from the existing code — this task did not add, remove, or renumber any of them.
- **`photo_cleanup_queue.attempts` still has no cap or give-up behavior.** A file that fails repeatedly will retry forever inside the nightly job, silently. This was flagged as an open business decision in the prior review (§13) and remains one — not something this implementation should decide unilaterally.
- **Per-item failure detail from the physical-deletion step is captured but not yet surfaced in the gallery UI.** `delete-storage-photos` now returns a `failed: [item_key, ...]` list (added during this pass so the data isn't silently dropped), but the current page only shows aggregate counts in the result banner, not which specific photos failed. Extending the banner to list them by tracking number would be a small, low-risk follow-up if you want it.
- **Legacy/unclassifiable photo references are shown but not actionable**, by design: a photo descriptor `classify_evidence_photo_ref()` can't recognize (an old raw URL, an embedded `data:` image, an unrecognized object shape) simply produces no row for size/provider purposes and is never selectable for deletion — matching how `archive-expired-evidence-photos` already treats an "unknown" reference as unsafe to touch automatically. It is not hidden from the gallery entirely (it still appears if referenced through the normal order/receipt path), it just never gets a checkbox.
- **Mobile layout was designed to the existing responsive grid conventions** (`repeat(auto-fill, minmax(160px, 1fr))`, the same collapsing patterns already used elsewhere in the admin app) but was not visually verified in a real mobile viewport — see the verification gaps in §5.
