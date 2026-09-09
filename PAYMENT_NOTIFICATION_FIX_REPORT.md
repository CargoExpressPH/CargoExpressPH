# Payment Confirmation Notification Fix (BUG-02)

**Date:** 2026-09-09
**Scope:** Whether a successful/recorded payment produces a customer-facing "payment received" notification, across all payment-recording paths — pickup (cash or GCash), a direct GCash transfer verified by an admin, an automatic PayMongo GCash capture, and the "Record Additional Payment" balance-settlement flow.
**Starting point:** `SYSTEM_MODULE_BUG_AUDIT.md`'s BUG-02 ("No customer notification is ever sent for a successful or recorded payment"). Per the task's explicit instruction, this was **re-verified against the current code, not assumed** — see §1. The audit's snapshot predates a large amount of notification-infrastructure work already in this repository's git history; BUG-02 turned out to be **already substantially fixed**, and this task closes the two concrete gaps that re-verification found.

---

## 1. Re-verification: is BUG-02 still present?

The audit (schema snapshot dated 2026-09-01) found zero notification writes anywhere in the payment path. That is no longer true. Between 2026-09-04 and 2026-09-05, six migrations already in this repository (`20260904235457_complete_push_delivery_system.sql`, `20260904235511_secure_push_registrations_and_policies.sql`, `20260904235517_server_notification_event_coverage.sql`, `20260905003149_...`, `20260905051734_...`, and three successive `..._improve_..._payment_notification_copy.sql` edits) built:

- A **durable, transactional push outbox**: `public.notification_delivery_jobs`, fanned out from a single `AFTER INSERT ON public.notifications` trigger (`private.enqueue_notification_delivery_jobs()`), claimed/completed via `claim_notification_delivery_jobs()` / `complete_notification_delivery_job()`, drained every minute by the `process-push-deliveries` Edge Function via `pg_cron`.
- A `'payment_update'` notification type, added to `notifications.type`'s `CHECK` constraint.
- **`private.notify_payment_recorded()`** — a trigger function on `public.payment_transactions`, firing `AFTER INSERT ... FOR EACH ROW`, that already:
  - skips rows whose `payment_status` isn't `'paid'`/`'partial'`,
  - skips orders with no linked customer (`v_order.user_id IS NULL`),
  - reads the order's `remaining_balance` **after** the ledger-totals trigger has recomputed it (see §4 for why this ordering is guaranteed, not assumed),
  - titles the notification `'Payment Complete'` or `'Payment Received'` depending on whether the balance reached zero.
- Frontend integration already complete: `notifications.type = 'payment_update'` has an icon (`ReceiptText`) and color in both `src/pages/customer/NotificationsPage.jsx` and `src/components/ui/AdminNotificationCenter.jsx`, and `src/lib/notification-routing.js` already routes a `payment_update` click to `/customer/orders/{reference_id}` (`reference_id` = the order id). RLS on `notifications` already restricts `SELECT` to `user_id = auth.uid() OR is_admin()`.

**Verified live** (queried the linked Supabase project directly, not assumed from the repo): `notify_payment_recorded()`, the outbox trigger, the type constraint, and the RLS policies are all live in production today, matching the repository exactly.

**What re-verification found still missing**, checked against this task's explicit business rules and failure-mode list:

1. **No database-level uniqueness ties a notification to the specific payment that caused it.** `notify_payment_recorded()` inserts with `reference_id = order.id` (needed for the click-through route above) but nothing keys the insert to `payment_transactions.id`. Today this is safe only because the ledger itself never inserts more than one row per logical payment (the BUG-01 fix + the idempotency-key/manual-GCash-reference guards). The task asks that this be "enforced atomically in the database," not merely implied by upstream ledger hygiene — i.e. a *second* trigger accidentally left registered on `payment_transactions`, or a future `AFTER UPDATE` variant, should not be able to double-notify even by accident.
2. **The message never says how the customer paid.** The business rules distinguish three channels a customer should be able to tell apart (cash at pickup; a direct GCash transfer the admin verified; GCash via PayMongo, verified automatically), and the task explicitly asks for a "customer-friendly payment method" in the message. `payment_transactions.payment_method` / `.gcash_channel` (added 2026-09-09 for BUG-01) already carry this; the trigger just never read them.

Nothing else on the required list was found broken: amount-of-this-payment vs. cumulative, tracking number, balance-after-this-payment, zero-payment actions, failed/pending/unverified payments, cross-customer access, no-device handling, one-notification-fans-out-to-many-devices, and push-failure isolation from the ledger were all already correct — see the "Checks performed" and "Requirements verified without a code change" tables in §5 and §8.

---

## 2. Chosen notification creation point (and why it was *not* changed)

The task asked to choose between a ledger-insert trigger and centralized payment-RPC logic, and to avoid overlapping writers across frontend/webhook/RPC/trigger. The codebase had already made this choice correctly, and this fix preserves it rather than introducing a second design:

- **Every** payment-recording path — `reconcile_paymongo_payment_attempt()` (PayMongo), `record_pickup_payment()`, `record_delivery_payment()`, `record_additional_payment()` — funnels through exactly one place: an `INSERT INTO public.payment_transactions`. None of them, and no frontend code, writes to `public.notifications` directly (confirmed by grep: zero `createNotification`/`INSERT INTO notifications` calls outside the trigger functions in `private.*`).
- A single `AFTER INSERT ... FOR EACH ROW` trigger on `payment_transactions` is therefore the one place that can see every payment, regardless of which RPC or Edge Function recorded it, without four copies of the same notification logic drifting out of sync in four different RPCs.
- It is also the only design that survives the future addition of a fifth payment path "for free" — a new RPC only has to insert into the ledger correctly; it does not have to remember to also write a notification.

**This fix keeps that design and does not add any new writer.** The change is entirely inside `private.notify_payment_recorded()` and a supporting column/index — no frontend, RPC, or Edge Function code was touched.

---

## 3. How duplicate notifications are prevented

Two independent layers, matching the task's ask for something stronger than "the ledger happens to be deduped":

1. **Upstream (unchanged, not weakened):** the ledger itself only ever produces one `payment_transactions` row per logical payment — a redelivered PayMongo webhook or a concurrent capture race short-circuits inside `reconcile_paymongo_payment_attempt()`'s "already reconciled" check (BUG-01 fix) before any insert is attempted; a double-clicked admin submission short-circuits on `idempotency_key` before any insert; a duplicate manual GCash reference is rejected by `guard_manual_gcash_payment()`/the partial unique index. Since `AFTER INSERT` triggers only fire for rows that are actually inserted (a conflicting `INSERT ... ON CONFLICT DO NOTHING` fires no trigger), the notification trigger can only ever run once per real payment today.
2. **New, atomic, in the database (this fix):** `notifications` gained a `payment_transaction_id UUID REFERENCES payment_transactions(id)` column with a **plain `UNIQUE` index**. `notify_payment_recorded()` now inserts `payment_transaction_id = NEW.id` with `ON CONFLICT (payment_transaction_id) DO NOTHING`. This makes "one payment → at most one notification" a hard database invariant instead of an emergent property of layer 1 — verified directly in the test suite (§6) by bypassing the trigger entirely and attempting a second raw `INSERT` for the same `payment_transactions.id`, which the constraint refuses.

A plain (non-partial) unique index was used deliberately: under standard SQL semantics, `NULL` values never conflict with each other or with anything else, so every other notification type (which never sets this column) is completely unaffected, and no `WHERE` predicate is needed on the index or the `ON CONFLICT` target.

**A legitimate second payment on the same order still gets its own notification** — trivially, since `payment_transaction_id` is derived from a fresh `payment_transactions.id` (a `gen_random_uuid()` primary key) for each real payment; there is nothing to deduplicate between two distinct rows. Verified explicitly in the test suite (two ₱500 payments on one order → two notifications, two different `payment_transaction_id` values).

---

## 4. How correct amounts and balances are obtained

- **This payment's amount**, not cumulative: read directly from `NEW.amount` on the ledger row that just committed — never re-derived from a running total.
- **Remaining balance after this payment**, not stale: `payment_transactions` has three `AFTER INSERT` triggers, and **Postgres fires same-timing triggers on one table/event in alphabetical order by trigger name** — this is documented Postgres behavior the existing code already relies on (see the comment inside `20260905223244_improve_payment_notification_copy.sql`), re-confirmed here by inspecting the live trigger names directly rather than assumed:
  1. `payment_transactions_log_activity` (writes only to `activity_logs`)
  2. `trigger_update_totals_after_payment` (`update_order_payment_totals()` — recomputes and writes `orders.amount_paid` / `.remaining_balance` / `.payment_status` from a fresh `SUM(...)` over the ledger)
  3. `zz_payment_transactions_notify_customer` (this fix's trigger — the `zz_` prefix is deliberate so it always sorts last)

  So by the time `notify_payment_recorded()` runs its own `SELECT * FROM orders WHERE id = NEW.order_id`, the balance it reads is already current — for both a single payment and a concurrent one, since every insert path takes `SELECT ... FOR UPDATE` on the order row *before* it ever inserts into the ledger, serializing any two payments racing on the same order.
- **Customer-friendly payment method** (the actual gap fixed here): derived from `NEW.payment_method` (`'cash'`/`'gcash'`) and `NEW.gcash_channel` (`'manual'`/`'paymongo'`/`NULL`), which already exist on every ledger row (added in the BUG-01 migrations): `'cash'` → *cash*, GCash + `gcash_channel = 'manual'` → *GCash transfer*, GCash + `gcash_channel = 'paymongo'` (or any other GCash row) → *GCash*. This mirrors the two trust levels already visible in the admin UI ("Process via PayMongo" vs. "record a direct GCash transfer").
- No transaction reference, phone number, or other PII is included in the message — matching the existing, unmodified message design.

---

## 5. Database changes

One new, additive migration: **`supabase/migrations/20260909120000_payment_confirmation_notification_hardening.sql`**.

- `ALTER TABLE notifications ADD COLUMN payment_transaction_id UUID REFERENCES payment_transactions(id) ON DELETE SET NULL;` — nullable, so every historical row (and every non-payment notification going forward) is untouched.
- `CREATE UNIQUE INDEX notifications_payment_transaction_key ON notifications (payment_transaction_id);`
- `CREATE OR REPLACE FUNCTION private.notify_payment_recorded()` — same signature, same trigger name/timing, rewritten body: adds the payment-method label, sets `payment_transaction_id = NEW.id`, and adds `ON CONFLICT (payment_transaction_id) DO NOTHING` to the insert. Message copy changed from *"We received your payment of ₱X for order Y..."* to *"We recorded your ₱X {method} payment for order Y..."*, matching this task's suggested wording while keeping the existing "order" terminology (not "shipment") for consistency with every other notification type in the app.
- `DROP TRIGGER IF EXISTS ... ; CREATE TRIGGER zz_payment_transactions_notify_customer ...` re-declared so the migration is self-sufficient to read in isolation, even though replacing the function alone would already take effect.

No table is rewritten, no historical `notifications` or `payment_transactions` row is modified, and no backfill is performed — a customer who already has old payment notifications (from before `payment_transaction_id` existed) simply has `NULL` in that column, which is fine under a plain unique index (see §3) and is never turned into a new notification.

## 6. Backend and frontend changes

**None**, beyond the one migration above. Every other piece the task asked to verify — RPC dedup, RLS, push outbox, icons, click-through routing, unread counts — was already correct and is reused unchanged (see §1). No `.jsx`/`.js` file was edited for this task.

## 7. Files changed

- `supabase/migrations/20260909120000_payment_confirmation_notification_hardening.sql` (new)
- `scripts/payment-notification-pgtest/notification-harness-additions.sql` (new — test harness)
- `scripts/payment-notification-pgtest/run.mjs` (new — test suite, 41 assertions)
- `package.json` (new `test:payment-notifications` script)
- `PAYMENT_NOTIFICATION_FIX_REPORT.md` (this file)

---

## 8. Tests performed and results

**Environment constraint** (same as the BUG-01 fix): no Docker/local Postgres in this environment, so the real migration files were run against [`@electric-sql/pglite`](https://pglite.dev/) — a full Postgres compiled to WASM, embedded in Node — not a JS reimplementation.

**Harness design:** `scripts/payment-notification-pgtest/notification-harness-additions.sql` layers on top of the existing `payment-ledger-pgtest` harness. Every function body in it (`enqueue_notification_delivery_jobs`, `claim_notification_delivery_job(s)`, `complete_notification_delivery_job`) is a **verbatim copy of what is live in production today**, fetched directly from the linked Supabase project via `pg_get_functiondef` on 2026-09-09 — not re-typed from a migration file, and not reimplemented. Only table shapes are hand-built, to avoid pulling in unrelated modules (chat, trips, announcements, `pg_cron`/`vault`/`net`) that the real historical migrations touch but this task does not need. `run.mjs` then applies the **three real BUG-01 migration files plus the new BUG-02 migration file verbatim** (`readFileSync` + `db.exec`, exactly like `payment-ledger-pgtest` already does), so the code under test is byte-for-byte what ships.

Run with `npm run test:payment-notifications`. **41 of 41 assertions passed.** Every scenario the task listed:

| Required scenario | Result |
|---|---|
| A successful payment creates exactly one in-app notification | ✅ (pickup cash, and separately a full PayMongo capture) |
| A repeated payment request creates no additional notification | ✅ (same idempotency key, 3 submissions → 1 notification) |
| A repeated/redelivered webhook creates no additional notification | ✅ (same PayMongo id redelivered twice → 1 notification) |
| Concurrent processing of the same payment still creates one notification | ✅ (`Promise.all` of two identical `reconcile` calls) |
| Two legitimate payments create two notifications, even if amounts match | ✅ (two ₱500 payments, two notifications, two distinct `payment_transaction_id`s) |
| Partial and full payments show correct amounts and remaining balances | ✅ (asserted on message text: this-payment amount, remaining balance, "fully paid" wording) |
| Failed/pending/unverified/zero-payment actions create no confirmation | ✅ (four separate scenarios: no `payment_id`; unverified manual GCash rejected before the ledger insert; promise-date-only pickup with ₱0 collected) |
| The correct customer receives the notification | ✅ (two different customers, two different orders, checked both ways; confirmed the recording admin gets none) |
| A customer cannot access another customer's notification | ✅ **exercised via real Postgres RLS**, not assumed — see note below |
| No registered device still results in an in-app notification | ✅ (notification exists; its one delivery job is a terminal `'skipped'` row, not a stuck retry) |
| Push failure leaves the payment intact and delivery retryable | ✅ (claim → complete with `outcome='retry'` → ledger row count/amount unchanged, job rescheduled into the future) |
| Notification navigation / unread behavior with the chosen type | ✅ code-inspected (§1) — `notification-routing.js` and the icon maps already handle `payment_update`; not re-tested here since untouched |
| One notification fans out to multiple devices, not duplicated in-app | ✅ (2 devices → 1 notification row, 2 delivery-job rows) |
| Retries don't create duplicate delivery jobs for the same notification+device | ✅ (3 claim/retry cycles → still exactly 1 job row, `attempt_count` incrementing) |
| Duplicate prevention is enforced *atomically in the database* | ✅ — a raw `INSERT` bypassing the trigger entirely, for the same `payment_transactions.id`, is refused by the `ON CONFLICT (payment_transaction_id) DO NOTHING` clause (this is the one assertion that tests the constraint itself rather than the trigger's normal behavior) |

**RLS note:** the BUG-01 test harness explicitly disclosed that PGlite's default connection runs as the Postgres superuser, which bypasses RLS entirely — so that harness never exercised RLS for real. This suite's RLS test does exercise it for real: `asUser()` was changed to `SET LOCAL ROLE authenticated` (or `service_role`) inside each test transaction, in addition to the existing `app.uid`/`app.role` GUCs the RPCs' own `auth.uid()` stand-in reads. This was verified independently (a throwaway `USING (false)` policy correctly hid rows once the session actually became a non-superuser role) before relying on it. Every RPC called this way is `SECURITY DEFINER` and still runs with its definer's privileges regardless, so this only affects the raw `SELECT` the RLS test itself issues — exactly what needed to change to make that one assertion real.

**Other checks run and passing, no regressions:**
- `npm run test:payment-ledger` (the BUG-01 suite, unmodified): **40/40 still pass** — confirms this task did not weaken the payment duplicate-prevention fix, as instructed.
- `npm test` (full existing contract-test suite: smoke, axe-lint, token-lint, activity-log, payment-UI, booking-dirty-state, registration-transition, mobile-layout, photo-*, Apple-platform, push-notification, notification-UX): **all pass, unchanged** — expected, since no frontend or shared-library file was touched.
- `npm run test:edge-functions` and `npm run build` (Vite production build): **both pass**.

**What is explicitly NOT verified**, stated per the task's instructions rather than implied:
- **True multi-backend concurrency** and **live PayMongo/FCM/APNs behavior** — same disclosed limitation as the BUG-01 report; nothing about this fix changes that.
- **Live push delivery** (an actual device receiving a push): the outbox mechanics (claim/complete/retry/skip, fan-out, dedup) were exercised against the real RPCs; the Edge Functions (`process-push-deliveries`, `send-push`) that call an external provider were not invoked, since doing so would require live credentials and would risk sending an actual notification — out of scope per the task's "do not send actual customer notifications" instruction.
- **Browser click-through**: no browser was available in this environment; `notification-routing.js`'s existing `payment_update` case was verified by reading it, not by clicking a rendered notification.

---

## 9. Prepared but unapplied migrations, and deployment order

`20260909120000_payment_confirmation_notification_hardening.sql` is a **local repository file only** — it has not been applied to any database. It depends on:
- `payment_transactions` already existing with an `id` primary key (baseline schema — already live).
- Nothing from `20260909030000_manual_payment_hardening.sql` (the BUG-01 hardening migration) directly, but that migration is also not yet live (confirmed by querying `supabase_migrations.schema_migrations` on the linked project directly: `20260909010000` and `20260909020000` are applied live; `20260909030000` and this new `20260909120000` are not).

Recommended order, extending the BUG-01 report's own deployment plan:
1. Run the two read-only BUG-01 diagnostics (already done in the prior session — both came back clean).
2. Apply `20260909030000_manual_payment_hardening.sql` (BUG-01, not yet live).
3. Apply `20260909120000_payment_confirmation_notification_hardening.sql` (this fix). It has no ordering dependency on step 2 beyond both being new files in the same migration directory — `payment_transaction_id` only needs `payment_transactions.id`, which has existed since the original schema.
4. No Edge Function or frontend deployment is required for this fix specifically.

## 10. Remaining limitations

- The new `payment_transaction_id` unique constraint protects against a **future** accidental double-registration of the notify trigger; it does not add a second, independent check on whether the *ledger itself* is correctly deduplicated — that guarantee is entirely BUG-01's, and this task was explicitly told not to weaken or duplicate it.
- Cross-channel ambiguity (a real PayMongo id typed into the manual-reference field) remains the disclosed, unfixable limitation from the BUG-01 report — unchanged here, and orthogonal to notifications.
- Exactly-once *external* push delivery is not promised, matching the task's instruction — `notification_delivery_jobs` guarantees exactly one **job row** per notification/device and retries with backoff, but a provider that accepts a push and then fails to deliver it is outside this system's visibility.
- SMS/email delivery was not added, per the task's explicit instruction not to.

## 11. Defense-demo steps (test-mode only, no live payments)

All of the following run with `npm run test:payment-notifications` (no live database, push provider, or real money needed):

1. **See a payment produce a notification with the right details:** the first scenario in the suite records a ₱400 cash pickup payment on a ₱1,000 order and asserts the notification says "₱400.00 cash" and "Remaining balance: ₱600.00" — run the file and read that block's `ok` lines.
2. **See the channel label change:** the third scenario shows the same order settled by a manual GCash transfer (labeled "GCash transfer" in the message) versus a separate order settled by an automatic PayMongo capture (labeled plain "GCash").
3. **See duplicate prevention hold at the database level, not just in application logic:** the last scenario directly attempts a second raw `INSERT INTO notifications` for a `payment_transactions.id` that already has one, bypassing the trigger entirely, and shows the row count stays at one.
4. **See a push failure not touch the payment:** the "push failure" scenario claims a delivery job, marks it `retry`, and asserts the payment ledger's row count and total are byte-for-byte unchanged before and after.

---

## Summary

**Fixed:** the two concrete gaps BUG-02 still had after re-verification — no database-enforced tie between a notification and the specific payment that caused it, and no customer-friendly payment method in the message — via one additive migration (`payment_transaction_id` + unique index + a rewritten trigger function). No frontend, RPC, or Edge Function code changed, because the rest of BUG-02 (notification type, RLS, icons, click routing, the durable push outbox, no-device handling, multi-device fan-out) was already correctly built in this repository before this task began.

**Tested:** 41 scenarios against the actual migration SQL running on a real embedded Postgres (PGlite), covering every required case in the task's validation list, including a genuine (non-superuser) RLS enforcement check. The existing 40-scenario BUG-01 suite, the full `npm test` contract suite, the edge-function build check, and `npm run build` all still pass unchanged.

**Unverified / disclosed:** true multi-backend lock contention, live push-provider delivery, and browser click-through — consistent with this environment's limitations, not silently skipped.

**Report path:** `PAYMENT_NOTIFICATION_FIX_REPORT.md` (this file).

No production migration was applied and no notification was sent to a real customer — all work is a local repository change, verified against a disposable in-memory Postgres and the live database's *read-only* current-state queries only.
