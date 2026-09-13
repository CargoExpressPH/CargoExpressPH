# CargoExpress PH Admin Refund Guide

Last updated: September 13, 2026

This guide explains how an administrator should issue, monitor, and explain a PayMongo GCash refund in CargoExpress PH. It covers full and partial refunds, every refund status, expected timing, automatic recovery, customer communication, test mode, live mode, and troubleshooting.

## Quick answer: how long does a refund take?

There are two different completion times. Do not combine them when speaking to a customer.

1. **CargoExpress confirmation time:** The refund request is often returned by PayMongo within seconds. If it remains pending, processing, or the response is uncertain, CargoExpress checks it automatically. Webhooks are the immediate path; the independent recovery worker runs every 5 minutes and normally revisits active payments at least every 15 minutes. Provider outages, queue backoff, or an inaccessible historical payment can make reconciliation take longer.
2. **Customer GCash posting time:** After the status becomes **Refund Completed**, PayMongo has successfully sent the refund to its payment partner. PayMongo states that eWallet refunds should normally appear in the customer's account **within the day**. This is a provider expectation, not a CargoExpress guarantee, and the customer's GCash balance may update later than CargoExpress.

Never promise that the funds are already visible in GCash until the customer confirms that they received them.

Official PayMongo reference: [Refund resource and status timing](https://docs.paymongo.com/reference/refund-resource).

## Who can create a refund?

Only a signed-in CargoExpress administrator can submit a refund from the application. The server checks the administrator again before contacting PayMongo. Customers can view refunds for their own orders, but they cannot create, edit, or delete refund records.

The **Refund** button appears only when all of the following are true:

- The row is an original payment, not another refund.
- The payment method is GCash.
- The GCash payment was verified through PayMongo.
- The original payment status is paid or partially paid.
- A positive refundable balance remains after completed and active refund reservations are considered.

Manual GCash transfers are not refundable through the PayMongo refund button because PayMongo did not process those payments.

## How to issue a refund in CargoExpress

1. Open the order in the admin area.
2. Go to **Payment History**.
3. Find the original PayMongo GCash payment.
4. Select **Refund**.
5. Review the original payment, amount already refunded, and available refundable amount.
6. Enter either the full available amount or a smaller partial amount. PayMongo currently documents a minimum refund of ₱1.00, and the amount cannot exceed the available refundable balance.
7. Select the reason:
   - Requested by customer
   - Duplicate payment
   - Fraudulent payment
   - Other
8. Add a short note when it will help the audit history. Notes are limited to 255 characters and must not contain secrets or unnecessary personal information.
9. Check the confirmation box only after verifying the order, original payment, and refund amount.
10. Select **Submit [amount] refund** once.
11. Read the resulting status. Do not submit another refund merely because the first request is pending, processing, or uncertain.

The refund changes the financial balance only. It does not cancel the order, cancel the shipment, or change the shipment status.

## Refund status meanings

| CargoExpress label | Stored status | What it really means | Financial effect | Admin action |
|---|---|---|---|---|
| **Refund Preparing** | `creating` | CargoExpress reserved the amount and is preparing the protected provider request. PayMongo success is not confirmed. | No amount is deducted from collected money. | Wait. Do not create another refund. |
| **Refund Pending** | `pending` | PayMongo received the request and will process it. It is not completed. | No amount is deducted from collected money. | Wait for automatic status updates. If it remains pending unusually long, check PayMongo and contact PayMongo Support. |
| **Refund Processing** | `processing` | PayMongo is processing the request, or the provider outcome is temporarily uncertain. It is not completed. | No amount is deducted from collected money. | Allow automatic recovery to check it. Use **Retry protected request** only when the same refund modal explicitly offers it. Never start a separate replacement request. |
| **Refund Completed** | `succeeded` | PayMongo confirmed that the refund succeeded and CargoExpress reconciled the refund ledger. | The succeeded refund is deducted from the order's collected total. The remaining balance and payment status are recalculated. | Tell the customer the refund is confirmed, but explain that GCash posting may take additional time. |
| **Refund Failed** | `failed` | PayMongo did not complete the refund. | No refund amount is deducted from the order's collected total. | Review the provider reason. Refresh the order before deciding whether a new refund request is appropriate. Contact PayMongo Support if the error persists. |
| **Refund Status Unavailable** | unknown or unsupported value | CargoExpress cannot reliably classify the provider state. | It is not treated as completed. | Do not assume success and do not create a duplicate. Escalate for technical review. |

Only **Refund Completed** is a successful financial outcome. Preparing, pending, processing, and unknown states must never be described as completed or successful.

## What happens after an administrator submits?

1. CargoExpress creates a unique protected refund reference.
2. The database locks and reserves the amount against the original payment. This prevents simultaneous refunds from exceeding the refundable balance.
3. The server sends the refund to PayMongo using the same protected idempotency key stored in the refund ledger.
4. PayMongo returns a refund resource with a provider refund ID and status.
5. CargoExpress records that provider result against the original payment and order.
6. Signed PayMongo webhook events remain the fastest way to receive later status changes.
7. The independent recovery worker also asks PayMongo for refunds so a missed webhook or a dashboard-created refund can still be discovered.
8. Only a `succeeded` refund changes the order's financial totals and creates the customer's **Refund Completed** notification.

The original successful payment remains in history. CargoExpress adds a separate negative refund row instead of rewriting or deleting the payment.

## Full and partial refunds

- **Full refund:** Refund the entire currently available amount.
- **Partial refund:** Enter an amount smaller than the available amount.
- PayMongo currently requires each refund to be at least ₱1.00.
- Multiple partial refunds are allowed while refundable money remains.
- The combined completed refunds and active refund reservations cannot exceed the original payment.
- A pending or processing reservation temporarily reduces the amount available for another refund, even though it does not yet reduce the order's collected total.
- A failed refund releases its reservation and does not reduce the order's collected total.

### Example

An order has a verified ₱1,000 PayMongo GCash payment.

- A ₱300 refund is submitted and remains processing: collected total stays ₱1,000, while only ₱700 remains available for another refund.
- PayMongo confirms the ₱300 refund as succeeded: collected total becomes ₱700 and the order balance is recalculated.
- A second completed refund of ₱700 would make the net collected total ₱0.

## Accurate customer communication

Use wording that matches the recorded status.

### Preparing, pending, or processing

> Your refund request has been submitted to PayMongo, but it is not completed yet. CargoExpress will update the status automatically. Please do not request another refund for the same payment.

### Completed

> PayMongo has confirmed your refund as completed. CargoExpress has updated your order balance. The refund may take additional time to appear in your original GCash account; PayMongo advises that eWallet refunds should normally reflect within the day.

### Failed

> PayMongo could not complete the refund. No refund amount was deducted from your order's collected total. We are reviewing whether a new request is required.

Do not say “money received,” “returned to GCash,” or “refund completed” while the status is preparing, pending, processing, unavailable, or failed.

## What automatic recovery does

Automatic recovery is a safety path in addition to webhooks.

- Supabase Cron invokes the recovery function every 5 minutes.
- The worker uses server-only credentials; customers and ordinary signed-in users cannot run or inspect it.
- It checks refunds attached to verified PayMongo payments and reconciles provider changes idempotently.
- It can discover a refund created directly in PayMongo Dashboard when the corresponding payment is still inside the recovery scan window.
- It revisits unresolved refunds every 5 minutes after a successful scan and normally checks other active payments every 15 minutes.
- If PayMongo is temporarily unavailable, the job remains active and retries with exponential backoff, capped at 6 hours.
- If an app request has an uncertain outcome, recovery waits at least 2 minutes and can replay only that same logical request, with the same amount, body, and idempotency key.
- The protected automatic replay window is 23 hours. If a successful provider lookup finds no refund before that window expires, CargoExpress marks the local request failed and releases the reservation.
- Ordinary background discovery jobs scan a verified payment for 180 days. An unresolved local refund reactivates and extends recovery even if that normal window has ended. Signed webhooks continue to reconcile valid refund events independently.

Recovery never invents a new refund, silently changes the requested amount, or marks a refund completed without PayMongo's `succeeded` status.

## If the result is uncertain

An uncertain result can happen when the PayMongo request times out or the provider reports that the same idempotent operation is still in progress.

1. Do not close the issue by assuming failure.
2. Do not create a second refund.
3. Leave the protected request intact.
4. If the modal offers **Retry protected request**, that action safely reuses the same request reference and amount.
5. Automatic recovery will continue checking PayMongo even if the administrator closes the modal.
6. Check both CargoExpress Payment History and the matching PayMongo payment/refund record before any manual intervention.

If CargoExpress reports **Automatic review in progress**, the request is outside the safe automatic resubmission window. Do not start another refund until the provider record has been reviewed.

## Refunds created in PayMongo Dashboard

Use the CargoExpress admin refund action whenever it is available because it reserves the amount first and records the initiating administrator.

For an eligible legacy PayMongo Source payment that the API refuses to refund, the administrator may need to create the refund in PayMongo Dashboard. In that case:

1. Confirm the exact original PayMongo payment ID.
2. Confirm the refundable amount and previous refunds.
3. Create the refund once in the correct PayMongo mode.
4. Do not manually add a payment or negative payment row in CargoExpress.
5. Wait for the signed webhook or automatic recovery to record it.
6. Verify that CargoExpress shows the matching provider refund ID and correct status.

If every webhook is missed, dashboard-created refund discovery normally depends on the payment's active background scan window. Escalate any dashboard refund that does not appear in CargoExpress after the next scheduled scan rather than creating it again.

## Test mode versus live mode

| Mode | What happens | Real money? |
|---|---|---|
| PayMongo test mode | Refunds exercise the same CargoExpress ledger, status, webhook, idempotency, and recovery logic using test resources. | No |
| PayMongo live mode | Refunds use live PayMongo payments and return real funds through the original payment method. | Yes |

Test and live resources are isolated. A test payment or refund cannot be managed with a live secret key, and a live payment cannot be managed with a test key. Before production use, ensure the live PayMongo secret key and the live webhook endpoint/events are configured. Do not copy test payment IDs into live operations.

## What changes when a refund succeeds?

When, and only when, PayMongo reports `succeeded` and CargoExpress reconciles it:

- A separate refund row appears in admin and customer payment history.
- The refund amount is displayed as a negative amount.
- `orders.amount_paid` becomes gross successful payments minus succeeded refunds.
- Remaining balance and payment status are recalculated from that net amount.
- Sales and reports retain gross collections, show refunds separately, and calculate net collections.
- The customer receives one deduplicated **Refund Completed** notification.
- The shipment status remains unchanged.

Pending, processing, failed, and unknown refunds do not reduce collected totals and do not generate a completed-refund notification.

## Admin verification checklist

Before submitting:

- Confirm the correct order and original PayMongo GCash payment.
- Confirm whether the customer requested a full or partial refund.
- Check the already-refunded and available-to-refund amounts.
- Check PayMongo for an existing refund if the customer or another admin may have already acted.
- Record a clear reason and useful note.

After submitting:

- Record the CargoExpress status and provider refund reference.
- Do not rely on toast color alone; read the exact status label.
- Confirm that only **Refund Completed** reduces the order's collected total.
- Confirm the customer's order balance and payment status after completion.
- Confirm the refund appears in customer/admin history and reports.
- Ask the customer to confirm GCash receipt separately from provider completion.

## Troubleshooting and escalation

### The Refund button is missing

Check whether the payment was a verified PayMongo GCash payment, whether it is paid/partially paid, and whether any refundable balance remains. Manual payments cannot use this action.

### The refund remains pending or processing

Wait through the next automatic recovery cycle and check PayMongo Dashboard. PayMongo describes a refund remaining pending or processing for an extended period as rare and recommends contacting PayMongo Support if it does not progress after a few minutes.

### PayMongo shows succeeded but CargoExpress does not

Do not create another refund. Keep the provider refund ID, payment ID, amount, mode, and timestamps. Wait for automatic recovery, then escalate for technical review if the next scheduled scan does not reconcile it.

### CargoExpress shows completed but the customer cannot see the money

CargoExpress completion means PayMongo confirmed provider success and the local ledger was updated; it does not prove the customer's GCash wallet has posted the funds. Ask the customer to recheck within the day. If it remains missing, collect the provider refund ID and contact PayMongo Support.

### The refund failed

No refund amount was deducted from the order's collected total. Review the error and PayMongo record before submitting a new request. Repeated provider failure should be escalated to PayMongo Support.

## Information to collect for support

Do not send secret API keys, service-role keys, access tokens, or webhook secrets.

Collect only:

- CargoExpress order tracking number
- Original PayMongo payment ID (`pay_...`)
- PayMongo refund ID (`ref_...`), if created
- Refund amount and reason
- Current CargoExpress refund status
- PayMongo mode: test or live
- Date and time submitted
- Screenshot of the PayMongo refund record, with sensitive information hidden

## Technical ownership reference

- Admin request function: `supabase/functions/paymongo-refund`
- Signed webhook function: `supabase/functions/paymongo-webhook`
- Automatic recovery function: `supabase/functions/paymongo-refund-recovery`
- Refund ledger migration: `supabase/migrations/20260912184434_paymongo_refunds_and_failures.sql`
- Recovery migration and schedule: `supabase/migrations/20260913000441_add_paymongo_refund_recovery.sql`
- Admin refund UI: `src/components/ui/RefundPaymentModal.jsx`
- Shared refund wording: `src/utils/paymentDisplay.js`

PayMongo API references:

- [Refund resource and statuses](https://docs.paymongo.com/reference/refund-resource)
- [Create a refund](https://docs.paymongo.com/reference/create-a-refund)
