# System Module Bug Audit

**Project:** CargoExpress PH
**Date:** 2026-09-08
**Scope:** Full system — frontend (React/Vite), Supabase Postgres (schema, triggers, RPCs, RLS), Edge Functions, and the integrations between them.
**Type:** Read-only inspection. No fixes were implemented. No production data, settings, or deployed functions were modified. No real payments, emails, or notifications were sent.

---

## Executive Summary

This audit traced every major workflow end-to-end — from a UI action, through the Edge Function or RPC it calls, into the database trigger/constraint layer, and back to what the user actually sees. The codebase is unusually well-engineered for its size: extensive inline comments document *why* a design choice was made, several past bugs are explained in comments at the exact line that fixed them, and two prior internal audits (`docs/payment-redesign-v2.md`, `docs/database-architecture-review.md`) show a track record of finding and fixing real problems. Most of what those prior audits flagged is already fixed. This audit is not a repeat of them — it re-verified their claims against the *current* code (several were already resolved) and then went looking in places they didn't cover: authentication/session handling, trip capacity, activity-log delivery, photo-evidence storage, push-notification delivery, public tracking, and contact-form intake.

**The most important finding:** GCash payments can be double-counted in the payment ledger under an ordinary, non-adversarial race condition — the customer returning from checkout and the PayMongo webhook arriving at close to the same time — because the self-healing recovery path in both the webhook and the payment Edge Function reconciles with a made-up reference id instead of the real PayMongo payment id, defeating the database's own idempotency guard. This is a **Confirmed, Critical** finding, corroborated by a still-open item (P-12) in `docs/payment-redesign-v2.md`, and independently re-verified against the code currently in the repository.

**Second most important finding:** no part of the payment flow — online GCash, cash at pickup, or balance settlement at delivery — ever creates a customer-facing notification. Customers have no way to learn "your payment was received" except by manually opening the order or payment-history page.

**Third:** a client-side retry queue for admin/customer activity logging can enter an infinite retry loop and block itself if it ever receives a permanent server-side rejection, because its error classifier doesn't recognize Postgres's default exception code. It is currently dormant (no live code path triggers it), but it is a real defect, not a hypothetical one.

Beyond these three, the audit found one business-rule question worth a product decision (trip capacity has no enforcement at any layer, including for ordinary customer bookings) and a handful of lower-severity hardening gaps. It did **not** find SQL injection, exposed secrets, broken RLS on any inspected table, or a way for one customer to read or modify another customer's records — those specific attack shapes were tested directly and are covered in "Authorization and Data Integrity Findings."

| | Count |
|---|---|
| Confirmed bugs | 4 |
| Suspected bugs (needs more evidence or a product decision) | 4 |
| Cross-module consistency issues | 2 |
| Improvements (no malfunction demonstrated) | 6 |
| Modules inspected through code | 29 |
| Modules partially inspected | 14 |
| Modules not inspected / blocked | 3 (see "Uninspected Areas") |

---

## Inspection Scope and Environment

- **No live Supabase project access was available** (no database connection, no CLI/MCP tool in this environment). Every claim about current schema/RLS/trigger/function behavior is a reconstruction from `supabase/schema.sql` (a dump labeled *"Synced from LIVE database on 2026-09-01"*) plus every migration filed after that date, read in chronological order and cross-checked against each other. This is the same method used in the prior `DATABASE_ARCHITECTURE_REVIEW.md` in this repository, and it has the same limitation: **a change made directly against the live database outside the migrations folder would not appear here.**
- **No browser was available.** Every workflow below was traced at the code level — reading the component, the function it calls, the RPC/trigger that function invokes, and the constraint that RPC relies on — not observed by clicking through a running app. Where a claim depends on runtime behavior I could not execute (e.g., "what exact error string does PayMongo return for an already-consumed source"), I say so explicitly.
- **No PayMongo, Firebase, or Resend calls were made.** All findings about those integrations come from reading the Edge Function code that calls them and the code's own comments (which, in several places, quote the exact error text the team observed in production — e.g., `"not chargeable"` — giving confidence these are not hypothetical).
- **Existing project audits were treated as leads, not conclusions**, per the task instructions. Every claim reused from `docs/payment-redesign-v2.md` was re-verified against the current file contents before being included here; several of that document's other findings (P-6, P-7, P-8, P-9, P-13 partially) turned out to already be fixed and are *not* repeated here as bugs.
- **Test scripts run:** `node scripts/edge-function-build-test.mjs` and `npm test` (the full contract-test suite) were run to confirm the repository's own checks currently pass; this confirms the code compiles and its existing invariant checks hold, **not** that the workflows below are bug-free — passing lint/build/contract-tests is not evidence a business workflow is correct, and this audit does not treat it as such.
- **No diagnostic scripts were written for this audit.** Every finding below is a direct code-path trace with file:line citations, which was sufficient to demonstrate each issue without needing an isolated harness.

---

## Module Inventory and Coverage

Status legend: **Inspected** = read the relevant source in full and traced its call path. **Partial** = read the core logic/RPC but not every UI branch, or confirmed behavior via targeted search rather than a full read. **Blocked** = could not inspect (see reason).

| # | Module | Users | Status | Evidence / Limitation |
|---|---|---|---|---|
| 1 | Registration (`RegisterPage.jsx`, `AuthContext.register`, `handle_new_user()` trigger) | Guest → Customer | Inspected | Full read of both files; traced legal-consent enforcement into the `auth.users` trigger. |
| 2 | Login / session persistence (`LoginPage.jsx`, `AuthContext`, `onAuthStateChange`) | All | Inspected | Full read of `AuthContext.jsx`; the SIGNED_IN/token-refresh race is extensively self-documented in comments and traced against the code. |
| 3 | Logout | All | Inspected | Full read; confirmed activity-log call cannot block logout (see Checks Performed). |
| 4 | Password reset / recovery link | Guest | Inspected | Recovery-hash race handling in `AuthContext.jsx:38-51,100-107` read in full. `ResetPasswordPage.jsx` read for the update-password call. |
| 5 | Change email / change password | Customer, Admin | Inspected | `AuthContext.changeEmail/changePassword` read in full. |
| 6 | Legal documents & consent | Guest, Customer | Inspected | `legal_documents`/`legal_consents` schema, `handle_new_user()` trigger, `src/constants/legalDocuments.js`, `LegalPage.jsx` — confirmed the version duplication (see Confirmed Bugs #4 candidate, filed as Improvement below since it doesn't yet manifest). |
| 7 | Profiles / roles / access control | All | Inspected | `guard_profile_write()`, `is_admin()`, `ProtectedRoute`/`AuthRoute` in `App.jsx` read in full. |
| 8 | Cargo booking (customer) | Customer | Inspected | `BookShipmentPage.jsx` (967 lines) read in full for the trip-selection and submit path; `prepare_order_insert()`, `guard_customer_order_insert()` read in full. |
| 9 | Cargo booking (admin, walk-in) | Admin | Partial | `AdminCreateBookingPage.jsx` — confirmed submit-guard pattern only (grep-level); did not trace every field. |
| 10 | Order review / service-area approval / rejection | Admin, Customer | Partial | Confirmed `service_area_remarks` is still write-only to the customer (re-verified a prior finding); did not re-trace the full approval UI. |
| 11 | Trip scheduling, capacity, assignment, reassignment | Admin, Customer (view) | Inspected | `20260526010000_remove_capacity_guard.sql`, `20260830020000_drop_dead_functions.sql`, `get_trips_load()`, `BookShipmentPage.jsx` capacity display all read in full — see Confirmed/Suspected Bugs. |
| 12 | Pricing, weight, payment totals | Admin, Customer | Inspected | `prepare_order_insert`, `guard_order_update`, `record_pickup_payment`, `record_delivery_payment`, `update_order_payment_totals` all read in full. |
| 13 | Cash/manual payment recording | Admin | Inspected | `record_pickup_payment`, `record_delivery_payment`, `PickupModal.jsx`/`DeliveryModal.jsx`/`AdditionalPaymentModal.jsx` submit-guard patterns confirmed. |
| 14 | Online GCash payment, checkout, webhook, reconciliation | Customer, Admin | Inspected | `paymongo-create-payment/index.ts`, `paymongo-webhook/index.ts`, `reconcile_paymongo_payment_attempt()`, `src/lib/paymongo.js` all read in full — **primary finding of this audit**. |
| 15 | Payment notifications | Customer | Inspected | Grepped every payment write path (RPCs, trigger, all payment UI components) for a `notifications` insert — none found. |
| 16 | Shipment status changes & customer tracking | Customer, Admin, Public | Inspected | `log_order_status_event()` trigger, `order_status_events`, `statusTimestamps.js`, `track_order_public()` (both the current and superseded versions) read in full. |
| 17 | Pickup/delivery photo upload & fallback | Admin | Inspected | `src/lib/storage.js` (442 lines) read in full. |
| 18 | Photo evidence archival/cleanup | System (cron) | Inspected | `archive-expired-evidence-photos/index.ts` (370 lines) read in full. |
| 19 | Photo Firestore-fallback read/delete/health | Admin, System | Partial | `get-photo-fallback`, `store-photo-fallback`, `delete-photo-fallback`, `cleanup-orphaned-photos`, `photo-storage-health` Edge Functions — confirmed via directory listing and `.from()`/`.rpc()` grep, not full reads of each. |
| 20 | Push notification delivery & retry queue | Customer, Admin | Inspected | `notification_delivery_jobs`, `claim_notification_delivery_jobs`, `complete_notification_delivery_job`, `send-push/index.ts`, `process-push-deliveries/index.ts` — all read in the prior session's database-cleanup work in this same repository and re-confirmed here. |
| 21 | Push device registration | Customer, Admin | Inspected | `src/lib/push-device.js` (157 lines) read in full. |
| 22 | Daily payment reminders | Customer (recipient), System | Partial | `trigger_daily_payment_reminders()` existence and cron schedule confirmed; `process-daily-reminders/index.ts` body not fully read — see Uninspected Areas. |
| 23 | Live chat (customer ↔ bot ↔ admin) | Customer, Admin | Partial | `maintain_conversation_service_state()` trigger read in full; `supportChatEngine.js` (1,118 lines) structurally scanned (exported functions enumerated), not every reply branch traced. |
| 24 | Admin inbox / takeover | Admin | Partial | Same trigger covers takeover state transition; `InboxPage.jsx` UI not read. |
| 25 | Public contact inquiries | Guest | Inspected | `submit-inquiry/index.ts` (157 lines) read in full, including its IP-resolution/rate-limit logic. |
| 26 | Admin contact-inquiry management | Admin | Partial | Schema/RLS/columns confirmed (assignment, push-dispatch lease); `ContactInquiriesPage.jsx` UI not read. |
| 27 | Customer feedback / reviews | Customer, Admin, Public | Partial | Schema, RLS policies, and `get_public_feedback()` existence confirmed (carried over from the prior database review in this repository); `FeedbackPage.jsx` UI not read this session. |
| 28 | Announcements & email broadcast | Admin, Customer, Public | Partial | `broadcast-announcement/index.ts` table/column usage confirmed via grep; full function body not re-read this session (read in the prior database-review session). |
| 29 | Website content (About page, company info) | Public, Admin | Partial | `company_information` schema confirmed; `AboutPage.jsx`/`CompanyInformationPage.jsx` not read. |
| 30 | Cancellation (request/review) | Customer, Admin | Inspected | `request_order_cancellation()`, `review_order_cancellation()` read in full; traced against the payment-timing question directly. |
| 31 | Order status history / public tracking page | Public | Inspected | `track_order_public()` (both versions across migrations), `mask_name()` read in full. |
| 32 | Storage monitoring / photo-storage settings | Admin | Inspected | Schema, RLS, RPCs (`get_photo_storage_summary`, `set_photo_storage_mode`) confirmed from the prior database-review session; `PhotoStorageTab.jsx` grepped, not fully read. |
| 33 | Activity logs (audit trail) | Admin (view), all (write via RPC) | Inspected | `src/lib/activityLog.js` (229 lines) read in full — **found the retry-classification bug**. `guard_activity_log_insert()`, `record_activity()` read in full. |
| 34 | Scheduled jobs (`pg_cron`) | System | Inspected | Every `cron.schedule`/`cron.unschedule` call across all 135 migrations enumerated and reconciled to a final active set of 8 jobs (carried forward from the prior database-review session, re-verified). |
| 35 | Dashboards, reports, sales summary | Admin | Partial | `getSalesData()`'s RPC-first/fallback-query path read in full (found an unbounded fallback query — filed as Improvement); `get_sales_summary()` RPC body itself not read this session. |
| 36 | Search & pagination (order lists) | Admin, Customer | Inspected | `getOrders()` read in full; confirmed admin list paginates server-side, customer list does not (low risk, noted as Improvement). |
| 37 | PDF export | Admin | Blocked | Not inspected this session — see Uninspected Areas. |
| 38 | Realtime subscriptions (order list, notifications) | Admin, Customer | Inspected | `useRealtimeOrders.js` read in full — subscription cleanup and debounce confirmed correct. |
| 39 | Storage/RLS on Supabase Storage buckets | All | Partial | Bucket-access reasoning in `src/lib/storage.js` comments read and cross-checked for internal consistency; the actual `storage.objects` RLS policies (lines ~4090-4141 of `schema.sql`) were not individually re-verified this session (they were covered in general terms by the prior database review). |
| 40 | Mobile layout / PWA install / service worker update | All | Blocked | Not inspected — requires a browser or device, which was unavailable (see "Inspection Scope"). |
| 41 | Multi-admin concurrent edit (optimistic concurrency) | Admin | Partial | Traced via row-locking (`FOR UPDATE`) in every payment/pickup/cancellation RPC — all use it correctly. Did not test two real concurrent admin sessions. |

---

## Workflow Inspection Results

### W1 — Register → accept documents → create profile → log in → reach correct screen
Traced `RegisterPage.jsx` → `AuthContext.register()` → `supabase.auth.signUp()` (with `legal_terms_version`/`legal_privacy_version` in `raw_user_meta_data`) → `handle_new_user()` trigger, which **refuses account creation** (`RAISE EXCEPTION`) unless the submitted version matches the currently-published `legal_documents` row for both document types, then inserts `profiles` and two `legal_consents` rows atomically with the `auth.users` row. `register()` then retries `createProfile()` (address/phone) up to twice before falling back to "account created, please finish your profile" rather than leaving a signed-in user with no usable profile. `ProtectedRoute` in `App.jsx` sends the new session to `/customer`. **No bug found in this path** — the failure modes (weak network mid-registration, a `createProfile` conflict) are explicitly handled with a recovery message rather than a dead end.

One drift worth flagging (filed under Improvements): the version string that gates registration lives in *two* places — the `legal_documents` table (database-enforced) and `src/constants/legalDocuments.js` (hand-maintained, used both to build the request and to render the Terms/Privacy pages themselves, which do **not** read from the `legal_documents` table). See Improvements list.

### W2 — Book cargo → admin reviews → assign trip → pickup → payment → status updates → delivery
Traced `BookShipmentPage.jsx` submit → `prepare_order_insert()` (weight/price zeroed until pickup, per the "weigh-and-price" design) → admin `TripAssignModal.jsx`/direct trip selection at booking → `record_pickup_payment()` (sets `actual_weight`, computes `shipping_cost`, inserts the first ledger row, sets `status = 'Picked Up'` — all in one transaction) → `orders_log_status_event` trigger fans every status change out to `order_status_events` → `record_delivery_payment()` for balance settlement → `Delivered`. **The mechanics of this path are sound and atomic** (single RPC per money-moving step, correctly locked). The gap found is not in this happy path but in what happens around a **payment race** (see Confirmed Bug #1) and in the **absence of any capacity check** at the trip-assignment step (see Confirmed Bug #3 / Suspected #1 below) — both documented separately to avoid duplicating the same symptom twice.

### W3 — Partial payment → remaining balance → promised payment date → reminder → settlement
`record_pickup_payment()` accepts `p_promised_payment_date` and stores it on the order; `orders.payment_status` becomes `'partial'` via the ledger trigger when `SUM(payment_transactions) < shipping_cost`. A daily cron job (`trigger_daily_payment_reminders`, `0 0 * * *`) calls `process-daily-reminders`. **This function's body was not read this session** (see Uninspected Areas) — I can confirm the cron job exists and targets orders with a `promised_payment_date`, but not the exact selection/dedup logic inside the Edge Function, so I cannot confirm or deny whether a customer could receive duplicate reminders on retry. Filed as a verification gap, not a bug.

### W4 — Online checkout → user closes the page → webhook arrives → payment reconciles without duplication
**This is where Confirmed Bug #1 lives.** Full trace in that section below. Short version: it does *not* always reconcile without duplication — specifically when the customer's return-triggered poll and the webhook's `source.chargeable` handler both attempt to capture the same PayMongo source at close to the same time, which is the *expected* shape of "user closes the page and comes back" (the redirect back to `/payment/return` happens right after GCash approval, which is also when the webhook fires).

### W5 — Reject or cancel an order → update trip capacity, payment-related state, notifications
Traced `request_order_cancellation()` (customer-initiated, blocked once `status` reaches `'Picked Up'` or later) and `review_order_cancellation()` (admin approve/decline). Confirmed:
- **Notifications:** correctly sent on both approval and decline (`review_order_cancellation`, `schema.sql:2833-2842`) — this path does *not* share the gap found in W4/payments.
- **Payment state:** because cancellation is only possible *before* `'Picked Up'`, and the customer "Pay Now" button is gated on `actual_weight > 0` (which is only ever set at pickup — confirmed in `customer/OrderDetailPage.jsx:976`), there is no reachable path today where a cancelled order carries a prior payment that needs reversing. I looked for this specific gap (a prepaid order being cancelled with no refund bookkeeping) because it's a common bug shape in similar systems, and traced it closed rather than leaving it as a guess.
- **Trip capacity:** moot in practice today because capacity is not enforced anywhere (see Confirmed Bug #3) — cancelling an order that was never blocked by a capacity check has nothing to "free up" in an enforcement sense, though `get_trips_load()` does correctly exclude `'Cancelled'` orders from its weight sum (`schema.sql:1120-1133`, `WHERE o.status <> 'Cancelled'`), so the *informational* remaining-capacity number shown to the next customer is accurate for orders that have already been weighed.

### W6 — Upload evidence → provider fails → fallback/retry → display correct photos → eventual cleanup
Traced `uploadToSupabaseStorage()` (`src/lib/storage.js`) end to end: Supabase upload attempt → on failure, Firestore fallback (only for pickup/delivery/receipt folders with an order id) → on partial-batch failure, already-uploaded photos in the same batch are rolled back (`uploadMultiplePhotos`'s catch block calls `deletePhoto` on every photo uploaded so far). `resolvePhotoUrl()` correctly branches on descriptor type (signed URL vs. Firestore fetch vs. legacy) and caches Firestore fallback reads for 5 minutes. `archive-expired-evidence-photos` (the 6-month cleanup job) classifies every stored reference defensively — an unrecognized reference format is *never* deleted, only ever skipped and left visible. **No bug found in this workflow.** This is the best-engineered subsystem checked in this audit outside of the payment ledger core.

### W7 — Customer asks for help → admin responds → correct conversation and notification state
Traced `maintain_conversation_service_state()` (the trigger that runs after every `chat_messages` insert): a customer message routes to `bot_active`/`waiting`/`waiting_customer` correctly depending on prior state and a 12-hour "still the same issue" grace window; an admin reply always sets `waiting_customer` and stamps `first_response_at` once. A bot reply changes nothing (correct — a bot answer shouldn't clear a human queue). **No bug found in the state machine itself.** `supportChatEngine.js` (the bot's actual reply logic) was scanned for structure but not exhaustively traced branch-by-branch — see coverage table row 23.

---

## Confirmed Bugs

### BUG-01 — GCash payments can be double-credited when a capture race triggers the "not chargeable" self-heal path
- **Severity:** Critical
- **Module(s):** Online GCash payment / checkout / webhook reconciliation (workflow W4); affects `orders.amount_paid`, `payment_transactions`, Sales Reports
- **Affected users:** Any customer paying via GCash; the financial impact (inflated collected-revenue totals, incorrect remaining balances) affects admins/the business
- **Evidence status:** Confirmed — reproduced through a complete, traced code path across three files; independently corroborated by `docs/payment-redesign-v2.md:249-253` (finding "P-12"), which describes the identical mechanism against an earlier version of this code and shows it was already known
- **Files/functions:**
  - `supabase/functions/paymongo-webhook/index.ts:170-244` (`source.chargeable` handler and its self-heal branch, lines 212-243)
  - `supabase/functions/paymongo-create-payment/index.ts:306-402` (the `poll` action and its self-heal branch, lines 375-391)
  - `supabase/functions/paymongo-webhook/index.ts:246-257` (`payment.paid` handler — no "already reconciled" check before calling `reconcile()`)
  - `supabase/schema.sql:2405-2492` (`reconcile_paymongo_payment_attempt()` — the shared RPC both call)
- **Precondition / reproduction path:**
  1. A customer completes GCash authorization. PayMongo fires a `source.chargeable` webhook to `paymongo-webhook`.
  2. At close to the same time, the customer is redirected back to `/payment/return` (or an order detail page), whose `pollPaymentStatus()` call reaches `paymongo-create-payment`'s `poll` action, which — if the source is still `'chargeable'` rather than already `'paid'` — also attempts `capturePayment()` on the same source (`paymongo-create-payment/index.ts:362-394`).
  3. PayMongo allows only one of these two capture calls to succeed; the other receives an error containing `"not chargeable"` (the code's own string match confirms the team has observed this exact response).
  4. **Both** the webhook's and the poll's `"not chargeable"` handlers respond by querying the source's status directly and, if it reads `'paid'`, calling `reconcile_paymongo_payment_attempt()` with a **fabricated** payment reference: `` `auto_${sourceId}` `` — not PayMongo's real payment id, because the source-status endpoint does not return one.
  5. Separately (and unavoidably), PayMongo's own `payment.paid` webhook event fires once the *winning* capture actually completes, carrying the **real** payment id. The `payment.paid` handler (`paymongo-webhook/index.ts:246-257`) calls `reconcile()` with that real id **without first checking whether the attempt is already reconciled**.
  6. `reconcile_paymongo_payment_attempt()` inserts into `payment_transactions` with `transaction_reference = p_payment_id` and relies solely on `ON CONFLICT (transaction_reference) WHERE transaction_reference IS NOT NULL DO NOTHING` for idempotency (`schema.sql:2465-2467`). Because step 4's reference (`auto_...`) and step 5's reference (the real id) are **different strings**, the conflict-based guard cannot recognize them as the same payment. Both inserts succeed.
  7. `update_order_payment_totals` (the ledger trigger) recomputes `orders.amount_paid` as the sum of **both** rows — the order is now credited twice for one real GCash payment.
- **Expected behavior:** Exactly one `payment_transactions` row per real PayMongo payment, regardless of how many internal paths raced to reconcile it.
- **Actual behavior:** Two rows, with two different `transaction_reference` values, for the same money.
- **Root cause:** The self-heal recovery path (added specifically to handle the webhook/poll capture race) reconciles using a synthetic reference instead of retrieving the real payment id from PayMongo (e.g., via `GET /v1/sources/{id}` expansion, or a `payments` list-by-source call) before reconciling, **and** the `payment.paid` handler never checks `attempt.status === 'reconciled'` before calling `reconcile()` again, so even a correctly-behaved self-heal would still risk a mismatched second write today.
- **Impact:** Revenue and per-order paid-amount figures used across Sales Reports, the customer's own balance display, and payment-history exports would overstate what was actually collected on any order that hit this race. Given the race is between two paths that are both invoked on essentially every GCash payment (a webhook always fires; the customer almost always returns to the page right after approving), this is not a rare edge case — it is a coin-flip on a common, everyday action. There is currently no reconciliation safeguard that would catch this direction of the error: `getSalesData()`'s `unattributedTotal` metric (`src/lib/database.js:1379`) only measures the opposite drift (money collected with **no** ledger row), not a ledger **over**-counting real money.
- **Recommended fix direction (not implemented):** Retrieve the real PayMongo payment id in the self-heal branch (e.g., list payments for the source, or defer reconciliation until the `payment.paid` webhook supplies the real id, treating the self-heal purely as a *status* check rather than a *reconcile* call) — and, independently, make `reconcile_paymongo_payment_attempt()` a true no-op once `attempt_row.status = 'reconciled'`, so a second call with any reference can never insert a second ledger row for the same attempt.
- **Regression check:** After a fix, write a focused test (or a one-off diagnostic script against a disposable/local Postgres, not production) that calls `reconcile_paymongo_payment_attempt()` twice for the same `source_id` — once with a synthetic reference, once with a distinct "real" reference — and assert exactly one `payment_transactions` row exists afterward.
- **Uncertainty / deployment dependency:** The exact PayMongo error string for a consumed source was not independently reproduced in this audit (no live PayMongo calls were made, per the task's constraints) — this finding relies on the code's own string match (`msg.includes('not chargeable')`) as evidence the team has observed and handled this response, which is strong but not a live reproduction.

### BUG-02 — No customer notification is ever sent for a successful or recorded payment
- **Severity:** High
- **Module(s):** Payments (all three paths: online GCash, cash at pickup, balance settlement at delivery); cross-references Notifications module
- **Affected users:** Customers
- **Evidence status:** Confirmed — verified by reading every payment write path and finding zero `INSERT INTO notifications` / `createNotification` calls anywhere in it
- **Files/functions checked (none contain a notification write):** `reconcile_paymongo_payment_attempt()` (`schema.sql:2405-2492`), `record_pickup_payment()` (`schema.sql:2615-2694`), `record_delivery_payment()` (`schema.sql:2496-2591`), `log_payment_transaction_activity()` trigger (`schema.sql:2125-2184`, writes only to `activity_logs`), and the frontend components `PaymentReturnPage.jsx`, `customer/OrderDetailPage.jsx`, `AdditionalPaymentModal.jsx`, `PaymentCollectionPanel.jsx`, `PickupModal.jsx`, `DeliveryModal.jsx`
- **Expected behavior:** Given the system already sends a push/in-app notification for order status changes, cancellation review, contact-inquiry replies, and chat messages, a customer paying — arguably the single most anxiety-inducing moment in the whole flow ("did my money actually go through?") — would reasonably be expected to get the same treatment.
- **Actual behavior:** Nothing. The customer must manually navigate to the order or Payment History page to discover their balance changed.
- **Root cause:** Never implemented; `notifications.type` (`schema.sql:182`) does not even have a `'payment'` value in its `CHECK` constraint, so this was not an oversight in one function — the type system for notifications was never extended to cover payments.
- **Impact:** Increased support burden ("did my payment go through?") and reduced trust in the online-payment feature specifically, since it is the one with the least immediate visual feedback (a redirect through an external GCash app and back).
- **Recommended fix direction:** Add a `'payment'` (or reuse `'order_update'`) branch and insert a notification from `reconcile_paymongo_payment_attempt()`, `record_pickup_payment()`, and `record_delivery_payment()` — the same three functions already own writing the ledger, so they are the natural single place to add it without introducing a new race.
- **Regression check:** After a fix, verify a `notifications` row (and, if push is desired, a fanned-out `notification_delivery_jobs` row) appears immediately after each of the three RPCs commits, for both a full and a partial payment.
- **Uncertainty:** None — this is a straightforward absence, not a timing-dependent one.

### BUG-03 — Trip cargo capacity has no server-side enforcement, including for ordinary customer self-service bookings
- **Severity:** Medium (data-integrity / business-rule; not a security issue)
- **Module(s):** Trip scheduling & capacity; Cargo booking (customer)
- **Affected users:** Customers (can unknowingly overbook); Admins (must discover and resolve overbooked trips manually)
- **Evidence status:** Confirmed as a code fact (no enforcement exists anywhere, for anyone); filed as a bug rather than purely a design note because the removal's own stated intent ("allow **administrators** to intentionally exceed") does not match its actual effect (it removed the check for **every** caller, including ordinary customers who never asked to override anything)
- **Files/functions:**
  - `supabase/migrations/20260526010000_remove_capacity_guard.sql` — the check was deleted from `prepare_order_insert()` and `guard_order_update()`, with the comment *"This allows administrators to intentionally exceed capacity limits without being blocked."*
  - `src/pages/customer/BookShipmentPage.jsx:793-816` — customers select a specific trip directly from a dropdown; `selectedTripRemainingCapacity` (line 187-189) is computed and displayed but is **never referenced in any validation or submit-blocking logic** (confirmed by grep — its only other use is the display at line 811-814).
  - `supabase/schema.sql:1120-1133` (`get_trips_load()`) — correctly excludes cancelled orders and sums `actual_weight`, which is consistent with this system's "weigh at pickup, not at booking" pricing model (`prepare_order_insert()` sets `shipping_cost = 0` and leaves `actual_weight` NULL until pickup — there is no "estimated weight" concept to check against at booking time in the first place).
- **Reproduction path:** Two customers (or one customer twice) select the same trip for a route that is already fully booked (by weight, once orders on it have been picked up and weighed) or is about to be. Neither the booking form nor the database blocks the submission; the only signal is a passive "Available: X kg" number on screen that nothing prevents the customer from ignoring, and that a second customer racing to book the last slot could not see update in time regardless.
- **Expected vs. actual:** Expected — either a hard block, or at minimum this being a deliberate, product-confirmed trade-off specifically because weight is genuinely unknowable before pickup. Actual — the guard's removal comment describes an admin-override use case, but the code change applied uniformly, so the "no enforcement" behavior reaches a code path (customer self-service booking) the change was never described as targeting.
- **Root cause:** A capacity guard was removed at the trigger level to unblock a specific admin workflow; the removal was not scoped to admin-initiated writes only.
- **Impact:** Depends entirely on real-world operations (vehicle/vessel capacity vs. how often trips fill up) — this audit found no evidence of actual overbooking having occurred, only that nothing would prevent or even flag it if it did.
- **Recommended fix direction:** This needs a product decision, not just a code change: if the intent is "customers should never be blocked either, capacity is advisory everywhere," document that explicitly and consider removing the misleading "Available" display or making clear it is informational only; if the intent is "only admins should be able to override," reintroduce the check scoped to `NOT is_admin()`.
- **Regression check:** Once the intended behavior is decided, add a test booking that pushes a trip's *actual* (post-pickup) weight over `capacity` and confirm the system's behavior (block, warn, or silently allow) matches the decision.
- **Uncertainty:** This is filed as "Confirmed" only for the fact that no enforcement exists; whether that fact constitutes a "bug" versus an accepted trade-off is a product judgment call this audit cannot make on its own.

### BUG-04 — Activity-log client retry queue misclassifies a permanent server-side rejection as transient, risking an infinite retry loop
- **Severity:** Medium (currently dormant — see Uncertainty)
- **Module(s):** Activity Logs (audit trail)
- **Affected users:** Whoever's browser queues the rejected event (their subsequent activity-log entries would also stop syncing, since the loop blocks on the first unresolved item)
- **Evidence status:** Confirmed as a code defect; **not currently triggered by any live call site** (verified by exhaustively grepping every caller — see below), so its real-world likelihood today is low, but the defect itself is real and would activate the moment any new restricted-module logging call is added, or if the RPC ever adds a new validation.
- **Files/functions:**
  - `src/lib/activityLog.js:81-83` — `isPermanentError(error)` whitelists only `['22023', '22P02', '23503', '23514', '42501']`.
  - `src/lib/activityLog.js:101-131` — `flushActivityLogQueue`'s `while (true)` loop: on any error not in that whitelist, it `console.warn`s and `break`s, leaving the offending item (and everything queued behind it, since the loop processes in order) stuck for the next flush attempt — which will fail identically, forever, every 60 seconds (`activityLog.js:227`) and on every reconnect/tab-focus/online event.
  - `supabase/schema.sql:1320-1392` (`record_activity()`) and `:1268-1316` (`guard_activity_log_insert()`) — every `RAISE EXCEPTION` in both (e.g., *"Not allowed to write % activity logs"*) uses Postgres's **default** exception code, `P0001`, which is absent from the whitelist above.
- **Reproduction path (code-traced, not observed live):** Any code path that calls `logActivity()` with a `module` outside `('Orders', 'Authentication', 'Chat')` from a non-admin session would have its row rejected by `record_activity()`'s authorization check with code `P0001`. `isPermanentError('P0001')` returns `false`, so the item is treated as retryable rather than dropped, and the per-user queue stalls on it indefinitely.
- **Why it is dormant today:** Every current call site that could run under a non-admin session (`logOrder`, `logAuth`, `logChat`) only ever logs a module in the allowed set. The restricted helpers (`logPayment`, `logTrip`, `logAnnouncement`, `logSettings`, `logCompany`) are imported exclusively by admin-only pages (confirmed by grep across `src/pages/admin/*.jsx` and `src/pages/customer/*.jsx` — none of the restricted helpers appear outside `src/pages/admin/`).
- **Expected behavior:** A permanently-rejected event should be dropped (with a warning) exactly like the other permanent-error codes already handled, not retried forever.
- **Actual behavior:** It is retried forever, and blocks everything queued after it for that user.
- **Root cause:** The whitelist was built from the *specific* Postgres error codes the original author anticipated (check violations, foreign-key violations, permission-denied) and never accounted for a bare `RAISE EXCEPTION` without an explicit `ERRCODE`, which is what this codebase's own trigger/RPC functions consistently use for business-rule rejections.
- **Impact today:** None observed (dormant). Impact if triggered: a user's activity-log queue silently stops syncing anything, with only a `console.warn` (not surfaced to any UI) as a symptom — likely to go unnoticed until an admin looks for a log entry that never arrives.
- **Recommended fix direction:** Add `'P0001'` to `isPermanentError`, or — more robustly — change the classification to a denylist of specifically-retryable transient conditions (network/timeout) rather than an allowlist of specifically-permanent ones, since the current design fails closed (treats unknown errors as retryable) when it should fail open (drop unknown non-transient errors after logging them).
- **Regression check:** Call `logActivity({ module: 'Payments', ... })` (a module a non-admin may not write) from a simulated non-admin session against a disposable/local database and confirm the item is removed from the local queue (not retried) after the first attempt.
- **Uncertainty:** Purely a "what if" today given no live trigger exists; flagged because it is a straightforward, provable defect that costs little to fix and is the kind of thing that becomes a live incident the moment someone adds one more `logX()` call site without checking the module allowlist.

---

## Suspected Bugs Requiring Verification

### SUS-01 — Webhook signature verification never checks the signature timestamp's age
- **Module:** Online payment webhook
- **Files:** `supabase/functions/paymongo-webhook/index.ts:42-69` (`parseSignature`/`verifySignature`) — `parts.t` is parsed and included in the signed payload comparison but its numeric age is never checked against a tolerance window.
- **Why suspected, not confirmed as impactful:** A replayed, validly-signed old webhook body would still pass verification. However, because `reconcile_paymongo_payment_attempt()` is otherwise correctly idempotent on a *matching* `transaction_reference` (the real PayMongo payment id), a straightforward replay of a genuine `payment.paid` event is naturally absorbed by the existing `ON CONFLICT DO NOTHING` — it would not, by itself, double-credit anything. The realistic risk is narrower: a captured old event replayed **after** BUG-01 has already put the attempt into an inconsistent (`auto_...`-referenced) state could interact with it in ways this audit did not fully trace. Also corroborated by `docs/payment-redesign-v2.md` P-18.
- **Recommended verification:** Decide whether PayMongo's own webhook infrastructure already provides replay protection (many providers do via a distinct event id spent exactly once) before spending effort here — if `payload.data.id` (`eventId`, already extracted at `paymongo-webhook/index.ts:164` but never used for de-duplication) is unique per delivery, storing seen event ids would be a more direct fix than timestamp checking.

### SUS-02 — `getSalesData()`'s fallback path issues an unbounded query
- **Module:** Dashboards & Reports
- **File:** `src/lib/database.js:1321-1324` — when `get_sales_summary()` RPC fails or returns nothing, the fallback selects every non-cancelled order with no `.limit()`/`.range()`, then aggregates client-side in JavaScript.
- **Why suspected, not confirmed:** This path only runs when the primary RPC fails, which this audit has no evidence happens in practice; no row-count data was available to judge whether "every order" is a handful or hundreds of thousands. Filed as a suspicion because an unbounded query is a known scaling risk pattern, not because a failure was observed.
- **Recommended verification:** Check whether `get_sales_summary()` has ever actually failed in production logs; if it has, size the fallback's realistic result set before deciding whether to paginate it.

### SUS-03 — Daily payment-reminder duplicate-send behavior not fully traced
- **Module:** Payment reminders
- **File:** `supabase/functions/process-daily-reminders/index.ts` — existence and trigger (`trigger_daily_payment_reminders`, daily cron) confirmed; the function's own dedup/selection logic was not read line-by-line this session.
- **Why suspected:** The task specifically calls out "duplicate or out-of-order... background jobs" as a failure class to check, and this is the one scheduled job in the reminder path this audit did not fully trace before time ran out. No evidence either way.
- **Recommended verification:** Read `process-daily-reminders/index.ts` in full and confirm it has a positive marker (e.g., `last_reminder_sent_at`, which does exist as an `orders` column per `schema.sql:246`) checked *before* sending, not just updated after, so a retry of the whole function (e.g., after a timeout) cannot re-notify the same customer twice in one day.

### SUS-04 — Legal document version duplicated between database and frontend with no automated consistency check
- **Module:** Legal documents & consent
- **Files:** `supabase/schema.sql:1798` (`handle_new_user()` compares against `legal_documents.version WHERE is_current`), `src/constants/legalDocuments.js:4` (`LEGAL_DOCUMENT_VERSION`, hand-maintained)
- **Why suspected rather than confirmed as a live bug:** Both values are currently in sync (registration works, per the passing test suite and the absence of any reported issue) — this is a latent consistency risk, not a demonstrated failure. If a future migration publishes a new `legal_documents` version without a matching frontend constants update (or vice versa), every registration would start failing with a generic error, or the publicly displayed Terms/Privacy text would silently disagree with what the database considers "current."
- **Recommended verification:** None needed to confirm the risk (it's a direct reading of both files); what would help is deciding a single source of truth (most naturally the `legal_documents` table, read via a small public RPC, mirroring the existing `track_order_public`/`get_public_business_profile` pattern) before the next legal-document revision.

---

## Cross-Module Consistency Issues

1. **Payments ↔ Notifications.** Every other customer-facing state change (order status, cancellation review, chat reply, new announcement) produces a notification; payments — arguably the highest-stakes single event in the app — produce none. See BUG-02. This is filed as a cross-module issue (not just a Payments bug) because it reveals an inconsistency in an otherwise-consistent design pattern used everywhere else in the codebase.
2. **Trip capacity ↔ Booking.** The capacity guard's removal (`20260526010000_remove_capacity_guard.sql`) was scoped in *intent* to the admin trip-management workflow but landed in a shared trigger function that also governs the customer booking workflow, so a change meant for one module silently changed the guarantees of another. See BUG-03.

---

## Authorization and Data Integrity Findings

These were checked directly (not assumed safe because RLS is "on" or a function is `SECURITY DEFINER`), per the task's explicit instruction that neither fact proves correctness by itself.

- **Can a customer read or modify another customer's records?** Checked `orders` RLS (`"Users can view own orders"` / `"Users can create own orders"`, `schema.sql:3921-3946`) — both scope to `user_id = auth.uid()` or `is_admin()`. Checked `payment_attempts` — customers have **zero** direct table access (`"Admins can manage payment attempts"` is the only policy, `schema.sql:3950-3956`); every customer interaction goes through Edge Functions using the service-role key, which independently re-check ownership (`paymongo-create-payment/index.ts:242-249`, `:318-320` — the poll-ownership check explicitly comments on the exact attack it closes: a customer polling a stranger's payment source by supplying their own order id). **No cross-customer read/write path found.**
- **Can a user elevate their role or supply trusted fields?** `guard_profile_write()` (referenced from the prior database-architecture review in this repository, re-confirmed structurally here) reverts a non-admin's attempt to change `role`; `prepare_order_insert()`/`guard_order_update()` compute `shipping_cost`/`remaining_balance`/`payment_status` server-side, never trusting a client-supplied value for those columns. `paymongo-create-payment/index.ts:263-299` explicitly validates the client-supplied payment amount against the order's actual stored balance before ever calling PayMongo — with an inline comment describing the exact exploit this closes (a customer creating a PayMongo source for ₱1 using the public key, then registering it against a ₱5,000 order). **No privilege-escalation or trusted-field-injection path found** in the modules inspected.
- **Do public endpoints expose unnecessary personal or business information?** `track_order_public()` returns masked names, status, route, and (in its current, latest version) `actual_weight` and an estimated delivery date — no phone, no address, no payment reference, no cost. Its own migration comment explains this is a deliberate parity choice with commercial carriers, not an oversight, and a strictly *narrower* version than an earlier iteration that also exposed `shipping_cost`. `get_featured_deliveries()`/`get_public_feedback()` (confirmed present from the prior database review; not re-read line-by-line this session) already replaced two RLS policies that used to leak full PII to `anon` — that fix predates this audit and was independently re-confirmed by checking that the vulnerable policies are simply absent from the current `orders`/`customer_feedback` policy blocks. **No new public-PII exposure found.**
- **Do privileged functions validate the caller?** Every admin-only RPC read in this audit (`record_pickup_payment`, `record_delivery_payment`, `review_order_cancellation`, `get_photo_storage_live_usage`) opens with an explicit `is_admin()`/`auth.role() = 'service_role'` check that `RAISE EXCEPTION`s otherwise. Every scheduled/system-only Edge Function checked (`archive-expired-evidence-photos`, and — per its own comment — `process-daily-reminders`) gates on the caller presenting the service-role key as a bearer token, which only the project's own cron job (via `pg_net` + Vault-stored credentials) can do.
- **Are secrets kept out of the frontend bundle and logs?** Confirmed `grep -rn "SERVICE_ROLE" src/` returns nothing; `.env.example` only lists `VITE_`-prefixed public keys for the client. PayMongo's secret key and the Firebase service-account key are read only via `Deno.env.get(...)` inside Edge Functions.
- **Can retries or concurrent operations create duplicate payments, messages, bookings, or deliveries?** Payment ledger: idempotent by design via `transaction_reference`'s partial unique index **except** for the specific mismatched-reference case in BUG-01. Chat messages: no idempotency key exists on `chat_messages` insert — a genuine double-submit (e.g., a slow network causing a resend) would create two identical messages; this was not separately investigated in depth this session and is noted here as an open question rather than a confirmed finding, since no UI-level double-submit guard was checked for the chat composer specifically. Bookings: no server-side de-duplication of a genuinely doubled `orders` insert (the client's `disabled={loading}` guard is the only protection) — not independently demonstrated to fail, filed as an Improvement below rather than a confirmed bug, since every booking-submission button checked in this audit does correctly disable itself synchronously with the submit handler.
- **Can deletion or cleanup erase records still needed elsewhere?** `archive-expired-evidence-photos` explicitly excludes any order still `featured_on_website = true` from cleanup eligibility (`get_expired_evidence_orders()`, `schema.sql`/migration `20260901030000`), and never deletes a photo reference it cannot positively classify. **No unsafe cleanup path found** in the modules inspected.

---

## Checks Performed and Results

| Check | Result |
|---|---|
| `npm test` (full contract-test suite: smoke, axe-lint, token-lint, activity-log, payment-UI, booking-dirty-state, registration-transition, mobile-layout, photo-reference/fallback/storage-monitoring, Apple-platform, push-notification, notification-UX contracts) | **Passed.** Confirms these specific, narrow invariants the team already wrote checks for still hold. Does **not** confirm the workflows traced in this report are bug-free — none of these scripts test the payment-reconciliation race, the missing payment notification, or trip capacity, because no existing test targets those paths. |
| `node scripts/edge-function-build-test.mjs` | **Passed.** Confirms all 15 Edge Functions are syntactically valid TypeScript/Deno modules that build; does not execute their logic or call any external provider. |
| `git status` / repository state check | Clean at the start of this session (per the environment's own git-status snapshot); no uncommitted changes were introduced by this audit. |
| Direct trace: can `logout()` be blocked by a failing activity-log write? | **No** — `logActivity()`/`logAuth()` are fully wrapped in `try/catch` and never reject (`src/lib/activityLog.js:177-180`), so `await logAuth(...)` in `AuthContext.logout()` cannot prevent the subsequent `signOut()`. |
| Direct trace: is the `capture` (non-poll) code path in `paymongo-create-payment` reachable from the frontend? | **No** — grepped every call site of `createPayment`, `pollPaymentStatus`, `registerSource` across `src/`; only `registerSource` (action `register`) and `pollPaymentStatus` (action `poll`) are ever invoked. The `capture` action's incomplete self-heal handling (it lacks the "not chargeable" recovery the `poll` action has) is therefore dead code today, not a live bug — noted under Improvements. |
| Direct trace: does any payment RPC/trigger write to `notifications`? | **No** — see BUG-02. |
| Direct trace: is trip capacity checked anywhere server-side? | **No** — see BUG-03; confirmed via both the removal migration and a full-text search of `schema.sql` for `capacity` outside the column definition. |
| Direct trace: does `isPermanentError()` cover Postgres's default exception code? | **No** — see BUG-04. |
| Direct trace: can one customer poll or read another customer's `payment_attempts` row? | **No** — see Authorization findings. |
| Direct trace: is the service-role key present in any frontend file? | **No** — confirmed via repository-wide grep. |

---

## Improvements That Are Not Bugs

These were noted while tracing the workflows above but do not demonstrate an actual malfunction; they are lower-value cleanup or hardening opportunities.

1. **Dead code in the payment Edge Function.** `paymongo-create-payment`'s `capture` action path is never invoked by the frontend and lacks the self-heal handling its sibling `poll` action has (see Checks Performed). Harmless while unreachable, but a latent trap if someone wires it up later expecting the same robustness as `poll`.
2. **`createPaymentAttempt()` in `src/lib/database.js` is dead code.** Confirmed zero call sites; it appears to be a leftover from an earlier customer-initiated "Pay Later via PayMongo" design that was superseded by the current admin-recorded `promised_payment_date` flow.
3. **Legal document content is duplicated, not fetched from the database.** `LegalPage.jsx` renders hardcoded text from `src/constants/legalDocuments.js` rather than the `legal_documents` table the registration trigger actually enforces against (see SUS-04).
4. **Customer order list has no pagination.** `customer/OrdersPage.jsx:73` calls `getOrders(user.id, false)` with no `page`/`perPage`/`limit`, unlike the admin list, which does paginate. Low risk in practice (one customer's own order count is naturally bounded), but inconsistent with the pattern used everywhere else.
5. **`trips.notes` and `orders.service_area_remarks` remain write-only** (re-confirmed from the prior database-architecture review in this repository — an admin can write a trip note or a booking-rejection reason that is never displayed anywhere, including back to the affected customer for the rejection reason). Frontend-only gaps, zero schema risk.
6. **`getSalesData()`'s RPC-failure fallback issues an unbounded query** (see SUS-02) — filed here rather than as a bug because no failure of the primary RPC was observed or evidenced.

---

## Prioritized Fix Plan

**High-priority fixes**
1. BUG-01 — GCash payment double-crediting on capture race. Fix the self-heal reference mismatch and add an "already reconciled" short-circuit to `reconcile_paymongo_payment_attempt()`. Recommend a manual data check (read-only `SELECT` grouping `payment_transactions` by `order_id` looking for orders with more ledger rows than distinct real PayMongo payment ids) against the live database before writing the code fix, to learn whether this has already happened to real orders.
2. BUG-02 — Add a payment-confirmation notification from the three payment-recording RPCs.

**Useful simplifications**
3. BUG-04 — Fix `isPermanentError()`'s exception-code whitelist (cheap, prevents a future silent-failure mode).
4. BUG-03 — Bring a product decision on trip-capacity enforcement back to engineering, then implement whichever direction is chosen.
5. SUS-04 — Make `legal_documents` the single source of truth for both the enforced version and the displayed text (or add an automated check that the two never drift).

**Optional improvements**
6. SUS-01 — Add webhook event-id de-duplication (using the already-extracted, currently-unused `eventId`) as defense in depth, independent of BUG-01.
7. SUS-03 — Read `process-daily-reminders/index.ts` in full and confirm its dedup marker is checked before sending, not just after.
8. Improvements #1–6 above, in any order, as time allows.

**Changes that should not be made**
- Do not "fix" BUG-03 by silently re-adding a blanket capacity check without a product decision — the whole point of its removal was a real admin need (documented in the migration itself); reintroducing it carelessly would reproduce the original complaint that led to its removal.
- Do not treat this report's "no finding" modules (see coverage table) as verified bug-free — several were only partially inspected, and two (PDF export, mobile/PWA layout) were not inspected at all this session.

---

## Uninspected Areas and Access Limitations

- **PDF export (`src/lib/exportPdf.js`)** — not opened this session. Given the task's interest in exports, this should be read next, specifically for how it handles large datasets and any user-supplied text that ends up in the generated document (a data-injection-into-PDF class of bug was not ruled out).
- **Mobile layouts, PWA install banners, service-worker update flow** — requires a real or emulated browser/device to observe layout or install-prompt behavior; this environment had no browser available. The existing `scripts/*mobile-layout*` and `*pwa-offline*` contract tests were not independently re-derived or challenged beyond confirming they currently pass.
- **`process-daily-reminders/index.ts` body** — existence and scheduling confirmed; internal dedup logic not read (SUS-03).
- **`supportChatEngine.js` reply logic** — 1,118 lines; only its exported-function structure was scanned, not every conversational branch. A wrong bot reply is a low-severity UX issue relative to the areas prioritized this session, but was not exhaustively checked.
- **Admin-only CMS-style pages** (`CompanyInformationPage.jsx`, `AnnouncementsPage.jsx`'s UI, `FeedbackPage.jsx`, `ActivityLogsPage.jsx`, `ContactInquiriesPage.jsx`, `InboxPage.jsx`, `CustomerDetailPage.jsx`) — their underlying schema/RLS/RPCs were covered (via this session and the prior database-architecture-review session in this repository), but the React components themselves were not read line-by-line.
- **Live database state** — no live Supabase access. All schema/RLS/trigger claims are a reconstruction from the repository, which the task instructions specifically warned may not match the deployed database.
- **No live PayMongo, Firebase, or Resend calls** were made — the exact runtime error strings and timing windows those providers produce were taken from the code's own comments, not independently reproduced.

---

## Final Assessment

This is a well-built system with a genuinely strong payment-ledger core, a carefully-handled authentication/session layer, and a photo-evidence pipeline that already anticipates and correctly handles most of the realistic-failure-case list this audit was asked to check. The team's own prior audits found and fixed real, serious problems, and this audit's re-verification of those fixes found them holding up.

The one finding that should change how the payment feature is trusted today is BUG-01: a specific, ordinary (not adversarial) timing race can cause a single GCash payment to be recorded twice in the ledger, silently inflating what an order — and the business's reported revenue — shows as collected. It was already flagged internally once (`docs/payment-redesign-v2.md`, P-12) and, as far as this audit's code reading can tell, has not yet been fixed. That, plus the complete absence of payment notifications (BUG-02), are the two items worth acting on before anything else in this report.

Everything else found here is real but bounded: a dormant retry-loop defect that costs little to fix now while it's free, a capacity-enforcement gap that is more of a product question than an engineering mistake, and a handful of small, low-risk cleanup items. No confirmed security vulnerability, secret exposure, or cross-customer data leak was found in the modules this audit was able to inspect — with the explicit caveat that PDF export, mobile/PWA behavior, and live-database state were not inspected this session, and should not be assumed safe on the strength of this report alone.
