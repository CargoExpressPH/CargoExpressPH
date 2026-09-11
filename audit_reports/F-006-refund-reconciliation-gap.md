# F-006 — Refund reconciliation is not implemented

- **Status:** Confirmed feature gap
- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Verified:** 2026-09-11
- **Area:** PayMongo lifecycle and payment ledger

## Finding

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
