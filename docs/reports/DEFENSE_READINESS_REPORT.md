# CargoExpress PH Defense Readiness Report

Date: 2026-09-21 (Asia/Manila)

## Verdict

**Conditionally ready for a controlled thesis/demo walkthrough.** The repository passes the available non-live checks, the current frontend contains the Sales & Reports/Per Trip and public payment-return implementation, and an unverified `success=true` return does not display payment success or redirect to login. A real payment, deployed Edge Function, live RLS/Reatime configuration, and all requested device/browser combinations were not exercised in this audit, so this is not a claim of end-to-end production readiness.

The checkout/payment-return path remains the main release gate. Before a defense demonstration, use an isolated test/staging order and verify that the deployed migration, `paymongo-create-payment`, `verify-payment-return` (with gateway JWT verification disabled as designed), webhook/reconciliation path, and frontend are the same release being demonstrated.

## Audit boundary and repository state

- Branch: `main`
- Audited commit at start: `10ef050c319843bb2bd0ce4827c65ef40c868d12`
- Working tree at start: clean
- No commit, push, deployment, production-data mutation, real payment, refund, email, notification, or scheduled cleanup execution was performed.
- Local Supabase status could not be started because Docker/Podman is unavailable. This prevented local database/Edge Function runtime verification.
- Playwright live E2E was intentionally not run: the repository configuration targets a real Supabase backend and writes data.

## Checks completed

| Check | Result | What it proves |
|---|---|---|
| `npm test` | Passed | Unit, contract, PGlite financial/RLS/idempotency, payment/refund, cancellation, mobile, photo, push/notification, chatbot, and Per Trip report checks passed. The support-chat fixture emitted its expected failure-path warning while the contract passed. |
| `npm run test:edge-functions` | Passed | 20 Edge Functions built successfully. |
| `npm run build` | Passed | Production frontend build completed; PWA injected 71 assets. The existing vendor React chunk is over the 500 KB advisory threshold. |
| `npm run test:pwa-offline` | Passed | 71 JavaScript/CSS/font assets were confirmed in the offline precache. |
| `node scripts/photo-fallback-browser-test.mjs` | Passed | Nine browser assertions for photo fallback behavior passed. |
| Local preview of `/payment/return?success=true` | Passed | The URL stayed on the return route and showed `Payment link unavailable`; it did not trust the query parameter or redirect to login. |
| Live public route read-only smoke | Passed | The public site served successfully; the same unverified return URL stayed on the return route and showed the invalid/expired confirmation-link state. No payment call was made. |
| Git/diff hygiene | Passed at audit start | No pre-existing working-tree changes were overwritten. |

The successful automated checks are primarily unit, contract, database-emulation, build, and read-only browser checks. They do not replace a real-device payment test.

## Feature coverage assessment

### Confirmed by source and automated checks

- Authentication and role boundaries remain enforced by the existing protected routes and database authorization model.
- `/payment/return` is intentionally outside login guards. The return flow requires a backend-confirmed capability/status rather than trusting a success-looking URL.
- Payment/refund tests cover authoritative status handling, idempotency, duplicate-prevention, pending/failed non-crediting behavior, refund states, cancellation behavior, and authorized access patterns.
- Device B’s confirmed state is designed to contain only the thank-you confirmation. No private booking details or payment amount should be exposed there.
- The Sales & Reports area currently uses the Per Trip report implementation. The Per Trip contract covers paid, unpaid, pending/failed/uncertain, unpriced, and multiple-payment cases without changing financial formulas.
- Existing checks cover booking, trip/pickup, discounts, cancellation/refund, customer/admin flows, print/mobile behavior, photos, push/notifications, and the menu-driven support chat at contract level.

### Not verified live in this audit

1. **Actual PayMongo/GCash Device A → Device B completion.** The reported “Verifying your payment…” symptom cannot be marked fixed without a test-mode payment using the exact deployed return verifier, migration, webhook/reconciliation path, and gateway configuration.
2. **Cross-device Realtime updates.** The source has an order subscription/refresh architecture, but live table publication, RLS visibility, reconnection, delayed webhook handling, and stale-response ordering were not tested on two authorized devices.
3. **Deployed-version identity.** The live site contains the expected payment-return and Sales & Reports strings, but its asset hashes differ from the local build. The exact deployed commit was not independently proven.
4. **External providers.** PayMongo, Resend, Firebase push, Google services, storage, Vault secrets, and scheduled `pg_cron`/`pg_net` execution were not invoked or validated.
5. **All six requested Device B contexts.** Logged-out/not-installed, logged-out/installed, initiating account, different account/admin, in-app browser, and refresh-after-success remain a staging/device test matrix, not completed evidence here.

## Payment and Realtime release gates

Before demonstrating payment, confirm in an isolated environment:

1. Apply `20260920150000_public_payment_return_capability.sql`.
2. Deploy `paymongo-create-payment`.
3. Deploy `verify-payment-return` with JWT verification disabled at the gateway, while retaining its narrow hashed-capability and authoritative payment-attempt checks.
4. Deploy the frontend that generated the payment link.
5. Complete one test-mode partial/full payment and verify exactly one payment transaction, correct amount paid/balance, and no duplicate on refresh/repeated callback.
6. Keep Device B unauthenticated and confirm only the simple thank-you page appears. It must not log in, switch sessions, show private details, show an amount, show another payment button, or redirect to a dashboard.
7. Keep an already-open authorized admin/customer page on Device A and verify amount paid, remaining balance, status, payment history, and payment controls update without a full reload. Repeat after backgrounding and reconnecting the page.

Do not “fix” a failure by making `orders` or `payment_attempts` public. Investigate the RPC/function response, deployment version, webhook reconciliation, Realtime publication, and authorized subscription query instead.

## Automatic deletion, retention, and scheduled automation

The following behavior is present in migrations/functions. The schedules and secrets were inspected from source; their live installation and execution were not verified.

| Process | Schedule | Effect and demo impact |
|---|---|---|
| Old activity-log retention | Daily `03:00 UTC` / `11:00 PHT` | Deletes `activity_logs` older than 7 days. Old audit evidence may disappear. |
| Stale support conversations | Daily `03:30 UTC` / `11:30 PHT` | Resolves open/waiting conversations inactive for 7 days; this is a status change, not deletion. |
| Payment reminders | Daily `00:00 UTC` / `08:00 PHT` | Calls `process-daily-reminders`, sends due/unpaid reminders, and updates the last-reminder timestamp. Do not use real customer data for a demo. |
| Evidence-photo cleanup | Daily `01:30 UTC` / `09:30 PHT` | Queues/deletes evidence files for terminal orders older than 6 months, with retry handling; featured evidence is excluded by the later rule. |
| Photo storage health | Every 6 hours at `:15` | Runs health checks/alerts; it is not a business-record deletion process. |
| Photo operational-log cleanup | Sundays `03:00 UTC` | Retains storage events for 30 days and completed cleanup-queue rows for 7 days; pending/running/failed/retryable work is retained. |
| Push delivery worker | Every minute | Processes the durable notification outbox. |
| Push delivery-job cleanup | Daily `03:20 UTC` | Removes completed delivery jobs older than 7 days. |
| Push health monitor | Every 5 minutes | Monitors delivery health. |
| PayMongo refund recovery | Every 5 minutes | Retries/reconciles unresolved provider refunds idempotently; it should not create a new logical refund request. |

The former delivery-attempt cleanup schedule was later unscheduled with its table dropped; it should not be presented as an active current process without a live schema check.

## Defense demo guidance and limitations

- Use an isolated/test-mode order and disposable accounts. Do not demonstrate with the referenced production booking or real money.
- Capture the local commit, deployed asset/build identifier, migration status, function versions, and test order ID before starting.
- Have a fallback screenshot or recorded result for provider/device limitations, while clearly labeling it as recorded evidence.
- The localhost build is not automatic proof that the deployed frontend/backend match.
- A displayed `₱0` before a shipment is priced means “Not priced yet”; it does not mean the shipment was paid.
- A cancelled shipment should not be described as collectible merely because an old balance exists; the refund/retained-fee decision must remain authoritative.
- Browsers may block programmatic tab closing or app return. Device B must retain the visible fallback telling the user to close the tab and return to the device where payment started.

## Smallest remaining actions

1. Run the payment-return and cross-device matrix against isolated PayMongo test data with the exact deployed versions.
2. Record the backend response and database row for the reconciliation event, then verify the authorized Realtime refresh on admin and customer views.
3. Add or capture a deployment fingerprint so the demonstrated frontend, migration, and functions can be matched to one release.
4. Treat the large vendor chunk as a later performance improvement; it is not a functional defense blocker.

