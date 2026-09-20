# CargoExpressPH System Bug and Security Fix Report

**Implementation date:** 2026-09-16 (Asia/Manila)  
**Repository baseline:** `main` at `6ee6a73` when work began  
**Scope:** local source, isolated PGlite databases, mocked provider calls, build and contract tests  
**Deployment status:** not deployed; production and live Supabase state were not changed or verified

## Simple Taglish result

Na-implement locally ang confirmed fixes for reports, booking-draft privacy, announcement email reliability, validation gate, at report wording. Ang financial report RPC now executes with real fixture data instead of returning fake zeroes. Ang booking drafts ay naka-scope na sa signed-in user at binubura sa logout, kaya hindi makikita ni Customer B ang draft ni Customer A sa parehong tab.

Ang announcement email flow ay may durable job at recipient records na ngayon. Isang worker lang ang puwedeng mag-claim ng active job, bawat recipient ay may sariling outcome at stable Resend idempotency key, at `emailed_at` ay mase-set lang kapag lahat ay accepted o safely skipped. Kapag uncertain ang provider response o nag-fail ang database write pagkatapos ng provider acceptance, mare-retry ang parehong saved payload at key habang valid pa ang provider window. Hindi na nagpapadala kapag failed ang consent recheck.

Local fixes and tests lang ang result na ito. Walang migration o Edge Function na dineploy, walang totoong email/payment/refund na ginawa, at hindi nito pinapatunayang secure o fixed na ang production system.

## Finding status

| Finding | Status | Local result |
|---|---|---|
| F-01 Financial report SQL crash | **Fixed locally** | Forward migration removes the invalid unused CTE; executable PGlite tests invoke both report RPCs and pass. |
| F-02 Booking draft privacy | **Fixed locally** | Draft keys are user-scoped, legacy global drafts are discarded, logout clears the signed-out user's draft, and account changes cancel stale autosaves/reset memory. |
| F-03 Announcement broadcast reliability | **Fixed locally; live provider behavior unverified** | Durable job/recipient state, atomic leases, stable keys/payloads, truthful completion, safe retry, consent recheck, expiry recovery, and admin retry UI are implemented and tested with mocks/PGlite. |
| F-04 Validation gate | **Fixed locally** | Header semantics, renamed-page test/CSS, report tests, announcement tests, and behavior-based PWA font verification are in the gate. |
| F-05 Stale schema snapshot | **Partially fixed** | Snapshot is prominently labeled historical/non-authoritative and migrations are documented as deployment authority. Regeneration remains incomplete because Docker and local PostgreSQL are unavailable. |
| F-06 Optional PayMongo hardening | **Still open by instruction** | No webhook timestamp or live/test signature changes were made. This remains a separate hardening recommendation, not a demonstrated double-credit exploit. |
| F-07 Period events vs current balances | **Fixed locally as a clarification** | Screen and print/PDF distinguish period payment/refund events from current booking values and show a snapshot timestamp. No historical accounting engine was fabricated. |

## F-01 — Financial report RPC

### Root cause

`get_financial_report_data` contained an unused `method_agg` CTE with aggregate and non-aggregate columns but no `GROUP BY`. PostgreSQL deferred planning the PL/pgSQL statement until invocation, so the migration could create the function even though every report call failed.

### Implementation

- Added `supabase/migrations/20260916160000_fix_financial_report_runtime.sql` as an append-only corrective migration. The prior migration was not edited.
- Replaced only `get_financial_report_data`, removed the invalid CTE, and preserved admin authorization, JSON response shape, event timestamp filters, successful-refund rules, current delivered-booking values, and grants.
- Added `scripts/financial-report-pgtest/run.mjs` and included it in `npm test`.

### Regression coverage

The test applies both the original report migration and the forward fix, then executes `get_financial_report_data` and `get_sales_overview_data`. It verifies an empty database, cash and GCash, exclusion of `paylater`, successful versus pending/failed refunds, a payment whose booking was created before the range, inclusive start/exclusive end boundaries, exact summary/method/daily values, delivery snapshot values, and rejection of a non-admin caller.

## F-02 — Account-scoped booking drafts

### Root cause

Names, phone numbers, Facebook names, addresses, parcel details, and notes were written to global `booking_form`/`booking_step` session keys. Logout preserved those keys, and the next account mounted the same values.

### Implementation

- `src/lib/bookingDraft.js` now uses `cargoexpress.booking-draft.v2:<user-id>:form|step` keys and refuses to read or write without an authenticated user ID.
- Legacy unscoped keys are deleted without assigning their data to any account.
- `src/contexts/AuthContext.jsx` clears only the signed-out user's booking draft plus the legacy keys. Unrelated browser storage remains untouched.
- `src/pages/customer/BookShipmentPage.jsx` starts clean, waits for a resolved user ID, restores only that user's draft, resets form state on account changes, and guards delayed autosave with both timer cancellation and the current user reference.
- Same-user refresh/resume remains supported. One-time route/trip suggestions remain intact for the account that opened the page and are not carried into a later account switch.

### Regression coverage

`scripts/booking-dirty-state-contract-test.mjs` verifies all 21 sensitive fields, legacy-key deletion, A/B isolation, session-expiration behavior, account-scoped logout cleanup, no unauthenticated save/restore, preservation of unrelated scoped state, and same-user refresh.

## F-03 — Durable announcement email delivery

### Root cause

The previous function used one `emailed_at` flag around a non-atomic batch operation. Concurrent requests could both send, provider failures were still marked complete, a failed final database update could resend everyone, and a failed consent recheck fell back to a stale recipient list.

### Provider behavior used

Resend documents idempotency on both `POST /emails` and `POST /emails/batch`. Keys are sent through `Idempotency-Key`, can be at most 256 characters, and are retained for 24 hours. A concurrent use returns `409 concurrent_idempotent_requests` and is safe to retry later; using the same key with a different payload returns `409 invalid_idempotent_request` and must not be blindly retried. Sources: [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys), [Resend errors](https://www.resend.com/docs/api-reference/errors), and [send batch email API](https://resend.com/docs/api-reference/emails/send-batch-emails).

### Implementation

- Added `supabase/migrations/20260916161000_durable_announcement_broadcasts.sql`.
- `announcement_email_broadcasts` stores the snapshotted subject/content/sender, job lease, truthful status, counts, and completion timestamp.
- `announcement_email_recipients` stores one recipient outcome, attempt/lease data, stable UUID idempotency key, exact provider payload, provider message ID, and safe error state.
- Service-role-only `SECURITY DEFINER` RPCs atomically claim the announcement, claim recipients with `FOR UPDATE SKIP LOCKED`, persist the exact payload before sending, record outcomes, recover expired claims, and finalize counts/completion in one transaction.
- `announcements.emailed_at` is written only when all snapshot recipients are `accepted` or `skipped`. Retryable, permanent-failure, and needs-review rows keep the announcement incomplete.
- The Edge Function rechecks the authoritative `email_subscriptions` row immediately before each send. A check error records a retryable outcome and sends nothing; an opt-out records `skipped`.
- Each recipient uses individual `POST /emails` with its persisted payload and stable key. Network/timeouts, 408, 429, 5xx, and concurrent-idempotency conflicts remain retryable. Payload conflicts require review; definitive 4xx failures are recorded without looping.
- Expired uncertain sends are retried with the same key only inside a conservative 23-hour window. Older uncertain sends become `needs_review`, avoiding a blind resend after Resend's documented 24-hour retention.
- The admin announcement page displays accepted/retryable/review counts and offers **Retry unfinished emails**. Already accepted/skipped recipients are never selected again.
- Recipient selection still comes only from all enabled `email_subscriptions`, including inquiry subscribers without bookings. The separate private booking/payment and trip-reschedule recipient paths were not broadened.

### Regression coverage and limits

- `scripts/broadcast-announcement-worker-test.mjs` injects a mocked provider/database adapter and verifies concurrent requests, partial provider failure, retry of only the failed recipient, stable key and identical payload after timeout uncertainty, consent-check failure with zero provider calls, completion-write failure after acceptance, and Resend 409 classifications.
- `scripts/announcement-broadcast-pgtest/run.mjs` applies the actual migration and verifies active-lease exclusion, per-recipient outcomes, stable retry keys, payload persistence, incomplete versus completed state, expired-claim recovery, old uncertainty moving to review, and transaction rollback when the final `announcements.emailed_at` write fails.
- PGlite is a single embedded PostgreSQL backend. Docker and a local PostgreSQL server are unavailable, so true multi-session PostgreSQL concurrency was not run. Concurrency is covered by the executable worker mock plus the database row-lock/lease implementation and sequential database claim assertions.
- No real email was sent. Resend acceptance, rate limiting, dashboard reconciliation, and deployed secret configuration remain unverified.

## F-04 — Validation gate

- Added `scope="col"` to report table headers and repaired all `<thead>` markup.
- Updated the stale mobile-layout contract to read `UnpaidShipmentsPage.jsx`; renamed its matching CSS selectors from `unsettled-*` to the current `unpaid-*` component classes.
- Updated the PWA check to require a local Inter `@font-face`, at least one emitted WOFF/WOFF2 asset, and every emitted font in the service-worker precache. It no longer assumes a fixed number of font files.
- Restored the lockfile-declared `@fontsource-variable/inter` package to local `node_modules`; this changed no tracked dependency file. A clean install from `package-lock.json` provides the same dependency.
- Added the financial and announcement regression suites to `npm test` rather than leaving them as optional commands.

## F-05 — Schema authority

`supabase/schema.sql` was not regenerated or selectively patched. Its header now says it is a historical 2026-09-01 snapshot and must not be used for deployment/rebuild. `README.md` and `CLAUDE.md` identify ordered migrations as the deployment authority.

The Supabase CLI is installed, but Docker and `psql`/local PostgreSQL are unavailable. Therefore the required disposable full migration environment, extensions, schema dump, and drift comparison could not be produced honestly. A future regeneration should use an empty disposable Supabase instance, apply every migration in order, dump tables/functions/signatures/policies/triggers/constraints/grants, replace the snapshot as one generated artifact, then repeat the migration-and-diff command in CI.

## F-07 — Report labels

The report screen and print document now label gross collections, refunds, net collections, method totals, and detail events as belonging to the selected period. Delivered booking rows are labeled **Current Financial Snapshot**, show the generation timestamp, and explicitly state that their current charge/paid/balance values are not expected to total to the selected-period event collections.

## Changed files

### Database and server

- `supabase/migrations/20260916160000_fix_financial_report_runtime.sql`
- `supabase/migrations/20260916161000_durable_announcement_broadcasts.sql`
- `supabase/functions/broadcast-announcement/index.ts`
- `supabase/functions/_shared/announcement-broadcast-worker.ts`

### Application

- `src/lib/bookingDraft.js`
- `src/contexts/AuthContext.jsx`
- `src/pages/customer/BookShipmentPage.jsx`
- `src/lib/database.js`
- `src/pages/admin/AnnouncementsPage.jsx`
- `src/pages/admin/ReportsPage.jsx`
- `src/styles/tables-mobile.css`
- `src/styles/admin-modern-refresh.css`

### Tests and release gate

- `scripts/financial-report-pgtest/run.mjs`
- `scripts/announcement-broadcast-pgtest/run.mjs`
- `scripts/broadcast-announcement-worker-test.mjs`
- `scripts/booking-dirty-state-contract-test.mjs`
- `scripts/unsettled-mobile-layout-contract-test.mjs`
- `scripts/pwa-offline-contract-test.mjs`
- `package.json`

### Documentation

- `supabase/schema.sql`
- `README.md`
- `CLAUDE.md`
- `SYSTEM_BUG_SECURITY_FIX_REPORT.md`

Unrelated pre-existing untracked reports, patches, reject/original files, and helper scripts were preserved.

## Tests actually run

| Command / suite | Result |
|---|---|
| `npm run test:financial-reports` | Passed: both RPCs, exact fixture totals, boundaries, refund states, and authorization. |
| `npm run test:announcement-broadcast` | Passed: mocked provider worker plus migration/RPC tests. |
| `node scripts/booking-dirty-state-contract-test.mjs` | Passed: 21 protected draft fields and account isolation contracts. |
| `node scripts/unsettled-mobile-layout-contract-test.mjs` | Passed against `UnpaidShipmentsPage.jsx` and current CSS. |
| `node scripts/axe-lint.mjs` | Passed: 161 files. |
| `npm run test:edge-functions` | Passed: 18 Edge Functions bundled. |
| `npm run build` | Passed after restoring the lockfile-declared font dependency; emitted two local Inter WOFF2 files. |
| `npm run test:pwa-offline` | Passed: 71 JS/CSS/font assets precached, including both emitted Inter files. |
| `npm run check` | **Passed end to end** after restoring the lockfile-declared font dependency: application tests, 18 Edge Function builds, 9 browser-fallback assertions, production build, and PWA precache checks. The first run had correctly exposed the incomplete local dependency install at the final PWA step. |

All database tests used temporary in-memory PGlite databases. Provider tests used mocks. No production/staging records or external side effects were used.

## Unverified behavior and remaining risks

- Nothing is deployed. The prior read-only management requests returned HTTP 401, so live migration/function versions remain unknown; access controls were not bypassed.
- No real Resend request was made. The implementation follows current official documentation, but live account/domain/API-key behavior needs staging verification.
- True multi-session PostgreSQL locking was unavailable locally. Run a two-connection staging test before relying on high-volume concurrency.
- Broadcasts process at most 25 recipient attempts per invocation to stay inside Edge Function time limits. Larger lists remain in truthful `partial` state and require another admin retry invocation for the next chunk. Retryable provider/consent failures respect a delay; accepted recipients remain excluded.
- Report screen and print/PDF wording compiled successfully, but authenticated fixture-based browser/print visual inspection was unavailable and remains unperformed.
- The full schema snapshot is still stale by design and prominently labeled accordingly.
- F-06 remains separate optional PayMongo webhook hardening.

## Ordered deployment steps

1. Create a database backup and use a staging project first. Confirm all earlier migrations through `20260916152000` are present.
2. Apply `20260916160000_fix_financial_report_runtime.sql`, then run both report RPCs as an admin and a non-admin with known staging fixtures.
3. Apply `20260916161000_durable_announcement_broadcasts.sql`. Verify the two tables, five RPC signatures, RLS, function grants, and service-role execution.
4. Deploy `broadcast-announcement` together with `_shared/announcement-broadcast-worker.ts`. Confirm `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and `UNSUBSCRIBE_SIGNING_SECRET` in staging.
5. Deploy the SPA after both migrations and the Edge Function. The new announcement query expects the broadcast-status relationship, so database-first order matters.
6. Run `npm ci && npm run check` from a clean checkout using the deployment commit.
7. Execute the staging rehearsal below with safe test subscribers. Review database recipient rows and provider logs before production rollout.
8. Repeat database migration, Edge Function, then SPA deployment in production. Verify live behavior read-only after deployment; do not infer it from local success.

## Staging / defense rehearsal checklist

- Generate an empty report and a seeded cash/GCash/refund report; compare exact period totals and confirm a non-admin is rejected.
- Open report print preview and exported PDF; confirm period labels, snapshot timestamp, no misleading reconciliation, no clipped tables, and no blank pages.
- In one tab, enter Customer A contact/address data, log out, sign in as Customer B, and confirm the form is clean. Confirm A's draft resumes only on same-user refresh before logout.
- Send one announcement to controlled test addresses. Trigger two requests together; verify one active job, one accepted row per address, stable keys, and one provider email per recipient.
- Simulate/force one temporary failure and one unsubscribe; verify partial status, retry only the unfinished address, and skip the unsubscribed address.
- Confirm `emailed_at` remains null during any retryable/failed/review state and is set only after all rows are accepted/skipped.
- Run `npm ci && npm run check` and retain the output with the defense build.
