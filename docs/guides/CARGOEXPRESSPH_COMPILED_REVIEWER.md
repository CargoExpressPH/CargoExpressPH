# CargoExpress PH Compiled Reviewer

**Purpose.** This is a compact, current-state reviewer for the CargoExpress PH
repository. It compiles the most useful findings from the architecture guides,
workflow guides, payment/refund audits, security reviews, and operations notes. It
is deliberately evidence-linked: implementation claims should be checked against
source, migrations, tests, and the target environment.

**Review boundary.** This document describes the repository as inspected on 20
September 2026. It does not certify a production deployment, live Supabase
configuration, PayMongo account, or provider webhook delivery. Migrations are
append-only and are the database source of truth.

## 1. Overview and stack

CargoExpress PH is a single-page React application for shipment booking, pickup,
delivery, trip operations, customer support, notifications, payments, refunds,
reporting, and administrative controls.

| Layer | Repository evidence | Responsibility |
|---|---|---|
| Web client | `src/`, React 19, React Router 7, Vite 6 | Public pages plus authenticated customer and admin workspaces |
| Data/auth | `src/lib/supabase.js`, `src/lib/database.js`, `supabase/migrations/` | Supabase Auth, Postgres, RLS, RPCs, triggers, and protected read/write helpers |
| Realtime | `src/hooks/`, Supabase Realtime migrations | Authorized live updates, especially order totals and notifications |
| Provider integration | `src/lib/paymongo.js`, `supabase/functions/paymongo-*` | PayMongo checkout/source creation, capture/poll, webhook reconciliation, refunds |
| Edge Functions | `supabase/functions/` | Privileged, narrow server operations and scheduled/operational jobs |
| Storage | photo components, storage functions, storage migrations | Pickup/delivery evidence and monitored photo lifecycle |
| PWA/notifications | `public/`, service-worker and Firebase code | Installable shell, offline behavior, push notifications, update prompts |
| Release tooling | `package.json`, `scripts/`, `docs/operations/` | Contract tests, database-backed tests, build and release checks |

Detailed source: [technical overview](../architecture/TECHNICAL-OVERVIEW.md),
[module coverage](./CARGOEXPRESSPH_MODULE_COVERAGE.md), and the root
[README](../../README.md).

## 2. Architecture and security model

The browser is an untrusted client. Pricing, payment totals, settlement gates,
status transitions, and authorization-sensitive writes must be enforced by the
database/RPC or a narrowly scoped Edge Function rather than by React state.

- Supabase Auth identifies the caller; RLS protects tenant/private rows.
- `SECURITY DEFINER` RPCs are used for privileged state transitions and are
  expected to validate the caller, target row, allowed state, amounts, and
  idempotency conditions.
- Service-role credentials are used only inside Edge Functions. They are not
  bundled into the client and are not printed in repository documentation.
- `payment_attempts` remains private. The public payment-return route sends a
  high-entropy return capability to `verify-payment-return`; the function hashes
  it, looks up the digest with service role, and returns only a status enum.
- `/payment/return` is declared outside `AuthRoute` and `ProtectedRoute`. It does
  not create an auth session, read private booking details, or redirect based on
  the current Device B account.
- Same-browser return navigation is only a local convenience. The saved path is
  sanitized to an internal CargoExpress path and is used only when the saved
  initiating user is still the current authenticated user. Device B falls back
  to a public close message.
- Realtime does not make private data public: the authorized page receives an
  event for its own order and refetches through its existing RLS-protected data
  helpers.

Primary evidence: [database architecture review](../architecture/DATABASE_ARCHITECTURE_REVIEW.md),
[security audit](../audits/SECURITY_AUDIT_2026-08-17.md),
[public return migration](../../supabase/migrations/20260920150000_public_payment_return_capability.sql),
[return verifier](../../supabase/functions/verify-payment-return/index.ts), and
[route declaration](../../src/App.jsx).

## 3. Guest, customer, and admin pages

### Guest/public surface

The router exposes tracking, about, terms, privacy, unsubscribe, schedules, FAQ,
and the payment-return confirmation page without requiring a login. Booking,
customer data, and administrative data remain behind protected routes.

### Customer surface

Customer pages cover the dashboard, orders and order detail, booking, tracking,
trips, notifications, profile and personal information, password/email changes,
support chat, payment history, help, and version/about information. Customer order
detail uses the caller’s RLS scope and refreshes the order, payment history,
events, and settlement view after an authoritative order update.

### Admin surface

Admin pages cover the dashboard, orders/order detail, booking and trip creation,
trip detail/reassignment, customers, sales/reports, announcements, inbox,
contact inquiries, profile/security, activity logs, company information, storage
monitoring, and feedback. Admin order detail uses the same protected order
identity for Realtime and performs a silent refresh so unsaved surrounding page
state is not discarded.

Source: [module coverage](./CARGOEXPRESSPH_MODULE_COVERAGE.md) and the route tree
in [`src/App.jsx`](../../src/App.jsx).

## 4. Core workflows

1. A customer or authorized admin creates a booking through a validated route and
   contact/package form. The database remains responsible for the final write
   authorization and derived totals.
2. Pickup processing captures actual weight, pickup evidence, payer choice,
   promised payment information, and any permitted shipping discount through the
   sanctioned RPC. Once pickup payment/discount state is committed, the discount
   is not freely editable from the UI.
3. A trip is created, assigned, rescheduled, monitored, and advanced through the
   operational status flow. Notifications and activity records accompany relevant
   changes.
4. Delivery collects any remaining freight, records proof and status, and gates
   completion on the settlement rules. Freight Prepaid and Freight Collect are
   distinct business paths.
5. Cancellation uses the settlement workflow rather than a client-only status
   change. It calculates what was collected, what is refundable, and what must be
   recorded before the booking is treated as financially settled.

The exact status vocabulary and guards should be read from the current migrations,
not inferred from an old report. See [system flow review](../audits/SYSTEM_FLOW_AND_LOGIC_REVIEW.md),
[cancellation settlement workflow audit](../audits/SALES_AND_CANCELLED_BOOKING_SETTLEMENT_PLAN.md),
and [complete system guide](./CARGOEXPRESSPH_COMPLETE_SYSTEM_GUIDE.md).

## 5. Payments, discounts, refunds, and cancellation settlement

### PayMongo flow

The client requests a PayMongo source through `paymongo-create-payment`. The
function authorizes the order, binds a source to its first registered order,
stores a `payment_attempts` record, and returns a checkout URL plus a short-lived
return capability. The provider redirect is only a navigation event; it is not
proof of payment.

The webhook and explicit capture/poll paths reconcile the provider result through
the database reconciliation RPC. The RPC is idempotent and locks the attempt so a
webhook, poll, or retry cannot create a second credit for the same provider
source/payment. Database triggers derive order totals and payment status from the
authoritative ledger state.

### Device B return

`/payment/return` accepts only the capability token. `verify-payment-return` hashes
the token and returns `confirmed` only for an unexpired attempt whose backend
status is `reconciled`, has a provider payment ID, and is not failed. The confirmed
page shows only:

> Thank you for your payment!
>
> Your payment has been successfully confirmed.

It provides a visible Close/Return action. Same-device initiation may return to a
sanitized internal route after confirming the same initiating session; a scanning
device without that context receives the close-tab fallback. It does not show
amounts, booking details, login redirects, dashboard redirects, or another
payment button.

### Discounts and manual collection

Discounts are staged and committed through guarded pickup/payment paths. A recorded
payment freezes the discount so an admin cannot silently alter the amount after
money has been received. Manual cash/GCash collection and additional payment
modals still use protected RPC/Edge paths and should not write derived totals
directly.

### Refunds and cancellation

Provider refunds, manual refunds, refund recovery, reference validation, period
bucketing, and cancellation settlement are separate audited paths. A refund must
be linked to an eligible payment and recorded exactly once; cancellation must
settle collected money and remaining balance before the final state is trusted.

Source set: [PayMongo flow](../../src/lib/paymongo.js), [create function](../../supabase/functions/paymongo-create-payment/index.ts),
[webhook](../../supabase/functions/paymongo-webhook/index.ts), [payment ledger tests](../audits/PAYMENT_DUPLICATE_PREVENTION_FIX.md),
[refund reconciliation audit](../audits/FINANCE_REFUND_RECONCILIATION_AUDIT.md),
[discount audit](../audits/DISCOUNT_OVERPAYMENT_REFUND_AUDIT.md), and
[settlement migration](../../supabase/migrations/20260920110000_cancellation_settlement_workflow.sql).

## 6. Sales and reports

The admin sales/reporting area is a read/reporting surface over booking, payment,
refund, cancellation, and settlement data. Financial reports must use the same
database-derived totals and status definitions as operational pages; a display
calculation is not a replacement for a ledger or settlement record.

Review points include gross/collected/remaining/refunded amounts, cancelled
booking treatment, date-period bucketing, partial payments, discounts, and the
separation of provider/manual refund records. The report UI should remain
authorized and should not make financial tables public merely to support a public
payment return.

Source: [sales computation audit](../audits/SALES_REPORTS_COMPUTATION_AUDIT.md),
[refund/report alignment](../audits/REFUND_UI_REPORTS_ALIGNMENT_REPORT.md),
[financial reconciliation](../audits/FINANCE_REFUND_RECONCILIATION_AUDIT.md), and
the admin [reports page](../../src/pages/admin/ReportsPage.jsx).

## 7. Edge Functions, RPCs, triggers, and jobs

The repository currently contains deployable Edge Function directories alongside
the `_shared` helper directory. The exact deployable inventory should be taken
from `supabase/functions/` at release time because it changes with migrations and
feature work. Important groups include:

- PayMongo create, webhook, refund, refund recovery, and public return verification.
- Photo storage/fallback, deletion, archival, health, and event recording.
- Notifications, push delivery, announcements, unsubscribe, inquiries, and trip
  reschedule email.
- Manual refund recording and scheduled daily reminders.

Database RPCs and triggers handle guarded booking/payment/refund transitions,
derived payment totals, notification events, status logs, and storage lifecycle
rules. Realtime publication migrations add the tables whose authorized consumers
need event delivery. Current code counts 20 deployable function directories (plus
`_shared`); older docs that state a different count are historical.

Do not treat a function name or old report as proof of deployment. Verify the
function source, migration grants, secrets, gateway JWT setting, and target
project separately. See [backend automation and retention](../operations/BACKEND_AUTOMATION_AND_RETENTION_GUIDE.md),
[event/data-store guide](../architecture/CARGOEXPRESS_EVENT_DIAGRAM_DATABASE_DATASTORE_GUIDE.md),
and the [migration directory](../../supabase/migrations/).

## 8. Deletion, retention, and recovery

The repository includes explicit photo-storage monitoring, fallback, deletion, and
archival paths; payment and refund records are not ordinary disposable uploads.
Operational cleanup must preserve financial/audit evidence, respect references
from orders and payment attempts, and use the guarded backend path rather than
direct client deletion.

Retention schedules in older operational notes should be checked against current
migrations and deployed jobs before being quoted as policy. The same applies to
activity-log and notification cleanup intervals. Recovery paths exist for storage
fallbacks and PayMongo refund reconciliation, but recovery is not a substitute
for observing idempotency and authorization at the first write.

Sources: [storage monitoring implementation](../operations/STORAGE_MONITORING_SIMPLIFICATION_IMPLEMENTATION.md),
[storage audit](../audits/STORAGE_UNUSED_COLUMNS_AND_EDGE_FUNCTIONS_AUDIT.md),
[automation/retention guide](../operations/BACKEND_AUTOMATION_AND_RETENTION_GUIDE.md),
and [photo-storage migrations](../../supabase/migrations/).

## 9. Operations and troubleshooting

Recommended local checks are defined in `package.json`:

- `npm test` — smoke, accessibility, security, route/payment contracts, and
  database-backed payment/refund/notification checks.
- `npm run test:edge-functions` — Edge Function build/type-oriented checks.
- `npm run build` — production Vite build.
- `npm run test:pwa-offline` — PWA/offline contract checks.
- `npm run check` — the broader combined gate, including build and PWA checks.

For a payment that appears successful at the provider but remains stuck:

1. Confirm the `payment_attempts` row reached the authoritative reconciled state
   and has the expected provider payment ID.
2. Confirm the webhook/capture/poll path reached the reconciliation RPC and did
   not fail idempotency or amount validation.
3. Confirm the public return capability is present, unexpired, and hashed in the
   attempt row; do not expose the raw token in logs.
4. Confirm the authorized Device A order page subscribes to `orders` for that
   booking and refetches order totals/history on the event.
5. Check Realtime reconnect, browser focus/visibility, and network recovery. The
   hook has bounded reconnect backoff and active-page refresh behavior.
6. Use a manual refresh only as diagnosis; it is not the intended steady state.

Known browser constraints: a browser generally cannot close a tab unless it was
opened by script, so the public page must retain a clear close-tab fallback. An
in-app browser may also restrict navigation/close behavior. See [go-live guide](../operations/GOLIVE_GUIDE.md)
and [post-deployment regression audit](../audits/POST_DEPLOYMENT_REGRESSION_AUDIT.md).

## 10. Defense Q&A

| Question | Defensible answer |
|---|---|
| Can Device B see a booking after scanning? | No. It receives only a public status enum from a narrowly scoped verifier. |
| Is a PayMongo `success` query parameter enough? | No. Only an unexpired hashed capability bound to a reconciled backend attempt can show confirmed. |
| Why is the verifier unauthenticated? | Device B is intentionally login-free; possession of the short-lived capability is the narrowly scoped return proof. |
| Are `orders` or `payment_attempts` public? | No. RLS and the absence of public table policies remain in force; the verifier uses service role internally and returns no row data. |
| Can the same payment be credited twice? | The source binding, row lock, idempotent reconciliation, and database ledger guards are designed to reject duplicate credit. Tests cover this; live provider behavior still needs environment verification. |
| Why can an admin/customer page update without a reload? | An authorized `orders` UPDATE event triggers a silent protected refetch of order totals, history, and related state. |
| What happens if Realtime disconnects? | The hook reconnects with bounded backoff and refreshes on online, focus, and visibility events. A delayed webhook may still leave the return page in processing until the backend catches up. |
| Can the app always return or close the scanning tab? | No. Same-device return is best effort; other devices and browser restrictions receive a safe close instruction. |
| Are old audit proposals deployed? | Not necessarily. Proposals and archived reports are evidence of reasoning, not deployment evidence. |
| What is authoritative for schema and policy? | Applied migrations and the live database, not `schema.sql`, screenshots, or an old Markdown count. |

## 11. Known limitations and unverified items

- This repository review did not deploy migrations, Edge Functions, or frontend
  assets, and did not initiate a real payment.
- The public return implementation is present locally, but gateway JWT-disabled
  configuration, Edge Function deployment, secrets, webhook delivery, and live
  Realtime publication/RLS behavior require target-environment verification.
- Real-device tests across logged-out/installed/in-app-browser combinations were
  not performed by this documentation pass. Browser close-tab behavior remains
  inherently conditional.
- Older documents contain counts and repository paths from earlier snapshots.
  The cleanup report identifies the meaningful stale references.
- A few historical audits refer to diagnostic SQL files that are not present in
  the current tree. They were retained as audit evidence and are not represented
  as runnable fixtures.
- Root one-off scripts and snapshots were retained where their dependency or
  historical value could not be disproven safely.
- Payment redesign documents in `archive/` describe proposals or superseded
  approaches and must not be read as current implementation requirements.

## 12. Source index

### Current implementation

- [Router and public return route](../../src/App.jsx)
- [Payment provider client](../../src/lib/paymongo.js)
- [Public return page](../../src/pages/shared/PaymentReturnPage.jsx)
- [Safe return context](../../src/lib/paymentReturnContext.js)
- [Order payment Realtime hook](../../src/hooks/useOrderPaymentRealtime.js)
- [Order payment migration](../../supabase/migrations/20260920150000_public_payment_return_capability.sql)
- [Payment return verifier](../../supabase/functions/verify-payment-return/index.ts)
- [PayMongo create function](../../supabase/functions/paymongo-create-payment/index.ts)
- [Supabase migrations](../../supabase/migrations/)

### Current guides and operations

- [Technical overview](../architecture/TECHNICAL-OVERVIEW.md)
- [Database design](../architecture/database_design.md)
- [Complete system guide](./CARGOEXPRESSPH_COMPLETE_SYSTEM_GUIDE.md)
- [Defense reviewer](./CARGOEXPRESSPH_DEFENSE_REVIEWER.md)
- [Backend automation and retention](../operations/BACKEND_AUTOMATION_AND_RETENTION_GUIDE.md)
- [Go-live guide](../operations/GOLIVE_GUIDE.md)

### Audits and historical context

- [Security audit](../audits/SECURITY_AUDIT_2026-08-17.md)
- [System flow review](../audits/SYSTEM_FLOW_AND_LOGIC_REVIEW.md)
- [Payment duplicate prevention](../audits/PAYMENT_DUPLICATE_PREVENTION_FIX.md)
- [Finance/refund reconciliation](../audits/FINANCE_REFUND_RECONCILIATION_AUDIT.md)
- [Cancellation settlement plan](../audits/SALES_AND_CANCELLED_BOOKING_SETTLEMENT_PLAN.md)
- [Archived payment redesign](../archive/payment-redesign-v2.md)
- [Repository cleanup report](../REPOSITORY_CLEANUP_REPORT.md)

The complete source set remains in the category folders. The source index above is
curated for review; it is not intended to hide or replace the individual audit
documents.
