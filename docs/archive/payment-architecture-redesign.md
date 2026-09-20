# Payment Architecture Redesign — Engineering Design Document

**Project:** CargoExpress PH
**Status:** Proposal — awaiting approval. **No code changes have been made.**
**Author:** Prepared from direct source analysis
**Date:** 2 August 2026

---

## 0. Scope and method

Every statement below is grounded in the current repository. Files and line numbers cited are
from the working tree at `/Users/beasarong/Downloads/CargoExpressPH-main`.

Components studied in full:

| Layer | Artefacts examined |
|---|---|
| Tables | `orders`, `payment_transactions`, `payment_attempts` (schema.sql + 38 migrations) |
| Triggers | `prepare_order_insert`, `guard_order_update`, `update_order_payment_totals`, `update_updated_at` |
| RPCs | `reconcile_paymongo_payment_attempt` (×3 versions), `get_sales_summary`, `global_price_per_kilo`, `effective_trip_price` |
| RLS | All policies on `orders`, `payment_transactions`, `payment_attempts` |
| Edge Functions | `paymongo-create-payment` (398 ln), `paymongo-webhook` (265 ln) |
| Client lib | `src/lib/paymongo.js` (224 ln), `src/lib/database.js` payment section |
| React | `PickupModal`, `DeliveryModal`, `AdditionalPaymentModal`, customer `OrderDetailPage`, admin `OrderDetailPage`, `PaymentMethodsPage`, `BookShipmentPage` |

---

# A. Current Payment Architecture

## A.1 The four write paths

Today, five different code locations can change an order's payment state, through **four
mutually inconsistent mechanisms**:

```
┌─ PATH 1 — Admin manual (WORKS) ──────────────────────────────────────────┐
│ PickupModal.handleSubmit()          computes payment_status in JavaScript │
│   → admin/OrderDetailPage.handlePickupSave()          :227                │
│   → updateOrder()          database.js:275  → direct UPDATE orders SET    │
│                                                payment_status, amount_paid │
│   → recordPaymentTransaction()  database.js:1477 → INSERT ledger row      │
│   → trigger update_order_payment_totals → recomputes orders from ledger   │
│                                                                            │
│ Writes the same fact TWICE by two different mechanisms.                    │
└───────────────────────────────────────────────────────────────────────────┘

┌─ PATH 2 — Admin additional payment (WORKS) ──────────────────────────────┐
│ AdditionalPaymentModal.handleSave()                                       │
│   → recordAdditionalPayment()  database.js:1504                           │
│   → recordPaymentTransaction() → INSERT ledger → trigger derives totals   │
│                                                                            │
│ Ledger-only. This is the CORRECT pattern — and it is the minority path.   │
└───────────────────────────────────────────────────────────────────────────┘

┌─ PATH 3 — Customer GCash (BROKEN) ───────────────────────────────────────┐
│ customer/OrderDetailPage.handlePayNow()               :328                │
│   → initiateGCashPayment()  paymongo.js:181 → POST /v1/sources [PUBLIC KEY]│
│   → registerSource()        paymongo.js:145 → Edge Fn 'register'          │
│       → ensureAttempt() → INSERT payment_attempts                         │
│   → localStorage[`pending_payment_${id}`] = sourceId                      │
│   → window.location.href = checkoutUrl                                    │
│   ── customer pays in GCash app ──                                        │
│   → returns ?payment=success → pollPaymentStatus()    :185                │
│       → Edge Fn 'poll' → capturePayment() → reconcile RPC                 │
│                                                                            │
│ Depends entirely on reconcile_paymongo_payment_attempt(), which has TWO   │
│ conflicting implementations. Customer has NO UPDATE policy on orders and  │
│ therefore no fallback.                                                     │
└───────────────────────────────────────────────────────────────────────────┘

┌─ PATH 4 — PayMongo webhook (SAME FATE AS PATH 3) ────────────────────────┐
│ PayMongo → paymongo-webhook → verify HMAC → capturePayment() → reconcile  │
│ Duplicates ~120 lines of Path 3's edge function.                          │
└───────────────────────────────────────────────────────────────────────────┘
```

## A.2 Data model as built

| Table | Role today | Problem |
|---|---|---|
| `orders.amount_paid` / `remaining_balance` / `payment_status` | Sometimes authoritative, sometimes derived | **No single owner** |
| `payment_transactions` | Ledger — but only populated by admin manual paths | Incomplete; GCash payments may be absent |
| `payment_attempts` | PayMongo session state **+ smuggled order mutations** (`actual_weight`, `pickup_photos`, `promised_payment_date`) | Payment path can silently overwrite operational data |

## A.3 The three reconcile implementations

| Version | File | Behaviour |
|---|---|---|
| v1 | `20260531080000_payment_reconciliation.sql` | Overwrites `orders` directly |
| v2 | `20260621120000_partial_payment_reconciliation.sql` | Adds `payment_type`/`estimated_cost`; still overwrites `orders` |
| v3 | `20260622010000_fix_payment_reconciliation.sql` | **Inserts into `payment_transactions`**, comment: *"We do NOT overwrite amount_paid here anymore!"* |
| — | `schema.sql:1321` (claims "LIVE as of 2026-07-11") | Reverts to the **v2 overwrite** behaviour |

`schema.sql` is dated *after* v3 but contains the *pre-v3* logic. Which one is deployed cannot
be determined from the repository — it depends on what was actually executed against the
database.

---

# B. Problems with the Current Architecture

Ordered by severity.

### B-1 🔴 CRITICAL — Client-controlled payment amount

`createGCashSource()` (`paymongo.js:21`) runs **in the browser** with the PayMongo *public*
key, and the amount is a function argument supplied by client code:

```js
const balance = parseFloat(order.remaining_balance || 0);   // OrderDetailPage.jsx:330
const { sourceId, checkoutUrl } = await initiateGCashPayment(balance, ...);
await registerSource(sourceId, balance, { orderId: order.id });
```

The edge function accepts `amount` from the request body and stores it verbatim
(`ensureAttempt`, `paymongo-create-payment/index.ts:66-81`). It validates only
`amount > 0` — never that the amount matches the order.

Under reconcile **v1/v2**, `payment_type='full'` forces `final_payment_status := 'paid'` and
`remaining := 0` **regardless of the amount paid**. A customer who edits the request to pay
₱1 on a ₱5,000 order is marked fully paid.

Under **v3** the ledger records ₱1 and the trigger computes the balance correctly, so the
financial damage is contained — but the order is still driven into a paid-ish state and the
attempt is marked `reconciled`.

> This must be fixed regardless of which redesign is approved. Amount must be computed
> server-side from the order, never accepted from the client.

### B-2 🔴 CRITICAL — Two conflicting reconcile implementations

Described in A.3. Whichever is live, the customer flow has a distinct failure:

- **If v3 is live:** `ON CONFLICT (transaction_reference) DO NOTHING` targets a **partial**
  unique index (`WHERE transaction_reference IS NOT NULL`, same migration, line 2).
  PostgreSQL cannot infer a partial index without a matching predicate → error `42P10:
  there is no unique or exclusion constraint matching the ON CONFLICT specification` →
  the whole function aborts → order never updated.
- **If v1/v2 is live:** `amount_paid` is set to *this* payment's amount, not the cumulative
  total. `guard_order_update` then fires (because `amount_paid` changed) and recomputes
  `remaining_balance = shipping_cost − amount_paid`, resurrecting a balance the customer just
  paid — while leaving `payment_status = 'paid'`. The UI reads `remaining_balance`
  (`OrderDetailPage.jsx:606, 635, 657`) and shows "Pay Now" again.

### B-3 🔴 CRITICAL — No single source of truth

Four owners of the same three numbers:

| Writer | Location | Writes |
|---|---|---|
| Client JS | `PickupModal.jsx:195-212` | `payment_status`, `amount_paid`, `remaining_balance` |
| Client JS | `database.js:348-360` (`updateOrder`) | recomputes and overrides all three |
| DB trigger | `guard_order_update` | recomputes `shipping_cost`, `remaining_balance` (**not** `payment_status`) |
| DB trigger | `update_order_payment_totals` | recomputes all three from the ledger |

These run in unpredictable combinations. `guard_order_update` recomputing `remaining_balance`
without `payment_status` is the specific mechanism that produces
`payment_status='paid' AND remaining_balance>0`.

### B-4 🟠 HIGH — Ledger is incomplete, so it cannot be trusted as truth

Customer GCash payments produce no `payment_transactions` row under v1/v2. Therefore:

- `getPaymentTransactions()` — the payment history UI — shows nothing for those payments.
- Any later admin ledger write makes `update_order_payment_totals` recompute
  `amount_paid = SUM(payment_transactions)`, **silently erasing** the customer's GCash payment.

### B-5 🟠 HIGH — Payment path mutates operational shipment data

`payment_attempts` carries `actual_weight`, `pickup_photos`, `promised_payment_date`, and the
reconcile RPC writes them into `orders`. A payment event can overwrite proof-of-pickup photos
and the recorded cargo weight. Payment and operations are different concerns and must not
share a write path.

### B-6 🟠 HIGH — `status = 'Picked Up'` set by a payment event

Reconcile v1/v2 sets `status := 'Picked Up'` unconditionally. A customer paying a `Pending`
order — never collected, no proof photos — moves it to `Picked Up`. A financial event is
driving the logistics state machine.

### B-7 🟡 MEDIUM — Confirmation depends on `localStorage` on the paying device

`OrderDetailPage.jsx:184` reads `localStorage[pending_payment_${id}]`. In the admin QR flow
(`PickupModal.jsx:400`) the *customer scans with their own phone* — that key exists on no
device that will ever poll. Only the webhook can reconcile, and if it is not configured or
is missed, the payment is lost silently. There is no sweeper, no retry, no alert.

### B-8 🟡 MEDIUM — Admin PayMongo path deliberately writes "unpaid"

`PickupModal.jsx:201-203`:

```js
if (form.payment_method === 'gcash' && paymentStep === 'waiting' && !form.payment_reference) {
  finalAmountPaid = 0;
  paymentStatus = 'unpaid';
}
```

The admin's PayMongo QR flow saves the order as **unpaid** and skips the ledger insert, then
depends on the same broken reconciliation. **Admin PayMongo fails exactly like customer
PayMongo.** The real dividing line is *manual assertion vs. PayMongo reconciliation*, not
admin vs. customer.

### B-9 🟡 MEDIUM — Duplicated reconciliation logic across two Edge Functions

`paymongo-create-payment` and `paymongo-webhook` each contain their own `capturePayment()`,
`reconcile()`, and "not chargeable" self-heal block — ~120 near-identical lines that have
already drifted (the webhook uses `attempt.amount`; the create-payment poll uses
`sourceAmount || attempt.amount`).

### B-10 🟢 LOW — Dead and confused code

- `createPaymentAttempt()` (`database.js:1051`) is **never called**. It is also the only place
  `payment_type` / `estimated_cost` would be set, so every attempt is created by
  `ensureAttempt` with `payment_type='full'`, `estimated_cost=null` — **customer pay-later can
  never work**. If it *were* called it would fail RLS (`payment_attempts` is admin-only).
- `AdditionalPaymentModal.jsx:131-146` contains an unresolved developer monologue in comments
  (*"If we insert into payment_transactions with status 'paid', it's wrong!"*) — direct
  evidence that ownership of the write was never settled.
- Three near-identical GCash QR blocks in `PickupModal`, `DeliveryModal`,
  `AdditionalPaymentModal`.
- `orders.payment_preference` (added 2026-08-02) is collected at booking
  (`BookShipmentPage.jsx:759`) and never read anywhere.

---

# C. Recommended Architecture

## C.1 Governing principles

1. **The ledger is the only truth.** `payment_transactions` is an append-only record of money
   movement. `orders.amount_paid`, `remaining_balance`, `payment_status` are *derived
   projections*, maintained by exactly one trigger, writable by nothing else.
2. **One reconciliation function.** Every confirmation route — webhook, client poll, scheduled
   sweeper, admin manual verification — calls the same RPC. No route has its own logic.
3. **Payment never mutates shipment state.** No payment path writes `status`, `actual_weight`,
   or `pickup_photos`.
4. **The server owns the amount.** The client requests *"pay order X"*, never *"pay ₱N"*.
5. **Role-neutral flow.** Admin and customer initiate the *same* checkout. The only difference
   is presentation (QR on the admin's screen vs. redirect on the customer's) and who is
   recorded as initiator.
6. **Cash is a payment too.** A cash collection is a ledger entry with `provider='manual'`.
   It follows the same path, minus the PayMongo hop.

## C.2 Target flow — one path for everything

```
                    ┌────────────────────────────────────────┐
                    │  WHO INITIATES (presentation only)     │
                    │  • Customer  → "Pay Now"  (redirect)   │
                    │  • Admin     → "Charge"   (QR / link)  │
                    └──────────────────┬─────────────────────┘
                                       ▼
              ┌────────────────────────────────────────────────┐
              │  Edge Fn: payments-create-intent               │
              │  • authn: JWT; authz: order owner OR admin     │
              │  • amount = SERVER-COMPUTED from order         │
              │      (remaining_balance, or requested          │
              │       downpayment clamped to that)             │
              │  • guard: order must be in the payable window  │
              │  • creates PayMongo source with SECRET key     │
              │  • INSERT payment_intents (status='pending')   │
              │  • returns { checkoutUrl, intentId }           │
              └──────────────────┬─────────────────────────────┘
                                 ▼
                     customer authorises in GCash
                                 ▼
     ┌───────────────┬───────────────────┬───────────────────────┐
     │  WEBHOOK      │  CLIENT POLL      │  SWEEPER (cron, 5 min)│
     │  (authority)  │  (latency only)   │  (safety net)         │
     └───────┬───────┴─────────┬─────────┴───────────┬───────────┘
             └─────────────────┼─────────────────────┘
                               ▼
              ┌────────────────────────────────────────────────┐
              │  RPC: settle_payment_intent(intent_id, ...)     │
              │  ★ THE ONLY RECONCILIATION POINT ★              │
              │  • SELECT … FOR UPDATE on the intent            │
              │  • idempotent: already settled → return early   │
              │  • INSERT payment_transactions (the ONLY write) │
              │  • mark intent settled                          │
              │  • touches NOTHING else on orders               │
              └──────────────────┬─────────────────────────────┘
                                 ▼
              ┌────────────────────────────────────────────────┐
              │  TRIGGER: sync_order_payment_totals            │
              │  amount_paid       = Σ ledger                  │
              │  remaining_balance = shipping_cost − Σ ledger  │
              │  payment_status    = derived                   │
              │  (the ONLY writer of these three columns)      │
              └────────────────────────────────────────────────┘
```

Manual cash / manual GCash reference takes the identical last two steps — an admin action
inserts a ledger row through one RPC, and the same trigger derives the totals. There is no
second mechanism anywhere.

---

## C.3 Business workflow — when does payment open?

### Verdict on your proposal: **correct, and for the right reason. Two refinements needed.**

Your reasoning is sound and is confirmed by the code. `prepare_order_insert` computes
`shipping_cost = package_weight × price` from the **customer's own estimate**. The real figure
only exists once an admin records `actual_weight` in `PickupModal`, after which
`guard_order_update` recomputes `shipping_cost`. Charging before that means charging an
estimate, which creates over-collection and a refund obligation — and PayMongo refunds are a
manual, fee-bearing process. Blocking payment before pickup is correct.

Two refinements:

**Refinement 1 — Gate on the actual fact, not the status label.**

`status = 'Picked Up'` is a *proxy* for "the weight has been verified". Nothing in the database
enforces that link — an admin (or a buggy payment path, see B-6) can set `Picked Up` with
`actual_weight IS NULL`. The true gate is:

```
payable  ⟺  actual_weight IS NOT NULL           (final cost is locked)
            AND status ∈ payable-status-set
            AND remaining_balance > 0
```

Add a DB constraint: `status = 'Picked Up'` requires `actual_weight IS NOT NULL`. Then the
status becomes a trustworthy proxy rather than a hopeful one.

**Refinement 2 — Payment must stay open after pickup, not just at pickup.**

Your proposal states the window *opens* at Picked Up. It must then remain open through the
rest of the journey, because that is exactly where Pay Later balances get settled.

### Recommended per-status matrix

| Status | Final cost known? | Customer online payment | Admin record payment | Rationale |
|---|---|---|---|---|
| `Pending Review` | ✗ estimate | **Closed** | Closed | Out-of-coverage review; may be rejected |
| `Pending` | ✗ estimate | **Closed** | Closed | No trip, no weight |
| `Assigned` | ✗ estimate | **Closed** ✅ *your call* | Closed | Weight unknown — **this is the fix for the current bug where customers can pay an estimate** |
| `Picked Up` | ✓ **locked** | **OPEN** ✅ *your call* | Open | Weight recorded, cost final |
| `In Transit` | ✓ | **Open** | Open | Pay Later settlement window |
| `Arrived at Hub` | ✓ | **Open** | Open | Receiver may pay before release |
| `Out for Delivery` | ✓ | **Open** | Open | Typical COD moment |
| `Delivered` | ✓ | **Open if balance > 0** | Open | Becomes a receivable; flag as overdue past `promised_payment_date` |
| `Cancelled` | — | **Closed** | Refund only | Collected money becomes a refund obligation |

**Logistics note.** In a door-to-door model the rider is physically present at pickup and at
delivery — these are the two natural collection moments, and they align exactly with the two
ends of the open window. Sender-pays settles at pickup; receiver-pays (`payer_type='receiver'`)
settles at delivery. The window design supports both without a special case.

**Should a deposit be allowed at booking?** Recommended **no** for v1. It would reintroduce
charging against an estimate and create a refund path. Revisit only if no-show bookings
become a measured business problem.

---

## C.4 PayMongo confirmation strategy

### Recommendation: **Webhook (authority) + Poll (UX) + Sweeper (safety net) + Manual (break-glass) — all converging on one RPC.**

The current system already has webhook + poll, but they are *separate implementations*, which
is the defect. Multiplicity of *triggers* is good; multiplicity of *logic* is the bug.

| Strategy | Advantages | Disadvantages | Verdict |
|---|---|---|---|
| **Webhook only** | Authoritative, signed, server-to-server, works when the user closes the browser | Silent single point of failure; no user-visible confirmation on return; a missed delivery is invisible; local dev needs tunnelling | ❌ Insufficient alone — B-7 is exactly this failure |
| **Webhook + polling** | Instant UX on return; covers webhook delay | Poll only works on the *paying device* (breaks the admin-QR case, B-7); adds a second code path that drifts | ⚠️ Necessary but not sufficient |
| **Webhook + manual verification** | Admin can rescue any stuck payment | Reactive — requires someone to notice; manual entry is where B-1-style errors originate | ⚠️ Needed as break-glass only |
| **★ All four, one RPC** | Webhook = authority; poll = latency; sweeper = catches everything both miss, on *any* device; manual = last resort with audit | Slightly more infrastructure (one cron) | ✅ **Recommended** |

**The sweeper is the piece that is currently missing and matters most.** A scheduled job every
5 minutes selects intents in `pending`/`processing` older than 10 minutes, queries the PayMongo
source, and calls the same `settle_payment_intent()`. It is device-independent, so it fixes the
admin-QR case that polling structurally cannot. Intents unresolved after ~24 h are flagged for
admin review rather than left silent.

**Additional hardening:**

- Move source creation **server-side** with the secret key (fixes B-1). The public key can be
  dropped from the client bundle entirely.
- Persist raw webhook events in a `payment_webhook_events` table before processing —
  auditability, and replay capability after an outage.
- Keep the HMAC verification exactly as implemented in `paymongo-webhook/index.ts:50-69` — the
  constant-time comparison and raw-body signing there are correct and should be preserved.

---

## C.5 Payment scenarios

The central simplification: **"full payment" and "downpayment" are not types — they are
amounts.** Encoding them as a type (`payment_attempts.payment_type`) is what forces the
reconcile function to branch, and that branch is where the bugs live. Delete the concept.

### A. Full payment

```
amount = order.remaining_balance   (server-computed at intent creation)
→ ledger row  (amount = full balance)
→ trigger: remaining = 0 → payment_status = 'paid'
```
No special case. No `payment_type`. No forced `remaining := 0`.

### B. Downpayment via GCash

```
amount = requested, server-clamped to (0, remaining_balance]
→ ledger row  (partial amount)
→ trigger: remaining > 0 → payment_status = 'partial'
```
Identical code path to (A). The only difference is the number.

### C. Pay Later

Pay Later is an **order-level arrangement**, not a payment type. It is a promise, and a promise
is not money:

```
orders.payment_terms         = 'immediate' | 'deferred'
orders.promised_payment_date = DATE
```

Lifecycle:

1. **At pickup** — admin sets `payment_terms='deferred'` + `promised_payment_date`. Optionally
   the customer pays a downpayment → **one ledger row** → status `partial`.
2. **In transit** — customer may pay any amount online at any time → **ledger rows** → the
   trigger keeps `remaining_balance` correct automatically.
3. **At delivery** — admin collects the remainder in cash → `record_manual_payment()` RPC →
   **one ledger row** → trigger flips `payment_status` to `paid`.
4. **Overdue** — a view flags `promised_payment_date < today AND remaining_balance > 0`.
   No trigger needed; it is a query.

The ledger stays accurate by construction, because every one of those steps is the same
operation: *append a row*. Nothing recomputes, nothing overwrites, nothing races.

---

## C.6 `payment_transactions` — recommended design

**Q: Should every payment create a ledger entry?**
**A: Yes — without exception.** Cash, manual GCash reference, PayMongo online, adjustments,
refunds. If money moved, there is a row. A payment with no row does not exist.

**Q: Should `orders` ever directly update `amount_paid`?**
**A: Never.** Not by a client, not by an RPC, not by an Edge Function, not by an admin. One
trigger owns those three columns.

**Q: Should totals always be computed from `payment_transactions`?**
**A: Yes.** `orders.amount_paid` / `remaining_balance` / `payment_status` become a *cached
projection* for query performance and RLS simplicity, never an input.

### Enforcement mechanism

A guard trigger rejects any direct write to the derived columns. `pg_trigger_depth() = 0`
identifies a direct client/RPC statement; the sync trigger runs at depth > 0 and is therefore
permitted. This makes the invariant structural rather than conventional — the same technique
already used successfully by `guard_profile_write`.

### Immutability

**Never `DELETE` from the ledger.** To correct an error, insert a compensating negative-amount
row (`entry_type='reversal'`) referencing the original. Benefits: full audit trail, the
`AFTER DELETE` trigger branch disappears, and the design becomes defensible in the thesis as
double-entry-inspired.

### Recommended ledger shape

| Column | Purpose |
|---|---|
| `id` | PK |
| `order_id` | FK → orders |
| `amount` | Signed numeric; negative = reversal |
| `entry_type` | `payment` \| `reversal` \| `adjustment` |
| `payment_method` | `cash` \| `gcash` |
| `provider` | `paymongo` \| `manual` |
| `provider_payment_id` | PayMongo payment id (null for manual) |
| `idempotency_key` | **UNIQUE NOT NULL** — the real duplicate guard |
| `intent_id` | FK → payment_intents (null for manual) |
| `recorded_by` / `recorded_by_name` | Actor attribution |
| `reverses_id` | FK → self, for reversals |
| `payment_date`, `receipt_url`, `notes` | Existing fields, retained |
| `created_at` | Immutable |

`idempotency_key` **NOT NULL + UNIQUE** replaces the current partial index on
`transaction_reference` — which is precisely the index that breaks `ON CONFLICT` inference in
reconcile v3 (B-2). A total unique index over a NOT NULL column supports `ON CONFLICT`
inference correctly.

---

## C.7 `payment_attempts` — necessary, but must be redesigned

**Verdict: KEEP the concept, RENAME to `payment_intents`, STRIP the leaked fields.**

It is necessary. A PayMongo webhook arrives carrying only `source_id`. Without a persisted
mapping there is no way to answer *"which order is this ₱850 for?"*. It is also the
idempotency anchor and the audit record of "someone tried to pay".

But the current table conflates three concerns:

| Current column | Verdict | Reason |
|---|---|---|
| `source_id`, `payment_id`, `amount`, `status`, `order_id` | **Keep** | Genuine checkout-session state |
| `actual_weight`, `pickup_photos` | **Remove** | Shipment data smuggled through the payment path (B-5) |
| `promised_payment_date` | **Move to `orders`** | It is a term of the order, not of a payment |
| `payment_type` (`full`/`paylater`) | **Remove** | The root of the reconcile branch; amount is sufficient (C.5) |
| `estimated_cost` | **Remove** | Snapshot of `orders.shipping_cost`; always stale, always `null` in practice (B-10) |
| `payer_type` | **Move to `orders`** | An order attribute |

Redesigned `payment_intents`:

```
id, order_id, amount, currency, provider, provider_source_id, provider_payment_id,
status ('pending' → 'processing' → 'settled' | 'failed' | 'expired'),
initiated_by, initiated_role, checkout_url, expires_at,
last_error, settled_at, created_at, updated_at
```

An intent is a *request to pay*. A transaction is *money that moved*. Keeping them distinct is
what makes the system auditable: you can see abandoned checkouts without them polluting the
ledger.

---

# D. Recommended Database Changes

Presented as intent. No SQL is being executed.

### D-1 New / restructured objects

| Object | Action |
|---|---|
| `payment_intents` | New table (replaces `payment_attempts`; data migrated) |
| `payment_transactions` | Add `entry_type`, `provider`, `provider_payment_id`, `idempotency_key`, `intent_id`, `recorded_by`, `reverses_id`. Backfill `idempotency_key` for existing rows |
| `orders` | Add `payment_terms`, `weight_verified_at`. Keep `promised_payment_date`, `payer_type`. Drop unused `payment_preference` |
| `payment_webhook_events` | New — raw signed events for audit and replay |

### D-2 Functions

| Function | Action |
|---|---|
| `reconcile_paymongo_payment_attempt()` | **DROP all three versions** |
| `settle_payment_intent()` | **NEW** — the single reconciliation point |
| `record_manual_payment()` | **NEW** — admin cash / manual GCash, same ledger |
| `reverse_payment()` | **NEW** — compensating entry, admin-only, audited |
| `create_payment_intent()` | **NEW** — server-side amount computation + payability guard |
| `is_order_payable()` | **NEW** — one implementation of the C.3 matrix, used by DB, API and UI |

### D-3 Triggers

| Trigger | Action |
|---|---|
| `update_order_payment_totals` | **Rewrite** as `sync_order_payment_totals` — sole writer of the three derived columns; handles signed amounts; no DELETE branch |
| `guard_order_update` | **Modify** — must stop writing `remaining_balance` (B-3). Keep `shipping_cost` recomputation, but have a weight change re-invoke the ledger projection |
| `guard_order_payment_columns` | **NEW** — rejects direct writes to derived columns via `pg_trigger_depth()` |
| `enforce_pickup_requires_weight` | **NEW** — `status='Picked Up'` ⇒ `actual_weight IS NOT NULL` (C.3 Refinement 1) |

### D-4 RLS

| Table | Policy change |
|---|---|
| `payment_intents` | Customers **SELECT** own (via order ownership) — currently admin-only, which is why the customer UI cannot show its own pending payment. **No customer INSERT/UPDATE**; creation goes through the Edge Function |
| `payment_transactions` | Keep customer SELECT-own. **Remove client INSERT capability entirely** — all writes via `SECURITY DEFINER` RPC. Explicitly deny UPDATE/DELETE to everyone |
| `orders` | Unchanged. Customers still have no UPDATE — correct, and now consistent, since nobody writes payment columns directly |
| `settle_payment_intent()` | `GRANT EXECUTE TO service_role` only |
| `record_manual_payment()` / `reverse_payment()` | `authenticated`, admin check inside |

---

# E. Recommended Code Changes

### E-1 Edge Functions

| Function | Action |
|---|---|
| `_shared/paymongo.ts` | **NEW** — one module: `createSource`, `capturePayment`, `getSource`, `verifyWebhookSignature`. Eliminates B-9 |
| `payments-create-intent` | **NEW** — replaces the `register` action. Server-side amount, payability guard, secret-key source creation |
| `payments-sync` | **NEW** — replaces the `poll` action. Queries PayMongo, calls `settle_payment_intent()`. Used by both client poll and sweeper |
| `paymongo-webhook` | **Rewrite** — persist event, verify, call `settle_payment_intent()`. Target ≈80 lines (from 265) |
| `payments-sweeper` | **NEW** — scheduled; finds stale intents, calls `payments-sync` |
| `paymongo-create-payment` | **DELETE** — its three actions are replaced by the above |

### E-2 Client library

| Item | Action |
|---|---|
| `paymongo.js` | **Rewrite.** Delete `createGCashSource`, `checkPaymentStatus`, `createPayment`, `registerSource`, `initiateGCashPayment` (all client-key operations). Keep two functions: `startPayment(orderId, amount?)`, `syncPayment(intentId)` |
| `VITE_PAYMONGO_PUBLIC_KEY` | **Remove from the client bundle** |
| `database.js` — `createPaymentAttempt` | **DELETE** (dead code, B-10) |
| `database.js` — `recordPaymentTransaction` | **Replace** with an RPC call to `record_manual_payment()` |
| `database.js` — `recordAdditionalPayment` | **Simplify** — pre-fetch/re-fetch dance is unnecessary once totals are derived |
| `database.js` — `updateOrder` | **Remove lines 348-360** — the payment recalculation block (B-3) |

### E-3 React components

| Component | Action |
|---|---|
| `GCashCheckout` | **NEW shared component** — QR + link + live status. Replaces three duplicated blocks |
| `PickupModal` | **Remove all payment-status computation** (lines 195-212). Becomes: weight + photos + terms. Payment is a separate, subsequent action |
| `DeliveryModal` | Same — proof of delivery only; settlement via the shared payment action |
| `AdditionalPaymentModal` | Becomes the single `PaymentModal` used by every admin collection point. Delete the comment block at 131-146 |
| customer `OrderDetailPage` | Replace `handlePayNow` with `startPayment`. Remove `localStorage` dependence — use `intent_id` from the URL and let the sweeper backstop |
| Payment button gating | Single source: `isOrderPayable(order)` mirroring the DB function |

### E-4 Deletions summary

```
DROP FUNCTION reconcile_paymongo_payment_attempt  ×3 versions
DELETE  supabase/functions/paymongo-create-payment/
DELETE  database.js :: createPaymentAttempt
DELETE  paymongo.js :: createGCashSource, checkPaymentStatus, createPayment,
                       registerSource, initiateGCashPayment
DELETE  PickupModal payment-status computation block
DELETE  updateOrder payment recalculation block
DELETE  orders.payment_preference column (unused)
DELETE  3× duplicated GCash QR JSX blocks
```

---

# F. Recommended UI Flow

### Customer

```
Order: Assigned
  ┌──────────────────────────────────────────────┐
  │ Estimated cost   ₱1,200.00                   │
  │ ⓘ Final cost is confirmed after your cargo   │
  │   is weighed at pickup.                      │
  │ [ Pay Now ]  ← DISABLED, with reason shown   │
  └──────────────────────────────────────────────┘

Order: Picked Up
  ┌──────────────────────────────────────────────┐
  │ Actual weight    14.5 kg                     │
  │ Final cost       ₱1,160.00                   │
  │ Paid             ₱0.00                       │
  │ Balance          ₱1,160.00                   │
  │ [ Pay Full ₱1,160.00 ]   [ Pay Partial… ]    │
  └──────────────────────────────────────────────┘
        ↓ redirect to GCash ↓ return
  ┌──────────────────────────────────────────────┐
  │ ⏳ Confirming your payment…                   │
  │ (auto-updates via Realtime; if the tab is    │
  │  closed, the sweeper still settles it)       │
  └──────────────────────────────────────────────┘
```

**Key UI principle:** a disabled payment button must always state *why*. "Available after your
cargo is weighed at pickup" prevents the support ticket that "Pay Now doesn't work".

**Use Realtime instead of polling for the UI.** `orders` is already in the
`supabase_realtime` publication. The customer's page subscribes to their order row; when the
trigger updates it, the UI reflects it instantly — no `localStorage`, no timers, and it works
even when the payment is confirmed from another device (the admin-QR case).

### Admin

```
Order detail → [ Record Payment ]
  ┌──────────────────────────────────────────────┐
  │ Balance ₱1,160.00                            │
  │ Amount  [ 1160.00 ]                          │
  │ Method  ( Cash )  ( GCash )                  │
  │                                              │
  │ Cash  → [ Record Payment ]  → ledger entry   │
  │ GCash → ( Send payment link ) ← recommended  │
  │         ( Enter reference manually ) ← audited│
  └──────────────────────────────────────────────┘
```

Pickup and payment become **two distinct actions**. "Confirm Pickup" records weight and photos.
"Record Payment" moves money. This removes the class of bug where a photo upload failure rolls
back a payment, and vice versa.

---

# G. Migration Strategy

Seven phases. Each is independently deployable and reversible. **Nothing is deleted until its
replacement is proven in production.**

### Phase 0 — Establish ground truth *(no code changes)*

```sql
-- Which reconcile version is actually deployed?
SELECT prosrc LIKE '%payment_transactions%' AS uses_ledger
FROM pg_proc WHERE proname = 'reconcile_paymongo_payment_attempt';

-- How many payments are currently stuck?
SELECT status, count(*), max(last_error)
FROM payment_attempts GROUP BY status;

-- Orders where the projection is already inconsistent
SELECT id, tracking_number, shipping_cost, amount_paid, remaining_balance, payment_status
FROM orders
WHERE (payment_status = 'paid'   AND remaining_balance > 0)
   OR (payment_status = 'unpaid' AND amount_paid > 0)
   OR (amount_paid <> COALESCE((SELECT SUM(amount) FROM payment_transactions t
                                WHERE t.order_id = orders.id), 0));
```

**Gate:** do not proceed until the size of the existing inconsistency is known. It determines
the reconciliation workload in Phase 2.

### Phase 1 — Stop the bleeding *(security only, ~1 day)*

Fix **B-1** immediately and independently of the redesign: server-side amount validation in the
existing edge function — reject any request where `amount ≠ order.remaining_balance` (within
tolerance). This closes the underpayment hole without touching the architecture.

### Phase 2 — Ledger backfill *(data, no behaviour change)*

Add the new ledger columns (nullable). Backfill `idempotency_key`. For every order where
`amount_paid` exceeds the ledger sum, insert a reconciling `entry_type='adjustment'` row
annotated as a migration artefact, so historical orders reconcile without altering their
displayed totals. **Verify: for every order, `amount_paid = SUM(ledger)`.**

### Phase 3 — Single projection *(behaviour change, reversible)*

Deploy `sync_order_payment_totals`, the guard trigger, and the modified `guard_order_update`.
Remove the client-side computation blocks. At this point the *displayed* numbers are correct
even though the payment *flow* is unchanged.

**Verify:** the Phase 0 inconsistency query must return zero rows and stay at zero.

### Phase 4 — Unified reconciliation *(the core change)*

Create `payment_intents` and `settle_payment_intent()`. Deploy the new Edge Functions
**alongside** the old ones. Point the webhook at the new handler. Run both paths in parallel;
the old RPC becomes a no-op wrapper that logs and delegates. Monitor for one full business
cycle.

### Phase 5 — Client cutover

Switch UI to `startPayment` / `syncPayment`. Ship the payability gate (C.3). Remove the
PayMongo public key from the bundle. Add Realtime-driven confirmation.

### Phase 6 — Sweeper and observability

Deploy the scheduled sweeper. Add an admin "Payment Exceptions" view listing intents stuck
> 1 h and any order where the projection disagrees with the ledger. This view should be
permanently zero; a non-zero value is an alert.

### Phase 7 — Deletion

Only after Phases 4-6 have been stable for a full business cycle: drop the three reconcile
versions, delete `paymongo-create-payment`, remove dead client functions, drop
`payment_attempts`.

---

# H. Risks of the Migration

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| H-1 | **Live money in flight during cutover** — a customer paying mid-deploy | 🔴 High | Medium | Deploy Phase 4 in a low-traffic window. Old and new paths coexist; both settle idempotently. Never deploy 4 and 7 together |
| H-2 | **Historical data cannot be perfectly reconstructed** — GCash payments made under v1/v2 have no ledger row, and the true amount may be unrecoverable | 🔴 High | **Certain** | Phase 2 adjustment rows preserve current totals rather than inventing history. Every adjustment is labelled and auditable. Accept that pre-migration history is approximate and document it |
| H-3 | **Webhook downtime during Phase 4** — endpoint switch loses events | 🟠 Med | Low | PayMongo retries failed webhooks. The sweeper (Phase 6) catches anything missed. Consider deploying the sweeper *before* Phase 4 as extra cover |
| H-4 | **The guard trigger rejects a legitimate write** — some unexamined code path writes payment columns | 🟠 Med | Medium | Ship the guard in log-only mode first (raise `WARNING`, not `EXCEPTION`) for one cycle; promote to hard rejection after the logs are clean |
| H-5 | **Payability gate blocks a real business case** — e.g. a regular client who pre-pays by arrangement | 🟠 Med | Medium | Keep an admin override that records a manual payment on a not-yet-payable order, fully audited. The gate binds the *customer* flow; admins retain judgement |
| H-6 | **`npm test` fails** — `smoke-check.mjs` asserts `prepare_order_insert`, `guard_order_update`, and the selected-trip safeguards still exist | 🟢 Low | **Certain** | Both survive the redesign (modified, not deleted). Update the assertion list in the same commit that changes them |
| H-7 | **Reports shift** — `get_sales_summary()` reads `amount_paid`/`remaining_balance`; corrected projections will change historical figures | 🟠 Med | High | Snapshot current report output before Phase 3 and diff after. Every difference must be explainable by a Phase 0 inconsistency. **Brief stakeholders before, not after** |
| H-8 | **Thesis timing** — this touches the system's most defensible subsystem mid-documentation | 🟠 Med | — | Phases 0-3 alone fix correctness and are individually defensible. If time is short, stop after Phase 3 and document 4-7 as future work |
| H-9 | **Scope creep into shipment logic** — separating pickup from payment touches operational UI | 🟡 Low | Medium | Phases 1-4 do not change shipment flow at all. The pickup/payment split is Phase 5 and can be deferred |
| H-10 | **No staging environment observed** in the repo | 🟠 Med | — | Confirm before Phase 3 whether a separate Supabase project exists for testing. If not, creating one is a prerequisite — these changes must not be first-run in production |

---

## Open questions for you

1. **Which reconcile version is live?** Phase 0 answers it, and it changes the Phase 2 workload
   substantially. This is the single most important unknown.
2. **Is there a staging Supabase project?** (H-10) If not, that becomes a prerequisite.
3. **How many orders currently have real money mis-recorded?** Phase 0 query 3.
4. **Is the PayMongo webhook actually registered and firing in production?** If it was never
   configured, every non-returning customer payment since launch is unreconciled — which would
   change the priority order significantly.
5. **Thesis deadline?** Determines whether we target Phase 3 or Phase 7.

---

## Summary of what changes

| Concern | Before | After |
|---|---|---|
| Payment write paths | 4 inconsistent | 1 |
| Reconciliation implementations | 3 conflicting | 1 |
| Writers of `amount_paid` | 4 | 1 trigger |
| Source of truth | Ambiguous | `payment_transactions` |
| Amount authority | Client | Server |
| Admin vs customer flow | Different architectures | Identical |
| Confirmation | Webhook + device-bound poll | Webhook + poll + sweeper + manual, one RPC |
| Payment can alter shipment data | Yes | No |
| Customer recovery when reconciliation fails | None | Sweeper + admin exception queue |

---

*No code has been changed. Awaiting approval before implementation. On approval,
recommend starting with Phase 0 (read-only diagnostics) to resolve open question 1.*
