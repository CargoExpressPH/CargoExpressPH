# CargoExpress PH — Unified Payment Architecture

**Complete redesign proposal · v2**
**Status:** Design only. **No code has been modified.**
**Supersedes:** `docs/payment-architecture-redesign.md`
**Date:** 2 August 2026

---

## Contents

1. [Current Architecture Diagram](#1-current-architecture-diagram)
2. [Problems Found](#2-problems-found)
3. [Root Causes](#3-root-causes)
4. [Recommended New Architecture](#4-recommended-new-architecture)
5. [Database Changes](#5-database-changes)
6. [Flow Diagrams](#6-flow-diagrams)
7. [Migration Plan](#7-migration-plan)
8. [Risk Assessment](#8-risk-assessment)
9. [Files That Will Be Modified](#9-files-that-will-be-modified)
10. [Exact Implementation Plan](#10-exact-implementation-plan)

---

# 0. One architectural decision I need to flag first

Your brief says **"No manual bypass"** and also lists **Cash** as a payment option at Picked Up.
These are only compatible under a precise definition, so let me state it plainly:

> **A cash payment physically cannot pass through PayMongo.** A rider collecting ₱1,160 in
> banknotes at a customer's door is a real event that no payment gateway can witness.

The resolution is to separate two things the current system conflates:

| Concept | Count | Meaning |
|---|---|---|
| **Capture channel** | **2** | *How money is collected.* `paymongo` (online, gateway-verified) and `manual` (cash or offline GCash reference, admin-attested) |
| **Reconciliation pipeline** | **1** | *How a payment becomes truth.* One service → one ledger insert → one projection trigger |

So: **two ways money can arrive, one way it is ever recorded.** The bypass being eliminated is
the *reconciliation* bypass — admin code writing `payment_status` directly — not the existence
of cash. Every recommendation below enforces this.

If you intended something stricter (GCash-only, no cash at all), say so and I will revise —
but that would be a business-model change, not an architecture change.

**Everything that follows assumes this definition.**

---

# 1. Current Architecture Diagram

## 1.1 The system as built

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                          CUSTOMER UI                                          ║
║  customer/OrderDetailPage.jsx                                                 ║
║    handlePayNow()  :328                                                       ║
║    payment return handler  :160-214   (reads localStorage)                    ║
║  PaymentMethodsPage.jsx   — read-only history                                 ║
║  BookShipmentPage.jsx     — payment_preference (WRITTEN, NEVER READ)          ║
╚═══════════════╤═══════════════════════════════════════════════════════════════╝
                │
╔═══════════════╪═══════════════════════════════════════════════════════════════╗
║                          ADMIN UI                                             ║
║  PickupModal.jsx            :195-229  computes payment_status in JS ①         ║
║  DeliveryModal.jsx          :164-180  computes payment_status in JS ②         ║
║  AdditionalPaymentModal.jsx :143-155  ledger-only (the correct one) ③         ║
║  admin/OrderDetailPage.jsx  :227,250,297  three different save handlers       ║
╚═══════════════╤═══════════════════════════════════════════════════════════════╝
                │
      ┌─────────┴──────────┬──────────────────────┬────────────────────────┐
      ▼                    ▼                      ▼                        ▼
┌───────────────┐  ┌────────────────┐  ┌────────────────────┐  ┌──────────────────┐
│ paymongo.js   │  │ database.js    │  │ database.js        │  │ database.js      │
│ createGCash   │  │ updateOrder()  │  │ recordPayment      │  │ recordAdditional │
│ Source()      │  │ :275           │  │ Transaction():1477 │  │ Payment() :1504  │
│ ⚠ PUBLIC KEY  │  │ ⚠ recomputes   │  │                    │  │                  │
│ ⚠ CLIENT AMT  │  │   :348-360 ④   │  │                    │  │                  │
└───────┬───────┘  └────────┬───────┘  └─────────┬──────────┘  └────────┬─────────┘
        │                   │                    │                       │
        ▼                   │                    │                       │
┌──────────────────────┐    │                    │                       │
│ EDGE FUNCTIONS       │    │                    │                       │
│ paymongo-create-     │    │                    │                       │
│   payment (398 ln)   │    │                    │                       │
│   3 actions:         │    │                    │                       │
│   register/capture/  │    │                    │                       │
│   poll               │    │                    │                       │
│ paymongo-webhook     │    │                    │                       │
│   (265 ln)           │    │                    │                       │
│ ⚠ ~120 ln DUPLICATED │    │                    │                       │
└──────────┬───────────┘    │                    │                       │
           ▼                │                    │                       │
┌────────────────────────┐  │                    │                       │
│ RPC reconcile_paymongo │  │                    │                       │
│ _payment_attempt()     │  │                    │                       │
│ ⚠ THREE VERSIONS ⑤    │  │                    │                       │
│  v1 20260531 overwrite │  │                    │                       │
│  v2 20260621 overwrite │  │                    │                       │
│  v3 20260622 ledger    │  │                    │                       │
│  schema.sql = v2 (?)   │  │                    │                       │
└──────────┬─────────────┘  │                    │                       │
           │                │                    │                       │
           ▼                ▼                    ▼                       ▼
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              DATABASE                                         ║
║                                                                               ║
║   orders ◄──── written directly by ①②④⑤                                     ║
║     amount_paid, remaining_balance, payment_status                            ║
║        ▲                                                                      ║
║        │ ALSO written by TWO TRIGGERS that disagree:                          ║
║        ├── guard_order_update      (BEFORE UPDATE)                            ║
║        │     recomputes shipping_cost + remaining_balance                     ║
║        │     ⚠ does NOT recompute payment_status  ⑥                          ║
║        └── update_order_payment_totals (AFTER ins/upd/del on ledger)          ║
║              recomputes ALL THREE from SUM(payment_transactions)              ║
║                                                                               ║
║   payment_transactions ◄── written by ③ and (only in v3) ⑤                   ║
║     ⚠ INCOMPLETE — GCash payments missing under v1/v2                        ║
║                                                                               ║
║   payment_attempts ◄── written by Edge Fn (service role)                      ║
║     ⚠ carries actual_weight, pickup_photos → payment writes SHIPMENT data ⑦  ║
╚═══════════════════════════════════════════════════════════════════════════════╝

   ✗ NO realtime subscription on either OrderDetailPage
   ✗ NO notification on any payment event
   ✗ NO audit log for PayMongo payments (logPayment only in path ③)
```

## 1.2 Complete write-site inventory

Every location that mutates a payment field. This is the exhaustive sweep you asked for.

### `orders.payment_status`

| # | Location | Mechanism | Legitimate? |
|---|---|---|---|
| 1 | `PickupModal.jsx:222` | Client JS computes and sends | ❌ |
| 2 | `DeliveryModal.jsx:172` | Client JS sets `'paid'` | ❌ |
| 3 | `database.js:357,359,361` (`updateOrder`) | Client recomputes | ❌ |
| 4 | `database.js:193` (`createOrder`) | Sets `'unpaid'` at insert | ⚠ redundant — trigger already does it |
| 5 | `schema.sql:814` (`prepare_order_insert`) | Trigger forces `'unpaid'` | ✅ |
| 6 | `schema.sql:1235` (`update_order_payment_totals`) | Trigger derives from ledger | ✅ **the only correct one** |
| 7 | `schema.sql:1413` (reconcile v1/v2) | RPC overwrites directly | ❌ |
| 8 | Migrations ×3 (reconcile versions) | RPC overwrites | ❌ |

**8 writers. 2 legitimate.**

### `orders.amount_paid`

| # | Location | Mechanism | Legitimate? |
|---|---|---|---|
| 1 | `PickupModal.jsx:220` | Client JS | ❌ |
| 2 | `DeliveryModal.jsx:170` | Client JS | ❌ |
| 3 | `database.js:191` (`createOrder`) | Insert `0` | ⚠ redundant |
| 4 | `schema.sql:815` (`prepare_order_insert`) | Trigger forces `0` | ✅ |
| 5 | `schema.sql:1233` (`update_order_payment_totals`) | Trigger derives | ✅ |
| 6 | `schema.sql:1411` (reconcile v1/v2) | RPC overwrites — **not cumulative** | ❌ |

### `orders.remaining_balance`

| # | Location | Mechanism | Legitimate? |
|---|---|---|---|
| 1 | `PickupModal.jsx:221` | Client JS | ❌ |
| 2 | `DeliveryModal.jsx:173` | Client JS | ❌ |
| 3 | `database.js:355` (`updateOrder`) | Client recomputes | ❌ |
| 4 | `database.js:192` (`createOrder`) | Insert | ⚠ redundant |
| 5 | `schema.sql:839` (`prepare_order_insert`) | Trigger | ✅ |
| 6 | `schema.sql:882` (`guard_order_update`) | Trigger — **conflicts with #7** | ⚠ **the specific conflict** |
| 7 | `schema.sql:1234` (`update_order_payment_totals`) | Trigger derives | ✅ |
| 8 | reconcile v1/v2 `:1412` | RPC | ❌ |

### `orders.status` changed *by a payment event*

| Location | What it does |
|---|---|
| `schema.sql:1418` (reconcile v1/v2) | `status := 'Picked Up'` **unconditionally** — a payment drives the logistics state machine |
| `PickupModal.jsx:228` | `status: 'Picked Up'` bundled with payment fields in one write |
| `DeliveryModal.jsx:160` | `status: 'Delivered'` bundled with payment fields |

---

# 2. Problems Found

Twenty findings, ordered by severity. Each is traceable to a line.

## 🔴 Critical

**P-1 · Client controls the payment amount.**
`createGCashSource()` (`paymongo.js:21`) executes in the browser with the PayMongo **public
key**; the amount is a JS argument (`OrderDetailPage.jsx:330`). The Edge Function stores it
verbatim (`ensureAttempt`, `paymongo-create-payment/index.ts:66-81`), validating only
`amount > 0`, never against the order. Under reconcile v1/v2, `payment_type='full'` forces
`payment_status := 'paid'` and `remaining := 0` **regardless of amount received** — a ₱1
payment marks a ₱5,000 order fully paid.

**P-2 · Three conflicting reconcile implementations.**
v1 (`20260531080000`), v2 (`20260621120000`), v3 (`20260622010000`), plus `schema.sql:1321`
which re-states v2 while claiming to be live *after* v3 shipped. Which is deployed cannot be
determined from the repository.

**P-3 · `ON CONFLICT` cannot infer a partial index (if v3 is live).**
`20260622010000:116` uses `ON CONFLICT (transaction_reference) DO NOTHING` against an index
created at line 2 of the same file with `WHERE transaction_reference IS NOT NULL`. PostgreSQL
requires a matching predicate to infer a partial index → error **42P10** → the entire function
aborts → the order is never updated.

**P-4 · `guard_order_update` resurrects paid balances (if v1/v2 is live).**
Reconcile sets `amount_paid` to *this* payment's amount, not the cumulative total. The BEFORE
UPDATE trigger (`schema.sql:882`) then recomputes
`remaining_balance = shipping_cost − amount_paid` **without** recomputing `payment_status`,
producing `payment_status='paid' AND remaining_balance>0`. The customer UI reads
`remaining_balance` (`OrderDetailPage.jsx:606,635,657`) and shows "Pay Now" again.

**P-5 · No single source of truth.** Eight writers of `payment_status`, six of `amount_paid`,
eight of `remaining_balance` (§1.2). Two triggers disagree by design.

## 🟠 High

**P-6 · Ledger is incomplete.** Under v1/v2, customer GCash payments create no
`payment_transactions` row. Payment history shows nothing, and any later admin ledger write
makes `update_order_payment_totals` recompute `amount_paid = SUM(ledger)`, **silently erasing**
the customer's payment.

**P-7 · Payment path mutates shipment data.** `payment_attempts` carries `actual_weight` and
`pickup_photos`; reconcile writes them into `orders` (`schema.sql:1415-1416`). A payment event
can overwrite proof-of-pickup evidence.

**P-8 · Payment drives logistics status.** Reconcile sets `status := 'Picked Up'`
unconditionally (`schema.sql:1418`). A customer paying a `Pending` order — never collected,
no photos — moves it to `Picked Up`.

**P-9 · Payment and shipment share one transaction.** `PickupModal` bundles weight, photos,
*and* payment into one `updateOrder` call. A photo upload failure rolls back the payment;
a payment failure loses the weight.

**P-10 · Confirmation is device-bound.** `OrderDetailPage.jsx:184` reads
`localStorage[pending_payment_${id}]`. In the admin-QR flow (`PickupModal.jsx:400`) the customer
scans with *their own phone* — that key exists on no device that will ever poll. Only the
webhook can save it, with no sweeper and no alerting.

**P-11 · Admin PayMongo path writes "unpaid" on purpose.** `PickupModal.jsx:201-203` sets
`finalAmountPaid = 0; paymentStatus = 'unpaid'` and skips the ledger insert. **Admin PayMongo
fails identically to customer PayMongo.** The real fault line is *manual vs. PayMongo*, not
*admin vs. customer*.

**P-12 · Race: concurrent webhook + poll.** Both call reconcile. v1/v2 lock via `FOR UPDATE`
so the DB is safe, but the *Edge Functions* both call `capturePayment()` first — PayMongo
rejects the second with "not chargeable", which triggers the self-heal branch, which reconciles
with a **synthetic** `auto_{sourceId}` reference instead of the real payment id. Two different
references can therefore exist for one payment.

**P-13 · No realtime, anywhere in payments.** Neither `OrderDetailPage` subscribes to anything,
despite `orders` already being in `supabase_realtime`. Your "UI updates automatically, no
refresh" requirement is **entirely unimplemented today**.

**P-14 · No payment notifications.** `createNotification` fires for status changes
(`admin/OrderDetailPage.jsx:220,242,258,…`) but **never for a payment**. The customer is never
told their payment succeeded. Also: the `notifications.type` CHECK constraint has no `payment`
value, so this needs a schema change.

**P-15 · No audit trail for online payments.** `logPayment()` (`activityLog.js:77`) is called
only from `recordAdditionalPayment`. PayMongo payments — the ones involving a gateway and real
settlement risk — produce **no** `activity_logs` entry.

## 🟡 Medium

**P-16 · ~120 lines duplicated across two Edge Functions**, and already drifted: the webhook
uses `attempt.amount`; the poll path uses `sourceAmount || attempt.amount`.

**P-17 · No webhook event log.** `paymongo-webhook` verifies the signature then discards the
raw event. No replay protection, no duplicate-event detection, no post-outage recovery.

**P-18 · Timestamp not validated.** `verifySignature` (`paymongo-webhook/index.ts:50`) parses
`parts.t` and includes it in the signed payload but **never checks its age**. A captured
webhook body can be replayed indefinitely.

## 🟢 Low

**P-19 · Dead code.** `createPaymentAttempt()` (`database.js:1051`) is never called; it is also
the only place `payment_type`/`estimated_cost` would be set, so **customer Pay Later can never
work**. It would fail RLS anyway (`payment_attempts` is admin-only). `orders.payment_preference`
is written at booking (`BookShipmentPage.jsx:759`) and read nowhere.

**P-20 · Unresolved design debate left in comments.** `AdditionalPaymentModal.jsx:131-146` is a
developer monologue — *"If we insert into payment_transactions with status 'paid', it's
wrong!"* — direct evidence that write-ownership was never decided.

---

# 3. Root Causes

The twenty findings collapse into **five** underlying causes.

### RC-1 — No designated owner of payment state

Nobody decided whether `orders.payment_status` is *stored* or *derived*. Both models were
implemented, and both still run. Every one of P-3, P-4, P-5, P-6 is a symptom.

> A field that is sometimes authoritative and sometimes derived is *always* wrong.

### RC-2 — Reconciliation was patched, never redesigned

Three reconcile versions in 22 days, each fixing the previous one's symptom:
`payment_reconciliation` → `partial_payment_reconciliation` → `fix_payment_reconciliation`.
v3 correctly identified the fix (*"We do NOT overwrite amount_paid here anymore!"*) but
`schema.sql` was later regenerated from a database that still had v2 — so the fix was
effectively reverted by a documentation artefact. **P-2, P-3.**

### RC-3 — Trust boundary drawn in the wrong place

The client was trusted with the payment amount (public key + client-supplied value) while the
*server* was given no authority to compute it. Inverted: the server knows
`remaining_balance`, the client knows nothing worth trusting. **P-1.**

### RC-4 — Payment and shipment were never separated

`payment_attempts` carries shipment fields; reconcile sets `status`; `PickupModal` writes both
in one call. Two lifecycles — *money* and *cargo* — were modelled as one. **P-7, P-8, P-9.**

### RC-5 — Asynchronous completion treated as an edge case

The design assumes the customer returns to the app. Everything else (different device, closed
browser, missed webhook) was handled by bolting on `localStorage` polling and a self-heal
branch, rather than by making the system converge on its own. **P-10, P-12, P-17, P-18.**

---

# 4. Recommended New Architecture

## 4.1 Principles

| # | Principle | Enforced by |
|---|---|---|
| 1 | The **ledger** is the only truth | `payment_transactions`, append-only |
| 2 | `orders` payment columns are a **read-only projection** | one trigger + a guard trigger |
| 3 | **One** reconciliation service | `settle_payment()` RPC |
| 4 | The **server** computes the amount | `create_payment_intent()` Edge Function |
| 5 | Payment **never** touches shipment state | separate RPCs, separate tables |
| 6 | Two capture channels, **one** recording path | `provider ∈ {paymongo, manual}` |
| 7 | The system **converges without the user** | webhook + sweeper |
| 8 | Every payment emits **ledger + audit + notification + realtime** | inside one transaction |

## 4.2 Layer map

```
╔════════════════════════════════════════════════════════════════════════════╗
║ PRESENTATION — differs only in framing, never in logic                     ║
║   Customer: "Pay Now"  → redirect                                          ║
║   Admin:    "Charge"   → QR / copyable link                                ║
║   Admin:    "Record Cash" → attested manual entry                          ║
║   ALL call the same two client functions: startPayment / recordManual      ║
╚═════════════════════════════╤══════════════════════════════════════════════╝
                              ▼
╔════════════════════════════════════════════════════════════════════════════╗
║ API — Supabase Edge Functions (Deno)                                       ║
║                                                                            ║
║  payments-create-intent      authn JWT · authz owner|admin                 ║
║                              amount = SERVER-COMPUTED                      ║
║                              gate  = is_order_payable()                    ║
║                              creates PayMongo source with SECRET key       ║
║                                                                            ║
║  payments-webhook            verify HMAC + timestamp age                   ║
║                              persist raw event (replay protection)         ║
║                              → settle_payment()                            ║
║                                                                            ║
║  payments-sync               on-demand + sweeper; queries PayMongo         ║
║                              → settle_payment()                            ║
║                                                                            ║
║  _shared/paymongo.ts         ONE client. Zero duplication.                 ║
╚═════════════════════════════╤══════════════════════════════════════════════╝
                              ▼
╔════════════════════════════════════════════════════════════════════════════╗
║ ★ RECONCILIATION — settle_payment()  ·  THE ONLY WRITE PATH ★             ║
║                                                                            ║
║   SECURITY DEFINER · service_role only · ONE transaction:                  ║
║     1. SELECT … FOR UPDATE on the intent          (serialise)              ║
║     2. already settled?  → return early           (idempotent)             ║
║     3. INSERT payment_transactions                (the ONLY money write)   ║
║     4. UPDATE payment_intents → settled                                    ║
║     5. INSERT activity_logs                       (audit)                  ║
║     6. INSERT notifications                       (customer + admins)      ║
║                                                                            ║
║   Manual cash enters at the same point via record_manual_payment(),        ║
║   which validates admin role then calls the identical internal routine.    ║
╚═════════════════════════════╤══════════════════════════════════════════════╝
                              ▼
╔════════════════════════════════════════════════════════════════════════════╗
║ PROJECTION — sync_order_payment_totals()  ·  ONE TRIGGER                   ║
║   AFTER INSERT ON payment_transactions                                     ║
║     amount_paid       := Σ ledger (signed)                                 ║
║     remaining_balance := shipping_cost − Σ ledger                          ║
║     payment_status    := remaining ≤ 0 ? 'paid'                            ║
║                        : Σ > 0        ? 'partial' : 'unpaid'               ║
║   ⇒ payment_status='paid' is NEVER assigned; it is only ever derived.      ║
╚═════════════════════════════╤══════════════════════════════════════════════╝
                              ▼
╔════════════════════════════════════════════════════════════════════════════╗
║ DELIVERY — already-built infrastructure, currently unused for payments     ║
║   Realtime: orders is in supabase_realtime → both UIs update live          ║
║   Push:     send-push Edge Function → FCM / Web Push                       ║
╚════════════════════════════════════════════════════════════════════════════╝
```

## 4.3 Business rules — confirmation and one correction

### Payment availability by status — **your rules confirmed**

| Status | Final cost? | Customer pays online | Admin records | Note |
|---|---|---|---|---|
| `Pending Review` | ✗ | **Blocked** | Blocked | May be rejected |
| `Pending` | ✗ | **Blocked** | Blocked | No weight |
| `Assigned` | ✗ estimate | **Blocked** ✅ | Blocked | *Your rule — correct* |
| `Picked Up` | ✓ **locked** | **OPEN** ✅ | Open | *Your rule — correct* |
| `In Transit` | ✓ | Open | Open | Pay-later settlement |
| `Arrived at Hub` | ✓ | Open | Open | Receiver may pre-pay |
| `Out for Delivery` | ✓ | Open | Open | Typical COD moment |
| `Delivered` | ✓ | Open if balance > 0 | Open | Receivable; overdue flag |
| `Cancelled` | — | Blocked | Refund only | |

Your reasoning is confirmed by the code: `prepare_order_insert` computes `shipping_cost` from
`package_weight` — the *customer's estimate*. The real figure exists only after an admin records
`actual_weight`. Charging before that means charging an estimate and owning a refund
obligation through a manual, fee-bearing PayMongo process.

**Hardening:** gate on the *fact*, not the label. Nothing currently enforces that `Picked Up`
implies a recorded weight — P-8 is that gap being exploited today. Add:

```
CONSTRAINT: status = 'Picked Up' ⇒ actual_weight IS NOT NULL
is_order_payable(order) ⇔ actual_weight IS NOT NULL
                        ∧ status ∈ payable-set
                        ∧ remaining_balance > 0
```

### ⚠️ One correction: "Awaiting Remaining Balance" should **not** be an order status

You specified that Pay Later sets `status = 'Awaiting Remaining Balance'`. I recommend against
this, and the reason is the same defect we are removing.

`orders.status` is a **logistics** state machine — where the cargo physically is. It is linear
(`STATUS_FLOW`, `src/constants/status.js:19`), drives trip cascades
(`TRIP_TO_ORDER_STATUS`), and feeds public tracking. "Awaiting Remaining Balance" is a
**financial** state and is *orthogonal*: a pay-later parcel can be simultaneously awaiting
balance **and** In Transit. Putting it in `status` means:

- the cargo's physical location becomes unknowable while it is unpaid;
- `STATUS_FLOW` breaks — what is the next status after it?
- trip cascade breaks — moving the trip to `in_progress` would overwrite it;
- public tracking would expose the customer's debt to anyone with a tracking number;
- **it re-creates P-8** — payment driving logistics status — the exact bug being fixed.

**Recommended instead — two orthogonal dimensions, one UI label:**

```
orders.status         = 'In Transit'          ← where the cargo is
orders.payment_terms  = 'deferred'            ← the arrangement
orders.payment_status = 'partial'             ← derived from ledger

UI displays:  "In Transit · Awaiting Remaining Balance ₱560.00"
```

You get the exact wording you asked for, as a **derived display label**, without corrupting the
state machine. If you still prefer it as a real status after this, say so — it is your call and
I will design it that way, but you should know the cost.

### Payment scenarios

**The key simplification: "full payment" and "downpayment" are not types — they are amounts.**
Encoding them as a type (`payment_attempts.payment_type`) is what forces reconcile to branch,
and that branch is where the bugs live. Delete the concept.

**CONFIRMED REQUIREMENTS (2026-08-02):** the payer chooses the *amount* (full or partial);
**both cash and GCash support both**, because some customers cannot pay in full by either
method; and a Pay Later **downpayment is optional — ₱0 is valid**, since some customers only
commit to a promised date.

### The model

```
payment_method ∈ {cash, gcash}          ← 2 methods, per PAYMENT (not per order)
amount         ∈ (0, remaining_balance] ← payer's choice; "Full" is a prefill shortcut
promised_payment_date  DATE NULL        ← presence of a date = the Pay Later arrangement
```

| Method \ Amount | Partial | Full |
|---|---|---|
| **Cash** | ✅ ledger row, `partial` | ✅ ledger row, `paid` |
| **GCash** | ✅ PayMongo intent, `partial` | ✅ PayMongo intent, `paid` |

A single order may mix methods freely — ₱600 GCash downpayment then ₱560 cash on delivery is
two ledger rows, each carrying its own `payment_method`. No special case.

| Scenario | Mechanism |
|---|---|
| **Full payment** | `amount = remaining_balance` → ledger row → trigger → `paid` |
| **Partial payment** | `amount = requested`, server-clamped to `(0, remaining_balance]` → ledger row → trigger → `partial` |
| **Remaining balance** | identical operation, later, any method → trigger → `paid` |
| **Pay Later, ₱0 down** | set `promised_payment_date` only. **No ledger row, no PayMongo intent** — a promise is not money ✅ |
| **Pay Later, with down** | `promised_payment_date` + one ledger row of any amount/method |
| **Cash (any amount)** | `record_manual_payment()` → ledger row → same trigger |

### `payment_terms` is not needed — derive it

An optional (₱0) downpayment means "Pay Later" reduces to *an order with a remaining balance
and a promised date*. `promised_payment_date IS NOT NULL` states that unambiguously.

| State | `remaining_balance` | `promised_payment_date` | UI label |
|---|---|---|---|
| Paid | 0 | — | Paid |
| Partial, no commitment | > 0 | NULL | Balance Due |
| Pay Later, ₱0 down | = full | set | Awaiting Payment · due *date* |
| Pay Later, partial down | > 0 | set | Awaiting Remaining Balance · due *date* |
| Overdue | > 0 | < today | **Overdue** |

Storing `payment_terms` as well would create two columns that must agree — the exact defect
class this redesign removes. **Decision: do not add `payment_terms`.**

All five are the same operation: **append one row**. `payment_status='paid'` is never assigned
by anyone — it emerges when `remaining_balance` reaches 0. ✅ *your rule, enforced structurally.*

## 4.4 PayMongo confirmation strategy

**Webhook (authority) + Sync (latency) + Sweeper (convergence) + Manual (break-glass) — all
calling `settle_payment()`.** Multiple *triggers* are correct; multiple *implementations* are
the bug.

| Route | Role | Why it exists |
|---|---|---|
| **Webhook** | Authority | Signed, server-to-server, works when the browser is closed |
| **Sync** | Latency | Customer returns and wants instant confirmation. Not a separate path — same RPC |
| **Sweeper** (cron, 5 min) | Convergence | **The missing piece.** Device-independent, so it fixes the admin-QR case (P-10) that polling structurally cannot |
| **Manual verify** | Break-glass | Admin rescues a stuck payment; fully audited |

### Webhook robustness — your checklist

| Requirement | Current | Recommended |
|---|---|---|
| Signature verification | ✅ HMAC-SHA256, constant-time (`index.ts:50-69`) — **keep as-is** | Keep |
| **Replay protection** | ❌ timestamp parsed, never checked | Reject if `\|now − t\| > 300s` |
| **Duplicate events** | ❌ no event log | `payment_webhook_events(provider_event_id UNIQUE)` |
| **Idempotency** | ⚠ partial, breaks on partial index (P-3) | `idempotency_key UNIQUE NOT NULL` on the ledger |
| Timeout handling | ⚠ unbounded PayMongo fetch | 10 s `AbortController`; return 200 + queue |
| Retry handling | ⚠ 500 on error → PayMongo retries | 200 for *recorded* events, 5xx only for transient failures |
| Network failure | ⚠ self-heal branch | Sweeper reconciles independently |
| Duplicate payments | ⚠ ref-mismatch check only | Unique `provider_payment_id` |
| Cancelled / expired | ❌ unhandled | Handle `source.expired`, `payment.failed` → mark intent, notify |
| Pending | ⚠ returns generic status | Explicit `pending` state, sweeper continues |

## 4.5 Security

| Control | Current | Recommended |
|---|---|---|
| PayMongo public key in bundle | ⚠ client creates sources | **Remove entirely** — server-side only |
| Amount authority | ❌ client | **Server**, from `remaining_balance` |
| Service-role key | ✅ Edge secrets only | Unchanged |
| Webhook auth | ✅ HMAC | + timestamp age + event-id uniqueness |
| Customer → `payment_status` | ✅ no UPDATE policy on `orders` | Unchanged + guard trigger makes it structural |
| Customer → `payment_transactions` | ⚠ SELECT-own only, but admin can INSERT client-side | **Nobody** inserts client-side; RPC only |
| Customer → `payment_intents` | ❌ admin-only (can't see own payment) | SELECT-own via order ownership; no INSERT/UPDATE |
| `settle_payment()` | — | `service_role` only |

## 4.6 UX

Your seven requirements, mapped:

| Requirement | Delivered by |
|---|---|
| Current shipping cost | Cost card; shows "Estimated" before pickup, "Final" after |
| Amount paid | Projection column, always ledger-consistent |
| Remaining balance | Projection column |
| Payment status | Badge + plain-language line |
| Payment history | `payment_transactions` list — **now complete**, incl. GCash |
| Payment receipt | Per-transaction receipt via existing `html2pdf.js` |
| Next required action | Single directive sentence, always present |

```
── Assigned ────────────────────────────────────
  Estimated cost      ₱1,200.00
  ⓘ Payment will become available after your cargo
    has been picked up and weighed.
  [ Pay Now ]  ← disabled, reason always shown

── Picked Up ───────────────────────────────────
  Actual weight       14.5 kg
  Final cost          ₱1,160.00
  Paid                ₱0.00
  Balance             ₱1,160.00
  → Next: settle your balance
  [ Pay with GCash ]  [ Pay Later ]

── Partial (deferred) ──────────────────────────
  In Transit · Awaiting Remaining Balance
  Final cost  ₱1,160.00   Paid ₱600.00
  Balance     ₱560.00     Due  15 Aug 2026
  [ Pay Balance ₱560.00 ]
  History:  600.00  GCash   2 Aug  ✓ receipt

── Confirming ──────────────────────────────────
  ⏳ Confirming your payment…
  Updates automatically — you can close this page.
```

### Admin collection screen — flexible amount (CONFIRMED 2026-08-02)

The amount must be **freely editable by the admin**, not locked to the full balance. Real
scenario: balance ₱500, but admin and customer agree the customer only has ₱250 today.

```
── Record Payment ──────────────────────────────
  Balance             ₱500.00
  Amount to collect   [ 250.00 ]        ← editable, defaults to full balance
                      [ Full ₱500.00 ]  ← shortcut button, NOT a lock
  Method              ( Cash )  ( GCash )
  Promised date       [ 15 Aug 2026 ]   ← for the remainder
                      [ Pay Now ]
        ↓
  ₱250 collected → one ledger row → trigger derives:
     remaining_balance ₱250 · payment_status 'partial'
  UI: "Awaiting Remaining Balance ₱250.00 · due 15 Aug 2026"
```

**Removes existing rigidity:**

| Path | Today | After |
|---|---|---|
| Customer Pay Now | Full balance only, no amount field (`OrderDetailPage.jsx:330`) | Editable amount |
| Admin pickup GCash | Custom amount requires flipping the order into "Pay Later" mode (`PickupModal.jsx:54`) | Editable amount, no mode toggle |
| Admin additional payment | Already partial-capable (`AdditionalPaymentModal.jsx:102`) | Unchanged — becomes the pattern for all three |

**Validation:** client shows `0 < amount ≤ remaining_balance`; the server independently
recomputes `amount := LEAST(requested, remaining_balance)` and rejects `≤ 0` (P-1). Flexible
for the operator, never trusted from the browser.

**A disabled button must always state why.** Realtime replaces polling: the page subscribes to
its order row, so confirmation appears even when payment completes on another device.

---

# 5. Database Changes

## 5.1 Table-by-table verdict

| Table | Verdict | Reasoning |
|---|---|---|
| `orders` | **Keep, restructure** | Core entity. Payment columns become derived-only |
| `payment_transactions` | **Keep, promote to source of truth** | Already the right shape; must become complete and immutable |
| `payment_attempts` | **Replace** → `payment_intents` | Concept necessary (webhooks carry only `source_id`); current columns leak shipment data |
| `activity_logs` | **Keep as-is** | Correct design. Note: your brief says `audit_logs`; the actual table is `activity_logs`. Only change: payments must actually write to it (P-15) |
| `notifications` | **Keep, extend enum** | Add `'payment'` to the `type` CHECK (P-14) |
| `payment_webhook_events` | **New** | Replay + duplicate protection, post-outage replay |

**Merge candidates: none.** `payment_intents` and `payment_transactions` look similar but are
categorically different — an *intent* is a request to pay (may be abandoned), a *transaction* is
money that moved (never abandoned). Merging them would put abandoned checkouts in the ledger.

## 5.2 Column changes

**`orders`**

| Column | Action |
|---|---|
| `amount_paid`, `remaining_balance`, `payment_status` | **Keep — become read-only projections.** Guard trigger rejects direct writes |
| `weight_verified_at` | **ADD** — timestamp; the payability gate |
| `promised_payment_date` | **KEEP** — this alone encodes the Pay Later arrangement (§4.3). No `payment_terms` column |
| `payment_method` | **DROP from `orders`** — mixed-method orders are now an explicit requirement, so a single order-level method is unrepresentable. Method lives on each ledger row. Expose `payment_methods_used TEXT[]` as a derived summary if the UI needs it |
| `payment_preference` | **DROP** — written, never read (P-19) |
| `payment_reference`, `payment_date`, `receipt_url` | **DROP from `orders`** — per-payment facts that belong on ledger rows. Currently only the *last* payment's values survive |

> **P-21 🟠 NEW — `get_sales_summary()` misreports the cash/GCash split.**
> `schema.sql:1046-1048` computes `cashTotal` / `gcashTotal` as
> `SUM(orders.amount_paid) FILTER (WHERE orders.payment_method = …)`, attributing an order's
> *entire* collected amount to its single order-level method. Already wrong whenever the method
> changes between pickup and delivery; **structurally wrong** once mixed-method payments are
> supported. Must be rewritten to aggregate `payment_transactions` by each row's own
> `payment_method`. Add to Phase 6.

**`payment_transactions`**

| Column | Action |
|---|---|
| `entry_type` | **ADD** — `'payment' \| 'reversal' \| 'adjustment'` |
| `provider` | **ADD** — `'paymongo' \| 'manual'` |
| `provider_payment_id` | **ADD** — UNIQUE, nullable |
| `idempotency_key` | **ADD** — **UNIQUE NOT NULL**. Total index over NOT NULL supports `ON CONFLICT` inference correctly, fixing P-3 at the root |
| `intent_id` | **ADD** — FK → `payment_intents` |
| `reverses_id` | **ADD** — self-FK for reversals |
| `recorded_by` / `recorded_by_name` | **RENAME** from `admin_id`/`admin_name` — payments now originate from customers too |
| `amount` | **Allow negative** for reversals; drop any positive-only assumption |
| `transaction_reference` | **Keep** for human-entered GCash refs; **drop the partial unique index** (superseded) |
| `payment_status` | **DROP** — a ledger row does not have a status; it either exists or does not |

**`payment_intents`** (new, replaces `payment_attempts`)

```
id · order_id · amount · currency · provider · provider_source_id (UNIQUE)
provider_payment_id (UNIQUE) · status ('pending'→'processing'→'settled'|'failed'|'expired')
checkout_url · initiated_by · initiated_role · expires_at
last_error · settled_at · created_at · updated_at
```

**Dropped from the old table:** `actual_weight`, `pickup_photos` (P-7 — shipment data),
`promised_payment_date`, `payer_type` (move to `orders`), `payment_type`, `estimated_cost`
(P-19 — always null, never worked).

## 5.3 Triggers vs RPCs — the explicit decision you asked for

**Rule: RPCs for actions, triggers for invariants.**

| Concern | Mechanism | Why |
|---|---|---|
| Recording a payment | **RPC** (`settle_payment`) | An action with authorisation, validation, side effects |
| Deriving order totals | **TRIGGER** (`sync_order_payment_totals`) | An invariant that must hold no matter who writes |
| Blocking direct writes | **TRIGGER** (`guard_order_payment_columns`) | An invariant |
| Weight ⇒ Picked Up | **TRIGGER** | An invariant |
| Creating an intent | **Edge Function** | Needs an external HTTP call |

**Why a trigger for the projection, not the RPC:** if the RPC owned it, any future code path
that inserts a ledger row would silently skip the projection. The trigger makes the invariant
hold unconditionally — including during data migration and manual DBA repair.

**Final trigger inventory on payment tables:**

| Trigger | Status |
|---|---|
| `update_order_payment_totals` | **REPLACE** → `sync_order_payment_totals` (signed amounts, no DELETE branch) |
| `guard_order_update` | **MODIFY** — must stop writing `remaining_balance` (P-4). Keeps `shipping_cost`; a weight change re-invokes the projection |
| `prepare_order_insert` | **KEEP** — correct |
| `guard_order_payment_columns` | **NEW** — rejects direct writes via `pg_trigger_depth() = 0` |
| `enforce_pickup_requires_weight` | **NEW** |

Net: **5 triggers, each with exactly one job, none overlapping.**

## 5.4 Functions to drop

```
DROP FUNCTION reconcile_paymongo_payment_attempt(TEXT,TEXT,DECIMAL,TEXT)   -- all 3 versions
DROP TABLE    payment_attempts                                              -- after migration
```

New: `settle_payment()`, `record_manual_payment()`, `reverse_payment()`,
`is_order_payable()`, `compute_order_payment_totals()`.

---

# 6. Flow Diagrams

## 6.1 GCash — the canonical path (identical for customer and admin)

```
CUSTOMER UI                                    ADMIN UI
[ Pay with GCash ]                             [ Charge via GCash ]
      │                                              │
      └──────────────────┬───────────────────────────┘
                         ▼
         startPayment(orderId, amount?)          ← ONE client function
                         ▼
    ┌────────────────────────────────────────────────────┐
    │ EDGE: payments-create-intent                       │
    │  1. verify JWT                                     │
    │  2. authz: order owner OR admin                    │
    │  3. is_order_payable(order)   ── ✗ → 409 + reason  │
    │  4. amount := LEAST(requested ?? balance, balance)  │  ← SERVER
    │  5. PayMongo /v1/sources  [SECRET KEY]             │
    │  6. INSERT payment_intents (pending)               │
    │  7. → { intentId, checkoutUrl }                    │
    └────────────────────────┬───────────────────────────┘
                             ▼
        Customer: redirect          Admin: render QR + link
                             ▼
                   ── customer pays in GCash ──
                             ▼
   ┌──────────────┬────────────────────┬──────────────────────┐
   │ WEBHOOK      │ SYNC (on return)   │ SWEEPER (cron 5 min) │
   │ authority    │ latency only       │ convergence          │
   │ verify HMAC  │ query PayMongo     │ stale intents > 10m  │
   │ + timestamp  │                    │ device-independent   │
   │ + event id   │                    │                      │
   └──────┬───────┴─────────┬──────────┴──────────┬───────────┘
          └─────────────────┼─────────────────────┘
                            ▼
   ╔════════════════════════════════════════════════════════════╗
   ║  settle_payment(intent_id, provider_payment_id, amount)     ║
   ║  ── ONE TRANSACTION ──                                      ║
   ║   SELECT … FOR UPDATE      serialise                        ║
   ║   already settled? → RETURN (idempotent, no error)          ║
   ║   INSERT payment_transactions  ← the ONLY money write       ║
   ║   UPDATE payment_intents → settled                          ║
   ║   INSERT activity_logs         ← audit (P-15 fixed)         ║
   ║   INSERT notifications         ← customer + admins (P-14)   ║
   ╚════════════════════════════╤═══════════════════════════════╝
                                ▼
   ╔════════════════════════════════════════════════════════════╗
   ║  TRIGGER sync_order_payment_totals  (AFTER INSERT)          ║
   ║    amount_paid       := Σ ledger                            ║
   ║    remaining_balance := shipping_cost − Σ ledger            ║
   ║    payment_status    := derived  ← never assigned           ║
   ╚════════════════════════════╤═══════════════════════════════╝
                                ▼
        ┌───────────────────────┴────────────────────────┐
        ▼                                                ▼
   REALTIME (orders + notifications)              PUSH (send-push)
        ▼                                                ▼
   Customer UI updates          Admin UI updates    Device notification
   — no refresh —               — no refresh —
```

## 6.2 Cash — same recording path, no gateway

```
[ Record Cash Payment ]  (admin only)
          ▼
   record_manual_payment(order_id, amount, 'cash', notes, receipt)
          ▼
   ┌──────────────────────────────────────────┐
   │ assert is_admin()                        │
   │ assert is_order_payable(order)           │
   │ assert amount ≤ remaining_balance        │
   │ idempotency_key := hash(order,amount,ts) │
   └──────────────────┬───────────────────────┘
                      ▼
      ══ SAME internal routine as settle_payment ══
         INSERT ledger → audit → notification
                      ▼
      ══ SAME trigger: sync_order_payment_totals ══
                      ▼
              Realtime → both UIs
```

**No PayMongo hop. Identical everything else.** This is what "one pipeline" means in practice.

## 6.3 Pay Later lifecycle

```
PICKUP           admin records weight + photos    [shipment write]
                 admin sets payment_terms='deferred' + promised date
                                                  [terms write — no money]
                 optional downpayment ₱600 ──► ledger row
                                          ──► trigger ──► 'partial'
                 UI: "In Transit · Awaiting Remaining Balance ₱560"

IN TRANSIT       customer may pay any amount online at any time
                 ──► same GCash flow ──► ledger ──► trigger

DELIVERY         admin collects ₱560 cash
                 ──► record_manual_payment ──► ledger
                 ──► trigger: remaining = 0 ──► 'paid'  ← DERIVED

OVERDUE          a VIEW flags promised_payment_date < today
                 AND remaining_balance > 0    (no trigger needed)
```

---

# 7. Migration Plan

Eight phases. Each independently deployable and reversible. **Nothing is deleted until its
replacement is proven in production.**

### Phase 0 — Ground truth *(read-only, ~1 hour)*

```sql
-- Q1: which reconcile version is deployed?
SELECT prosrc LIKE '%payment_transactions%' AS is_v3
FROM pg_proc WHERE proname = 'reconcile_paymongo_payment_attempt';

-- Q2: how many payments are stuck?
SELECT status, count(*), max(last_error) FROM payment_attempts GROUP BY status;

-- Q3: how far has the projection drifted?
SELECT id, tracking_number, shipping_cost, amount_paid, remaining_balance, payment_status,
       COALESCE((SELECT SUM(amount) FROM payment_transactions t WHERE t.order_id = o.id),0) AS ledger_sum
FROM orders o
WHERE (payment_status = 'paid'   AND remaining_balance > 0)
   OR (payment_status = 'unpaid' AND amount_paid > 0)
   OR  amount_paid <> COALESCE((SELECT SUM(amount) FROM payment_transactions t WHERE t.order_id = o.id),0);

-- Q4: is the webhook live? (if zero rows ever settled by webhook, it was never wired up)
SELECT count(*) FILTER (WHERE payment_id LIKE 'auto_%') AS self_healed,
       count(*) FILTER (WHERE payment_id IS NOT NULL)   AS captured
FROM payment_attempts;
```

**Gate:** Q3's row count sizes Phase 2. Q4 may reorder every priority.

### Phase 1 — Emergency security fix *(~1 day, ships alone)*

Fix **P-1** independently of the redesign: server-side amount validation in the existing Edge
Function — reject any request where `amount ≠ order.remaining_balance` (small tolerance).
Closes the underpayment hole without architectural change. **Ship this regardless of approval
timing.**

### Phase 2 — Ledger completion *(data only, no behaviour change)*

Add new ledger columns (nullable). Backfill `idempotency_key` for existing rows. For every order
where `amount_paid` exceeds the ledger sum, insert `entry_type='adjustment'` rows labelled as
migration artefacts — preserving displayed totals rather than inventing history.
**Exit criterion:** `amount_paid = SUM(ledger)` for every order.

### Phase 3 — Single projection *(behaviour change, reversible)*

Deploy `sync_order_payment_totals`, `guard_order_payment_columns` (**log-only mode**), modify
`guard_order_update` to stop writing `remaining_balance`. Remove client-side computation from
`PickupModal`, `DeliveryModal`, `updateOrder`.
**Exit criterion:** Phase 0 Q3 returns zero rows and stays at zero for one business cycle.

> After Phase 3 the displayed numbers are correct even though the payment *flow* is unchanged.
> **If the thesis deadline forces a stop, stop here** — it is a coherent, defensible endpoint.

### Phase 4 — Unified reconciliation *(the core change)*

Create `payment_intents`, `payment_webhook_events`, `settle_payment()`,
`record_manual_payment()`. Deploy new Edge Functions **alongside** the old. Point the webhook at
the new handler. Old RPC becomes a logging no-op wrapper that delegates. Run in parallel one
full business cycle.

### Phase 5 — Client cutover

Switch UI to `startPayment` / `recordManual`. Ship the payability gate. **Remove the PayMongo
public key from the bundle.** Promote the guard trigger from log-only to hard rejection.

### Phase 6 — Realtime, notifications, audit

Subscribe both `OrderDetailPage`s to their order row (P-13). Add `'payment'` to the
notifications enum and emit on settle (P-14). Verify audit entries (P-15).

### Phase 7 — Sweeper and observability

Deploy the scheduled sweeper. Add an admin **Payment Exceptions** view: intents stuck > 1 h,
orders where projection ≠ ledger. This view should be permanently empty; non-empty is an alert.

### Phase 8 — Deletion

Only after 4–7 stable for a full cycle: drop all three reconcile versions, delete
`paymongo-create-payment`, remove dead client functions, drop `payment_attempts`, drop
`orders.payment_preference` / `payment_reference` / `payment_date` / `receipt_url`.

---

# 8. Risk Assessment

| # | Risk | Sev | Likelihood | Mitigation |
|---|---|---|---|---|
| R-1 | **Live payment in flight during cutover** | 🔴 | Medium | Deploy Phase 4 in a low-traffic window. Old and new paths coexist; both settle idempotently. Never deploy 4 and 8 together |
| R-2 | **History cannot be perfectly reconstructed** — GCash payments under v1/v2 have no ledger row; true amounts may be unrecoverable | 🔴 | **Certain** | Phase 2 adjustment rows preserve current totals rather than invent history. Every adjustment labelled and auditable. **Document that pre-migration history is approximate** |
| R-3 | **Webhook events lost during endpoint switch** | 🟠 | Low | PayMongo retries. Deploy the sweeper *before* Phase 4 as extra cover |
| R-4 | **Guard trigger rejects a legitimate write** from an unexamined path | 🟠 | Medium | Ship log-only (WARNING) in Phase 3; promote to EXCEPTION in Phase 5 after logs are clean |
| R-5 | **Payability gate blocks a real business case** (e.g. a regular client pre-paying by arrangement) | 🟠 | Medium | Admin override records a manual payment on a not-yet-payable order, fully audited. The gate binds the *customer* flow; admins retain judgement |
| R-6 | **Reports shift** — `get_sales_summary()` reads the corrected projections | 🟠 | High | Snapshot report output before Phase 3, diff after. Every difference must map to a Phase 0 Q3 row. **Brief stakeholders before, not after** |
| R-7 | **`npm test` fails** — `smoke-check.mjs` asserts `guard_order_update`, `prepare_order_insert`, and selected-trip safeguards exist | 🟢 | **Certain** | All survive (modified, not deleted). Update assertions in the same commit |
| R-8 | **No staging environment observed** in the repo | 🟠 | — | Confirm before Phase 3. If none exists, creating one is a **prerequisite** — this must not be first-run in production |
| R-9 | **Thesis timing** — this is the system's most defensible subsystem | 🟠 | — | Phases 0–3 alone fix correctness and stand on their own; 4–8 documented as future work |
| R-10 | **Dropping `orders.payment_reference`/`payment_date`/`receipt_url`** may break unexamined UI reads | 🟡 | Medium | Grep before Phase 8; keep as generated columns reading the latest ledger row if needed |
| R-11 | **Realtime subscription load** — every open order page holds a channel | 🟡 | Low | Per-order channels, unsubscribe on unmount, already the established pattern |
| R-12 | **Scope creep into shipment logic** — separating pickup from payment touches operational UI | 🟡 | Medium | Phases 1–4 do not change shipment flow. The split is Phase 5 and can be deferred |

---

# 9. Files That Will Be Modified

### Database — new migrations (no existing migration is edited)

```
supabase/migrations/
  2026XXXX_p2_ledger_columns.sql              NEW   ledger columns + backfill
  2026XXXX_p3_single_projection.sql           NEW   sync trigger, guards, guard_order_update fix
  2026XXXX_p4_payment_intents.sql             NEW   payment_intents, webhook_events, settle_payment
  2026XXXX_p4_manual_payments.sql             NEW   record_manual_payment, reverse_payment
  2026XXXX_p5_payability_gate.sql             NEW   is_order_payable, weight constraint
  2026XXXX_p6_payment_notifications.sql       NEW   notifications type enum + emit
  2026XXXX_p8_drop_legacy.sql                 NEW   drop reconcile ×3, payment_attempts, dead cols
supabase/schema.sql                           MODIFY  regenerate from live DB (this is how P-2 happened)
```

### Edge Functions

```
supabase/functions/_shared/paymongo.ts               NEW     one PayMongo client
supabase/functions/_shared/cors.ts                   NEW     shared headers
supabase/functions/payments-create-intent/index.ts   NEW     replaces 'register'
supabase/functions/payments-sync/index.ts            NEW     replaces 'poll'
supabase/functions/payments-sweeper/index.ts         NEW     scheduled convergence
supabase/functions/paymongo-webhook/index.ts         REWRITE 265 → ~90 lines
supabase/functions/paymongo-create-payment/          DELETE  (Phase 8)
```

### Client library

```
src/lib/paymongo.js        REWRITE  224 → ~60 ln. Delete createGCashSource,
                                    checkPaymentStatus, createPayment, registerSource,
                                    initiateGCashPayment. Keep startPayment, syncPayment
src/lib/database.js        MODIFY   DELETE createPaymentAttempt (:1051, dead)
                                    DELETE payment recalc block (:348-360)
                                    REWRITE recordPaymentTransaction → RPC
                                    SIMPLIFY recordAdditionalPayment
                                    ADD     getPaymentHistory, getPaymentIntent
src/lib/activityLog.js     MODIFY   logPayment now server-side; keep for manual actions
src/constants/status.js    MODIFY   ADD PAYABLE_STATUSES, isOrderPayable()
```

### React components

```
src/components/ui/GCashCheckout.jsx          NEW      shared QR/link/status (replaces 3 copies)
src/components/ui/PaymentModal.jsx           NEW      single admin collection modal
src/components/ui/PaymentSummaryCard.jsx     NEW      cost/paid/balance/next-action
src/components/ui/PaymentHistoryList.jsx     NEW      ledger + receipts
src/components/ui/PickupModal.jsx            REWRITE  weight + photos + terms ONLY
                                                      (delete :195-229 payment block)
src/components/ui/DeliveryModal.jsx          REWRITE  proof only (delete :164-180)
src/components/ui/AdditionalPaymentModal.jsx DELETE   → PaymentModal
src/pages/customer/OrderDetailPage.jsx       MODIFY   startPayment; DELETE localStorage
                                                      handler (:160-214); ADD realtime
src/pages/admin/OrderDetailPage.jsx          MODIFY   split pickup/payment handlers; ADD realtime
src/pages/customer/PaymentMethodsPage.jsx    MODIFY   read complete ledger
src/pages/customer/BookShipmentPage.jsx      MODIFY   remove payment_preference (:759)
src/pages/admin/SalesReportsPage.jsx         VERIFY   confirm against corrected projections
```

### Tests / docs

```
scripts/smoke-check.mjs   MODIFY  update assertion list (R-7)
CLAUDE.md                 MODIFY  payment section rewrite
docs/payment-redesign-v2.md       this document
```

**Totals: 7 new migrations · 6 Edge Function files (5 new, 1 rewrite, 1 delete) · 4 client lib
files · 12 React files (4 new, 2 rewrite, 1 delete, 5 modify) · 2 support files.**

---

# 10. Exact Implementation Plan

Each step lists its deliverable, exit criterion, and rollback. **Awaiting your approval.**

### Step 0 · Diagnostics — *0.5 day, read-only*
Run the four Phase 0 queries; produce a findings note.
**Exit:** Q1–Q4 answered. **Rollback:** n/a.
**⚠ Gate — Q1 and Q4 change the plan below. Do not start Step 2 without them.**

### Step 1 · Emergency amount validation — *1 day*
Server-side amount check in the existing Edge Function.
**Exit:** a tampered-amount request returns 400; a correct payment still succeeds.
**Rollback:** revert one function.

### Step 2 · Ledger columns + backfill — *1.5 days*
Migration `p2`; adjustment rows for drifted orders.
**Exit:** `amount_paid = SUM(ledger)` for 100% of orders.
**Rollback:** columns are additive; drop them.

### Step 3 · Single projection — *2 days*
Migration `p3`; remove client computation from three files.
**Exit:** Phase 0 Q3 = 0 rows; guard trigger logs zero warnings for 48 h.
**Rollback:** restore previous trigger definitions.
**★ Coherent stopping point — correctness restored.**

### Step 4 · Payment intents + settle — *3 days*
Migrations `p4`; `_shared/paymongo.ts`; `payments-create-intent`; `payments-sync`; rewritten
webhook. Old RPC delegates.
**Exit:** a test payment settles identically via webhook, via sync, and via double-fire
(idempotent).
**Rollback:** repoint webhook to old handler; old RPC still functional.

### Step 5 · Manual payments unified — *1.5 days*
`record_manual_payment`, `reverse_payment`; `PaymentModal`.
**Exit:** cash and GCash produce structurally identical ledger rows differing only in
`provider`.
**Rollback:** old admin modals still deployed.

### Step 6 · Client cutover + payability gate — *2.5 days*
`paymongo.js` rewrite; `GCashCheckout`; `PaymentSummaryCard`; gate in UI and DB; public key
removed; guard trigger → hard rejection.
**Exit:** Pay Now disabled at Assigned with the stated message; enabled at Picked Up; bundle
contains no PayMongo key.
**Rollback:** revert client bundle (DB unchanged).

### Step 7 · Pickup/payment separation — *2 days*
`PickupModal` → weight + photos + terms. Payment becomes a separate action.
**Exit:** a photo upload failure cannot roll back a recorded payment.
**Rollback:** revert components.

### Step 8 · Realtime + notifications + audit — *1.5 days*
Subscriptions on both order pages; `'payment'` notification type; verify audit rows.
**Exit:** payment on device A updates device B within 2 s with no refresh.
**Rollback:** remove subscriptions (polling fallback remains).

### Step 9 · Sweeper + exceptions view — *1.5 days*
Scheduled function; admin Payment Exceptions page.
**Exit:** an intent deliberately left unsettled is auto-settled within 10 min.
**Rollback:** disable the schedule.

### Step 10 · Cleanup — *1 day*
Migration `p8`; delete dead code; update `smoke-check.mjs`, `CLAUDE.md`, regenerate
`schema.sql`.
**Exit:** `npm run check` passes; one reconcile function exists; no `payment_attempts`.
**Rollback:** deletions are the last step by design.

**Total ≈ 18 working days.** Steps 0–3 (≈5 days) restore correctness; 4–10 deliver the unified
architecture.

---

## Decisions I need from you

| # | Question | Why it matters |
|---|---|---|
| 1 | **Confirm the two-channel model** (§0) — PayMongo + attested cash, one reconciliation path | Foundational. If you want GCash-only, the design changes |
| 2 | **"Awaiting Remaining Balance"** — accept it as a derived UI label (recommended), or insist on a real `orders.status` value? | §4.3. As a status it re-creates the bug being fixed |
| 3 | **Run Step 0 now?** | Q1 and Q4 could reorder everything |
| 4 | **Is there a staging Supabase project?** | R-8 — prerequisite for Step 3 |
| 5 | **Thesis deadline?** | Determines whether we target Step 3 or Step 10 |
| 6 | **Ship Step 1 immediately, ahead of approval?** | P-1 is a live financial vulnerability |

---

*No code has been modified. On approval I will begin at Step 0 and stop at each exit criterion
for review.*
