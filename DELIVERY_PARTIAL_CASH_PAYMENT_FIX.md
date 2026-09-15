# Delivery Payment Rule Fix — Cash or GCash at Delivery Confirmation

Implements the corrected business rule (not just an audit): Cash and GCash are both accepted
during pickup **and** during delivery confirmation, while the admin is physically receiving
payment. Only a later, out-of-band balance settlement (after delivery is already confirmed)
remains GCash-only. The blanket "GCash only after pickup" rule is removed.

---

## 1. Previous vs. corrected business rule

| | Previous (too restrictive) | Corrected |
|---|---|---|
| At pickup | Cash or GCash | Unchanged — Cash or GCash |
| At delivery confirmation (admin physically receiving payment) | **GCash only** — cash rejected server-side unconditionally | **Cash or GCash**, including partial payments |
| After delivery, later balance settlement (no one at a counter) | GCash only | Unchanged — **GCash only** |
| Who can record cash | N/A | Only authenticated admins (`is_admin()`), server-enforced. Customers have no cash-recording path at all — they only ever see "Pay with GCash". |

The rule that changed is narrower than it first sounds: it was never "no cash after pickup" as a
blanket policy — the actual distinction the business cares about is *whether someone is standing
at a counter handing over cash right now*. That's true at both pickup and delivery confirmation,
and false for a later, separate settlement action. The fix makes the code match that distinction
instead of the blanket rule the original comment described.

---

## 2. Root cause

`record_delivery_payment()` (the server-side RPC `DeliveryModal` calls to complete a delivery)
unconditionally rejected `payment_method = 'cash'`:

```sql
IF COALESCE(p_amount, 0) > 0 THEN
    IF v_method = 'cash' THEN
      RAISE EXCEPTION 'Cash is no longer accepted once an order has been picked up. Collect the remaining balance via GCash.'
        USING ERRCODE = '22023';
    END IF;
    ...
```

The frontend mirrored this with a `config.allowCash: false` flag on `DeliveryModal`'s
`PaymentCollectionPanel` config, which hid the Cash button entirely. Both were deliberate,
documented decisions from `20260909030000_manual_payment_hardening.sql` — not a bug, but a rule
that was more restrictive than the actual business need.

A second, independent bug was found and fixed while doing this: the same RPC's ledger insert
**hardcoded `payment_method = 'gcash'` and `gcash_channel = 'manual'` for every row it ever wrote**
(because gcash was the only value that could reach that line). This was latent — harmless while
cash could never reach that INSERT — but would have silently mislabeled every cash delivery
payment as a "verified manual GCash transfer" the moment cash was allowed, corrupting the ledger's
own payment-method record. Fixed as part of the same change.

A third, unrelated but directly relevant bug was found while verifying scenario coverage: the
**customer-facing** "Pay with GCash" button (`OrderDetailPage.jsx`) hid itself for any order in
`'Delivered'` status, via a hardcoded `PAYABLE_STATUSES` list that never included `'Delivered'`.
The server-side edge function that actually creates the GCash checkout
(`paymongo-create-payment`) never restricted by order status at all — it only ever checks
`remaining_balance`. So a customer with a Delivered order and a real outstanding balance (exactly
the scenario this task introduces as normal) had no way to pay it. Fixed.

---

## 3. Files and database functions changed

| File | Change |
|---|---|
| `supabase/migrations/20260915100000_allow_cash_at_delivery_confirmation.sql` (new) | `CREATE OR REPLACE FUNCTION record_delivery_payment(...)` (same 12-arg signature — no `DROP FUNCTION` needed): accepts `cash` or `gcash`; fixed the payment_method/gcash_channel mislabeling; every other guard (idempotency, `Out for Delivery` lifecycle check, delivery-photo count, negative-amount check, discount-aware outstanding-balance cap, promise-date requirement) is untouched. |
| `src/components/ui/DeliveryModal.jsx` | Removed `allowCash: false`. Payment method now starts blank (admin must choose) instead of defaulting to `'gcash'`. Added the concise "Accept Cash or GCash now..." copy above the payment panel. Updated stale comments. |
| `src/components/ui/PaymentCollectionPanel.jsx` (shared by Pickup and Delivery) | Removed the now-dead `config.allowCash` branching — Cash and GCash are unconditionally both offered (the only caller that ever set `allowCash: false` was `DeliveryModal`). Added a short "Cash received — ₱X collected directly from…" indicator when Cash is selected. Fixed a real gap: switching payment method away from GCash after a checkout had been opened (or already confirmed) now clears the amount/reference/verification fields instead of silently carrying them into the new method — previously this could have double-charged money the webhook already recorded, or mislabeled an unconfirmed GCash amount as cash received. |
| `src/components/ui/AdditionalPaymentModal.jsx` | **Logic unchanged** (still GCash-only, correctly — this is the "later, out-of-band settlement" flow). Comment and on-screen text reworded from "a remaining balance after pickup can no longer be settled in cash" (no longer accurate) to "cash can only be collected in person, at pickup or during delivery confirmation." |
| `src/pages/customer/OrderDetailPage.jsx` | Added `'Delivered'` to `PAYABLE_STATUSES` — fixes the bug in §2 that hid the customer's GCash payment button for a Delivered order with a real balance. |
| `src/lib/database.js` | Doc-comment update on `recordDeliveryPayment()` only; no behavior change (the wrapper already passed `payment_method` straight through with no client-side filtering). |
| `scripts/delivery-cash-payment-pgtest/` (new) | Focused local regression suite, 47 assertions, described in §6. |
| `package.json` | Added `test:delivery-cash-payment` script. |

`record_pickup_payment()` and `record_additional_payment()` were **not modified** — pickup already
allowed both methods, and the later-settlement rule for `record_additional_payment` is correct as
written and stays GCash-only.

---

## 4. How partial cash + later GCash settlement work

1. Admin opens **Confirm Delivery**, selects **Pay Later**, enters the amount actually being
   handed over (e.g. ₱3,000 of a ₱5,496 balance), selects **Cash**, attaches delivery photos, and
   confirms.
2. `record_delivery_payment()` runs in one transaction: locks the order row, validates the amount
   against the *discount-aware* outstanding balance (`order_payable_amount()`), inserts exactly one
   `payment_transactions` row (`amount = 3000`, `payment_method = 'cash'`, `payment_status =
   'partial'`), and sets `orders.status = 'Delivered'`.
3. The existing ledger trigger (`update_order_payment_totals`, from `20260913170000`, untouched by
   this fix) recomputes `orders.amount_paid`, `remaining_balance`, and `payment_status` from the
   ledger — `remaining_balance` becomes ₱2,496, `payment_status` becomes `'partial'`. `status`
   (`Delivered`) and `payment_status` (`partial`) are independent columns — delivery completion
   never implied full payment, architecturally, and nothing in this fix changes that.
4. Because a balance remains, `record_delivery_payment()` still requires a promise date on file
   (unchanged rule) before it will confirm the delivery.
5. Later, the customer (via "Pay with GCash" — now visible on a Delivered order, §2/§3) or an admin
   (via `AdditionalPaymentModal` → `record_additional_payment()`, still GCash-only) settles the
   remaining ₱2,496. This is a **separate** `payment_transactions` row with its own method and
   amount — the ₱3,000 cash row is never touched, relabeled, or merged.
6. Result: two ledger rows, ₱3,000 `cash` + ₱2,496 `gcash`, summing to ₱5,496; `orders.status`
   stays `'Delivered'` (the later settlement never re-runs delivery); `payment_status` becomes
   `'paid'`.

---

## 5. Duplicate-payment and concurrency protections

All of this was already in place for GCash and now applies identically to cash, since cash goes
through the exact same code path once the method check is relaxed:

- **Idempotency key**: `DeliveryModal` generates one UUID per modal mount
  (`createPaymentCollectionState`'s `idempotency_key`) and resends it unchanged on every retry of
  the *same* collection attempt. `record_delivery_payment()` locks the order row first, then checks
  whether that key already has a ledger row — if so, it returns the current order untouched instead
  of inserting again. **This is never the amount** — two genuinely different ₱3,000 cash payments
  on the same order (unlikely, but not impossible) would use two different keys and both post
  correctly; only a *retry* of the identical attempt is deduplicated. Verified: "exactly one cash
  transaction despite the retry" (double-click simulation).
- **Cross-order key reuse rejected, not silently accepted**: if the same key is ever presented
  against a *different* order than the one it was first used for, the RPC raises instead of
  returning success. Verified.
- **Order-row locking serializes concurrent writes**: `record_delivery_payment()`,
  `record_additional_payment()`, and the webhook's own reconciliation RPC all take `SELECT ... FOR
  UPDATE` on the order before reading or writing totals. A concurrent GCash settlement opened while
  the delivery modal is still up is therefore serialized against the delivery confirmation — one
  commits, the other observes its result before proceeding — rather than racing on a stale balance
  snapshot.
- **The ledger trigger itself also locks the order row** (`20260913170000`, untouched) before
  recomputing `amount_paid`/`remaining_balance`/`payment_status`, so even a hypothetical future
  write path that bypasses the RPC-level lock still can't leave the derived totals behind the
  ledger.
- **Manual GCash reference duplicate protection** (`guard_manual_gcash_payment` +
  `uq_payment_transactions_manual_gcash_ref` unique index): unchanged, still GCash-only since cash
  has no reference to check.
- **Frontend carry-over fix** (§3, `PaymentCollectionPanel.jsx`): switching from GCash to Cash after
  a checkout was opened now clears the typed amount instead of silently reusing it — closing a path
  that could have produced a duplicate/phantom charge on the client side before it ever reaches the
  server's own idempotency check.
- **No competing total-overwrite paths**: `record_delivery_payment()` writes order metadata and the
  ledger row in the same transaction; the derived totals are owned exclusively by the trigger. No
  code path sets `amount_paid`/`remaining_balance`/`payment_status` directly.

---

## 6. Tests performed and actual results

All testing used **disposable, synthetic records** — a hand-built local Postgres schema
(`@electric-sql/pglite`, an embedded real Postgres, not a mock) with the **actual, unmodified**
migration files applied verbatim on top, per this repo's established pgtest convention
(`scripts/*-pgtest/run.mjs`). No real customer data, no live database, no real financial
transaction was touched.

**New suite**: `npm run test:delivery-cash-payment` (`scripts/delivery-cash-payment-pgtest/`) —
**47/47 assertions passed**. Covers, from the task's required scenario list:

- Full cash payment during delivery — one ledger row, correctly labeled `cash`, `gcash_channel`
  NULL (the mislabeling bug from §2 verified fixed).
- **The exact ₱5,496 example**: ₱3,000 cash at delivery (Pay Later) → `Delivered` / `partial` /
  ₱2,496 owing → ₱2,496 GCash settlement afterward → exactly two `payment_transactions` rows
  summing to ₱5,496, `Delivered` status unchanged by the later settlement, exactly two payment
  notifications (one per real payment, none for the ₱0 case elsewhere in the suite).
- Pay Later with ₱0 collected: delivery still confirms, balance and `payment_status` untouched, no
  ledger row, no notification.
- Verified GCash (manual reference) during delivery still works, recorded as `gcash` /
  `gcash_channel = 'manual'`.
- An unverified GCash reference is rejected, with no order-status change and no ledger row —
  proxy for "a payment that never actually completed must not silently succeed" (the suite
  cannot invoke the real PayMongo webhook/polling path from a local Postgres instance; see gaps
  below).
- A previously partially-paid order: collecting more than the remaining balance is rejected;
  collecting exactly the remaining balance settles it.
- Discounted booking: the discounted `order_payable_amount()`, not the gross `shipping_cost`, is
  what determines "paid in full."
- Double-click/retry of the same delivery confirmation (same idempotency key): exactly one cash
  transaction, order not double-credited.
- The same idempotency key reused against a different order is rejected outright.
- A customer session and an anonymous session both fail `is_admin()` and record nothing.
- A Delivered order with a balance still accepts a GCash settlement afterward.
- A fully paid order rejects a further settlement attempt (amount exceeds outstanding-balance-of-0).
- `record_additional_payment()` (the later, out-of-band flow) still unconditionally rejects cash —
  confirms the narrower rule was preserved exactly where it should be.
- Negative amount and an unsupported method (`'check'`) are both rejected.
- The pre-existing `Out for Delivery` lifecycle guard is unaffected by this change.

**Existing suites re-run, all green, no regressions:**
- `npm test` (full 21-script default chain) — pass.
- `npm run test:shipping-discount` (92 assertions) — pass; confirms discount-aware notification
  copy and `get_sales_summary()` figures are unaffected.
- `npm run test:payment-ledger` (52 assertions) — pass; confirms ledger/order-total consistency
  across all orders is unaffected.
- `npm run build` — production build succeeds.
- `node scripts/token-lint.mjs`, `node scripts/axe-lint.mjs` — both part of `npm test`, pass (no
  new design-token or accessibility issues from the DeliveryModal/PaymentCollectionPanel UI
  changes).

---

## 7. Deployment steps and verification gaps

**Not yet applied to the live database.** Per this task's implicit continuation of the same safety
posture as prior work in this repo, and because this task did not explicitly authorize a live
`supabase db push`, the new migration
(`20260915100000_allow_cash_at_delivery_confirmation.sql`) is written and locally verified but has
**not** been pushed to the linked Supabase project. To deploy:

```bash
supabase db push
```

No Edge Function changes are needed (this fix is entirely a database function + frontend change;
no `supabase functions deploy` step is required).

**Explicit verification gaps** (cannot be closed without a browser/staging environment):

- **No browser/UI verification** of `DeliveryModal`/`PaymentCollectionPanel`'s new Cash flow, the
  "Cash received" indicator, the reworded copy, or the method-switch amount-clearing fix. Desktop
  and mobile rendering are unverified beyond code review and the existing token/a11y linters.
- **No live PayMongo webhook test.** The suite verifies the *manual*-GCash-reference path and the
  *rejection* of an unconfirmed/unverified one, but cannot drive a real PayMongo checkout or
  webhook callback from a local Postgres instance. `reconcile_paymongo_payment_attempt()` — the
  function that actually records a webhook-confirmed GCash payment — was not modified by this task
  and was not re-tested here; it credits money through a completely separate path from
  `record_delivery_payment()`'s manual-entry branch.
- **No true concurrent-transaction test.** The pgtest suite runs each scenario against a single
  connection in sequence; it demonstrates the row-locking mechanism is in place and that a
  same-key retry is deduplicated, but does not open two simultaneous Postgres connections to prove
  a real race resolves correctly. The locking pattern itself (`SELECT ... FOR UPDATE` before any
  read of totals, in both the RPCs and the trigger) is the same one already relied on elsewhere in
  this codebase and was not altered by this fix.
- **No live customer-facing "Pay with GCash" click-through** on a Delivered order — the
  `PAYABLE_STATUSES` fix was verified by code/logic review (the server-side edge function's own
  lack of a status check, confirmed by reading `paymongo-create-payment/index.ts`) rather than by
  driving the actual checkout flow in a browser.

Nothing in this task required or performed a destructive schema change, a real financial
transaction, or a change to unrelated modules (pickup, refunds, discounts, sales reporting were all
read for context and left untouched, confirmed by the shipping-discount and payment-ledger suites
still passing unmodified).
