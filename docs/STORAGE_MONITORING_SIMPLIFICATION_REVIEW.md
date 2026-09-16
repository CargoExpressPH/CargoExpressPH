# Storage Monitoring Module — Simplification Review

**Scope:** `/admin/storage-monitoring` (Photo Storage) — `photo_storage_settings`, `photo_storage_events`, `photo_cleanup_queue`, and the photo/storage columns they interact with on `orders` and `payment_attempts`.
**Type:** Read-only inspection and planning. No code, schema, records, storage settings, or stored files were changed to produce this report.
**Method:** Live Supabase project (`duigaivxgxlnjmfienhg`, linked) queried read-only via `supabase db query --linked` (information_schema, pg_catalog, pg_policies, pg_proc, cron.job, storage.buckets, storage.objects policies, `supabase_migrations.schema_migrations`) — no Docker/psql was available, so `supabase db dump` could not run, but `db query` gave direct, authoritative access to live metadata. This was cross-checked against `supabase/schema.sql`, all `supabase/migrations/*.sql`, `src/lib/database.js`, `src/pages/admin/{StorageMonitoringPage,PhotoStorageTab}.jsx`, the six photo-related Edge Functions, `scripts/photo-storage-monitoring-contract-test.mjs`, prior root-level audit reports, and `git log`.
**Convention used below:** 🟢 **LIVE-VERIFIED** = confirmed against the actual running database just now. 📄 **REPO** = confirmed by reading migration/source files. Where the two disagree, both are stated explicitly.

---

## 1. Executive Summary (plain English)

The Storage Monitoring page already does what an admin needs: it tells them **how full the photo storage is** (Good / Getting Full / Action Needed), **what's using the space** (pickup, delivery, receipt photo counts), **whether something is broken** (live health badges + a 24-hour failure count), and gives them exactly **two actions** — a manual "remove orphaned photos" cleanup, and an emergency "route new photos to Backup instead" switch. A prior UX pass (see §5, `CARGOEXPRESS_MONITORING_PAGE_UX_AUDIT.md`) already collapsed the technical/provider-level detail into three optional, closed-by-default sections. **This page is close to the target you're describing already** — the remaining opportunities are small wording fixes, not a redesign.

The three core tables (`photo_storage_settings`, `photo_storage_events`, `photo_cleanup_queue`) are **not bloated**. Every column earns its place: either the UI reads it, a background job reads/writes it, an RLS policy depends on it, or a CHECK constraint depends on it. None are candidates for removal. The one concrete "extra columns" pattern worth your attention is a **look-alike, not a duplicate**: `payment_attempts.pickup_photos` has the same name as `orders.pickup_photos` but lives on a different table for a different, actively-used reason (§5).

**Did anything "come back" after a cleanup?** No evidence of an actual column being dropped and later re-added was found anywhere in migration or git history (§5, §3). What most likely produced that impression is a **stale internal report** — `DATABASE_PRACTICAL_PRIORITIES_REPORT.md` states the Sept-8 photo-retention migration was "intentionally left unapplied," but the live database proves it **was** applied (and further secured three days later). If you read that report and then looked at the live project, the retention functions would appear to have "reappeared" — they never left; the report was just out of date (§3, §5).

The one genuine reliability gap found: two "clean up old records" functions (`purge_old_photo_storage_events`, `purge_old_photo_cleanup_queue`) were built and correctly locked down, but were **never scheduled to actually run** (§8). `photo_storage_events` will grow forever until someone calls them from a cron job.

---

## 2. Current Module Architecture and Data Flow

```
Admin opens /admin/storage-monitoring
        │
        ▼
StorageMonitoringPage.jsx (src/pages/admin/StorageMonitoringPage.jsx:1-14)
        │  wraps everything in an ErrorBoundarySection
        ▼
PhotoStorageTab.jsx (src/pages/admin/PhotoStorageTab.jsx, 742 lines — this IS the whole module's UI)
        │
        ├─ getPhotoStorageMode()      → RPC get_effective_photo_storage_mode()      (database.js:3380)
        ├─ getPhotoStorageSummary()   → RPC get_photo_storage_summary()             (database.js:3396)
        ├─ getPhotoStorageEvents()    → SELECT photo_storage_events (paged)         (database.js:3402)
        ├─ checkPhotoStorageHealth()  → Edge Fn photo-storage-health                (database.js:3428)
        ├─ checkUnusedPhotos()        → Edge Fn cleanup-orphaned-photos {preview}   (database.js:3438)
        ├─ removeUnusedPhotos()       → Edge Fn cleanup-orphaned-photos {delete}    (database.js:3447)
        └─ setPhotoStorageMode()      → RPC set_photo_storage_mode()               (database.js:3386)

Realtime: a Supabase Realtime channel subscribes to INSERT on photo_storage_events
(PhotoStorageTab.jsx:209-226) and reloads the whole screen when a new event lands,
plus a 60s poll (PhotoStorageTab.jsx:230-234) as a backstop for provider outages
that don't produce a DB event.
```

**Background/scheduled side** (none of this is visible in the frontend, all found live in `cron.job` 🟢 and cross-checked against migrations 📄):

| Cron job | Schedule | Calls | Purpose |
|---|---|---|---|
| `scheduled_old_photo_cleanup` | `30 1 * * *` (1:30 AM daily) | `trigger_scheduled_old_photo_cleanup()` → Edge Fn `archive-expired-evidence-photos` | Permanently delete pickup/delivery photos for orders `Delivered`/`Cancelled` > 6 months, via a durable queue |
| `photo_storage_health_check` | `15 */6 * * *` (4×/day) | `trigger_photo_storage_health_check()` → Edge Fn `photo-storage-health` | Refresh live usage, notify admins at 85% |

**Six Edge Functions** are involved (all under `supabase/functions/`):
`photo-storage-health` (320 ln), `cleanup-orphaned-photos` (196 ln), `archive-expired-evidence-photos` (378 ln), `record-photo-storage-event` (82 ln), `store-photo-fallback` / `get-photo-fallback` / `delete-photo-fallback` (Firebase fallback CRUD, invoked by the actual photo upload flow elsewhere in the app, not by this page directly).

**Twelve SQL functions**, all `SECURITY DEFINER`, all live-confirmed 🟢: `get_effective_photo_storage_mode`, `set_photo_storage_mode`, `get_photo_storage_summary`, `get_photo_storage_live_usage`, `is_featured_photo_path`, `is_supabase_evidence_upload_allowed`, `list_orphaned_evidence_photos`, `get_expired_evidence_orders`, `queue_expired_evidence_cleanup`, `record_photo_cleanup_queue_result`, `purge_old_photo_cleanup_queue`, `purge_old_photo_storage_events`, `trigger_photo_storage_health_check`, `trigger_scheduled_old_photo_cleanup` (14 total).

**Enforcement is server-side, not advisory.** The "force new photos to Backup" toggle isn't just a UI flag the client is trusted to respect — it's enforced by a Storage RLS policy 🟢:

```sql
-- is_supabase_evidence_upload_allowed(p_path), live-verified
SELECT public.is_admin()
  AND (
    (storage.foldername(p_path))[1] NOT IN ('pickup','delivery','receipts','pickup-proofs','delivery-proofs')
    OR COALESCE(
      (SELECT (ps.upload_mode = 'automatic' OR ps.force_firebase_expires_at <= now())
       FROM public.photo_storage_settings ps WHERE ps.id = TRUE),
      TRUE)
  );
```
When `upload_mode = 'force_firebase'` and not expired, Supabase Storage itself **refuses** new pickup/delivery/receipt uploads — the client has no way to bypass this even if it wanted to. This matches the CLAUDE.md principle ("the browser is never trusted") and is genuinely load-bearing, not decorative.

---

## 3. Live vs. Repository Differences

| Item | Live DB (🟢 verified) | Repo (📄 `supabase/schema.sql`) | Verdict |
|---|---|---|---|
| `photo_storage_settings`, `photo_storage_events`, `photo_cleanup_queue` columns/constraints/indexes | Match exactly what migrations 20260831170000 + 20260901030000 define | Present, matches (schema.sql:293-336 region) | ✅ In sync |
| `purge_old_photo_storage_events(int)`, `purge_old_photo_cleanup_queue(int)` | **EXIST**, `SECURITY DEFINER`, `GRANT EXECUTE` restricted to `service_role` only | **ABSENT** — `grep -n "purge_old_photo" supabase/schema.sql` returns nothing | ⚠️ Repo snapshot stale — schema.sql was never regenerated after migrations `20260908112100` and `20260911075700` landed |
| `20260908112100_prepare_photo_retention` and `20260911075700_secure_photo_cleanup_functions` recorded as applied | **YES** — both appear in `supabase_migrations.schema_migrations` 🟢 (confirmed by direct query) | `git log --oneline -- supabase/schema.sql` shows no commit touching schema.sql after `6566a5f` (the migration before these two) | The migrations *were* deployed; only the hand-maintained schema.sql snapshot lags. This is a documentation gap, not a functional one — migrations, not schema.sql, are the actual source of truth per `CLAUDE.md`. |
| `DATABASE_PRACTICAL_PRIORITIES_REPORT.md` §3 claim: *"`20260908112100_prepare_photo_retention.sql` is ready but intentionally left unapplied"* | **Contradicted** — the migration is applied, the functions exist and work | — | ❌ Stale claim in a prior internal report — see §5 for why this likely produced the "did a column come back?" impression |
| `CARGOEXPRESS_DATABASE_CLEANUP_AUDIT.md` L59: references a function `clean_up_abandoned_photos()` as "Active (Cron target)" | **No such function exists** — `grep -rn "clean_up_abandoned_photos" supabase/` = zero hits; the real cron targets are `trigger_scheduled_old_photo_cleanup()` / `trigger_photo_storage_health_check()` | — | ❌ Factual error in a prior audit (likely a paraphrase/typo, not evidence of a dropped function) |
| RLS policy count on the three tables | `photo_storage_events`: **1** policy (admin SELECT). `photo_storage_settings` and `photo_cleanup_queue`: **0** policies each, RLS enabled | Matches — migrations 1 and 5 explicitly create only that one policy | ✅ In sync. Deliberate: these two tables are reachable *only* through `SECURITY DEFINER` RPCs / service-role Edge Functions, never through a direct client query. |
| `photo_cleanup_queue` row count | **0 rows ever inserted** (both its indexes show `index_scans: 0`, `unused: true` in `supabase inspect db index-stats`) | — | Not a defect — no order has crossed the 6-month archive threshold yet in this project's data. Do not read this as "the queue is unnecessary" (see §5, §9 caution). |

**No evidence anywhere** (git history, migration diffs, schema.sql history) of a photo/storage column being dropped and later re-added on any of these tables, `orders`, or `payment_attempts`. `git log -p --all -- supabase/migrations/` for `DROP COLUMN.*photo|storage` / `ADD COLUMN.*photo|storage` patterns returns zero matches.

---

## 4. Complete Table-and-Column Inventory

### `photo_storage_settings` (singleton config row — the admin's routing choice)

| Column | Type | Purpose (plain English) | Written by | Read by | Recommendation | Evidence |
|---|---|---|---|---|---|---|
| `id` | boolean, PK, `CHECK(id)` | Forces exactly one row to ever exist (the "one dial" for the whole app) | table creation only | every function below (`WHERE id = TRUE`) | Required for core behavior | migration `20260831170000`:5-18 🟢 |
| `upload_mode` | text, `'automatic'`\|`'force_firebase'` | Whether new photos go to Supabase first (normal) or straight to Firebase Backup (emergency) | `set_photo_storage_mode()` | `get_effective_photo_storage_mode()`, `is_supabase_evidence_upload_allowed()` (Storage RLS gate) | Required for core behavior | 🟢 live constraint + function defs |
| `force_firebase_expires_at` | timestamptz, nullable | When the emergency mode auto-reverts (max 24h out) | `set_photo_storage_mode()` | `get_effective_photo_storage_mode()` (auto-expiry check), Storage RLS gate | Required for core behavior | 🟢 `force_firebase_requires_expiry` CHECK pairs this with `upload_mode` |
| `reason` | text, ≤500 chars, nullable | Admin's free-text note on why they switched modes | `set_photo_storage_mode()` | UI "Reason" field, activity log detail text | Useful operational history | PhotoStorageTab.jsx:583-591 |
| `updated_by` | uuid, FK `profiles(id)` | Which admin last changed the setting | `set_photo_storage_mode()` (`auth.uid()`) | not currently surfaced in UI | Required for reliability/security (accountability) — but see §10 for a low-cost UI addition | 🟢 FK confirmed live |
| `updated_at` | timestamptz | When it last changed | `set_photo_storage_mode()` | `get_effective_photo_storage_mode()` return value, UI banner text | Required for core behavior | PhotoStorageTab.jsx:443 |

### `photo_storage_events` (append-only activity log — "Recent Photo Activity" table)

| Column | Type | Purpose | Written by | Read by | Recommendation | Evidence |
|---|---|---|---|---|---|---|
| `id` | uuid PK | Row identity, realtime key | insert-time default | React `key`, pagination | Required for core behavior | database.js:3408 |
| `event_type` | text, `upload`\|`mode_change`\|`health_check`\|`cleanup` | What kind of thing happened | `record-photo-storage-event` (upload), `set_photo_storage_mode`/auto-expiry (mode_change), `archive-expired-evidence-photos` + `cleanup-orphaned-photos` (cleanup) | `activityName()` UI switch (PhotoStorageTab.jsx:51-61) | **Potentially unused value, not column**: `'health_check'` is allowed by the CHECK constraint and has a UI label, but **nothing in the codebase ever writes it** — `photo-storage-health`'s Edge Function only returns JSON, never inserts a row. See §8. | grep across all Edge Functions: only `upload` and `cleanup` are ever inserted |
| `provider` | text, `supabase`\|`firebase`\|`system` | Where it happened / who did it | same as above | `providerLabel()` UI, `provider_outcome_idx` | Required for core behavior | index `photo_storage_events_provider_outcome_idx` |
| `outcome` | text, `success`\|`failure`\|`expired` | Result | same | badge color, `failures_last_24h` count in `get_photo_storage_summary()` | Required for core behavior | function def line "outcome = 'failure'" |
| `photo_type` | text, `pickup`\|`delivery`\|`receipt`, nullable | Which kind of photo (only set for `upload` events) | `record-photo-storage-event` | `photoTypeLabel()` UI | Required for core behavior | record-photo-storage-event/index.ts:35,69 |
| `order_id` | uuid, FK `orders(id) ON DELETE SET NULL`, nullable | Which shipment, for upload events | `record-photo-storage-event` | not directly shown in this table's UI row today (see §10) | Useful operational history (currently under-surfaced, not unused) | 🟢 FK + partial index `WHERE order_id IS NOT NULL` |
| `storage_path` | text, nullable | Exact file path, for troubleshooting | upload/cleanup writers | not shown in UI (kept out on purpose — see photoFunctionError pattern) | Required for reliability (debugging aid) | events table def |
| `size_bytes` | bigint, nullable, `CHECK >= 0` | File size, for freed-space totals | upload/cleanup writers | `freed_bytes` displayed after a cleanup run | Required for core behavior | PhotoStorageTab.jsx:325 (`formatBytes(result?.freed_bytes)`) |
| `message` | text, ≤500 chars, nullable | Short human-readable outcome sentence | all writers | `activityDetails()` fallback text | Useful operational history | events CHECK `message_length` |
| `metadata` | jsonb, `NOT NULL DEFAULT '{}'` | Structured details (counts, kind, cutoff date, etc.) — the reason `activityDetails()` can say "3 photos removed, 1 pending" | all writers | `activityDetails()` (PhotoStorageTab.jsx:67-92) | Required for core behavior | heavily read by the UI's per-event copy logic |
| `created_by` | uuid, FK `profiles(id) ON DELETE SET NULL`, nullable | Which admin triggered it (null for scheduled/system events) | `set_photo_storage_mode`, `record-photo-storage-event`, `cleanup-orphaned-photos` | joined in `getPhotoStorageEvents()` (`profiles:created_by(name,email)`) but **not rendered** in the table today | Useful operational history (fetched, unused in current UI — cheap to surface, see §10) | database.js:3408 selects it; PhotoStorageTab.jsx never reads `event.profiles` |
| `created_at` | timestamptz | When | insert-time default | sort order, pagination, `created_at_idx`, retention cutoff | Required for core behavior | index + `purge_old_photo_storage_events` |

### `photo_cleanup_queue` (durable retry queue for the automatic 6-month archive)

| Column | Type | Purpose | Written by | Read by | Recommendation | Evidence |
|---|---|---|---|---|---|---|
| `id` | bigint identity PK | Row identity for retry bookkeeping | insert | `record_photo_cleanup_queue_result(p_ids, ...)` | Required for core behavior | migration `20260901030000`:97-106 |
| `provider` | text, `supabase`\|`firebase` | Which storage system holds this file | `queue_expired_evidence_cleanup` | `archive-expired-evidence-photos` (splits into two deletion code paths) | Required for core behavior | 🟢 CHECK + edge fn `pendingSupabase`/`pendingFirebase` split |
| `storage_path` | text | The exact file/document to delete | same | same | Required for core behavior | UNIQUE(provider, storage_path) dedupes re-queues |
| `queued_at` | timestamptz | When it was scheduled for deletion | insert / `ON CONFLICT` upsert | ordering (`ORDER BY queued_at ASC`) so oldest work is processed first | Required for reliability | archive-expired-evidence-photos/index.ts:253 |
| `completed_at` | timestamptz, nullable | Null = still pending/retrying; set = done | `record_photo_cleanup_queue_result` | `.is('completed_at', null)` pending-work filter; retention purge | **Required for reliability** — this is the field that makes the queue crash-safe: a failed run leaves rows with `completed_at = NULL` so the next run retries them automatically, instead of losing track of undeleted files | archive-expired-evidence-photos/index.ts:252, `purge_old_photo_cleanup_queue` WHERE clause |
| `attempts` | integer, `CHECK >= 0`, default 0 | How many times deletion was tried | `record_photo_cleanup_queue_result` (increments) | not currently surfaced to the admin (used only for future backoff/give-up logic, which doesn't exist yet — see §13) | Required for reliability — this is the retry counter the task description asked about explained: it's a plain "how many times have we tried" number, incremented every run, with no current cap/give-up logic reading it | function def: `attempts = attempts + 1` |
| `last_error` | text, ≤ implicit 500 via `left(p_error,500)`, nullable | The most recent failure reason, for troubleshooting a stuck file | `record_photo_cleanup_queue_result` | not currently surfaced in the UI (queue itself has no admin-facing view — see §10) | Required for reliability (diagnostic field) | `record_photo_cleanup_queue_result` def |

### Related columns on other tables (as requested — not core module tables, but load-bearing dependencies)

| Table.Column | Type | Purpose | Written by | Read by | Recommendation | Evidence |
|---|---|---|---|---|---|---|
| `orders.pickup_photos` | jsonb, default `[]` | The shipment's pickup evidence photos (array of path/URL descriptors) | booking/pickup flow (outside this module) | `get_photo_storage_summary()`, `get_expired_evidence_orders()`, `archive-expired-evidence-photos`, `is_featured_photo_path()` | Required for core behavior | 🟢 live column |
| `orders.delivery_photos` | jsonb, default `[]` | Same, for delivery | delivery flow | same set of functions | Required for core behavior | 🟢 live column |
| `orders.featured_on_website` | boolean, default false | Marks an order's photo as safe to show publicly, and **exempts it from the 6-month auto-cleanup** | admin "feature this shipment" action (outside this module) | `get_expired_evidence_orders()` — `AND COALESCE(o.featured_on_website, FALSE) = FALSE` | Required for reliability/security — this is the featured-photo protection the review was asked to verify | migration `20260901030000`:28 🟢; live function def confirms |
| `orders.featured_image_type` | text, nullable | Which photo (pickup vs delivery) is the featured one | same admin action | `is_featured_photo_path()` (decides which single photo gets public read access) | Required for core behavior | `is_featured_photo_path` def |
| `orders.featured_at` | timestamptz, nullable | When it was featured | same admin action | not read by this module directly (site display elsewhere) | Optional to this module specifically, but not unused app-wide | not referenced in any of the 14 functions above |
| `payment_attempts.pickup_photos` | jsonb, default `[]`, nullable | A **snapshot** of pickup photos taken at the moment a GCash payment attempt was created, so a webhook reconciliation days later can restore them onto the order even if the order's own value changed in between | booking/payment-attempt creation flow | payment reconciliation function (`... pickup_photos = COALESCE(attempt_row.pickup_photos, order_row.pickup_photos) ...`) | **Required for reliability — this is not a duplicate of `orders.pickup_photos`.** See §5 for the full explanation; it is actively used and was hardened as recently as `20260911060218_secure_paymongo_order_metadata.sql` (adds a `CHECK (jsonb_array_length(pickup_photos) <= 3)`) | 🟢 confirmed live column + 6 migrations touching this exact COALESCE, most recently `20260912184434` |
| `payment_transactions.receipt_url` | text | The GCash/manual payment receipt image | payment flow | `get_photo_storage_summary()` (counted as the "receipt" photo type) | Required for core behavior | function def: `WHERE t.receipt_url IS NOT NULL` |

**Recommendation categories used above, per your instructions:** none of the columns in these three tables landed in "Potentially redundant" or "Potentially unused" — every one is read by a live function, a live RLS policy, or a live UI element. The only genuinely idle thing found is a **value**, not a column: the `'health_check'` `event_type` (§8).

---

## 5. Findings About "Supposedly Restored" Columns

You asked specifically to investigate this, so to be precise about what was and wasn't found:

1. **No column was ever dropped and re-added.** `git log -p` across every migration file, searched for `DROP COLUMN` / `ADD COLUMN` touching anything photo/storage-named, returns **zero matches**. The three core tables were created once (`20260831170000`, plus `photo_cleanup_queue` in `20260901030000`) and every later migration only *adds* functions, constraints, or fixes bugs — never removes and re-adds a column.

2. **The most likely real source of the "did this come back?" feeling** is `DATABASE_PRACTICAL_PRIORITIES_REPORT.md`, which explicitly describes the photo-retention migration (`20260908112100_prepare_photo_retention.sql`) as *"ready but intentionally left unapplied."* We queried the live project's own migration ledger (`supabase_migrations.schema_migrations`) directly, and both that migration **and** its follow-up security fix (`20260911075700_secure_photo_cleanup_functions.sql`) are recorded as applied, and the functions exist and are correctly locked to `service_role` right now. If someone read that report, then separately looked at the live database or `\df` output and saw `purge_old_photo_storage_events` sitting there, it would look exactly like "a column/function that was supposedly removed has reappeared." **It didn't reappear — the report was simply wrong/stale**, written either before deployment or never updated after. This should be corrected in that report (see §13).

3. **A genuine look-alike, but not a duplicate:** `payment_attempts.pickup_photos` (jsonb, same shape as `orders.pickup_photos`) could easily be mistaken for redundant schema bloat if you only look at column names. It is not. It was added in the very first payment-reconciliation migration (`20260531080000_payment_reconciliation.sql:16`) as a **snapshot at the moment a payment attempt is created**, so that if the customer's order data changes (or gets cleared) before a delayed PayMongo webhook fires, the reconciliation function can restore the correct photos with `pickup_photos = COALESCE(attempt_row.pickup_photos, order_row.pickup_photos)`. This exact line appears, essentially unchanged, in **six** migrations across three and a half months, most recently `20260912184434_paymongo_refunds_and_failures.sql:540` — and it was actively hardened (not removed) on `2026-09-11` with a new `CHECK` constraint capping it at 3 photos. This is load-bearing payment-integrity logic, not leftover schema.

4. **A factual slip in an older audit**, not a code change: `CARGOEXPRESS_DATABASE_CLEANUP_AUDIT.md` refers to a function called `clean_up_abandoned_photos()` as an active cron target. That function name does not exist anywhere in the repository or the live database — the real functions are `trigger_scheduled_old_photo_cleanup()` and `trigger_photo_storage_health_check()`. This is worth a correction in that document so it doesn't cause future confusion, but it is not evidence of anything being dropped.

**Bottom line for your question:** nothing was actually removed and reintroduced. What happened is that internal documentation (a status report, an older audit) fell out of sync with a live database that was, in fact, moving forward correctly.

---

## 6. Admin Experience — Walking Through the Actual Page

Answering your specific questions, using the current `PhotoStorageTab.jsx` (742 lines) as it exists today, which — per `CARGOEXPRESS_MONITORING_PAGE_UX_AUDIT.md` — was already reworked once from a more technical, provider-parity layout:

| Question | Can the admin answer it today? | Where / how |
|---|---|---|
| How much storage is being used? | **Yes**, plainly. | "Storage Usage" card: `{percent}% used · {used} of {quota}` + a progress bar + a one-word status (Good/Getting Full/Action Needed) (PhotoStorageTab.jsx:449-473) |
| Which provider is being used? | Yes, but only if they open "Advanced" or "Technical Details" — the main view correctly hides this because it's rarely relevant | `showAdvanced`/`showTechnical` collapsibles, closed by default |
| Is there a storage problem? | **Yes** — a single badge (`Good`/`Getting Full`/`Action Needed`/`No Fixed Limit`/`Checking`) plus a plain-English sentence, computed in `overviewStatus` (PhotoStorageTab.jsx:388-411) | Top of "Storage Usage" card |
| Which photos are eligible for cleanup? | **Partially.** The automatic 6-month rule is explained in a static info banner (line 496-499: *"pickup and delivery photos are permanently removed once an order has been Delivered or Cancelled for more than 6 months... Receipt photos and photos featured on the public website are always kept."*). But the **manual** "Check Unused Photos" button uses a *different* eligibility rule (orphaned = no matching order at all — e.g., a deleted test booking) that is **never explained anywhere in the UI** — the button label and the confirm-modal text ("X unused photos were found") don't distinguish this from the automatic 6-month rule. An admin who has just read the "6 months" banner could reasonably assume the button does the same thing. See §10 for the fix (one sentence). | button at line 433-435; modal at 722-736 |
| What will happen if the admin clicks each action? | Yes for both actions: the "Save Choice" flow shows a confirm modal stating the exact effect and duration (line 709-720); the cleanup flow shows a **preview count and byte estimate before anything is deleted**, with an explicit "This cannot be undone" (line 722-736). This matches what the cleanup Edge Function actually enforces (a short-lived, signed confirmation token tied to that exact file list — a client can't retarget it, see §7). | ConfirmModal instances |
| Is cleanup pending, completed, or failing? | **Yes for the manual action** (toast + activity row immediately). **Partially for the automatic one** — completed/failing shows up in "Recent Photo Activity" the next day, but there's no "N photos currently queued for cleanup" indicator anywhere, even though that number exists (`photo_cleanup_queue` pending count is computed server-side inside `archive-expired-evidence-photos` but never exposed as its own reading — it's currently 0 in production so this hasn't mattered yet, see §3) | activity table |

### Per-element inventory (cards, counters, tables, filters, toggles, buttons)

| Element | Data source | Meaning | Plain-English? | Keep / Move / Remove |
|---|---|---|---|---|
| Live-status badge ("Live updates on" / "Reconnecting…" / "Offline") | Realtime channel state | Whether the page will update itself without a manual refresh | Yes | Keep, visible |
| "Check Unused Photos" button | `cleanup-orphaned-photos` preview | Runs the orphan scan | Mostly — see the eligibility-confusion note above | Keep, visible; add one clarifying sentence (§10) |
| Mode banner (Automatic / Backup Photos active) | `photo_storage_settings.upload_mode` | Which mode is live right now | Yes, already very clear | Keep, visible (this is exactly the kind of thing that should never be buried) |
| "Storage Usage" card (%, bar, status word, pickup/delivery/receipt counts) | `get_photo_storage_live_usage()` + `get_photo_storage_summary()` | The single "is everything OK" answer | Yes | Keep, primary/visible — this is the correct anchor of the page |
| Failures-last-24h banner | `summary.failures_last_24h` | Recent upload problems | Yes | Keep, conditional (already only shows when > 0) |
| "Automatic cleanup" info banner | static text | Explains the 6-month rule | Yes | Keep, visible — but see the duplicate-terminology note above |
| "Backup Photos" section | `get_photo_storage_summary()` + `photo-storage-health` (Firebase part) | Fallback provider stats | Yes, and already collapsed by default | Keep, collapsed |
| "Advanced: Where New Photos Are Saved" | `photo_storage_settings` | The force-Firebase override | Yes, and already collapsed with a "most admins will not need this" disclaimer | Keep, collapsed |
| "Recent Photo Activity" table | `photo_storage_events` (paged) | Audit trail of everything that happened | Yes, translated into plain sentences via `activityName`/`activityDetails` | Keep, visible |
| "Technical Details" section | `photo-storage-health` raw payload | Exact bytes, plan name, bucket breakdown, quota caveats | Deliberately technical, and already collapsed | Keep, collapsed — this is exactly where "optional technical details for troubleshooting" belongs, and it already exists |

**On your specific instruction to check for misleading percentages/partial counts:** the page already does this correctly and explicitly. The Technical Details footnote (PhotoStorageTab.jsx:680-692) states the plan-allowance figure is "the published quota... not a metered reading," flags when the Supabase organization has more than one project sharing the same allowance, and separately labels the Firebase figure as `estimated_photo_data_bytes` (never presented as a hard quota). The "database storage vs. photo/file storage" distinction is also handled correctly — this page only ever reports Supabase **Storage** (buckets), never Postgres database size, and says so.

**No misleading elements were found.** The one real wording/comprehension gap is the "Check Unused Photos" vs. automatic 6-month cleanup distinction described above.

---

## 7. Cleanup and Fallback Behavior — Verified

| Question | Answer | Evidence |
|---|---|---|
| How do photos become eligible for cleanup? | **Two independent mechanisms.** (1) *Orphan scan* (manual, admin-triggered): any evidence file under `pickup-proofs/`, `delivery-proofs/`, `receipts/` whose tracking-number folder matches no row in `orders` — `list_orphaned_evidence_photos()`. (2) *Scheduled archive* (automatic, daily 1:30 AM): any order `Delivered` or `Cancelled` with `terminal_status_at` (from `order_status_events`, not `orders.updated_at`) older than 6 months — `get_expired_evidence_orders()`. | migration `20260901020000`:50-85, 103-134; migration `20260901030000`:6-35 |
| Can cleanup affect active shipments? | **No.** The automatic path only selects `status IN ('Delivered','Cancelled')`; every other status (Pending, Assigned, In Transit, etc.) is excluded by definition. The manual orphan scan only touches files with *no* matching order at all. | `get_expired_evidence_orders` WHERE clause 🟢 |
| Are featured/public photos protected? | **Yes, at the eligibility query itself** — `AND COALESCE(o.featured_on_website, FALSE) = FALSE` is baked into `get_expired_evidence_orders()`, so a featured order's photos are never even considered for archival, regardless of age. Separately, `is_featured_photo_path()` gates public read access to exactly one photo per featured order via Storage RLS. | migration `20260901030000`:28 🟢 |
| Do Supabase and Firebase references stay consistent? | Yes — `archive-expired-evidence-photos` classifies every stored photo reference (`classifyPhoto()`, index.ts:71-116) and **skips the entire order** if any reference is unrecognized ("Never clear a row when a stored reference cannot be understood... keeping it visible is safer than claiming it was removed," index.ts:218-220) rather than guessing. Both providers' deletions are queued in the same `photo_cleanup_queue` table, processed in the same run. | archive-expired-evidence-photos/index.ts:203-246 |
| What happens if deletion succeeds on one provider but fails on the other? | Each queue row is tracked independently by `(provider, storage_path)`. A Supabase failure and a Firebase success (or vice versa) are recorded separately via `record_photo_cleanup_queue_result` — the failed one keeps `completed_at = NULL` and stays in the queue for the next run; the successful one is marked done. Nothing is lost or double-counted. | index.ts:257-319 |
| How do retries avoid losing pending work? | The order's `pickup_photos`/`delivery_photos` are cleared **only after** the files are durably queued (`queue_expired_evidence_cleanup`, in one transaction with the order update — index.ts:234-246), *before* any actual deletion is attempted. Actual Storage/Firestore deletion happens in a separate step reading from the queue, retried every day until `completed_at` is set. A crash mid-run simply leaves queue rows pending; nothing is deleted twice (the `UNIQUE(provider, storage_path)` constraint plus `ON CONFLICT DO UPDATE` in `queue_expired_evidence_cleanup` makes re-queuing idempotent). | migration `20260901030000`:150-166 (ON CONFLICT clause) |
| Do completed queue rows / old logs have retention? | **The functions exist (`purge_old_photo_cleanup_queue` 7 days, `purge_old_photo_storage_events` 30 days) and are correctly permissioned, but neither is ever called** — no cron job, no Edge Function invocation. See §8, this is the one confirmed reliability gap in the whole module. | `cron.job` 🟢 has no entry for either function; `grep -rn "purge_old_photo" supabase/functions/` = zero hits |
| Does retention use an appropriate timestamp? | Yes, by design: `purge_old_photo_cleanup_queue` filters on `completed_at` (not `queued_at`), so pending/failed/retrying rows are explicitly protected from deletion — only rows that finished successfully and then aged out are removed. | migration `20260908112100`:31-32 (comment) + WHERE clause |
| Do fallback controls / automatic switching work as described? | Yes — verified as a real Storage RLS enforcement, not just a UI toggle (see §2's boxed SQL). The 24-hour cap on `force_firebase_expires_at` and the auto-revert-to-automatic-with-a-logged-event behavior are both implemented, not just described. | `set_photo_storage_mode` (24h cap), `get_effective_photo_storage_mode` (auto-expiry + event log) |

**No cleanup jobs were executed and no photos were deleted or previewed with side effects during this review.**

---

## 8. Confirmed Bugs vs. Optional Improvements

### Confirmed bugs / gaps (evidence-backed, not speculative)

1. **Retention functions are prepared and secured but never scheduled.** `purge_old_photo_storage_events(30)` and `purge_old_photo_cleanup_queue(7)` exist live, are correctly locked to `service_role` only (`20260911075700`), but no `cron.job` row and no Edge Function anywhere calls either one. `photo_storage_events` (and, once real cleanup volume starts, completed `photo_cleanup_queue` rows) will grow without bound. **Impact today: low** (the events table is presumably still small), **but it is a real, unaddressed gap**, and the fix is a one-line cron addition, not a new feature (§12).
2. **`event_type = 'health_check'` is dead.** The CHECK constraint allows it, `PhotoStorageTab.jsx:58` has a UI label ready for it ("Storage check completed"), but no code path anywhere inserts it — `photo-storage-health`'s Edge Function only returns a JSON health payload and never writes to `photo_storage_events`. This is inert, not harmful, but it's worth knowing the constraint value is currently unreachable.
3. **`DATABASE_PRACTICAL_PRIORITIES_REPORT.md` is factually out of date** about the retention migration's deployment status (§3, §5) — should be corrected so it stops describing live functionality as unapplied.
4. **`CARGOEXPRESS_DATABASE_CLEANUP_AUDIT.md` names a nonexistent function** (`clean_up_abandoned_photos()`) — should be corrected to the real names.

### Optional improvements (not bugs — nothing here is broken)

5. The "Check Unused Photos" button doesn't explain how its eligibility differs from the automatic 6-month rule (§6) — a one-sentence clarification would remove the only real comprehension gap found on the page.
6. `photo_storage_events.created_by` is fetched (joined to `profiles(name, email)`) but never rendered in the activity table — cheap to add ("by Admin X") if you want more accountability visible without opening anything.
7. No pending-cleanup-queue count is surfaced anywhere in the UI, even though it's cheap to compute (`archive-expired-evidence-photos` already computes `filesPending` server-side every run). Currently moot (0 rows so far) but will matter once real 6-month-old orders start appearing.

---

## 9. Proposed Simplified Page Layout

Given that the page has already been through one simplification pass, this is **not a redesign** — it's confirming the current structure is right and naming the two small wording changes worth making. Existing design language (`.card`, `.admin-section-card`, `.badge-*`, collapsible `card-header` buttons) is reused as-is.

```
┌─────────────────────────────────────────────────────────┐
│ Photo Storage                          [● Live] [Check   │  ← unchanged
│ Check available space...               Unused Photos]    │
├─────────────────────────────────────────────────────────┤
│ ℹ Automatic photo saving is on. New photos saved to      │  ← unchanged
│   main storage; Backup used automatically only if needed.│
├─────────────────────────────────────────────────────────┤
│ Storage Usage                              [Good ▮]       │  ← unchanged — this
│ 42% used · 420 MB of 1 GB        580 MB left               │    IS the "clear storage
│ ▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░              │    summary + understandable
│ You have enough room for new photos.                       │    status" the brief asks for
│  Pickup Photos: 128   Delivery Photos: 121   Receipts: 96  │
├─────────────────────────────────────────────────────────┤
│ ℹ Automatic cleanup: pickup/delivery photos are removed    │  ← unchanged, but add:
│   once Delivered/Cancelled for 6+ months. Receipts and     │    "Use 'Check Unused Photos'
│   featured photos are always kept. This is permanent.      │    above to remove photos from
│                                                              │    cancelled test bookings that
│                                                              │    no longer exist — a
│                                                              │    different, smaller cleanup."
├─────────────────────────────────────────────────────────┤
│ ▸ Backup Photos · 4 in use                    [Live]       │  ← unchanged, collapsed
├─────────────────────────────────────────────────────────┤
│ ▸ Advanced: Where New Photos Are Saved · Automatic         │  ← unchanged, collapsed
├─────────────────────────────────────────────────────────┤
│ Recent Photo Activity                    Updates auto.     │  ← unchanged
│ [table: Date | Activity | Saved In | Status | What Happened]│  optionally add "By" column
│                                             [pagination]    │  using the already-fetched
├─────────────────────────────────────────────────────────┤   created_by/profiles join
│ ▸ Technical Details                                        │  ← unchanged, collapsed
└─────────────────────────────────────────────────────────┘
```

**What this keeps, hides, combines, or removes vs. today:** keeps everything. Hides nothing new (three sections are already collapsed). Combines nothing. Removes nothing. The only content change is one added sentence in the existing "Automatic cleanup" banner, and an optional "By" column in the already-existing activity table. **No new cards, no new buttons, no new admin decisions to make.**

**Configuration/business decisions this review does *not* invent an answer for** (per your instruction not to invent thresholds): the 80%/95% UI color breakpoints and the 85% backend notification threshold already exist in code and are left as-is; this review does not propose new ones. Whether `photo_cleanup_queue.attempts` should ever trigger a "give up and alert an admin" behavior is a real open question (see §13) — no number is proposed here because none currently exists in the code to report on.

---

## 10. Simplification Recommendations

### A. UI simplification

| Change | What's unnecessary | Evidence | Dependencies affected | Result | Data/capability lost | Risk vs. benefit |
|---|---|---|---|---|---|---|
| Add one clarifying sentence to the "Automatic cleanup" banner distinguishing it from "Check Unused Photos" | Nothing removed — this *adds* six words of copy | §6 finding | None — pure copy change in `PhotoStorageTab.jsx:498` | Admin no longer has to guess which cleanup does what | None | Zero risk, closes the only real comprehension gap found |
| (Optional) Add a "By" column to Recent Photo Activity using the already-fetched `created_by`/`profiles` join | Nothing — data is already fetched, just unrendered | database.js:3408 | None (no new query) | More accountability visible without opening a modal | None | Zero risk, but low urgency — nice-to-have |

**No other UI element should be removed, hidden further, or merged.** Every visible card/section was already checked against "does removing this lose a capability an admin needs" and passed — collapsing the technical/advanced sections further would hide information admins occasionally do need (e.g., during an actual outage), and the page already defaults them closed.

### B. Code simplification

**None recommended.** `src/lib/database.js`'s storage-monitoring functions (database.js:3379-3455, ~76 lines for 7 functions) are already minimal — each is a thin RPC/Edge-Function wrapper with no duplicated logic. The three Edge Functions (`photo-storage-health`, `cleanup-orphaned-photos`, `archive-expired-evidence-photos`) each do one distinct job (health/usage read, manual orphan cleanup, scheduled archive) and share only trivial helpers (CORS headers, `chunk()`, Firebase JWT signing) that would need to move to a shared module to dedupe — a refactor with real risk (three independently-deployed Deno functions, no shared build step per Edge Function architecture) for a readability gain only, not a behavior change. Not recommended unless you're touching these functions for another reason anyway.

### C. Database simplification

**No column or table removal is recommended.** Every column in the three core tables mapped to a live consumer in §4. Specifically or the two items that might *look* removable:

- **`photo_storage_events.event_type = 'health_check'`** (a CHECK-constraint *value*, not a column): technically removable since nothing writes it. **Recommendation: leave it.** Removing it from the CHECK constraint requires a migration for zero behavior change (it's already inert — allowing an unused value costs nothing), and the UI code that handles it (`PhotoStorageTab.jsx:58`) suggests it was intended to be wired up, not abandoned. If you want the health-check cron run to actually produce a visible "storage check completed" activity-log row (which would also make the queue-processing story more complete for the admin), that's a small **feature completion**, not a cleanup — see §12.
- **`payment_attempts.pickup_photos`**: looks redundant with `orders.pickup_photos` by name alone. **Do not remove or consolidate** — §5 shows this is live, hardened, and actively read by payment reconciliation logic across six migrations. Removing it would break the ability to recover a customer's pickup photos if a GCash payment confirmation arrives after the order record was already changed.

### The one database action actually worth taking: schedule the two purge functions

This is a **reliability fix**, not a simplification, but it belongs here because it's the report's single highest-value database-layer recommendation. See §12 for the concrete step.

---

## 11. Changes That Should NOT Be Made

- **Do not drop `photo_storage_settings`, `photo_storage_events`, or `photo_cleanup_queue`**, or consolidate them into one table. Each has a distinct write pattern (singleton config vs. append-only log vs. mutable retry queue) and distinct, already-correct RLS/grant postures; merging them would either weaken the settings table's lockdown or bloat the append-only log with mutable retry state.
- **Do not remove `payment_attempts.pickup_photos`** — see §5, §10-C. This would silently break payment-reconciliation photo recovery for the retry-payment path.
- **Do not remove `orders.featured_on_website`/`featured_image_type`/`featured_at`** dependencies from the cleanup eligibility query — this is the featured-photo protection mechanism itself.
- **Do not move `photo_cleanup_queue`'s retry state (attempts, completed_at, last_error) into an Edge Function's memory or a stateless design.** Per your own instruction, this is exactly the kind of durable retry state that must survive a crashed/redeployed function — it already correctly lives in the database and should stay there.
- **Do not "fix" the schema.sql staleness (§3) by hand-editing it.** It's a generated/snapshot file; the correct fix is regenerating it from the live/migrated schema (or documenting that it's known to lag), not manually retyping the missing function definitions in a way that could drift again.
- **Do not treat the 0-row `photo_cleanup_queue` as evidence it's unneeded.** Per your own instruction not to assume zero rows means unnecessary: this table has zero rows because no order has yet crossed the 6-month cutoff in this project's data (the app appears to be a few months old), not because the mechanism is broken or unused — its wiring (cron job, RPCs, RLS) is fully live and correct.

---

## 12. Prioritized Implementation Plan

| # | Priority | Action | Why | Effort |
|---|---|---|---|---|
| 1 | **High** | Add a cron job (or extend `trigger_scheduled_old_photo_cleanup()`) to call `purge_old_photo_storage_events(30)` and `purge_old_photo_cleanup_queue(7)` on a schedule (e.g., weekly) | The only confirmed reliability gap — these functions exist, are secured, and do nothing today | Small — one `cron.schedule(...)` migration |
| 2 | **Medium** | Correct `DATABASE_PRACTICAL_PRIORITIES_REPORT.md`'s "intentionally left unapplied" claim about the retention migration, and `CARGOEXPRESS_DATABASE_CLEANUP_AUDIT.md`'s reference to the nonexistent `clean_up_abandoned_photos()` | Both are the most plausible source of "did something come back" confusion; leaving them uncorrected will keep producing false alarms in future audits | Trivial — doc edits |
| 3 | **Medium** | Regenerate/resync `supabase/schema.sql` so it includes the two purge functions (and, ideally, add a note near the top of that file about how/when it's regenerated) | Closes the live-vs-repo gap found in §3 so the next person doesn't have to re-derive it from `supabase_migrations.schema_migrations` by hand | Small |
| 4 | **Low** | Add one sentence to the "Automatic cleanup" banner distinguishing it from "Check Unused Photos" (§10-A) | Removes the one real UI comprehension gap found | Trivial — copy change |
| 5 | **Low** | Either wire `event_type = 'health_check'` up to actually log something from the scheduled health check, or leave it — no action required either way | Currently inert but harmless; only worth doing if you want the activity log to show "storage check completed" entries from the 4×/day cron | Small, optional |
| 6 | **Low** | Surface `created_by` (admin name) in the Recent Photo Activity table | Data is already fetched; currently wasted | Trivial |

Nothing above requires a schema migration that removes data, and nothing above changes the page's information architecture.

---

## 13. Unverified Areas and Specific Follow-Up Checks

- **`payment_transactions.receipt_url` full column definition** (type/constraints beyond its use in `get_photo_storage_summary()`) was not pulled in detail — it's outside this module's three core tables and was only confirmed as a *read* dependency. Follow-up: `\d payment_transactions` if a future review touches payment receipts specifically.
- **Where exactly `record-photo-storage-event` (the Edge Function that logs individual upload success/failure) is called from** was not traced into the actual photo-upload UI flow (`photoReference.js`/`storage.js`, mentioned in `CLAUDE.md` as related modules but out of this module's direct scope) — confirmed the Edge Function exists and is admin-gated, but not which upload code path invokes it or under what conditions it's skipped.
- **`photo_cleanup_queue.attempts` has no observed cap or give-up behavior** — worth a deliberate decision (not invented here, per your instruction not to invent thresholds): should a file that's failed N times stop retrying and instead alert an admin? Today it will retry forever, silently, inside the daily cron run. This is a business decision, not a code defect — flagging it as something to decide, not something broken.
- **`scripts/photo-storage-monitoring-contract-test.mjs` coverage confirmed to include the retention functions? No** — it asserts against 4 migrations and does not reference `20260908112100_prepare_photo_retention.sql` or `20260911075700_secure_photo_cleanup_functions.sql` at all, meaning the retention functions have zero automated regression coverage. (Correction to note: this test **is** part of the default `npm test` chain per `package.json:8` — an earlier internal pass at this research mis-stated it as excluded; confirmed directly against `package.json`.)
- **Whether `store-photo-fallback`/`get-photo-fallback`/`delete-photo-fallback` (the three Firebase-fallback CRUD Edge Functions) have their own retention or orphan-cleanup story** was not investigated in depth — they're part of "Firebase fallback integration" per your scope list, but the actual upload-time fallback path (as opposed to the monitoring/cleanup path reviewed here) is a large enough area (205+185+131 lines) to warrant its own pass if you want it covered as thoroughly as the monitoring path was here.
- **Production data volumes**: this review confirms `photo_cleanup_queue` has 0 rows and infers `photo_storage_events` is likely still small (both from index-usage stats, not a direct row count) — an actual `SELECT count(*)` on `photo_storage_events` was not run and would be a cheap, genuinely read-only follow-up if you want a precise sense of how urgent the retention gap (§8, item 1) really is.

---

## 14. Closing Answers

1. **Are there genuinely unnecessary tables or columns?** No. Every column in `photo_storage_settings`, `photo_storage_events`, `photo_cleanup_queue`, and the related columns on `orders`/`payment_attempts` maps to a live reader (a function, an RLS policy, a UI element, or a CHECK constraint). The one genuinely idle thing is a constraint *value* (`event_type = 'health_check'`), not a column, and it's cheap to either leave alone or wire up (§8, §12).

2. **Did any removed fields actually return?** No column was ever dropped and re-added — confirmed against full migration and git history. The impression likely comes from a stale internal report (`DATABASE_PRACTICAL_PRIORITIES_REPORT.md`) claiming the photo-retention migration was "unapplied," when the live database proves it was applied and even further secured days later (§5).

3. **Can the admin page be simpler without changing the schema?** It's already close to as simple as it can get — a prior UX pass already collapsed the technical detail into three closed-by-default sections and replaced provider-parity stat tiles with plain pickup/delivery/receipt counts. The only remaining simplification is a one-sentence copy fix distinguishing the two cleanup mechanisms (§10-A). No schema change is needed or recommended for this.

4. **What are the highest-value changes?** (1) Schedule the two prepared-but-dormant retention/purge functions so operational logs don't grow forever (§8, §12 #1) — the single concrete reliability gap found. (2) Correct the two prior reports with stale/incorrect claims about this module, since they're the most likely source of confusion about "reintroduced" schema (§12 #2).

5. **Where is the saved report?** This file: `STORAGE_MONITORING_SIMPLIFICATION_REVIEW.md` in the project root.
