# CargoExpressPH Post-Deployment Regression Audit

**Audit date:** 2026-09-17 (Asia/Manila)
**Scope:** live Supabase project `duigaivxgxlnjmfienhg`, live frontend at `https://www.cargoexpress-ph.online` (Vercel), repository at `main`/`origin/main` commit `50f589a` (the fix commit described in `SYSTEM_BUG_SECURITY_FIX_REPORT.md`).
**Mode:** verification only. No application code, migration, Edge Function, or production configuration was changed. No real booking, payment, refund, email, or push notification was sent. Two throwaway synthetic customer accounts (`audit-test-*@example.com`) were self-registered through the public signup API to test authorization boundaries; they hold no real data and can be safely ignored/deleted by an admin at leisure.
**Access available:** live REST/RPC/Auth endpoints (anon key) and a synthetic authenticated customer session — full read/write within RLS. **Not available:** Supabase Management API/CLI (token returns 401, same as the prior audit), a working designated E2E admin credential (see F-01 below), a browser/Playwright tool in this session, and a service-role key.

---

## A. Simple Taglish summary

Nag-verify ako directly sa live Supabase project at sa live na naka-deploy na frontend (`cargoexpress-ph.online`, naka-host sa Vercel), hindi lang sa local na tests. **Magandang balita:** parehong migration na dapat na-deploy (`20260916160000` para sa report RPC, `20260916161000` para sa announcement broadcast) ay talagang naka-apply na sa live database — na-verify ko ito sa pamamagitan ng pag-tawag mismo sa mga RPC/table gamit ang totoong HTTP requests, hindi lang pagbasa ng migration file. Ang live frontend build stamp ay 27 segundo lang pagkatapos ng fix commit — ibig sabihin kasalukuyang naka-deploy talaga ang bagong build, hindi luma/naka-cache.

**Pero may dalawang seryosong bagay na dapat malaman bago ang defense:**

1. **Hindi ko na-verify na gumagana talaga ang na-ayos na Reports RPC para sa isang totoong admin**, dahil ang designated na E2E admin test account (`e2e_admin@cargoexpress.ph` sa `.env`) ay **"Invalid login credentials"** sa live project — parang hindi na tumutugma ang password o wala na ang account doon. Kailangan itong ayusin bago ma-verify nang buo ang F-01.
2. **Ang "lahat ng enabled subscribers dapat makatanggap ng trip-reschedule email" na requirement ay HINDI pa rin naipapatupad sa totoong reschedule flow.** Sinuri ko ang aktwal na code: kapag nireschedule ng admin ang isang trip, automatic itong nagpapadala ng email sa pamamagitan ng isang hiwalay, tahimik na database trigger — walang "send email" na option/checkbox man lang sa RescheduleTripModal — at ang email na iyon ay pumupunta lang sa mga customer na may **aktibong booking sa specific na trip na iyon** at naka-on ang `wants_announcements`. Hindi ito nakaka-reach sa mga inquiry-only subscriber o sa mga rehistradong customer na walang booking sa trip na iyon. Ito mismo ang isinulat sa comment ng bagong migration (`20260916150000`, linya 16–24): sinasabi nitong "sinadya" na hindi kasama ang trip-reschedule path sa broader na `email_subscriptions` audience. Kung ito ang tinutukoy na "agreed rule," hindi pa ito gumagana sa totoong system ngayon.
3. **May bagong natuklasang bug sa validation gate mismo**, hindi kaugnay sa naunang pitong findings: 12 sa mga `scripts/*-pgtest/run.mjs` files ay gumagamit ng maling paraan ng path resolution (`new URL(import.meta.url).pathname` sa halip na `fileURLToPath`), na sumasabog sa Windows kapag may space o special character ang folder path — **eksaktong ang mismong thesis folder na ito** ("KAY BEAAAA TOOOOO!!!"). Na-reproduce ko ito ngayon: humihinto ang `npm run check` sa `payment-refund-pgtest` na may `ENOENT` error tungkol sa maling path (`C:\C:\Users\...`), kaya lahat ng test pagkatapos nito — kasama ang financial-report at announcement suites — hindi na umaabot sa pagtakbo sa loob ng iisang `npm run check` run dito. **Pero** pag pinatakbo ko ang bawat sira na test nang isa-isa (bypass sa broken chain), lahat sila — kasama ang financial-report at announcement-broadcast suites — ay **pumasa**. Ibig sabihin, hindi ulit sumira ang mismong mga fix; isang bagong, hiwalay na portability bug lang ang sumisira sa gate sa specific na folder na ito.

Overall: malakas ang ebidensya na naka-deploy ang mga core na fix (F-01 at F-03 na database layer), at gumagana nang tama ang authorization boundaries (verified live gamit ang totoong bagong account). Pero hindi pa ito "the same as secure/complete" — may dalawang bagay na dapat pagtuunan bago ang defense: (a) ayusin ang admin test credential para ma-verify nang buo ang report RPC, at (b) linawin/ayusin kung paano dapat gumana ang trip-reschedule broadcast, dahil sa kasalukuyan ay hindi ito tumutugma sa hiningi na rule.

---

## B. Deployment verification matrix

| Item | Method | Result | Evidence level |
|---|---|---|---|
| Git commit pushed | `git fetch origin main`; `git rev-list --left-right --count HEAD...origin/main` | `main` and `origin/main` both at `50f589a` (0 ahead/behind) | Direct |
| Frontend build identity | `curl https://www.cargoexpress-ph.online/`, inspected `/sw.js` `CACHE_VERSION` | Live stamp `v1789569507114` = **2026-09-16 22:38:27 +0800**, 27s after fix-commit timestamp (2026-09-16 22:38:00 +0800). Asset hashes (`index-BWqp14I4.js`, etc.) present and served with HTTP 200. | Direct, strong — the live site is running a build produced immediately after the fix commit, not a stale one |
| Vercel hosting confirmed | `curl -I https://cargoexpress-ph.online/` | `HTTP/1.1 308` → `www.cargoexpress-ph.online`, `Server: Vercel` | Direct |
| Supabase Management API / CLI | `supabase migration list --linked`, `supabase functions list`, `supabase projects list` with `SUPABASE_PERSONAL_ACCESS_TOKEN` from `.env` | All return `401 Unauthorized` | Direct — same blocker the original audit reported; the token in this checkout is not valid for management calls |
| `get_financial_report_data` deployed with the fix | Called live via PostgREST with correct params (`p_start_date`/`p_end_date`) as anon and as a fresh authenticated non-admin | Anon: `42501 permission denied` (only migration `20260916160000` revokes anon/PUBLIC execute — `20260916140000` alone would not produce this). Authenticated non-admin: `P0001 Admin access required` (the `is_admin()` guard fires correctly, not a SQL crash). | Indirect but strong (grant fingerprint unique to the fix migration) |
| `announcement_email_broadcasts` / `announcement_email_recipients` deployed | Queried live via PostgREST | `announcement_email_broadcasts`: `42703 column "id" does not exist` — correct, because the actual PK column is `announcement_id` exactly as migration `20260916161000` defines it. `announcement_email_recipients`: `42501 permission denied` — correct, RLS/grants match the migration (`GRANT SELECT` only on broadcasts, none on recipients). | Indirect but strong (schema fingerprint matches migration text column-for-column) |
| 5 new announcement RPCs deployed (service-role only) | Not independently invoked (require service-role key, which is correctly never exposed to the client) | Not directly tested; inferred from the successful table/column deployment above, since all five functions are created in the same transaction as those tables | Inferred |
| Edge Functions live | `curl -X OPTIONS` against `broadcast-announcement`, `email-trip-reschedule`, `paymongo-webhook`, `paymongo-create-payment` | All returned HTTP 200 on at least one attempt each. Some attempts hit transient DNS/connection resets from this local network — not evidence of an undeployed function, since the same URLs succeeded on retry. | Direct, with noted local network flakiness |
| Config/project match | `.env` `VITE_SUPABASE_URL` vs. `supabase/.temp/project-ref` | Both resolve to `duigaivxgxlnjmfienhg` — the dev `.env` here is pointed at the same project this audit tested. `VITE_APP_URL` is still `http://localhost:5173` in this local `.env`, same as the original audit flagged; this is a **local dev file**, not proof of what Vercel's own environment variables hold — I have no access to Vercel's dashboard/env vars to check that separately. | Direct for project match; unverified for what Vercel itself has configured |
| Registration / legal-consent version match | Self-registered two throwaway accounts | First attempt (no legal metadata) correctly failed with a Postgres-trigger-raised error surfaced by GoTrue as generic `500 Database error saving new user` — this is expected trigger behavior, not a bug, when required consent fields are omitted. Second attempt with `legal_terms_version`/`legal_privacy_version` = `2026-08-22` (the value hardcoded in `src/constants/legalDocuments.js`) succeeded with `HTTP 200` and an active session. Confirms the client's hardcoded legal version still matches the live `legal_documents.is_current` row. | Direct |

**Bottom line:** the two migrations described in the fix report are live, the RPC's admin gate fires correctly for both anon and a real authenticated non-admin, and the currently served frontend build is essentially the fix commit's build. What remains unverified is whether the *inside* of `get_financial_report_data` — the part actually rewritten to remove the invalid `method_agg` CTE — completes successfully for a real admin, because the only credential available to reach that branch (the E2E admin fixture) does not authenticate (see F-01 below).

---

## C. Previous findings — verified fixed / still failing / unverified

### F-01 — Financial report RPC crash

**Status: Deployed and gate-passing; admin-execution success partially unverified.**

- The fixed function signature and its unique `REVOKE ... FROM PUBLIC, anon` are live (see matrix above) — strong evidence the whole `20260916160000` transaction, including the corrected function body, committed.
- `is_admin()` is checked *before* any of the previously-buggy SQL runs (confirmed by reading `supabase/migrations/20260916160000_fix_financial_report_runtime.sql:14-17`), so both the anon and authenticated-non-admin probes I ran correctly stop at the auth check and cannot, by themselves, prove the `method_agg`-free query body executes cleanly for an admin.
- **Blocked:** signing in as the designated fixture `E2E_ADMIN_EMAIL=e2e_admin@cargoexpress.ph` / `E2E_ADMIN_PASSWORD` (from `.env`) against the live project returns `{"error_code":"invalid_credentials"}`. This is either a stale password, a deleted/never-created auth user for that email on this project, or a decoupled staging vs. production credential. I did not attempt to guess a different password or otherwise bypass this.
- `node scripts/financial-report-pgtest/run.mjs` (the regression test added for this fix) re-run directly against the current commit: **passes** — empty range, mixed payment methods, refund states, date boundaries, and non-admin rejection all assert correctly against embedded Postgres running the *exact* applied migration text.
- **Net verdict:** high confidence the fix is deployed and structurally correct (schema/grant fingerprint + embedded-Postgres re-execution of the literal deployed SQL), but a live, real-admin, real-Supabase-Postgres invocation was not completed. This is a gap in evidence level, not a discovered regression.
- **What's needed:** a working admin credential for this project (fix the E2E fixture, or supply a different designated test admin) to run `get_financial_report_data` end-to-end and reconcile totals against known fixtures, per the original checklist.

### F-02 — Booking-draft privacy

**Status: Verified fixed by code inspection; matches the fix report exactly.**

- Read `src/lib/bookingDraft.js` in full: keys are `cargoexpress.booking-draft.v2:<user-id>:form|step`; `readBookingDraft`/`persistBookingDraft`/`clearBookingDraftStorage` all refuse to operate without a `userId`; `clearLegacyBookingDraftStorage` unconditionally deletes the old global `booking_form`/`booking_step` keys on every read/write/clear call, so no legacy value is ever adopted by a new session.
- `node scripts/booking-dirty-state-contract-test.mjs` re-run directly: **passes** — 21 protected fields, account isolation, legacy-key deletion.
- **Not independently re-verified in a real browser** (no browser tool in this session): logout-clears-draft, account-switch-resets-form, and delayed-autosave-race behavior in `AuthContext.jsx`/`BookShipmentPage.jsx` were read and are consistent with the fix report's description, but the actual DOM-level behavior (does Customer B's mounted form really render clean) needs a manual/Playwright pass. This is a code-review-level confirmation, not a live UI confirmation.

### F-03 — Announcement broadcast reliability

**Status: Tables/RPCs deployed live (see matrix); worker logic re-verified against the exact deployed migration; one real functional gap found (see item 3/D below), one minor UX-clarity gap found.**

- `node scripts/broadcast-announcement-worker-test.mjs` and `node scripts/announcement-broadcast-pgtest/run.mjs` re-run directly: **both pass** (concurrency, partial retry, stable idempotency key, consent recheck, completion-write failure, expired-claim recovery).
- Recipient seeding (`claim_announcement_email_broadcast`, lines 105-109 of the migration) does correctly pull from **all** `email_subscriptions WHERE subscribed IS TRUE` — this part of the fix (general Announcements → email path includes inquiry-only subscribers) is real and deployed.
- `finish_announcement_email_broadcast` only sets `announcements.emailed_at` when `v_outstanding = 0 AND v_failed = 0 AND v_review = 0` (read in full, lines 337-349) — a batch that still has untouched/`pending` recipients correctly stays `partial`, never silently marked complete.
- Admin UI (`src/pages/admin/AnnouncementsPage.jsx:348,373-393`): `emailIncomplete = send_email && !emailed_at`, so the **"Retry unfinished emails"** button correctly stays visible for any non-complete state, including recipients that were never attempted (not just ones that failed) — the truthfulness property holds.
- **Minor finding (new, low severity):** the status line at line 378 (`` `Email ${status}: ${accepted} accepted, ${retryable} retryable, ${failed+needs_review} need review` ``) never explicitly shows a "pending / not yet attempted" count. For a list over the 25-recipient-per-invocation cap, an admin could read "Email partial: 25 accepted, 0 retryable, 0 need review" and reasonably (but wrongly) assume it's essentially done, when in fact e.g. 75 more recipients are sitting untouched in `pending`. The button correctly stays present and the status word "partial" is accurate, so nothing is falsely marked complete — this is a clarity/hardening suggestion, not a truthfulness bug.
- **Not tested (per audit constraints and lack of designated test mailbox):** real Resend acceptance, real delivery, true multi-connection Postgres concurrency (only PGlite single-backend was available, same limitation the fix report already disclosed).

### F-04 — Validation gate

**Status: The specific fixes claimed (table scopes, renamed-page test, font assertion) are real and verified. A new, unrelated gate-breaking bug was found and reproduced live in this exact checkout.**

- `npm ci` — clean install from the lockfile, 213 packages, exit 0.
- `npm run check` in this checkout — **fails**, but not for any of the seven original reasons. It stops inside the `npm test` chain at `payment-refund-pgtest/run.mjs` with:
  ```
  Error: ENOENT: no such file or directory, open 'C:\C:\Users\user\OneDrive\Desktop\KAY%20BEAAAA%20TOOOOO!!!\CargoExpressPH\scripts\payment-ledger-pgtest\harness-schema.sql'
  ```
  Root cause: `scripts/payment-refund-pgtest/run.mjs:8` (and 11 other `*-pgtest/run.mjs` files — see new finding N-1 below) resolve their own directory with `path.dirname(new URL(import.meta.url).pathname)` instead of Node's `fileURLToPath()`. On Windows this leaves a literal leading `/C:/...` (which `path.resolve` then doubles into `C:\C:\...`) and leaves `%20`/other percent-encoding un-decoded whenever the checkout path contains a space or special character — which this actual project folder does (`KAY BEAAAA TOOOOO!!!`).
- I then ran **every** script in the `npm test` chain individually (bypassing the broken one) to isolate whether this is masking any real regression: `financial-report-pgtest`, `broadcast-announcement-worker-test`, `announcement-broadcast-pgtest`, `booking-dirty-state-contract-test`, `registration-transition-contract-test`, `unsettled-mobile-layout-contract-test`, `photo-reference-test`, `photo-fallback-contract-test`, `photo-storage-monitoring-contract-test`, `apple-platform-test`, `push-notification-contract-test`, `notification-ux-contract-test`, `test:edge-functions` (18 functions), `photo-fallback-browser-test` (9 assertions), `npm run build`, `test:pwa-offline` (71 assets) — **all pass, exit 0**, individually.
- **Conclusion:** the seven originally-claimed F-04 fixes are real and correct. The gate is nonetheless genuinely red *in this exact folder*, because of a newly discovered, previously-undetected portability bug (see N-1). This matters for the defense specifically because the demo will almost certainly run from this same folder.

### F-05 — Schema snapshot

**Status: Unchanged from the fix report's own assessment; not independently re-litigated.**

`supabase/schema.sql` is still explicitly labeled historical per the fix report; I did not attempt to regenerate it (Docker/local Postgres still unavailable in this environment, and doing so is out of scope for a read-only audit). No new information changes this finding's status.

### F-06 — PayMongo webhook hardening

**Status: Confirmed unchanged (as intended) — still open, still optional hardening.**

`supabase/functions/paymongo-webhook/index.ts` is **not** in the fix commit's changed-file list (`git show --stat 50f589a`), confirming no timestamp-freshness change was made, exactly as the fix report states. Per the audit's explicit instruction, I did not replay any request against the live webhook endpoint and did not attempt to inflate this beyond its original "Low / hardening" classification. No new evidence changes the original F-06 risk assessment.

### F-07 — Report period vs. current-snapshot labeling

**Status: Verified present in the deployed code (static), not visually confirmed on-screen.**

`src/pages/admin/ReportsPage.jsx:309,315,326-327,412,414,424-425` contain the exact labels described in the fix report — "Deliveries Completed in Period — Current Financial Snapshot", "Paid (Current)"/"Balance (Current)" column headers with `scope="col"`, and explanatory copy ("...are not expected to total to the period collections") on both the on-screen and print sections. This confirms the wording shipped; it does not confirm how it actually renders/paginates on screen or in an exported PDF, which needs a real browser (see workflow matrix).

---

## D. The reschedule-email rule (task item 3) — confirmed still failing

**This is the most consequential functional finding of this audit.**

Traced the full live path: `RescheduleTripModal.jsx` → `trips` table update → `trips_notify_reschedule_email` trigger (`supabase/migrations/20260910020000_trip_reschedule_email_trigger.sql`) → `email-trip-reschedule` Edge Function.

- **`RescheduleTripModal.jsx` has no "send email" option at all.** It has exactly two fields: departure date and arrival date (`src/components/ui/RescheduleTripModal.jsx:34-37,121-148`). There is no sending-option checkbox to select or deselect for this action.
- The reschedule email is **fully automatic** and fires unconditionally (`AFTER UPDATE OF departure_date, arrival_date ... WHEN (NEW.status = 'scheduled' AND dates changed)`), with no admin choice involved.
- `email-trip-reschedule/index.ts:236-267` selects recipients as: active (non-cancelled) **bookings on that specific trip**, grouped by `user_id`, then filtered to `profiles.role = 'customer' AND wants_announcements = true AND email IS NOT NULL`. This is a completely different data source (`profiles.wants_announcements`) from the one the general Announcements "Send email" feature now correctly uses (`email_subscriptions`, populated from both `contact_inquiries` and `profiles`).
- This separation is **explicitly intentional and documented by the fix author themselves**, in the migration that shipped alongside the fix commit: `supabase/migrations/20260916150000_email_updates_subscription.sql:16-24` states in its own header comment that `profiles.wants_announcements` "keeps gating the separate, pre-existing trip-reschedule courtesy email... untouched here," and that `email_subscriptions` is the sole recipient source only for `broadcast-announcement`, not for the reschedule trigger. The fix report's own "Changed files" list (F-03 section) says the same: "The separate private booking/payment and trip-reschedule recipient paths were not broadened."
- **Consequence for every one of the task's required checks:**
  - Enabled inquiry subscriber without an account → **never reached** by a trip reschedule (only reachable via a manually-composed, separate Announcement).
  - Enabled registered customer without a booking → **never reached** (the query is scoped to `orders.trip_id = <this trip>`).
  - Customer already booked on the trip → reached, correctly, if `wants_announcements = true`.
  - Disabled/unsubscribed email → correctly excluded (the query filters `wants_announcements = true`), **but** note `unsubscribe_email_updates()` (the RPC behind the public unsubscribe link) does flip `profiles.wants_announcements` to `false` too, so an opt-out via the new unified flow does correctly suppress the old reschedule path — that part is consistent.
  - Duplicate email across inquiry/profile records → not applicable to this path, since it never reads `email_subscriptions`/`contact_inquiries` at all.
  - Overlap between the public broadcast and the booked-customer path → there is no overlap by design today: they are two entirely separate mechanisms with no shared trigger point. An admin who reschedules a trip and separately wants to notify the public would have to manually go create a new Announcement in the Announcements page — the system does nothing to prompt or connect that.
  - Private booking/payment details in the public broadcast → not at risk, since the general Announcements broadcast (which is the only one touching the broad audience) has no booking-specific content in its payload — it only sends `subject`/`content` typed by the admin.

**If the "agreed rule" is that a trip reschedule, when the admin chooses to email, should reach every enabled subscriber including inquiry-only ones — this is not implemented anywhere in the live system.** The only way to reach that full audience today is a manually authored Announcement, which is a distinct admin action, not a reschedule option.

---

## E. Workflow matrix

| Workflow | Environment / method actually used | Result |
|---|---|---|
| Deployment/commit consistency | Live Git remote + live frontend SW timestamp comparison | **Passed** — frontend build ≈ fix commit, ±27s |
| Financial-report RPC deployed + auth-gated | Live PostgREST, anon + fresh authenticated non-admin | **Passed** (auth gate); **Blocked** for full admin execution (invalid E2E admin credential) |
| Announcement broadcast tables/RPC schema deployed | Live PostgREST schema fingerprinting | **Passed** |
| Announcement worker logic (mocked/PGlite) | Direct re-run of `broadcast-announcement-worker-test.mjs`, `announcement-broadcast-pgtest/run.mjs` on this commit | **Passed** |
| Booking-draft isolation (code) | Static read of `bookingDraft.js`, `AuthContext.jsx`, plus re-run of `booking-dirty-state-contract-test.mjs` | **Passed** (code-level); **Untested** live-browser |
| Validation gate (`npm run check`) | This checkout, this commit | **Failed** — new portability bug (N-1), unrelated to the seven original findings |
| Validation gate, per-suite bypass | Every script in the chain run individually | **Passed**, all of them |
| Edge Functions reachable | Live `OPTIONS` requests | **Passed** (with noted local-network flakiness on some attempts) |
| Customer registration + legal consent version match | Live signup API, two synthetic accounts | **Passed** |
| Authenticated-customer RLS scoping | Live REST as synthetic customer: own profile read, empty `orders` list, rejected `get_financial_report_data`, rejected `admin_set_email_subscription` | **Passed** |
| Trip-reschedule → public/all-subscriber email rule | Full code trace of trigger + Edge Function + migration comments | **Failed** — confirmed still limited to booked, opted-in customers on that trip (Section D) |
| Report print/PDF visual output (blank pages, clipped columns, filename, totals) | None — no browser tool available this session | **Untested** |
| Customer/admin browser workflows (login, booking form, pickup/weight/discount, payments, delivery, feedback, push toggle, inquiry form) | None — no browser tool available this session | **Untested** |
| Real two-connection Postgres concurrency (payment/refund/broadcast claims) | None — no direct DB credential, management API 401 | **Untested**, same gap the original audit had |
| Real email/push delivery | None — no designated test mailbox/device supplied, correctly not attempted per audit rules | **Untested by design** |
| Cross-account IDOR (Customer A vs. B on real order/payment/proof data) | Partial — verified a fresh account sees zero orders/others' data via RLS; did not create two accounts with real bookings to test cross-order access, to keep footprint minimal | **Partially tested** |

---

## F. New and remaining findings

### N-1 — `npm run check` fails on this exact machine/folder due to a Windows path-resolution bug (New)

- **Severity:** Medium-High (demo-readiness), **Category:** engineering/tooling
- **New/recurring/mismatch:** New — not one of the original seven findings, and not caused by the fix commit's changes to those seven areas.
- **Evidence level:** Reproduced directly, twice (once inside `npm run check`, once isolated).
- **Affected:** `scripts/payment-refund-pgtest/run.mjs:8`, and 11 siblings: `contact-details-lock-pgtest/run.mjs`, `contact-details-lock-pgtest/trigger-bypass-run.mjs`, `delivery-cash-payment-pgtest/run.mjs`, `featured-shipments-pgtest/run.mjs`, `legacy-rpc-overload-cleanup-pgtest/run.mjs`, `payment-ledger-pgtest/run.mjs`, `payment-notification-pgtest/run.mjs`, `payment-refund-recovery-pgtest/run.mjs`, `photo-gallery-pgtest/run.mjs`, `service-area-mass-assignment-pgtest/run.mjs`, `shipping-discount-pgtest/run.mjs`.
- **Repro:** run `npm run check` (or `npm test`) from this literal project folder.
- **Expected:** the gate runs to completion.
- **Actual:** stops at `payment-refund-pgtest` with `ENOENT` on a doubled/mis-decoded path (`C:\C:\Users\...\KAY%20BEAAAA%20TOOOOO!!!\...`), because `path.dirname(new URL(import.meta.url).pathname)` leaves the URL's percent-encoding and leading slash intact instead of using `fileURLToPath(import.meta.url)`.
- **Impact:** on any Windows checkout whose path has a space or special character — including this actual thesis folder — the mandated pre-deploy gate cannot be trusted to run end-to-end. It does **not** indicate the underlying suites are broken (all pass individually), but it does mean nobody can currently get a genuine green `npm run check` from this folder without either renaming the folder or patching the 12 scripts.
- **Smallest fix:** in each of the 12 files, replace `path.dirname(new URL(import.meta.url).pathname)` with `path.dirname(fileURLToPath(import.meta.url))` (`import { fileURLToPath } from 'node:url'`) — the exact pattern already used correctly elsewhere in the newer suites (e.g. `financial-report-pgtest`, `announcement-broadcast-pgtest`).
- **Verification needed after fixing:** re-run `npm run check` from this same folder path and confirm exit 0.

### N-2 — Trip-reschedule email is not connected to the full-subscriber audience (Recurring / deployment-confirmed gap)

- **Severity:** Medium (functional/requirements gap, not a security issue)
- **Category:** correctness / requirements
- **New/recurring/mismatch:** Recurring in effect — the original audit never separately called this out as its own finding (it was framed as part of F-03's general reliability concerns), but the task's own item 3 treats it as a distinct requirement, and it is confirmed still unmet on the live system.
- **Evidence level:** CONFIRMED — direct code/migration reading of the deployed commit, corroborated by the fix migration's own authoring comments.
- **Affected:** `src/components/ui/RescheduleTripModal.jsx`, `supabase/migrations/20260910020000_trip_reschedule_email_trigger.sql`, `supabase/functions/email-trip-reschedule/index.ts`.
- **Expected (per task item 3):** when an admin reschedules a trip and chooses to notify by email, all enabled subscribers — including inquiry-only subscribers with no booking — should be eligible.
- **Actual:** there is no sending-choice UI at all; the automatic email always fires and is hard-limited to customers with an active booking on that trip who have `profiles.wants_announcements = true`.
- **Impact:** if the panel or stakeholders expect the broadened audience rule to apply to reschedules specifically (not just to manually-composed Announcements), the current system will visibly under-deliver in a live demo — e.g., an inquiry-only test subscriber will never receive a reschedule notice no matter what is toggled.
- **Smallest fix:** this needs a product decision first (does "reschedule notice" mean the narrow per-trip courtesy email, the broad Announcements-style broadcast, or both?), then either (a) leave the two paths intentionally separate but add an explicit admin control on reschedule that also creates/sends a broad Announcement, or (b) repoint `email-trip-reschedule` to read from `email_subscriptions` for a public/general notice while keeping the current per-trip one for booked customers specifically.
- **Verification needed after fixing:** re-run the full item-3 checklist (inquiry-only, no-booking, booked, unsubscribed, duplicate-email cases) against staging.

### N-3 — Announcement status line omits a "not yet attempted" count (New, low severity)

- **Severity:** Low, **Category:** UX clarity / hardening
- **Evidence level:** PLAUSIBLE (static code reading only, not observed live in a real admin session)
- **Affected:** `src/pages/admin/AnnouncementsPage.jsx:378`
- **Expected:** an admin can tell at a glance whether a >25-recipient broadcast still has recipients that were never attempted.
- **Actual:** the status string only reports accepted/retryable/failed+review counts; a large batch's untouched `pending` recipients are invisible in that string (though the overall `status` word correctly reads `partial`, and the "Retry unfinished emails" button correctly stays visible).
- **Impact:** minor — no data is misrepresented as complete, but an admin skimming the line alone could underestimate how much sending remains.
- **Smallest fix:** add a `pending` count to the status string, or show `X of Y recipients processed`.
- **Verification needed:** none blocking; cosmetic.

### N-4 — Uncommitted local doc reorganization in the working tree (Info only)

`git status` shows `EMAIL_UPDATES_SUBSCRIPTION_FEATURE.md` and `FINANCE_REFUND_RECONCILIATION_AUDIT.md` deleted from the repo root and present as untracked files under `audit_reports/`. This predates this audit (not caused by it) and has no bearing on the deployed system, but flagging it so the move isn't accidentally lost — it's currently un-staged.

---

## G. External integrations actually verified

| Integration | What was actually done | Evidence level |
|---|---|---|
| Supabase Auth (signup, session issuance) | Two real signups against the live project; one correctly rejected (missing legal consent), one succeeded with a real session/JWT | Direct, live |
| Supabase PostgREST (RLS, RPC grants) | Multiple live anon and authenticated calls against real tables/RPCs | Direct, live |
| Vercel hosting | Live HTTP fetch of the production domain and its service worker | Direct, live |
| Resend (email provider) | **Not exercised.** No designated test mailbox was supplied, and broad/real sends are explicitly out of scope. | Not attempted (by design) |
| Firebase/FCM push | **Not exercised.** No designated test device was supplied. | Not attempted (by design) |
| PayMongo | **Not exercised.** No payment/refund was initiated; only confirmed the `paymongo-create-payment` and `paymongo-webhook` functions respond to requests at all. | Existence-only, live |
| Supabase Management API | Attempted, returned 401 (same as original audit) | Direct, live (of the failure) |

---

## H. Exact remaining staging/manual checks

1. **Fix or replace the E2E admin credential** (`E2E_ADMIN_EMAIL`/`E2E_ADMIN_PASSWORD` in `.env`) and re-run `get_financial_report_data`/`get_sales_overview_data` as a real admin against known fixtures, reconciling totals, boundaries, refunds, and payment methods.
2. **Decide and re-verify the reschedule-email rule** (Section D / N-2) against whatever the actual agreed behavior should be.
3. **Patch the 12 `import.meta.url` path-resolution scripts** (N-1) and re-run `npm run check` from this same folder to get a genuine green gate here.
4. Run the full E2E Playwright suite (`npm run test:e2e`) once the admin credential is fixed — it was not run in this audit because it creates live stateful records (trip/customer/booking/payment) against the shared project, which this audit was told to avoid without a confirmed staging target.
5. Real browser pass: mobile nav, login/session refresh/logout, booking form validation, admin booking detail, pickup weight/discount calculation, partial/full payment UI, shipment progression, feedback/featured display, Sales Overview/Unpaid Shipments, date-range report generation, push notification settings, inquiry form + email preference toggle — none of this was reachable without a browser tool in this session.
6. Report print preview and PDF export: open on a real device/browser and check for blank pages, clipped columns, correct row inclusion, filename, and totals matching the on-screen report.
7. Two-connection real-Postgres concurrency test for payment/refund reservation and broadcast claim locking (needs a disposable staging DB with a direct connection string — this audit had neither).
8. A controlled-recipient live send test for the announcement broadcast (needs a designated test mailbox/domain) to see real Resend acceptance vs. actual inbox delivery, which are different evidence levels.
9. Cross-account IDOR test with two real customer accounts each holding an actual order/payment/proof, run against isolated synthetic data on a staging project.

---

## I. Concise defense rehearsal script

1. Show `git log -1` and the live site's `/sw.js` `CACHE_VERSION` side by side to demonstrate the deployed build matches the presented commit (as done in this audit).
2. Log in as the fixed admin test account (once its credential is repaired) and generate one empty-range and one populated-range financial report; show no SQL error, and manually add one payment + one refund in the fixture data to reconcile against the report total live.
3. Print/export that same report and visually confirm no blank pages, no clipped columns, and the period/snapshot labels described in F-07.
4. In one browser tab: fill in a booking draft with clearly fake sender/receiver details as "Customer A," log out, sign in as "Customer B" in the same tab, and show the form is empty.
5. Book, weigh, discount, and partially pay one isolated test shipment as a customer + admin pair; click the payment button twice to show no duplicate ledger row.
6. Reschedule a test trip that has one booked, opted-in test customer and observe the automatic per-trip email path fire (do this against a designated test inbox only) — while being upfront that this path does **not** currently reach inquiry-only subscribers, per Section D.
7. Compose a real Announcement with "Send email" checked to a small set of designated test addresses (inquiry-only and registered) to demonstrate the broader `email_subscriptions` audience does work — and simulate one failure/unsubscribe to show the truthful `partial` status and "Retry unfinished emails" behavior.
8. Run `npm run check` live from a folder path with no spaces (or after applying the N-1 fix) and show a genuine green result.

---

## Final answers

**1. What could currently interrupt the defense?**
Two things concretely, both reproduced today: (a) `npm run check` fails in this exact project folder due to a newly found Windows path bug (N-1) — if asked to run it live from this folder, it will fail, even though the underlying fixes are sound; (b) if the reschedule-email rule (Section D) is demonstrated or questioned as "all subscribers get reschedule notices," the live system will visibly not do that for anyone without a booking on the rescheduled trip.

**2. Which fixes are necessary before the demo?**
- Patch the 12 scripts' path resolution (N-1) so the gate can actually be shown passing from this machine.
- Either fix the demo script to avoid claiming the broadened rule applies to trip reschedules specifically, or implement the missing connection (N-2) if the panel expects it.
- Repair the E2E admin credential so the Reports RPC can be demonstrated with a real admin session rather than only its rejection path.

**3. Which workflows were verified on the deployed system?**
Live, direct evidence: deployment/build identity, both fix migrations' presence (via schema/grant fingerprinting), the financial-report RPC's authorization gate (anon and real authenticated non-admin), announcement broadcast schema, customer registration + legal-consent version matching, and RLS scoping for a fresh authenticated customer (own profile visible, others' data not, admin RPCs rejected). Local-checkout evidence: every individual test in the `npm test`/`npm run check` chain (bypassing N-1), the production build, and the PWA precache check.

**4. Which still need testing?**
Everything requiring a real browser (all listed UI workflows, print/PDF visual inspection), everything requiring the repaired admin credential (real report execution/reconciliation, full E2E suite), everything requiring a designated test mailbox/device (real email/push delivery), and true multi-connection Postgres concurrency (needs a direct staging DB connection this audit did not have).

**Demo-readiness assessment:** the deployed backend fixes for F-01 and F-03 have strong, direct, live evidence behind them, and the frontend build is current. The system is **not** yet demonstrably complete against the specific reschedule-broadcast requirement in Section D, and the release gate cannot currently be shown green from this exact machine without the N-1 patch. Neither of these is a security hole; both are credible, fixable blockers to a clean demonstration. No claim is made here that the system is free of further errors beyond what was actually exercised above.
