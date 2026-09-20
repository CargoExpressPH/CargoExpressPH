# CargoExpressPH Discount, Overpayment, and Refund Audit

## Taglish Summary of How Discounts Work
Ang discount sa system ay isang fixed peso amount (`discount_amount`) na binabawas mula sa original `shipping_cost` para makuha ang final charge. Ang original na `shipping_cost` ay hindi pinapalitan, kaya laging intact ang history. Kapag nag-apply ang admin ng discount, kailangan may valid `discount_reason` ('Regular customer', 'Negotiated price', o 'Other') at `discount_notes`. Laging admin lang ang pwedeng mag-set nito (read-only sa customers) at hindi pwedeng maging negative o mas malaki sa shipping cost ang ibabawas. 

## Exact Computations & Code References
*   **Original Charge Preservation:** `orders.shipping_cost` is never altered. It represents the original weight × rate. (Ref: `20260911010000_shipping_discount_schema.sql`)
*   **Final Charge Formula:** `v_payable := public.order_payable_amount(v_shipping_cost, v_discount_amount);` (Ref: `20260911020000_shipping_discount_guards.sql`). It evaluates to `shipping_cost - discount_amount`, floored at 0.
*   **Remaining Balance Formula:** `v_remaining := GREATEST(0, v_payable - v_total_paid);` (Ref: `update_order_payment_totals` in `20260912184434_paymongo_refunds_and_failures.sql`).
*   **Payment Status Formula:** In `derive_payment_status`: `WHEN COALESCE(p_amount_paid, 0) >= COALESCE(p_shipping_cost, 0) - 0.005 THEN 'paid'` (Note: internally it uses `payable` now instead of `shipping_cost`).

## What Happens When a Discount is Applied After Payment
If an admin applies a ₱500 discount to a fully paid ₱7,000 order:
*   **Final Charge (Payable):** Becomes ₱6,500.
*   **Amount Paid:** Remains ₱7,000 (until a refund successfully pushes through).
*   **Remaining Balance:** The system evaluates `GREATEST(0, 6500 - 7000)`, which equals **0**. The excess ₱500 is **hidden behind a zero remaining balance**; the UI does not explicitly show "Amount to return ₱500".
*   **Payment Status:** Remains `paid` because `amount_paid` (7000) is >= `payable` (6500).

## Does the Current Feature Safely Support Overcharge Corrections?
**No, not safely.** While an admin can technically apply a discount with reason "Other" and notes "Overcharge correction", the system only supports a **single** `discount_amount` column. 
*   **Issue:** If a legitimate promotional discount (e.g., ₱200) already exists, applying a ₱500 correction would require the admin to overwrite the record (summing it to ₱700 and changing the reason). This mixes business concepts, corrupts the original promo history, and inflates promotional reports. A separate charge-adjustment or dedicated correction action is safer.

## Which GCash Refund/Payout Paths Are Supported?
*   **PayMongo GCash Refunds:** **Supported.** The `payment_refunds` ledger specifically expects a `pay_...` PayMongo ID.
*   **Cash or Manual GCash Refunds:** **Not Supported.** The database RPC `prepare_paymongo_refund` explicitly rejects any payment where `gcash_channel IS DISTINCT FROM 'paymongo'` or the ID isn't a PayMongo reference.
*   **Payouts to a Different GCash Account:** **Not Supported.** PayMongo refunds automatically go back to the exact source account. The system lacks any integration with a Payout API.
*   **Manual Transfers + Recorded Refund:** **Not Supported by the System.** An admin can manually send GCash to the customer, but the system's `payment_refunds` table rejects manual recording because it enforces strict PayMongo data formats (`refund_id ~ '^ref_'`).

## Smallest Practical Proposed Workflow
Since we cannot integrate a full Payout API immediately, and reusing the discount feature overrides promos, the smallest viable change is:
1.  **Add an `overcharge_adjustment` column** to `orders` (separate from `discount_amount`). Update `order_payable_amount` to subtract both.
2.  **Add a `manual_refunds` table** (or relax `payment_refunds` constraints) to record manual GCash transfers (Fields: `amount`, `destination_gcash`, `reference_number`, `admin_id`, `notes`).
3.  **Update `update_order_payment_totals`** to include `manual_refunds` in the `v_refunded` calculation.

## Necessary UI/Backend Changes
*   **Backend:** 
    *   Migration to add `overcharge_adjustment` to `orders`.
    *   Migration to relax `payment_refunds` to accept `gcash_channel = 'manual'` and non-PayMongo references, OR create a new `manual_refunds` table.
*   **Frontend:** 
    *   A new UI action in `OrderDetailPage` for "Correct Overcharge" that handles the adjustment amount.
    *   A new modal for "Record Manual GCash Refund" when returning money for non-PayMongo transactions. 

## Verified Findings vs Unresolved Questions
*   **Verified:** The discount feature floors the remaining balance at 0. Overpayments are not explicitly displayed. The existing refund API strictly locks down to PayMongo only.
*   **Verified:** `get_sales_summary()` buckets refunds by the *original* payment method. If a Cash payment is refunded via GCash, it reduces the net 'Cash' bucket, which might cause cash-drawer reconciliation mismatches for admins.
*   **Unresolved:** How does the business want to handle the cash-drawer mismatch if they return cash via GCash? Do they want to log it as a GCash expense instead of a Cash refund?

## Before/After Table (Applying ₱500 Adjustment)

| Scenario | Original Payable | Amount Paid | Adjustment | New Payable | New Amount Paid | Remaining Balance | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Fully Paid (Cash/GCash)** | ₱7,000 | ₱7,000 | ₱500 | ₱6,500 | ₱7,000 | ₱0 (Hidden Excess) | Paid |
| **Partially Paid** | ₱7,000 | ₱5,000 | ₱500 | ₱6,500 | ₱5,000 | ₱1,500 | Partial |
| **Pending Refund (Provider)** | ₱7,000 | ₱7,000 | ₱500 | ₱6,500 | ₱7,000 | ₱0 | Paid |
| **Successful Refund (₱500)** | ₱7,000 | ₱6,500 | ₱500 | ₱6,500 | ₱6,500 | ₱0 | Paid |

*(Note: Reusing the discount calculation corrupts promo history if one exists; a separate adjustment action is highly recommended.)*
