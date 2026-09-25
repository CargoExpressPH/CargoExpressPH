# CargoExpress PH — Database Simplification and Fresh-Start Reset: Review for Approval

**Prepared:** 2026-09-25 · **Supabase project:** `duigaivxgxlnjmfienhg` · **Repository HEAD:** `3d56d7a` (+ uncommitted changes listed in §2)

> **Production state: UNCHANGED.** No migration was applied, no row was written or deleted, nothing was deployed, committed or pushed. Every production interaction was a read-only `SELECT` (catalog queries and aggregate counts) or a read-only download of one deployed function's source to a scratch folder.
>
> **Local state: IMPLEMENTED AND TESTED.** The changes below exist only in the working tree. They were verified against an isolated in-memory Postgres (PGlite) loaded with a schema-only replica of the live database.
>
> In this document, "removed" always means **proposed for removal by Stage 2**. All nine columns still exist in the live database.

Note on the baseline: while this work was in progress, 30 commits landed on `main` (by `justhulaanmo`, `cd42145` → `3d56d7a`; mostly UI/SEO/CSS, **no migrations**). All scans and tests were re-run on the new HEAD after they arrived. Live migration history: **219 applied = 219 local** before my two new files (latest applied: `20260924083945`).

---

## 1. Summary of what needs your approval

| # | Decision | My recommendation |
|---|---|---|
| A | Apply **Stage 1** migration (additive, backward compatible) | Approve |
| B | Deploy the 2 changed **Edge Functions** + the new **frontend** | Approve, after A |
| C | Apply **Stage 2** (drops 9 columns), after the compatibility period | Approve later, after B + backup |
| D | Run the **fresh-start reset** (table manifest §7) | Approve with the decisions in §7.3 |
| E | **Shipment-photo cleanup** through the Storage API | Approve after D |
| F | Pricing decision: a **weight correction** re-prices at the *current* rate (§4.2) | Decide |
| G | Capacity decision: allow **downward** weight corrections on an over-limit trip (§4.3) | Decide (implemented; one-line revert) |
| H | Which **accounts** to keep (2 admins, 6 customers — §7.3) | Decide |

---

## 2. Exact files and database objects changed (local only)

### 2.1 New files

| File | Purpose |
|---|---|
| `supabase/migrations/20260926100000_simplify_stage1_derive_and_compat.sql` | **Stage 1.** Additive/compatible. Picked up by `supabase db push`. |
| `supabase/migrations_pending/20260926110000_simplify_stage2_drop_columns.sql` | **Stage 2.** Destructive. Kept **outside** `supabase/migrations/` so a `db push` cannot apply it together with Stage 1. |
| `supabase/migrations_pending/README.md` | Explains the pending folder. |
| `supabase/maintenance/fresh_start_reset.sql` | Data reset. **Not a migration.** Guarded; see §7. |
| `supabase/maintenance/rollback_stage1.sql` | Exact rollback of Stage 1, generated from the live function definitions. |
| `scripts/reset/cleanup-shipment-photos.mjs` | Storage API cleanup of shipment photos. Dry-run by default. |
| `scripts/db-simplification-pgtest/snapshot-live-schema.py` | Builds `live-schema.sql` from **read-only** catalog queries (no rows). |
| `scripts/db-simplification-pgtest/live-schema.sql` | Generated schema-only replica: 29 tables, 151 functions, 50 triggers, 49 RLS policies. Contains no data or secrets (only Vault secret *names*). |
| `scripts/db-simplification-pgtest/{bootstrap.sql,harness.mjs,fixtures.mjs,run.mjs}` | Isolated test harness and the 92-check suite. |
| `src/lib/orderParties.js` | Shared frontend helper: `formatPersonName`, `orderPartyName`, `orderPartyAddress`. |

### 2.2 Modified files

| File | Change |
|---|---|
| `src/lib/database.js` | Adds `getCompanyTripDefaults` / `attachCompanyTripDefaults` (every trip fetch now carries company capacity and rate); removes `effectiveTripPrice`; trip selects no longer name `capacity, price_per_kg`; name search matches first/last parts; contact editing calls `update_order_contact_parts` with `lot_block` and no free-text address; explicit selects use name parts; stops writing the legacy inquiry `phone`; **removes the unused `createPaymentAttempt`** (verified: no caller anywhere in `src`, `scripts`, `tests`, `supabase`). |
| `src/components/ui/EditContactDetailsModal.jsx` | No full-address value is built or sent; lot/block is saved as its own field. |
| `src/pages/customer/BookShipmentPage.jsx`, `src/pages/admin/AdminCreateBookingPage.jsx` | Stop sending `sender_address` / `receiver_address`; display names through the helper. |
| `src/pages/admin/CreateTripPage.jsx` | Stops inserting `capacity` / `price_per_kg`; still shows the company values for planning. |
| `src/pages/admin/OrderDetailPage.jsx` | A weighed order shows its **recorded** `shipping_cost` (previously recomputed as weight × rate, which would drift after a rate change). The pickup estimate uses the current company rate. |
| `src/pages/admin/ContactInquiriesPage.jsx` | Reads only `contact_phone` / `contact_email` (legacy parser removed). |
| `src/components/ui/{PickupModal,DeliveryModal,AdditionalPaymentModal,PackageQrLabels}.jsx`, `src/pages/admin/{OrdersPage,TripDetailPage,UnpaidShipmentsPage}.jsx`, `src/pages/customer/{HomePage,OrdersPage,OrderDetailPage}.jsx`, `src/lib/{perTripSalesReport,supportChatEngine}.js` | Names and addresses through `orderPartyName` / `orderPartyAddress` (QR label, billing names, lists, search, reports). |
| `src/pages/admin/CompanyInformationPage.jsx` | Comment and help text: the company capacity is *the* trip capacity. |
| `supabase/functions/submit-inquiry/index.ts` | Stops writing `phone`. Requires a mobile number or an email. Accepts the legacy combined value **only** from old clients that send nothing else (split exactly as the old admin page did); it is never stored. |
| `supabase/functions/paymongo-create-payment/index.ts` | Stops writing `payment_attempts.description` / `estimated_cost`. **The description is still sent to PayMongo** at capture (both capture calls are unchanged). |
| `package.json` | Adds `npm run test:db-simplification`. |

Not changed on purpose: `src/pages/public/TrackingPage.jsx` and `src/pages/admin/ReportsPage.jsx`. They read `sender_name` / `receiver_name` from RPC responses (`track_order_public`, `get_financial_report_data`), and those responses keep the same field names.

### 2.3 Database objects in Stage 1

| Object | Kind | Change |
|---|---|---|
| `public.format_person_name(text, text)` | new | The one name rule |
| `public.clean_address_part(text)`, `public.format_address(6 × text)` | new | The one address rule (exact port of `buildFullAddress`) |
| `public.company_default_capacity()` | new | Reads `company_information.default_capacity` |
| `public.sender_name(orders)`, `receiver_name(orders)`, `sender_address(orders)`, `receiver_address(orders)`, `capacity(trips)`, `price_per_kg(trips)` | new | PostgREST **computed fields**: compatibility aliases for older clients |
| `private.sync_order_legacy_display_columns()` + trigger `orders_zz_sync_legacy_display_columns` | new (removed in Stage 2) | Keeps the stored legacy columns equal to the derived values until they are dropped |
| `public.sync_order_sender_receiver_names_insert()` + its trigger | **dropped** | Replaced by the one-way sync above |
| `public.update_order_contact_parts(...)` | new | Structured contact editing (adds lot/block, no free-text address) |
| `public.update_order_contact_details(...)` (old 19-arg signature) | replaced | Compatibility wrapper: **ignores** the free-text addresses and keeps lot/block |
| `public.guard_order_update()` | replaced | New pricing rule, company capacity, lock keyed on the parts (lot/block included) |
| `public.prepare_order_insert()`, `public.guard_customer_order_insert()` | replaced | Company capacity; no legacy name references |
| `public.effective_trip_price(uuid)` | replaced (dropped in Stage 2) | Returns the company rate; no longer reads the trip |
| `public.track_order_public(text)` | replaced | Same output fields; masked names derived from the parts |
| `public.get_financial_report_data`, `public.evidence_photo_rows`, `public.create_admin_notifications_rpc`, `private.notify_new_order` | replaced | **Only** the name expression changed (generated by exact text substitution from the live definitions) |
| `public.contact_phone_key(text)` | new | Rate-limit key: digits, last 10 |
| `public.guard_contact_inquiry_rate_limit()` | replaced | New limits (§5) |
| `contact_inquiries.phone` | altered | `DROP NOT NULL` |
| `contact_inquiries_has_contact_channel`, `_contact_phone_length`, `_contact_email_length` | new CHECKs | At least one channel; length bounds |
| `idx_contact_inquiries_created_at` | new index | Supports the rate-limit counts |

Stage 1's one-time statement re-derives the legacy columns on existing rows. A read-only check against production (the same rules implemented inline in a `SELECT`) found **0 of 11 sender names, 0 of 11 receiver names and 0 of 22 addresses differ**, so it is expected to update **zero** live rows.

---

## 3. Columns proposed for removal (Stage 2) and how each value is obtained afterwards

| Column (still in production) | After Stage 2, the value comes from | Old/API compatibility |
|---|---|---|
| `orders.sender_name` | `public.format_person_name(sender_first_name, sender_last_name)`; frontend `orderPartyName(order,'sender')` | Computed field `sender_name(orders)`, so `select=sender_name` keeps working. RPCs return the same `sender_name` field. |
| `orders.receiver_name` | same, receiver parts | computed field `receiver_name(orders)` |
| `orders.sender_address` | `public.format_address(lot_block, street, barangay, city, province, landmark)`; frontend `orderPartyAddress` | computed field `sender_address(orders)` |
| `orders.receiver_address` | same, receiver parts | computed field `receiver_address(orders)` |
| `trips.capacity` | `company_information.default_capacity` via `company_default_capacity()`; frontend `attachCompanyTripDefaults` | computed field `capacity(trips)` |
| `trips.price_per_kg` | `company_information.default_price_per_kg` via `global_price_per_kilo()` | computed field `price_per_kg(trips)` |
| `payment_attempts.estimated_cost` | nothing (never populated: 0 of 18 rows; no reader) | none needed |
| `payment_attempts.description` | the description still goes to PayMongo in the capture request; PayMongo keeps it | none needed (no reader) |
| `contact_inquiries.phone` | `contact_phone` + `contact_email` | the Edge Function still accepts the legacy request field |

**Formatting rules (identical in SQL and JavaScript; tested on 17 vectors):**
- *Name:* blank or NULL parts are skipped; any run of whitespace becomes one space; the result is trimmed. "Juan" + "Dela Cruz" → `Juan Dela Cruz`.
- *Address:* each part has leading/trailing spaces and commas stripped and `,,` collapsed; empty parts are dropped; a part equal (ignoring case) to the previous one is dropped. The order is lot/block, street, barangay, city, province, joined by `, `; then ` (Landmark: …)`. A free-text "Other Area" location is stored in `*_province`, so it appears unchanged.
  Example: `Lot 5 Blk 2, Rizal St, Bagumbayan, Quezon City, Metro Manila (Landmark: Near chapel)`

**Caveat:** computed fields are **not** included in `select=*`. That is why the current frontend never relies on them; they exist only for older cached clients and explicit selects.

---

## 4. Final pricing and capacity behaviour

### 4.1 Pricing rule (implemented)
- A booking has no price (`shipping_cost = 0`) until weighed. *Unchanged.*
- When `actual_weight` is recorded or changed, the database sets `shipping_cost = ROUND(weight × company_information.default_price_per_kg, 2)` at that moment.
- **Every other update keeps the recorded `shipping_cost`:** payments and refunds (which change `amount_paid` through the ledger trigger), discounts, trip reassignment, status changes, and direct write attempts. Before this change, the trigger re-priced on every `amount_paid` change. The baseline test on the live-schema replica reproduced the old behavior: ₱700 became ₱1,000 after a rate change followed by an ordinary ₱100 payment.
- Discounts are unchanged: payable = `shipping_cost − discount_amount` (floored at 0); balance = payable − net paid; status is derived from them. Discounts may only be set before pickup and never above the fee.

### 4.2 Every weight-change and trip-change path

| Path | What it writes | Pricing now | Before |
|---|---|---|---|
| `record_pickup_payment` (admin pickup, cash/GCash with manual verification) | weight (+ discount) | priced at the **current** company rate | trip rate, else company rate |
| `reconcile_paymongo_payment_attempt` (GCash pickup staged in an attempt) | `actual_weight = COALESCE(attempt weight, order weight)` | priced at the current rate **when the webhook reconciles**, which could differ from the rate shown at checkout if the rate changed in between | same exposure (trip rate) |
| Admin direct weight edit (`updateOrder`) | weight | re-priced at the current rate | trip rate |
| `reassign_trip` RPC, trip assignment in `updateOrder` / auto-assign at trip creation | `trip_id` | **no re-pricing** (recorded charge kept) | re-priced at the new trip's rate |

**Unresolved decision F (before production):** a weight correction made *after* a rate change re-prices the whole order at the new rate (test: 12 kg × ₱100 after the order was first priced at ₱70). Options:
1. **Keep as implemented** (simplest; the current rate applies whenever the scale reading changes).
2. Keep the originally applied rate for corrections. This needs a place to remember it, for example a small `orders.applied_rate_per_kg` snapshot column. That would re-introduce one stored value (per order, not per trip).

The GCash timing gap (row 2) is inherent to both options and rare. It can be closed by making pricing use the attempt's own amount; flagged, not implemented.

### 4.3 Capacity rule (implemented)
- Ceiling = `company_information.default_capacity` **+ 200 kg** (the existing allowance, unchanged; it matches `TRIP_CAPACITY_ALLOWANCE_KG`). A company capacity of 0 disables the check, as before.
- Checked when cargo is **added** to a trip: customer booking onto a trip, assignment or reassignment, or a weight **increase**.
- **If an administrator lowers the company capacity below a trip's recorded load:** nothing is unassigned or deleted, and existing cargo keeps moving through pickup, transit and delivery. New bookings onto that trip, assignments to it, and weight increases on it are refused with the standard message until the load is under the new ceiling.
- **Decision G:** a weight change that keeps or lowers an order's weight is always allowed. Before, *any* weight change re-ran the check, so a downward correction on an over-limit trip was blocked. This was added so a capacity reduction cannot freeze corrections. Reverting it is a one-line change.

---

## 5. Contact-inquiry anti-spam (implemented)

| Limit | Before (live) | Now |
|---|---|---|
| Per network (server-derived IP) | 5 / 10 min | 5 / 10 min |
| Per phone | 3 / 10 min, **only when no IP was present** | 3 / 10 min, **always**; `0917…` and `+63 917…` count as one number |
| Per email | none | 3 / 10 min (case-insensitive) |
| Global | 15 / min | 15 / min |
| Concurrency | two simultaneous inserts could both pass a count | transaction-scoped advisory lock serializes inquiry inserts |

The IP still comes only from the Edge Function (Cloudflare `cf-connecting-ip` first; the `ip` column is server-owned). The contact limits no longer depend on the IP, so a spoofed or shared IP cannot bypass them. The stored email is kept exactly as entered; only the rate-limit key is lower-cased.

---

## 6. Tests: commands and actual results

All results below come from this working tree (HEAD `3d56d7a` + changes), re-run after the upstream commits arrived.

| Command | Result |
|---|---|
| `npm run test:db-simplification` (new; live-schema replica + both stages, synthetic data) | **92 passed, 0 failed** |
| `npm run check` (full `npm test` chain, Edge Function esbuild bundle test, photo-fallback browser test, production build, PWA offline test) | **exit 0** |
| `npm run test:payment-ledger` | 52 passed, 0 failed |
| `npm run test:payment-notifications` | 41 passed, 0 failed |
| `npm run test:shipping-discount` | 95 passed, 0 failed |
| `npm run test:contact-details-lock` | 8 passed, 0 failed |
| `npm run test:service-area-mass-assignment` | 12 passed, 0 failed |
| `npm run test:email-updates-subscription` | 38 passed, 0 failed |
| `npm run test:delivery-cash-payment` | 47 passed, 0 failed |
| `npm run test:featured-shipments` | 33 passed, 0 failed |
| `npm run test:photo-gallery` | 47 passed, 0 failed |
| `npm run test:legacy-rpc-overload-cleanup` | 8 passed, 0 failed |
| `npm run test:trip-start-dates` | 26 passed, 0 failed |

The older domain suites run against their own historical harness schemas, so they prove no regression in those areas but do not exercise the new migrations. The new suite covers the requested flows:

| Requested verification | Covered by (section in `run.mjs`) |
|---|---|
| Customer and admin booking creation | Bookings… |
| Name and address editing | Contact-details editing; Stage-1 window (old signature) |
| Public tracking masked, no private fields | Public tracking stays masked |
| QR labels show correct details | Bookings… (helper on a `select=*` row, as `PackageQrLabels` uses it) |
| Pickup uses the current company rate | Pricing |
| Rate change does not re-price during payment or refund | Pricing |
| Discounts, partial payments, zero-payable, refunds | Pricing |
| Capacity limit + allowance; capacity reduction | Capacity |
| Trip assignment / reassignment | Pricing (reassignment keeps charge), Capacity (full-trip refusal) |
| Reports and printing data | Reports and admin views (financial report, evidence listing, notifications) |
| Contact inquiry + anti-spam | Contact inquiries |
| Retained admin after reset rehearsal | Fresh-start reset rehearsal |
| Clean booking → delivery after reset | Fresh-start reset rehearsal |
| Delayed / repeated payment events | Delayed / repeated PayMongo events |
| Stage 2 safety; Stage 1 rollback | Migrations apply…; Stage 1 rollback restores… |

Not run: **Playwright E2E**. It drives a real Supabase project and creates live data on every run, so it was deliberately skipped (no staging project was designated).

---

## 7. Fresh-start reset

### 7.1 Why it is safe to prepare now (read-only findings, 2026-09-25)
- **All PayMongo activity is test mode.** `livemode = false` on both refunds and all 14 recovery jobs. The ledger holds 14 GCash payments and 4 cash payments, all synthetic/test.
- No refund is pending or uncertain (2 of 2 `succeeded`). No attempt is captured-but-unreconciled. The 4 `pending` attempts are abandoned test checkouts: over a day old, no payment id, orders already delivered.
- Push jobs: 55 sent, 237 skipped, **0 queued**. Announcement emails: 31 accepted, **0 queued**. Photo cleanup queue: **0 open**.
- 14 `private.paymongo_refund_recovery_jobs` are **active until March 2027**. They poll PayMongo for dashboard-made refunds on these test payments, and the reset clears them. Otherwise they would keep polling for deleted payments.

Deleting local records **does not reverse any payment and does not remove anything from PayMongo**. PayMongo keeps its own transaction, refund and webhook history. Here it is test-mode data only.

### 7.2 Table-by-table manifest (29 application tables)

| Table | Rows now | Class | Notes |
|---|---|---|---|
| orders | 11 | **CLEAR** | test bookings |
| order_status_events | 34 | **CLEAR** | history of cleared orders |
| trips | 3 | **CLEAR** | |
| payment_attempts | 18 | **CLEAR** | 4 abandoned test checkouts |
| payment_transactions | 18 | **CLEAR** | test ledger |
| payment_refunds | 2 | **CLEAR** | both succeeded, test mode |
| cancellation_settlements | 0 | **CLEAR** | |
| cancellation_settlement_history | 1 | **CLEAR** | |
| customer_feedback | 2 | **CLEAR** | tied to cleared orders |
| conversations | 2 | **CLEAR** | support chats |
| chat_messages | 85 | **CLEAR** | |
| contact_inquiries | 0 | **CLEAR** | |
| notifications | 292 | **CLEAR** | about cleared records |
| notification_delivery_jobs | 293 | **CLEAR** | none queued |
| activity_logs | 515 | **CLEAR** ⚠ | audit trail of test activity; confirm you don't need it (the backup keeps it) |
| photo_storage_events | 17 | **CLEAR** | operational log |
| photo_cleanup_queue | 0 | **CLEAR** | |
| announcement_email_recipients | 31 | **CLEAR** | completed send log |
| announcement_email_broadcasts | 5 | **CLEAR** | completed send log |
| private.paymongo_refund_recovery_jobs | 14 | **CLEAR** | stops polling for deleted payments |
| private.manual_refund_reauth_attempts | 1 | **CLEAR** | re-auth lockout counter; resets it |
| company_information | 1 | **KEEP** | rate, capacity, contact details, banner reference |
| legal_documents | 2 | **KEEP** | current Terms and Privacy versions |
| legal_consents | 10 | **KEEP** | for retained accounts (cascades only if an account is deleted) |
| photo_storage_settings | 1 | **KEEP** | configuration |
| profiles | 8 | **KEEP / NEEDS OWNER DECISION** | see §7.3 |
| user_device_tokens | 1 | **KEEP** | belongs to a retained account |
| email_subscriptions | 8 | **NEEDS OWNER DECISION** | consent records (5 profile, 2 admin-set, 1 contact-form lead). Default: keep. |
| announcements | 13 | **NEEDS OWNER DECISION** | public website posts (3 active). Default: keep. |

**REBUILD:** none required. Totals, balances and statuses are derived by triggers, and the cleared tables have no derived copies elsewhere. Operational workers start from empty queues.

**Never touched:** `auth.*` (logins), `storage.*` (file metadata), `supabase_migrations.*`, `cron.*`, `vault.*`, Edge Function secrets, PayMongo/Firebase configuration.

How the script clears data: **one `TRUNCATE` statement, without `CASCADE`**. No kept table references a cleared table (FK graph checked), so a mistake fails instead of silently emptying a kept table. `TRUNCATE` fires no row triggers, so **no notification, push, email or audit row is produced about the removed records**. The script refuses to run without `SET LOCAL cargoexpress.reset_confirm = 'I-HAVE-A-VERIFIED-BACKUP'`. It also refuses while anything external is open (live/uncertain/non-final refunds, captured-but-unreconciled payments, live-mode recovery jobs, queued push or email jobs, open storage cleanup) unless you explicitly acknowledge those items. It prints before/after counts for every table.

### 7.3 Accounts (listed separately; nothing deleted by default)

| Account (id prefix) | Role | Created | Last login | Orders | Consents |
|---|---|---|---|---|---|
| 2e11107a | admin | 2026-05-01 | 2026-09-25 | 0 | 0 |
| dc668c1f | admin | 2026-06-26 | 2026-09-24 | 0 | 0 |
| fe497f30 | customer | 2026-08-06 | 2026-09-24 | 9 | 0 |
| bbc09b18 | customer | 2026-08-28 | 2026-09-25 | 2 | 2 |
| a483d982 | customer | 2026-08-29 | 2026-08-29 | 0 | 2 |
| 623c3ff6 | customer | 2026-09-09 | 2026-09-14 | 0 | 2 |
| f86e6c72 | customer | 2026-09-20 | 2026-09-20 | 0 | 2 |
| d0613607 | customer | 2026-09-22 | 2026-09-22 | 0 | 2 |

There are **two** admin accounts; please confirm which to keep. Customer account removal, if approved per account, must use the Supabase Auth Admin API or the Dashboard (Authentication → Users → Delete), never SQL on `auth.users`. That cascades to the profile, consents and device tokens. Customer `fe497f30` has 0 legal consents (it predates consent capture).

### 7.4 Announcement-consent mismatch (investigated separately, not changed)
The single mismatch is the **admin** account: `profiles.wants_announcements = false`, but `email_subscriptions.subscribed = true` (source `admin`, set 2026-09-16, after the profile's last update). This is **by design**: `admin_set_email_subscription()` deliberately does not copy an admin-made opt-*in* into the profile, while any opt-*out* always propagates. No change is proposed, and no one is opted in automatically. Two accounts (1 admin, 1 customer) simply have no subscription row, which means "never chosen".

### 7.5 Storage
| Bucket | Folder | Objects | Size | Plan |
|---|---|---|---|---|
| `cargo-photos` (private) | `pickup-proofs` | 11 | 2.8 MB | delete after the DB reset (Storage API) |
| `cargo-photos` (private) | `delivery-proofs` | 4 | 1.4 MB | same |
| `company-assets` (public) | `banner` | 1 | 189 kB | **KEEP** (referenced by Company Information) |

Orders reference 8 photos (5 pickup, 3 delivery; all Supabase, none Firebase), so **7 objects are already unreferenced**. `photo_storage_events` records only Supabase uploads. Whether any Firebase-fallback objects exist was **not verified** (no Firebase access was used).

`scripts/reset/cleanup-shipment-photos.mjs` uses `storage.from('cargo-photos').list/remove`, which removes the file and its metadata together. It never touches `company-assets` and never prints object names.
- `--mode=orphans` removes only unreferenced objects (safe anytime).
- `--mode=all` is refused until orders and payments are empty.
- It is a dry run unless `--execute` is given.

---

## 8. Backup, restoration and deployment order

### 8.1 Deployment and maintenance sequence (all steps NOT EXECUTED)

```bash
# ── 0. Pre-flight (read-only) ─────────────────────────────────────────────
supabase migration list --linked            # expect 219 applied + 1 pending (stage 1)

# ── 1. BACKUP (required before steps 5–7) ─────────────────────────────────
# pg_dump is not installed on this machine: `brew install libpq` (or use the
# Dashboard → Database → Backups if the plan includes them — UNVERIFIED).
pg_dump "$DB_URL" -Fc --no-owner -n public -n private -n auth -f cargoexpress_$(date +%Y%m%d).dump
supabase storage cp -r ss:///cargo-photos ./backup/cargo-photos --linked
# Verify: pg_restore --list cargoexpress_*.dump | wc -l ; count files in ./backup/cargo-photos

# ── 2. STAGE 1 (compatible with the current app and old clients) ──────────
supabase db push                            # applies ONLY 20260926100000 (stage 2 is in migrations_pending/)

# ── 3. Edge Functions (need stage 1: phone is nullable) ───────────────────
supabase functions deploy submit-inquiry
supabase functions deploy paymongo-create-payment
# then: one test-mode GCash payment end to end; one contact inquiry.

# ── 4. Frontend (needs stage 1: update_order_contact_parts) ───────────────
#   deploy the build as usual (Vercel); smoke-test booking, pickup, tracking.

# ── 5. Compatibility period — recommended ≥ 7 days ────────────────────────
#   Open old tabs keep old JavaScript until the user accepts the in-app
#   update prompt. Everything old clients do still works under stage 1.

# ── 6. Maintenance window: pause workers, reset, clean storage, resume ────
psql "$DB_URL" <<'SQL'
SELECT cron.alter_job(jobid, active := false) FROM cron.job
 WHERE jobname IN ('process_push_deliveries','daily_payment_reminders','paymongo_refund_recovery',
                   'scheduled_old_photo_cleanup','photo_storage_health_check','monitor_push_delivery_health',
                   'auto_resolve_stale_conversations');
SQL
psql "$DB_URL" <<'SQL'
BEGIN;
SET LOCAL cargoexpress.reset_confirm = 'I-HAVE-A-VERIFIED-BACKUP';
\i supabase/maintenance/fresh_start_reset.sql
-- read the before/after NOTICE report, then:
COMMIT;
SQL
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/reset/cleanup-shipment-photos.mjs --mode=all            # dry run
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/reset/cleanup-shipment-photos.mjs --mode=all --execute
psql "$DB_URL" -c "SELECT cron.alter_job(jobid, active := true) FROM cron.job WHERE jobname IN (...same list...);"
#   Security checks are NOT disabled at any point; only schedulers are paused.
#   Delayed PayMongo webhooks during/after the window are ignored (no attempt row).

# ── 7. STAGE 2 (destructive) — only after 3–6 are verified ────────────────
git mv supabase/migrations_pending/20260926110000_simplify_stage2_drop_columns.sql supabase/migrations/
supabase db push                            # the migration aborts itself if any function still reads a dropped column

# ── 8. Later clean-up (not prepared): drop the compatibility aliases and the
#       old update_order_contact_details wrapper once no old client can exist.
```

The cron job names come from the live `cron.job` table. `purge_*` housekeeping jobs can stay active.

### 8.2 Rollback

| Step | Rollback | Data restorable? |
|---|---|---|
| Stage 1 | `supabase/maintenance/rollback_stage1.sql` (tested: restores all live function definitions byte-for-byte and the original triggers; refills `phone` for inquiries written meanwhile) + redeploy the previous frontend and Edge Functions | Yes, no data is lost |
| Edge Functions / frontend | redeploy the previous version | Yes |
| Reset | restore the cleared tables from the dump into a scratch database, then copy rows back (`pg_restore --data-only -t <table>`), **before** Stage 2 | Yes, from the backup only |
| Storage cleanup | re-upload from `./backup/cargo-photos` | Yes, only if the storage copy in step 1 was made |
| Stage 2 | forward migration re-adding the columns; names, addresses and trip values can be re-derived from parts/defaults | Names, addresses and trip values: yes (derivable). `payment_attempts.description`: only from the backup. |

**Cannot be undone by any restore:** push notifications and emails already delivered; anything on PayMongo's side (unaffected by the reset in any case); photos deleted without the storage copy.

---

## 9. Unverified behaviour and unresolved decisions

1. **Deployed code parity:** the 20 deployed Edge Functions were not byte-compared with the repository (only `support-bot` was downloaded: a retired 410 stub). The deployed frontend was not compared with the repository.
2. **PostgREST computed fields** were verified as SQL (the functions and their SQL attribute notation). The HTTP behaviour against Supabase's PostgREST (embedded `trips(capacity,price_per_kg)` and `select=sender_name`) should be smoke-tested on staging or right after Stage 1.
3. **True concurrency** of the inquiry limiter: PGlite has one connection. The test proves the insert takes the advisory lock; simultaneous clients were not exercised.
4. **Edge Functions** were checked by the esbuild bundle test and code review, not executed in Deno.
5. **Supabase backup plan / PITR availability** for this project is unknown.
6. **Firebase-fallback storage** contents were not inspected.
7. **Decisions F, G, H** (§1) and the manifest items marked NEEDS OWNER DECISION.

---

## 10. Chapter 2 field descriptions

### 10.1 CURRENT production schema (use these until Stage 2 is applied)

| Field Name | Data Type | Description |
|---|---|---|
| trips.capacity | integer | Planned van capacity in kg, copied from the company default when the trip was created. *(Proposed for removal.)* |
| trips.price_per_kg | numeric | Freight rate in ₱/kg copied from the company default when the trip was created; used by the database to compute an order's shipping cost. *(Proposed for removal.)* |
| company_information.default_capacity | integer | Default van capacity (kg) copied into new trips. |
| company_information.default_price_per_kg | numeric | Default freight rate copied into new trips; fallback rate for an order without a trip. |
| orders.sender_first_name / sender_last_name | text | Sender's given name and surname; the authoritative name fields. |
| orders.sender_name | varchar | Sender's full name, kept in sync by the database from first and last name. *(Proposed for removal.)* |
| orders.receiver_first_name / receiver_last_name / receiver_name | text / varchar | Same as the sender fields, for the receiver. *(receiver_name proposed for removal.)* |
| orders.sender_address / receiver_address | text | Complete pickup/delivery address as entered at booking or contact edit. *(Proposed for removal.)* |
| orders.sender_lot_block, sender_street, sender_barangay, sender_city, sender_province, sender_landmark (and receiver_*) | text | Structured address parts. |
| orders.shipping_cost | numeric | Shipping charge = weight × rate; currently recalculated when weight, trip, discount **or amount paid** changes. |
| contact_inquiries.phone | text | Legacy combined contact value ("phone \| email"); also the phone rate-limit key. *(Proposed for removal.)* |
| contact_inquiries.contact_phone / contact_email | text | The inquirer's mobile number / email, stored separately. |
| payment_attempts.estimated_cost | numeric | Legacy field, never populated. *(Proposed for removal.)* |
| payment_attempts.description | text | Copy of the charge label sent to PayMongo; not read by the system. *(Proposed for removal.)* |

### 10.2 AFTER approval and Stage 2 (describe these only once applied)

| Field Name | Data Type | Description |
|---|---|---|
| company_information.default_capacity | integer | The van capacity (kg) used for every trip's capacity check, plus a fixed 200 kg allowance. Changing it affects future loading only; no cargo is unassigned. |
| company_information.default_price_per_kg | numeric | The freight rate (₱/kg) applied when a parcel's weight is recorded at pickup. Changing it never changes a charge already recorded. |
| orders.shipping_cost | numeric | Charge recorded when the weight is recorded (weight × company rate at that moment). Kept unchanged by payments, refunds, discounts and trip reassignment. |
| orders.discount_amount | numeric | Approved peso reduction set before pickup; payable = shipping_cost − discount_amount. |
| orders.sender_first_name / sender_last_name | text | Sender's given name and surname. The full name is derived from these (not stored). |
| orders.receiver_first_name / receiver_last_name | text | Receiver's given name and surname. The full name is derived from these (not stored). |
| orders.sender_lot_block | text | Lot/block/purok of the pickup address (optional). |
| orders.sender_street | text | Street/subdivision of the pickup address. |
| orders.sender_barangay | text | Barangay of the pickup address. |
| orders.sender_city | text | City/municipality of the pickup address. |
| orders.sender_province | text | Province of the pickup address; holds the typed location for out-of-coverage ("Other Area") pickups. |
| orders.sender_landmark | text | Landmark for the pickup address. The complete address is derived from these six parts (not stored). |
| orders.receiver_* (same six parts) | text | Delivery address parts; the complete delivery address is derived. |
| contact_inquiries.contact_phone | text | The inquirer's mobile number (optional if an email is given). |
| contact_inquiries.contact_email | text | The inquirer's email address (optional if a mobile number is given). At least one of the two is required. |
| contact_inquiries.ip | text | Network address recorded by the server for anti-spam limits. |

**Derived values (not table columns) — for the manuscript's data-processing section:**

| Name | Returned as | Rule |
|---|---|---|
| Full name | `sender_name` / `receiver_name` in tracking, reports, labels | first name + " " + last name (blanks skipped, spaces normalized) |
| Complete address | `sender_address` / `receiver_address` | lot/block, street, barangay, city, province + " (Landmark: …)" |
| Trip capacity | `capacity` on trip displays | company_information.default_capacity |
| Trip rate | `price_per_kg` on trip displays | company_information.default_price_per_kg |

---

## 11. Simple Taglish explanation

Wala pang binago sa production. Lahat ng ginawa ko ay local lang at sinubukan sa isang kopya ng database structure (walang totoong data).

- **Presyo at capacity:** Sa Company Information na lang kukunin ang rate per kg at capacity. Kapag tinimbang ang parcel sa pickup, gagamitin ang kasalukuyang rate. **Kapag nagbago ang rate, hindi na magbabago ang singil ng lumang order** kahit may bagong bayad o refund. Dati, nagbabago ito tuwing may bayad; nakita ko ito sa test. Nasa 200 kg allowance pa rin. Kapag binabaan ang capacity, walang cargo na tatanggalin; hindi lang tatanggap ng dagdag na karga.
- **Pangalan at address:** Hindi na itatago ang buong pangalan at buong address. Binubuo na lang ito mula sa first/last name at sa mga bahagi ng address (lot/block, street, barangay, city, province, landmark), gamit ang iisang rule sa database at sa app. Sa pag-edit ng contact details, ang mga bahagi na ang ine-edit, kaya hindi na magkakaiba ang buong address at ang mga bahagi nito.
- **Contact form:** Hindi na ginagamit ang lumang `phone`. Mas mahigpit na ang anti-spam: may limit na bawat phone, bawat email, bawat network, at global.
- **Fresh start:** Handa na ang reset script, pero may bantay: hindi ito tatakbo nang walang backup confirmation, o kung may nakabinbing refund, payment, o notification. Test mode lahat ng PayMongo payments, kaya walang totoong pera. Tandaan: ang pagbura sa database ay hindi nagbabalik ng bayad at hindi nagbubura ng history sa PayMongo. Hindi buburahin ang mga account hangga't hindi mo sinasabi kung alin.
- **Order ng gagawin:** backup → Stage 1 → Edge Functions at frontend → maghintay (mga 7 araw) → reset at storage cleanup → Stage 2 (pagtanggal ng columns).
