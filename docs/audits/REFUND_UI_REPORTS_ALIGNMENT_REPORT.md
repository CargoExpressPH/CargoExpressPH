# Refund/Cancellation UI ↔ Backend Alignment Report

**Status:** Focused implementation pass, not a fresh audit. Built on
`REFUND_CANCELLATION_WORKFLOW_STUDY.md`, but every claim in that study was re-verified
against the current codebase and current migrations before anything was changed — several of
the study's own conclusions turned out to be wrong or incomplete, and are corrected below.
No real refunds, payments, or notifications were triggered. Nothing was deployed or committed.

---

## 1. Confirmed mismatches and their causes

Two independent read-only verification passes were run against current code before any edit,
specifically to check the study's assumptions rather than trust them. Findings:

| # | Claim checked | Verdict | Cause |
|---|---|---|---|
| 1 | Refund period-bucketing may drift between reporting periods | **CONFIRMED — real bug, fixed** | `get_financial_report_data()` bucketed a refund by `payment_refunds.updated_at`. That column is bumped by an unconditional `BEFORE UPDATE` trigger on *any* `UPDATE` statement, including a no-op touch — e.g. `mark_paymongo_refund_uncertain()` re-running against an already-`succeeded` row during a delayed/duplicate webhook retry leaves the refund's outcome unchanged but still re-dates it into whatever period the retry happened to land in. |
| 2 | Customer Order Detail "Balance" card can mislead on a cancelled order | **CONFIRMED — real bug, fixed** | `outstandingBalance(order)` (in `src/constants/status.js`) is not Cancelled-aware by design — only the higher-level `getSettlementState()` special-cases `Cancelled → SETTLED`. The admin Order Detail page already gates its balance display on `settlementState` before calling `outstandingBalance()`; the customer page's Balance card did not, so a cancelled order with only a *partial* refund (raw `remaining_balance` still positive — `update_order_payment_totals()` has no `status`-aware branch) rendered a nonzero peso figure in success-green under "Balance". |
| 3 | Admin refund button shows a "working-looking" action for Cash/manual-GCash payments | **NOT CONFIRMED — pre-existing code was already correct** | My own draft summary (before reading the actual JSX) assumed the button's visibility used only `refundable_amount > 0` from `mergePaymentActivity`, which has no payment-method awareness. Reading `src/pages/admin/OrderDetailPage.jsx` directly showed the render condition **already** requires `tx.payment_method === 'gcash' && tx.gcash_channel === 'paymongo'` — the button was never shown for Cash/manual-GCash. This is flagged here specifically as a caution: a partial read of a helper function is not the same as reading the actual gating logic; the fix applied here is a wording/clarity improvement (see §2), not a bug fix. |
| 4 | Post-pickup customer cancellation "only needs a frontend change" (my own earlier study's phrasing) | **CONFIRMED WRONG — correctly not implemented** | `request_order_cancellation()`'s server-side blocked-status list (`Picked Up, In Transit, Arrived at Hub, Out for Delivery, Delivered`) is byte-for-byte identical to the frontend's `IN_NETWORK_STATUSES`. A frontend-only change would have shown a button that always fails server-side. Per your explicit scope instruction, **no post-pickup cancellation permission was added** — this is listed as a business decision in §6, not implemented. |
| 5 | Nullable `payment_refunds.refund_id` implies manual (non-PayMongo) refunds are already possible | **CONFIRMED WRONG — correctly not implemented** | `refund_id` is nullable, but `payment_id` is `NOT NULL` **and** constrained to PayMongo's own format (`^pay_[A-Za-z0-9_-]{4,128}$`). A manual refund cannot be inserted through the existing schema without a synthetic fake `payment_id`, which would be actively misleading. Per your explicit scope instruction, **no manual-refund recording feature was added** — listed as a business decision in §6. |
| 6 | A refund alone corrects the amount owed on an active shipment (Example A: ₱7,000→₱6,500) | **CONFIRMED — no correction path exists at all** | There is no "edit shipping cost / re-weigh" admin UI anywhere in the codebase. `guard_order_update()` recomputes `shipping_cost` only when `actual_weight` changes, and no page calls `updateOrder()` with a new `actual_weight` after pickup. Since the feature to correct a charge doesn't exist, **nothing was built to bypass it** — this is documented as an unsupported limitation in §6, not silently worked around with a refund that would leave a false debt. |
| 7 | Payment can complete while a cancellation is under review | **CONFIRMED — by design, correctly preserved, now surfaced to the admin** | `record_additional_payment()` and `reconcile_paymongo_payment_attempt()` (the PayMongo webhook credit path) have **no** `orders.status` check at all. Per your explicit instruction ("Preserve legitimate late payment confirmations... surface the updated amount to the admin"), this was **not** blocked. Instead, the admin's Approve/Decline buttons now silently refresh the ledger immediately before opening their confirmation dialog (§2), so a payment that lands mid-review is visible before the decision is made. |
| 8 | JOIN-based double-counting when one payment has multiple refunds | **NOT CONFIRMED — already safe** | Both `get_sales_summary()` and `get_financial_report_data()` aggregate payments and refunds in **separate** CTEs before combining them via `UNION ALL`/`FULL OUTER JOIN ... USING (method)` on already-summed one-row-per-method tables. No query re-joins refunds back onto the original payment row. No change needed. |
| 9 | Cancellation approval implies a refund happened | **CONFIRMED — messaging gap, fixed** | The "Approve & Cancel Order" toast only ever said "Cancellation approved... the customer has been notified" — never mentioned money, which is correct, but neither did anything else on the page. Nothing told the admin (or the customer) explicitly that *no refund exists yet*. Fixed in both admin and customer views (§2, §3). |

---

## 2. Files / functions / migrations changed

### Database (forward migration — no existing migration file was edited)
- **`supabase/migrations/20260918010000_refund_period_bucketing_fix.sql`** (new)
  - `ALTER TABLE public.payment_refunds ADD COLUMN succeeded_at TIMESTAMPTZ` — set once, the
    first time a refund reaches `status = 'succeeded'`, and never overwritten again
    (`COALESCE(succeeded_at, ...)` guard).
  - Backfill: `succeeded_at = COALESCE(provider_updated_at, updated_at)` for existing succeeded
    rows (best-available proxy for historical rows).
  - `CREATE OR REPLACE FUNCTION public.reconcile_paymongo_refund(...)` — identical logic to the
    current version, with `succeeded_at` set on first success (INSERT and UPDATE branches).
  - `CREATE OR REPLACE FUNCTION public.get_financial_report_data(...)` — refund date-bucketing
    (the `refunds` CTE and `daily_union`'s refund half) now uses
    `COALESCE(succeeded_at, provider_updated_at, updated_at)` instead of bare `updated_at`.
    Nothing else in the function changed (verified via diff against
    `20260916160000_fix_financial_report_runtime.sql`).

### Frontend
- **`src/pages/customer/OrderDetailPage.jsx`**
  - Added `refundRows`/`refundSucceeded`/`refundPending`/`refundFailed`/`hasAnyRefundRecord`
    computed from the already-loaded `paymentTransactions` (no new data fetch).
  - Cancelled-booking banner: added an explicit "Refund status" section — "No refund recorded
    yet..." when there is no refund row at all, or itemized succeeded/pending/failed amounts
    when there is.
  - Balance card: now shows **"Cancelled"** instead of a raw, non-Cancelled-aware
    `outstandingBalance()` figure in success-green.
- **`src/pages/admin/OrderDetailPage.jsx`**
  - Added the same `grossCollected`/`refundSucceeded`/`refundPending`/`refundFailed` computation,
    plus `eligibleRefundTx` (PayMongo-GCash rows with `refundable_amount > 0`) and
    `unrefundablePaidTx` (Cash/manual-GCash rows that are paid but not provider-refundable).
  - New `CancellationPaymentSummary` component (module-level, reused in two places): original/
    final charge, gross collected, successfully refunded, net collected, pending/failed refund
    totals, a **per-transaction** "Eligible for provider refund (technical maximum — not the
    amount approved to return)" list with a **"Start Refund"** button per row (reuses the
    existing `RefundPaymentModal`, no new modal), and an explicit note for any Cash/manual-GCash
    payment that cannot be refunded automatically.
  - Rendered in **both** the "Cancellation Request Review" action bar and the static
    "Cancellation Details" card on an already-cancelled order (same component, same numbers).
  - New banner: *"Booking cancelled. No money has been refunded by this action."* — shown only
    when there is no successful/pending/failed refund yet; disappears once a refund exists (it
    is replaced by the summary's own numbers, not left showing alongside them).
  - New `openCancellationDecision()` helper — silently refreshes the order/ledger immediately
    before opening the Approve or Decline confirmation dialog, so a late payment during review is
    visible before the admin decides (per your explicit instruction to preserve, not block, that
    payment).
  - New `openRefundModal()` helper — re-fetches the payment ledger immediately before opening
    `RefundPaymentModal`, re-validates the transaction is still eligible, and only then opens it
    (guards against acting on stale `refundable_amount`).
  - Payment History table's Action column: Cash/manual-GCash rows that are paid now show
    **"Manual refund only"** (with an explanatory tooltip) instead of a bare, unexplained "N/A".

### Tests (new)
- **`scripts/refund-period-bucketing-pgtest/run.mjs`** (new) — see §5.
- **`package.json`** — registered the new test in the main `npm test` chain and added a
  `test:refund-period-bucketing` alias, following the project's existing convention.

### Explicitly not touched
No existing migration file was edited (append-only, per `CLAUDE.md`). No RLS policy, no refund
RPC's validation/locking logic, no `RefundPaymentModal`/`AdditionalPaymentModal` internals, no
`get_sales_summary()` (it does not date-bucket refunds at all — see study §2.4 — so it was not in
scope for this fix), no notification code.

---

## 3. Final labels, formulas, and status mapping

**`payment_refunds.status`** — CHECK-constrained to exactly `creating | pending | processing |
succeeded | failed`. **`'uncertain'` is never a real status value** — it is a separate
`outcome_uncertain BOOLEAN` column. The UI's `refund_status` field (built in
`mergePaymentActivity`, `src/lib/database.js`) is `outcome_uncertain ? 'uncertain' : status` —
this is a presentation-layer label, not a database status, and this report does not introduce or
rely on any new database status value.

**Formulas (all backend-computed, client only reads):**
- `Gross collected` = `SUM(payment_transactions.amount) WHERE payment_status IN ('paid','partial')`
- `Successfully refunded` = `SUM(payment_refunds.amount) WHERE status = 'succeeded'`
- `Net collected` = Gross collected − Successfully refunded
- `Refundable (per transaction)` = `payment.amount − SUM(payment_refunds.amount WHERE status IN ('creating','pending','processing','succeeded'))` — reservation includes everything except `failed`, confirmed identical on both the client display (`mergePaymentActivity`) and the server enforcement (`prepare_paymongo_refund`).
- `Remaining balance` = `GREATEST(0, order_payable_amount(shipping_cost, discount_amount) − amount_paid)`, where `amount_paid = GREATEST(gross_paid − refunded_succeeded, 0)` — computed server-side by `update_order_payment_totals()`, has **no** `Cancelled`-aware branch at the column level (the UI must special-case it, which is exactly what was fixed in §2).

**Cancelled-order settlement:** `getSettlementState(order)` always returns `SETTLED` for
`status = 'Cancelled'`, regardless of the raw `remaining_balance` column. This was already correct
in the SQL layer (`get_sales_summary()`'s base CTE filters `WHERE status <> 'Cancelled'` entirely)
and in the admin UI; the only place it was not correctly applied was the customer Balance card,
now fixed.

---

## 4. Example reconciliation table across screens

**Scenario: ₱1,000 GCash (PayMongo) payment on 2026‑09‑20, ₱400 partial refund succeeds the same
day. A duplicate/delayed webhook re-delivers the same succeeded refund on 2026‑10‑05 (simulating a
late provider retry).**

| Screen | September report (Sept 1–30) | October report (Oct 1–31) |
|---|---|---|
| Admin Order Detail — Payment Summary | Gross ₱1,000 · Refunded ₱400 · Net ₱600 (always current, not period-scoped) | *(same — order detail is not period-scoped)* |
| Customer Order Detail / Payment History | ₱400 "refunded and confirmed" (always current) | *(same)* |
| Sales Overview (`get_sales_summary`, lifetime) | grossCollected ₱1,000 · refundTotal ₱400 · netCollected ₱600 | *(same — this RPC is lifetime, not period-bucketed, by design)* |
| Period Financial Report — **before fix** | Gross ₱1,000, Refund ₱400 (correct, refund touched only in Sept) | Gross ₱0, **Refund ₱400 (WRONG — re-dated by the Oct touch)**, Net **−₱400 (spuriously negative)** |
| Period Financial Report — **after fix** | Gross ₱1,000, Refund ₱400, Net ₱600 | Gross ₱0, Refund ₱0, Net ₱0 (genuinely nothing happened in October) |
| PDF/print export | Matches on-screen exactly (clones the rendered `.print-doc` node — no second query) | *(same)* |
| Unsettled Deliveries | Order excluded entirely once `status <> 'Cancelled'` no longer applies here (order is active, not cancelled) — balance shown is ₱600, consistent with Net above | *(unaffected by this scenario)* |

This exact scenario (payment in one period, a refund success in the same period, then a
non-substantive touch to the refund row in a later period) is what
`scripts/refund-period-bucketing-pgtest/run.mjs` exercises against the real migration files.

---

## 5. Tests and results

All commands run from the repo root. Nothing here talks to a live Supabase project — everything
runs against an in-memory Postgres (`@electric-sql/pglite`) with the **real** migration SQL files
applied verbatim, per the project's existing convention.

```
$ node scripts/refund-period-bucketing-pgtest/run.mjs
  ok - succeeded_at is set at success time
  ok - succeeded_at does not move on a later redelivery touch
  ok - provider_updated_at DID move forward (proves the touch was real, not a no-op)
  ok - updated_at moved to a real touch timestamp, independent of succeeded_at
  ok - September report includes the September payment
  ok - September report includes the refund that succeeded in September
  ok - September net = 1000 - 400 = 600
  ok - October report has zero gross collected
  ok - October report does NOT re-count the September refund
  ok - October net can legitimately be zero here — not clamped
  10 passed, 0 failed
```

Full existing suite re-run after all changes, to confirm no regression:

```
$ npm test
  ... (all 27 chained scripts) ...
  14 passed, 0 failed   — payment-refund-pgtest (partial/full refund, redelivery idempotency,
                           concurrent over-refund rejection, sales report gross/refund/net split)
  22 passed, 0 failed   — payment-refund-recovery-pgtest (manual-GCash exclusion, PayMongo-only
                           queueing, uncertain-outcome retention, customer/admin field redaction)
  10 passed, 0 failed   — refund-period-bucketing-pgtest (new, this change)
  Financial report RPC tests passed (empty, mixed methods, refund states, boundaries,
                           authorization, both RPCs)
  ... axe-lint, token-lint, security-hardening, payment-ui, payment-return-state,
      paymongo-authorization, payment-refund-request, announcement/broadcast, booking-dirty-state,
      registration-transition, unsettled-mobile-layout, photo-*, apple-platform,
      push-notification, notification-ux — all passed
```

```
$ npm run build
  ✓ built (no errors)
```

Manual syntax verification (`esbuild --bundle`) was also run against both edited JSX files before
the full test/build pass, to catch a malformed edit early.

**Regression scenarios from your list, and how each is covered:**

| Scenario | Covered by |
|---|---|
| Partial and full refunds | Existing `payment-refund-pgtest` |
| Multiple partial refunds against one payment | Existing `payment-refund-pgtest` (reservation-sum rejection + full-remainder test) |
| Multiple payments on one order | Existing `payment-ledger-pgtest` |
| Pending, failed, uncertain refunds | Existing `payment-refund-pgtest` + `payment-refund-recovery-pgtest` ("unknown provider outcome is retained as an explicit uncertain state") |
| Duplicate webhook delivery | Existing `payment-refund-pgtest` ("webhook redelivery is idempotent") + new test (duplicate touch to an already-succeeded row) |
| Concurrent refund attempts | Existing `payment-refund-pgtest` ("active reservations prevent concurrent over-refunds") |
| Cancelled order, no refund yet | **UI logic reviewed by direct code read** (§1, §2) — not automated-tested; no pgtest harness renders JSX |
| Cancelled order, successful refund | **UI logic reviewed by direct code read** — same caveat |
| Active-order refund vs. actual charge correction | **Not applicable** — charge correction has no UI to test; documented as unsupported (§6) |
| Payment and refund in different report periods | **New `refund-period-bucketing-pgtest`** (this change's primary target) |
| Cash/manual-GCash eligibility | Existing `delivery-cash-payment-pgtest` (server-side) + admin button gating (already correct, pre-existing — §1 item 3) |
| Screen/print totals from same generated data | Verified by direct code read: `exportPrintDocumentToPdf` clones the already-rendered DOM node, no second query |

**Explicitly not visually tested.** No browser tool was available in this session. The two JSX
files were verified for (a) syntax correctness via `esbuild`, (b) successful production build via
`npm run build`, (c) accessibility via the project's `axe-lint` linter, and (d) CSS token
correctness via `token-lint` — but **actual rendered appearance, mobile layout, and modal
scroll/footer behavior were not visually confirmed in a browser.** All new UI reuses existing CSS
classes/utilities already used elsewhere in the same file in the same responsive patterns (grid,
flex-wrap), and no existing modal (`RefundPaymentModal`, `ReasonModal`, `AdditionalPaymentModal`)
was structurally modified — new content was only added to page-level cards/action bars, which
lowers layout risk, but this is not a substitute for actually opening the pages on a phone-width
viewport.

---

## 6. Remaining unsupported features and business decisions

These were deliberately **not** built, per your explicit scope instruction not to silently
introduce new policy:

1. **Post-pickup customer self-cancellation.** Both client and server currently block it
   identically. Needs a business decision on which statuses (if any) should allow it, and whether
   pickup/return charges apply, before any code changes.
2. **Manual refund recording for Cash / manually-recorded GCash.** No table/RPC exists to record
   "we manually returned this money" — the schema's `payment_id` format constraint actively
   prevents inserting a manual refund through the existing `payment_refunds` table without a fake
   PayMongo-shaped ID. Needs a decision on whether this belongs in `payment_refunds` (with a
   relaxed constraint for a `manual` channel) or a separate lightweight record, and whether it
   needs a second-admin confirmation step.
3. **Charge correction on an active shipment** (Example A: ₱7,000 collected, ₱6,500 correct). No
   "edit shipping cost after pickup" UI exists at all. Building the refund-approval UI around an
   assumption that this exists would have been wrong; it does not. A pricing-correction feature
   needs its own design (who can correct it, until which status, is it logged) before a refund can
   correctly leave both the charge *and* the collected total consistent at ₱6,500.
4. **A formal "approved refund amount" concept**, distinct from "technically eligible to refund."
   Today the only place this distinction lives is in the admin's own judgment when typing an
   amount into `RefundPaymentModal` — the UI now labels the maximum clearly as a technical ceiling
   (§2), but there is no database field recording what the business actually *decided* to return
   versus what PayMongo would technically allow.
5. **Cargo-return tracking after a post-pickup cancellation.** No column or action exists to record
   whether cargo was returned to the customer or is awaiting pickup at a hub. Out of scope here
   since it's downstream of decision #1.

---

## 7. Deployment steps (if applied)

1. Apply the new migration: `supabase db push` (after linking to the target project — see
   `CLAUDE.md`). This runs `20260918010000_refund_period_bucketing_fix.sql`, which:
   - Adds one nullable column (`succeeded_at`) — non-breaking, no downtime.
   - Backfills existing succeeded refunds from `provider_updated_at`/`updated_at` — a read+write
     over the `payment_refunds` table, expected to be small (refunds are a low-volume table for
     this business) and safe to run online.
   - Replaces two functions (`reconcile_paymongo_refund`, `get_financial_report_data`) via
     `CREATE OR REPLACE` — no signature change, so existing grants and callers are unaffected.
2. No Edge Function changes were made — no `supabase functions deploy` needed.
3. Frontend: standard `npm run build` + deploy — no new environment variables, no new client
   dependencies.
4. No data migration or backfill is needed on the frontend side; the new UI reads fields
   (`is_refund`, `refund_status`, `refundable_amount`, `gcash_channel`) that already existed in
   the payment-history RPCs before this change.

---

## Taglish summary

**Ano ang binago at bakit tama na ngayon ang mga numero.**

May totoong bug na nakita — kapag na-refund na yung isang bayad tapos may huling
webhook/duplicate na dumaan pa dito (kahit walang binago), naliligaw ito sa ibang buwan sa
Financial Report dahil sa `updated_at` column ang ginagamit, na gumagalaw kahit walang totoong
pagbabago. Ngayon may bagong `succeeded_at` column na nakatakda **isang beses lang**, sa
totoong sandali ng tagumpay ng refund — kaya doon na lang permanente sasabak ang refund sa report,
hindi na lilipat pa.

Sa customer app, kapag cancelled na ang booking pero bahagya lang na-refund, dati'y nagpapakita ito
ng "Balance" na berde na parang settled at malaki pa — nakakalito. Ngayon, malinaw na lang na
sinasabing "Cancelled" ang balanse, at may bagong "Refund status" na nagsasabi kung ilan ang
na-refund na, ilan ang naka-pending, at kung wala pa talagang naitatalang refund — hindi na
basta-basta ipapalagay na buo ang refund.

Sa admin side, kapag nire-review ang isang cancellation request, makikita na ngayon agad ang
kabuuang nakolekta, na-refund na, at naka-pending, plus per-transaction na "Start Refund" button —
gamit pa rin ang parehong refund modal, walang bagong module. Pagkatapos mag-approve ng
cancellation, may malinaw na paalala: "Booking cancelled. No money has been refunded by this
action." kung wala pang refund — para hindi ipalagay na kasabay na-refund ang customer.

**Hindi namin ginalaw:** yung cancellation policy pagkatapos ma-pickup, manual refund recording
para sa Cash/manual-GCash, at pag-correct ng presyo sa active na shipment — lahat ito ay
kailangan munang desisyunan bago i-build, base mismo sa iyong instruksyon na huwag basta magdagdag
ng bagong policy nang tahimik. Nakalista ang mga ito sa Seksyon 6 bilang mga tanong na dapat
sagutin muna.
