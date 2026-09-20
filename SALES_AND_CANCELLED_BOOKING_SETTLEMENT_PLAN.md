# Sales and Cancelled-Booking Settlement Audit and Implementation Plan

Audit date: 2026-09-20 (Asia/Manila)  
Scope: read-only review of the current repository. No application fix, migration, production write, real payment/refund, cancellation, email, deployment, or settings change was performed.

## Executive conclusion

The fixture reconciles to **₱50,000 gross collections, ₱20,000 successful refunds, ₱30,000 net collections, and ₱45,000 active shipment receivables**. The current database formulas produce those totals when evaluated at the requested fixed instant, September 20, 2026 at 1:19 PM Asia/Manila.

The work should be split into two tracks:

- **A — Existing bugs and display corrections:** restore Sales Overview freshness; label its daily figure as net; explain that report method buckets use the **original payment method**; and stop showing cancelled bookings as simultaneously Partial, Settled, owing the old charge balance, and still carrying a payment promise.
- **B — New agreed-fee settlement capability:** add an explicit, audited cancellation-settlement decision. Existing unrefunded money must remain For Review until a decision is recorded; it must never be inferred to be a cancellation fee.

The current SQL does **not** reproduce the historical Collected Today ₱0. The current Sales page fetches once on mount, has no refresh control, and no longer subscribes to order changes even though it says “Real-time.” Git history confirms that the page rewrite removed its earlier Realtime refresh. A page opened before the 1:12 PM payment can therefore still show ₱0 at 1:19 PM. This is a confirmed freshness defect and the best-supported cause. The precise historical deployed function and browser session cannot be reconstructed from repository evidence alone, so the individual screenshot incident remains operationally unverified rather than being mislabeled as a proven timezone failure.

Live deployed definitions and records were not available through an authorized read-only connection during this audit. The conclusions below refer to the effective definitions in this repository; live state is unverified.

## 1. Current computation and flow

### 1.1 Authoritative financial flow

1. A successful collection is recorded in payment_transactions.
2. A refund is recorded separately in payment_refunds and linked to one original payment transaction.
3. update_order_payment_totals() locks the parent order, sums successful payments, subtracts only refunds whose stored status is succeeded, and writes the derived order cache:
   - amount_paid = gross successful collections − successful refunds
   - remaining_balance = max(0, final shipping fee − amount_paid)
   - payment_status = derive_payment_status(final shipping fee, amount_paid)
4. Creating, pending, processing, outcome-uncertain, and failed refunds remain visible but do not reduce amount_paid. Active refund rows reserve capacity so another refund cannot consume the same original payment amount.
5. Sales Overview and Reports aggregate ledger events directly. Unpaid Shipments reads active orders and derives current receivables from the order financial fields.

The ledger behavior is appropriate and should be preserved. The cancellation problem is primarily that the active-shipment balance model is being reused to answer a different question: what the business still owes the customer after cancellation.

### 1.2 Displayed-field mapping

| Displayed field | Current source/function | Formula | Included statuses/population | Date basis |
|---|---|---|---|---|
| Sales: Collected Today | SalesPage → getSalesOverviewData() → get_sales_overview_data() | Successful non-Pay-Later payments minus successful refunds | Payments marked paid/partial; refunds marked succeeded; not limited by order status | Manila midnight inclusive to next Manila midnight exclusive; payment created_at; refund succeeded_at with provider/update fallback |
| Sales: Net Collected This Month | Same RPC | Month payments minus month successful refunds | Same as above | Manila month start inclusive to next month exclusive |
| Sales: monthly chart | Same RPC | Monthly gross minus monthly successful refunds | Same as above | Event timestamps converted to Asia/Manila; database year defaults to current Manila year |
| Sales: Current Unpaid Balance | Same RPC | Sum of max(final fee − amount_paid, 0) | Picked Up, In Transit, Arrived at Hub, Out for Delivery, Delivered | Current snapshot |
| Sales: Delivered but Unpaid | Same RPC | Same balance formula | Delivered only | Current snapshot |
| Reports: gross collected | ReportsPage → getFinancialReportData() → get_financial_report_data() | Sum successful payment events; Pay Later excluded from headline/method totals | Payments marked paid/partial | Selected Manila start inclusive/end exclusive; payment created_at |
| Reports: successful refunds | Same RPC | Sum successful refund events | Refunds marked succeeded | Selected interval; succeeded_at with legacy fallback |
| Reports: net collected | Same RPC | Gross collected − successful refunds | Same events as above | Same half-open interval |
| Reports: per-method refund | Same RPC refunds CTE | Refund assigned to original payment_transaction.payment_method | Successful refunds linked to original payments | Refund success event date |
| Reports: daily chart | Same RPC | Daily payment gross − daily successful refunds | Successful payment/refund events | Event converted to Manila calendar date |
| Unpaid shipment row | getUnsettledOrders(), deriveSettlement(), outstandingBalance() | max(final fee − amount_paid, 0) | Explicit active shipment statuses; Cancelled excluded | Current snapshot; promise aging currently uses browser-local midnight |
| Cancelled Paid/raw payment badge | orders.amount_paid and orders.payment_status | Net retained after successful refunds; status compared with historical final charge | Includes cancelled orders | Current ledger snapshot |
| Cancelled Settled badge | getSettlementState() | Immediately returns settled when order is Cancelled | All cancelled orders | No date basis; means non-collectible in shipment flow, not refund completion |
| Cancelled original/final charge | Order pricing fields and finalShippingFee() | max(shipping_cost − discount_amount, 0) | Selected booking | Preserved historical terms |
| Cancelled gross/refund/net summary | Payment activity and CancellationPaymentSummary | Gross successful payments; succeeded refunds; net = gross − succeeded refunds | Selected order | Full order history |
| Cancelled promise date | orders.promised_payment_date | Rendered whenever non-null | Currently includes cancelled orders | Date-only UI value |

### 1.3 Sales Overview freshness and date handling

src/pages/admin/SalesPage.jsx calls loadData() only in a mount-time effect. It does not use useRealtimeOrders, poll, or offer a normal refresh button; Retry is shown only after an error. This conflicts with its “Real-time collections and outstanding balances” subtitle.

The existing useRealtimeOrders mechanism is suitable for a minimal repair. The ledger tables are not in the Realtime publication, but every successful payment or refund recalculates the parent orders row, so an order subscription catches the event. Unpaid Shipments already uses this design.

The effective overview RPC establishes Manila boundaries in the database:

~~~text
today_start = Manila calendar date at 00:00 Asia/Manila
today_end   = today_start + 1 day
include event when today_start <= timestamp < today_end
~~~

It includes successful partial-payment rows. Its daily number is net, not gross. The React chart uses a hard-coded JavaScript year, 2026, only to obtain localized month names; this does not change RPC values, but it is needless technical debt.

For Reports, the browser sends a Manila-offset start and a next-day exclusive end. This is correct for a Manila browser and the current tests pass. Using Date.setDate() in the browser is still avoidable timezone/DST coupling; a shared Manila date-boundary helper would make the contract explicit for administrators outside the Philippines.

### 1.4 Payment method versus refund return method

The report groups refunds by **the original payment method**. Its refund query joins payment_refunds to payment_transactions and selects the original transaction's payment_method. It does not group by payment_refunds.return_method.

The actual return route is retained for manual refunds:

- refund_channel: paymongo or manual
- return_method: cash or gcash for a manual return
- return_reference and returned_at: supporting evidence/time
- A PayMongo refund has no manual return_method; its return route is the original provider source.

get_payment_refund_history() exposes channel and return method to the customer while keeping internal identifiers/references restricted. mergePaymentActivity() displays a manual refund using its actual return method and a provider refund as GCash. Detailed order history can therefore answer “how was this money returned?” even though the aggregate report answers “which original collection was reversed?”

For the fixture, the report's existing semantics are:

| Original payment method | Gross received | Refunds linked to those payments | Net retained |
|---|---:|---:|---:|
| Cash | ₱40,000 | ₱20,000 | ₱20,000 |
| GCash | ₱10,000 | ₱0 | ₱10,000 |
| **Total** | **₱50,000** | **₱20,000** | **₱30,000** |

An actual money-movement view would instead be:

| Movement channel | Received | Returned | Net movement |
|---|---:|---:|---:|
| Cash | ₱40,000 | ₱10,000 | ₱30,000 |
| GCash | ₱10,000 | ₱10,000 | ₱0 |
| **Total** | **₱50,000** | **₱20,000** | **₱30,000** |

Both are mathematically correct and answer different questions. The existing aggregate must not silently switch semantics.

### 1.5 Cancellation and refund flow

Cancellation currently stores operational review information in orders.cancellation_details: reason, request/previous status, reviewer, review time, and review notes. The admin review RPC checks admin authority, locks the order, and changes shipment status. It does not decide the financial outcome.

Refunding is intentionally separate. Existing protections include original-payment linkage, per-payment refundable limits, idempotency, parent-order locking, active reservations, provider reconciliation, manual-return evidence, and success-only effects on financial totals.

The contradiction for Booking B is produced as follows:

- The historical final charge remains ₱34,000, correctly preserving the original commercial terms.
- Successful payments total ₱30,000 and successful refunds total ₱20,000, so orders.amount_paid becomes ₱10,000. Here amount_paid is net retained, not lifetime gross paid.
- Comparing ₱10,000 with the ₱34,000 historical charge derives Partial and a raw ₱24,000 shipment balance.
- getSettlementState() special-cases every cancelled booking as Settled, regardless of refund records.
- The promise date is rendered merely because it is non-null.

Thus current Settled means “excluded from shipment collections,” not “refund obligation complete.” It cannot represent cancellation financial settlement.

### 1.6 Current refund eligibility and reservations

Refund eligibility is calculated per original payment. Provider refund actions are offered only for successful GCash transactions whose channel is PayMongo. Cash and manually recorded GCash collections use the manual-return recording path; that path explicitly rejects a verified PayMongo payment so provider evidence is not bypassed.

Both the UI read model and server-side refund routines subtract refund rows in creating, pending, processing, or succeeded states from the original payment's refundable capacity. Failed rows release capacity. An outcome-uncertain provider result is displayed as uncertain while its underlying active row continues to reserve money. The manual path locks the original payment row before calculating the reservation, and idempotency keys plus uniqueness checks prevent retries from creating duplicate money movement. These protections must remain intact.

## 2. Confirmed defects versus confusing labels

### A. Existing bugs and display corrections

| Finding | Classification | Evidence/consequence | Minimal correction |
|---|---|---|---|
| Sales Overview stays stale after a later payment/refund | **Confirmed defect** | Current page loads once; earlier Realtime refresh was removed; subtitle still says real-time | Restore debounced order-change refresh; add Refresh and Updated at |
| Collected Today subtracts refunds | **Confirmed misleading label** | RPC returns payments minus refunds | Rename to **Net Collected Today**; never call it profit |
| Historical ₱0 blamed on timezone | **Not supported by current code** | Fixed fixture returns ₱20,000 using Manila bounds | Treat stale snapshot as reproducible cause; verify historical deployment only if evidence becomes available |
| Method report is ambiguous | **Confirmed confusing label** | Refund uses original payment method, not manual return_method | Rename headings and add note on screen and print |
| Cancelled order shows Partial and Settled | **Confirmed semantic/UI defect** | Two labels answer different questions but appear as one state | Suppress active-collection badges and use a cancellation-settlement status |
| Cancelled order can show ₱24,000 as active debt | **Confirmed semantic/UI defect where rendered** | Valid historical-charge arithmetic is not a post-cancellation receivable | Preserve charge but do not label the difference as customer debt without explicit policy |
| Cancelled order shows promise date | **Confirmed display defect** | Both detail views render any non-null promise | Hide or label historical; exclude from active collections |
| Customer view hides balance but still shows Partial/promise | **Confirmed consistency defect** | Adjacent fields contradict the Cancelled balance label | Use the same settlement facts and terminology as admin |
| Hard-coded 2026 chart-label year | **Low-risk defect** | Does not affect SQL values but is brittle | Use stable month labels/current year |
| Promise aging uses browser-local midnight | **Robustness risk, not observed cause** | Client timezone can alter classification | Compare Manila date keys |

### B. New agreed-fee settlement capability

| Missing capability | Current result | Required behavior |
|---|---|---|
| Explicit financial decision | Unrefunded money has no recorded meaning | Default to For Review; admin records full refund or agreed fee |
| Agreed retained amount | No suitable field | Store separately from discount, payment, and refund |
| Decision identity/time | Cancellation reviewer is not necessarily decision maker | Store deciding admin and server timestamp |
| Customer agreement evidence | Not represented | Require confirmation for retained-fee decisions |
| Safe decision/refund coordination | Existing safety is per original payment | Atomically validate fee against successful and reserved refunds |
| Canonical read model | UIs can derive different states | Return gross, succeeded, pending, fee, due, and state once |

## 3. Proposed before/after displays

### 3.1 Sales Overview

Before:

~~~text
Collected Today                 ₱0.00
Real-time collections ...      (but no live refresh)
~~~

After:

~~~text
Net Collected Today            ₱20,000.00
Successful collections minus successful refunds today (Asia/Manila)
Updated 1:19 PM                [Refresh]
~~~

If owners want gross too, add a separate Gross Collected Today value. Do not relabel the current net formula as gross.

### 3.2 Reports & Analytics

Before:

~~~text
Method | Gross | Refunds | Net
~~~

After:

~~~text
Original Payment Method | Gross Received | Refunds of These Payments | Net Retained

Refunds are grouped by the method of the original payment being reversed.
The actual return channel may differ and appears in payment/refund history.
~~~

Use identical wording in print/PDF. Add a separate Actual Return Channel table only if Finance/Operations confirms that it is needed for cash-control reconciliation; do not replace the original-payment table.

### 3.3 Cancelled booking

The main card should stop using the active-shipment balance model. Keep original fee, discount, final charge, and full transaction history accessible.

**Scenario A — no decision recorded**

~~~text
Booking status                 Cancelled
Historical final charge        ₱34,000
Gross collected                ₱30,000
Successfully refunded          ₱20,000
Net retained                   ₱10,000
Cancellation settlement        For Review
~~~

**Scenario B — full refund agreed, not completed**

~~~text
Booking status                 Cancelled
Gross collected                ₱30,000
Successfully refunded          ₱20,000
Agreed retained fee            ₱0
Refund still due               ₱10,000
Refund in progress             ₱0 (or active reservation)
Cancellation settlement        Refund Pending
~~~

**Scenario C — ₱10,000 retained fee agreed**

~~~text
Booking status                 Cancelled
Gross collected                ₱30,000
Successfully refunded          ₱20,000
Agreed cancellation fee        ₱10,000
Refund still due               ₱0
Cancellation settlement        Refund Settled
~~~

The customer-facing card should say “Agreed cancellation fee” plainly. It should not expose internal notes or sensitive references. Payment/refund history should continue to show each collection and return, including whether the actual return was Cash, manual GCash, or provider GCash.

## 4. Whether existing fields are sufficient

They are **not sufficient** for an agreed retained fee.

| Requirement | Existing support | Assessment |
|---|---|---|
| Shipment cancellation reason/review | orders.cancellation_details | Sufficient only for operational cancellation |
| Gross successful collections | payment_transactions | Sufficient |
| Successful/pending/failed refunds | payment_refunds | Sufficient and lifecycle-aware |
| Original versus return method | Original payment link plus refund_channel/return_method | Sufficient |
| Agreed retained fee | None | Missing |
| Settlement decision/status | None | Missing; payment_status and shipment status are not substitutes |
| Decision maker/time | Cancellation review fields describe another action | Missing for financial settlement |
| Customer agreement | None | Missing |
| Optional internal settlement note | Cancellation review note has another meaning | Missing |

Adding JSON keys to cancellation_details is not recommended for money: it gives weak typing/constraints, awkward concurrency validation, and poor reporting. The minimum robust design is a dedicated one-row-per-order cancellation_settlements table:

| Field | Minimum rule |
|---|---|
| order_id | Primary/foreign key; order must be Cancelled before confirmation |
| decision_status | for_review or confirmed; absent legacy row reads as for_review |
| decision_type | Null while reviewing; full_refund or retained_fee when confirmed |
| agreed_retained_amount | Null while reviewing; required and non-negative when confirmed; zero for full refund |
| customer_agreement_confirmed | Required true for a retained-fee decision |
| customer_agreement_confirmed_at | Server timestamp |
| decided_by / decided_at | Authenticated admin and server timestamp |
| internal_notes | Optional, length-limited, admin-only |
| created_at / updated_at | Server timestamps |

Use an admin-only RPC for confirm/change, not direct browser writes. It should lock the order and settlement row, calculate ledger totals in the same transaction, validate invariants, write an activity log with old/new values, and return the canonical read model.

Allocating existing retained money to a fee is classification of money already collected. It creates **no** payment transaction, refund row, discount, revenue event, or additional cash.

## 5. Minimal frontend/backend changes required

### A. Existing bugs and display corrections

| Change | Why needed | Affected files/functions |
|---|---|---|
| Restore Sales Overview refresh | Prevent a later valid payment/refund from leaving the headline stale | src/pages/admin/SalesPage.jsx; reuse src/hooks/useRealtimeOrders.js; getSalesOverviewData() unchanged |
| Add manual Refresh and last-updated time | Make freshness observable and provide fallback if Realtime disconnects | src/pages/admin/SalesPage.jsx |
| Rename daily card to Net Collected Today and explain PHT | Match the RPC formula | src/pages/admin/SalesPage.jsx |
| Remove hard-coded chart year | Remove misleading year coupling | src/pages/admin/SalesPage.jsx |
| Relabel method report on screen and print/PDF | Explain original-payment grouping without changing totals | src/pages/admin/ReportsPage.jsx |
| Suppress active collection labels for cancelled bookings | Eliminate Partial + Settled + balance + promise contradiction | src/pages/admin/OrderDetailPage.jsx; src/pages/customer/OrderDetailPage.jsx |
| Stop treating Cancelled as financially settled | Separate shipment collectibility from refund completion | src/constants/status.js; regression-check PaymentReturnPage and supportChatEngine |
| Standardize Manila date-only comparisons | Avoid browser-zone-dependent promise aging | src/lib/database.js classifySettlement()/deriveSettlement(); reuse src/utils/datetime |

The Sales and financial-report RPC formulas do not need changes for this fixture. The report grouping must not be rewritten merely to make the Cash row look intuitive.

### B. New agreed-fee settlement capability

| Change | Why needed | Expected affected areas |
|---|---|---|
| Add constrained settlement schema and RLS | Store the decision as a first-class financial fact | New migration for cancellation_settlements, checks, indexes, RLS |
| Add atomic decision RPC | Enforce locks, permissions, invariant checks, agreement, and audit | Same migration; record_cancellation_settlement_decision() or equivalent |
| Add canonical settlement read model | Prevent frontend-specific arithmetic/status drift | New SQL function/view or an extension to an authorized detail RPC |
| Add database client wrappers | Keep UI access centralized | src/lib/database.js |
| Extend admin cancellation summary/control | Show facts and allow an authorized decision | src/pages/admin/OrderDetailPage.jsx |
| Extend customer cancellation summary | Explain fee/due/pending without internal notes | src/pages/customer/OrderDetailPage.jsx |
| Keep detailed return-channel display | Preserve how money actually returned | Existing payment display helpers/components, only if shared labels are needed |
| Add a focused test harness | Protect arithmetic, locks, auth, and legacy handling | New PGlite/UI tests and package script |

### 5.1 Canonical settlement arithmetic and states

Define:

~~~text
G = successful collections
S = successful refunds
P = active refund reservations
    (creating/pending/processing, including outcome-uncertain rows)
F = confirmed agreed retained fee

N = G - S             # net retained now
R = G - S - F         # refund obligation remaining after successful refunds
A = G - S - P - F     # amount still available to initiate now
~~~

Do not wrap R or A in MAX(0, ...). A negative result reveals inconsistent data and must fail closed.

The existing order cache and active-shipment balance helpers do use GREATEST/MAX to keep a receivable non-negative. That is acceptable for ordinary display only because refund entry is separately guarded, but it is not sufficient validation for the new cancellation decision. The canonical settlement function must inspect the raw G, S, P, and F values first, report an invariant failure, and only then derive a display state.

Minimum invariants:

- Amounts use two-decimal numeric values and are non-negative.
- A confirmed decision requires 0 <= F <= G.
- S <= G must hold.
- Existing reservation rules require S + P <= G.
- A confirmed decision requires S + P + F <= G.
- full_refund requires F = 0.
- retained_fee requires F > 0 and the required customer-agreement evidence.
- No decision or for_review means F is unknown, not zero. Do not derive a settled state.
- A zero-payment cancellation may resolve with full_refund and R=0; it creates neither refund nor fee.
- Failed refunds contribute to neither S nor P, but remain visible.
- An outcome-uncertain refund stays in P until reconciled; it enters S only if its stored refund status becomes succeeded.

Canonical display states:

| Condition | Display state |
|---|---|
| No confirmed decision | For Review |
| Confirmed and R > 0, P = 0 | Refund Due |
| Confirmed and R > 0, P > 0 | Refund Pending; show successful and in-progress amounts |
| Confirmed and R = 0, P = 0 | Refund Settled |
| Any negative/violated invariant | Needs Reconciliation; block decision/refund changes |

If P=R, all remaining obligation is reserved but not yet successful, so the state remains Refund Pending. If P<R, show both the amount in progress and the amount not yet initiated.

## 6. Existing-data handling

### A. Display corrections

- Do not rewrite an existing order, payment, refund, discount, or cancellation JSON merely to fix labels.
- Keep cancelled bookings excluded from Unpaid Shipments and Current Unpaid Balance. That separation is correct.
- Preserve original fee, discount, final charge, and all transaction history.
- Treat a cancelled order's raw remaining_balance as legacy shipment arithmetic, not a customer receivable.
- Keep orders.amount_paid as its current derived net-retained cache for compatibility, but label it accurately on cancelled bookings. Gross must continue to come from ledger rows.
- Preserve stored promise dates for history, but exclude them from active collection UX and overdue classification after cancellation.

### B. Settlement capability

- Do not backfill a fee from gross minus refunds, payment status, remaining balance, notes, or elapsed time.
- Existing cancelled bookings without settlement data must read as For Review (legacy — decision not recorded).
- A migration could create for_review rows if operations needs a work queue, but agreed_retained_amount must remain null. A left-join/no-row fallback is smaller and avoids a mass data write.
- Reconcile any pre-existing invariant failure before accepting a confirmed decision. Do not clamp it away.
- Decision changes must use the same locking RPC. Reject a new F when S + P + F > G.
- Simplest safe policy: reject decision amendments while a refund is creating, pending, processing, or outcome-uncertain. If owners allow changes, the transaction must still preserve every invariant.
- Never mutate successful payment/refund history to make it fit a decision.

## 7. Regression risks and acceptance tests

### 7.1 Executed verification

All verification was local/isolated and caused no production calls or writes.

| Verification | Result |
|---|---|
| Fixed-time two-booking fixture against effective get_sales_overview_data() at 2026-09-20 13:19:00+08 | Passed: Sep 20 net ₱20,000; September gross ₱50,000, refunds ₱20,000, net ₱30,000; active unpaid ₱45,000 |
| Per-day fixture reconciliation | Passed: Sep 18 ₱30,000 − ₱20,000 = ₱10,000; Sep 20 ₱20,000 − ₱0 = ₱20,000 |
| npm run test:financial-reports | Passed |
| npm run test:refund-period-bucketing | Passed, 10/10 |
| npm run test:payment-refunds | Passed, 14/14 |
| npm run test:manual-refund | Passed: database 46/46, Edge Function contracts 21/21, GCash reference validation passed |

The fixture linked both refunds to an original Cash payment while representing one actual Cash return and one actual GCash return. This reproduces why the report's Cash refund bucket can be ₱20,000 without losing actual return-channel detail.

### 7.2 Required acceptance tests for Track A

1. Load Sales Overview before a successful payment, record the payment elsewhere, and verify a debounced refresh changes Net Collected Today without navigation.
2. Simulate Realtime failure and verify manual Refresh works, last good figures remain visible, and Updated at is honest.
3. Test 2026-09-19 23:59:59.999+08 and 2026-09-20 00:00:00+08, then the next exclusive midnight; events must fall on the correct Manila day.
4. Confirm paid and partial successful transaction rows are included and Pay Later is excluded.
5. Confirm only succeeded refunds reduce daily/monthly/period totals; pending, processing, uncertain, and failed rows have no cash effect.
6. Confirm screen and print/PDF say Original Payment Method, Gross Received, Refunds of These Payments, and Net Retained, with the note.
7. For Booking B, confirm neither detail view shows an active ₱24,000 debt, Partial beside Settled, or an actionable promise.
8. Confirm Booking A remains in Unpaid Shipments at ₱45,000 and cancelled Booking B never enters the active receivable total.
9. Confirm PaymentReturnPage and support chat do not mistake cancellation for a successful payment after settlement-helper changes.
10. Confirm the report's event totals remain separate from its explicitly labelled current delivery snapshot.

### 7.3 Required acceptance tests for Track B

1. **Awaiting decision:** G=₱30,000, S=₱20,000, no confirmed F → For Review; no fee or settled label.
2. **Full refund agreed:** F=₱0 → R=₱10,000; Refund Due/Refund Pending until success.
3. **Agreed retained fee:** F=₱10,000 with customer confirmation and S=₱20,000 → R=₱0, Refund Settled; no new collection row.
4. **Pending refund:** G=₱30,000, S=₱20,000, P=₱10,000, F=₱0 → R=₱10,000, A=₱0, Refund Pending; duplicate request rejected.
5. **Failed refund:** moving the active row to failed returns P to zero, leaves S unchanged, restores Refund Due, and preserves failure history.
6. **Uncertain provider result:** reserve the amount, show awaiting confirmation, block a duplicate refund/incompatible fee, then reconcile idempotently.
7. **Concurrent admins:** two decisions, or a decision racing a refund, serialize on the same order/settlement locks; only a valid final state commits.
8. **Mixed payments:** refund allocation respects every original payment's remaining refundable amount even though F is order-level.
9. **Provider/manual returns:** both affect S only on success; Cash/GCash evidence and PayMongo identity protections remain intact.
10. **Zero-payment cancellation:** G=S=P=0; no refund row and no inferred fee.
11. **Legacy cancellation:** no metadata → For Review (legacy), never fee retained or Refund Settled.
12. **Invalid arithmetic:** reject F<0, F>G, S>G, and S+P+F>G; show Needs Reconciliation instead of clamping.
13. **Authorization/privacy:** customers read their summary and return method but cannot write decisions or see internal notes/provider IDs.
14. **Reporting:** confirming/changing F does not alter gross, refunds, or net cash. Any future fee analytics is a separate allocation, not a receipt.

### 7.4 Main regression risks

- Changing the shared settlement helper affects PayMongo return-page completion and support-chat answers; explicitly test both.
- Listening to all order changes can over-fetch aggregate RPCs; reuse debounce and prevent overlapping refreshes.
- An order-level fee can conflict with per-payment refundable capacity if checked only in JavaScript; enforce it transactionally in SQL.
- Reclassifying report buckets would break historical comparison; Track A changes labels, not grouping.
- Exposing return_reference to customers would weaken existing privacy; keep it admin-only.
- Treating pending/uncertain refunds as successful understates retained money; keep S and P separate.
- Adding a fee to Sales totals double-counts money already received.

## 8. Business decisions requiring confirmation

1. **What proves customer agreement?** Recorded verbal consent with admin/date, a chat confirmation ID, signed/uploaded evidence, or a customer confirmation action? A bare boolean may be insufficient in a dispute.
2. **Who may approve a retained fee?** Any admin, Finance only, or two-person approval above a threshold?
3. **Can a confirmed decision change?** Recommendation: no ordinary edit while a refund is active; require an explicit audited amendment afterward.
4. **May the fee exceed the historical final charge while remaining within G?** Recommended default: cap at min(G, historical final charge) unless owners document another lawful policy.
5. **Does full refund require customer confirmation?** Recommendation: no agreement flag for F=0, but admin identity/time remain required.
6. **Which customer wording is approved?** “Agreed cancellation fee” versus “Agreed inconvenience fee,” plus the dispute/contact route.
7. **Is actual return-channel aggregation operationally needed?** Add it only for a real Cash/GCash reconciliation workflow.
8. **Should a cancelled promise date be erased or hidden?** Recommendation: preserve for audit, hide from active collection/overdue behavior.
9. **What does Finance call net collections?** It is collections less successful refunds, not profit and not necessarily recognized revenue.

## 9. Ordered implementation plan

### Phase A — Existing bugs and display corrections

1. **Lock terminology with owners.** Confirm Net Collected Today, original-payment table labels, and cancellation-summary wording.
2. **Add regression tests first.** Encode the fixed September fixture, Manila midnight boundaries, screen/print headings, and cancelled-display suppression.
3. **Repair Sales freshness.** Restore debounced useRealtimeOrders refresh in SalesPage, add manual Refresh/Updated at, and keep the last good payload during background refresh. Do not change SQL totals.
4. **Correct Sales presentation.** Rename the daily card, explain net/PHT semantics, and remove the hard-coded year.
5. **Clarify report semantics.** Update interactive and print/PDF tables; preserve the RPC's grouping.
6. **Separate cancellation from active receivables.** Introduce a cancelled/non-collectible state or bypass the active settlement helper on cancelled views; remove raw Partial, active balance, and promise indicators. Regression-test PaymentReturnPage and support chat.
7. **Normalize promise-date comparisons to Manila.** Use existing date utilities for Unpaid Shipments while preserving stored history.
8. **Run financial/refund suites and manual UI checks.** Compare Sales, Reports, Unpaid, admin detail, customer detail, and print/PDF against one fixture.

### Phase B — New agreed-fee settlement capability

1. **Resolve Section 8 policy questions.** Agreement evidence, approver authority, amendment rules, and customer language determine the final constraints.
2. **Add the dedicated settlement schema/read model.** Legacy/no-row must read For Review; no inferred fee backfill.
3. **Implement one atomic decision RPC.** Lock rows, recompute G/S/P, validate invariants, capture authenticated admin/server time, enforce agreement, and audit old/new values.
4. **Integrate rather than replace refund protections.** Keep provider/manual refund flows and per-payment capacity; add F to the order-level availability check so S+P+F cannot exceed G.
5. **Build the admin workflow.** Show the canonical summary; allow authorized full-refund or retained-fee decisions; block incompatible changes during active refunds.
6. **Build the customer summary.** Show gross, successful refunds, pending amount, agreed fee, refund due, and status without internal notes.
7. **Keep cash reporting ledger-based.** Gross/refund/net remain ledger movements. A fee is a separate allocation of already-retained money.
8. **Run concurrency, legacy, authorization, privacy, and arithmetic tests.** Require all existing suites and Section 7 cases.
9. **Deploy in two reversible releases.** Schema/read path first with legacy rows For Review; write workflow and customer display second. Monitor invariant and refresh errors without rewriting ledgers.

## Source evidence index

- src/pages/admin/SalesPage.jsx: mount-only load, misleading real-time subtitle, Collected Today label, hard-coded chart year.
- src/pages/admin/ReportsPage.jsx: ambiguous interactive and print/PDF method table headings.
- src/lib/database.js: Manila report bounds, Sales RPC wrapper, active-status Unpaid query, settlement aging, merged payment/refund activity.
- src/hooks/useRealtimeOrders.js: existing order-based Realtime invalidation design.
- src/constants/status.js: final charge/outstanding formulas and Cancelled → Settled shortcut.
- src/pages/admin/OrderDetailPage.jsx: raw payment status, settlement badge, promise, and cancellation payment/refund summary.
- src/pages/customer/OrderDetailPage.jsx: cancelled refund banner, hidden numeric balance, raw payment status, and unconditional promise.
- supabase/migrations/20260913170000_serialize_order_payment_totals.sql: locked ledger-to-order recalculation.
- supabase/migrations/20260918010000_refund_period_bucketing_fix.sql: effective financial-report event and original-method grouping.
- supabase/migrations/20260918020000_manual_refund_recording.sql and 20260919000000_manual_refund_reference_validation.sql: actual return method, evidence, privacy, and manual-refund protections.
- supabase/migrations/20260919030000_fix_sales_overview_refund_period.sql: effective Sales Overview formulas and Manila boundaries.
- supabase/migrations/20260831070000_secure_cancellation_and_chat_updates.sql: effective cancellation review locking and metadata.

## Simple Taglish explanation using the two bookings

Si **Booking A** ay active na Picked Up: final charge niya ay ₱65,000, may successful payment na ₱20,000, kaya tama ang **₱45,000 na active unpaid balance**. Dapat kasama siya sa Unpaid Shipments.

Si **Booking B** ay cancelled. Nakolekta ang ₱30,000 at na-refund na ang ₱20,000, kaya **₱10,000 ang kasalukuyang net na hawak ng business**. Hindi ibig sabihin nito na automatic na cancellation fee na ang ₱10,000, at hindi rin ibig sabihin na may utang pa ang customer na ₱24,000. Hangga't walang recorded agreement, ang tamang status ay **For Review**. Kapag full refund ang napagkasunduan, may **₱10,000 Refund Due**. Kapag malinaw at recorded na agreed cancellation fee ang ₱10,000, saka lang magiging **Refund Settled**.

Sa combined report, tama ang ₱50,000 gross minus ₱20,000 refunds equals ₱30,000 net. Lumabas ang buong ₱20,000 refund sa Cash row dahil naka-group ang report ayon sa **original payment method**, kahit ang actual na balik ng isang ₱10,000 ay GCash. Kaya label at explanation ang kailangang ayusin; hindi kailangang palitan nang tahimik ang computation.
