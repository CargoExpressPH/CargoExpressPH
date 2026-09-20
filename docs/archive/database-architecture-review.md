# CargoExpress PH — Database Architecture Review

**Date:** 2026-08-03
**Scope:** 15 tables / 192 columns, 24 functions, 0 views, 5 Edge Functions, 38 migrations, 100 source files.
**Status:** Review and proposal only. No code, schema, or migration was changed.

---

## 0. Method

Every column below was traced by grepping the full corpus — `src/**`, `supabase/functions/**`,
`scripts/**`, `public/**`, `supabase/schema.sql`, `supabase/migrations/**` — and then reading the
call sites. Nothing here is inferred from a name. Where I could not prove a claim from code I say so
explicitly and mark it **VERIFY**.

Two structural facts up front, because they shape everything else:

- **There are zero views and zero materialized views.** Every aggregate is computed either in
  `get_sales_summary()` (one RPC) or in JavaScript in `src/lib/database.js`.
- **The database already went through one consolidation pass** (`20260715000000_consolidate_tables.sql`,
  `20260802000000_schema_cleanup.sql`): `global_settings` → a column, `coverage_regions` +
  `coverage_municipalities` → JSONB, `trip_reassignments` → JSONB. That direction of travel was
  correct for two of those three and wrong for the third. Details in Phase 3.

---

## Phase 1 — Column usage trace

Legend: **FE** frontend · **DL** data layer (`src/lib/database.js`) · **TRG** trigger · **RPC** ·
**EF** Edge Function · **RLS** policy · **WO** write-only (stored, never read anywhere) ·
**DEAD** never written and never read.

### 1.1 `profiles` — 14 columns, 1 FK

| Column | Used by | Notes |
|---|---|---|
| `id` | FE, DL, TRG, RPC, RLS, EF | PK, FK→`auth.users`. Referenced by 9 other tables. |
| `name` | FE, DL, TRG, RPC | `mask_name()`, `log_customer_chat_message()`, activity-log author. |
| `email` | FE, DL, TRG | Synced from `auth.users` by `sync_auth_email_to_profile()`. Reverted on non-admin UPDATE by `guard_profile_write`. |
| `phone` | FE, DL | Customer search (`getCustomers`), booking prefill. |
| `address_lot_block` / `_street` / `_barangay` / `_city` / `_province` / `address_landmark` | FE, DL | Read at `BookShipmentPage.jsx:230-255` to prefill sender/receiver. `address_province` also drives customer search. Genuinely used — see §2.1 for the asymmetry with `orders`. |
| `role` | FE, DL, TRG, RPC, RLS, EF | The authorization axis. `is_admin()`, `guard_profile_write`, `create_admin_notifications_rpc`, `send-push`. |
| `facebook_name` | FE | Prefills `orders.sender_facebook` / `receiver_facebook`. |
| `created_at` | FE, DL, TRG | Customer list sort; reverted on non-admin UPDATE. |
| `updated_at` | TRG | `profiles_updated_at`. Not rendered. |

No dead columns. This table is clean.

### 1.2 `trips` — 14 columns, 1 FK

| Column | Used by | Notes |
|---|---|---|
| `id`, `trip_number`, `origin`, `destination`, `departure_date`, `capacity`, `price_per_kg`, `status` | FE, DL, TRG, RPC | Core. `effective_trip_price()`, `prepare_order_insert`, `guard_order_update`. |
| `arrival_date` | FE, RPC | Surfaced publicly as `estimated_delivery` by `track_order_public()`. |
| **`available_slots`** | **WO** | Written exactly once — `database.js:425`, `available_slots: tripData.capacity \|\| 1000`. Never read, never updated, never decremented. It is a stale copy of `capacity` that was never wired up. |
| **`notes`** | **WO** | Captured at `CreateTripPage.jsx:202`, persisted via the `...tripData` spread. Zero read sites: `grep "notes" TripDetailPage.jsx TripsPage.jsx TripAssignModal.jsx TripReassignModal.jsx` returns nothing. Admins can write trip notes that no screen will ever show them again. |
| **`created_by`** | **WO** | `database.js:426`. Never read or joined. Audit value only. |
| `created_at`, `updated_at` | FE, TRG | |

### 1.3 `orders` — 46 columns, 2 FKs — the problem table

| Column | Used by | Notes |
|---|---|---|
| `id`, `user_id`, `trip_id`, `tracking_number`, `status` | everywhere | Core. |
| `origin`, `destination` | FE, DL, TRG, RPC | Denormalized from `trips`, but **legitimately** — an order may have no trip (`trip_id` nullable) and still needs a route. Overwritten from the trip by both order triggers, so it cannot drift. **Keep.** |
| `sender_name`, `sender_phone`, `sender_address`, `receiver_*` | FE, DL, RPC | `sender_address`/`receiver_address` are pre-flattened strings built by `buildFullAddress()` (`src/lib/address.js:19`). |
| `sender_province`, `sender_city`, `receiver_province`, `receiver_city` | FE, DL | Also embedded *inside* the flattened address string. Duplicated data, see §2.3. |
| `sender_facebook`, `receiver_facebook` | FE | Prefilled from `profiles.facebook_name`. Displayed on order detail. |
| `package_description`, `package_weight` | FE, TRG, RPC | `prepare_order_insert` rejects weight ≤ 0. |
| `actual_weight` | FE, TRG, RPC, EF | Nulled on insert by trigger; set at pickup; drives repricing. |
| `shipping_cost` | TRG, RPC | **Server-owned.** Recomputed by `prepare_order_insert` and `guard_order_update`. |
| `amount_paid`, `remaining_balance`, `payment_status` | TRG, RPC, FE, EF | **Contested ownership — see §2.2. This is the most important finding in this review.** |
| `payment_method` | FE, DL, RPC, EF | Also written by the reconcile RPC. |
| `payer_type` | FE, RPC | Copied from `payment_attempts` on reconcile. |
| `promised_payment_date` | FE, RPC | Pay-later due date. Displayed on 3 pages. |
| `payment_reference` | FE, DL, RPC | The PayMongo `payment_id`. Duplicates `payment_transactions.transaction_reference`. |
| **`payment_preference`** | **WO** | Collected at `BookShipmentPage.jsx:333`, stored. Zero readers in FE, DL, TRG, RPC, RLS, or EF. Added 2026-08-02 (`20260802080000`). |
| **`payment_date`** | **WO** | Written at `PickupModal.jsx:325`. `grep "order.payment_date\|o.payment_date"` → **0 hits**. Every UI that shows a payment date reads `tx.payment_date` from the ledger (`OrderDetailPage.jsx:778`, `PaymentMethodsPage.jsx:240`). |
| **`receipt_url`** | **WO + inconsistent** | Written at `PickupModal.jsx:302`, `DeliveryModal.jsx:177`. Never read. Worse: the evidence-cleanup routine (`OrderDetailPage.jsx:386-401`) deletes the storage object and nulls **only** `payment_transactions.receipt_url` — `orders.receipt_url` is left pointing at a deleted blob. |
| `pickup_photos`, `delivery_photos` | FE, DL, TRG, RPC, RLS | JSONB descriptor arrays. Constrained to `'[]'` on customer INSERT by RLS *and* by trigger. |
| `service_area_status` | FE | `for_review` → `approved`/`rejected` at `OrderDetailPage.jsx:317,332`; badge at `OrdersPage.jsx:129`. |
| **`service_area_remarks`** | **WO** | Written on rejection (`OrderDetailPage.jsx:332`). One reference in the whole codebase — the write. The rejection reason the admin types is never shown to anyone, including the customer whose booking was rejected. |
| `featured_on_website`, `featured_title`, `featured_caption`, `featured_image_type`, `featured_at` | FE, DL, RLS | Website CMS fields living on the transactional order row. Drives an **anon** RLS policy — see §2.4. |
| `reassignment_history` | DL, RPC | JSONB append-only log written by `reassign_trip()`. Read raw at `database.js:634`; the comment there admits trip numbers and admin names are not hydrated. |
| `notes` | FE | Customer booking note. Displayed. |
| `created_at`, `updated_at` | everywhere | |

**Summary: 6 of 46 order columns are write-only** (`payment_preference`, `payment_date`,
`receipt_url`, `service_area_remarks`, plus the two below in `trips`). Four distinct concerns —
shipment, payment, website-CMS, service-area-review — are mixed into one row.

### 1.4 `announcements` — 7 columns, 1 FK

All used. `author_id` is read via the PostgREST embed `profiles:author_id (name)` at `database.js:650`.
`is_active` implements a soft delete (`deleteAnnouncement` sets it false) — correct, since notifications
carry `reference_id` pointing at the announcement.

### 1.5 `notifications` — 8 columns, 1 FK

All used. `reference_id` is an **untyped polymorphic pointer** — it holds an order id, an announcement
id, or NULL depending on `type`, with no FK and no discriminator beyond `type`. See §2.5.

### 1.6 `user_device_tokens` — 4 columns, 1 FK

All used by `send-push` and `firebase-messaging.js`. Minimal and correct.

### 1.7 `notification_delivery_attempts` — 8 columns, 3 FKs — **a write-only blackhole**

Inserted at `send-push/index.ts:331,357`. Then:

- **RLS is enabled and there are zero policies on this table.** No `anon`, `authenticated`, or admin
  role can read a single row. Only `service_role` (which bypasses RLS) can.
- There is no admin UI, no RPC, no report that reads it.
- There is **no retention job** — `purge_old_activity_logs()` covers `activity_logs` only.

Every push notification the system has ever sent has written a permanently unreadable, permanently
growing row. `provider_message_id`, `error_message`, `device_token_id`, `attempted_at` have exactly
one reference each in the entire codebase: the INSERT.

### 1.8 `conversations` — 5 columns, 2 FKs

All used. `status` carries three values in practice — `'open'`, `'closed'`, `'waiting_admin'`
(`InboxPage.jsx:24,375,403`) — with **no CHECK constraint**; the column is bare `TEXT DEFAULT 'open'`.

**Schema drift:** `assigned_admin_id` is declared `UUID DEFAULT NULL` with no FK in `schema.sql:174`,
but migration `20260622000000:42` added `REFERENCES public.profiles(id) ON DELETE SET NULL`. The live
DB has the FK; `schema.sql` does not. This matters because `database.js:1082,1116` uses the PostgREST
embed `assigned_admin:assigned_admin_id (name)`, which **requires** that FK to resolve. Anyone
rebuilding from `schema.sql` alone gets a broken admin inbox.

### 1.9 `chat_messages` — 7 columns, 2 FKs

All used. `sender_id`/`sender_role` are overwritten from `auth.uid()` by `guard_chat_message_insert`,
making impersonation impossible — correct and worth preserving.

### 1.10 `contact_inquiries` — 6 columns, **0 FKs**

| Column | Notes |
|---|---|
| `name`, `message`, `created_at` | Used. |
| **`phone`** | **Polymorphic.** Stores a phone *or* an email *or* `"phone \| email"`. `AboutPage.jsx:735-747` validates either, then `ContactInquiriesPage.jsx:20-26` re-parses it with a `splitContact()` helper that splits on `\|` and sniffs for `@`. One column, two domains, no type tag. |
| `status` | Bare `TEXT NOT NULL DEFAULT 'new'`, **no CHECK**. The UI knows three values (`new`, `read`, `resolved` — `ContactInquiriesPage.jsx:14-18`) but `read` is never written by any code path. |

Also: `createContactInquiry` (`database.js:1027`) reads `data.email` and `data.subject` in its
notification message — **neither column exists**. Dead code producing `undefined` in admin
notification text.

There is **no admin DELETE policy** on this table, so inquiries can never be removed.

### 1.11 `company_information` — 22 columns, 0 FKs, singleton

All 22 columns are read. I verified each of the ones that looked like CMS dead weight:
`messenger` → `AboutPage.jsx:1384`; `hero_button_text`/`hero_button_link` → `:895`;
`long_description` → `:928`; `hero_image_url` → `:802`; `website` → CMS form.
`features` and `coverage` are JSONB and correctly so (§3.2).

### 1.12 `activity_logs` — 12 columns, 1 FK

| Column | Notes |
|---|---|
| `admin_id`, `admin_name` | **Misnamed.** Migration `20260731090000` added a policy letting *customers* insert their own logs, and `logActivity` (`activityLog.js:52`) sets `admin_id: cachedUser.id` for any signed-in user. Roughly half the rows are customer actions stored in columns called `admin_*`. |
| `module`, `action`, `details` | Used for filtering and display. |
| `new_value` | **Load-bearing.** Read by `deriveStatusTimestamps` (`statusTimestamps.js:37`) to reconstruct the shipment timeline. |
| **`previous_value`** | **WO.** One reference: the INSERT at `activityLog.js:58`. |
| **`record_type`** | **WO.** One reference: the INSERT. Never filtered, never displayed. |
| `record_id`, `record_ref` | Used — `getActivityLogsByRecord`, search. |

**This is the second most important finding.** `activity_logs` is simultaneously (a) an audit log with
a **7-day pg_cron purge** (`schema.sql:251-278`) and (b) the **only store of shipment status history**.
`OrderDetailPage.jsx:120`, `customer/OrderDetailPage.jsx:54`, and `public/TrackingPage.jsx:111` all
call `deriveStatusTimestamps(logs, …)`, which recovers "when was this picked up" by fuzzy string
matching — 20 hardcoded action strings, a `Status Changed to X` prefix parse, and substring sniffing
on `details` for `'Triggered by Trip Start'`. After 7 days every shipment's timeline silently collapses
to the backfill branch, which stamps every completed step with `order.created_at`.

Related dead path: `TrackingPage.jsx:194` guards the log fetch on `data?.id`, but
`track_order_public()` **does not return `id`** (`schema.sql:988-1002`). The public tracking page has
never fetched a single activity log. It also couldn't — `activity_logs` SELECT is admin-only.

### 1.13 `customer_feedback` — 7 columns, 2 FKs

All used. `UNIQUE (order_id)` is correct. See §2.6 for an RLS problem.

### 1.14 `payment_transactions` — 13 columns, 2 FKs — the money ledger

All 13 used. `payment_date` and `receipt_url` here are the **live** ones (the `orders` copies are the
dead ones). `transaction_reference` carries a partial unique index — the idempotency key the whole
PayMongo flow depends on.

### 1.15 `payment_attempts` — 19 columns, 2 FKs

| Column | Notes |
|---|---|
| `source_id`, `order_id`, `amount`, `status`, `payment_id`, `payment_status`, `last_error` | Core state machine. Used by both Edge Functions and the reconcile RPC. |
| `actual_weight`, `payer_type`, `pickup_photos`, `promised_payment_date` | **Staging copies of `orders` columns.** Held while the customer is inside GCash, then flushed onto the order by the reconcile RPC (`schema.sql:1464-1471`). Deliberate and correct — see §5.7. |
| `payment_type` | `'full' \| 'paylater'`; decides `final_payment_status` in the RPC. |
| **`description`** | **WO.** Written by `ensureAttempt`. `capturePayment()` takes its description from the HTTP request body, not from this row. Never read. |
| **`estimated_cost`** | **Effectively WO.** The only reads (`paymongo-create-payment/index.ts:49,78,100`) exist solely to copy the value back into itself so a re-upsert doesn't clobber it. No business logic consumes it. |
| **`reconciled_at`** | **WO.** Set by the RPC, read by nothing. |
| `created_by` | WO (audit). |

---

## Phase 2 — Table audit

### 2.1 `profiles` — **leave unchanged**

Purpose: identity + role + default address book. 14 cols / 1 FK / referenced by 9 tables.
No redundancy, no derived columns, no dead columns. The six address components are correctly
normalized-by-decomposition and are actively read to prefill bookings. `role` as a
`VARCHAR(20) CHECK` rather than an enum is fine — it has two values and is referenced from
`is_admin()`, which is `SECURITY DEFINER` and cached per statement.

One gap: **no index on `role`**. `create_admin_notifications_rpc` scans `WHERE role='admin'` on
every admin notification, and `createAnnouncement` scans `WHERE role='customer'` to fan out. At a
few thousand profiles this is a sequential scan on every booking.

### 2.2 `orders` — payment ownership is contested (**highest severity**)

`CLAUDE.md` states: *"`orders.payment_status` is derived by trigger, never written directly by a
client."* That is the intended design and `update_order_payment_totals()` implements it correctly.
**The client violates it.**

`PickupModal.jsx:325-330` writes:

```js
updates.amount_paid       = finalAmountPaid;
updates.remaining_balance = Math.max(0, estimatedCost - finalAmountPaid);
updates.payment_status    = paymentStatus;
```

`OrderDetailPage.jsx:227-238` then runs these as **two separate round trips**:

```js
await updateOrder(id, cleanData);                 // (1) writes amount_paid directly
if (pickupData.amount_paid > 0 && !skip)
  await recordPaymentTransaction(id, …);          // (2) inserts ledger → trigger recomputes
```

`updateOrder` itself (`database.js:352-363`) *also* derives `remaining_balance` and `payment_status`
client-side. So three independent authorities write the same three columns.

**Failure mode, concretely:** step (1) succeeds and stamps `amount_paid = 5000`. Step (2) inserts into
`payment_transactions` with `transaction_reference` = a PayMongo id that already exists (retry, double
click, or a webhook that landed first). `unique_tx_ref` raises `23505`. `recordPaymentTransaction`
has no `ON CONFLICT` — only the reconcile RPC does (`schema.sql:1459`) — so it throws.
`handlePickupSave` rethrows. **The order is now marked paid ₱5,000 with zero backing ledger rows,
and nothing ever reconciles it.** `get_sales_summary()` sums `orders.amount_paid`, so the discrepancy
propagates straight into revenue reporting.

The same two-step shape exists in `handleDeliverySave` (`OrderDetailPage.jsx:253-260`).

The reconcile RPC gets this right and its comment says so explicitly:
*"amount_paid is deliberately NOT written here — the ledger trigger owns it."* The admin pickup path
never got the same treatment.

Other `orders` issues: 46 columns spanning four bounded contexts; 6 write-only columns; no index on
`created_at` despite every report and the sales RPC filtering on it; `idx_orders_tracking` is redundant
with the `UNIQUE` constraint's implicit index.

### 2.3 `orders` address duplication

`sender_city` and `sender_province` are stored twice: once as columns, once concatenated inside
`sender_address` by `buildFullAddress()`. The other four components (lot/block, street, barangay,
landmark) are stored **only** inside the concatenated string. Consequence: a booking's address can
never be edited component-wise or re-validated, and `detectPickupLocation()` (the route guard at
`database.js:147`) can only work because `sender_province` happens to also exist as a column.
This is *under*-designed relative to `profiles`, which decomposes the same address correctly.

### 2.4 `orders` — anon RLS exposes full PII (**security**)

```sql
CREATE POLICY "Public can read featured orders" ON orders
  FOR SELECT TO anon USING (featured_on_website = true);
```

`getFeaturedDeliveries()` selects 10 safe columns — but the *policy* grants `anon` every column of
every featured row. `GET /rest/v1/orders?featured_on_website=eq.true&select=*` with the anon key
returns `sender_phone`, `receiver_phone`, `sender_address`, `receiver_address`, `amount_paid`,
`payment_reference`, and `user_id` for every featured shipment.

`CLAUDE.md` already states the correct rule: *"Never widen table-level anon access to serve public
pages — add or extend an RPC."* This policy is the one place that rule was broken.

### 2.5 `notifications` — untyped polymorphic reference

`reference_id UUID` points at an order, an announcement, or nothing, discriminated only by `type`.
No FK, so deleting an order leaves dangling notification links. Low severity (notifications are
ephemeral, capped at 50 per fetch) but worth naming.

Missing composite index on `(user_id, is_read)` — `getUnreadNotificationCount` runs that exact
predicate on every page load for every user.

### 2.6 `customer_feedback` — duplicate and over-broad policies

```sql
CREATE POLICY "Public can read non-hidden feedback"     ... USING (is_hidden = false);
CREATE POLICY "Public can read non-hidden feedback auth" ... USING (is_hidden = false);
```

Two byte-identical policies, neither with a `TO` clause, so both apply to every role. `anon` can
therefore read `customer_id` for every visible testimonial — a stable identifier linking a public
review to a specific user account. `getPublicFeedback()` also embeds `profiles:customer_id (name)`,
which silently returns `null` for anon and for other customers (profiles RLS blocks it), so public
testimonials render without attribution for everyone except admins. **VERIFY** against the running
site — this is my reading of the policy set, not an observed render.

### 2.7 `contact_inquiries` — under-designed

0 FKs (fine — submitters are anonymous). But: polymorphic `phone`, unconstrained `status`, no DELETE
policy, no index on `status` (the list page filters on it), and the notification message references two
non-existent columns.

### 2.8 `activity_logs` — over-loaded, under-constrained

Doing three jobs: admin audit trail, customer action log, and shipment status history. Two of the
three want different retention. `record_id` is polymorphic across order/trip/conversation/announcement/
setting/company with no FK. `module` has a CHECK; `action` is free text that
`statusTimestamps.js` parses as if it were an enum.

### 2.9 `payment_transactions` — correct, keep

This is the best-designed table in the schema. Append-only ledger, partial unique index for
idempotency, trigger-derived aggregates. Its only problem is that clients bypass it (§2.2).

`admin_name TEXT NOT NULL DEFAULT 'Unknown Admin'` denormalizes `profiles.name` — that is **correct**
for a financial ledger (the name at time of transaction must not change when someone edits their
profile). Keep it.

### 2.10 `payment_attempts` — correct, keep

19 columns looks heavy but each earns its place: it is a durable staging record for state that must
survive the customer leaving the browser mid-GCash. Row-locked reconcile, unique `source_id` and
`payment_id`, explicit state machine. Three write-only columns to prune, nothing structural.

### 2.11 `notification_delivery_attempts` — under-designed to the point of being useless

See §1.7. It has FKs and indexes and RLS enabled, and is unreadable by every role that has a login.

### 2.12 `trips`, `announcements`, `user_device_tokens`, `conversations`, `chat_messages`, `company_information`

Structurally sound. Issues are localized: `trips` has 3 write-only columns; `conversations.status`
and `contact_inquiries.status` lack CHECKs; `company_information` is a singleton enforced only by
convention (a fixed UUID) rather than by a constraint.

---

## Phase 3 — Optimization analysis

### 3.1 Things that look like problems but are not — **do not change these**

| Apparent issue | Why it must stay |
|---|---|
| `orders.origin` / `destination` duplicate `trips.*` | Orders exist without trips. Both order triggers overwrite these from the trip whenever `trip_id` is set, so drift is impossible. |
| `orders.shipping_cost` is derived from weight × price | It must be **frozen at transaction time**. Recomputing it would retroactively reprice historical orders when `company_information.default_price_per_kg` changes. Storing it is correct. |
| `orders.amount_paid` / `remaining_balance` duplicate the ledger | Correct as a trigger-maintained cache — a generated column cannot aggregate a child table. The bug is client writes, not the columns. |
| `payment_transactions.admin_name` duplicates `profiles.name` | Financial ledgers must snapshot the actor's name. |
| `payment_attempts` staging copies of order fields | They exist precisely so an abandoned browser session doesn't lose pickup data. |
| `orders.reassignment_history` JSONB | Low volume, append-only, admin-read-only. Extracting it back to a table is not worth it — though note the table it replaced (`trip_reassignments`) had FKs to `trips`, which the JSONB does not. If reassignment reporting is ever needed, that trade reverses. |
| `company_information.coverage` / `.features` JSONB | Config, edited as a whole document, drag-reordered client-side, never joined or filtered in SQL. JSONB is the right choice. |
| `orders.pickup_photos` / `delivery_photos` JSONB | Storage descriptor arrays. Right choice. |
| Two-tier price resolution (`effective_trip_price` → `global_price_per_kilo`) | Clean COALESCE chain with a hard fallback of 70. Keep. |

### 3.2 Where the schema genuinely can be simplified

**A. Drop the 11 write-only columns** — after deciding, per column, whether the *feature* was meant to
exist. Some of these are unfinished features, not dead weight:

| Column | Verdict |
|---|---|
| `trips.available_slots` | Delete. Pure duplicate of `capacity`, never maintained. |
| `trips.created_by` | Keep, but expose it (or delete). Cheap audit value. |
| `trips.notes` | **Unfinished feature.** Render it on `TripDetailPage` rather than delete it. |
| `orders.payment_date` | Delete. Ledger owns it. |
| `orders.receipt_url` | Delete. Ledger owns it, and the orphaned copy actively misleads cleanup. |
| `orders.payment_preference` | **Unfinished feature.** Either surface it to admins at pickup or delete it. |
| `orders.service_area_remarks` | **Unfinished feature.** The rejection reason should reach the customer. Wire it up, don't delete. |
| `activity_logs.previous_value` | Keep. An audit log with only the new value is half an audit log; the write already happens. Use it in the UI. |
| `activity_logs.record_type` | Keep — it is the discriminator for the polymorphic `record_id`. Use it. |
| `payment_attempts.description` | Delete. |
| `payment_attempts.estimated_cost` | Delete — but only after confirming no future partial-payment reconciliation needs it. **VERIFY** with the product owner. |
| `payment_attempts.reconciled_at` | Keep. Zero cost, real forensic value for payment disputes. |

Net honest reduction: **~5 columns**, not 11. That is the correct answer for a production logistics
system — most of these are bugs of omission, not excess.

**B. Add the missing constraints.** Free integrity, zero schema churn:

- `conversations.status` → `CHECK (status IN ('open','closed','waiting_admin'))`
- `contact_inquiries.status` → `CHECK (status IN ('new','read','resolved'))`
- `company_information` → `CHECK (id = '00000000-…0001')` to make the singleton real
- `orders` → `CHECK (remaining_balance >= 0)`, `CHECK (amount_paid >= 0)`
- `trips` → `CHECK (arrival_date IS NULL OR arrival_date > departure_date)` (currently only validated in `CreateTripPage.jsx:45`)
- `notification_delivery_attempts` → add the retention job it never got

**C. Add the missing indexes.** All of these back queries that already exist:

| Index | Backs |
|---|---|
| `profiles(role)` | `create_admin_notifications_rpc`, announcement fan-out (runs per booking) |
| `orders(created_at DESC)` | every report, `get_sales_summary` monthly CTE, all list pages |
| `orders(featured_on_website) WHERE featured_on_website` | public About page |
| `notifications(user_id, is_read)` | unread badge, every page load |
| `chat_messages(conversation_id, sender_role, is_read)` | both unread-count queries |
| `customer_feedback(customer_id)` | own-feedback reads |
| `contact_inquiries(status)` | inquiry list filter |
| `trips(departure_date)` | trip pickers |

Drop as redundant: `idx_orders_tracking` (duplicates the `UNIQUE` index),
`idx_conversations_customer_id` (duplicates `UNIQUE(customer_id)`).

**D. Reconcile `schema.sql` with the live DB.** Two known drifts:
`conversations.assigned_admin_id` FK (present live, missing in `schema.sql`) and
`idx_payment_transactions_order_id` (in migration `20260622000000`, missing from `schema.sql`).
`schema.sql` is documented as the single source of truth and currently is not one. **VERIFY** the
rest by diffing against a live `pg_dump --schema-only`; I could only compare files.

**E. Do not** convert `role`/`status` CHECKs to PostgreSQL enums. Enum value changes require
`ALTER TYPE` and are painful to reverse; the CHECK constraints cost nothing and are already in place.

---

## Phase 4 — Impact analysis

Ordered by value. Each row states why it is safe before what it changes.

### P0-1 — Make the ledger the sole writer of order payment totals

**Why safe:** `update_order_payment_totals()` already recomputes all three columns from the ledger on
every INSERT/UPDATE/DELETE. Removing the client writes removes a *competing* writer, not the only one.
The trigger's output is a strict superset of what the client computes, because the client only knows
about the payment it is currently making.

| Dimension | Impact |
|---|---|
| Pages | `PickupModal.jsx` (drop 3 assignments), `DeliveryModal.jsx`, `admin/OrderDetailPage.jsx` (`handlePickupSave`, `handleDeliverySave`) |
| API | `updateOrder` — remove the derive block at `database.js:352-363` |
| SQL | Optionally add a `guard_order_update` clause reverting client-supplied `amount_paid`/`payment_status` for non-`service_role` |
| Triggers | `update_order_payment_totals` — unchanged, becomes authoritative |
| RLS | None |
| Edge Functions | None (reconcile RPC already does this correctly) |
| Migration difficulty | **Low** — mostly deletion. A one-off backfill query should reconcile existing drifted rows first. |
| Risk | **Medium.** Touches the money path. Needs manual QA of all four flows: cash pickup, GCash pickup, pay-later, delivery settlement. |
| Performance | Slightly better — one fewer round trip per pickup. |

Prerequisite: make the two steps atomic. A `record_pickup_payment(...)` RPC that does the order
UPDATE and the ledger INSERT in one transaction removes the failure window entirely.

### P0-2 — Move status history off `activity_logs`

**Why safe:** additive. Write timestamps to a new store *in parallel* with existing logging;
`deriveStatusTimestamps` keeps working as a fallback until the new store is populated.

Two viable shapes:

- **`order_status_events(order_id, status, changed_at, changed_by, note)`** — append-only, FK-backed,
  no retention purge. A trigger on `orders` (`AFTER UPDATE OF status`) fills it, so no client can
  forget to. Preferred.
- Or timestamp columns on `orders` (`picked_up_at`, `in_transit_at`, …) — fewer moving parts, but adds
  8 nullable columns to an already 46-column table and can't record who or why.

| Dimension | Impact |
|---|---|
| Pages | `admin/OrderDetailPage.jsx:120`, `customer/OrderDetailPage.jsx:54`, `public/TrackingPage.jsx:111` |
| API | New `getOrderStatusEvents()`; `statusTimestamps.js` becomes a thin mapper, ~120 lines of string matching deleted |
| SQL | New table + `AFTER UPDATE OF status ON orders` trigger |
| Triggers | New; existing untouched |
| RLS | New table: own-order read + admin all. **Plus** extend `track_order_public()` to return the event list, which finally makes the public timeline work (it currently never has). |
| Edge Functions | None |
| Migration difficulty | **Medium.** Backfill from surviving `activity_logs` rows (≤7 days) plus `orders.created_at`/`updated_at`. Older history is already unrecoverable. |
| Risk | **Low.** Purely additive; old path stays as fallback during rollout. |
| Performance | **Better** — an indexed FK lookup replaces fetching every log row for a record and string-parsing it in JS. |

### P0-3 — Close the anon PII hole on featured orders

**Why safe:** `getFeaturedDeliveries()` already selects only 10 columns. An RPC returning exactly those
10 is behaviourally identical for the app and strictly narrower for everyone else.

| Dimension | Impact |
|---|---|
| Pages | `public/AboutPage.jsx:662` (via `getFeaturedDeliveries`) — no visible change |
| API | `getFeaturedDeliveries` → `supabase.rpc('get_featured_deliveries')` |
| SQL | New `SECURITY DEFINER` RPC, `GRANT EXECUTE TO anon, authenticated` |
| RLS | **Drop** `"Public can read featured orders"` and `"Public can read featured orders auth"` |
| Migration difficulty | **Low** |
| Risk | **Low.** Regression surface is one public page. |
| Performance | Neutral (add the partial index from §3.2C). |

Same treatment for `customer_feedback`: replace the two duplicate policies with one
`get_public_feedback()` RPC that returns rating, message, date, masked name via the existing
`mask_name()`, and the resolved photo — and never `customer_id`.

### P1-1 — Delete the four confirmed-dead columns

`trips.available_slots`, `orders.payment_date`, `orders.receipt_url`, `payment_attempts.description`.

**Why safe:** zero read sites in FE, DL, TRG, RPC, RLS, or EF. Grep evidence is in Phase 1.

| Dimension | Impact |
|---|---|
| Pages | `PickupModal.jsx:302,325`, `DeliveryModal.jsx:177` — remove the assignments |
| API | `database.js:425` — remove `available_slots` |
| SQL / RLS / EF | None |
| Migration difficulty | **Low** |
| Risk | **Low**, but irreversible for existing data. **Archive `orders.receipt_url` and `orders.payment_date` values before dropping** — if any predate the ledger's own `receipt_url`/`payment_date` columns (added `20260622000000` / `20260625020000`), those rows hold receipts that exist nowhere else. **VERIFY** with `SELECT count(*) FROM orders WHERE receipt_url IS NOT NULL AND created_at < '2026-06-22'`. |
| Performance | Marginal. |

Recommended sequencing for all drops: rename to `_deprecated_<col>` for one release, confirm nothing
breaks, then drop. Two migrations, no risk window.

### P1-2 — Finish the three unfinished features

`trips.notes` (render it), `orders.service_area_remarks` (show the customer why their booking was
rejected), `orders.payment_preference` (surface at pickup).

Frontend-only. **Zero** SQL, trigger, RLS, or Edge Function impact. Risk **very low**.
`service_area_remarks` is arguably a customer-service defect, not a schema one — a customer whose
booking is rejected currently gets a `Cancelled` status and no reason.

### P1-3 — `notification_delivery_attempts`: give it a reader or a lifecycle

Three options, in order of preference: (a) add an admin SELECT policy + a small delivery-health panel
and a 30-day purge; (b) keep it write-only but add the purge; (c) drop the table.

Do not choose (c) without asking — push delivery diagnostics on iOS PWAs are genuinely hard to debug
without this data, which is presumably why it was built.

| Dimension | Impact |
|---|---|
| SQL | One policy + one `cron.schedule` (mirror `purge_old_activity_logs`) |
| Everything else | None |
| Risk | **Very low** |
| Performance | **Better** — bounds unbounded growth. |

### P2-1 — Indexes and CHECK constraints (§3.2 B & C)

**Why safe:** additive, non-breaking, individually revertible. Build indexes `CONCURRENTLY` in
production. Before adding each CHECK, run the equivalent `SELECT count(*) WHERE NOT (<predicate>)` —
if existing rows violate it, `ALTER TABLE ADD CONSTRAINT` will fail loudly, which is the desired
outcome but should be discovered in a maintenance window, not at deploy time.

Risk **very low**. Performance **better**.

### P2-2 — Normalize `contact_inquiries.phone`

Split into `contact_phone` + `contact_email`, backfill using the same `splitContact()` logic that
already exists at `ContactInquiriesPage.jsx:20-26`, delete the helper.

Pages: `AboutPage.jsx:760`, `ContactInquiriesPage.jsx`. SQL: 2 columns + backfill + drop.
Risk **low** (write path is one form; read path is one page). Migration **low-medium** (a backfill
that must be idempotent).

### P3-1 — Split `orders` by bounded context — **evaluate, do not schedule**

The five `featured_*` columns are website CMS state on a financial record. Moving them to
`featured_shipments(order_id PK, title, caption, image_type, featured_at)` would drop `orders` to 41
columns, remove the anon policy's reason to exist, and give the public page a table with no PII in it.

But: it touches the order detail page, the About page, two RLS policies, and needs a backfill —
for a genuine but modest gain. **I would do P0-1, P0-2 and P0-3 first and revisit this only if
`orders` keeps accreting columns.** A 46-column table is large, not broken.

---

## Phase 5 — Redesign plan

### 5.1 Order payment totals — single writer

**BEFORE** — three writers, non-atomic:
```
PickupModal ──► updateOrder() ──► orders.amount_paid = X          (write 1)
                     └─ database.js derives remaining_balance      (write 2)
OrderDetailPage ──► recordPaymentTransaction() ──► ledger INSERT
                     └─ trigger recomputes all three               (write 3)
```

**AFTER** — one writer:
```
PickupModal ──► record_pickup_payment() RPC  [single transaction]
                   ├─ UPDATE orders SET actual_weight, payment_method,
                   │                    payer_type, pickup_photos, status
                   └─ INSERT payment_transactions
                          └─ trigger → amount_paid, remaining_balance, payment_status
```

**Reason:** the CLAUDE.md invariant is already written down; only the admin pickup path violates it.
**Benefits:** eliminates the paid-with-no-ledger-row failure; makes pickup atomic; removes ~15 lines
of duplicated arithmetic from `database.js` and `PickupModal.jsx`; `get_sales_summary()` becomes
provably equal to `SUM(payment_transactions.amount)`.
**Risks:** money path — needs a full manual QA matrix. Mitigate by shipping the RPC first, running
both paths against a staging order, then removing the client writes.
**Column reduction:** 0. **Complexity reduction:** high — one authority instead of three.

### 5.2 Status history

**BEFORE**
```
orders.status  (current state only)
activity_logs  (action TEXT, new_value JSONB, details TEXT)
      ↓  purged after 7 days by pg_cron
statusTimestamps.js  — 20-entry lookup table + prefix parse + substring sniff
      ↓
TrackingTimeline
```

**AFTER**
```
orders.status  (current state)
order_status_events(id, order_id FK, status, changed_at, changed_by FK, note)
      ↑ AFTER UPDATE OF status ON orders — no retention purge
      ↓
getOrderStatusEvents()  →  TrackingTimeline
track_order_public()    →  returns the event list, masked
activity_logs           →  reverts to being purely an audit log
```

**Reason:** business state must not live in a store that self-deletes after 7 days.
**Benefits:** permanent shipment history; the public tracking timeline works for the first time;
`statusTimestamps.js` shrinks from 158 lines to ~20; a trigger cannot forget to log the way a
`logOrder()` call site can.
**Risks:** history older than 7 days is already gone and cannot be recovered — the backfill will
be thin. Say so to stakeholders before migrating.
**Column reduction:** +5 (a new table). **Complexity reduction:** high.

This is the one place I recommend *adding* structure. Data integrity over column count.

### 5.3 Public data access

**BEFORE**
```
anon ──► RLS "Public can read featured orders" ──► orders.*   ← all 46 columns
anon ──► RLS "Public can read non-hidden feedback" ──► customer_feedback.*  ← incl. customer_id
```

**AFTER**
```
anon ──► get_featured_deliveries()  ──► 10 whitelisted columns
anon ──► get_public_feedback()      ──► rating, message, created_at, mask_name(name), photo
```

**Reason:** the codebase's own stated rule. Two RPCs already prove the pattern
(`track_order_public`, `get_public_business_profile`).
**Benefits:** closes a PII leak; makes the public surface auditable in one place; lets the About
page finally show attributed testimonials (via `mask_name`) instead of blank names.
**Risks:** low. **Column reduction:** 0. **Complexity reduction:** moderate (4 policies → 2 RPCs).

### 5.4 Dead columns

**BEFORE:** `trips.available_slots`, `orders.payment_date`, `orders.receipt_url`,
`payment_attempts.description` — written, never read.
**AFTER:** dropped, after a one-release `_deprecated_` rename and a data-archival check.
**Column reduction:** −4 (192 → 188). **Complexity reduction:** low but real — removes three
misleading columns from the payment domain, where ambiguity is most expensive.

### 5.5 Constraints and indexes

**BEFORE:** 2 unconstrained status columns; a singleton enforced by a magic UUID; no index on
`profiles(role)`, `orders(created_at)`, or `notifications(user_id, is_read)`; 2 redundant indexes.
**AFTER:** 6 CHECKs added, 8 indexes added, 2 dropped.
**Benefits:** invalid states become unrepresentable; the announcement fan-out and unread badge stop
sequential-scanning. **Risks:** a CHECK may reject existing bad rows — that is the point; discover it
in a maintenance window. **Column reduction:** 0.

### 5.6 `contact_inquiries`

**BEFORE:** `phone TEXT` holding phone | email | `"phone | email"`, decoded by a client helper.
**AFTER:** `contact_phone TEXT` + `contact_email TEXT`, `status` CHECK-constrained, admin DELETE
policy, index on `status`. Also fix the `data.email`/`data.subject` references in
`createContactInquiry` that read non-existent columns.
**Column reduction:** +1. **Complexity reduction:** moderate — one parsing helper deleted, and
"email the person back" becomes a query instead of a string parse.

### 5.7 What stays exactly as it is

`profiles` · `payment_transactions` · `payment_attempts` (minus 2 columns) · `user_device_tokens` ·
`chat_messages` · `announcements` · `company_information` · the trigger set
(`guard_profile_write`, `prepare_order_insert`, `guard_order_update`, `guard_chat_message_insert`,
`update_order_payment_totals`) · the price-resolution chain · `track_order_public` + `mask_name` ·
the storage descriptor design · all JSONB usage except `reassignment_history` (which is defensible).

The payment subsystem in particular is the strongest part of this schema — dual-path reconciliation,
row locks, partial unique index, orphan recovery, self-heal, constant-time HMAC. It should not be
touched beyond removing the two write-only columns and fixing the *client-side* dual write.

---

## Summary

| | Count |
|---|---|
| Tables | 15 (all justified; none should be merged or dropped outright) |
| Columns | 192 → ~188 after honest pruning |
| Confirmed write-only columns | 11 (4 truly dead, 4 unfinished features, 3 low-cost audit fields) |
| Confirmed dead code paths | 2 (public tracking log fetch; `data.email`/`data.subject` in `createContactInquiry`) |
| Security findings | 2 (anon PII on featured orders; `customer_id` exposed via public feedback) |
| Data-integrity findings | 2 (contested payment-total ownership; status history on a 7-day purge) |
| Schema drift vs. live DB | 2 confirmed (`assigned_admin_id` FK, `idx_payment_transactions_order_id`) |
| Missing indexes backing existing queries | 8 |
| Missing CHECK constraints | 6 |

**Recommended order:** P0-1 (payment single writer) → P0-3 (anon PII, small and quick) → P0-2 (status
history) → P1 (dead columns, unfinished features, delivery-attempts lifecycle) → P2 (indexes,
constraints, contact normalization). P3 (splitting `orders`) is optional and should be re-evaluated
only after the above land.

**The headline is not column count.** This schema is not bloated — it is 15 well-chosen tables with
a genuinely excellent payment core. Its two real problems are that the *client* writes columns the
*database* is supposed to own, and that business-critical history lives in a table that deletes
itself weekly. Fixing those two is worth more than every column removal in this document combined.
