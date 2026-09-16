# CargoExpressPH System Bug and Security Audit

**Audit date:** 2026-09-16 (Asia/Manila)

**Scope:** repository at commit `6ee6a73` on `main`; isolated local build and tests; attempted read-only deployment metadata checks

**Mode:** audit only. No application code, configuration, migrations, deployed functions, database records, bookings, files, notifications, payments, or refunds were changed.

## A. Simple Taglish executive summary

May **isang high-priority demo blocker** sa bagong Reports & Analytics flow: ang database RPC na ginagamit ng page ay may invalid SQL. Na-reproduce ito locally gamit ang actual migration; pag nag-generate ng report, babagsak ang RPC sa PostgreSQL error tungkol sa `p.method` na wala sa `GROUP BY`. Ito ang unang dapat ayusin bago defense.

May dalawa ring importanteng privacy/reliability issues. Una, ang unfinished booking draft ay may sender/receiver names, phone numbers, Facebook names, at addresses sa unscoped `sessionStorage`; hindi ito binubura sa logout. Sa shared device/tab, puwedeng makita ng susunod na account ang naunang customer's draft. Pangalawa, ang announcement email broadcast ay hindi transaction-safe: sabay na requests can send duplicates, habang provider failures are still followed by `emailed_at`, making failed recipients impossible to retry from the normal flow.

Hindi pumapasa ang required `npm test` / `npm run check` gate. It stops on 19 accessibility errors; a later test also references a renamed/deleted page, and the PWA test expects two font files although the current variable-font build emits one. The production build itself passed in an isolated checkout, as did the inspected payment, refund, ownership, storage, notification, and most database regression suites.

The strongest server-side defenses are present in repository code: RLS owner checks, database-derived roles/prices/payment totals, admin checks inside privileged RPCs and Edge Functions, private evidence storage, signed PayMongo webhooks, amount/ownership checks, idempotency keys, row locks, and an append-only refund ledger. No confirmed customer-to-customer IDOR, privilege escalation, arbitrary payment-status write, SQL injection, XSS, SSRF, command injection, or committed secret was found in the repository paths reviewed.

**Deployment warning:** the available Supabase management credential returned HTTP 401 and the configured app URL is localhost. I therefore could not verify which migrations/functions are actually deployed. Repository findings are not proof that production has the same state.

## B. Architecture and trust boundaries

### Repository state reviewed

- Branch: `main`, at `6ee6a73`, matching the local `origin/main` reference.
- Relevant recent history: `b31f11c` introduced the sales/report rewrite and financial RPC; `21ce68e` corrected its dollar quoting; `6ee6a73` added audit documents and an instant-push migration. F-01 remains in the current head after those changes.
- The tracked working tree was unchanged when the audit began. It already contained unrelated untracked reports, patch/reject/original files, and helper scripts; they were not read as authoritative deployment state and were not modified. This audit added only `SYSTEM_BUG_SECURITY_AUDIT.md` in the repository.
- Tests and builds ran in `/tmp/cargoexpress-audit.ne9Ybk`, populated from `git archive HEAD`, so generated `dist` output and temporary harnesses did not alter the repository checkout.
- Local `.env` exists and is ignored by Git. Only variable names and public origins were inspected; secret values and full tokens were neither printed nor placed in this report.

### System shape

- React/Vite SPA with public, customer, and admin routes.
- Supabase Auth issues browser sessions; `profiles.role` is the application role.
- PostgreSQL/PostgREST is the main security and business-rule boundary: RLS, triggers, constraints, and `SECURITY DEFINER` RPCs.
- Supabase Storage stores shipment evidence in a private `cargo-photos` bucket; selected website assets/features have narrow public-read policies.
- Edge Functions hold PayMongo, Firebase, Resend, service-role, VAPID, and management secrets.
- PayMongo source creation begins in the browser with a publishable key; capture, reconciliation, refunds, and webhook handling run server-side.
- Firebase/FCM/Web Push deliver notifications. Resend sends announcement and reminder email.

### Public boundary

Public functionality includes tracking RPCs, public company information, public feedback/featured deliveries, legal documents, trips, inquiry submission, and signed unsubscribe links. Public tracking uses a masking RPC rather than direct order-table access. Inquiry submission runs through an Edge Function which validates types/lengths and writes server-derived IP data; direct table reads are admin-only in the schema snapshot.

### Customer boundary

Customers read their own profiles, bookings, status events, messages, feedback, payment attempts/refunds, notification rows, device registrations, and shipment evidence. Order insertion is limited by RLS and rewritten by triggers: tracking number, role-sensitive fields, weight, price, payment fields, discounts, and proof arrays are server controlled. Payment creation reloads the order with service-role access, then explicitly verifies `order.user_id` against the authenticated caller before accepting a customer payment.

### Admin boundary

Admin UI routes are only a UX gate. Repository authorization is repeated in database policies/RPCs and Edge Functions for trips, orders, reports, customer directory, inquiries, feedback, announcements, storage operations, payment collection, and refunds. Financial RPCs lock the order, derive payable values, restrict methods, require evidence, cap collection/refund amounts, and use idempotency keys.

### Storage and integrations

`cargo-photos` is declared private with a 5 MB limit and image MIME allow-list. Owner reads are tied to the authenticated user's order and path; featured/public reads require designated paths. Firestore fallback functions validate document paths and authorize admin, owner, or the exact selected public feature. The browser storage helper does return a public URL after a signing failure, but private evidence remains protected by the bucket/policies; this is a failed-image behavior, not a confirmed public disclosure.

## C. Prioritized confirmed findings

### F-01 — Reports & Analytics RPC fails at execution time

- **Severity:** High
- **Classification:** Confirmed functional bug
- **Evidence level:** Reproduced locally against the actual migration in embedded PostgreSQL
- **Fix timing:** **Fix before the defense**
- **Affected role:** Admin
- **Affected locations:** `supabase/migrations/20260916140000_financial_report_rpc.sql:52-64`; `src/lib/database.js:2325-2345`; `src/pages/admin/ReportsPage.jsx:58-70`

**Preconditions:** The migration exists/applies, an admin opens Reports & Analytics, chooses dates, and generates a report.

**Execution path:** `ReportsPage.loadReport()` calls `getFinancialReportData()`, which invokes `get_financial_report_data`. The RPC's `WITH` list contains `method_agg`, selecting `p.method` and `r.method` beside aggregates without a `GROUP BY`. Although `method_agg` is unused later, PostgreSQL plans the whole query when the PL/pgSQL statement executes.

**Local reproduction:** I created only the tables/functions required by the migration, applied the migration verbatim, and executed:

```sql
select get_financial_report_data(now() - interval '1 day', now() + interval '1 day');
```

Actual error:

```text
column "p.method" must appear in the GROUP BY clause or be used in an aggregate function
```

**Expected:** A JSON report containing collections, refunds, daily totals, method totals, and completed deliveries.

**Actual:** The RPC raises an error; the admin page shows report generation failure and cannot print/export the report.

**Impact:** The main defense demo workflow for date-range financial reporting is broken in the repository implementation. If this function version is deployed, it is broken live too. Deployment could not be verified.

**Smallest fix:** Delete the unused `method_agg` CTE. `method_union` and `method_totals` already implement the intended aggregation.

**Verification test:** Add a PGlite test that applies the migration and actually calls both RPCs with (1) no rows, (2) payment rows in two methods, and (3) a refund. Assert exact JSON totals and date boundaries. Merely checking that `CREATE FUNCTION` succeeds is insufficient because PL/pgSQL defers planning this statement until execution.

### F-02 — Booking drafts leak customer contact/address data across logout on a shared tab

- **Severity:** Medium
- **Classification:** Confirmed privacy bug
- **Evidence level:** Static-code finding with deterministic browser-storage path
- **Fix timing:** **Fix before the defense**
- **Affected roles:** Customer; the next person/account using the same browser tab
- **Affected locations:** `src/lib/bookingDraft.js:4-25,34-53`; `src/pages/customer/BookShipmentPage.jsx:75-105,171`; `src/contexts/AuthContext.jsx:402-418`

**Preconditions:** Customer A enters any meaningful booking data, logs out without submitting/discarding it, and Customer B signs in using the same tab/session.

**Execution path:** The draft includes sender/receiver names, phone numbers, Facebook names, granular addresses, package description, landmarks, and notes. It is stored under global keys `booking_form` and `booking_step`. Logout intentionally preserves drafts and only removes two FCM session keys. `BookShipmentPage` then loads those global keys for whichever user is signed in.

**Expected:** A draft belongs only to the account that created it, or sensitive draft data is removed on logout/account switch.

**Actual:** The next account receives the previous account's full draft in its booking form.

**Impact:** Customer PII can be exposed on shared phones, shop computers, or account switching. The next customer could also accidentally submit the previous customer's shipment details.

**Smallest fix:** Key drafts by authenticated user ID (for example `booking_form:<uid>`) and clear the signed-out user's keys during logout. Clear/migrate the legacy unscoped keys once.

**Verification test:** With a fake `sessionStorage`, save a draft for user A, simulate logout/login as user B, mount the booking page, and assert no A fields render. Also assert A can resume only A's draft if that product behavior is retained.

### F-03 — Announcement broadcasts can duplicate sends and permanently suppress retries after failures

- **Severity:** Medium
- **Classification:** Confirmed reliability bug with external side effects
- **Evidence level:** Static-code finding; no email was sent during this audit
- **Fix timing:** **Fix before the defense** if email will be demonstrated; otherwise fix soon after
- **Affected role:** Admin; all opted-in recipients
- **Affected locations:** `supabase/functions/broadcast-announcement/index.ts:244-269,282-341`

**Preconditions:** An admin publishes/sends an announcement, and either two requests overlap, a provider batch fails, or the final database update fails after sends.

**Execution paths:**

1. Two requests can both read `emailed_at = NULL` before either finishes, then both send the same recipient batches.
2. A non-2xx Resend response or thrown provider call only increments `failed`; after the loop, the function still writes `emailed_at` and returns `success: true`. A retry then returns `already_sent`, so failed recipients cannot be retried normally.
3. The result of the final `announcements.update({ emailed_at })` is ignored. If email succeeds but that update fails, the next invocation can resend everyone.
4. If the immediate subscription recheck fails, the function deliberately sends to the original list; someone who opted out during that interval can still receive the message.

**Expected:** At-most-once processing per announcement/recipient, truthful success/failure state, and retry of only unsent recipients.

**Actual:** The single `emailed_at` flag cannot safely represent claim, per-recipient outcome, partial completion, or concurrency.

**Impact:** Duplicate promotional email, lost sends reported as completed, and avoidable mail after an opt-out. This is especially visible in a demo with repeated clicks or a flaky provider.

**Smallest fix:** Claim the announcement atomically before sending (database RPC/update with `WHERE emailed_at IS NULL` or a dedicated `sending` lease), persist per-recipient delivery/idempotency records, mark complete only when policy says the broadcast is complete, and never send a batch after a failed consent recheck.

**Verification test:** Mock Resend and issue two concurrent function calls; assert each recipient is sent once. Then fail one batch and assert the announcement remains retryable and only failed recipients are retried. Fail the completion update and assert a retry is deduplicated by recipient records.

### F-04 — The required validation gate is red; some tests no longer test existing code

- **Severity:** Medium
- **Classification:** Confirmed engineering/demo-readiness bug
- **Evidence level:** Reproduced locally in an isolated clean checkout
- **Fix timing:** **Fix before the defense**
- **Affected locations:** `package.json:8,24-25`; `src/pages/admin/ReportsPage.jsx:318-325,389-392,413-419`; `scripts/unsettled-mobile-layout-contract-test.mjs:4`; `scripts/pwa-offline-contract-test.mjs:27-32`

**Observed results:**

- `npm test` stops after `axe-lint` reports **19 missing `scope="col"` attributes**, chiefly in the new reports tables.
- Running later tests separately shows `unsettled-mobile-layout-contract-test.mjs` exits with `ENOENT` because it reads deleted/renamed `src/pages/admin/UnsettledDeliveriesPage.jsx`; the live page is `UnpaidShipmentsPage.jsx`.
- The isolated production build succeeds, but the PWA offline check fails because it requires at least two font assets. The current self-hosted variable font build emits one `.woff2`; this assertion no longer matches the implementation.
- Because `npm run check` starts with `npm run test`, it fails before edge builds, production build, and PWA verification in normal use.

**Expected:** The documented pre-deployment command provides a trustworthy green/red release gate.

**Actual:** It is always red on the audited commit, and one test points to nonexistent code. Developers can no longer distinguish a real regression from known gate failures.

**Impact:** Defense preparation and deployment validation are blocked or routinely bypassed. Bypassing the suite can hide real financial/authorization regressions such as F-01.

**Smallest fix:** Add proper table-header scopes; update the renamed-page test to the current component/classes; make the font assertion verify that a local Inter font exists and is precached, rather than requiring two files. Add an execution test for the report RPC.

**Verification test:** A clean isolated `npm run check` must return exit 0, with no network or production writes.

### F-05 — Canonical schema snapshot is materially behind current migrations

- **Severity:** Medium
- **Classification:** Confirmed repository integrity bug; deployment impact unverified
- **Evidence level:** Static-code finding
- **Fix timing:** Fix soon after; before using `schema.sql` for rebuild/recovery
- **Affected locations:** `supabase/schema.sql:2493,3425-3429`; migrations from `20260911010000` through `20260916152000`

**Evidence:** The file described as the full schema has the old 10-argument `record_delivery_payment`, contains no `payment_refunds`, `email_subscriptions`, `get_financial_report_data`, or `get_sales_overview_data`, and does not include several later refund/report/subscription policies and triggers. Current application code calls newer signatures/features.

**Preconditions:** A developer, evaluator, recovery procedure, or audit treats `schema.sql` as the effective database definition.

**Expected:** The canonical snapshot reconstructs the effective schema or is clearly labeled historical/non-authoritative.

**Actual:** It represents an earlier state and contradicts current application/migration behavior.

**Impact:** A rebuild from the snapshot can lack current financial tables/functions and restore stale grants. Static security review against the snapshot can also report false positives or miss newer controls. `supabase db push` may still work from migrations; that path was not run because it could affect the linked project.

**Smallest fix:** Regenerate the snapshot from a disposable database after applying every migration. Document migrations as the only deployment authority and add a drift check comparing a fresh migrated schema to the snapshot.

**Verification test:** Apply all migrations to an empty local Postgres and compare normalized tables, functions/signatures, policies, triggers, constraints, and grants against regenerated `schema.sql`.

### F-06 — PayMongo webhook signature accepts an unlimited-age signed payload

- **Severity:** Low
- **Classification:** Hardening recommendation
- **Evidence level:** Static-code finding; no confirmed financial exploit because ledger paths are idempotent
- **Fix timing:** Optional hardening
- **Affected location:** `supabase/functions/paymongo-webhook/index.ts:50-76,258-277`

The code verifies HMAC over `t.rawBody` and uses timing-safe comparison, but never checks whether `t` is recent. PayMongo's current guidance says the timestamp can be compared with current time as an additional security control. The handler also accepts either `te` or `li` rather than selecting the signature that matches the environment/event mode. See [PayMongo webhook setup and management](https://docs.paymongo.com/do/docs/developer-tools-webhook-setup-management) and [webhook best practices](https://docs.paymongo.com/docs/developer-tools-best-practices).

Replaying a genuine old signed event is substantially mitigated: payment reconciliation binds a provider payment/source and refund reconciliation binds a refund/payment with database idempotency and amount limits. I found no demonstrated way to double-credit or over-refund through replay. The remaining risk is future event handling that is not idempotent, extra provider capture attempts around chargeable-source events, and weaker incident containment if a signed payload is captured.

**Smallest fix:** Reject timestamps outside a short tolerance (commonly five minutes, allowing clock skew), validate numeric timestamp format, and select `te` or `li` according to the deployment/event mode. Continue relying on database idempotency as the primary replay defense.

**Verification test:** Generate a valid HMAC for a current payload and an hour-old payload; accept the current request, reject the old one, and prove repeated current payment/refund events remain database no-ops.

### F-07 — Report rows mix event-period totals with current order balances

- **Severity:** Low
- **Classification:** Confirmed misleading-report behavior
- **Evidence level:** Static-code finding
- **Fix timing:** Fix soon after
- **Affected locations:** `supabase/migrations/20260916140000_financial_report_rpc.sql:14-41,80-113`; `src/pages/admin/ReportsPage.jsx:309-345`

Payments/refunds and daily totals are filtered by their event timestamps. A completed delivery is filtered by its Delivered status-event timestamp, but its `amount_paid`, `payment_status`, and `balance` come from the current order row. For a shipment delivered during the selected period and paid or refunded later, the detail row reflects later/current state while the report's period collection totals exclude that later event.

The UI does label columns “Paid (Current)” and “Balance (Current),” which reduces ambiguity, so this is not a calculation corruption bug. It can still confuse a thesis panel comparing row totals with the date-scoped summary.

**Smallest fix:** Either make all detail financials as-of the period end using ledger events, or clearly separate “current snapshot” from “events in period” and avoid inviting row-to-summary reconciliation.

**Verification test:** Deliver an isolated fixture in period A, pay in period B, and assert the period-A report either shows the as-of-A balance or clearly labels/excludes current values from reconciliation.

## D. High-impact workflows checked and results

| Workflow / boundary | Evidence | Result |
|---|---|---|
| Clean production build | Isolated `git archive` checkout with placeholder public config | **Passed** |
| Dependency advisory scan | `npm audit --json`, 263 installed dependencies | **0 known vulnerabilities reported** at audit time; applicability still depends on deployed bundle |
| General smoke checks | `scripts/smoke-check.mjs` | **Passed** |
| Accessibility static gate | `scripts/axe-lint.mjs` | **Failed: 19 issues**, primarily report table headers |
| Edge Function compilation | `scripts/edge-function-build-test.mjs` | **Passed: 18 functions** |
| Payment ledger math/idempotency | Actual payment migrations in PGlite | **Passed: 52 tests** |
| Payment notification deduplication | Trigger/migration PGlite suite | **Passed: 41 tests** |
| PayMongo create-payment authorization | Contract tests plus code trace | **Passed locally**; ownership and amount checks present |
| Refund request/provider/recovery | Contract and PGlite suites | **Passed locally:** request and provider checks; 14 refund ledger tests; 22 recovery tests |
| Discounted pickup/delivery/additional payment | Migration/code trace and domain PGlite suites | **Passed: 92 tests**; old reports F-002/F-004 are addressed by later migrations |
| Delivery cash payment | Domain PGlite suite | **Passed: 47 tests** |
| Contact details lock | Normal and trigger-bypass PGlite suite | **Passed: 8 tests in the final sub-suite** |
| Customer service-area field forgery | RLS/trigger PGlite suite | **Passed: 12 tests**; forged fields are rewritten/blocked by current migration |
| Legacy payment RPC overload cleanup | PGlite catalog suite | **Passed: 8 tests** |
| Email preference synchronization and authorization | Actual migration in PGlite | **Passed: 38 tests**; broadcast delivery semantics still have F-03 |
| Customer/admin row ownership | RLS and RPC static trace; authorization contracts | **Defenses present; not live-reproduced** |
| Private proof/receipt access | Storage policies, fallback authorization, 9-assertion browser test | **Passed locally/static**; live bucket settings unverified |
| Photo fallback/rollback | Contract tests and browser harness | **Passed locally** |
| Push device ownership and notification UX | Contract tests and RPC/policy trace | **Passed locally/static** |
| Authentication/password recovery/account switching | Code trace and registration transition tests | **Mostly passed locally**; booking-draft account isolation failed by inspection (F-02) |
| Report generation/date ranges | Actual migration executed in PGlite | **Failed** (F-01) |
| Report print/PDF | Production bundle compiled; report data path broken; no visual PDF export completed | **Untested end-to-end** |
| Announcement email | Static authorization/escaping/consent review | **Admin check and HTML escaping present; concurrency/failure semantics fail** (F-03) |
| Inquiry submission | Edge source review | Input validation and DB-backed limiting present; **not sent live** |
| Full customer/admin E2E | Existing suite intentionally writes remote fixtures | **Not run** because the available environment was not confirmed staging and the audit forbids changing real data |
| PWA offline | Build succeeded; contract test | **Test failed on stale two-font assertion**; actual offline behavior not browser-verified |

### Defenses evaluated before classifying issues

- Broad `authenticated` EXECUTE grants on admin RPCs were not treated as privilege escalations where the function starts with `is_admin()` and uses server-derived `auth.uid()`.
- The publishable Supabase/PayMongo/Firebase browser keys were not treated as secret leaks. `.env` is ignored and not tracked; repository scanning found secret *names/placeholders*, not embedded secret values.
- The payment return query parameters are presentation/routing state. Reconciliation calls reload registered attempts/orders and verify ownership/amount server-side; a forged `?payment=success` alone does not mark an order paid.
- Public company/featured media policies were distinguished from private shipment evidence. Predictable tracking numbers do not by themselves bypass the private bucket or owner checks.
- React renders customer/admin text as escaped nodes. The small Markdown renderer also restricts link schemes to HTTP(S) or same-origin absolute paths and uses `noopener`; no confirmed stored XSS sink was found.
- PayMongo payment/refund webhook paths validate HMAC and reconcile provider identifiers/amounts idempotently. The missing timestamp window is therefore rated hardening, not a confirmed double-credit exploit.
- Current PayMongo documentation lists signed payment/refund events and refund monitoring; the repository handles payment paid/failed and multiple refund event shapes. See [PayMongo events](https://docs.paymongo.com/docs/developer-tools-webhooks-events) and [refunding transactions](https://developers.paymongo.com/v1/docs/refunding-transactions).

## E. Unverified areas and access limitations

1. **Actual deployed database state:** Management API queries for migration history, policies, grants, triggers, constraints, and function definitions all returned HTTP 401. No conclusion is made that repository migrations are deployed.
2. **Actual deployed Edge Functions:** Function metadata/source could not be read with the available credential. Repository code may differ from deployed code.
3. **Public deployment:** `.env` configures `VITE_APP_URL=http://localhost:5173`; the README's Vercel address was not treated as authoritative deployment evidence.
4. **Live user-role isolation:** No second real customer account was used to probe another customer's ID/order, because that would exceed authorized data. IDOR conclusions are based on RLS/RPC/Edge code and local contracts.
5. **Payments/refunds:** No real/sandbox PayMongo source, capture, refund, or webhook was initiated. Provider dashboard amounts and live/test mode are unverified.
6. **Notifications/email:** No push, inquiry, subscription change, announcement broadcast, or reminder was sent.
7. **Files:** No production upload, signed URL, fallback document, cleanup, or delete operation was attempted.
8. **Visual/browser workflows:** No stateful E2E journey was run against remote Supabase. Mobile layout, login screens under real latency, actual print/PDF pagination, and browser offline behavior remain unverified.
9. **Concurrency:** PGlite uses one backend and proves post-lock logic, not true multi-backend lock contention. Payment/refund concurrency still merits staging tests with two database sessions.
10. **Rate limiting:** Inquiry IP-header trust notes claim prior live verification, but that claim was not independently reproduced.

## F. Minimal remediation order

### Fix before the defense

1. Remove the invalid unused `method_agg` CTE and add an execution test for both report RPCs. Verify the applied migration/function in staging/production read-only metadata.
2. Scope booking drafts to user ID and clear legacy/current user's sensitive draft data at logout/account switch.
3. Make announcement broadcast claiming and recipient delivery idempotent; do not mark failed batches as emailed.
4. Restore a green `npm run check`: table scopes, renamed-page test, and variable-font PWA assertion.
5. Run a safe defense rehearsal against a disposable staging project: customer/admin login, booking, pickup/price/discount, partial payment, trip progression, delivery, report generation, print/PDF, feedback, notification toggles, inquiry handling, and email preference changes.

### Fix soon after

1. Regenerate `supabase/schema.sql` from a clean fully migrated database and add drift detection.
2. Define whether period reports are event reports or as-of snapshots; make detail rows and summary semantics reconcile.
3. Add multi-session PostgreSQL concurrency tests for payment, refund reservation/reconciliation, and broadcast claims.

### Optional hardening

1. Add PayMongo webhook timestamp freshness and explicit live/test signature-mode validation.
2. Add CSP reporting/monitoring and alerting for webhook/provider failures.
3. Consider clearing or account-scoping queued client activity details on logout; the queue is user-ID filtered and server actor identity is derived, but it can retain operational text locally for up to seven days.

## G. Short defense-demo checklist

- [ ] Confirm the deployed commit/version and list applied Supabase migrations.
- [ ] Generate a financial report for a known date range; confirm no SQL error and reconcile one payment plus one refund.
- [ ] Print and export the same report; inspect first/last page and filename.
- [ ] Log in as customer, create one isolated booking, and record the server-generated tracking number.
- [ ] As admin, weigh it and show server-derived charge/discount; collect a partial payment once.
- [ ] Repeat the payment button/request and show no duplicate ledger row.
- [ ] Move shipment through trip statuses; demonstrate unpaid dispatch gate and permitted override/COD rule.
- [ ] Confirm delivery with proof and verify payment status is independent of shipment status.
- [ ] Log out with a partially entered draft, sign in as another test customer, and confirm no prior PII appears.
- [ ] Verify customer A cannot read customer B's order/payment/proof using staging fixtures.
- [ ] Toggle push and email updates using test accounts; do not use real recipients.
- [ ] Send one announcement only to controlled test inboxes; simulate/retry failure and confirm no duplicate.
- [ ] Run `npm run check` from a clean checkout and save the passing output.
- [ ] Keep a fallback demo dataset/screenshots for provider or network outage; do not claim live behavior when using them.

## Final answer to the audit question

The highest-priority problem is the broken financial-report RPC: the actual migration reproduces a PostgreSQL aggregation error when invoked, so Reports & Analytics cannot reliably support the defense demo. Next are cross-account leakage of unscoped booking drafts and non-idempotent/incorrect announcement email completion handling. The required release gate is also red and partially stale.

Evidence is strongest for the report bug (actual migration executed locally), the failing build/test gate (clean isolated checkout), and the storage/privacy/email paths (precise static execution paths plus existing local contracts). Payment/refund ledger, discount math, ownership checks, Edge compilation, photo fallback, contact locks, push contracts, and production build passed the available local checks. Actual production policies/functions, full login-to-delivery E2E, real payment/refund behavior, notifications/email delivery, report PDF output, and mobile/offline behavior remain untested because read-only production access failed and the existing E2E suite would create remote records.

Passing builds or local contracts do not establish that the deployed system is secure or bug-free.
