# Storage Monitoring — Folder Browser Redesign

Implements (not just proposes) the three-column booking-folder browser and the corrected
manual-deletion rule, replacing the flat "All Photos / Can Be Deleted / Still Needed" gallery from
`STORAGE_MONITORING_SIMPLIFICATION_IMPLEMENTATION.md`, informed by the follow-up
`STORAGE_MONITORING_POST_CHANGE_AUDIT.md` (which flagged the anon-grant gap and the undeployed
`cleanup-orphaned-photos` leftover this task also addresses).

---

## 1. What changed

| Layer | Before | After |
|---|---|---|
| Admin UI | Flat photo grid with All/Can Be Deleted/Still Needed tabs, a badge on every card, a long retention sentence on every card | Three-column booking-folder browser (Cargo Photos) + a simpler group browser (Company Images), a Cargo Photos/Company Images selector, one concise banner explaining the two separate rules |
| Manual deletion rule | A Delivered/Cancelled booking's photos were undeletable by an admin for 6 months | An admin can delete an eligible photo from a Delivered/Cancelled booking **immediately**, with confirmation — no wait |
| Automatic cleanup rule | 6 months after Delivered/Cancelled, unattended | **Unchanged** — still 6 months, still fully separate code (`get_expired_evidence_orders`/`archive-expired-evidence-photos`), never touched by this task |
| New protection | — | A pickup photo currently referenced by a **pending/chargeable** (not yet reconciled) `payment_attempts` row is protected; a **reconciled/failed** one never blocks anything |
| DB functions | `list_evidence_photos()` (flat, paginated, filtered) | `list_evidence_folders()` (left column), `list_folder_photos()` (middle column), both built on a new shared `evidence_photo_rows()`; `list_evidence_photos()` is dropped |
| `delete_evidence_photos()` | Rejected anything less than 6 months post-Delivered/Cancelled | Same signature, same re-verification pattern, 6-month check removed, pending-payment check added |
| Grants | `list_evidence_photos`/`delete_evidence_photos` had an unintended `anon` EXECUTE grant (flagged in the prior audit) | Every new/replaced function explicitly `REVOKE ALL ... FROM anon` — fixed |
| Company Images | Not covered by the admin gallery at all | Own tab, grouped by the bucket's own existing folders (`banner`, `hero`, …), deletion gated on "is this the live site banner" |
| `cleanup-orphaned-photos` / `list_orphaned_evidence_photos()` | Still deployed/live, unused by the app (per the prior audit) | **Unchanged in this task** — still deployed, still not dropped; see §8 for the required removal order, which this task does not perform |

---

## 2. Desktop behavior

Three columns, always visible side by side (`grid-template-columns: 260px minmax(260px,1fr)
minmax(280px,1.15fr)`), never collapsing into a full-width card grid:

- **Left — booking folders.** One row per tracking number (customer name + shipment status as
  secondary text), plus one virtual **"Photos Without Bookings"** row pinned last for files with no
  matching order. A compact search box filters by tracking number; folders are visible with no
  search typed. Paginated (20/page) via the existing `Pagination` component.
- **Middle — the selected folder's photos.** Compact rows: checkbox, thumbnail, type
  (Pickup/Delivery/Receipt evidence — labeled per row, no extra nested navigation to see which is
  which), date, size. A protected row shows its reason inline instead of a checkbox. "Select all
  eligible" operates **only on what's currently loaded** (see §6) — it never reaches into an
  unfetched page. Clicking a row opens it on the right.
- **Right — preview.** The image at a useful size (`object-fit: contain`, not stretched or cropped),
  type/tracking reference/date/size, a "Delete This Photo" button (hidden, replaced by the reason,
  when protected), and a plain empty-state placeholder before anything is selected. A failed/missing
  image shows a warning icon and "This photo could not be loaded" instead of a broken image.

Folder selection, the loaded photo list, and the preview all stay in sync: deleting a photo removes
it from the middle-column list and clears the preview if it was the one open, then refreshes both
the folder list (so its counts stay accurate) and the current folder.

## 3. Mobile behavior

Below 900px, the same three DOM nodes collapse into sequential full-width panes — **Folders →
Photos → Preview** — via a single CSS mechanism: a `data-pane` attribute on the wrapper (derived
purely from React state: `preview selected ? 'preview' : folder selected ? 'photos' : 'folders'`)
that a media query uses to show only the matching pane. All three panes stay **mounted** at all
times; only their CSS visibility changes. This was a deliberate choice over conditionally
unmounting/remounting panes: it means switching panes on mobile never resets scroll position,
never re-fetches, and never loses in-progress selection — "Back" (shown only below the breakpoint)
just clears the deeper selection and the previous pane reappears exactly as it was. This mirrors
the same list/detail collapse pattern already used by the admin Inbox
(`chat-inbox.css`'s `.inbox-layout.has-active-conv`), applied here with a three-level rather than
two-level stack.

## 4. Exact manual-deletion and automatic-cleanup rules

**Manual deletion** (`delete_evidence_photos()`, re-derived from scratch on every call, never
trusting the caller): a pickup/delivery photo is eligible **immediately** once its booking is
`Delivered` or `Cancelled`, unless:
- it is a **receipt** (always protected — financial record);
- the booking is **featured on the public website** (always protected);
- the booking's status is **not yet** `Delivered`/`Cancelled` (active shipment — always protected);
- **[new]** the photo is currently referenced by a `payment_attempts` row whose `status` is
  `pending` or `chargeable` (not yet reconciled) — protected with the reason "A payment for this
  booking is still being reconciled." A `reconciled` or `failed` attempt referencing the same photo
  never blocks anything — it's pure history.

**Automatic cleanup** (`get_expired_evidence_orders()` → `archive-expired-evidence-photos`,
untouched by this task): still fires **only** 6 months after a booking's `Delivered`/`Cancelled`
status was set, for whatever pickup/delivery photos an admin has **not already** deleted manually
in the meantime, with the same receipt/featured protections it already had. The two paths share no
code — verified by grep (the new migration never calls `get_expired_evidence_orders`, and
`archive-expired-evidence-photos` never calls `list_evidence_folders`/`list_folder_photos`/
`delete_evidence_photos`) and asserted in the contract test.

**Photos without bookings**: eligible once re-verified at execution time that no order now matches
the tracking-number folder (a booking created since the file became orphaned blocks it, with the
reason "A booking now matches this photo — it is no longer unused").

## 5. Remaining protected cases (unchanged, not relaxed)

- Receipts — always.
- Photos featured on the public website — always.
- Active-shipment (not yet Delivered/Cancelled) pickup/delivery evidence — always.
- **[new]** Photos tied to an unresolved payment reconciliation — see §4.
- Company Images: the file currently set as `company_information.banner_image_url` — see §6.
- Booking and payment records themselves are never touched by any deletion path — only the
  `pickup_photos`/`delivery_photos` array element (or the file for Company Images) is removed;
  `delete_evidence_photos()` never issues `DELETE FROM orders` or `DELETE FROM payment_transactions`
  (asserted in the contract test).

## 6. Company Images (`company-assets` bucket)

Kept deliberately lighter, per the task's own framing ("use existing meaningful groups or actual
folders... a simple selector if needed"):
- **No new listing RPC.** Admins already have full `SELECT`/`DELETE` on `company-assets` via the
  existing `"Admins manage company assets"` `FOR ALL` storage policy (`20260804180000`), so the
  browser calls the Storage SDK's `list()` directly — real, existing top-level folders (`banner`,
  live today; `hero`/`gallery`/`timeline` if ever populated) become the left column with zero
  invented structure.
- **One new RPC**, `check_company_asset_deletable(p_paths)`: the one thing the browser cannot
  safely decide client-side — whether a path is `company_information.banner_image_url` right now —
  re-verified server-side both when the folder is opened (to grey out the checkbox) and again
  immediately before the actual `storage.remove()` call. Everything else in this bucket is small
  website decoration with no per-booking structure to protect.
- **Explicit, honest limitation**: only `banner_image_url` is a verifiable "in use" signal this
  codebase can check (confirmed — it's the only image-reference column on `company_information`,
  and `CompanyInformationPage.jsx`'s only live upload path is `banner/<field>.jpg`). A file the
  check doesn't recognize as the banner is deletable, but nothing in this codebase claims to verify
  every possible external reference to it — this is stated in the function's own comment rather than
  silently assumed safe.

## 7. Duplicate-payment / duplicate-deletion protections carried forward unchanged

- Idempotent queue upsert (`ON CONFLICT (provider, storage_path) DO UPDATE`) — a retried or
  double-clicked delete of the same photo re-queues, never duplicates.
- Order row locked (`FOR UPDATE`) before the `pickup_photos`/`delivery_photos` array is rewritten,
  and only the one matching `(provider, storage_path)` element is removed — a concurrent edit can't
  be silently clobbered, and array position is never trusted.
- Orphan claims are re-verified against **live** `storage.objects`/`orders` at execution time, not
  trusted from an earlier list read.
- The confirm dialog (shared by single-photo and bulk delete) shows: exact count, estimated space
  freed (when every selected item's size is known), that deletion is permanent, and that booking/
  payment records remain — only the photo evidence stops being available.

## 8. Database objects — kept, changed, and NOT removed (with reasons)

Per the prior audit ("no removable tables or columns... do not force schema deletion"), re-verified
for this redesign:

**Unchanged, all columns still load-bearing:** `photo_storage_settings` (RLS enforcement point for
upload routing, operator safety valve), `photo_storage_events` (audit log, now-scheduled 30-day
purge), `photo_cleanup_queue` (durable retry queue for the actual provider deletion step, now-
scheduled 7-day purge of completed rows). Nothing about the folder-browser redesign changes what
depends on any of these.

**Dropped:** `list_evidence_photos(text, text, integer, integer)` — superseded by
`list_evidence_folders`/`list_folder_photos`; confirmed by repo-wide grep before writing the
migration that nothing outside the files this task also rewrote (the old `PhotoStorageTab.jsx`, the
old `database.js` wrapper, the old contract test — all updated) called it. Safe to drop in the same
migration as its replacement because, unlike the item below, there is no separately-deployed process
still calling it.

**Added:** `evidence_photo_rows()` (internal, not granted to any client role — called only by the
two functions below, running as its `SECURITY DEFINER` caller), `list_evidence_folders()`,
`list_folder_photos()`, `check_company_asset_deletable()`.

**Changed in place (same signature):** `delete_evidence_photos(jsonb)` — eligibility logic only, per
§4; explicit `REVOKE ... FROM anon` added.

**NOT removed, left exactly as the prior audit found them, because removing them requires a live
action this task does not perform:**
- `cleanup-orphaned-photos` (Edge Function) — **re-verified still `ACTIVE` (version 6) on the live
  project** as of this task (checked via `supabase functions list`), unchanged since the prior
  audit. Nothing in the current codebase calls it.
- `list_orphaned_evidence_photos()` (SQL function) — its only live caller is that same stale
  edge function. **Left in place in this migration**, per the task's own explicit ordering
  requirement: the edge function must be undeployed first, or dropping this function would turn a
  harmlessly-unreachable stale endpoint into an actively-erroring one.
- **Required order, still awaiting your approval to execute:**
  1. `supabase functions delete cleanup-orphaned-photos --linked` (or remove it via the dashboard).
  2. A follow-up migration: `DROP FUNCTION IF EXISTS public.list_orphaned_evidence_photos();`

**No new table.** A "folders" table was considered and rejected — every folder-grouping field
(tracking number, customer name, order status, photo counts, sizes) already exists as either a
direct `orders` column or something computed from the photo arrays themselves; grouping it in SQL
(`GROUP BY tracking_number`) is a normal query, not a missing piece of schema.

## 9. Photo inventory gaps — resolved and still outstanding

**Resolved / already correctly handled** (verified, not assumed):
- **Images whose booking was deleted**: the `"Photos Without Bookings"` folder (§2) — the same
  `NOT EXISTS (SELECT 1 FROM orders WHERE tracking_number = ...)` matching logic the previous
  gallery already used, now paginated (up to 200/page) instead of unbounded, since a bulk data reset
  is exactly the scenario that could make this folder large.
- **Legacy/fallback references**: `classify_evidence_photo_ref()` (unchanged, reused verbatim) still
  handles current-shape descriptors, legacy raw-string paths, legacy Firestore-fallback strings, and
  double-encoded JSON strings — so a booking folder's middle column shows Firebase-fallback-stored
  pickup/delivery photos alongside Supabase-stored ones automatically, with no separate "fallback"
  view or provider-specific UI.
- **Photos referenced only by `payment_attempts`**: now an explicit, tested protection (§4) rather
  than an unexamined category.

**Still outstanding — a real, pre-existing gap, not introduced or worsened by this task, and out of
this task's scope to fix** (documented, not silently ignored): a storage object referenced **only**
by a *superseded* `payment_attempts` row (e.g., a customer's first GCash attempt uploaded photos,
went unreconciled, and a second attempt/cash payment used different photos) is invisible to both the
old orphan scan and this new browser — it's neither "referenced" (not in the order's current
`pickup_photos`) nor "orphaned" (the order still exists, so the tracking-number match hides it). This
was independently confirmed identical in the *original* `list_orphaned_evidence_photos()` logic
(same `NOT EXISTS` match by tracking number only), so it predates this task. It is a storage-
accounting **completeness** gap (a small number of superseded photos may sit uncounted, never
reachable through any admin UI), never a **safety** issue — nothing this gap describes can ever be
wrongly deleted, because the browser simply never shows it as either type.

**Total storage vs. displayed cargo photos**: the Storage Usage card's "space used" figure is a live
count of **every object in the bucket** (including the above superseded-attempt leftovers, if any
exist); the folder browser's photo counts only ever total what's classified as referenced or
orphaned. The usage card's own copy says so explicitly ("measured live across all files... cargo
photos and website images"), rather than implying the two numbers must reconcile exactly.

## 10. Tests performed and actual results

All testing used **disposable, synthetic records** against a real embedded Postgres
(`@electric-sql/pglite`) with the **actual, unmodified** migration files applied verbatim, per this
repo's established pgtest convention. No real customer data or live database was touched, and no
live deploy/undeploy was performed.

**`npm run test:photo-gallery`** (`scripts/photo-gallery-pgtest/`, rewritten for this task) —
**47/47 assertions passed**, covering:
- Folder listing: one row per tracking number with customer name/status, the eligible-vs-total
  photo count distinction, the unbooked catch-all folder, search, pagination with `total_count`.
- Folder photo listing: a Delivered booking's pickup photo is eligible **immediately** (explicitly
  asserted the reason text no longer mentions "6 month"), receipt/featured/active-shipment still
  protected, the pending-vs-reconciled `payment_attempts` distinction (both directions — a pending
  attempt blocks, a reconciled one on a *different* order does not), the unbooked folder correctly
  lists an orphan and never leaks a still-referenced file into it.
- Deletion: the same re-verification battery as the prior implementation (receipt/featured/active-
  shipment rejection, stale-path rejection, nonexistent-booking rejection, orphan re-verification
  against live storage/orders, idempotent re-queue for double-click/retry safety, a mixed
  eligible+protected batch returning one outcome per item) **plus** the new positive case (immediate
  manual deletion, no wait) and the new pending-payment rejection/acceptance pair.
- **Unauthorized access**: both an anonymous session and an authenticated-but-non-admin (customer)
  session rejected for `list_evidence_folders` and `delete_evidence_photos`.
- Company Images: the live-banner path correctly blocked (with its cache-busting query string
  stripped for comparison), an unrelated file correctly allowed, non-admin rejected, empty selection
  rejected.

**Existing suites re-run, all green, no regressions:**
- `npm test` (full 21-script default chain, including the rewritten
  `photo-storage-monitoring-contract-test.mjs`, which now asserts the new grants, the dropped
  function, the removed 6-month wait, the new pending-payment protection, and the presence of the
  three-column CSS).
- `npm run test:edge-functions` (18 functions build) — `delete-storage-photos` and
  `archive-expired-evidence-photos` are unchanged by this task and still build.
- `npm run build` — production build succeeds.
- `node scripts/token-lint.mjs`, `node scripts/axe-lint.mjs` — pass (no new undefined CSS tokens, no
  new accessibility issues).
- `supabase db push --dry-run` against the live linked project confirms the new migration is
  recognized as the one pending, unapplied change — a syntax/reference sanity check beyond the
  pgtest suite, though it does not execute the SQL (no shadow database available in this
  environment; see gaps below).

## 11. Local vs. deployed status

**Local only — not yet applied to the live database or deployed:**
- `supabase/migrations/20260915110000_photo_storage_folder_browser.sql` — written, dry-run-validated
  against the live schema, and locally tested via pgtest. **Not pushed.**
- The rewritten `PhotoStorageTab.jsx` / `database.js` / CSS — committed locally, not built-and-
  deployed as a live SPA update.

**Unaffected, confirmed unchanged on the live project:** `delete-storage-photos` (still `ACTIVE`
v1), `archive-expired-evidence-photos`, `photo-storage-health`, `record-photo-storage-event` — this
task deploys no Edge Function changes at all.

**Confirmed still live and unaddressed** (re-checked via `supabase functions list` during this
task, not assumed from the prior audit): `cleanup-orphaned-photos`, still `ACTIVE` version 6.

## 12. Live actions awaiting your approval

1. `supabase db push` — applies `20260915110000_photo_storage_folder_browser.sql`.
2. Deploy the rewritten frontend (`npm run build` + your normal SPA deploy step) — the new page only
   works once both the migration and the frontend are live together (the RPC names changed).
3. `supabase functions delete cleanup-orphaned-photos --linked` (or via dashboard) — then, as a
   **separate, later** migration: `DROP FUNCTION IF EXISTS public.list_orphaned_evidence_photos();`.
   Deliberately not bundled into this migration — see §8's ordering requirement.

## 13. Verification gaps — stated explicitly

- **No browser/live rendering was verified.** The three-column desktop layout, the mobile
  folder→photos→preview collapse, the empty/error preview states, and the Company Images tab were
  all checked by code review, the pgtest suite (SQL correctness only), and the build/lint pipeline
  — not by opening the page in an actual browser. This needs a staging environment.
- **No live end-to-end deletion** was performed against real Supabase Storage or Firestore —
  disallowed by the task without separate approval, and consistent with using disposable records
  only.
- **`supabase db push --dry-run`** confirms the migration is recognized and pending; it does not
  execute the SQL against a shadow database (none is available in this environment), so it is not a
  substitute for the pgtest suite's actual execution — both were used together deliberately.
- **Concurrent-connection races** (e.g., two admins deleting overlapping photos from the same folder
  at once) are covered by the same row-locking mechanism already relied on elsewhere in this
  codebase, but were not driven with two simultaneous live connections in this task's testing.
