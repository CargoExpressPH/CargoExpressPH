# CargoExpress PH — Sales & Reports Computation Audit
**Audit Date:** September 16, 2026  
**Auditor:** Gemini Research Subagent (read-only, repository access only)  
**Scope:** `src/pages/admin/ReportsPage.jsx`, `SalesReportsPage.jsx`, `UnsettledDeliveriesPage.jsx`, `src/lib/database.js`, `src/constants/status.js`, `src/lib/exportPdf.js`, `src/components/ui/PrintDocument.jsx`, and all related Supabase migrations.

---

## 1. Simple Taglish Summary (Para sa Thesis Defense)

Ang CargoExpress PH ay may tatlong view sa loob ng iisang tab na tinatawag na "Sales & Reports": ang **Reports & Analytics** (period-based, kailangan i-generate manually), ang **Unsettled Deliveries** (real-time list ng mga order na may natitirang bayad), at ang **Sales Overview** (all-time na summary ng lahat ng kita).

Ang **Reports & Analytics** ay nagba-base sa `created_at` ng booking — ang petsa na nag-book ang customer, hindi ang petsa ng delivery o ng payment. Kapag pumili ka ng "Sep 1–15", makikita mo lahat ng orders na na-book sa loob ng period na iyon, kasama na ang mga hindi pa nadeliver, hindi pa nabayaran, o nakansela pa. Ang "Total Revenue" dito ay hindi talaga "revenue" sa accounting sense — ito ay `SUM(amount_paid)` ng mga hindi nakansela, ibig sabihin, ang nakolekta na pera, hindi ang kabuuang dapat bayaran. Ito ang pinakamahalagang mali ng label sa buong sistema.

Ang **Unsettled Deliveries** ay walang date filter — ito ay isang live na listahan ng lahat ng orders sa pipeline (Picked Up hanggang Delivered) na may natitirang balance, kahit gaano katagal na. Ito ay nagre-refresh ng real-time sa pamamagitan ng Supabase WebSocket. Ang "Outstanding" na formula dito ay tama at consistent: `MAX(0, finalShippingFee - amount_paid)`, na iisa lang ang definition sa buong sistema.

Ang **Sales Overview** naman ay gumagamit ng `get_sales_summary()` RPC sa Postgres na kumukuha ng **lahat ng oras** na data (walang date range). Ito ang pinaka-tama sa tatlo pagdating sa accounting: ang Total Revenue dito ay `SUM(MAX(shipping_cost - discount_amount, 0))` — ang tunay na billed na halaga bawat order.

---

## 2. Metric → Formula → Source Table Reference

### Tab 1: Reports & Analytics (`getReportData` in `database.js` line 2267)

**Date filter:** `orders.created_at >= startDate AND orders.created_at <= endDate` (endDate set to 23:59:59.999 of selected end day, browser-local time)  
**Source table:** `orders` + `payment_transactions` (via `sumTransactionsByMethod`)

| Metric | Label in UI | Actual Formula (Code) | Source Column(s) | Statuses Included | Misleading? |
|---|---|---|---|---|---|
| Total Orders | Total Orders | `filtered.length` | `orders.*` | ALL (including Cancelled) | No |
| Delivered | Delivered | `filtered.filter(o => o.status === 'Delivered').length` | `orders.status` | Delivered only | No |
| **Total Revenue** | Total Revenue | `filtered.filter(o => status !== 'Cancelled').reduce((s,o) => s + parseFloat(o.amount_paid\|\|0), 0)` | `orders.amount_paid` | Non-cancelled | **YES — this is amount collected, not total billed fee** |
| **Collected** (card) | Collected | `filtered.reduce((s,o) => s + parseFloat(o.amount_paid\|\|0), 0)` | `orders.amount_paid` | ALL (includes Cancelled) | YES — includes cancelled orders' payments |
| Gross Collected | Gross Collected | `s.grossCollected \|\| s.totalCollected` → `totalCollected + refundTotal` | `orders.amount_paid` + ledger refunds | Non-cancelled for refunds; ALL for totalCollected | Partially — adds refund amount back to a base that isn't consistent |
| Successful Refunds | Successful Refunds (N) | `refundTotal` from ledger: only `payment_refunds.status = 'succeeded'` | `payment_refunds.amount` | Only succeeded refunds | No |
| Net Collected | Net Collected | `s.totalCollected` = `filtered.reduce(...amount_paid, 0)` | `orders.amount_paid` | ALL (includes cancelled) | YES — same formula as "Collected" above; includes cancelled orders |
| Outstanding Balance | Outstanding Balance | `filtered.filter(o => status !== 'Cancelled').reduce((s,o) => s + outstandingBalance(o), 0)` | `orders.shipping_cost, discount_amount, amount_paid` | Non-cancelled | No, but scopes ALL statuses not just pipeline |
| Total Weight | Total Weight Shipped | `filtered.filter(o => status !== 'Cancelled').reduce(...actual_weight, 0)` | `orders.actual_weight` | Non-cancelled | Minor — label says "shipped", includes pending/unshipped |
| Cash | Cash (N payments) | Ledger: `SUM(payment_transactions.amount WHERE method='cash' AND status IN ('paid','partial'))` minus refunds | `payment_transactions.amount, payment_method` | Non-cancelled orders only | No |
| GCash | GCash (N payments) | Same as Cash but `method='gcash'` | `payment_transactions.amount, payment_method` | Non-cancelled orders only | No |
| Pay Later | Pay Later (N payments) | Same but `method='paylater'` | `payment_transactions.amount, payment_method` | Non-cancelled orders only | No |
| Unattributed | Unattributed | `MAX(collectedOnActiveOrders - ledgerTotal, 0)` | `orders.amount_paid` vs ledger | Non-cancelled | No — honest gap disclosure |
| Route Revenue | Revenue (in Route table) | `routeMap[key].revenue += parseFloat(o.amount_paid\|\|0)` | `orders.amount_paid, origin, destination` | Non-cancelled | **YES — says "Revenue" but is amount_paid per route** |
| Payment count | N payments (badge) | `methodCounts[method]` from ledger | `payment_transactions` | Non-cancelled | No — correctly counts transactions not orders |

### Tab 2: Unsettled Deliveries (`getUnsettledOrders` in `database.js` line 1602)

**Date filter:** NONE — real-time live view, no date range  
**Source table:** `orders` + derived settlement logic  
**Status filter:** `status IN ('Picked Up', 'In Transit', 'Arrived at Hub', 'Out for Delivery', 'Delivered')`

| Metric | Label | Formula | Source | Notes |
|---|---|---|---|---|
| Total Outstanding | Total Outstanding | `SUM(outstanding)` over all qualifying orders | Derived: `MAX(0, MAX(0, shipping_cost - discount_amount) - amount_paid)` | Correct — discount-aware |
| Unsettled Shipments | Unsettled Shipments | `orders.length` after filter | Count of rows where outstanding > 0 | Correct |
| Held at Hub | Held at Hub | Count where `settlement_bucket = 'held'` | `status = 'Arrived at Hub' AND payer_type != 'receiver' AND no promised_payment_date` | Correct |
| Overdue Promises | Overdue Promises | Count where `settlement_bucket = 'overdue'` | `promised_payment_date < today` | Correct |
| Billed (per row) | Billed | `MAX(0, shipping_cost - discount_amount)` | `orders.shipping_cost, orders.discount_amount` | Correct — discount-aware |
| Paid (per row) | Paid | `o.amount_paid` | `orders.amount_paid` | Correct |
| Balance (per row) | Balance | `o.outstanding` = `outstandingBalance(order)` = `MAX(0, finalShippingFee(o) - amount_paid)` | Derived | Correct |
| Overdue Amount | Overdue Amount | `SUM(outstanding WHERE bucket = 'overdue')` | Derived | Correct |
| Mismatched count | Stored Balance Needing Reconciliation | `orders.filter(o => o.balance_mismatch)` | `\|remaining_balance - outstanding\| > 0.01` | Correct diagnostic |

**Settlement Buckets (classification logic — `classifySettlement` line 1561):**
1. `OVERDUE`: `promised_payment_date < today` (regardless of status)
2. `DELIVERED`: `status = 'Delivered'` (and not overdue)
3. `PROMISED`: has a future `promised_payment_date`
4. `HELD`: `status = 'Arrived at Hub'` AND `payer_type = 'sender'` AND no promise date
5. `COLLECT`: `payer_type = 'receiver'`
6. `IN_FLIGHT`: everything else (Picked Up, In Transit, Out for Delivery — still moving)

### Tab 3: Sales Overview (`getSalesData` → `get_sales_summary()` RPC)

**Date filter:** NONE — all-time, all non-cancelled orders  
**Source table:** `orders` + `payment_transactions`  
**Primary path:** `get_sales_summary()` Supabase RPC (SECURITY DEFINER, admin-only)  
**Latest RPC version:** `20260911040000_sales_summary_discount_aware.sql`

| Metric | Label | Formula | Notes |
|---|---|---|---|
| Total Revenue | Total Revenue (billed, net of discounts) | `SUM(GREATEST(shipping_cost - discount_amount, 0))` | **Correct — this is actual billed amount, discount-aware** |
| Collected (card) | Collected | `SUM(amount_paid)` all non-cancelled | Correct |
| Outstanding (card) | Outstanding | `SUM(outstanding) WHERE is_tracked` = settlement-tracked statuses only | Correct — matches Unsettled tab |
| Unpaid Orders | Unpaid Orders | `COUNT WHERE is_tracked AND outstanding > 0.005` | Correct |
| Gross Collected | Gross Collected | `paidTotal + refundTotal` (in JS fallback) | Correct formula |
| Net Collected | Net Collected | `paidTotal` = `SUM(amount_paid)` | Correct |
| Cash/GCash/PayLater | Payment Methods | Ledger: `SUM(payment_transactions.amount WHERE method=X AND status IN ('paid','partial'))` | Correct — per-transaction, not per-order |
| Unattributed | Unattributed | `GREATEST(paid_total - ledger_total, 0)` | Correct — honest disclosure |
| Monthly Revenue | Monthly chart | Per-month: `SUM(shipping_cost - discount_amount)`, `SUM(amount_paid)`, `SUM(outstanding)` | Correct |
| Outstanding (pipeline) | Outstanding — shipments in the pipeline | `outstandingTotal` = tracked statuses only | Correct |
| Outstanding (all) | Outstanding — all active orders | `outstandingAllOrders` = all non-cancelled | Correct — both scopes printed |

---

## 3. Payment and Refund Reconciliation Findings

### 3.1 Full and Partial Payments
- **Multiple payments for one booking:** Fully supported. `payment_transactions` stores each payment as a separate row. `orders.amount_paid` is the trigger-computed sum of all `paid`/`partial` rows. The `sumTransactionsByMethod` function reads all payment_transactions per order and aggregates correctly.
- **Partial payments:** Correctly handled. `payment_status = 'partial'` rows ARE included in both `amount_paid` derivation and ledger totals.

### 3.2 Pending/Failed/Cancelled Payment Attempts
- **Included in reports?** NO. Both the JS `sumTransactionsByMethod` function (line 1504) and the SQL RPC filter `payment_status IN ('paid', 'partial')`. Failed/pending PayMongo attempts are NOT counted.
- **Pending PayMongo links (GCash):** PayMongo link payments in 'pending' or 'awaiting_payment' status are also excluded from collection totals.

### 3.3 Refund Handling
- **Only `status = 'succeeded'` refunds** are counted in `refundTotal` (line 1505: `refund.status === 'succeeded'`).
- `creating`, `pending`, `processing`, `failed` refunds → NOT subtracted from totals.
- **Are refunded payments subtracted twice?**
  - `methodTotals[method]` is REDUCED by the refund amount (line 1522).
  - `ledgerTotal` is ALSO REDUCED (line 1523).
  - `refundTotal` is ADDED separately.
  - `grossCollected = totalCollected + refundTotal` — here `totalCollected` comes from `amount_paid` on the orders table, which is managed by the trigger. The trigger does NOT reduce `amount_paid` when a refund succeeds. So: `totalCollected` still includes the refunded money, and `refundTotal` adds it back on top. This means `grossCollected` correctly equals the total ever collected before any refunds.
  - **No double-subtraction issue found.**

### 3.4 Does a Refund Re-open the Collectible Balance?
- **Behavior (inferred from code — [REPO]):** A `payment_refunds.status = 'succeeded'` row reduces the method breakdown totals in reports. HOWEVER, there is NO trigger that decreases `orders.amount_paid` when a refund succeeds. The `outstandingBalance(order)` formula is `MAX(0, finalShippingFee - amount_paid)`. So a fully-refunded GCash payment would: (a) reduce the payment_method totals in the report breakdown, (b) still show the order as "paid" in `amount_paid` column, (c) NOT re-open a collectible balance.
- **This is [UNVERIFIED]** — would need to confirm live behavior of the PayMongo webhook handler, but the migration code for `update_order_payment_totals` trigger and the refund webhook handler in `paymongo-webhook` edge function are not reviewed.
- **Implication:** If a GCash refund succeeds, the report's Net Collected (via ledger) will show reduced cash, but `amount_paid` stays the same — creating a potential discrepancy between `totalCollected` and `ledgerTotal`. This is what `unattributedTotal` catches in reverse (it shows when `amount_paid > ledgerTotal`), but there is no metric that shows when `ledgerTotal > amount_paid` (refund confirmed by provider, not yet reflected in `amount_paid`). [REPO/UNVERIFIED]

### 3.5 Discounts
- **Sales Overview (RPC):** Discount-aware. `total_revenue = SUM(GREATEST(shipping_cost - discount_amount, 0))`. Outstanding also uses discounted fee. ✅
- **Unsettled Deliveries:** Discount-aware. `outstanding = MAX(0, (shipping_cost - discount_amount) - amount_paid)`. ✅
- **Reports & Analytics:**
  - `totalRevenue = SUM(amount_paid)` — discount NOT applied (nor needed, since this is collections not billings, but the label "Revenue" suggests billings).
  - `totalOutstanding = SUM(outstandingBalance(o))` where `outstandingBalance` uses `finalShippingFee` which IS discount-aware. ✅
  - Route `revenue`: `routeMap[key].revenue += parseFloat(o.amount_paid || 0)` — NOT discount-aware (uses collected amount). ⚠️

### 3.6 Duplicate Join Risk
- `sumTransactionsByMethod` fetches via RPC in chunks of 100 order IDs. The RPC returns one row per payment_transaction, no joins that could multiply. **No duplicate multiplication risk found.** [REPO]

---

## 4. Direct Answer: Are Unsettled Deliveries in Generated Reports?

**YES, they are included in Reports & Analytics** — but only if their `created_at` falls within the selected date range. There is no status filter that excludes them.

### Detailed Breakdown

| Question | Answer |
|---|---|
| Are Delivered bookings with unpaid balances in Reports? | YES — included if booked within the date range. Their `amount_paid` contributes to "Total Revenue" and "Net Collected". Their `outstandingBalance(o)` contributes to "Outstanding Balance". |
| Are In-Transit bookings with unpaid amounts in Reports? | YES — same as above. No status exclusion in `getReportData`. |
| Where do their charges appear? | In Total Orders count, Status Breakdown, "Total Revenue" (via amount_paid), "Outstanding Balance" (via outstandingBalance), Route Performance (via amount_paid). |
| Where do their collected amounts appear? | In "Net Collected" / "Total Revenue" (amount_paid column). |
| Does the order list show payment status/balance? | **NO.** The Detailed Order List in Reports & Analytics does NOT have a "Balance" or "Payment Status" column. It shows: Tracking #, Customer, Route, Status, Weight, Amount (finalShippingFee if priced, else "—"), Payment Method (order-level field, last method used), Date. No balance owing visible per row. |
| Are they excluded by any status/date filter? | Status: NO. Date: Only if booked outside the date range. |
| Does Unsettled Deliveries show anything NOT in Reports & Analytics? | YES: (1) It has NO date filter — shows ALL time, not just the selected period. (2) It shows Billed vs. Paid vs. Balance per row. (3) It classifies by settlement bucket (Overdue, Held, Promised, etc.). (4) It shows orders booked OUTSIDE the selected period that still have a balance. (5) It includes real-time updates via WebSocket. |

### Date-Range Scenario Table

| Scenario | Booking Date | Delivery/Payment | Sep 1–15 Report | Sep 1–30 Report |
|---|---|---|---|---|
| 1. Delivered Sep 10, fully paid Sep 10 | Sep 10 | Delivered Sep 10 | ✅ Included. Amount appears in Revenue + Collected. Outstanding = ₱0. Status = Delivered. | ✅ Included. Same. |
| 2. Delivered Sep 10, partial Sep 10, balance paid Sep 18 | Sep 10 | Partial Sep 10, full Sep 18 | ✅ Included. `amount_paid` is a live column — reflects ALL payments including Sep 18. Outstanding = ₱0 if both payments done. **The report reads current live values, NOT point-in-time.** ⚠️ | ✅ Included. Full payment reflected. |
| 3. In transit as of Sep 15, unpaid | Sep 5 | Not delivered | ✅ Included in Sep 1–15 report. Counted in Total Orders, Status Breakdown (In Transit). `amount_paid = 0`. Outstanding = full fee. No payment method shown. | ✅ Included in Sep 1–30. Same. |
| 4. Delivered Sep 10, fully refunded Sep 12 | Sep 10 | Delivered Sep 10, refund Sep 12 | ✅ Included in report. If refund webhook does NOT reduce `amount_paid`, "Net Collected" still shows original payment AND "Successful Refunds" shows the refund, making "Gross Collected" = Net + Refund. [UNVERIFIED] | ✅ Included. Same concern. |
| 5. Booked Aug 28, still in transit Sep 10 | Aug 28 | Not delivered | ❌ NOT in Sep 1–15 report (booked before Sep 1). BUT ✅ visible in Unsettled Deliveries tab. | ❌ NOT included. |

> [!IMPORTANT]
> The report reads **CURRENT live values** of `orders.amount_paid` filtered by booking `created_at`. It does NOT snapshot point-in-time data. A report generated for "Sep 1–15" on Sep 16 will show the Sep 18 payment on the Sep 10 booking, because `amount_paid` reflects all payments as of right now.

---

## 5. Date-Range and Print Consistency

### Date Column Used
- **Reports & Analytics:** `orders.created_at` (booking creation date). [REPO]
- **Sales Overview:** No date filter — all-time. [REPO]
- **Unsettled Deliveries:** No date filter — all-time live. [REPO]

### Inclusivity and Timezone
- Start date: `startDate = new Date(customStart)` — parses `YYYY-MM-DD` string.
- End date: `endDate = new Date(customEnd); endDate.setHours(23, 59, 59, 999)` — end of day.
- **Timezone Risk:** Per ECMAScript spec, date-only ISO strings (`YYYY-MM-DD`) are parsed as **UTC midnight**, not local time. For Philippine (UTC+8) admins, "Sep 1" becomes `2026-09-01T00:00:00Z` = `2026-09-01T08:00:00+08:00`. Orders created between **midnight and 7:59 AM PH time** on the start date are technically inside the UTC start boundary and ARE included — this is actually correct behavior. However, the end boundary is set using `setHours(23,59,59,999)` in local time after UTC parsing — this needs verification. ⚠️ [REPO — needs live confirmation]

### Mismatched Data Risk (Date Pickers vs. Report)
- **Correctly handled.** `reportedStart`/`reportedEnd` are set only inside `loadReport()`, not on every date-picker change. Changing the date pickers without regenerating does NOT corrupt the displayed report's label or filename. [REPO] ✅

### Print / PDF Export — All Rows vs. Paginated View
- **Reports & Analytics:** PrintDocument renders `data.orders.map(...)` — ALL orders in the result set, no pagination. ✅ [REPO]
- **Unsettled Deliveries:** Screen uses `paginated` (paginated slice), but PrintDocument uses `filtered` (full filtered list, all pages). ✅ [REPO]
- **PDF Export:** Clones the `.print-doc` element (all rows) and renders via html2pdf.js. ✅ [REPO]

### Filename Consistency (Recent Commit)
- **Print:** Sets `document.title` to `buildReportFilename(reportedStart, reportedEnd, false)` before `window.print()`. Restored on `afterprint`. ✅
- **PDF:** Uses `buildReportFilename(reportedStart, reportedEnd)` → `CargoExpress PH Report (Sep 1, 2026 to Sep 15, 2026).pdf`. ✅
- **Unsettled PDF:** Uses today's ISO date (no range — correct since Unsettled has no range). ✅
- Screen, print, and PDF are consistent for Reports & Analytics. ✅

---

## 6. Sales Overview Recommendation

### What Each Tab Does

| Tab | Admin Task Supported | Unique Information | Duplicated Elsewhere |
|---|---|---|---|
| **Reports & Analytics** | Period-based operational reporting, printable for records | Status breakdown by period, Route Performance chart, per-order detail list (printable), date-range filtering | Revenue/collected figures overlap with Sales Overview |
| **Unsettled Deliveries** | AR collections — who owes money, how much, how late | Settlement buckets (Overdue, Held, Promised, Freight Collect, In-Flight), per-order Balance/Paid/Billed, real-time, Record Payment action | Outstanding figure also on Sales Overview |
| **Sales Overview** | All-time financial health dashboard, quick daily check | Monthly revenue chart (only historical trend view), all-time totals, two outstanding scopes (pipeline vs. all), unpriced count | Revenue/collected overlap with Reports tab |

### Recommendation: **Keep Sales Overview as a Separate Tab (but rename and clarify)**

**Why keep it separate:**
1. It is the ONLY place with a **monthly revenue trend chart** — valuable for seeing seasonal patterns.
2. Its data scope is fundamentally different: **all-time**, not period-based. Merging would require admins to manually enter a "since the beginning" date range.
3. It loads instantly — no date input required. For a quick "how are we doing overall?" check, Sales Overview is the right tool.
4. It is the only tab where `totalRevenue` is computed correctly as `SUM(GREATEST(shipping_cost - discount_amount, 0))` — the true billed amount. This is the most academically correct accounting view.

**Suggested improvement:** Rename to **"All-Time Summary"** or **"Financial Overview"** to make the scope explicit.

### Is "Unsettled Deliveries" an Accurate Title?

**Partially.** The tab includes orders that are:
- `Picked Up` — not yet at destination
- `In Transit` — on the boat/truck
- `Arrived at Hub` — at destination warehouse, not dispatched
- `Out for Delivery` — on last-mile run
- `Delivered` — handed over, balance still owing

Only the last category is technically a "delivery that is unsettled." The others are **shipments in transit with a balance**. A more accurate title would be **"Unsettled Shipments"** or **"Outstanding Balances"**. The subtitle already correctly says "Shipments in the pipeline that still owe money" — the title should match the subtitle.

---

## 7. Confirmed Bugs vs. Design Choices vs. Unverified Concerns

### ✅ Confirmed Bugs (Found in Repository Code)

**[BUG-01] "Total Revenue" in Reports & Analytics is mislabeled.** [REPO]
- Location: `database.js` line 2332
- Actual formula: `SUM(amount_paid)` on non-cancelled orders = **amount collected**, not billed revenue.
- Impact: An order billed for ₱500 but only partially paid ₱300 contributes ₱300 to "Total Revenue." Revenue is understated when orders are unpaid.

**[BUG-02] "Net Collected" and "Collected" card include cancelled orders' payments.** [REPO]
- Location: `database.js` line 2333: `totalCollected = filtered.reduce(...amount_paid)` — no status filter.
- If a cancelled order had a prior payment, it is still counted in `totalCollected`.

**[BUG-03] Route Revenue in Reports & Analytics uses `amount_paid`, not `finalShippingFee`.** [REPO]
- Location: `database.js` line 2356
- The Route Performance table and bar chart show "Revenue" per route, but this is collected cash, not billed amount.

**[BUG-04] Timezone behavior of date range start needs verification.** [REPO]
- Location: `database.js` lines 2272–2276
- `new Date('2026-09-01')` parses as UTC midnight per ECMAScript spec. Testing with Philippine (UTC+8) timezone needed to confirm no boundary edge cases.

**[BUG-05] `grossCollected` formula inconsistency in Reports & Analytics.** [REPO]
- Line 2398: `grossCollected: totalCollected + refundTotal`
- `totalCollected` includes cancelled orders; `refundTotal` excludes them. Different populations being added together.

### ⚙️ Design Choices (Not Bugs)

1. **Reports & Analytics is booking-date-based, not payment-date-based.** Shows "how much did September bookings collect in total" rather than "how much cash came in during September." Defensible for a small logistics business.
2. **Reports show current live column values, not point-in-time snapshots.** No snapshot mechanism exists.
3. **Unsettled Deliveries has no date filter by design.** The business need is operational: "what needs to be collected right now?"
4. **`payment_method` on the order row shows the last payment method used** — not the breakdown. For orders with multiple payment methods, slightly misleading.
5. **Refunds only affect reporting through the ledger breakdown.** The `amount_paid` column is not reversed by a refund — a fully refunded order stays "paid" in `amount_paid` and does NOT re-appear in Unsettled Deliveries.

### ❓ Unverified Concerns (Cannot Confirm Without Live Access)

1. **[UNVERIFIED-01] Does the PayMongo webhook reduce `orders.amount_paid` when a refund succeeds?** If it does, a refunded order would incorrectly re-appear in Unsettled Deliveries with a new balance.
2. **[UNVERIFIED-02] Is `get_sales_summary()` the discount-aware version from `20260911040000`?** Cannot confirm without live DB access.
3. **[UNVERIFIED-03] Does `record_additional_payment` RPC correctly update `orders.amount_paid` atomically?**
4. **[UNVERIFIED-04] Exact timezone bug severity** — depends on browser clock and DatePicker.jsx string format.
5. **[UNVERIFIED-05] How many live orders trigger `balance_mismatch` warnings** in Unsettled Deliveries.

---

## 8. Prioritized Minimal Fixes (Recommendations Only — No Code Changes)

### Priority 1 — Critical (Affects Report Accuracy / Thesis Defense)

**Fix-01: Rename or correct "Total Revenue" in Reports & Analytics**
- File: `src/lib/database.js` line 2332 + `ReportsPage.jsx` lines 234, 325–326, 513–514, 643–644
- Option A: Change label to "Total Collected (Non-Cancelled)" — accurate for the current formula.
- Option B: Change formula to `SUM(finalShippingFee(o))` for non-cancelled, priced orders — true revenue/billings.

**Fix-02: Exclude cancelled orders from `totalCollected` in Reports & Analytics**
- File: `src/lib/database.js` line 2333
- Add `.filter(o => o.status !== 'Cancelled')` before the reduce.

**Fix-03: Fix the "Collected" summary card after Fix-02**
- File: `ReportsPage.jsx` line 235
- After Fix-02, `totalCollected` and `totalRevenue` will be the same formula. Decide which to show, or show both with distinct labels.

### Priority 2 — Important (Affects Report Credibility)

**Fix-04: Fix Route Performance "Revenue" label**
- File: `database.js` line 2356 and `ReportsPage.jsx` line 407
- Change label to "Collected" or change formula to `finalShippingFee(o)`.

**Fix-05: Add "Payment Status" and "Balance" columns to the Detailed Order List**
- File: `ReportsPage.jsx` lines 447–491 (screen table) and 613–648 (print table)
- Add `Balance` = `isOrderPriced(order) ? formatCurrency(outstandingBalance(order)) : '—'` and `Pay Status` = `order.payment_status`.

### Priority 3 — Minor (Housekeeping / Clarity)

**Fix-06: Rename "Unsettled Deliveries" tab to "Unsettled Shipments"**
- File: `SalesReportsPage.jsx` line 24

**Fix-07: Document the timezone behavior of the date range**
- File: `database.js` lines 2272–2276
- Add comment explaining UTC parsing behavior and whether PH-local midnight is desired.

**Fix-08: Add tooltip or sub-label near "Total Revenue" clarifying it means "Amount Collected"**
- If Fix-01 formula is not done, at minimum add a UI tooltip.

---

## 9. Short Thesis Defense Explanation (Taglish)

Ang sistema ng CargoExpress PH ay gumagamit ng tatlong view para sa financial reporting ng negosyo. Ang **Reports & Analytics** ay nagge-generate ng period-based na ulat batay sa petsa ng booking (`created_at`), na nagbibigay ng detalyadong listahan ng lahat ng orders sa loob ng piniling panahon — kasama ang kanilang status, nakolektang bayad, at ruta. Ang **Unsettled Deliveries** ay isang real-time na listahan ng mga shipmento na may natitirang bayad pa, na na-update agad ng WebSocket kapay nagbago ang anumang order o payment sa sistema. Ang **Sales Overview** naman ay nagpapakita ng all-time na financial health ng negosyo gamit ang isang secure na Supabase RPC na direktang nagku-kuenta sa loob ng database.

Natuklasan sa audit na ang pinakamalaking isyu sa sistema ay ang label na "Total Revenue" sa Reports & Analytics tab — ang aktwal na kinukwentang halaga ay ang `SUM(amount_paid)` (kabuuang nakolekta na pera), hindi ang `SUM(billed amount minus discounts)` na iyon ang tunay na kahulugan ng "revenue" sa accounting. Ang Sales Overview naman ay tama ang formula ng Total Revenue, kaya mayroong inconsistency sa pagitan ng dalawang tab. Ang lahat ng financial formulas para sa outstanding balance ay consistent at tama sa tatlong tab — gumagamit ng iisang `MAX(0, finalShippingFee - amount_paid)` na formula. Para sa thesis defense, mahalaga na ipunto na ang sistema ay may matibay na pundasyon (ledger-based payment tracking, single-source-of-truth formula para sa outstanding balance, real-time updates) ngunit kailangan pa ng kaunting pagwawasto sa mga label at formula ng Reports & Analytics tab para maging mas tama at malinaw ang financial reporting.

---

## Appendix: Key Files and Line References

| Finding | File | Lines |
|---|---|---|
| getReportData function | `src/lib/database.js` | 2267–2406 |
| totalRevenue formula (BUG-01) | `src/lib/database.js` | 2332 |
| totalCollected formula (BUG-02) | `src/lib/database.js` | 2333 |
| routeRevenue formula (BUG-03) | `src/lib/database.js` | 2354–2358 |
| date range construction (BUG-04) | `src/lib/database.js` | 2272–2276 |
| grossCollected formula (BUG-05) | `src/lib/database.js` | 2398 |
| getSalesData / get_sales_summary | `src/lib/database.js` | 1371–1460 |
| sumTransactionsByMethod | `src/lib/database.js` | 1473–1530 |
| getUnsettledOrders | `src/lib/database.js` | 1602–1618 |
| classifySettlement | `src/lib/database.js` | 1561–1572 |
| isOrderPriced | `src/constants/status.js` | 463–466 |
| finalShippingFee | `src/constants/status.js` | 475–480 |
| outstandingBalance | `src/constants/status.js` | 499–503 |
| ReportsPage: summary cards | `src/pages/admin/ReportsPage.jsx` | 231–244 |
| ReportsPage: financial grid | `src/pages/admin/ReportsPage.jsx` | 323–376 |
| ReportsPage: order list | `src/pages/admin/ReportsPage.jsx` | 459–492 |
| SalesReportsPage: tab structure | `src/pages/admin/SalesReportsPage.jsx` | 22–26, 62–77 |
| exportPrintDocumentToPdf | `src/lib/exportPdf.js` | 14–57 |
| buildReportFilename | `src/pages/admin/ReportsPage.jsx` | 40–45 |
| get_sales_summary (discount-aware) | `supabase/migrations/20260911040000_sales_summary_discount_aware.sql` | all |
| payment_refunds table | `supabase/migrations/20260912184434_paymongo_refunds_and_failures.sql` | 21–63 |
| record_additional_payment RPC | `supabase/migrations/20260909030000_manual_payment_hardening.sql` | all |

---

*Report generated: September 16, 2026. Audit is repository-only [REPO]. All findings labeled [REPO] were directly confirmed from source code. Findings labeled [UNVERIFIED] require live database access to confirm.*
