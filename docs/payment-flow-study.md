# Pickup Payment — Process Flow Study & Restructure Plan

**Date:** 2026-08-04
**Status:** Design proposal. No code, schema, or migration changed.
**Scope:** `PickupModal`, `DeliveryModal`, `payment_attempts`, `paymongo-*` Edge Functions,
and the billing semantics of `orders`.

---

## 0. Summary of the recommendation

Three changes, in order of impact:

1. **Give `payer_type` teeth.** It is currently decorative — it selects a billing name on the
   PayMongo source and renders a badge, and gates nothing. It should decide *whether the pickup
   screen asks for money at all*. Receiver-pays orders should collect nothing at pickup.
2. **Add a third GCash channel: PayMongo Payment Links.** Live QR is right for "customer is
   ready now"; it is the wrong and only tool for "customer needs to cash in later". Links solve
   the driver-waiting problem outright.
3. **Delete the Full / Pay Later toggle.** It is a derived fact, not an input. The amount
   collected already tells you which it is, and having both lets them contradict each other.

Net effect: **the driver never waits for a payment, in any permutation.**

---

## 1. What the system does today (traced, not assumed)

### 1.1 The pickup form has four inputs

From `PickupModal.jsx:14-23`:

| Input | Values | What it actually controls |
|---|---|---|
| `payment_type` | `full` \| `paylater` | Branches the amount defaulting and the old status math |
| `payment_method` | `cash` \| `gcash` | Whether the QR flow appears |
| `payer_type` | `sender` \| `receiver` | **Nothing.** See below |
| `amount_paid` | number | The amount collected |

### 1.2 `payer_type` is decorative

Every reference, traced across `src/**`, `supabase/functions/**`, `schema.sql` and the RLS policies:

- `PickupModal.jsx:68-69` — picks `sender_name`/`sender_phone` vs `receiver_*` for the PayMongo
  source's billing block
- `PickupModal.jsx:301` → the pickup RPC → `orders.payer_type`
- `reconcile_paymongo_payment_attempt` — copies it from the attempt onto the order
- `admin/OrderDetailPage.jsx:737` — renders a badge

It gates **no branch, no validation, no workflow**. Meanwhile `payment_method` is *required*
(`PickupModal.jsx:237-240`). So for a receiver-pays shipment the driver is forced to choose a
payment method and then either collect cash from a person who is not there, or display a QR code
to nobody. The only way through is to pick "Pay Later" with ₱0 — using an escape hatch to model
the normal case.

### 1.3 The customer already told us, twice, and we discard it

`BookShipmentPage.jsx:763-772` collects **both**:

- `payer_type` — "Who Pays?" → Sender / Receiver
- `payment_preference` — "Payment Preference" → I'll decide later / Cash / GCash

`payment_preference` is stored and **never read by anything** (confirmed in the architecture
review — it is one of the write-only columns). The customer states an intent at booking and the
pickup screen asks again from a blank slate.

### 1.4 The GCash flow assumes the customer is present and solvent

`PickupModal.jsx:57-85` creates a PayMongo **Source** with the full amount, shows a QR, then
`:145-170` subscribes to realtime on `orders` and polls every 15 s waiting for the webhook to
reconcile. There is no path that produces a payable artefact the customer can use after the
driver leaves. The only escape is `paymongoPending` — save the order with the QR unpaid and hope.

### 1.5 `payment_method` conflates a channel with a timing

`schema.sql:79` — `CHECK (payment_method IN ('cash', 'gcash', 'paylater'))`. "Pay later" is not a
payment method; it is a *term*. A pay-later order is eventually paid in cash or GCash, and the
column cannot express that. This is why `get_sales_summary()` has a `paylaterTotal` bucket that
double-counts against `cashTotal`/`gcashTotal` depending on how the order settled.

---

## 2. Industry standard: Freight Prepaid vs Freight Collect

This is a settled question in logistics. Every forwarder — FedEx, DHL, 2GO, LBC, JRS — models
billing on one axis:

| Term | Who pays | Collected at | Carrier's security |
|---|---|---|---|
| **Prepaid** (shipper-paid) | Sender | Pickup / booking | Payment taken before cargo moves |
| **Collect** (consignee-paid, COD) | Receiver | Delivery | **Possession of the cargo** |

The load-bearing insight, and the answer to "the driver cannot wait forever":

> **On a Collect shipment the carrier never chases payment, because the goods are the collateral.
> You do not release the cargo until the consignee pays.**

This is precisely why COD works at scale in the Philippines. It requires *zero* payment
infrastructure at pickup. The current design's hardest problem — a receiver who is not present
at pickup — is not a problem at all once billing mode is modelled properly. It disappears.

The residual case is **Prepaid where the sender cannot pay on the spot**. Industry practice there
is not to wait either. It is one of:

- accept the cargo with a balance owing and collect at delivery (converts to Collect), or
- hold the cargo at origin/hub until cleared, or
- issue an invoice with terms (this is what `promised_payment_date` is already for).

The existing `Pay Later` + `promised_payment_date` fields are the right primitives. They are just
not wired to a workflow.

---

## 3. Answering your three GCash questions directly

### 3.1 "Static GCash QR + admin types the reference number?"

**No, not as the primary mechanism.** Specifically:

- Nothing verifies it. The admin eyeballs a screenshot on a customer's phone.
- Reference numbers are trivially forged — a customer can type any 13 digits, and a driver under
  time pressure will not cross-check the merchant app.
- Money lands in a personal or merchant GCash wallet **outside the ledger**, so
  `payment_transactions` records a collection that no bank feed corroborates.
- No automatic reconciliation, so every one becomes manual back-office work.

**But keep it as an explicitly-labelled fallback**, because it is what genuinely happens when
PayMongo is down or the driver has no signal — and the app already supports it
(`PickupModal.jsx:243-251` accepts a manual reference). The fix is not to remove it; it is to
**stop treating it as equivalent to a verified payment**. See `verified` in §6.2.

### 3.2 "PayMongo Payment Link sent by SMS/email, payable within 24h?"

**Yes. This is the missing primitive.** I verified the capability against PayMongo's current
docs rather than assuming:

| Fact | Source |
|---|---|
| `POST /v1/payment_links` | `docs.paymongo.com/reference/payment-links` |
| **Secret key required** (HTTP Basic) | same — so it must live in an Edge Function, never the browser |
| Returns `url` **and `reference_number`** — "short unique reference included in the payment link URL" | same |
| **No expiration.** Active until archived via `PATCH /v1/payment_links/:id {archive:true}` | same |
| `restrictions.completed_sessions.limit` caps completed payments → set to **1** for single-use | same |
| Fires **`link.payment.paid`** webhook | same |
| Supports e-wallets, cards, QR Ph, online banking, BNPL | `docs.paymongo.com/docs/payment-channels-payment-links` |

Two consequences worth calling out:

- **`reference_number` is the real UX win**, more than the URL. It is short and human-readable, so
  the driver writes it on the paper waybill, says "pay this within 24 hours", and leaves. No SMS
  delivery dependency, no email deliverability problem, works on a feature phone.
- **"Within 24 hours" is a policy, not a platform feature.** Links do not expire on their own. If
  you want a deadline you enforce it yourself — a scheduled job that archives links older than N
  hours and flags the order. Do not assume PayMongo will time it out for you.

The existing key split already supports this correctly: the secret key is an Edge Function secret,
so link creation slots into `paymongo-create-payment` with no security change.

### 3.3 "Keep the live QR?"

**Yes — for the case it was designed for.** A customer who is standing there with a funded GCash
wallet should pay in 60 seconds and be done. The flow works and the reconciliation around it
(dual webhook + poll, row locks, self-heal) is the strongest part of this codebase. The defect is
that it is the *only* option, not that it is a bad option.

---

## 4. The proposed model: three orthogonal axes

The current modal presents one flat form where three unrelated decisions are tangled. Separate
them.

### Axis 1 — Billing mode (WHO owes, and therefore WHERE money is collected)

```
prepaid  → sender pays   → collection point = PICKUP
collect  → receiver pays → collection point = DELIVERY
```

Seeded from `orders.payer_type` at booking. Confirmed (and overridable) by the admin at pickup.
**This is the only decision that changes the shape of the screen.**

**Recommendation: do not add a `billing_mode` column.** `payer_type` already stores exactly this
(`sender`/`receiver`) with a CHECK constraint. Give the existing column meaning rather than adding
a synonym — consistent with the consolidation philosophy in the architecture review.

### Axis 2 — Settlement channel (HOW money moves), asked only at the collection point

```
cash        — immediate, offline, verified by the admin's own possession of the cash
gcash_now   — live PayMongo Source + QR. Customer present and funded.
gcash_link  — PayMongo Payment Link. Customer pays later. Driver leaves immediately.
manual_ref  — offline / unverified. Requires a receipt photo. Flagged as unverified.
```

Default this from `orders.payment_preference` — the booking-time field currently thrown away.

### Axis 3 — Amount collected now (₱0 … full)

**Delete the Full / Pay Later toggle.** It is derivable:

```
collected == 0        → nothing collected (was: "Pay Later, zero")
0 < collected < total → partial          (was: "Pay Later, downpayment")
collected == total    → settled          (was: "Full Payment")
```

Keep a **"Collect full amount"** shortcut button that prefills the field — that is the 90% case
and should be one tap. But it prefills an amount; it does not set a mode. This removes an entire
class of contradictory states (`payment_type='full'` with `amount_paid=0`, which the current code
can produce) and eliminates the branch at `PickupModal.jsx:308-326`.

---

## 5. The permutation matrix

### 5.1 At pickup

| `payer_type` | Payment section shown? | Channels offered | What the driver does |
|---|---|---|---|
| `sender` (Prepaid) | **Yes** | cash · gcash_now · gcash_link · manual_ref | Collect 0 → full |
| `receiver` (Collect) | **No** | — | Weigh, photograph, confirm. Leave. |

For Collect, the payment block is replaced by a banner:

> **Freight Collect** — ₱1,200.00 will be collected from *Maria S.* on delivery.
> Nothing to collect now.

### 5.2 Prepaid × amount collected

| Collected | Resulting state | Cargo moves? | Follow-up |
|---|---|---|---|
| Full | `paid` | Yes | None |
| Partial | `partial` | Per policy (§7) | Balance collected at delivery |
| Zero | `unpaid` | Per policy (§7) | `promised_payment_date` required |

### 5.3 Prepaid × channel

| Channel | Driver waits? | Reconciliation | Ledger `verified` |
|---|---|---|---|
| `cash` | No | Immediate, admin-attested | `true` |
| `gcash_now` | ~60 s | Webhook `payment.paid` + poll (existing) | `true` |
| `gcash_link` | **No** | Webhook `link.payment.paid` (**new branch**) | `true` |
| `manual_ref` | No | **None** — admin assertion only | **`false`** |

### 5.4 At delivery (`DeliveryModal`)

Already mostly correct — it computes `balance` from `remaining_balance` and registers a source
with `payerType: 'receiver'` (`DeliveryModal.jsx:57`). It needs the same channel choices as
pickup, and for Collect orders it becomes the **primary** collection screen rather than an
afterthought.

---

## 6. Backend / schema plan

### 6.1 `payment_attempts` — support links alongside sources

I said in the architecture review that this table should stay unchanged. I am revising that: not
because of a defect, but because links are a new requirement it was not designed for.

```
BEFORE  source_id TEXT NOT NULL UNIQUE
AFTER   source_id  TEXT UNIQUE          -- nullable
        link_id    TEXT UNIQUE          -- nullable
        reference_number TEXT           -- the short human-readable code
        channel    TEXT NOT NULL CHECK (channel IN ('gcash_now','gcash_link'))
        CHECK (num_nonnulls(source_id, link_id) = 1)
```

`reconcile_paymongo_payment_attempt` currently keys on `p_source_id`. It needs a sibling that
keys on `link_id`, or a single function taking `(p_source_id, p_link_id)` with the same row-lock
and `ON CONFLICT` idempotency. **Reuse the existing reconcile body** — its correctness controls
(row locks, orphan recovery, self-heal, unique reference) are the thing to preserve.

### 6.2 `payment_transactions.verified` — the audit fix

```
ALTER TABLE payment_transactions ADD COLUMN verified BOOLEAN NOT NULL DEFAULT true;
```

`false` only for `manual_ref` entries. Today a typed-in reference and a webhook-confirmed payment
are indistinguishable in the ledger, which means `get_sales_summary()` reports unverified money as
collected revenue with no way to separate it. With this column the admin Sales page can show
"₱X collected, of which ₱Y unverified" — which is the number a business owner actually needs.

**This is the highest-value item in this section** and is worth doing even if nothing else here
ships.

### 6.3 `orders.payment_method` — stop conflating channel and timing

```
BEFORE  CHECK (payment_method IN ('cash','gcash','paylater'))
AFTER   CHECK (payment_method IN ('cash','gcash'))
```

`paylater` disappears as a *method*; it is already expressed by
`payment_status='unpaid'/'partial'` + `promised_payment_date`. The fine-grained channel
(`gcash_now` vs `gcash_link` vs `manual_ref`) belongs on the **ledger row**, not the order — the
order can be settled by several payments through different channels.

Needs a backfill for existing `payment_method='paylater'` rows. **This one is not free** — check
the row count first and confirm `get_sales_summary()`'s `paylaterTotal` bucket is retired
alongside it.

### 6.4 `paymongo-webhook` — new event branch

The webhook currently handles `source.chargeable` and `payment.paid`
(`paymongo-webhook/index.ts:185-258`). Links fire **`link.payment.paid`**, a different event with
a different payload shape. Needs a third branch resolving `link_id → payment_attempt → reconcile`.

The existing signature verification, constant-time compare and raw-body HMAC are unaffected.

### 6.5 `orders.payment_preference` — finally used

No schema change. Read it in `PickupModal` to preselect the channel. This retires one of the
write-only columns from the architecture review by *finishing the feature* rather than deleting it.

---

## 7. The policy decision only you can make

**Does cargo move before a Prepaid order is settled?**

| Option | Rule | Risk |
|---|---|---|
| **A — Permissive** | Cargo always moves. Unpaid balance rides to delivery. | Receiver may refuse to pay someone else's freight |
| **B — Strict** | Cargo held at hub until Prepaid balance clears | Warehouse congestion; angry senders |
| **C — Hybrid** *(recommended)* | Cargo moves. `Out for Delivery` is **gated** on balance = 0 **or** an explicit admin conversion to Collect | Requires one guard in the status transition |

C uses your existing status machine as the enforcement point, needs no waiting at pickup, and
makes the conversion an explicit, logged admin decision rather than a silent default. It is one
check in `validateStatusTransition` plus a server-side guard.

I am not choosing this for you — it is a credit-risk decision about your own customers.

---

## 8. UX restructure of `PickupModal`

### 8.1 From flat form to 4 steps

The modal is currently one long scroll mixing weighing, payment, and photos. Proposed:

```
Step 1  WEIGH & VERIFY
        actual weight → live recomputed cost (₱/kg from the trip or global default)
        pickup photos (1-3, required)

Step 2  BILLING                       [skipped if payer_type = receiver]
        ┌──────────────────────────────────────────────┐
        │ Booking says: Sender pays · prefers GCash    │  ← from payer_type +
        │ [ Confirm ]  [ Change ]                      │    payment_preference
        └──────────────────────────────────────────────┘

Step 3  COLLECT                       [skipped if Collect]
        Amount due  ₱1,200.00
        Collecting  [ ₱______ ]  [Collect full amount]
        Channel     ( ) Cash
                    ( ) GCash — pay now      → QR, live confirm
                    ( ) GCash — pay later    → link + reference number
                    ▸ Record an offline payment (unverified)

Step 4  CONFIRM
        summary → one atomic submit  (record_pickup_payment, already built in P0-1)
```

### 8.2 Rules that make the driver's life work

1. **Never block on payment.** "Skip — collect later" is visible at every step, never buried.
2. **The QR screen has a permanent exit.** Today, choosing GCash and generating a QR effectively
   traps the driver watching a 15 s poll. Add **"Customer can't pay now → switch to Pay Later
   link"**, which archives the source, creates a link, and moves on.
3. **The link screen leads with `reference_number`, not the URL.** Large monospace type, a Copy
   button, then SMS/Email as secondary actions. The driver writes it on the waybill and leaves.
4. **Manual reference is behind a disclosure**, labelled "unverified", and requires a receipt
   photo. It writes `verified = false`.
5. **Show the recomputed cost the moment the weight changes.** The booking estimate is almost
   always wrong (that is the whole reason for weighing), and the customer needs to see why the
   number moved before being asked to pay it.

### 8.3 `DeliveryModal`

Same channel selector. For Collect orders it is the primary collection screen, so it should lead
with "Collect ₱X from *Maria S.*" rather than treating payment as a secondary concern after
photos.

---

## 9. Edge cases

| Case | Handling |
|---|---|
| **Customer pays the link 3 days later** | `link.payment.paid` → reconcile → ledger → trigger recomputes totals. Order may already be Delivered; that is fine, the ledger is append-only and `remaining_balance` simply goes to 0. |
| **Customer pays link *and* cash at delivery** | Ledger sums both; `remaining_balance` clamps at 0 via `GREATEST(0, …)`. Genuine overpayment surfaces as a refund case — see below. |
| **Overpayment** | Currently invisible: `remaining_balance` clamps to 0 and the excess vanishes. Needs an explicit `overpaid` state or a credit note. **Out of scope here, but worth logging as a known gap.** |
| **Link never paid** | Scheduled job archives links past your policy window, flags the order, notifies the admin. Links do not self-expire — you must enforce this. |
| **Driver's phone loses signal mid-pickup** | Photos upload on retry; the atomic RPC means a half-written pickup is impossible (this is what P0-1 bought). Offline queueing is a larger piece of work — flagging, not proposing. |
| **Receiver refuses to pay a Collect shipment** | Business/exception flow: return-to-sender or hold. Needs an order status the current machine lacks. **Gap — worth a decision.** |
| **Weight increases after a link is created** | The link is for a stale amount. Archive and reissue, or collect the difference at delivery. Recommend: **create the link only at the end of the flow**, after the weight is final. |
| **Customer pays QR while the driver is switching to a link** | The existing dual reconcile handles it — whichever lands first wins, idempotently. Do not add new logic; reuse the reconcile RPC. |
| **Sender pays, but the order is Collect** | Allow it. The ledger does not care who paid; `remaining_balance` drops. `payer_type` describes intent, not a constraint on who may pay. |

---

## 10. Suggested phasing

| Phase | Content | Why this order |
|---|---|---|
| **1** | `payer_type` gates the payment section. Collect orders collect nothing at pickup. | Pure frontend + one guard. Biggest UX win, smallest blast radius, **no schema change.** |
| **2** | `payment_transactions.verified` + label manual references as unverified | One column. Fixes the audit hole immediately. |
| **3** | PayMongo Links: Edge Function, `payment_attempts` columns, `link.payment.paid` branch, reconcile sibling | The real feature. Touches money — do it on its own, with staging QA. |
| **4** | Modal restructure into 4 steps; drop the Full/PayLater toggle; read `payment_preference` | Cosmetic once 1-3 land. |
| **5** | `payment_method` CHECK cleanup + `paylater` backfill + `get_sales_summary` bucket retirement | Needs a data migration; least urgent. |

Phase 1 alone resolves the receiver-not-present problem, which is the dilemma you opened with —
and it requires no database change at all.

---

## 11. What must not change

- **The ledger is the sole writer of payment totals** (P0-1). Every channel above records money by
  inserting a `payment_transactions` row. Nothing writes `amount_paid` directly, ever.
- **`record_pickup_payment` already generalises.** It takes an amount, a reference and a method —
  a link-settled payment is just another ledger row. No new RPC is needed for phases 1, 2 or 4.
- **The reconcile RPC's correctness controls**: row locks, `ON CONFLICT` on the partial unique
  index, orphan recovery, the not-chargeable self-heal. Reuse this body for links; do not write a
  second reconciliation path from scratch.
- **The key split.** Link creation needs the secret key, so it belongs in an Edge Function
  alongside capture. Never in the browser.
