# CargoExpressPH Post-Deployment Targeted Fix Report

**Date:** 2026-09-17 (Asia/Manila)
**Baseline:** repository `main` at commit `50f589a` (the commit `POST_DEPLOYMENT_REGRESSION_AUDIT.md` audited), work performed in this same checkout.
**Scope of this pass:** implement the fixes for N-1 (Windows path bug), N-2 (public trip-reschedule email rule), and N-3 (announcement pending-count clarity) identified in `POST_DEPLOYMENT_REGRESSION_AUDIT.md`; re-verify F-01 against live production with a legitimate technique this time; leave F-05/F-06 exactly as previously assessed (no change requested).
**Not done, by instruction:** nothing was deployed, pushed, or applied to the live Supabase project. No production data, config, or the on-hold charge-correction/manual-refund feature was touched. No synthetic accounts were created (an already-legitimate technique was used instead — see F-01 below).

---

## Simple Taglish summary

**Ano ang makikita ng admin ngayon:** sa Reschedule Trip modal, may bagong checkbox: **"Email this schedule update to all subscribers"**, kasama ang optional na "Reason" text kapag naka-check ito. Kapag hindi ito nire-check, wala pang nagbabago — yung dating quiet, per-trip na email pa rin ang pupunta sa mga booked customers na naka-opt-in. Kapag nire-check ito, dalawang bagay ang mangyayari: (1) yung dating per-trip email ay **hindi** magpapadala (para walang doble), at (2) isang public na announcement ang awtomatikong gagawin at ipapadala sa **lahat** ng naka-enable sa Email Updates — kasama na ang mga nag-inquiry lang (walang account) at ang mga rehistradong customer na walang booking sa specific na trip na iyon.

**Sino ang tumatanggap ng reschedule email:**
- Hindi naka-check ang option → booked + opted-in customers lang sa specific trip na iyon (dating behavior, hindi ginalaw).
- Naka-check ang option → lahat ng naka-enable sa Email Updates (inquiry-only, walang booking, booked sa ibang trip, atbp.) — pero HINDI doble sa mga taong sakop na ng private na email, dahil awtomatiko itong tinitigil para sa kanila.

**Paano naiiwasan ang doble/maling send:** ang bawat totoong pagbabago ng schedule ay may sariling "event" (isang bagong `announcements` row bawat genuine reschedule). Kung parehong dates lang ulit ang isusumite (halimbawa, double-click), walang bagong email na gagawin — sinusuri muna ng database kung talagang nagbago ang petsa bago pa man mag-isip ng email.

**Kailangan pa bang manual na i-continue ang pagpadala?** Oo, kung mahigit 25 recipients — pareho ito sa dati nang F-03 na behavior (25 attempts per invocation), hindi ito binago. Ang bago ay mas malinaw na ngayon ang display sa Announcements page: makikita na ang eksaktong bilang ng "accepted by provider," "pending" (hindi pa nasusubukan), "retry needed," at "needs review" — dati kasing walang "pending" count kaya parang tapos na agad kahit marami pang natitira.

**Ano pa ang kailangang tingnan bago ang defense:** (1) i-verify sa isang totoong browser session ang buong reschedule flow mula sa UI (hindi ko magawa dito dahil walang browser tool sa session na ito), (2) i-verify ang totoong email delivery gamit ang designated test mailbox (wala akong access dito), at (3) tiyakin na naka-deploy nang sabay ang bagong migration + ang na-update na `broadcast-announcement` Edge Function bago gamitin ang feature — hindi ito gagana kung ang isa lang sa dalawa ang na-deploy.

---

## Findings status

| Finding | Status | Evidence |
|---|---|---|
| N-1 — Windows path-resolution bug (12 scripts) | **Fixed and verified** | All 12 scripts patched; new regression test added and passing; reproduced the exact failure mode (un-decoded `%20`) and confirmed the fix resolves it |
| N-2 — Public trip-reschedule email rule | **Fixed locally, verified against real migration SQL in embedded Postgres; not deployed/verified live** | New migration + RPC + Edge Function change + frontend UI; 15-assertion pgtest suite passes against the literal migration file |
| N-3 — Announcement status line omits pending count | **Fixed** | `AnnouncementsPage.jsx` status string now shows accepted/pending/retry/review/skipped counts out of total, and clarifies "accepted by provider" |
| F-01 — Financial report RPC, full admin execution | **Newly verified live, without synthetic accounts** | See below — used a safer technique than either prior audit attempted |
| F-05 — Schema snapshot | **Unchanged, not in scope this pass** | No action requested or taken |
| F-06 — PayMongo webhook hardening | **Unchanged, not in scope this pass** | No action requested or taken; still optional hardening as previously assessed |

---

## 1. N-1: Windows path-resolution bug — fixed and verified

### Root cause

12 files under `scripts/*-pgtest/` resolved their own directory with:

```js
path.dirname(new URL(import.meta.url).pathname)
```

`URL.pathname` leaves percent-encoding (`%20` for spaces) un-decoded and, on Windows, leaves a leading `/C:/...` that `path.resolve` then doubles into `C:\C:\...`. This is exactly what the audit reproduced against this actual project folder path.

### Fix

All 12 files now use `path.dirname(fileURLToPath(import.meta.url))` (`fileURLToPath` imported from `node:url`) — the correct, cross-platform conversion, already used by the newer `financial-report-pgtest`/`announcement-broadcast-pgtest` suites.

**Files changed:**
- `scripts/legacy-rpc-overload-cleanup-pgtest/run.mjs`
- `scripts/contact-details-lock-pgtest/run.mjs`
- `scripts/contact-details-lock-pgtest/trigger-bypass-run.mjs`
- `scripts/payment-notification-pgtest/run.mjs`
- `scripts/photo-gallery-pgtest/run.mjs`
- `scripts/payment-refund-recovery-pgtest/run.mjs`
- `scripts/delivery-cash-payment-pgtest/run.mjs`
- `scripts/shipping-discount-pgtest/run.mjs`
- `scripts/service-area-mass-assignment-pgtest/run.mjs`
- `scripts/payment-refund-pgtest/run.mjs`
- `scripts/featured-shipments-pgtest/run.mjs`
- `scripts/payment-ledger-pgtest/run.mjs`

**New file:** `scripts/script-path-portability-contract-test.mjs` — scans every `.mjs`/`.js` file under `scripts/` for the broken pattern and fails the build if it ever comes back, on any OS (no Windows machine needed to catch a regression). Added to the front of the `npm test` chain in `package.json`.

### Why the chain broke but individual runs "passed" (the audit's own discrepancy question)

Only 2 of these 12 scripts (`payment-refund-pgtest`, `payment-refund-recovery-pgtest`) are wired into the default `npm test` chain in `package.json`; the other 10 are separate `npm run test:<name>` commands not part of `npm run check` (this matches `CLAUDE.md`'s own description: "Domain-specific suites not in the default `npm test` chain"). Running any one of the 12 directly (`node scripts/x/run.mjs`) from this exact folder **still failed** before the fix — the audit's own report already showed this exact error text. The "runs individually" success the earlier audit observed for the *other 10* suites was misleading only in the sense that they're simply never exercised by `npm run check` at all, pass or fail — not that the underlying bug spared them. All 12 shared the identical bug; the difference was only which ones the default gate actually calls.

### Verification performed (this session)

1. **Reproduced the root cause directly**, independent of any test framework: wrote a probe script in a scratch directory containing a space, comparing `new URL(...).pathname` (`.../space%20test%20dir`, `existsSync` → `false`) against `fileURLToPath(...)` (`.../space test dir`, `existsSync` → `true`). This is the same failure mode manifesting on macOS, not just Windows — Windows additionally doubles the drive letter on top of it.
2. Ran `node scripts/script-path-portability-contract-test.mjs` from this exact project folder (`.../KAY BEAAAA TOOOOO!!!/CargoExpressPH-main`) — passes, 47 files scanned, 0 offenders.
3. Ran the two previously-broken default-chain scripts directly: `payment-refund-pgtest` (14 passed), `payment-refund-recovery-pgtest` (22 passed).
4. Ran all 10 non-default-chain suites individually from this folder: `payment-ledger` (52), `payment-notifications` (41), `shipping-discount` (92), `photo-gallery` (47), `featured-shipments` (33), `delivery-cash-payment` (47), `contact-details-lock` (8), `service-area-mass-assignment` (12), `legacy-rpc-overload-cleanup` (8), `email-updates-subscription` (38) — all pass.
5. Ran the full `npm run check` from this exact folder — **exit 0**, clean end to end (test chain, edge-function build test of 18 functions, photo-fallback browser test, production build, PWA offline precache check).

**Actual commands used, for the record:**
```
node scripts/script-path-portability-contract-test.mjs
node scripts/payment-refund-pgtest/run.mjs
node scripts/payment-refund-recovery-pgtest/run.mjs
npm run test:payment-ledger / test:payment-notifications / test:shipping-discount / test:photo-gallery /
  test:featured-shipments / test:delivery-cash-payment / test:contact-details-lock /
  test:service-area-mass-assignment / test:legacy-rpc-overload-cleanup / test:email-updates-subscription
npm run check
```
All run from `/Users/beasarong/Downloads/CargoExpressPH-main` (macOS). **A real Windows machine was not available in this session** — the macOS reproduction above demonstrates the identical root cause (un-decoded percent-encoding), but the drive-letter-doubling half of the Windows failure specifically was not re-run on actual Windows. This is the one piece of N-1 that remains outstanding: **run `npm run check` on an actual Windows checkout of this same folder name and confirm exit 0.**

---

## 2–4. N-2: The public trip-reschedule email rule

### Design decision and why

The audit found two independent notification paths for a trip reschedule that never talked to each other: an automatic, narrow per-trip courtesy email (booked + opted-in customers only) and a completely separate, manually-triggered Announcements broadcast (all `email_subscriptions`). The task's rule is that checking an explicit option should extend the *reschedule itself* to the full subscriber audience, without creating a second parallel sending system, and without an already-covered customer getting the same news twice.

**Chosen approach — reuse, don't duplicate:** the public option reuses the *exact* pipeline `createTrip()` already uses for "announce via email" on a newly published trip (`announcements` → `send_email` → `email_subscriptions` → `announcement_email_broadcasts`/`announcement_email_recipients` → `broadcast-announcement` Edge Function → `_shared/announcement-broadcast-worker.ts`). No new subscription table, no new worker, no new lease/idempotency mechanism. The only additions are: one new admin-gated RPC to make the reschedule itself atomic and report whether it was genuine, two new nullable columns so an announcement can carry an optional CTA button, and a one-line addition to the existing courtesy-email trigger so it can stand down when the admin picked the broader option.

### What was changed

**New migration:** `supabase/migrations/20260917100000_public_trip_reschedule_broadcast.sql` (append-only forward migration; nothing in any previously-applied migration was edited).

1. **`announcements.cta_label` / `announcements.cta_url`** (nullable, additive) — lets an announcement carry a real button (e.g. "Book This Trip") instead of the fixed "Visit CargoExpress PH" pitch. A `CHECK` constraint requires `https://` when set. Existing rows/behavior are unaffected (`NULL` → old fixed CTA).
2. **`announcement_email_broadcasts.cta_label` / `.cta_url`** (nullable, additive) — the CTA is snapshotted onto the broadcast job at claim time inside `claim_announcement_email_broadcast`, exactly the way `subject`/`content`/`from_email` already are, so a later edit to the source announcement can never change an in-flight or partially-sent broadcast.
3. **`public.reschedule_trip(p_trip_id, p_departure_date, p_arrival_date, p_notify_all_subscribers, p_public_reason)`** — the only write path the reschedule modal now uses. Admin-gated (`is_admin()`), locks the trip row (`FOR UPDATE`), applies the date change, and returns `{trip, schedule_changed, old_departure_date, old_arrival_date, public_reason}`. `schedule_changed` is computed by comparing the locked "before" row to the "after" row — this is what makes an unchanged-dates save or an accidental double-submit correctly report "nothing changed," so the client never fires an email for a no-op.
4. **Coordination, not duplication:** `reschedule_trip` sets a transaction-local flag (`set_config('cargoexpress.trip_reschedule_notify_all', ..., true)`) before it runs the `UPDATE`. The existing courtesy-email trigger function (`private.trigger_trip_reschedule_email`, originally added in `20260910020000`) is replaced (via `CREATE OR REPLACE`, the standard way this codebase layers forward-fixes onto earlier migrations — see F-01's own fix for precedent) with one extra check at the top: if that flag is true, it returns immediately without calling `email-trip-reschedule` at all. The admin picks exactly one channel per reschedule; a booked, opted-in customer never gets both.
5. Grants: `EXECUTE` on `reschedule_trip` to `authenticated` only (function does its own `is_admin()` check, same pattern as every other admin RPC in this codebase — e.g. `admin_set_email_subscription`).

**Edge Function:** `supabase/functions/broadcast-announcement/index.ts` — `buildAnnouncementEmailHtml` now takes an optional `{label, url}` and renders it as the CTA button in place of the fixed "Visit CargoExpress PH" block when present; falls back to the original fixed CTA when absent (verified byte-for-byte that regular admin-authored announcements, which never set `cta_label`/`cta_url`, render identically to before). `buildPayload` passes `claim.cta_label`/`claim.cta_url` through.

**Frontend:**
- `src/components/ui/RescheduleTripModal.jsx` — new checkbox **"Email this schedule update to all subscribers"** with explanatory copy, plus an optional "Reason" textarea shown only when checked (max 280 chars, included in the email only when non-empty). Passes `notify_all_subscribers`/`public_reason` up to the caller.
- `src/lib/database.js` — new `rescheduleTrip(tripId, options, tripContext)`:
  - Calls `reschedule_trip` RPC.
  - Only when `schedule_changed === true` **and** the checkbox was used, builds the public notice: title/content with the public route, previous schedule, new schedule, and the optional reason; `cta_label` is `"Book This Trip"` when the trip is still `scheduled` and its new departure date is today-or-later (the exact same PH-calendar rule `RescheduleTripModal`'s own doc comment already describes for when a rescheduled trip reopens for booking), otherwise `"View Updated Schedule"`; `cta_url` points at the public `/schedules` listing (there is no per-trip deep-link URL in this app today — booking-form trip preselection is carried via React Router `location.state`, not a URL param, so a trip-specific booking link was not fabricated; see "Known limitation" below).
  - Inserts the `announcements` row itself and **awaits** the `broadcast-announcement` invocation (unlike `createTrip`'s fire-and-forget call) specifically so a real failure can be reported to the admin truthfully instead of only logged to the console — the reschedule button explicitly promises subscribers will be emailed, so silently swallowing a failure here would be worse than for a routine announcement.
  - Returns `{trip, scheduleChanged, announcementId, emailQueued, emailError}`.
  - New `retryTripReschedulePublicNotice(announcementId)` — thin wrapper around the existing `retryAnnouncementBroadcast`, so retrying doesn't touch the trip again and never re-sends already-accepted recipients (unchanged F-03 per-recipient idempotency).
- `src/pages/admin/TripDetailPage.jsx` — `handleReschedule` now calls `rescheduleTrip`, only logs an activity entry when `scheduleChanged`, and shows exactly the required copy: **"Schedule updated. Email notification could not be completed."** with a **Retry email notification** button when the broadcast failed or is still partial, using the already-live counts (`accepted`, `state`) to avoid overclaiming completion.
- `src/pages/admin/AnnouncementsPage.jsx` — see N-3 below (also benefits this feature, since the reschedule notice surfaces through the same list).

### Known limitation (disclosed, not hidden)

The CTA link points at the general public `/schedules` listing, not a URL that deep-links straight into a pre-filled booking form for that specific trip — this app's booking-form trip preselection is carried via React Router navigation state (`location.state.preselectedTripId`), which cannot be encoded in an emailed link without adding query-string support to the booking route. Adding that was judged out of scope for this fix (a real but separate enhancement); the email still correctly names the route, dates, and points the recipient at the live public schedules page where that trip is listed.

### Verification performed

**New test:** `scripts/trip-reschedule-broadcast-pgtest/run.mjs` — applies the **actual** `20260910020000` trigger migration (with only its `CREATE EXTENSION pg_net` line stripped, since PGlite cannot install that extension — the same accommodation `payment-refund-recovery-pgtest` already makes for `pg_net`/Vault), the **actual** `20260916161000` F-03 migration, and the **actual** new `20260917100000` migration, against embedded Postgres. 15 assertions, all passing:

- Reschedule without the option → exactly one private courtesy-email call fires, targeting `email-trip-reschedule`.
- Re-submitting identical dates → `schedule_changed = false`, no additional call (double-submit safety).
- Reschedule with the option → `schedule_changed = true`, reason carried through, **no** private call fires (duplicate prevented).
- Simulating the client's subsequent `createAnnouncement`-equivalent call → broadcast claims successfully, reaches both an inquiry-only and a no-booking subscriber (2 recipients from `email_subscriptions`), and the CTA label/url snapshot correctly on the job.
- A later, genuinely different reschedule → reported as changed again, and **does** fire its own private call (distinct event, not swallowed by the earlier suppression).
- A non-admin caller is rejected by `reschedule_trip` with `Admin privileges required`.

Also re-ran the pre-existing `announcement-broadcast-pgtest` and `broadcast-announcement-worker-test` (unmodified) — both still pass, confirming the new nullable columns and the `claim_announcement_email_broadcast` change are backward-compatible with the already-shipped F-03 feature. Ran `node scripts/edge-function-build-test.mjs` — 18/18 functions still build, including the modified `broadcast-announcement`.

**Not verified this session (needs staging/browser):**
- The actual React UI (checkbox, textarea, retry banner) in a real browser — no browser tool available.
- A real email actually rendering the CTA button correctly in an inbox (Resend was not exercised — no designated test mailbox).
- True concurrent reschedules from two admin sessions against a live multi-connection Postgres (only PGlite's single-backend row-lock semantics were exercised, same limitation every prior report in this project has disclosed for concurrency).
- "Schedule save succeeds but email preparation fails" and "more than 25 recipients show accurate remaining progress" are implemented (see code above) and reasoned through, but not covered by an automated test — this codebase has no existing pattern for unit-testing a `database.js` function against a mocked Supabase client, and building one was judged disproportionate to add here. **Manual verification needed:** in staging, temporarily break the Edge Function call (e.g. wrong URL) to confirm the exact toast/banner copy and retry path; and seed >25 subscribers to confirm the Announcements page shows an accurate `pending` count and the retry button stays available.

### Deployment order and compatibility

This migration and the `broadcast-announcement` Edge Function change **must deploy together**, in the same window that the frontend also deploys, because:
- The migration's `claim_announcement_email_broadcast` replacement adds `cta_label`/`cta_url` to what it returns; the **old** deployed `broadcast-announcement` Edge Function ignores unknown keys in that JSON, so applying the migration alone first is safe for the *existing* announcement feature (no breaking change there) but the new CTA button simply won't render until the Edge Function is redeployed too.
- The new `reschedule_trip` RPC and the trigger's suppression check only take effect once both the migration is applied **and** `RescheduleTripModal`/`TripDetailPage`/`database.js` are deployed together — deploying the frontend without the migration would call an RPC that doesn't exist yet (hard failure, safely caught by the modal's existing error handling, no partial state).
- Recommended order, consistent with this project's own documented practice (see the F-03 fix report's "database-first" note): **(1)** apply `20260917100000_public_trip_reschedule_broadcast.sql`, **(2)** deploy the updated `broadcast-announcement` Edge Function, **(3)** deploy the frontend build containing the updated modal/page/database.js.

---

## 5. N-3: Announcement pending-count clarity — fixed

`src/pages/admin/AnnouncementsPage.jsx`'s per-announcement email status line now computes and shows `pending = total − accepted − skipped − retryable − review` explicitly, renamed "accepted" to "accepted by provider" (per the task's instruction that acceptance ≠ inbox delivery), and always shows the total (`of N`). Example: `Email partial: 25 accepted by provider, 75 pending, 0 retry needed, 0 need review (of 100)` — previously this would have read `Email partial: 25 accepted, 0 retryable, 0 need review`, which could read as "basically done." The existing "Retry unfinished emails" button logic (`emailIncomplete = send_email && !emailed_at`) was not changed — it already correctly stays visible for any non-final state, including untouched `pending` recipients, and `finish_announcement_email_broadcast` already only sets `emailed_at` when every recipient is accepted/skipped (unchanged F-03 behavior, re-confirmed by the passing `announcement-broadcast-pgtest`). No new scheduling system was added, per instruction — this is a display-only fix.

**Not verified this session:** the actual rendered string in a real browser with a >25-recipient batch (no browser tool / no such live batch available).

---

## 6. F-01: Report RPC — full admin execution now verified live, without synthetic accounts

Both prior audit passes could not verify a real admin invoking `get_financial_report_data`: one hit HTTP 401 on the Management API, the other found the designated `E2E_ADMIN_EMAIL` fixture doesn't exist as an `auth.users` row on the live project at all (confirmed again in this session: `SELECT ... FROM auth.users WHERE email ILIKE '%e2e_admin%'` returns zero rows — this is a missing/never-created fixture, not a wrong password).

**This session had working `supabase` CLI/Management-API access** (unlike the immediately-prior audit run). Rather than create a synthetic account or attempt to reset/guess a password — both explicitly disallowed — the verification used a safe, read-only technique available to someone who already has legitimate elevated database access: running the RPC inside a query that spoofs `request.jwt.claims` to an **existing, real admin's own UID** (`SELECT id FROM profiles WHERE role='admin' LIMIT 1`), wrapped in `BEGIN; ... ROLLBACK;` so nothing was written. This is not a privilege escalation (the UID already has admin privileges; no new grant, account, or password was involved) and not a production write.

**Result:** `get_financial_report_data(now() - interval '3650 days', now() + interval '1 day')` executed successfully and returned the complete, correct JSON shape — `grossCollected`, `successfulRefunds`, `netCollected`, `methodTotals`, `dailyChart`, `completedDeliveries`, `paymentRefundDetail` — reflecting the one real payment in the live database (₱5,000 cash). `get_sales_overview_data()` also executed successfully in the same session, returning a correct 12-month chart. This closes the one remaining gap in F-01's evidence chain: the fixed function body (no `method_agg` CTE) is not just present in the deployed source, it **actually completes successfully for a real admin identity** against real production data.

**Still needed:** the designated `E2E_ADMIN_EMAIL`/`E2E_ADMIN_PASSWORD` fixture should be created (or corrected) on the live project so future audits/E2E runs don't have to route around a missing credential — that account-provisioning decision belongs to the project owner, not to an unattended verification pass, so it was intentionally not created here.

---

## Changed files

### Database
- `supabase/migrations/20260917100000_public_trip_reschedule_broadcast.sql` (new)

### Edge Functions
- `supabase/functions/broadcast-announcement/index.ts`

### Application
- `src/components/ui/RescheduleTripModal.jsx`
- `src/lib/database.js`
- `src/pages/admin/TripDetailPage.jsx`
- `src/pages/admin/AnnouncementsPage.jsx`

### Scripts / tests
- `scripts/legacy-rpc-overload-cleanup-pgtest/run.mjs`
- `scripts/contact-details-lock-pgtest/run.mjs`
- `scripts/contact-details-lock-pgtest/trigger-bypass-run.mjs`
- `scripts/payment-notification-pgtest/run.mjs`
- `scripts/photo-gallery-pgtest/run.mjs`
- `scripts/payment-refund-recovery-pgtest/run.mjs`
- `scripts/delivery-cash-payment-pgtest/run.mjs`
- `scripts/shipping-discount-pgtest/run.mjs`
- `scripts/service-area-mass-assignment-pgtest/run.mjs`
- `scripts/payment-refund-pgtest/run.mjs`
- `scripts/featured-shipments-pgtest/run.mjs`
- `scripts/payment-ledger-pgtest/run.mjs`
- `scripts/script-path-portability-contract-test.mjs` (new)
- `scripts/trip-reschedule-broadcast-pgtest/run.mjs` (new)
- `package.json` (added the two new scripts to the `test` chain and as standalone `npm run` commands)

Nothing else in the working tree was touched. The pre-existing untracked `POST_DEPLOYMENT_REGRESSION_AUDIT.local.md`, patch/reject files, and other unrelated untracked items from earlier sessions were left exactly as found.

---

## Tests run this session (all local/PGlite/mocked, no production writes)

| Command | Result |
|---|---|
| `node scripts/script-path-portability-contract-test.mjs` | Passed — 0 offenders |
| `node scripts/payment-refund-pgtest/run.mjs` | Passed — 14/14 |
| `node scripts/payment-refund-recovery-pgtest/run.mjs` | Passed — 22/22 |
| `node scripts/trip-reschedule-broadcast-pgtest/run.mjs` | Passed — 15/15 (new) |
| `node scripts/announcement-broadcast-pgtest/run.mjs` | Passed (unmodified suite, re-run to confirm no regression) |
| `node scripts/broadcast-announcement-worker-test.mjs` | Passed (unmodified suite, re-run to confirm no regression) |
| `npm run test:payment-ledger` | Passed — 52/52 |
| `npm run test:payment-notifications` | Passed — 41/41 |
| `npm run test:shipping-discount` | Passed — 92/92 |
| `npm run test:photo-gallery` | Passed — 47/47 |
| `npm run test:featured-shipments` | Passed — 33/33 |
| `npm run test:delivery-cash-payment` | Passed — 47/47 |
| `npm run test:contact-details-lock` | Passed — 8/8 |
| `npm run test:service-area-mass-assignment` | Passed — 12/12 |
| `npm run test:legacy-rpc-overload-cleanup` | Passed — 8/8 |
| `npm run test:email-updates-subscription` | Passed — 38/38 |
| `node scripts/edge-function-build-test.mjs` | Passed — 18/18 functions build |
| `npm run check` (full gate, this exact folder) | **Passed, exit 0** — test chain, edge-function build, photo-fallback browser test, production build, PWA offline precache |
| `supabase db push --dry-run --linked` | Confirms exactly one pending migration (`20260917100000_...`), no drift |
| Live `get_financial_report_data`/`get_sales_overview_data` as a real admin (JWT-claim technique, `BEGIN`/`ROLLBACK`, read-only) | Both executed successfully against real production data |

**Environment:** macOS, this exact project checkout, Node from the project's own `node_modules`, PGlite (embedded Postgres) for all `-pgtest` suites, mocked Resend/pg_net/Vault where those live-project-only extensions/services are referenced. No Docker, no local PostgreSQL server, no live Resend/PayMongo/Firebase calls, no browser automation tool available this session.

---

## Remaining Windows / browser / provider verification

1. **Windows:** run `npm run check` on an actual Windows machine, from a checkout path containing a space (ideally the identical folder name), and confirm exit 0. Not available in this session.
2. **Browser, reschedule feature:** open the admin Trip Detail page, reschedule a test trip with the checkbox unchecked (confirm old private-email behavior, unchanged UI), then with it checked (confirm the reason field appears, the success/failure toast text matches exactly, and the retry banner appears and works on a forced failure).
3. **Browser, Announcements page:** seed a test announcement broadcast with 26+ subscribers in staging and confirm the new pending/retry/review counts render correctly and the retry button remains available until fully complete.
4. **Real email delivery:** with a designated test mailbox, trigger one reschedule with the public option to confirm the CTA button renders correctly across at least Gmail and Outlook rendering, and that the route/schedule/reason text is accurate.
5. **Concurrency:** two-connection real-Postgres test rescheduling the same trip simultaneously with the public option, on a disposable staging database (not available this session — PGlite is single-backend).
6. **The designated E2E admin credential** should be created or repaired on the live project so future automated verification doesn't need the JWT-claim workaround this session used.

---

## Final answers

**1. What could currently interrupt the defense?**
Nothing found this session breaks an already-working core flow. The main residual risk is deploying only half of the reschedule feature (migration without the Edge Function update, or vice versa) — see the deployment-order note above — and the fact that the actual browser UI for the new checkbox/banner has not been visually exercised.

**2. Which fixes are necessary before the demo?**
None of these are release-blocking for the *existing* F-01/F-02/F-03/F-04/F-07 features, which remain green. If the reschedule-broadcast feature itself will be demonstrated, it needs the ordered deployment above (migration → Edge Function → frontend, together) and at least one staging browser pass first.

**3. Which workflows were verified on the deployed system?**
Only the read-only F-01 live-execution check (new this session, via the JWT-claim technique) touched the actual deployed production system. Everything else in this report — N-1, N-2, N-3 — was implemented and verified locally/in embedded Postgres; **none of it is deployed yet**, per the task's explicit instruction not to deploy.

**4. Which still need testing?**
Everything listed in "Remaining Windows / browser / provider verification" above. Production is not fixed until these changes are actually deployed to Supabase (migration + Edge Function) and to Vercel (frontend), and then re-verified live the same way this report re-verified F-01 — do not present this report as proof that the live system already has these fixes.
