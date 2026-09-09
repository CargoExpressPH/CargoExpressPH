# Payment Duplicate-Prevention Fix

**Date:** 2026-09-09
**Scope:** Payment-recording flow — online GCash (PayMongo), cash at pickup, direct GCash transfers recorded manually, and the "Record Additional Payment" / balance-settlement flow.
**Starting point:** `SYSTEM_MODULE_BUG_AUDIT.md`, primarily BUG-01. Its claims were re-verified against the current code before any fix was written (see "Verified root cause" below); the audit's BUG-02/BUG-03/BUG-04 are out of this task's scope and are addressed separately (see "Related work already in this repo").

---

## 1. Verified root cause

`SYSTEM_MODULE_BUG_AUDIT.md`'s BUG-01 was confirmed exactly as described by reading the current code, not assumed from the report:

- `supabase/functions/paymongo-webhook/index.ts` (`source.chargeable` self-heal branch) and `supabase/functions/paymongo-create-payment/index.ts` (the `poll` action's two self-heal branches) each reconciled a payment using a **fabricated reference**, `` `auto_${sourceId}` ``, whenever their own capture call lost a race and got PayMongo's `"not chargeable"` error, but the source's own status read back `"paid"`.
- The independent `payment.paid` webhook then arrives with the **real** PayMongo payment id and calls `reconcile_paymongo_payment_attempt()` again.
- `reconcile_paymongo_payment_attempt()` (`supabase/schema.sql:2405-2492`) had **no check for "already reconciled"** — its only idempotency guard was `ON CONFLICT (transaction_reference) WHERE transaction_reference IS NOT NULL`, a partial unique index on `payment_transactions.transaction_reference`. Because the synthetic reference and the real payment id are two different strings, this guard could not recognize them as the same money. Both `INSERT`s succeeded, and the order was credited twice for one real GCash payment.
- Corroborated by `docs/payment-redesign-v2.md` P-12, which had flagged the identical mechanism earlier and was never fixed.

**A second, separate defect was found while implementing the fix**, not mentioned in the audit: `recordAdditionalPayment()` in `src/lib/database.js` — the code behind the "Record Additional Payment" button and the Unsettled Deliveries settlement flow — never went through a database function at all. It did a plain `SELECT` (no row lock) followed by a raw `.insert()` into `payment_transactions` directly from the browser, protected only by an RLS policy that let any admin `INSERT`/`UPDATE`/`DELETE` on the table. This is the exact "SELECT then INSERT" pattern the task calls out as insufficient: no atomic order lock, no idempotency key, no cash-after-pickup rule, no manual-GCash verification, and no duplicate-reference detection. It is fixed the same way as the rest of this report (see §2.4).

## 2. Payment identity rules, per channel

| Channel | Identity | Where enforced |
|---|---|---|
| GCash via PayMongo (automatic) | The real PayMongo payment id (`pay_...`), obtained only from a successful `POST /v1/payments` response or the `payment.paid` webhook payload — never invented. One `payment_attempts` row (= one PayMongo source/checkout) can produce at most one ledger row. | `reconcile_paymongo_payment_attempt()`: short-circuits to a no-op once the attempt is `'reconciled'`, and rejects any `p_payment_id` matching `^auto_` outright. |
| Direct GCash transfer (manual, admin-verified) | The admin-entered reference, normalized (uppercased, whitespace/dashes stripped, **leading zeros and all other characters preserved**) and required to be unique **system-wide** (one receiving GCash account ⇒ a duplicate against a *different* order is exactly the case to catch), plus an explicit "I verified receipt" attestation. | `guard_manual_gcash_payment()`, called from `record_pickup_payment()`, `record_delivery_payment()`, and `record_additional_payment()`; backed by the `uq_payment_transactions_manual_gcash_ref` partial unique index. |
| Cash | No reference; identity is the admin-generated **idempotency key** (a stable id created once per collection attempt and resent unchanged on retry). Only legal at pickup. | `record_pickup_payment()`'s `p_idempotency_key` check against `payment_transactions.idempotency_key` (`uq_payment_transactions_idempotency_key`). |
| Internal submission id (idempotency key) | A client-generated UUID, one per *collection attempt* (double-click and dropped-response retries reuse it; a genuinely new payment gets a new one because it comes from a freshly-opened modal). | Same column/index as above, shared by `record_pickup_payment`, `record_delivery_payment`, `record_additional_payment`. |

These three identities are kept in **separate columns** and are never compared to each other: `transaction_reference` (as-entered, historical), `transaction_reference_normalized` (manual-GCash duplicate detection only), and `idempotency_key` (submission retry detection only). A PayMongo id and a manual GCash reference are never treated as interchangeable — `gcash_channel` (`'paymongo'` vs `'manual'`) tags which trust path produced a row.

**Limitation, stated plainly:** there is no reliable way to detect "the customer manually re-entered a PayMongo reference as if it were a direct transfer" or vice versa, because a PayMongo id (`pay_...`) and a GCash transfer reference are different formats from different systems with no shared identity space. The mitigations in place are (a) `guard_manual_gcash_payment` is only reachable from the manual admin RPCs, never from `reconcile_paymongo_payment_attempt` (which only service_role can call), so a PayMongo payment can never be *credited* twice this way, but (b) nothing stops an admin from typing a real `pay_...` id into the manual "GCash Transfer Reference" field for an unrelated order and having it accepted as a manual entry — the verified-receipt checkbox and the normalized-uniqueness check are the only defenses, and this is disclosed rather than claimed as a guarantee.

## 3. Database changes

Three new, additive migrations (no rewrite of applied history):

1. **`20260909010000_payment_ledger_integrity_columns.sql`** — adds `payment_transactions.idempotency_key`, `.gcash_channel`, `.transaction_reference_normalized` (all nullable; every historical row stays `NULL`), plus:
   - `uq_payment_transactions_idempotency_key` (unique, partial on `IS NOT NULL`)
   - `uq_payment_transactions_manual_gcash_ref` (unique, partial on `gcash_channel = 'manual'`)
   - a `CHECK` constraint on `gcash_channel`

2. **`20260909020000_fix_paymongo_reconciliation_idempotency.sql`** — the BUG-01 fix itself:
   - `reconcile_paymongo_payment_attempt()` now returns the existing result as a true no-op once `attempt_row.status = 'reconciled'`, checked **before** any insert, under the function's existing `SELECT ... FOR UPDATE` lock on `payment_attempts`. That row lock is what makes this safe under concurrency — Postgres serializes any two callers racing on the same `source_id`, so the second one always observes the first one's commit before deciding whether to write anything.
   - Rejects any `p_payment_id` matching `^auto_` outright (defense in depth against an un-redeployed Edge Function or a future regression).
   - A `p_payment_id IS NULL` call (a status check, not a capture) now correctly reports `order_reconciled = false` and leaves the attempt untouched, instead of marking it `'reconciled'` with no ledger row (a real, minor inconsistency found in the original function while testing it).

3. **`20260909030000_manual_payment_hardening.sql`**:
   - New `guard_manual_gcash_payment(p_reference, p_admin_verified_receipt)` — shared by all three RPCs below; requires admin, requires the verified-receipt attestation, requires a non-blank reference, normalizes it, and raises a clear error naming the conflicting order/amount/date if that normalized reference is already on file.
   - `record_pickup_payment()` and `record_delivery_payment()` gain `p_idempotency_key` and `p_admin_verified_receipt` parameters (both optional, backward-compatible — Postgres allows `CREATE OR REPLACE FUNCTION` to append new defaulted parameters without changing the function's identity or losing its existing grants).
   - `record_delivery_payment()` now **rejects `'cash'` outright** whenever money is being collected (`ERRCODE 22023`) — delivery-time settlement is always post-pickup by construction, matching the business rule.
   - Both now call `guard_manual_gcash_payment()` **unconditionally** whenever `p_amount > 0 AND payment_method = 'gcash'` (not only when a reference happens to be present) — an earlier draft of this fix only triggered the guard when a reference was already non-blank, which would have let a blank-reference GCash entry through with no verification at all. Caught by the test suite (see §6) and fixed before shipping.
   - New **`record_additional_payment()`** RPC replaces the raw client insert described in §1: admin-gated, locks the order `FOR UPDATE`, checks the idempotency key, unconditionally rejects `'cash'`, and requires `guard_manual_gcash_payment()` to pass for `'gcash'`.
   - New **`clear_payment_receipt_url()`** RPC replaces the one other direct admin write to `payment_transactions` (clearing a receipt photo reference), needed because of the next point.
   - RLS on `payment_transactions` is narrowed: the old `"Admins can insert and select payment transactions"` policy (`FOR ALL`) is replaced with **`SELECT`-only** for admins. Every write now goes through a `SECURITY DEFINER` RPC, which — as the table owner — bypasses RLS the same way the pre-existing pickup/delivery/webhook inserts already did. This directly closes "customers cannot use privileged payment-recording paths" for the one path that wasn't already gated this way, and removes the possibility of a future UI change accidentally re-introducing a raw client insert.

**Read-only pre-checks** (not migrations, run manually against the live database, never against production automatically):
- `docs/bug01-gcash-double-credit-diagnostic.sql` — finds orders where a `payment_attempts`-linked source produced more than one `payment_transactions` row, flagging the specific "synthetic reference alongside a real one within 10 minutes" shape as the likely BUG-01 signature, and reports an upper-bound ₱ figure. **Nothing is auto-corrected** — every row is a candidate for manual verification against the PayMongo dashboard, per the task's explicit instruction not to treat duplicate candidates as proven duplicates.
- `docs/manual-gcash-duplicate-precheck.sql` — checks whether any existing GCash `transaction_reference` was already reused across two ledger rows, which the new `uq_payment_transactions_manual_gcash_ref` index cannot retroactively catch (it only applies to rows that populate the new `gcash_channel`/`transaction_reference_normalized` columns, and no historical row does — the migration does not backfill them, so no historical row is relabeled).

**Neither script was run against a live database** — no live Supabase access was available in this environment (same limitation the audit itself noted). Both are ready for the team to run before deploying.

## 4. Edge Function changes

- **`supabase/functions/paymongo-webhook/index.ts`** — the `source.chargeable` "not chargeable" self-heal branch no longer calls `reconcile()` at all. It logs that a concurrent request won the capture race and returns `{ received: true, ignored: true, raced: true }`. The money is finished either by the sibling request (which has the real id from its own `POST /v1/payments` response) or by the independent `payment.paid` webhook event — both already existed and needed no new code.
- **`supabase/functions/paymongo-create-payment/index.ts`** — the `poll` action's two self-heal branches (`sourceStatus === 'paid'` and the `"not chargeable"` catch inside the `'chargeable'` branch) no longer invent a reference. Each re-reads the attempt row (the sibling may have already committed while this request was talking to PayMongo) and, if not yet reconciled, returns `{ status: 'paid', orderReconciled: false, settling: true, message: '...finalizing...' }` — an honest "confirmed by GCash, not yet in our ledger" signal instead of a fabricated credit.
- **No new PayMongo endpoint was used or invented.** PayMongo's Source resource (verified against current docs and independent corroboration) has no field linking back to a captured payment, and `List Payments` cannot be filtered by source id — so there genuinely is no way to look up "the real id for this source" from the losing side of the race. The fix is to not need one: only ever reconcile with an id obtained directly from PayMongo's own `POST /v1/payments` response or its `payment.paid` webhook payload.
- Three frontend call sites (`PaymentReturnPage.jsx`, `AdditionalPaymentModal.jsx`, `PaymentCollectionPanel.jsx`) were updated to stop treating a bare `status === 'paid'` in the poll response as proof of a completed credit — they now require `orderReconciled` (or the attempt's own `'reconciled'` status), and show the new `settling` message instead of a confusing "no payment received yet" when the ledger is still catching up.

## 5. UI changes

- **Cash removed after pickup:** `DeliveryModal.jsx` passes `allowCash: false` to the shared `PaymentCollectionPanel`, which now hides the Cash button whenever that flag is set and shows "GCash only — a remaining balance after pickup can no longer be settled in cash." `AdditionalPaymentModal.jsx` (always a post-pickup flow — see §1) drops the Cash/GCash toggle entirely. Pickup itself is untouched — cash remains a first-class option there, matching the business rule.
- **Channel labeling:** both payment components now say "Process via PayMongo — ... confirmed automatically, no verification needed" next to the automated button, and "Or record a direct GCash transfer received outside PayMongo" above the manual-reference field, so the two trust levels are visibly different rather than both just saying "GCash."
- **Verified-receipt checkbox:** a manually-entered GCash reference cannot be submitted without checking "I have personally verified that this GCash transfer was received in the business account. A reference number alone is not proof of payment." — enforced in both `PaymentCollectionPanel.jsx` (`validatePaymentCollection`) and `AdditionalPaymentModal.jsx`, and again, unconditionally, server-side.
- **Existing balance/history shown before recording:** unchanged — `OrderDetailPage.jsx` already renders the payment-transactions table and the current remaining balance above the "Record Additional Payment" button; this report did not need to add that.
- **No new "manually credit this PayMongo payment" affordance was added or exists** — the only status-check action for a pending PayMongo payment is the existing `pollPaymentStatus()`-backed "Check payment" button, which is server-verified (`paymongo-create-payment`'s `poll` action) and, after this fix, never fabricates a credit either.
- **Delivery/status actions cannot accidentally record a second payment:** unchanged and re-verified — `DeliveryModal` only ever attaches a `payment` object when `needsPayment` and `d.collected > 0`; marking an already-settled order "Delivered" sends `payment: null`. The promise-date guard in `record_delivery_payment()` (untouched) still allows delivering with an outstanding balance when a promise date is on file.

## 6. Files changed and migrations prepared

**Database (new migrations):**
- `supabase/migrations/20260909010000_payment_ledger_integrity_columns.sql`
- `supabase/migrations/20260909020000_fix_paymongo_reconciliation_idempotency.sql`
- `supabase/migrations/20260909030000_manual_payment_hardening.sql`

**Read-only diagnostics (not migrations):**
- `docs/bug01-gcash-double-credit-diagnostic.sql`
- `docs/manual-gcash-duplicate-precheck.sql`

**Edge Functions:**
- `supabase/functions/paymongo-webhook/index.ts`
- `supabase/functions/paymongo-create-payment/index.ts`

**Frontend:**
- `src/lib/database.js` (`recordPickupPayment`, `recordDeliveryPayment`, `recordAdditionalPayment` rewritten onto the new RPC, `clearPaymentReceiptUrls` rewritten onto `clear_payment_receipt_url`)
- `src/components/ui/PaymentCollectionPanel.jsx` (`allowCash` config, verified-receipt checkbox, idempotency key, channel labeling, trustworthy-signal fix)
- `src/components/ui/AdditionalPaymentModal.jsx` (cash removed, verified-receipt checkbox, idempotency key, channel labeling, trustworthy-signal fix)
- `src/components/ui/DeliveryModal.jsx` (`allowCash: false`, default method `'gcash'`)
- `src/pages/admin/OrderDetailPage.jsx`, `src/pages/admin/UnsettledDeliveriesPage.jsx` (thread `idempotencyKey`/`verifiedReceipt` through to `recordAdditionalPayment`)
- `src/pages/shared/PaymentReturnPage.jsx` (trustworthy-signal fix)

**Tests (new):**
- `scripts/payment-ledger-pgtest/harness-schema.sql`, `scripts/payment-ledger-pgtest/run.mjs` — see §7
- `package.json` — added `@electric-sql/pglite` devDependency and a `test:payment-ledger` script

## 7. Tests performed and actual results

**Environment constraint, stated up front:** this environment has no Docker/Podman and no local `psql`/`postgres` binary, so `supabase start` (which needs Docker) could not run, and no disposable/local Supabase Postgres was reachable. To still exercise the **real** SQL — not a JS re-implementation, not a mocked database call — this task used [`@electric-sql/pglite`](https://pglite.dev/), a full PostgreSQL engine compiled to WebAssembly that runs embedded in Node. `scripts/payment-ledger-pgtest/run.mjs` loads a minimal hand-built schema (`harness-schema.sql`: just `orders`/`payment_attempts`/`payment_transactions`/`profiles` plus `is_admin()`/`derive_payment_status()`/the totals trigger) and then applies the **three real migration files verbatim** from `supabase/migrations/` — the code under test is byte-for-byte what ships, not a transcription of it.

Run with `npm run test:payment-ledger`. **40 of 40 assertions passed.** Scenarios covered, mapped to the task's required failure-mode list:

| Required scenario | Result |
|---|---|
| Same successful PayMongo payment processed twice | ✅ one ledger row |
| BUG-01 synthetic-vs-real reference race | ✅ synthetic reference rejected outright; a second real-reference reconcile is a no-op |
| Webhook + polling "racing" on the same payment | ✅ one row (see concurrency caveat below) |
| Delayed/repeated webhook after success | ✅ no-op, still reports success |
| Unverified/ambiguous provider response (no payment id) | ✅ no credit, attempt left untouched |
| Failed/pending payment | ✅ no credit |
| ₱400 pickup + ₱600 later GCash = exactly ₱1,000 | ✅ two rows, total ₱1,000 |
| Two legitimate same-amount payments stay separate | ✅ not deduped by amount |
| Admin double-click / retry (idempotency key) | ✅ 3 submissions, same key → 1 row |
| A genuinely new payment gets a new key | ✅ not deduped |
| Duplicate direct GCash reference, same order | ✅ rejected (case/spacing-insensitive) |
| Duplicate direct GCash reference, different order | ✅ rejected, names the other order |
| Cash rejected after pickup | ✅ `record_delivery_payment` raises, no row written |
| Valid pickup-time cash still accepted | ✅ |
| Unauthorized (non-admin) callers rejected | ✅ both `record_pickup_payment` and `record_additional_payment` |
| Order totals consistent with the ledger | ✅ spot-checked across every order created in the run |
| Leading zeros preserved in normalized reference | ✅ `007712345678` ≠ `7712345678`; stored value unmodified |
| (found while testing) GCash amount with a blank reference | ✅ now refused — this was the gap described in §3's third bullet, caught here and fixed before shipping |

**Other checks run and passing:**
- `npm test` (full existing contract-test suite — smoke, axe-lint, token-lint, activity-log, payment-UI, booking-dirty-state, registration-transition, mobile-layout, photo-*, Apple-platform, push-notification, notification-UX): **all pass**, unchanged behavior for everything this fix didn't touch.
- `npm run build` (Vite production build): **succeeds**, no errors.
- Both edited Edge Functions individually built with `esbuild` (the same tool `scripts/edge-function-build-test.mjs` uses, which does not itself cover the `paymongo-*` functions): **both build cleanly**.

**What is explicitly NOT verified**, stated per the task's instructions rather than implied:
- **True multi-backend concurrency.** PGlite runs one embedded Postgres connection; two `.transaction()` calls issued from Node are serialized by the driver itself, not raced across independent backends. The "concurrent" tests above prove that **once Postgres's own `SELECT ... FOR UPDATE` row lock has serialized two callers** (which is standard, well-documented Postgres behavior this fix relies on but did not invent), the function's logic produces the correct idempotent result. They do not prove the lock itself behaves correctly under genuine simultaneous wire-level requests — that would need a real multi-connection Postgres server (Docker), which was unavailable here.
- **Live PayMongo behavior.** No live PayMongo call was made (per the task's constraints and this environment's lack of credentials). The `"not chargeable"` string match, the Source resource's field list, and the absence of a source→payment lookup endpoint were checked against PayMongo's current public API documentation and independent search corroboration, not a live reproduction.
- **RLS enforcement from an actual anon/customer JWT.** The pglite harness models authorization via `is_admin()` reading a `profiles` row keyed by a session variable standing in for `auth.uid()`, which correctly exercises every RPC's own `IF NOT is_admin() THEN RAISE EXCEPTION` check — but the *Postgres RLS policy* change (narrowing `payment_transactions` to admin-`SELECT`-only) was not separately exercised against Supabase's real RLS engine, since the harness doesn't implement RLS. The policy SQL was reviewed by hand against the existing, working customer-`SELECT` policy it sits beside.
- **Browser/UI behavior.** No browser was available in this environment. The UI changes were verified by reading the modified components, running the existing Vitest-free `payment-ui-contract-test.mjs` (which passes, unchanged), and a full `vite build` (which succeeds) — not by clicking through a running app. The task's instruction to test UI changes in a browser before calling them done could not be completed here; this is disclosed rather than skipped silently.

## 8. Historical-data checks and unresolved risks

- **No historical row was altered, relabeled, or deleted.** The three new `payment_transactions` columns are `NULL` on every existing row and stay that way — nothing is backfilled.
- `docs/bug01-gcash-double-credit-diagnostic.sql` and `docs/manual-gcash-duplicate-precheck.sql` are ready to run against the live database but were **not run here** (no live access). Until they are run, it is unknown whether BUG-01 has already double-credited a real order, or whether a manual GCash reference has already been reused historically. Both are explicitly read-only and produce candidates for manual review, not automatic conclusions.
- **Cross-channel duplicate detection is not, and cannot be, a guarantee** — see the limitation called out at the end of §2. This is a disclosed risk, not a fixed one.
- The webhook's replay-protection gap noted in the audit as SUS-01 (no signature-timestamp age check, no event-id dedup) was **not addressed** — it is out of this task's scope, and the reconcile-level idempotency fix already absorbs a redelivered *identical* `payment.paid` event safely (tested above), which was the main residual risk SUS-01 called out.

## 9. What is fixed locally vs. what remains undeployed

Everything in this report is a **local repository change only**. Per the task's explicit constraint, **no migration was applied to any database, no Edge Function was deployed, and no real payment was processed.** All of the above exists as:
- three new migration files (not yet run against any Postgres instance other than the disposable PGlite harness),
- two edited, but not deployed, Edge Functions,
- edited frontend source, verified only by build + the existing non-browser contract-test suite.

## 10. Deployment order and compatibility

1. Run `docs/bug01-gcash-double-credit-diagnostic.sql` and `docs/manual-gcash-duplicate-precheck.sql` against the live database first (read-only) and review any candidates with the team before proceeding.
2. Apply the three migrations **in order** (`20260909010000` → `20260909020000` → `20260909030000`) — `020000` and `030000` both depend on the columns `010000` adds, and `030000`'s `record_pickup_payment`/`record_delivery_payment` changes depend on `020000` only insofar as they share the same fixed baseline (no hard dependency, but keep the order for clarity).
3. Deploy `paymongo-webhook` and `paymongo-create-payment` — safe to deploy before or after the migrations, since both old and new Edge Function code call the same RPC signature (`reconcile_paymongo_payment_attempt` gained no new required parameter). Deploying the migrations first is slightly preferable: it closes the ledger-level gap even if a stale Edge Function version is still self-healing with a synthetic reference for a few minutes during rollout.
4. Deploy the frontend build. It depends on `record_additional_payment` and `clear_payment_receipt_url` existing — deploy migration `030000` before the frontend, not after, or the "Record Additional Payment" button and receipt-clearing action will fail against a database that doesn't have those functions yet.
5. **Trip-capacity (BUG-03) and activity-log-retry (BUG-04) fixes already exist in this repository's git history** (commits `63c6018` and `16bef32`), from earlier work on the same audit report — this task did not touch either, and confirmed no overlap with the payment functions changed here (`guard_order_update()` vs. the payment RPCs are disjoint). They are called out here only so a reviewer isn't surprised to see them in the same branch.

## 11. Rollback

- **Migrations:** `030000` and `020000` each `CREATE OR REPLACE` an existing function — rolling back means re-applying the *previous* function body (available in `git show <commit>~1:supabase/schema.sql` or by reverting the migration file and re-running the old `CREATE OR REPLACE`). `010000`'s new columns and indexes can be dropped with `DROP INDEX`/`ALTER TABLE ... DROP COLUMN` if needed — since nothing is backfilled, dropping them loses no historical data, only the (empty, until this fix is live) forward-going dedup metadata.
- **RLS policy:** the narrowed `payment_transactions` policy can be reverted to the prior `FOR ALL` policy in one statement (both are captured in `030000`'s own comments) if a rollback of the RPC-only-write model is needed — though doing so without also reverting `record_additional_payment`/`clear_payment_receipt_url` would just reopen the original raw-insert gap.
- **Edge Functions:** redeploying the previous `paymongo-webhook`/`paymongo-create-payment` versions is safe at any time relative to the migrations — the old self-heal code calls the same RPC with the same argument types; it would simply reintroduce BUG-01's window (mitigated, not eliminated, by the DB-level fix, since the DB fix alone already stops the *second* insert — rolling back the Edge Functions reopens the synthetic-reference *first* insert, which the reconcile fix accepts as a real payment because nothing on the DB side can tell a syntactically-plausible fake reference from a real one other than the `^auto_` pattern match, which is retained regardless of the Edge Function version deployed).
- **Limitation:** there is no automated rollback script — this is a manual, reviewed process consistent with how the rest of this repository's migrations are rolled back (no rollback tooling exists elsewhere in `supabase/migrations/` either).

## 12. Defense-demo steps (using test payments only)

All of the following can be run today with `npm run test:payment-ledger` (no live database or real money needed):

1. **Reproduce the original bug against the OLD logic** (optional, to see the failure): temporarily revert `reconcile_paymongo_payment_attempt()`'s "already reconciled" short-circuit in `20260909020000_...sql`, rerun the harness — the "BUG-01 synthetic-vs-real reference race" scenario will fail (two rows, ₱2,000 instead of ₱1,000). Restore the file afterward.
2. **See the fix hold:** `npm run test:payment-ledger` with the current code — scenario "BUG-01 synthetic-vs-real reference race" passes, confirming one ledger row and the correct total after a synthetic reference is rejected and a real one is reconciled twice.
3. **See the admin-side fix:** the "GCash amount at delivery with a BLANK reference is refused" scenario demonstrates the gap found and closed in §3 (third bullet) — an admin RPC call carrying `payment_method: 'gcash'`, an amount, and no reference is refused rather than silently credited.
4. **See cash correctly split by pickup vs. delivery:** "valid pickup-time cash still accepted" passes and "cash rejected after pickup" passes in the same run, proving the rule is enforced at the right boundary, not blanket-disabled.

---

## Summary

**Fixed:** the confirmed BUG-01 double-credit (synthetic `auto_` reference racing a real PayMongo id) via a true idempotency short-circuit in `reconcile_paymongo_payment_attempt()` plus removing the reference-inventing self-heal logic from both Edge Functions; the previously-undocumented raw-insert gap in the "Record Additional Payment" flow, replaced with a locked, idempotent RPC; cash now rejected server-side for any post-pickup balance settlement; manual GCash transfers now require admin verification and are checked for reuse (normalized, cross-order) via a real unique index; admin submissions (pickup, delivery, additional payment) are now protected against double-click/retry via a client-generated, retry-stable idempotency key.

**Tested:** 40 scenarios against the actual migration SQL running on a real embedded Postgres (PGlite), covering every required failure mode except true multi-backend lock contention and live PayMongo behavior; the full existing `npm test` suite and `npm run build` both pass unchanged.

**Unverified / disclosed limitations:** true concurrent multi-connection Postgres behavior (no Docker/Postgres server available — relies on standard, well-documented `FOR UPDATE` semantics rather than a fix-specific invariant); live PayMongo API responses; RLS enforcement under a real Supabase JWT; and a fundamental, disclosed limit on cross-channel (PayMongo vs. manual) duplicate detection, since the two reference formats share no common identity.

**Report path:** `PAYMENT_DUPLICATE_PREVENTION_FIX.md` (this file).

No production migration was applied, no Edge Function was deployed, and no real payment was processed — all repository work is complete and locally verified; the remaining steps (§10) are the deployment action items for the team.
