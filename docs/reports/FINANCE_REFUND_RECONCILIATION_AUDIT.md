# Finance and Refund Reconciliation Audit

## Simple Taglish Explanation (Executive Summary)
Walang totoong bug sa math ng database ninyo! Ang nakikita ninyong kakaibang numbers (₱18,500 Gross, ₱12,000 Refunds, 12 GCash payments) ay **direktang resulta ng repeated testing** sa iisang booking (`CE-20260913-2907`). 

Dahil paulit-ulit kayong nag-test ng bayad at refund sa iisang booking:
- **Payment Attempts vs Successful Payments:** Bawat beses na nag-succeed ang test payment ninyo, nag-re-record ang system ng isang "successful payment". Nangyari ito 12 times gamit ang GCash, kaya "12 payments" ang nakasulat, kahit isa lang ang booking.
- **Gross Collected (₱18,500):** Ito ang total ng lahat ng pera na pumasok (12 payments).
- **Refunds (₱12,000):** Ito ang total ng 5 beses na nag-test kayo ng refund.
- **Net Collected (₱6,500):** Ito ang natirang pera (₱18,500 pumasok - ₱12,000 lumabas = ₱6,500). Ito rin ang eksaktong halaga ng mismong delivery fee kaya **₱0** na ang Outstanding Balance.

## Metric Definitions and Formulas
Based on `src/lib/database.js` and database triggers:
- **Total Revenue:** Computed as `SUM(amount_paid)` for non-cancelled orders. It acts as "Cash Revenue" (cash accounting), not accrued booking value.
- **Gross Collected:** Computed as the sum of all `payment_transactions` with status `paid` or `partial`.
- **Successful Refunds:** Sum of all `payment_refunds` with status `succeeded`.
- **Net Collected:** Same as `SUM(amount_paid)`, which matches `Gross Collected` minus `Successful Refunds`.
- **Date Scope Warning:** The report filters by **Booking Date** (`orders.created_at`), not the actual transaction dates. If a booking made in August is refunded in September, running a September report will NOT show that refund.

## Transaction Reconciliation (Order `CE-20260913-2907`)
- **Booking Fee:** ₱6,500
- **Total Payments:** 12 GCash transaction rows (status: `paid` or `partial`) whose `amount` sums up to ₱18,500.
- **Total Refunds:** 5 refund rows (status: `succeeded`) whose `amount` sums up to ₱12,000.
- **Database Trigger Execution (`update_order_payment_totals`):** Every time a payment or refund is logged, the database computes: `v_total_paid = GREATEST(gross_paid - refunded, 0)`.
- `18,500 - 12,000 = 6,500`. 
- The booking's `amount_paid` is updated to ₱6,500.
- The `remaining_balance` is calculated as `6,500 (fee) - 6,500 (paid) = 0`.

## Provider Verification Status
**Unverified for Real Fiat Currency.** 
The database records show `status = 'succeeded'` for these refunds. The Edge Functions enforce that this status is only written if the PayMongo API accepts the refund payload. However, without read-only access to the PayMongo Dashboard, we cannot confirm if real money was transferred or if this was purely a Sandbox/Testmode success.

## Confirmed Bugs vs Expected Testing Effects
- **Expected Testing Effect:** The inflated Gross (18.5k) and Refund (12k) counts are mathematically correct representations of your test history. No SQL joins are multiplying rows; the system simply accurately recorded all 17 of your test actions.
- **Confirmed Flaw:** `Total Revenue` is calculated using `amount_paid` (cash received) rather than `shipping_cost` (business accrued value). If a customer hasn't paid yet, they contribute ₱0 to Total Revenue, which conflates Revenue with Cash Flow.
- **Confirmed Flaw:** The report's date filter scopes payments and refunds by the *order's creation date*, not the *transaction date*.

## Code Fixes and Unresolved Questions
- **Print Layout:** Fixed! A React Portal was implemented in `PrintDocument.jsx` to detach the print UI from `#root`, eliminating the extra blank pages.
- **Unresolved for Defense:** Do you want "Total Revenue" to represent "Total Booked Value" (`shipping_cost`) or "Total Cash Received" (`amount_paid`)? If the panelists ask, currently it represents Cash Received.
