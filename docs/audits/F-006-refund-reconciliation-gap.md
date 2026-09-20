# F-006 — Refund reconciliation

- **Status:** Resolved in `20260912184434_paymongo_refunds_and_failures.sql`
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Verified:** 2026-09-11
- **Area:** PayMongo lifecycle and payment ledger

## Original finding

The application can display a `refunded` payment status, but there is no verified refund workflow that updates the payment ledger and order state when a PayMongo refund occurs.

## Evidence

The live Supabase database has no public function whose name or definition contains `refund` or `refunded`.

The repository webhook handler contains handling for payment creation/chargeability and `payment.paid`, but no `payment.refunded` branch. The deployed Edge Function source was previously compared byte-for-byte with the repository and matched.

The UI recognizes the status in [`src/utils/paymentDisplay.js`](../src/utils/paymentDisplay.js#L114), and the legal text mentions refunds, but these do not create a ledger reconciliation path.

PayMongo documents refund processing and refund webhook behavior in its [refund documentation](https://developers.paymongo.com/v1/docs/refunding-transactions).

## Safe reproduction

The absence was verified by searching the matched webhook source and live PostgreSQL function catalog. No real refund was initiated.

## Impact

If a payment is refunded through PayMongo or an external administrative process, the application may continue to show the original payment as paid and leave the order balance or payment history incorrect.

## Recommended fix

Choose and implement one of these explicit models:

1. Process PayMongo refund webhooks idempotently and record a negative/refund ledger transaction; or
2. Create an admin-only manual refund reconciliation workflow with provider reference, amount, reason, and audit history.

The order payment status, remaining balance, customer view, staff view, and reports must all use the same refund semantics.

## Resolution

Implemented a dedicated `payment_refunds` lifecycle ledger linked to the
original `payment_transactions` row. Admin-created refunds reserve the amount
under a database lock before the secret-key PayMongo request. Signed
`payment.refunded`, `payment.refund.updated`, and compatibility
`refund.succeeded` deliveries upsert by provider refund id, so redelivery is a
no-op and multiple partial refunds cannot exceed the original payment.

Only `succeeded` refunds reduce `orders.amount_paid`, recalculate the remaining
balance/payment status, notify the customer, and reduce report collections.
Pending, processing, and failed attempts stay visible in customer/admin
history without moving money. `payment.failed` now closes the registered
attempt without writing a payment ledger row.

Regression coverage is in `scripts/payment-refund-pgtest/run.mjs`; it executes
the real migration against embedded PostgreSQL and checks partial/full refund
math, pending semantics, concurrency reservations, webhook idempotency,
notification deduplication, report totals, and failed-payment behavior.
