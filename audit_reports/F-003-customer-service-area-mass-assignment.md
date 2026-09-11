# F-003 — Customer booking can submit service-area approval metadata

- **Status:** Confirmed implementation gap
- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Verified:** 2026-09-11
- **Area:** Booking authorization and out-of-coverage workflow

## Finding

The production customer order INSERT policy does not restrict `service_area_status` or `service_area_remarks`. The customer-only insert triggers also do not derive or clear those fields.

The supported workflow uses `for_review` for an out-of-coverage booking. Because the field is accepted from the insert payload, a modified client request can submit `approved` instead.

## Evidence

The live `orders` INSERT policy checks the following customer-controlled values:

- `user_id = auth.uid()`
- status is `Pending` or `Assigned`
- `actual_weight IS NULL`
- payment fields are empty/unpaid/zero
- pickup and delivery photos are empty

It does not check `service_area_status` or `service_area_remarks`.

The live definitions of `guard_customer_order_insert()` and `prepare_order_insert()` mention and reset featured fields, but do not mention:

- `service_area_status`
- `service_area_remarks`
- `last_reminder_sent_at`
- `reassignment_history`

The workflow columns and allowed values are defined in [`20260625010000_out_of_coverage_workflow.sql`](../supabase/migrations/20260625010000_out_of_coverage_workflow.sql#L1).

## Safe reproduction

The issue is reproducible from the live policy and trigger definitions: the field is neither rejected by `WITH CHECK` nor rewritten by the customer insert triggers.

An actual crafted INSERT was intentionally not sent because this audit was read-only.

## Impact

An out-of-area booking could appear approved and avoid the staff review path. This is a business-authorization issue rather than a direct cross-customer data exposure.

## Recommended fix

1. Whitelist customer insert columns.
2. Derive the initial service-area status on the server.
3. Allow `approved` and `rejected` transitions only through an admin-authorized RPC or server function.
4. Protect service-area remarks and all other operational metadata from customer mass assignment.
