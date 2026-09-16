# Shipping Discount Implementation Report

Admin-only, fixed-peso shipping discount applied at pickup. Implemented across
the database (schema + triggers + RPC), the admin pickup UI, and customer/
admin displays and reports. Verified with a real embedded-Postgres test suite
that runs the actual shipped SQL, not a re-implementation of it.

**Nothing was deployed.** No migration was applied to a real database, no
Edge Function was deployed, and no real payment was processed. Everything
below describes prepared, locally-verified changes.

---

## 1. Previous pricing flow, and the design chosen

### 1.1 How a fee is produced today (before this feature)

- A booking is created **unpriced**: `prepare_order_insert()` always sets
  `shipping_cost = 0`, `remaining_balance = 0`. Nothing is billed until the
  parcel is weighed.
- At pickup, the admin enters `actual_weight` in `PickupModal`. On save,
  `record_pickup_payment()` writes `actual_weight` (and status → `Picked Up`)
  in one `UPDATE orders ...` statement.
- That single `UPDATE` fires the `guard_order_update()` trigger, which — because
  `actual_weight` changed — recomputes `shipping_cost := ROUND(weight * price, 2)`,
  where `price` comes from the assigned trip's `price_per_kg` or the global
  rate. **`shipping_cost` has always meant the fee computed from weight × rate
  — the "original" fee — and nothing before this feature ever meant anything
  else by it.**
- Money is a separate concern, owned by the `payment_transactions` ledger. Any
  INSERT/UPDATE/DELETE there fires `update_order_payment_totals()`, which sums
  the ledger and writes `orders.amount_paid`, `orders.remaining_balance`, and
  `orders.payment_status` (via the shared `derive_payment_status()` helper).
- `guard_order_update()` also independently recomputes `remaining_balance` and
  `payment_status` whenever weight/trip/`amount_paid` changes, using the
  **same** `derive_payment_status()` helper — this dual-writer design was
  fixed once already (see `20260805120000_payment_status_on_weight_edit.sql`)
  specifically because the two triggers had drifted. That existing fix is the
  reason this feature could be added by extending one shared formula instead
  of patching two independent ones.

**Conclusion of the inspection: `shipping_cost` already, unambiguously, meant
the original fee.** There was no "payable fee" concept distinct from it, and no
code path ever redefined `shipping_cost` mid-lifecycle. This made the correct
design obvious rather than a judgment call.

### 1.2 Design chosen

Add the discount as its **own** fact, and introduce **one** shared function
for "what is actually owed":

```
original fee   = orders.shipping_cost                      (never redefined)
discount       = orders.discount_amount                    (new; fixed peso)
final fee      = order_payable_amount(shipping_cost, discount_amount)
               = GREATEST(shipping_cost - discount_amount, 0)   (new SQL function)
remaining_balance = GREATEST(final fee - amount_paid, 0)   (both triggers, one formula)
payment_status     = derive_payment_status(final fee, amount_paid)   (unchanged function, new first argument)
```

`order_payable_amount()` is called from **both** `guard_order_update()` and
`update_order_payment_totals()` — exactly mirroring how `derive_payment_status()`
was already shared to prevent the earlier two-trigger drift. This is what
guarantees the discount cannot be "subtracted twice" or "lost" between the two
triggers: there is only one formula, called from both places, and both places
were changed in the same migration.

### 1.3 Why this needed more than a DB fix

Two *client-side* JS re-implementations of "what is owed" also had to be
updated, or the UI would show wrong numbers while the database was correct:

- `outstandingBalance(order)` in `src/constants/status.js` — deliberately
  computes `shipping_cost − amount_paid` **itself**, by design, rather than
  trusting the stored `remaining_balance` column (its own doc comment explains
  why: the stored column can lag a ledger write). This function feeds the
  customer "Balance" tile, the admin Unsettled list, `TripDetailPage`'s
  unsettled filter, and the dispatch-gate mirror. It now computes
  `finalShippingFee(order) − amount_paid`, where `finalShippingFee()` mirrors
  `order_payable_amount()` exactly.
- Admin `OrderDetailPage.jsx` has its **own** independent re-derivation of
  `shipping_cost` (`ratePerKg` backed out from the order, then
  `weight * ratePerKg`) for its summary card. This was left as-is for the
  *original* fee (to avoid touching working, subtle logic) and the discount is
  layered on top of its result for the *final* fee and balance.

---

## 2. Database fields and their meaning

New columns on `orders` (migration `20260911010000`):

| Column | Meaning |
|---|---|
| `discount_amount` (`NUMERIC(10,2)`, `NOT NULL DEFAULT 0`) | Fixed peso amount off the **original** `shipping_cost`. Never negative, never greater than `shipping_cost` (`CHECK` constraints). `0` = no discount. |
| `discount_reason` (`TEXT`) | `'Regular customer'` \| `'Negotiated price'` \| `'Other'`. `NULL` iff `discount_amount = 0` (`CHECK (discount_amount > 0) = (discount_reason IS NOT NULL)`). |
| `discount_notes` (`TEXT`) | Required free-text explanation when `discount_reason = 'Other'` (`CHECK`); `NULL` otherwise. Admin-internal — never shown to the customer. |
| `discount_applied_by` (`UUID → profiles.id`) | The admin who applied it. |
| `discount_applied_at` (`TIMESTAMPTZ`) | When. |

`discount_applied_by`/`discount_applied_at` are stored **on the order row
itself**, not only written to `activity_logs` — the brief specifically asked
for this because `activity_logs` can be purged and is not guaranteed
permanent storage. (The RPC *also* writes an `activity_logs` entry, for the
existing audit-trail UI, but the order row is the durable record.)

New function: `public.order_payable_amount(shipping_cost, discount_amount)` —
`GREATEST(shipping_cost - discount_amount, 0)`. `IMMUTABLE`, `SQL`.

---

## 3. Business rules implemented, and where

All of these are enforced **inside `guard_order_update()`** (migration
`20260911020000`) — a `BEFORE UPDATE` trigger on `orders` — which means they
apply no matter which code path tries to write `discount_amount`, not only the
one sanctioned RPC:

- Only an admin may change a discount (`is_admin()` check).
- `discount_amount ≥ 0`.
- `discount_amount ≤ shipping_cost` **as freshly recomputed in the same
  statement** — the check runs *after* `shipping_cost := ROUND(weight * price, 2)`
  in the same trigger invocation, so it validates against the fee for the
  weight actually being saved right now, not a stale value.
- A positive discount requires `discount_reason` to be one of the three fixed
  values; `'Other'` additionally requires non-blank `discount_notes`.
- **Read-only after pickup**: rejected unless `OLD.status IN ('Pending Review', 'Pending', 'Assigned')`.
- **Read-only once a payment exists**: rejected if any `payment_transactions`
  row with `payment_status IN ('paid','partial')` already exists for the
  order — belt-and-suspenders alongside the status check (see §3.1).
- Turning the discount off (`discount_amount = 0`) always clears
  `discount_reason`/`discount_notes`/`discount_applied_by`/`discount_applied_at`
  to `NULL`, **even if the caller still sent stale values for them** — a
  client bug cannot leave a "ghost" reason on a non-discounted order.

`record_pickup_payment()` (migration `20260911030000`) additionally:

- Refuses to run **at all** once `orders.status` is no longer one of
  `Pending Review / Pending / Assigned` — i.e. once pickup has already been
  confirmed once, a second call is refused outright, regardless of whether the
  discount it resends is identical. This is the concrete mechanism behind
  "discount is read-only after pickup": there is no second bite at the RPC.
- Accepts the discount as three new **trailing** parameters
  (`p_discount_amount`, `p_discount_reason`, `p_discount_notes`), written in
  the **same** `UPDATE` statement as `actual_weight`/`status`/`payment_method`
  — one atomic write. See §5 for atomicity.
- Never creates a `payment_transactions` row for the discount itself — only
  `p_amount > 0` does that (unchanged from before this feature; the discount
  parameters are entirely independent of the payment parameters).

### 3.1 Section 3's "active PayMongo checkout" condition — inspected, and why it needs no extra code

The brief asks that an active PayMongo checkout also block a discount edit. I
traced the pickup-time GCash flow (`PaymentCollectionPanel.jsx` →
`createGCashSource` → `payment_attempts`) and the webhook/reconcile path
(`reconcile_paymongo_payment_attempt()`), and this condition is **already true
by construction**, for one reason: a discount can only ever be set inside
`record_pickup_payment()`, and that RPC can only run while the order is still
pre-pickup and **unpriced**. Nothing can be "paid" against an unpriced,
pre-pickup order — there is no balance yet to charge. So the moment any
payment (PayMongo or manual) could exist, the order is no longer pre-pickup,
and the status guard above already blocks the discount. I did not add a
separate `payment_attempts` check for this reason; adding one would be inert
code guarding against a state the schema cannot produce.

**One real, pre-existing edge case, not introduced by this feature:**
`PaymentCollectionPanel`'s "Cancel payment — pay another way" deliberately
does **not** void the PayMongo source (its own comment: "if the customer pays
that link ten minutes from now, the webhook still reconciles it against this
order and the ledger stays honest" — an intentional design choice already in
production). If an admin generates a pickup-time GCash QR, cancels it, then
confirms pickup by cash with a *different* discount, and the customer later
pays the abandoned QR anyway, the webhook will still credit that **original,
pre-cancellation** amount to the (now-discounted) order. This is not new: the
exact same staleness already existed before this feature for a weight
correction between generating and cancelling a QR. It is not fixed here —
doing so would require voiding/expiring abandoned PayMongo sources, which is
an unrelated, larger payment-protection change, and reconciling a late,
mismatched credit would require exactly the "overpayment workflow" the brief
says not to build. Flagged here as inspected, understood, and consciously not
touched, per the brief's own instruction for this situation.

---

## 4. Files changed

### Database (new migrations — none edit an already-applied file)

| File | Purpose |
|---|---|
| `supabase/migrations/20260911010000_shipping_discount_schema.sql` | New columns + `CHECK` constraints on `orders`. |
| `supabase/migrations/20260911020000_shipping_discount_guards.sql` | `order_payable_amount()`; `prepare_order_insert()` (zeroes discount on INSERT); `guard_order_update()` (discount-aware balance + read-only guard); `update_order_payment_totals()` (discount-aware). |
| `supabase/migrations/20260911030000_record_pickup_payment_discount.sql` | `record_pickup_payment()` extended with the 3 discount parameters + the "already picked up" guard. |
| `supabase/migrations/20260911040000_sales_summary_discount_aware.sql` | `get_sales_summary()`: discount-aware `outstanding`/`totalRevenue`, new `totalDiscounts` field. |

### Backend / shared JS

- `src/lib/database.js` — `recordPickupPayment()` passes the 3 discount
  fields through; `discount_amount` added to every `orders` `SELECT` column
  list whose result is later run through `outstandingBalance()`
  (`getUnsettledOrders`, `getTripById`, `getSalesData`'s RPC-failure fallback,
  `getReportData`); `getSalesData`'s fallback path and `getReportData`'s
  summary gained the same `totalRevenue`/`totalDiscounts` treatment as the RPC.
- `src/constants/status.js` — new `finalShippingFee()`, `hasDiscount()`,
  `DISCOUNT_EDITABLE_STATUSES`, `canApplyDiscount()`; `outstandingBalance()`
  rewritten to route through `finalShippingFee()`.

### UI

- `src/components/ui/PickupModal.jsx` — the "Apply Discount" toggle (off by
  default), amount/reason/explanation fields, live pricing summary (Original /
  Discount / Final / Received / Balance), the "No payment due" state for a
  100%-discounted pickup, weight-change revalidation, and payload assembly.
  `PaymentCollectionPanel`'s `expectedAmount` is now the discounted final fee.
- `src/pages/admin/OrderDetailPage.jsx` — discount-aware summary tiles
  (Original Fee / Discount / Final Fee), a "Discount Applied" detail card
  (reason/notes/who/when — admin-only), "No Payment Due (Discount)" badge for
  a fully-discounted order, activity-log line mentions the discount.
- `src/pages/customer/OrderDetailPage.jsx` — the same Original/Discount/Final
  tiles **without** reason/notes/who-applied (kept admin-internal), and the
  same "No Payment Due" badge override.
- `src/pages/admin/UnsettledDeliveriesPage.jsx` — "Billed" column (both the
  live table and its print mirror) now shows the discounted final fee, with
  the pre-discount figure kept as a small annotation when a discount exists.
- `src/pages/admin/ReportsPage.jsx` — the per-order "Amount" column (both the
  live table and its print mirror) now shows the discounted final fee.
- `src/pages/admin/SalesPage.jsx` — printed report gained a "Total Discounts
  Given" line; the existing "Total Revenue (billed)" row is relabelled
  "(billed, net of discounts)" to match its now-corrected meaning.

### Tests

- `scripts/shipping-discount-pgtest/harness-schema.sql` + `run.mjs` (new) —
  see §7.
- `package.json` — added `test:shipping-discount` script (same convention as
  `test:payment-ledger`).

---

## 5. Effects on payments, notifications, receipts, reports

- **PayMongo / GCash at pickup**: `PickupModal`'s `paymentConfig.expectedAmount`
  is now `finalFee` (discounted), not the raw weight×rate estimate — the
  "Full Payment" quick-fill, the shortfall check, and the amount sent to
  `createGCashSource` are all discounted. The post-pickup balance flow
  (`paymongo-create-payment` Edge Function) needed **no changes**: it already
  reads `orders.remaining_balance` as its authority for a customer's payment
  cap, and that column is now discount-aware via the trigger fix — the Edge
  Function inherits correctness for free. Verified by reading the function in
  full; not independently re-tested (see §8, "inspected only").
- **Direct/manual GCash recording**: `record_additional_payment()` and
  `record_delivery_payment()` needed **no changes** for the same reason — both
  measure against `orders.shipping_cost`/`remaining_balance`, which are now
  correct.
- **Ledger**: unchanged. A discount never inserts into `payment_transactions`
  — confirmed by reading `record_pickup_payment()`'s structure (the ledger
  INSERT is gated on `p_amount > 0` alone) and by the test suite (100%
  discount → zero ledger rows; discount + payment → exactly one ledger row for
  the money actually collected).
- **Duplicate-prevention preserved, verbatim**: the idempotency-key check,
  `guard_manual_gcash_payment()`'s duplicate-reference check, and the
  `ON CONFLICT ... DO NOTHING` ledger insert are all **unmodified** lines from
  `20260909030000`, copied forward into the new function body untouched.
  Re-verified by running the existing `test:payment-ledger` suite unchanged
  (40/40 pass) and by new duplicate-specific scenarios in the new suite.
- **Notifications**: `private.notify_payment_recorded()` fires only on
  `payment_transactions` `AFTER INSERT` and was not modified. Since a discount
  never inserts there, a discount-only action **cannot** trigger it — this is
  structural, not a new check I added. Because it reads `orders.remaining_balance`
  *after* the ledger trigger has recomputed it, its message already reports
  the discounted balance for free. Verified at runtime (§7): a discount-only
  pickup produces zero notification rows; a discounted pickup with a real
  payment produces exactly one, whose text contains the discounted balance and
  not the pre-discount one; a retried identical payment still produces exactly
  one.
- **Receipts**: there is no separate single-order receipt document in this
  codebase distinct from the "Payment Details" card already updated above
  (payment-history rows are per-ledger-transaction and were never priced in
  terms of `shipping_cost`, so they needed no change).
- **Reports/dashboard**: `get_sales_summary()`'s `outstanding` (five call
  sites inside the function — total, all-orders, unpaid count, the unpaid-
  orders list, and each month's figure) and `totalRevenue`/monthly
  `total_revenue` are now discount-aware; `totalDiscounts` is new. Actual
  collections (`paidTotal`, `ledgerTotal`, method breakdowns) are untouched —
  they were always pure ledger sums and a discount was never counted there.
  `getReportData()`'s per-order "Amount" and `totalOutstanding` are similarly
  fixed; its `totalRevenue` field already meant *collected* money (an
  existing, if confusingly-named, convention) and was intentionally left
  alone.

---

## 6. Backward compatibility / deployment order

1. `20260911010000_shipping_discount_schema.sql` — additive only. Every
   existing row gets `discount_amount = 0`; every historical price and
   payment stays byte-identical (no historical fee is recomputed; no
   discount history is fabricated). Safe to apply alone; changes no
   behaviour.
2. `20260911020000_shipping_discount_guards.sql` — depends on (1)'s columns
   existing (`guard_order_update()`/`update_order_payment_totals()` reference
   `discount_amount`). Also additive in effect: for every row with
   `discount_amount = 0`, `order_payable_amount(shipping_cost, 0) = shipping_cost`,
   so `remaining_balance`/`payment_status` compute identically to before.
3. `20260911030000_record_pickup_payment_discount.sql` — depends on (1) and
   (2). Must be applied before the frontend bundle that sends
   `p_discount_amount`/`p_discount_reason`/`p_discount_notes` is deployed (see
   compatibility note below).
4. `20260911040000_sales_summary_discount_aware.sql` — independent of (1)–(3)
   at the SQL level (only reads `discount_amount`, which (1) already added),
   but should ship with them for the reported numbers to be meaningful.

**Frontend/backend compatibility window**: `record_pickup_payment()` now has
**three** live overloads (12-param from `20260803100000`, 14-param from
`20260909030000`, 17-param from this feature) because each of those earlier
migrations used `CREATE OR REPLACE` while *adding* trailing parameters, which
Postgres treats as a new, distinct function rather than a true replacement —
**this migration follows the same existing pattern** rather than risk an
exact-signature `DROP FUNCTION` typo against a function this size. This is
safe because every caller (old and new) always sends every named parameter its
own version of `recordPickupPayment()` in `src/lib/database.js` defines, so
PostgREST resolves each call unambiguously to the intended version — an
**old** deployed frontend bundle continues to resolve to the 14-param version
(no discount capability, unaffected) even after these migrations ship, and a
**new** bundle resolves to the 17-param version. There is no window in which a
half-deployed state breaks either bundle. The two older overloads are pre-
existing debt this feature did not create; cleaning them up is a separate,
unrelated task, called out here for visibility, not fixed.

**Rollback**: migrations (1)–(4) can be reverted by dropping the added
columns/constraints and restoring the pre-feature function bodies (all fully
reproduced, verbatim, inside `harness-schema.sql` for exactly this reason — it
IS the pre-feature state). There is no explicit `DOWN` migration file, matching
this repository's existing convention (no other migration in
`supabase/migrations/` ships a paired rollback file either).

---

## 7. Tests performed and results

All of the following were **executed**, not just read, against a real
embedded PostgreSQL (`@electric-sql/pglite` — already a dev dependency of this
repo, used the same way by the pre-existing `scripts/payment-ledger-pgtest`
suite). The harness loads a hand-built "before" schema that is the **pre-
feature production SQL verbatim** (copied from the exact migrations named in
each function's own header comment), then applies **the four real new
migration files, unmodified**, then runs 61 assertions.

Run with: `npm run test:shipping-discount`

```
61 passed, 0 failed
```

Executed and passing:

- No-discount pickup produces identical `shipping_cost`/`amount_paid`/
  `remaining_balance`/`payment_status` to the pre-migration baseline.
- An order picked up **before** the migration, re-read **after** it, is
  numerically unchanged (`discount_amount = 0`, everything else identical) —
  proves "existing orders retain current prices, no discount fabricated."
- The ₱1,000 / ₱100 discount / ₱400-at-pickup example → `remaining_balance = 500`,
  exactly one ₱400 ledger row (not ₱1,000, not ₱900).
- Settling that ₱500 later (simulated via `reconcile_paymongo_payment_attempt`)
  → `amount_paid = 900`, `remaining_balance = 0`, `payment_status = 'paid'`,
  and the ledger holds exactly two rows totalling ₱900 — the example from the
  brief, verified end to end including the "later GCash" leg.
- Exact full payment of a discounted fee in one shot → `paid`, `remaining_balance = 0`.
- A 100% discount → `remaining_balance = 0`, `amount_paid = 0`, **zero** ledger
  rows, zero notification rows.
- Rejected: negative discount; discount exceeding the original fee; a positive
  discount with no reason; a reason outside the fixed three; `'Other'` with a
  blank/whitespace-only explanation. Also confirmed each rejected attempt left
  the order **completely untouched** (still pre-pickup, `actual_weight` still
  `NULL`, `discount_amount` still 0).
- Atomicity: an over-limit discount submitted together with `actual_weight`
  and a `₱300` cash amount is rejected as one unit — `actual_weight` was not
  saved, status stayed pre-pickup, and no ledger row exists. Proves the "no
  partial save" requirement, not just "the discount alone is rejected."
- Toggle-off is enforced server-side even against a simulated client bug
  (`discount_amount: 0` sent alongside a stale `discount_reason`/`discount_notes`)
  — both are forced to `NULL`.
- A discount that fits a 10 kg parcel is rejected outright (not silently
  shrunk) when the actual weight is re-entered as 1 kg — "weight change
  revalidates the discount, does not silently change it."
- A customer session calling the pickup RPC — with or without a discount
  attached — is rejected outright (`Admin access required`).
- After a successful pickup: a raw `UPDATE orders SET discount_amount = ...`
  is rejected (not merely hidden by the UI); calling `record_pickup_payment()`
  a second time on the same order is rejected outright.
- A contrived pre-pickup order with a `payment_transactions` row already
  present also blocks a discount `UPDATE` — the independent, second guard,
  exercised on its own.
- Duplicate/retried pickup submissions (same idempotency key) still produce
  exactly one ledger row and leave the discount unaffected by the retry.
- The existing manual-GCash duplicate-reference protection still fires
  correctly on the new, longer function signature.
- A discount-only pickup creates **zero** notification rows; a discount +
  payment pickup creates **exactly one**, whose text contains the *discounted*
  remaining balance and **not** the pre-discount figure; a retried identical
  payment still produces exactly one notification.
- `get_sales_summary()`'s `totalRevenue`/`totalDiscounts`/`paidTotal` all match
  independently-computed `SUM()`s over the same fixture data, and collections
  are reported separately from discounts, never merged.

Also executed (pre-existing suites, to confirm no regression to what this
feature explicitly must preserve):

- `npm run test:payment-ledger` — **40/40 pass**, unchanged. Proves the
  BUG-01 duplicate-prevention fixes are untouched.
- `npm run test:payment-notifications` — **41/41 pass**, unchanged. Proves the
  BUG-02 one-notification-per-payment fixes are untouched.
- `npm run test:edge-functions` — **7/7 pass** (build-only check; no Edge
  Function source was modified by this feature).
- `npm test` (the full contract-test chain: smoke, a11y/token lint, activity
  log, payment UI, booking dirty-state, registration, unsettled mobile layout,
  photo reference/fallback/monitoring, Apple platform, push notification,
  notification UX) — every check passes except two **pre-existing**
  `axe-lint` findings (`src/App.jsx:311`, `src/pages/customer/OrderDetailPage.jsx:973`)
  confirmed via `git show HEAD` to predate this session entirely and to sit on
  lines this feature never touched. Zero new lint findings.
- `npx vite build` — clean production build after every batch of changes.

### Inspected only (not executed) — and why

- **The `paymongo-create-payment` / `paymongo-webhook` Edge Functions**: read
  in full; confirmed they read `orders.remaining_balance` as their authority
  and were not modified. Not independently re-run, because doing so requires
  Deno + live PayMongo/Supabase credentials this environment does not have,
  and no Edge Function source changed.
- **The customer-facing GCash "Pay Now" UI flow end to end in a browser**: the
  underlying data (`outstandingBalance()`, `remaining_balance`) was verified
  in the SQL test suite; the component code path was read and reasoned about,
  not click-tested in a running app (no live Supabase project is available in
  this environment to actually run the app against).
- **True concurrent-request races** (two admins submitting at the literal same
  instant): PGlite serializes all transactions through one connection, so — as
  the pre-existing `payment-ledger-pgtest` suite's own header notes — a
  `Promise.all([...])` in this harness proves the function's logic is correct
  once Postgres's row lock (`SELECT ... FOR UPDATE`) has serialized two
  callers, not true multi-backend lock contention.
- **The "active PayMongo checkout" pre-existing edge case** described in
  §3.1 — analyzed by reading every relevant function; not reproduced in the
  test harness, because reproducing it faithfully means re-implementing the
  whole abandon/reconcile-later interaction, which is unrelated to this
  feature and pre-existing regardless of it.

---

## 8. Remaining unverified items

- Real PayMongo capture/webhook behaviour against a live account (inherently
  outside a local/offline environment).
- Any UI interaction in an actual running browser session (button clicks,
  toggle reveal/hide animation, field-level error focus) — verified by
  reading `PickupModal.jsx`'s logic and by the existing `axe-lint`/contract
  test suite passing, not by driving a live app.
- The two orphaned `record_pickup_payment` overloads (12- and 14-param) are
  documented but not cleaned up — pre-existing debt, out of scope for this
  feature, and removing them safely would need its own verification pass.

---

## 9. Defense-demo steps (using the brief's own example)

Requires the migrations applied to a real (or local Supabase) database and the
frontend bundle rebuilt.

1. As an admin, open an `Assigned` order and click **Process Pickup**.
2. Enter weight so the estimated cost reads **₱1,000** (e.g. 10 kg at a ₱100/kg
   trip rate, or adjust to whatever rate is configured).
3. Toggle **Apply Discount** on. Enter **₱100**, choose reason **Regular
   customer**. The pricing summary updates live: *Original Fee ₱1,000.00 →
   Discount −₱100.00 → Final Fee ₱900.00*.
4. Set Payment Type to **Pay Later** (or Full, entering **₱400** manually) so
   **Amount Received = ₱400**. The summary shows **Remaining Balance ₱500.00**.
5. Attach a pickup photo and click **Confirm Pickup**. The order now shows
   Original Fee ₱1,000 / Discount −₱100 / Final Fee ₱900 / Paid ₱400 / Balance
   ₱500 on both the admin and customer order-detail pages; the payment history
   shows exactly one ₱400 entry.
6. Later, settle the ₱500 via GCash (customer "Pay Now" or admin "Record
   Additional Payment"). The order becomes fully paid; the ledger now shows
   two entries totalling ₱900 — never ₱1,000.
7. To see the "no payment due" path: repeat from step 1 on a fresh order,
   enter a discount equal to the full estimated cost (e.g. ₱1,000 discount on
   a ₱1,000 fee). The payment panel is replaced by a green **"No payment
   due"** banner; confirming pickup creates no payment record and no payment
   notification.
8. To see the read-only guard: reopen that same order's admin detail page —
   there is no way to re-open Pickup Processing (its status has advanced), and
   a direct database `UPDATE` to `discount_amount` on that order is rejected
   by `guard_order_update()`.

---

## Summary

**Implemented**: a fixed-peso, admin-only shipping discount — schema,
server-side validation and immutability guards, atomic pickup RPC, discount-
aware balance/status computation shared by both money triggers, the admin
pickup UI (toggle, amount, reason, live pricing summary, "no payment due"
state), customer/admin order-detail displays, and the sales-report/unsettled-
deliveries figures — while leaving every existing duplicate-payment and
payment-notification protection byte-for-byte unmodified.

**Tested**: 61 new assertions executed against the real, shipped SQL on an
embedded Postgres (`npm run test:shipping-discount`, 61/61 passing), plus the
two pre-existing protection suites re-run unchanged (81/81 passing) and the
full project contract-test chain and production build, both clean.

**Not deployed**: no migration, Edge Function, or real payment touched a live
system. Deployment order and the (already-safe) overload-compatibility window
are documented in §6.

**Report path**: `SHIPPING_DISCOUNT_IMPLEMENTATION_REPORT.md` (project root).
