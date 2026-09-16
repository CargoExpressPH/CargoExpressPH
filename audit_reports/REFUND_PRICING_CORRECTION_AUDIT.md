# Refund & Pricing Correction Audit Report

## 1. Taglish Explanation of the Existing Implementation
Ang system natin ay built for this exact scenario. Kapag nagkamali ang admin sa rate (₱70/kg instead of ₱65/kg), pwede niya itong i-correct by simply editing the order's weight/cost directly on the Order Detail page para maging ₱6,500. 

Ang kagandahan sa existing system natin (specifically the `payment_refunds` architecture introduced in `20260912184434_paymongo_refunds_and_failures.sql`), decoupled ang money collected (`payment_transactions`) sa actual shipment status (`orders`). Kapag nag-issue ng ₱500 refund ang admin via PayMongo, gagawa ang system ng strictly-tracked ledger record sa `payment_refunds` table. Pag successful na ang refund from PayMongo, ibabawas ng database trigger (`update_order_payment_totals`) ang ₱500 refund mula sa total successful payments (₱7,000 - ₱500 = ₱6,500). Dahil corrected na ang charge sa ₱6,500, ang bagong balance will be `GREATEST(0, 6500 - 6500) = 0`. Walang magiging negative balance, at hindi magiging `unpaid` ang shipment!

## 2. Direct Answers on "What 'Refund' Currently Means"
- **Can the admin issue a partial refund?** Yes. The `RefundPaymentModal` allows inputting any amount up to the `refundable_amount`.
- **Is it linked to a specific successful payment?** Yes, each refund is strictly bound to a `payment_transactions` record.
- **Does refunding change the booking’s final charge, or only return money?** It only returns money. Charge modifications are done separately by editing the order details.
- **Does a successful refund reduce amount_paid?** Yes. `update_order_payment_totals()` correctly computes `amount_paid = gross_paid - refunded_amount`.
- **Does it reopen a balance?** Only if the total collected (after refund) falls below the corrected/final charge. In our scenario where the charge was corrected to ₱6,500 and net collected becomes ₱6,500, the balance stays at ₱0.
- **Can a fully settled booking incorrectly become unpaid after an overcharge refund?** No. As long as the `amount_paid` (₱6,500) matches or exceeds the current `shipping_cost` (₱6,500), it stays `paid`.
- **Does the system distinguish a pricing correction from cancellation, overpayment return, or payment reversal?** Yes. It leaves the original ₱7,000 successful payment record untouched, adjusts the order’s `shipping_cost`, and appends a dedicated `payment_refunds` ledger entry.
- **Does entering a refund reason actually affect computation, or is it only a note?** It is only a note/categorization saved in the database.

## 3. Computation Walkthrough

| Stage | Original Charge | Current Corrected Charge | Gross Successful Payments | Pending Refund | Successful Refunds | Net Collected | Customer Amount Still Due | Amount Owed Back to Customer | Payment Status | What Admin/Customer Sees |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **A. ₱7k paid** | ₱7,000 | ₱7,000 | ₱7,000 | ₱0 | ₱0 | ₱7,000 | ₱0 | ₱0 | Paid | ₱7k paid, balance ₱0 |
| **B. Charge corrected to ₱6.5k** | ₱7,000 | ₱6,500 | ₱7,000 | ₱0 | ₱0 | ₱7,000 | ₱0 | ₱500* | Paid | Charge is ₱6.5k, total paid ₱7k, balance ₱0 |
| **C. ₱500 refund pending** | ₱7,000 | ₱6,500 | ₱7,000 | ₱500 | ₱0 | ₱7,000 | ₱0 | ₱500* | Paid | Pending refund visible. Balance still ₱0. |
| **D. Refund succeeds** | ₱7,000 | ₱6,500 | ₱7,000 | ₱0 | ₱500 | ₱6,500 | ₱0 | ₱0 | Paid | Refund succeeded. Net paid ₱6.5k, balance ₱0. |
| **E. Refund fails** | ₱7,000 | ₱6,500 | ₱7,000 | ₱0 | ₱0 | ₱7,000 | ₱0 | ₱500* | Paid | Refund failed. Net paid ₱7k, balance ₱0. |
*(Note: Owed back to customer is implied manually. System balance is `GREATEST(0, fee - paid)`, so it caps at ₱0 and never shows a negative balance).*

## 4. Financial Safeguards Verified
- **Authorization:** Handled securely via edge functions (`paymongo-refund`), verifying admin role.
- **Audit trail:** Original payment `amount` is untouched; refunds are recorded in a separate `payment_refunds` table.
- **Over-refund protection:** Checked both client-side (`refundable_amount`) and DB-side (`v_amount > v_payment.amount - v_reserved + 0.005`).
- **Concurrent requests:** Idempotency keys and DB row locks (`FOR UPDATE` on `payment_transactions`) prevent duplicate refunds.
- **Failure recovery:** Safe fallback edge states (e.g., timeouts) correctly map to 'uncertain' and await manual webhook recovery without polluting reports.

## 5. Payment-Method Cases
- **GCash (PayMongo):** Fully supported via automated API refund capability. UI displays the refund button on valid transactions.
- **Cash / Manual GCash / PayLater:** Not supported for automated or manual UI refunding. The system UI requires `payment_method === 'gcash'` AND `gcash_channel === 'paymongo'` to even show the Refund button. If a cash overcharge occurs, the admin cannot use the app to log the refund currently.

## 6. Reports and Customer-Facing Information
- Unpaid Shipments query only includes `outstanding > 0`. Since `outstandingBalance()` derives from `Math.max(0, finalShippingFee - amount_paid)`, the corrected ₱6,500 fee less ₱6,500 net collected results in `0`. The booking correctly vanishes from Unpaid Shipments.
- Sales Reports summarize `amount_paid` (which factors in the net) and `payment_refunds` (gross refunds). Totals remain balanced.

## 7. Recommended Minimal Correction Flow
1. **Admin updates Order Details:** Admin edits the weight/rate on the Order Detail page to reflect the correct ₱6,500 charge.
2. **Admin triggers Refund:** In the Payment History section, Admin clicks the Refund button on the original ₱7,000 PayMongo payment.
3. **Admin inputs Amount:** Enters `500`, sets Reason as "Requested by customer", and submits.
4. **System handles the rest:** CargoExpress and PayMongo coordinate to settle the transaction and update the ledger.

---

### Kapag ₱7,000 ang nabayaran pero ₱6,500 lang ang tamang singil, ano mismo ang gagawin ng admin at ano ang mangyayari sa balance at reports?

Ang gagawin lang ng admin ay i-edit yung shipping cost/weight sa system para maging ₱6,500, tapos i-click ang "Refund" button dun sa original GCash payment record at i-enter ang ₱500. 

Habang pending ang refund, ang balance ay mananatiling ₱0 (dahil sobra pa rin ang bayad kumpara sa bagong singil). Kapag successful na ang refund sa PayMongo, ang Net Collected natin ay magiging ₱6,500 automatically. Dahil ₱6,500 ang tamang singil at ₱6,500 ang Net Collected, `Paid` pa rin ang status ng order at hindi ito lalabas sa Unpaid Shipments. Sa Sales Reports, hiwalay na makikita ang Gross Payments (₱7,000) at ang Successful Refunds (₱500) para malinis ang accounting.
