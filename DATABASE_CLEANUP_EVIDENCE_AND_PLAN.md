# CargoExpress PH — Database Cleanup Evidence and Plan

**Type:** Inspection and proposal only. No table, column, row, migration, function or application file was changed. Nothing was committed, pushed or deployed.
**Inspection date:** 2026-09-25

---

## 1. Inspection baseline

| Item | Value |
|---|---|
| Repository commit | `cd42145680d4a94c5b2442a24c0f57795a67e153` (branch `main`; only untracked Chapter 2 files in the working tree) |
| Supabase project ref | `duigaivxgxlnjmfienhg` (from the linked Supabase CLI project) |
| Live application tables (`public`) | **27** base tables, **0** views, **0** materialized views |
| Live columns (`public`) | **377** |
| Generated columns | **0** |
| Local migration files | 219 |
| Local vs applied migrations | **219 local = 219 applied, 0 mismatches.** Every local version has a matching remote version. |
| Live DB objects inspected | 182 functions (`public` + `private`), 50 triggers, all RLS policies, all constraints, all indexes, 10 `pg_cron` jobs |
| Deployed Edge Functions | 21 ACTIVE. 20 match repository folder names. **`support-bot` (v3) is deployed but absent from the repo.** Its downloaded source (kept in a scratch folder, not the repo) is a 12-line stub that returns HTTP 410 "retired" and touches no table. |

### Live row counts (read-only `count(*)`)

| Table | Rows | Table | Rows |
|---|---|---|---|
| activity_logs | 515 | notifications | 292 |
| announcement_email_broadcasts | 5 | order_status_events | 34 |
| announcement_email_recipients | 31 | orders | 11 |
| announcements | 13 | payment_attempts | 18 |
| cancellation_settlement_history | 1 | payment_refunds | 2 |
| cancellation_settlements | 0 | payment_transactions | 18 |
| chat_messages | 85 | photo_cleanup_queue | 0 |
| company_information | 1 | photo_storage_events | 17 |
| contact_inquiries | **0** | photo_storage_settings | 1 |
| conversations | 2 | profiles | 8 |
| customer_feedback | 2 | trips | 3 |
| email_subscriptions | 8 | user_device_tokens | 1 |
| legal_consents | 10 | legal_documents | 2 |
| notification_delivery_jobs | 293 | | |

### Scheduled jobs (live `cron.job`)
`purge_old_activity_logs`, `auto_resolve_stale_conversations`, `daily_payment_reminders`, `scheduled_old_photo_cleanup`, `photo_storage_health_check`, `process_push_deliveries` (every minute), `purge_old_notification_delivery_jobs`, `monitor_push_delivery_health`, `paymongo_refund_recovery`, `purge_photo_storage_operational_logs`. All active.

### How the evidence was gathered
- **Live database:** `supabase db query --linked` using only `SELECT` against `information_schema`, `pg_catalog`, `pg_policies`, `cron.job` and aggregate queries on application tables.
- **Personal data:** For name and address comparisons, raw rows were piped straight into a local script that printed **counts only**. No names, phone numbers, addresses, emails or payment references were shown, stored in this report, or written to disk.
- **Dependency matrix:** For each of the 377 live columns, whole-word matches were counted in (a) live function, trigger, policy, constraint and index definitions, (b) `src/`, (c) `supabase/functions/`, and (d) `scripts/` + `tests/`. Columns with generic names (`id`, `status`, `name`, `notes` …) produce inflated counts. Every column flagged as unusual was checked by reading the code.

### Limitations (read these before approving anything)
1. **Deployed frontend is unverified.** I could not confirm that the hosted web build matches commit `cd42145`. Older PWA clients may still be cached on customer phones.
2. **Deployed Edge Function source was verified for `support-bot` only.** For the other 20, I confirmed the names and versions, but not that the deployed code is byte-identical to the repo.
3. **The dataset is very small** (11 orders, 3 trips, 0 contact inquiries). A 100% match on 11 rows is weak evidence. It shows that the current code writes consistently, not that every future or edge-case row will too.
4. **External consumers were not inspected:** PayMongo dashboard exports, manual SQL reports, or other tools that read the DB with the service role.

---

## 2. Findings for the columns you listed

### 2.1 `contact_inquiries.phone` vs `contact_phone`

| | `phone` | `contact_phone` |
|---|---|---|
| Live definition | `text NOT NULL`, CHECK `char_length(btrim(phone)) BETWEEN 6 AND 100` | `text NULL` |
| What it really holds | **Legacy combined contact field.** Before 2026-08-03 it held a phone OR an email OR `"phone \| email"`. It is still dual-written as `"<phone> \| <email>"`. | **Normalized mobile number only.** |
| Writer | Edge Function `submit-inquiry` (the only insert path; there is no INSERT RLS policy). It builds `[contact_phone, contact_email].join(' \| ')`, falls back to whichever one exists, and truncates to 100 characters. `database.js createContactInquiry` sends the same legacy value. | `submit-inquiry` from the form's single phone input (`AboutPage.jsx:681` → `normalizePhone(phone)`). |
| Readers | **Live trigger `guard_contact_inquiry_rate_limit()`**: `WHERE phone = NEW.phone AND created_at > now() - 10 min` → rejects the 4th inquiry. It also trims `NEW.phone`. `ContactInquiriesPage.jsx readContact()` parses it as a fallback for rows where both normalized columns are NULL. | `ContactInquiriesPage.jsx readContact()` (preferred source). |
| Live data | 0 rows, so there is nothing to compare. | 0 rows |

**Conclusion:** `contact_phone` is **not** an alternative or second number. It is the normalized form of the single phone input. `phone` is **not** a duplicate of `contact_phone`. It holds phone + email together, and it is the **key for the live anti-spam rate limiter** and the target of a NOT NULL/CHECK constraint. Migration `20260803140000` planned to deprecate `phone` later, but that step never happened.

**Recommendation: `phone` → KEEP TEMPORARILY (security/compatibility dependency). `contact_phone` → KEEP.**
Dropping `phone` today would break every inquiry insert: the Edge Function writes it, and the rate-limit trigger reads `NEW.phone`. The rate limiter would also need a new key, for example `coalesce(contact_phone, contact_email)` or `ip`. A cleanup is possible (see §7, Candidate C), but it is a security change, not just a column removal.

### 2.2 `trips.capacity`, `trips.price_per_kg` vs `company_information.default_capacity`, `default_price_per_kg`

**Flow traced:**
1. `CreateTripPage.jsx:34-56,142-143` reads the company defaults and **copies** them into the new trip (`capacity: defaults.capacity, price_per_kg: defaults.price_per_kg`). The admin can no longer type them per trip.
2. Live `effective_trip_price(trip_id)` = `COALESCE(NULLIF(trips.price_per_kg,0), global_price_per_kilo())`. `global_price_per_kilo()` reads `company_information.default_price_per_kg`, falling back to 70.
3. Live `guard_order_update()` **recomputes `orders.shipping_cost = ROUND(actual_weight × effective_trip_price(trip_id), 2)` whenever `actual_weight`, `trip_id`, `amount_paid` or `discount_amount` changes.** Every recorded payment changes `amount_paid`, so **the price is recomputed on every payment, not just at pickup.**
4. `guard_order_update()` and the insert path enforce van capacity: `SUM(actual_weight of non-cancelled orders on trip) + new weight ≤ trips.capacity + allowance`.

**What happens when company defaults change:**
- Existing trips keep their stored `price_per_kg` and `capacity`. Existing orders on those trips keep being priced at the **trip's** rate, even when a new payment triggers a recompute. **This is the historical-snapshot protection.**
- If `trips.price_per_kg` were removed and pricing read the company default instead, the next payment on an old order would **silently re-price that order at the new rate**. That would change `shipping_cost`, `remaining_balance` and `payment_status` on historical bookings, and sales reports would change after the fact.
- Capacity works the same way: lowering the company default would retroactively make fully booked past trips "over capacity" and block weight corrections on them.

**Live data:** 3 trips; all 3 have `price_per_kg = default_price_per_kg` and `capacity = default_capacity` (1 distinct price). All 5 weighed orders with a trip have `shipping_cost` equal to the trip rate, which is currently also the default rate. **The data cannot show any divergence yet, because the default has never changed since these trips were created.** Equal values today do not make the columns redundant.

**Recommendation: both → KEEP: historical/audit requirement.** Not a cleanup candidate.

### 2.3 `orders` names

| Column | Live type | Role |
|---|---|---|
| `sender_first_name`, `sender_last_name`, `receiver_first_name`, `receiver_last_name` | `text NOT NULL DEFAULT ''` | **Authoritative input** from the current booking forms (`BookShipmentPage.jsx:501-504`, `AdminCreateBookingPage.jsx`) and from the `update_order_contact_details` RPC, which requires both parts. Validated by `is_valid_person_name`. |
| `sender_name`, `receiver_name` | `varchar NOT NULL` | **Trigger-maintained full name.** |

**Synchronization (live triggers):**
- `orders_sync_sender_receiver_names_insert` (BEFORE INSERT): fills the parts from the full name if the parts are empty, then sets `full = trim(concat_ws(' ', first, last))`.
- `guard_order_update()`: if the parts changed, it rebuilds the full name. If **only** the full name changed (for example an older client), it splits on the first space into first + rest. So sync works in **both directions**. `update_order_contact_details` comments state it deliberately does not set the full names and leaves that to the trigger.

**Readers of the full-name columns (would break if removed):**
- Live RPC `get_public_tracking(...)`: returns `mask_name(o.sender_name)`, `mask_name(o.receiver_name)`, part of the public tracking response format.
- Live report RPCs: `COALESCE(o.receiver_name, o.sender_name) AS customer_name` (2 functions).
- Live notification functions: `COALESCE(NULLIF(btrim(sender_name),''),'Customer')` in new-booking and cancellation notifications. Another RPC selects `o.sender_name, o.receiver_name`.
- Frontend: 15 files, including `PackageQrLabels.jsx` (QR labels), `PickupModal.jsx`, `DeliveryModal.jsx`, `AdditionalPaymentModal.jsx` and `string.js`. Also 17 test files.
- Older PWA clients that still send only `sender_name` rely on the split-back branch.

**Aggregate comparison (11 orders; normalization = trim each part and join with one space; also checked with whitespace collapsed):**

| Side | Both populated & exact match | Match after whitespace normalization | Differ | Only full populated | Only parts populated | First or last empty |
|---|---|---|---|---|---|---|
| Sender | 11 | 0 | 0 | 0 | 0 | 0 |
| Receiver | 11 | 0 | 0 | 0 | 0 | 0 |

Values that could not be reconstructed: **0 of 11** on both sides.

**Assessment:** The full names **can** be derived exactly from the parts today. They still have many live consumers (a public RPC response, reports, notifications, QR labels, 15 UI files and old clients). For legacy rows created before the parts existed, the insert trigger split one string into parts. For a name like "Maria Clara Dela Cruz", the split into first/last is a guess, but joining the parts back together still gives the original full string, so nothing is lost.

**Recommendation: `*_first_name` / `*_last_name` → KEEP (authoritative). `sender_name` / `receiver_name` → KEEP TEMPORARILY (compatibility). Long-term DERIVE CANDIDATE**, but only via a staged plan (§7, Candidate D). The benefit is small: two columns whose values triggers already keep correct.

### 2.4 `orders` addresses

Verified column spelling in the live schema:
`sender_address`, `sender_lot_block`, `sender_street`, `sender_barangay`, `sender_city`, `sender_province`, `sender_landmark`, and the same six for `receiver_`. **There is no `*_lotblock`, `*_brgy` or `*_municipality`.**

**How the full address is produced:** by the **browser**, with `src/lib/address.js buildFullAddress()`:
- Trim leading/trailing spaces and commas from each part, collapse repeated commas, drop empty parts.
- Drop a part that equals the previous one, ignoring case.
- Join as `lot_block, street, barangay, city, province`.
- Append ` (Landmark: <landmark>)` if a landmark is present.

The database does **not** compute it. `update_order_contact_details` accepts `p_sender_address` / `p_receiver_address` as **separate parameters** and stores them as sent, so an admin edit can make the full address differ from the parts. For "Other Area" pickups, the customer form stores the free-text province in `sender_province`, so this case stays reconstructable.

**Aggregate comparison (11 orders; normalization = exact re-implementation of `buildFullAddress`, then also a case-insensitive/whitespace-collapsed comparison):**

| Side | Full address NULL/empty | Exact match with rebuilt value | Match only after case/whitespace normalization | Differ (cannot reconstruct) | All parts empty |
|---|---|---|---|---|---|
| Sender | 0 | 11 | 0 | 0 | 0 |
| Receiver | 0 | 11 | 0 | 0 | 0 |

All 11 orders have `service_area_status = 'standard'`, so no out-of-coverage rows exist to test.

**Why still keep it:**
- `sender_address`/`receiver_address` are `NOT NULL`. They are shown directly on both OrderDetail pages and on the out-of-coverage review banner, written to the activity log, included in the contact-edit audit JSON, and referenced by 6 test files.
- The full address is a **booking-time snapshot** of what the customer saw and confirmed. If it were derived, the displayed address of old bookings would change whenever `buildFullAddress` formatting changes (landmark wording, deduplication rule).
- The admin-edit RPC accepts it independently, so future rows *may* hold text that the parts can't reproduce.

**Recommendation: full address → KEEP (booking-time snapshot + independent admin-edit input). Parts → KEEP (used for coverage/geo filters, `TripDetailPage` grouping, and booking-draft reuse).** Not a cleanup candidate now. A smaller hardening step is suggested instead (§7, Candidate E).

---

## 3. Other tables and columns: notable findings

For every column in the live schema, the dependency matrix found at least one writer or reader somewhere (live DB object, frontend or Edge Function). The table-level picture:

| Table | Purpose | Assessment |
|---|---|---|
| orders | Booking, pricing, status, evidence photos, feature-on-site | Core. Payment totals are trigger-derived from the ledger by design (fast RLS-guarded reads). See §2. |
| trips | Scheduled van runs | `departure_date`/`arrival_date` = **planned** schedule; `departure_at`/`arrived_at` = **server-stamped actual** times; `estimated_arrival_at` = forecast set at Start Trip. Live data: `departure_at` NULL on 2 of 3, `estimated_arrival_at` NULL on 3 of 3, 0 equal to the planned values. Migration `20260922120000` documents these as separate facts. **KEEP all.** |
| payment_attempts vs payment_transactions vs payment_refunds | PayMongo attempts / confirmed ledger / refunds | **Different things. Must not be merged.** Attempts can fail or expire; the ledger holds only confirmed money; refunds have their own provider lifecycle. |
| payment_attempts.estimated_cost | Originally a reconcile hint | **REMOVAL CANDIDATE.** 0 of 18 rows populated. No live DB function reads it. The only frontend writer (`createPaymentAttempt`) is **never called**. The Edge Function only carries forward an existing value (always NULL). It is still named in `paymongo-create-payment` `.select()` lists, so the Edge Function must change first. |
| payment_attempts.description | Human-readable charge label | **Optional REMOVAL CANDIDATE.** 18 of 18 populated; written by `paymongo-create-payment`; **no reader** (the webhook uses PayMongo's own `attributes.description`). Migration `20260803150000` already recorded the safe order: redeploy the Edge Function first, then remove the column. Low value; it could also be kept as a small audit trail. |
| profiles.wants_announcements / contact_inquiries.wants_announcements vs email_subscriptions | Marketing consent | `email_subscriptions` is authoritative; triggers mirror the flags into it. Edge Functions `broadcast-announcement` and `email-trip-reschedule` still read `profiles.wants_announcements` directly. **Live drift found: of 8 profiles, 6 have a subscription row; 5 flags match and 1 differs.** Not a cleanup candidate. It is a **consistency issue to investigate** before any consolidation. `contact_inquiries.wants_announcements` is the consent given at submission time: **KEEP: historical.** |
| orders.payment_preference | Customer's preferred payment method at booking | 0 of 11 set to anything other than `'unspecified'`, but the booking forms collect it and `PickupModal.jsx:576-580` displays it. **KEEP** (active feature, just unused so far). |
| conversations.bot_resolved | Bot-resolution outcome | 0 of 2 set, but `database.js` writes it deliberately (NULL = "unknown"). **KEEP.** |
| legal_documents.effective_at, published_at | Legal version dates | No code reads them, but they are the legal record of when each version took effect. **KEEP: historical/audit.** |
| activity_logs.admin_name, payment_transactions.admin_name, payment_refunds.initiated_by_name, cancellation_settlement_history.changed_by_name, .tracking_number | Name/reference snapshots | Look derivable through a join, but they preserve the value **at the time of the action** (a staff name can change; a profile can be deleted). 14 of 18 ledger rows have NULL `admin_id` (customer GCash payments), so a join could not rebuild them. **KEEP: historical/audit.** |
| orders.origin / destination vs trips.origin / destination | Route | The trigger copies them from the trip, but 3 of 11 orders have no trip yet and need their own route. **KEEP.** |
| notifications.reference_id, payment_transaction_id, payment_refund_id | Links to the related record | Separate typed FKs used by payment notification deduplication. **KEEP.** |
| cancellation_settlements (0 rows) vs cancellation_settlement_history (1 row) | Current decision vs audit trail | Empty ≠ unused: live RPCs write both. **KEEP.** |
| photo_cleanup_queue (0 rows) | Storage deletion retry queue | Used by the cleanup cron. **KEEP.** |
| Repo-only dead code: `database.js createPaymentAttempt` | — | Exported, never imported. Not a DB column, but should be removed together with Candidate A. |

The full per-column inventory with evidence counts is in **Appendix A**.

---

## 4. Consolidated classification table (focus and candidate columns)

| Table/Column | Actual Purpose | Readers and Writers | Data Findings | Recommendation | Risk if Removed | Evidence |
|---|---|---|---|---|---|---|
| contact_inquiries.phone | Legacy combined contact (`phone \| email`); rate-limit key | W: `submit-inquiry` EF. R: live `guard_contact_inquiry_rate_limit`, `ContactInquiriesPage readContact` fallback | 0 rows | KEEP TEMPORARILY | Every inquiry insert fails (NOT NULL + EF writes it); anti-spam limiter breaks | live trigger fn; `submit-inquiry/index.ts:132-140`; migration 20260803140000 |
| contact_inquiries.contact_phone | Normalized mobile number (the single phone input) | W: `submit-inquiry`. R: `ContactInquiriesPage` | 0 rows | KEEP | Admins lose the phone number | `AboutPage.jsx:681`; `ContactInquiriesPage.jsx:35` |
| contact_inquiries.contact_email | Normalized email | W: `submit-inquiry`. R: admin page, `unsubscribe_email_updates`, subscription-sync trigger | 0 rows | KEEP | Unsubscribe and consent sync break | live fns |
| trips.capacity | Capacity snapshot at trip creation; enforced limit | W: `CreateTripPage` (copied from default). R: `guard_order_update`, insert guard, 19 UI files | 3 of 3 = current default | KEEP: historical | Past trips re-evaluated against the new default; weight corrections blocked | live `guard_order_update` |
| trips.price_per_kg | Rate snapshot at trip creation | W: `CreateTripPage`. R: `effective_trip_price` → `shipping_cost` on every payment | 3 of 3 = current default; 5 of 5 weighed orders priced at the trip rate | KEEP: historical | Old orders re-priced on their next payment; reports change | live `effective_trip_price`, `guard_order_update` |
| company_information.default_capacity / default_price_per_kg | Defaults for **new** trips; fallback rate when there is no trip | W: admin company page. R: `CreateTripPage`, `global_price_per_kilo` | 1 row | KEEP | No defaults for new trips | live `global_price_per_kilo` |
| orders.sender/receiver_first_name, _last_name | Authoritative name parts | W: booking forms, `update_order_contact_details`, trigger split. R: forms, validation triggers | 11 of 11 populated | KEEP | Name editing and validation break | live triggers |
| orders.sender_name, receiver_name | Trigger-synced full name | W: triggers (from parts), old clients. R: public tracking RPC, reports, notifications, QR labels, 15 UI files | 11 of 11 exact = trim(first ␠ last); 0 not reconstructable | KEEP TEMPORARILY (DERIVE CANDIDATE long-term) | Public tracking response, reports, notifications and QR labels break; old clients' writes lost | live fns listed in §2.3 |
| orders.sender_address, receiver_address | Booking-time full address snapshot | W: browser `buildFullAddress`, admin-edit RPC (independent param). R: OrderDetail (both roles), coverage banner, activity log | 11 of 11 exact rebuild; 0 differ | KEEP | NOT NULL insert failure; displayed history changes when formatting logic changes | `address.js:17`; live `update_order_contact_details` |
| orders.sender/receiver lot_block, street, barangay, city, province, landmark | Structured address | W: booking forms, admin-edit RPC. R: TripDetail grouping, drafts, change-detection trigger | all populated | KEEP | Coverage and grouping features break | `bookingDraft.js`, `TripDetailPage` |
| trips.departure_date / departure_at / arrival_date / estimated_arrival_at / arrived_at | Planned vs actual vs forecast | W: create/reschedule RPCs, status-transition trigger (clock). R: tracking RPC, UI | 0 of 3 planned = actual | KEEP | Loss of planned-vs-actual history | migration 20260922120000 |
| payment_attempts.estimated_cost | Unused reconcile hint | W: none active (EF carry-forward of NULL; dead `createPaymentAttempt`). R: EF `.select()` only | 0 of 18 non-NULL | REMOVAL CANDIDATE | None to data; **EF select fails if dropped before redeploy** | `paymongo-create-payment/index.ts:71,124,157` |
| payment_attempts.description | Charge label | W: `paymongo-create-payment`. R: none | 18 of 18 populated | REMOVAL CANDIDATE (optional; low value) | Loses a minor audit label; EF insert fails if dropped before redeploy | migration 20260803150000 notes |
| profiles.wants_announcements | Consent flag (mirrored to email_subscriptions) | W: register/profile, unsubscribe RPCs. R: 2 EFs, sync trigger | 1 drift of 6 comparable | KEEP TEMPORARILY | Broadcast/reschedule emails break | EF sources |
| Deployed EF `support-bot` | Retired stub | Returns 410; no table access | — | UNVERIFIED whether any cached old PWA still calls it | A cached old client would get 404 instead of 410 | downloaded source |

---

## 5. Stored duplicate vs computed value: which approach fits

| Case | Keep stored | SELECT expression | View | RPC computed | Generated column | Frontend display-only | Recommended |
|---|---|---|---|---|---|---|---|
| Order full names | ✔ today | `trim(concat_ws(' ', first, last))` | possible | already done in tracking RPC | **best long-term fit**: `GENERATED ALWAYS AS (btrim(concat_ws(' ', sender_first_name, sender_last_name))) STORED` keeps the column name, so every reader keeps working, and it can't drift | risky: RPCs and emails also need it | Keep now → later convert to a **generated column** (same name, no reader changes). Requires old clients to stop *writing* `sender_name` first, because writes to a generated column are rejected. |
| Order full address | ✔ | would need the JS algorithm ported to SQL | — | — | would freeze the formatting rules in SQL and lose the booking-time snapshot | display only | **Keep stored** (snapshot). |
| Trip price and capacity | ✔ (snapshot) | — | — | — | not applicable (copied from another table) | — | **Keep stored.** |
| Contact phone | ✔ `contact_phone` | — | — | — | the legacy `phone` could become generated from `contact_phone`/`contact_email` | — | See Candidate C. |
| Payment totals on orders | ✔ (already trigger-derived from the ledger) | — | — | — | — | — | Keep. It is a deliberate, trigger-maintained cache used by RLS and gating. |

About "GET": a REST/HTTP GET, or PostgREST `.select()`, only returns what a table, view or RPC exposes. It does not merge or replace stored columns. Deriving a value needs one of the database mechanisms above (a SQL expression in a view or RPC, or a generated column). The client then reads that with an ordinary `select`.

---

## 6. Fields that stay

All 27 tables stay. Every column stays **except** the candidates in §7. Keep-reasons in short:
- **Historical snapshots:** trip price and capacity, full addresses, staff-name snapshots, consent at submission, legal version dates, settlement history.
- **Security:** `contact_inquiries.phone` (rate limiter), `ip`, claim/lease columns on job tables, `return_token_hash`, idempotency keys, `transaction_reference_normalized` (duplicate-reference guard).
- **Background work:** push-delivery job columns, email-broadcast claim columns, photo cleanup and storage events, `last_reminder_sent_at`.
- **Distinct records:** attempts vs ledger vs refunds; planned vs actual trip timestamps.

---

## 7. Proposed cleanup plan (NOT EXECUTED; each item needs your approval)

> **No deletion is justified right now for the columns you listed.** The only removal candidates are two low-value `payment_attempts` columns (A, B). C and D are optional, staged simplifications with real preconditions. E is a hardening step, not a removal.

### Candidate A: drop `payment_attempts.estimated_cost` (lowest risk)
1. **Code:** remove `estimated_cost` from `paymongo-create-payment/index.ts` (select lists at lines ~71 and ~157, and the upsert at ~124). Delete the unused `createPaymentAttempt` from `database.js`.
2. **Deploy order:** (1) deploy the Edge Function → (2) test a live GCash payment on **staging** → (3) wait one release → (4) new forward migration.
3. **Data preservation:** none needed (0 non-NULL rows). Run the pre-flight count again right before migrating.
4. **Old clients:** the browser never reads this column, so there is no PWA impact.
5. **Tests:** `npm run test:payment-ledger`, `npm run check`, one Playwright GCash flow on staging.
6. **Rollback:** `ALTER TABLE ... ADD COLUMN estimated_cost numeric` and redeploy the old function. No backup is needed because the column held no data.

### Candidate B (optional): drop `payment_attempts.description`
Same sequence as A (this is the order already documented in migration `20260803150000`). **Backup required:** 18 populated values. Export `id, description` into an archive table before dropping. Recommend doing this only if you want the simplification; it is low value either way.

### Candidate C (optional, security-sensitive): retire the legacy `contact_inquiries.phone`
1. New migration: change `guard_contact_inquiry_rate_limit` to key on `coalesce(contact_phone, contact_email)` **and** `ip`.
2. Make `phone` nullable, or turn it into a generated column `coalesce(contact_phone, contact_email)`.
3. Update `submit-inquiry` and `database.js` to stop sending `phone`. Remove the `readContact` fallback only after confirming every row has `contact_phone` or `contact_email`.
4. Deploy order: migration step 1 (still compatible) → Edge Function → frontend → later migration to drop or convert.
5. Tests: `node scripts/security-hardening-contract-test.mjs` (it currently asserts on `contact_phone` handling and will need updating), plus a new pgtest showing that the 4th inquiry within 10 minutes is still rejected.
6. Backup: needed only if rows exist at that time (0 today).

### Candidate D (long-term): make `sender_name`/`receiver_name` generated columns
Preconditions: confirm no deployed client or Edge Function **writes** these columns, and that older PWA builds have expired from the service-worker cache. Change the name-sync triggers so they no longer assign `NEW.sender_name`. Migration: add a new generated column → backfill check (expected: 0 differ) → swap names inside one transaction → drop the old column. Backup: full `id, sender_name, receiver_name` export first. Tests: name-policy pgtests, tracking-privacy contract test, QR-label rendering, report RPCs. **Benefit is small; recommend deferring.**

### Candidate E (hardening, not removal): stop full address and parts from drifting
Have `update_order_contact_details` verify or rebuild `p_*_address` from the parts, or add a CHECK-style comparison. Also document in a column comment that the full address is a booking-time snapshot.

### Consent drift (investigation, not cleanup)
1 profile disagrees with its `email_subscriptions` row. Before changing anything, find out which value is correct, because the broadcast Edge Function reads the profile flag.

### Draft SQL: **NOT APPROVED FOR EXECUTION**
```sql
-- NOT APPROVED FOR EXECUTION — draft for Candidate A only.
-- Run ONLY after paymongo-create-payment no longer references estimated_cost,
-- and only via a new timestamped migration file. Test first on an isolated
-- database with synthetic data (e.g. the pglite harness), never production.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.payment_attempts WHERE estimated_cost IS NOT NULL) THEN
    RAISE EXCEPTION 'estimated_cost has data; archive before dropping';
  END IF;
END $$;
ALTER TABLE public.payment_attempts DROP COLUMN estimated_cost;  -- no CASCADE
COMMIT;
```

Any test run must use `@electric-sql/pglite` (the existing `scripts/*-pgtest` harnesses) or a disposable Supabase branch with synthetic data. **No production writes.**

---

## 8. Corrected manuscript descriptions (current deployed schema)

These describe columns **as they exist now**. None is removed.

| Field Name | Data Type | Correct Description |
|---|---|---|
| contact_inquiries.phone | text, NOT NULL | Legacy combined contact value kept for compatibility: the submitted phone and/or email (e.g. "phone \| email"), max 100 chars. Also used by the database to limit repeated inquiries from the same contact (3 per 10 minutes). |
| contact_inquiries.contact_phone | text, nullable | The inquirer's mobile number from the form's single phone field, stored separately. Not an alternative or second number. |
| contact_inquiries.contact_email | text, nullable | The inquirer's email address, stored separately; used for replies and email-update consent. |
| trips.capacity | integer | Maximum planned load (kg) for this trip, copied from the company default when the trip was created. Kept per trip so later default changes do not affect existing trips. Enforced by the database when orders are assigned or weighed. |
| trips.price_per_kg | numeric | Freight rate (₱/kg) locked in for this trip at creation. The database uses it to compute each order's shipping cost, including recalculations when payments are recorded. |
| company_information.default_capacity | integer | Default capacity copied into newly created trips. Changing it does not alter existing trips. |
| company_information.default_price_per_kg | numeric | Default rate copied into newly created trips, and the fallback rate for an order not yet assigned to a trip. |
| orders.sender_first_name / sender_last_name | text | Sender's given name and surname as entered at booking. The authoritative name fields. |
| orders.sender_name | varchar | Sender's full name, kept in sync automatically by the database from the first and last name. Used by tracking, labels, notifications and reports. |
| orders.receiver_first_name / receiver_last_name / receiver_name | text / varchar | Same as the sender fields, for the receiver. |
| orders.sender_address | text | Complete pickup address as confirmed at booking (lot/block, street, barangay, city, province, plus landmark), kept as a snapshot. |
| orders.sender_lot_block, sender_street, sender_barangay, sender_city, sender_province, sender_landmark | text | Individual parts of the pickup address, used for coverage checks, grouping and re-filling forms. |
| orders.receiver_address and receiver_* parts | text | Same as above, for the delivery address. |
| trips.departure_date / arrival_date | timestamptz | Planned departure and arrival schedule. |
| trips.departure_at / arrived_at | timestamptz | Actual departure and arrival times, stamped by the database clock when the trip is started or marked arrived. |
| trips.estimated_arrival_at | timestamptz | Optional arrival forecast entered when the trip starts; not proof of arrival. |
| payment_attempts.estimated_cost | numeric | Legacy reconcile field; currently never populated. (Proposed for removal; still exists.) |
| payment_attempts.description | text | Label of the GCash charge as sent to PayMongo; stored for reference only. |

---

## 9. Simple Taglish explanation

Sinuri ko isa-isa ang 27 tables at 377 columns sa live Supabase database mo, at kung saan sila ginagamit sa code, triggers, RPCs, RLS, Edge Functions at cron jobs.

- **Mukhang doble, pero may silbi talaga.** Halimbawa, `trips.price_per_kg`: parang kopya lang ng company default, pero ito ang "naka-lock" na presyo ng trip. Kapag tinanggal ito at binago mo ang default price, **magbabago ang shipping cost ng lumang bookings** sa susunod na bayad nila. Kaya dapat manatili.
- **Ang `phone` sa contact inquiries** ay hindi kapareho ng `contact_phone`. Ang `phone` ay lumang field na phone at email na pinagsama, at ginagamit pa ito ng database para pigilan ang spam (3 inquiries lang bawat 10 minuto). Kapag tinanggal ito, masisira ang contact form.
- **Ang pangalan (full name vs first/last)** ay pare-pareho sa lahat ng 11 orders, at awtomatikong sini-sync ng trigger. Pero maraming bahagi pa ang gumagamit ng full name (public tracking, QR label, reports, notifications), kaya hindi pa ito pwedeng tanggalin.
- **Ang full address** ay pare-pareho rin sa mga parts ngayon. Pero ito ang "snapshot" ng address na kinumpirma ng customer, at pwede itong i-edit ng admin nang hiwalay, kaya dapat manatili.
- **Ang talagang pwedeng tanggalin** ay isang maliit na column lang: `payment_attempts.estimated_cost` (walang laman, walang gumagamit). Optional din ang `payment_attempts.description`. Pero kailangan munang i-update at i-deploy ang Edge Function bago tanggalin ang column.

---

## Appendix A: Full column dependency inventory (live schema)

Counts are whole-word matches. "Live DB object refs" = occurrences in live function, trigger, policy, constraint and index definitions. Generic names (⚠) have inflated counts and were judged by reading the code, not by the count.

| Table | Column | Type | Live DB object refs | Frontend files (src/) | Edge Functions | Test files | Classification |
|---|---|---|---|---|---|---|---|
| activity_logs | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| activity_logs | `admin_id` | uuid | 31 | 1 | record-manual-refund | 11 | KEEP |
| activity_logs | `admin_name` | text | 18 | 7 | — | 14 | KEEP |
| activity_logs | `module` | text | 20 | 20 | record-manual-refund | 10 | KEEP |
| activity_logs | `action` ⚠generic name | text | 26 | 42 | delete-storage-photos,paymongo-create-payment,record-manual-refund,unsubscribe-announcements | 13 | KEEP |
| activity_logs | `record_type` | text | 16 | 0 | — | 6 | KEEP |
| activity_logs | `record_id` | uuid | 15 | 1 | — | 6 | KEEP |
| activity_logs | `record_ref` | text | 17 | 2 | — | 5 | KEEP |
| activity_logs | `previous_value` | jsonb | 11 | 0 | — | 5 | KEEP |
| activity_logs | `new_value` | jsonb | 12 | 0 | — | 5 | KEEP |
| activity_logs | `details` | text | 20 | 51 | _shared,broadcast-announcement,get-photo-fallback,send-push,verify-payment-return | 9 | KEEP |
| activity_logs | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| activity_logs | `client_event_id` | uuid | 4 | 0 | — | 3 | KEEP |
| announcement_email_broadcasts | `announcement_id` | uuid | 28 | 1 | broadcast-announcement | 1 | KEEP |
| announcement_email_broadcasts | `subject` | text | 3 | 3 | broadcast-announcement,email-trip-reschedule,process-daily-reminders,send-push | 3 | KEEP |
| announcement_email_broadcasts | `content` ⚠generic name | text | 4 | 33 | archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,unsubscribe-announcements,verify-payment-return | 16 | KEEP |
| announcement_email_broadcasts | `from_email` | text | 3 | 0 | broadcast-announcement | 1 | KEEP |
| announcement_email_broadcasts | `status` ⚠generic name | text | 344 | 69 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,process-push-deliveries,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,unsubscribe-announcements,verify-payment-return | 59 | KEEP |
| announcement_email_broadcasts | `claim_token` | uuid | 23 | 0 | paymongo-refund-recovery | 1 | KEEP |
| announcement_email_broadcasts | `claim_expires_at` | timestamp with time zone | 13 | 0 | — | 1 | KEEP |
| announcement_email_broadcasts | `total_recipients` | integer | 4 | 2 | — | 0 | KEEP |
| announcement_email_broadcasts | `accepted_count` | integer | 2 | 2 | — | 0 | KEEP |
| announcement_email_broadcasts | `skipped_count` | integer | 2 | 2 | — | 0 | KEEP |
| announcement_email_broadcasts | `retryable_count` | integer | 2 | 2 | — | 0 | KEEP |
| announcement_email_broadcasts | `failed_count` | integer | 14 | 3 | delete-storage-photos | 1 | KEEP |
| announcement_email_broadcasts | `needs_review_count` | integer | 2 | 2 | — | 0 | KEEP |
| announcement_email_broadcasts | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| announcement_email_broadcasts | `updated_at` ⚠generic name | timestamp with time zone | 60 | 6 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook | 17 | KEEP |
| announcement_email_broadcasts | `completed_at` | timestamp with time zone | 11 | 1 | archive-expired-evidence-photos | 2 | KEEP |
| announcement_email_broadcasts | `cta_label` | text | 4 | 1 | broadcast-announcement | 1 | KEEP |
| announcement_email_broadcasts | `cta_url` | text | 6 | 1 | broadcast-announcement | 1 | KEEP |
| announcement_email_recipients | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| announcement_email_recipients | `announcement_id` | uuid | 28 | 1 | broadcast-announcement | 1 | KEEP |
| announcement_email_recipients | `email` ⚠generic name | text | 62 | 39 | _shared,broadcast-announcement,email-trip-reschedule,process-daily-reminders,record-manual-refund,submit-inquiry,unsubscribe-announcements | 24 | KEEP |
| announcement_email_recipients | `idempotency_key` | text | 38 | 2 | _shared,paymongo-refund,paymongo-refund-recovery | 7 | KEEP |
| announcement_email_recipients | `status` ⚠generic name | text | 344 | 69 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,process-push-deliveries,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,unsubscribe-announcements,verify-payment-return | 59 | KEEP |
| announcement_email_recipients | `attempts` | integer | 12 | 6 | record-manual-refund | 6 | KEEP |
| announcement_email_recipients | `claim_token` | uuid | 23 | 0 | paymongo-refund-recovery | 1 | KEEP |
| announcement_email_recipients | `claim_expires_at` | timestamp with time zone | 13 | 0 | — | 1 | KEEP |
| announcement_email_recipients | `first_attempt_at` | timestamp with time zone | 4 | 0 | — | 1 | KEEP |
| announcement_email_recipients | `next_attempt_at` | timestamp with time zone | 5 | 0 | — | 1 | KEEP |
| announcement_email_recipients | `delivery_payload` | jsonb | 5 | 0 | _shared | 2 | KEEP |
| announcement_email_recipients | `provider_message_id` | text | 2 | 0 | — | 0 | KEEP |
| announcement_email_recipients | `last_error` | text | 29 | 1 | paymongo-create-payment,paymongo-webhook | 6 | KEEP |
| announcement_email_recipients | `accepted_at` | timestamp with time zone | 3 | 0 | — | 0 | KEEP |
| announcement_email_recipients | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| announcement_email_recipients | `updated_at` ⚠generic name | timestamp with time zone | 60 | 6 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook | 17 | KEEP |
| announcements | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| announcements | `title` ⚠generic name | character varying | 27 | 88 | broadcast-announcement,email-trip-reschedule,photo-storage-health,process-daily-reminders,send-push | 21 | KEEP |
| announcements | `content` ⚠generic name | text | 4 | 33 | archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,unsubscribe-announcements,verify-payment-return | 16 | KEEP |
| announcements | `author_id` | uuid | 1 | 1 | — | 0 | KEEP |
| announcements | `is_active` | boolean | 1 | 1 | — | 2 | KEEP |
| announcements | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| announcements | `updated_at` ⚠generic name | timestamp with time zone | 60 | 6 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook | 17 | KEEP |
| announcements | `comments` | jsonb | 3 | 4 | — | 4 | KEEP |
| announcements | `send_email` | boolean | 1 | 2 | broadcast-announcement | 3 | KEEP |
| announcements | `emailed_at` | timestamp with time zone | 3 | 1 | — | 2 | KEEP |
| announcements | `cta_label` | text | 4 | 1 | broadcast-announcement | 1 | KEEP |
| announcements | `cta_url` | text | 6 | 1 | broadcast-announcement | 1 | KEEP |
| announcements | `audience` | text | 3 | 3 | send-push | 1 | KEEP |
| cancellation_settlement_history | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| cancellation_settlement_history | `order_id` | uuid | 132 | 3 | archive-expired-evidence-photos,delete-storage-photos,get-photo-fallback,paymongo-create-payment,record-photo-storage-event,send-push,store-photo-fallback | 21 | KEEP |
| cancellation_settlement_history | `tracking_number` | text | 88 | 29 | archive-expired-evidence-photos,email-trip-reschedule,paymongo-create-payment,process-daily-reminders,send-push | 36 | KEEP |
| cancellation_settlement_history | `action` ⚠generic name | text | 26 | 42 | delete-storage-photos,paymongo-create-payment,record-manual-refund,unsubscribe-announcements | 13 | KEEP |
| cancellation_settlement_history | `old_decision` | jsonb | 2 | 0 | — | 0 | KEEP |
| cancellation_settlement_history | `new_decision` | jsonb | 4 | 0 | — | 0 | KEEP |
| cancellation_settlement_history | `changed_by` | uuid | 6 | 0 | — | 1 | KEEP |
| cancellation_settlement_history | `changed_by_name` | text | 2 | 0 | — | 0 | KEEP |
| cancellation_settlement_history | `changed_at` | timestamp with time zone | 14 | 2 | — | 5 | KEEP |
| cancellation_settlement_history | `idempotency_key` | uuid | 38 | 2 | _shared,paymongo-refund,paymongo-refund-recovery | 7 | KEEP |
| cancellation_settlements | `order_id` | uuid | 132 | 3 | archive-expired-evidence-photos,delete-storage-photos,get-photo-fallback,paymongo-create-payment,record-photo-storage-event,send-push,store-photo-fallback | 21 | KEEP |
| cancellation_settlements | `decision_type` | text | 13 | 1 | — | 0 | KEEP |
| cancellation_settlements | `agreed_retained_amount` | numeric | 13 | 0 | — | 0 | KEEP |
| cancellation_settlements | `customer_agreement_confirmed` | boolean | 6 | 2 | — | 0 | KEEP |
| cancellation_settlements | `customer_agreement_confirmed_at` | timestamp with time zone | 4 | 0 | — | 0 | KEEP |
| cancellation_settlements | `internal_notes` | text | 6 | 2 | — | 1 | KEEP |
| cancellation_settlements | `decided_by` | uuid | 5 | 0 | — | 1 | KEEP |
| cancellation_settlements | `decided_at` | timestamp with time zone | 4 | 0 | — | 0 | KEEP |
| cancellation_settlements | `updated_at` ⚠generic name | timestamp with time zone | 60 | 6 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook | 17 | KEEP |
| cancellation_settlements | `version` ⚠generic name | integer | 12 | 17 | — | 8 | KEEP |
| cancellation_settlements | `last_idempotency_key` | uuid | 4 | 0 | — | 0 | KEEP |
| chat_messages | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| chat_messages | `conversation_id` | uuid | 26 | 3 | — | 1 | KEEP |
| chat_messages | `sender_id` | uuid | 5 | 3 | — | 0 | KEEP |
| chat_messages | `sender_role` | character varying | 14 | 5 | — | 1 | KEEP |
| chat_messages | `message` ⚠generic name | text | 53 | 78 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,process-push-deliveries,record-manual-refund,record-photo-storage-event,send-push,submit-inquiry,unsubscribe-announcements | 50 | KEEP |
| chat_messages | `is_read` | boolean | 4 | 6 | — | 2 | KEEP |
| chat_messages | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| company_information | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| company_information | `name` ⚠generic name | text | 91 | 76 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-webhook,photo-storage-health,process-daily-reminders,send-push,store-photo-fallback,submit-inquiry,unsubscribe-announcements | 58 | KEEP |
| company_information | `short_description` | text | 0 | 4 | — | 0 | KEEP |
| company_information | `long_description` | text | 0 | 3 | — | 0 | KEEP |
| company_information | `banner_image_url` | text | 2 | 3 | — | 1 | KEEP |
| company_information | `banner_title` | text | 0 | 3 | — | 0 | KEEP |
| company_information | `banner_description` | text | 0 | 3 | — | 0 | KEEP |
| company_information | `banner_button_text` | text | 0 | 3 | — | 0 | KEEP |
| company_information | `banner_button_link` | text | 0 | 3 | — | 0 | KEEP |
| company_information | `email` ⚠generic name | text | 62 | 39 | _shared,broadcast-announcement,email-trip-reschedule,process-daily-reminders,record-manual-refund,submit-inquiry,unsubscribe-announcements | 24 | KEEP |
| company_information | `facebook` | text | 1 | 10 | — | 4 | KEEP |
| company_information | `smart_phone` | text | 2 | 5 | — | 0 | KEEP |
| company_information | `globe_phone` | text | 2 | 5 | — | 0 | KEEP |
| company_information | `manila_address` | text | 2 | 6 | — | 0 | KEEP |
| company_information | `bohol_address` | text | 2 | 6 | — | 0 | KEEP |
| company_information | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| company_information | `updated_at` ⚠generic name | timestamp with time zone | 60 | 6 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook | 17 | KEEP |
| company_information | `default_price_per_kg` | numeric | 1 | 6 | — | 2 | KEEP |
| company_information | `features` | jsonb | 0 | 7 | — | 1 | KEEP |
| company_information | `coverage` | jsonb | 1 | 16 | — | 4 | KEEP |
| company_information | `default_capacity` | integer | 1 | 3 | — | 1 | KEEP |
| contact_inquiries | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| contact_inquiries | `name` ⚠generic name | text | 91 | 76 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-webhook,photo-storage-health,process-daily-reminders,send-push,store-photo-fallback,submit-inquiry,unsubscribe-announcements | 58 | KEEP |
| contact_inquiries | `phone` ⚠generic name | text | 19 | 31 | record-manual-refund,submit-inquiry | 11 | KEEP TEMPORARILY |
| contact_inquiries | `message` ⚠generic name | text | 53 | 78 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,process-push-deliveries,record-manual-refund,record-photo-storage-event,send-push,submit-inquiry,unsubscribe-announcements | 50 | KEEP |
| contact_inquiries | `status` ⚠generic name | text | 344 | 69 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,process-push-deliveries,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,unsubscribe-announcements,verify-payment-return | 59 | KEEP |
| contact_inquiries | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| contact_inquiries | `contact_phone` | text | 0 | 3 | submit-inquiry | 2 | KEEP |
| contact_inquiries | `contact_email` | text | 2 | 3 | submit-inquiry | 2 | KEEP |
| contact_inquiries | `assigned_admin_id` | uuid | 3 | 2 | — | 1 | KEEP |
| contact_inquiries | `first_response_at` | timestamp with time zone | 6 | 3 | — | 0 | KEEP |
| contact_inquiries | `resolved_at` | timestamp with time zone | 9 | 3 | — | 0 | KEEP |
| contact_inquiries | `push_dispatched_at` | timestamp with time zone | 6 | 0 | — | 1 | KEEP |
| contact_inquiries | `push_dispatch_started_at` | timestamp with time zone | 5 | 0 | — | 1 | KEEP |
| contact_inquiries | `push_dispatch_claim_id` | uuid | 6 | 0 | — | 1 | KEEP |
| contact_inquiries | `ip` | text | 9 | 0 | submit-inquiry | 0 | KEEP |
| contact_inquiries | `wants_announcements` | boolean | 11 | 5 | broadcast-announcement,email-trip-reschedule,submit-inquiry,unsubscribe-announcements | 2 | KEEP: historical |
| conversations | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| conversations | `customer_id` | uuid | 24 | 3 | — | 2 | KEEP |
| conversations | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| conversations | `status` ⚠generic name | text | 344 | 69 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,process-push-deliveries,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,unsubscribe-announcements,verify-payment-return | 59 | KEEP |
| conversations | `escalated` | boolean | 7 | 3 | — | 0 | KEEP |
| conversations | `first_response_at` | timestamp with time zone | 6 | 3 | — | 0 | KEEP |
| conversations | `last_customer_message_at` | timestamp with time zone | 4 | 2 | — | 0 | KEEP |
| conversations | `resolved_at` | timestamp with time zone | 9 | 3 | — | 0 | KEEP |
| conversations | `bot_resolved` | boolean | 0 | 1 | — | 0 | KEEP |
| customer_feedback | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| customer_feedback | `order_id` | uuid | 132 | 3 | archive-expired-evidence-photos,delete-storage-photos,get-photo-fallback,paymongo-create-payment,record-photo-storage-event,send-push,store-photo-fallback | 21 | KEEP |
| customer_feedback | `customer_id` | uuid | 24 | 3 | — | 2 | KEEP |
| customer_feedback | `rating` | integer | 9 | 5 | — | 1 | KEEP |
| customer_feedback | `message` ⚠generic name | text | 53 | 78 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,process-push-deliveries,record-manual-refund,record-photo-storage-event,send-push,submit-inquiry,unsubscribe-announcements | 50 | KEEP |
| customer_feedback | `is_hidden` | boolean | 10 | 2 | — | 2 | KEEP |
| customer_feedback | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| email_subscriptions | `email` ⚠generic name | text | 62 | 39 | _shared,broadcast-announcement,email-trip-reschedule,process-daily-reminders,record-manual-refund,submit-inquiry,unsubscribe-announcements | 24 | KEEP |
| email_subscriptions | `subscribed` | boolean | 13 | 9 | _shared,broadcast-announcement,unsubscribe-announcements | 4 | KEEP |
| email_subscriptions | `source` ⚠generic name | text | 24 | 23 | paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,unsubscribe-announcements | 19 | KEEP |
| email_subscriptions | `updated_by` | uuid | 19 | 0 | — | 2 | KEEP |
| email_subscriptions | `updated_at` ⚠generic name | timestamp with time zone | 60 | 6 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook | 17 | KEEP |
| email_subscriptions | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| legal_consents | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| legal_consents | `user_id` | uuid | 98 | 14 | email-trip-reschedule,get-photo-fallback,paymongo-create-payment,photo-storage-health,process-daily-reminders,send-push | 35 | KEEP |
| legal_consents | `document_type` | text | 12 | 0 | — | 0 | KEEP |
| legal_consents | `document_version` | text | 5 | 0 | — | 0 | KEEP |
| legal_consents | `accepted_at` | timestamp with time zone | 3 | 0 | — | 0 | KEEP |
| legal_consents | `source` ⚠generic name | text | 24 | 23 | paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,unsubscribe-announcements | 19 | KEEP |
| legal_documents | `document_type` | text | 12 | 0 | — | 0 | KEEP |
| legal_documents | `version` ⚠generic name | text | 12 | 17 | — | 8 | KEEP |
| legal_documents | `url_path` | text | 1 | 0 | — | 0 | KEEP |
| legal_documents | `effective_at` | timestamp with time zone | 0 | 0 | — | 0 | KEEP: historical |
| legal_documents | `published_at` | timestamp with time zone | 0 | 0 | — | 0 | KEEP: historical |
| legal_documents | `is_current` | boolean | 4 | 0 | — | 0 | KEEP |
| notification_delivery_jobs | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| notification_delivery_jobs | `notification_id` | uuid | 10 | 0 | process-push-deliveries,send-push | 3 | KEEP |
| notification_delivery_jobs | `user_id` | uuid | 98 | 14 | email-trip-reschedule,get-photo-fallback,paymongo-create-payment,photo-storage-health,process-daily-reminders,send-push | 35 | KEEP |
| notification_delivery_jobs | `device_token_id` | uuid | 10 | 0 | process-push-deliveries,send-push | 3 | KEEP |
| notification_delivery_jobs | `dedupe_key` | text | 6 | 0 | — | 1 | KEEP |
| notification_delivery_jobs | `status` ⚠generic name | text | 344 | 69 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,process-push-deliveries,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,unsubscribe-announcements,verify-payment-return | 59 | KEEP |
| notification_delivery_jobs | `attempt_count` | integer | 11 | 0 | — | 3 | KEEP |
| notification_delivery_jobs | `available_at` | timestamp with time zone | 7 | 0 | — | 3 | KEEP |
| notification_delivery_jobs | `claimed_at` | timestamp with time zone | 14 | 0 | — | 2 | KEEP |
| notification_delivery_jobs | `claim_id` | uuid | 8 | 0 | send-push | 1 | KEEP |
| notification_delivery_jobs | `completed_at` | timestamp with time zone | 11 | 1 | archive-expired-evidence-photos | 2 | KEEP |
| notification_delivery_jobs | `last_error` | text | 29 | 1 | paymongo-create-payment,paymongo-webhook | 6 | KEEP |
| notification_delivery_jobs | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| notification_delivery_jobs | `updated_at` ⚠generic name | timestamp with time zone | 60 | 6 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook | 17 | KEEP |
| notifications | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| notifications | `user_id` | uuid | 98 | 14 | email-trip-reschedule,get-photo-fallback,paymongo-create-payment,photo-storage-health,process-daily-reminders,send-push | 35 | KEEP |
| notifications | `title` ⚠generic name | character varying | 27 | 88 | broadcast-announcement,email-trip-reschedule,photo-storage-health,process-daily-reminders,send-push | 21 | KEEP |
| notifications | `message` ⚠generic name | text | 53 | 78 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,process-push-deliveries,record-manual-refund,record-photo-storage-event,send-push,submit-inquiry,unsubscribe-announcements | 50 | KEEP |
| notifications | `type` ⚠generic name | character varying | 36 | 104 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,unsubscribe-announcements,verify-payment-return | 31 | KEEP |
| notifications | `reference_id` | uuid | 26 | 3 | send-push | 14 | KEEP |
| notifications | `is_read` | boolean | 4 | 6 | — | 2 | KEEP |
| notifications | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| notifications | `payment_transaction_id` | uuid | 37 | 1 | paymongo-refund-recovery | 10 | KEEP |
| notifications | `payment_refund_id` | uuid | 6 | 0 | — | 3 | KEEP |
| order_status_events | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| order_status_events | `order_id` | uuid | 132 | 3 | archive-expired-evidence-photos,delete-storage-photos,get-photo-fallback,paymongo-create-payment,record-photo-storage-event,send-push,store-photo-fallback | 21 | KEEP |
| order_status_events | `status` ⚠generic name | character varying | 344 | 69 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,process-push-deliveries,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,unsubscribe-announcements,verify-payment-return | 59 | KEEP |
| order_status_events | `changed_at` | timestamp with time zone | 14 | 2 | — | 5 | KEEP |
| order_status_events | `changed_by` | uuid | 6 | 0 | — | 1 | KEEP |
| order_status_events | `note` | text | 1 | 16 | archive-expired-evidence-photos,delete-storage-photos,email-trip-reschedule,process-daily-reminders,record-manual-refund | 6 | KEEP |
| orders | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| orders | `user_id` | uuid | 98 | 14 | email-trip-reschedule,get-photo-fallback,paymongo-create-payment,photo-storage-health,process-daily-reminders,send-push | 35 | KEEP |
| orders | `trip_id` | uuid | 47 | 8 | email-trip-reschedule | 15 | KEEP |
| orders | `origin` ⚠generic name | character varying | 9 | 32 | email-trip-reschedule,process-daily-reminders,send-push | 18 | KEEP |
| orders | `destination` ⚠generic name | character varying | 16 | 32 | email-trip-reschedule,process-daily-reminders,send-push | 19 | KEEP |
| orders | `tracking_number` | character varying | 88 | 29 | archive-expired-evidence-photos,email-trip-reschedule,paymongo-create-payment,process-daily-reminders,send-push | 36 | KEEP |
| orders | `sender_name` | character varying | 26 | 15 | — | 17 | KEEP TEMPORARILY |
| orders | `sender_phone` | character varying | 6 | 8 | — | 6 | KEEP |
| orders | `sender_address` | text | 6 | 5 | — | 6 | KEEP |
| orders | `receiver_name` | character varying | 24 | 15 | — | 17 | KEEP TEMPORARILY |
| orders | `receiver_phone` | character varying | 6 | 8 | — | 7 | KEEP |
| orders | `receiver_address` | text | 6 | 5 | — | 6 | KEEP |
| orders | `package_description` | text | 5 | 7 | — | 5 | KEEP |
| orders | `actual_weight` | numeric | 30 | 14 | paymongo-create-payment | 23 | KEEP |
| orders | `shipping_cost` | numeric | 26 | 11 | paymongo-create-payment | 24 | KEEP |
| orders | `payer_type` | character varying | 8 | 10 | paymongo-create-payment | 10 | KEEP |
| orders | `payment_method` | character varying | 35 | 11 | — | 18 | KEEP |
| orders | `payment_status` | character varying | 46 | 13 | paymongo-create-payment,verify-payment-return | 20 | KEEP |
| orders | `amount_paid` | numeric | 21 | 14 | — | 18 | KEEP |
| orders | `remaining_balance` | numeric | 18 | 11 | paymongo-create-payment,process-daily-reminders | 17 | KEEP |
| orders | `promised_payment_date` | date | 9 | 10 | paymongo-create-payment,process-daily-reminders | 9 | KEEP |
| orders | `status` ⚠generic name | character varying | 344 | 69 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,process-push-deliveries,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,unsubscribe-announcements,verify-payment-return | 59 | KEEP |
| orders | `notes` ⚠generic name | text | 22 | 19 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,record-manual-refund | 16 | KEEP |
| orders | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| orders | `updated_at` ⚠generic name | timestamp with time zone | 60 | 6 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook | 17 | KEEP |
| orders | `sender_facebook` | text | 0 | 4 | — | 0 | KEEP |
| orders | `sender_city` | text | 6 | 5 | — | 5 | KEEP |
| orders | `receiver_facebook` | text | 0 | 4 | — | 0 | KEEP |
| orders | `receiver_city` | text | 10 | 7 | — | 6 | KEEP |
| orders | `receiver_province` | text | 10 | 7 | — | 6 | KEEP |
| orders | `sender_province` | text | 7 | 5 | — | 7 | KEEP |
| orders | `pickup_photos` | jsonb | 24 | 5 | archive-expired-evidence-photos,get-photo-fallback,paymongo-create-payment | 8 | KEEP |
| orders | `delivery_photos` | jsonb | 17 | 5 | archive-expired-evidence-photos,get-photo-fallback | 7 | KEEP |
| orders | `payment_reference` | character varying | 7 | 6 | — | 4 | KEEP |
| orders | `service_area_status` | text | 10 | 4 | — | 4 | KEEP |
| orders | `service_area_remarks` | text | 3 | 2 | — | 3 | KEEP |
| orders | `featured_on_website` | boolean | 12 | 2 | get-photo-fallback | 3 | KEEP |
| orders | `featured_title` | text | 5 | 3 | — | 1 | KEEP |
| orders | `featured_caption` | text | 3 | 2 | — | 1 | KEEP |
| orders | `featured_image_type` | text | 5 | 1 | get-photo-fallback | 1 | KEEP |
| orders | `featured_at` | timestamp with time zone | 5 | 1 | — | 1 | KEEP |
| orders | `reassignment_history` | jsonb | 3 | 1 | — | 0 | KEEP |
| orders | `payment_preference` | text | 0 | 3 | — | 0 | KEEP |
| orders | `cancellation_details` | jsonb | 10 | 4 | send-push | 3 | KEEP |
| orders | `last_reminder_sent_at` | timestamp with time zone | 0 | 0 | process-daily-reminders | 0 | KEEP |
| orders | `sender_barangay` | text | 6 | 4 | — | 4 | KEEP |
| orders | `sender_street` | text | 6 | 4 | — | 4 | KEEP |
| orders | `sender_lot_block` | text | 0 | 4 | — | 0 | KEEP |
| orders | `sender_landmark` | text | 6 | 4 | — | 4 | KEEP |
| orders | `receiver_barangay` | text | 6 | 4 | — | 4 | KEEP |
| orders | `receiver_street` | text | 6 | 4 | — | 4 | KEEP |
| orders | `receiver_lot_block` | text | 0 | 4 | — | 0 | KEEP |
| orders | `receiver_landmark` | text | 6 | 4 | — | 4 | KEEP |
| orders | `discount_amount` | numeric | 37 | 7 | — | 20 | KEEP |
| orders | `discount_reason` | text | 14 | 3 | — | 4 | KEEP |
| orders | `discount_notes` | text | 9 | 3 | — | 4 | KEEP |
| orders | `discount_applied_by` | uuid | 4 | 0 | — | 2 | KEEP |
| orders | `discount_applied_at` | timestamp with time zone | 3 | 1 | — | 1 | KEEP |
| orders | `package_quantity` | integer | 2 | 2 | — | 0 | KEEP |
| orders | `sender_first_name` | text | 19 | 4 | — | 2 | KEEP |
| orders | `sender_last_name` | text | 16 | 4 | — | 1 | KEEP |
| orders | `receiver_first_name` | text | 19 | 4 | — | 1 | KEEP |
| orders | `receiver_last_name` | text | 16 | 4 | — | 1 | KEEP |
| payment_attempts | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| payment_attempts | `source_id` | text | 7 | 3 | paymongo-create-payment,paymongo-webhook | 7 | KEEP |
| payment_attempts | `order_id` | uuid | 132 | 3 | archive-expired-evidence-photos,delete-storage-photos,get-photo-fallback,paymongo-create-payment,record-photo-storage-event,send-push,store-photo-fallback | 21 | KEEP |
| payment_attempts | `amount` ⚠generic name | numeric | 95 | 27 | paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,process-daily-reminders,record-manual-refund | 26 | KEEP |
| payment_attempts | `description` ⚠generic name | text | 0 | 40 | paymongo-create-payment,paymongo-webhook | 16 | REMOVAL CANDIDATE (optional) |
| payment_attempts | `status` ⚠generic name | text | 344 | 69 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,process-push-deliveries,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,unsubscribe-announcements,verify-payment-return | 59 | KEEP |
| payment_attempts | `payment_id` | text | 35 | 0 | paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,verify-payment-return | 11 | KEEP |
| payment_attempts | `payment_status` | text | 46 | 13 | paymongo-create-payment,verify-payment-return | 20 | KEEP |
| payment_attempts | `actual_weight` | numeric | 30 | 14 | paymongo-create-payment | 23 | KEEP |
| payment_attempts | `payer_type` | character varying | 8 | 10 | paymongo-create-payment | 10 | KEEP |
| payment_attempts | `pickup_photos` | jsonb | 24 | 5 | archive-expired-evidence-photos,get-photo-fallback,paymongo-create-payment | 8 | KEEP |
| payment_attempts | `last_error` | text | 29 | 1 | paymongo-create-payment,paymongo-webhook | 6 | KEEP |
| payment_attempts | `reconciled_at` | timestamp with time zone | 2 | 0 | — | 3 | KEEP |
| payment_attempts | `created_by` | uuid | 4 | 1 | delete-storage-photos,paymongo-create-payment,record-photo-storage-event,store-photo-fallback | 3 | KEEP |
| payment_attempts | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| payment_attempts | `updated_at` ⚠generic name | timestamp with time zone | 60 | 6 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook | 17 | KEEP |
| payment_attempts | `payment_type` | text | 11 | 8 | paymongo-create-payment | 8 | KEEP |
| payment_attempts | `estimated_cost` | numeric | 0 | 1 | paymongo-create-payment | 2 | REMOVAL CANDIDATE |
| payment_attempts | `promised_payment_date` | date | 9 | 10 | paymongo-create-payment,process-daily-reminders | 9 | KEEP |
| payment_attempts | `return_token_hash` | text | 2 | 0 | paymongo-create-payment,verify-payment-return | 1 | KEEP |
| payment_attempts | `return_token_expires_at` | timestamp with time zone | 0 | 0 | paymongo-create-payment,verify-payment-return | 0 | KEEP |
| payment_refunds | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| payment_refunds | `refund_id` | text | 20 | 1 | paymongo-refund,paymongo-refund-recovery | 4 | KEEP |
| payment_refunds | `idempotency_key` | uuid | 38 | 2 | _shared,paymongo-refund,paymongo-refund-recovery | 7 | KEEP |
| payment_refunds | `payment_transaction_id` | uuid | 37 | 1 | paymongo-refund-recovery | 10 | KEEP |
| payment_refunds | `order_id` | uuid | 132 | 3 | archive-expired-evidence-photos,delete-storage-photos,get-photo-fallback,paymongo-create-payment,record-photo-storage-event,send-push,store-photo-fallback | 21 | KEEP |
| payment_refunds | `payment_id` | text | 35 | 0 | paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,verify-payment-return | 11 | KEEP |
| payment_refunds | `amount` ⚠generic name | numeric | 95 | 27 | paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,process-daily-reminders,record-manual-refund | 26 | KEEP |
| payment_refunds | `currency` | text | 4 | 4 | paymongo-create-payment,paymongo-refund-recovery,paymongo-webhook,process-daily-reminders | 0 | KEEP |
| payment_refunds | `status` ⚠generic name | text | 344 | 69 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,process-push-deliveries,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,unsubscribe-announcements,verify-payment-return | 59 | KEEP |
| payment_refunds | `reason` | text | 59 | 25 | archive-expired-evidence-photos,delete-storage-photos,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,record-manual-refund,send-push,unsubscribe-announcements | 12 | KEEP |
| payment_refunds | `notes` ⚠generic name | text | 22 | 19 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,record-manual-refund | 16 | KEEP |
| payment_refunds | `livemode` | boolean | 16 | 1 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook | 2 | KEEP |
| payment_refunds | `initiated_by` | uuid | 8 | 1 | record-manual-refund | 2 | KEEP |
| payment_refunds | `initiated_by_name` | text | 4 | 1 | — | 1 | KEEP |
| payment_refunds | `last_error` | text | 29 | 1 | paymongo-create-payment,paymongo-webhook | 6 | KEEP |
| payment_refunds | `last_event_id` | text | 3 | 0 | — | 0 | KEEP |
| payment_refunds | `provider_created_at` | timestamp with time zone | 5 | 1 | — | 0 | KEEP |
| payment_refunds | `provider_updated_at` | timestamp with time zone | 18 | 1 | — | 1 | KEEP |
| payment_refunds | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| payment_refunds | `updated_at` ⚠generic name | timestamp with time zone | 60 | 6 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook | 17 | KEEP |
| payment_refunds | `outcome_uncertain` | boolean | 10 | 4 | — | 2 | KEEP |
| payment_refunds | `public_failure_reason` | text | 8 | 1 | — | 1 | KEEP |
| payment_refunds | `succeeded_at` | timestamp with time zone | 18 | 0 | record-manual-refund | 3 | KEEP |
| payment_refunds | `refund_channel` | text | 21 | 1 | — | 3 | KEEP |
| payment_refunds | `return_method` | text | 14 | 1 | record-manual-refund | 2 | KEEP |
| payment_refunds | `return_reference` | text | 11 | 1 | — | 1 | KEEP |
| payment_refunds | `returned_at` | timestamp with time zone | 3 | 1 | — | 1 | KEEP |
| payment_transactions | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| payment_transactions | `order_id` | uuid | 132 | 3 | archive-expired-evidence-photos,delete-storage-photos,get-photo-fallback,paymongo-create-payment,record-photo-storage-event,send-push,store-photo-fallback | 21 | KEEP |
| payment_transactions | `amount` ⚠generic name | numeric | 95 | 27 | paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,process-daily-reminders,record-manual-refund | 26 | KEEP |
| payment_transactions | `payment_method` | text | 35 | 11 | — | 18 | KEEP |
| payment_transactions | `transaction_reference` | text | 25 | 6 | — | 11 | KEEP |
| payment_transactions | `payment_status` | text | 46 | 13 | paymongo-create-payment,verify-payment-return | 20 | KEEP |
| payment_transactions | `admin_id` | uuid | 31 | 1 | record-manual-refund | 11 | KEEP |
| payment_transactions | `admin_name` | text | 18 | 7 | — | 14 | KEEP |
| payment_transactions | `notes` ⚠generic name | text | 22 | 19 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,record-manual-refund | 16 | KEEP |
| payment_transactions | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| payment_transactions | `payment_type` | text | 11 | 8 | paymongo-create-payment | 8 | KEEP |
| payment_transactions | `payment_date` | date | 7 | 6 | — | 3 | KEEP |
| payment_transactions | `receipt_url` | text | 12 | 6 | — | 5 | KEEP |
| payment_transactions | `idempotency_key` | uuid | 38 | 2 | _shared,paymongo-refund,paymongo-refund-recovery | 7 | KEEP |
| payment_transactions | `gcash_channel` | text | 26 | 2 | — | 9 | KEEP |
| payment_transactions | `transaction_reference_normalized` | text | 6 | 0 | — | 3 | KEEP |
| photo_cleanup_queue | `id` ⚠generic name | bigint | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| photo_cleanup_queue | `provider` | text | 42 | 10 | _shared,archive-expired-evidence-photos,delete-photo-fallback,delete-storage-photos,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,photo-storage-health,process-push-deliveries,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,verify-payment-return | 19 | KEEP |
| photo_cleanup_queue | `storage_path` | text | 25 | 3 | archive-expired-evidence-photos,delete-storage-photos,record-photo-storage-event | 2 | KEEP |
| photo_cleanup_queue | `queued_at` | timestamp with time zone | 3 | 0 | archive-expired-evidence-photos | 1 | KEEP |
| photo_cleanup_queue | `completed_at` | timestamp with time zone | 11 | 1 | archive-expired-evidence-photos | 2 | KEEP |
| photo_cleanup_queue | `attempts` | integer | 12 | 6 | record-manual-refund | 6 | KEEP |
| photo_cleanup_queue | `last_error` | text | 29 | 1 | paymongo-create-payment,paymongo-webhook | 6 | KEEP |
| photo_storage_events | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| photo_storage_events | `event_type` | text | 7 | 0 | archive-expired-evidence-photos,delete-storage-photos,record-photo-storage-event | 0 | KEEP |
| photo_storage_events | `provider` | text | 42 | 10 | _shared,archive-expired-evidence-photos,delete-photo-fallback,delete-storage-photos,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,photo-storage-health,process-push-deliveries,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,verify-payment-return | 19 | KEEP |
| photo_storage_events | `outcome` | text | 11 | 6 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-storage-photos,paymongo-refund,paymongo-refund-recovery,process-push-deliveries,record-photo-storage-event,send-push | 9 | KEEP |
| photo_storage_events | `photo_type` | text | 8 | 1 | record-photo-storage-event | 0 | KEEP |
| photo_storage_events | `order_id` | uuid | 132 | 3 | archive-expired-evidence-photos,delete-storage-photos,get-photo-fallback,paymongo-create-payment,record-photo-storage-event,send-push,store-photo-fallback | 21 | KEEP |
| photo_storage_events | `storage_path` | text | 25 | 3 | archive-expired-evidence-photos,delete-storage-photos,record-photo-storage-event | 2 | KEEP |
| photo_storage_events | `size_bytes` | bigint | 35 | 2 | delete-storage-photos,photo-storage-health,record-photo-storage-event,store-photo-fallback | 2 | KEEP |
| photo_storage_events | `message` ⚠generic name | text | 53 | 78 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,process-push-deliveries,record-manual-refund,record-photo-storage-event,send-push,submit-inquiry,unsubscribe-announcements | 50 | KEEP |
| photo_storage_events | `metadata` | jsonb | 12 | 7 | archive-expired-evidence-photos,delete-storage-photos,paymongo-create-payment | 5 | KEEP |
| photo_storage_events | `created_by` | uuid | 4 | 1 | delete-storage-photos,paymongo-create-payment,record-photo-storage-event,store-photo-fallback | 3 | KEEP |
| photo_storage_events | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| photo_storage_settings | `id` ⚠generic name | boolean | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| photo_storage_settings | `upload_mode` | text | 14 | 1 | — | 3 | KEEP |
| photo_storage_settings | `force_firebase_expires_at` | timestamp with time zone | 11 | 0 | — | 1 | KEEP |
| photo_storage_settings | `reason` | text | 59 | 25 | archive-expired-evidence-photos,delete-storage-photos,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,record-manual-refund,send-push,unsubscribe-announcements | 12 | KEEP |
| photo_storage_settings | `updated_by` | uuid | 19 | 0 | — | 2 | KEEP |
| photo_storage_settings | `updated_at` ⚠generic name | timestamp with time zone | 60 | 6 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook | 17 | KEEP |
| profiles | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| profiles | `name` ⚠generic name | character varying | 91 | 76 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-webhook,photo-storage-health,process-daily-reminders,send-push,store-photo-fallback,submit-inquiry,unsubscribe-announcements | 58 | KEEP |
| profiles | `email` ⚠generic name | character varying | 62 | 39 | _shared,broadcast-announcement,email-trip-reschedule,process-daily-reminders,record-manual-refund,submit-inquiry,unsubscribe-announcements | 24 | KEEP |
| profiles | `phone` ⚠generic name | character varying | 19 | 31 | record-manual-refund,submit-inquiry | 11 | KEEP |
| profiles | `address_lot_block` | character varying | 0 | 6 | — | 0 | KEEP |
| profiles | `address_street` | character varying | 0 | 6 | — | 0 | KEEP |
| profiles | `address_barangay` | character varying | 0 | 7 | — | 0 | KEEP |
| profiles | `address_city` | character varying | 5 | 7 | — | 2 | KEEP |
| profiles | `address_province` | character varying | 8 | 7 | — | 2 | KEEP |
| profiles | `role` | character varying | 57 | 83 | archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,photo-storage-health,process-daily-reminders,process-push-deliveries,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,verify-payment-return | 50 | KEEP |
| profiles | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| profiles | `updated_at` ⚠generic name | timestamp with time zone | 60 | 6 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook | 17 | KEEP |
| profiles | `facebook_name` | text | 0 | 5 | — | 0 | KEEP |
| profiles | `address_landmark` | text | 0 | 6 | — | 0 | KEEP |
| profiles | `wants_announcements` | boolean | 11 | 5 | broadcast-announcement,email-trip-reschedule,submit-inquiry,unsubscribe-announcements | 2 | KEEP TEMPORARILY |
| trips | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| trips | `trip_number` | character varying | 6 | 17 | email-trip-reschedule | 9 | KEEP |
| trips | `origin` ⚠generic name | character varying | 9 | 32 | email-trip-reschedule,process-daily-reminders,send-push | 18 | KEEP |
| trips | `destination` ⚠generic name | character varying | 16 | 32 | email-trip-reschedule,process-daily-reminders,send-push | 19 | KEEP |
| trips | `departure_date` | timestamp with time zone | 36 | 14 | email-trip-reschedule | 8 | KEEP |
| trips | `arrival_date` | timestamp with time zone | 24 | 7 | email-trip-reschedule | 6 | KEEP |
| trips | `capacity` | integer | 12 | 19 | — | 10 | KEEP: historical |
| trips | `price_per_kg` | numeric | 1 | 7 | — | 6 | KEEP: historical |
| trips | `status` ⚠generic name | character varying | 344 | 69 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,process-push-deliveries,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,unsubscribe-announcements,verify-payment-return | 59 | KEEP |
| trips | `notes` ⚠generic name | text | 22 | 19 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,record-manual-refund | 16 | KEEP |
| trips | `created_by` | uuid | 4 | 1 | delete-storage-photos,paymongo-create-payment,record-photo-storage-event,store-photo-fallback | 3 | KEEP |
| trips | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| trips | `updated_at` ⚠generic name | timestamp with time zone | 60 | 6 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook | 17 | KEEP |
| trips | `departure_at` | timestamp with time zone | 11 | 4 | — | 4 | KEEP |
| trips | `estimated_arrival_at` | timestamp with time zone | 9 | 4 | — | 3 | KEEP |
| trips | `arrived_at` | timestamp with time zone | 8 | 4 | — | 3 | KEEP |
| user_device_tokens | `id` ⚠generic name | uuid | 388 | 98 | _shared,archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,paymongo-create-payment,paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,process-daily-reminders,record-manual-refund,record-photo-storage-event,send-push,store-photo-fallback,submit-inquiry,verify-payment-return | 68 | KEEP |
| user_device_tokens | `user_id` | uuid | 98 | 14 | email-trip-reschedule,get-photo-fallback,paymongo-create-payment,photo-storage-health,process-daily-reminders,send-push | 35 | KEEP |
| user_device_tokens | `token` | text | 8 | 12 | archive-expired-evidence-photos,broadcast-announcement,delete-photo-fallback,delete-storage-photos,email-trip-reschedule,get-photo-fallback,photo-storage-health,process-daily-reminders,process-push-deliveries,record-manual-refund,send-push,store-photo-fallback,unsubscribe-announcements | 17 | KEEP |
| user_device_tokens | `created_at` ⚠generic name | timestamp with time zone | 99 | 25 | paymongo-refund,paymongo-refund-recovery,paymongo-webhook,photo-storage-health,send-push,store-photo-fallback | 36 | KEEP |
| user_device_tokens | `device_id` | text | 7 | 1 | — | 1 | KEEP |
