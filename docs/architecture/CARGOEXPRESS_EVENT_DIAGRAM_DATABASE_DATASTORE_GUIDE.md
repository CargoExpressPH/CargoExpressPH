# CargoExpress PH — Event Diagram Database Data Store Guide

**Purpose:** Identify the correct data store(s) to place on each Chapter 2 Event List Diagram (Actor → Process → Data Store).
**Method:** Direct, read-only inspection of `supabase/schema.sql` (a full live-database schema dump, dated 2026-09-01 — the authoritative column-level reference used below), every file under `supabase/migrations/` (for tables created or dropped after that dump, and for trigger/RPC behavior), and every page/function in `src/` and `supabase/functions/` that actually reads or writes each table.
**No files were modified.** No source code, schema, migrations, or Supabase data were changed. Chapter 2 itself was not touched.

---

## 1. Scope and Source of Truth

`supabase/schema.sql` is explicitly labeled in its own header as "Synced from LIVE database on 2026-09-01" and is the single most reliable column-level reference in the repository — it reflects the database as it actually exists, not as any one migration file alone would suggest. It lists **21 tables**. Cross-checking every `CREATE TABLE` / `DROP TABLE` statement across all 125+ migration files against that dump surfaced:

- **3 additional tables** created after that dump and still active: `email_usage_logs`, `email_activity_log`, `notification_delivery_jobs`.
- **Several tables that no longer exist**, confirmed dropped and not recreated: `chat_faqs`, `chatbot_analytics`, `chatbot_unanswered_queries`, `trip_reassignments`, `coverage_regions`, `coverage_municipalities`, `global_settings` (all removed by `20260715000000_consolidate_tables.sql`; their functionality was consolidated into JSONB columns on `orders` and `company_information` — verified directly in `src/lib/database.js`, e.g. `getTripReassignments()` now reads `orders.reassignment_history`, a JSONB column, not a `trip_reassignments` table).

This gives a verified total of **24 currently-existing tables in the `public` schema**, plus Supabase's own `auth.users` (not in `public`, referenced only as a foreign-key target).

---

## 2. Complete Table Inventory

### Table: profiles

THESIS DATA STORE NAME:
profiles_db

PURPOSE:
Stores every registered account — both customers and administrators — with their identity, contact details, and address.

MAIN DATA STORED:
- name, email, phone, facebook_name
- address_lot_block, address_street, address_barangay, address_city, address_province, address_landmark
- role ('admin' or 'customer')
- wants_announcements (email opt-in)

READ BY:
- Login/session resolution (`AuthContext.jsx`)
- Customer directory and detail (`getCustomers`, `getCustomerById`)
- Every page that joins a customer's name/phone/email onto an order

WRITTEN BY:
- Registration (`AuthContext.register()` → `createProfile()`), backed by a database trigger (`handle_new_user()`) that also inserts a minimal row atomically with the `auth.users` row
- Profile edits (`updateProfile`, `updateOwnProfile`)

RELATED EVENTS:
- Event 1 — Customer Registration
- Event 11 — Viewing Customer Records

SHOW IN EVENT LIST DIAGRAM:
YES

REASON:
This is the actual, sole record of who a customer or admin is. It is the correct and only data store for the Registration event.

---

### Table: orders

THESIS DATA STORE NAME:
orders_db

PURPOSE:
The central business record of one cargo booking, from creation through delivery or cancellation — sender/receiver details, cargo weight and cost, trip assignment, payment summary, photos, and current status.

MAIN DATA STORED:
- tracking_number, sender_name/phone/address/city/province/facebook, receiver_name/phone/address/city/province/facebook, package_description
- trip_id, origin, destination
- actual_weight, shipping_cost, payer_type, payment_method, payment_status, amount_paid, remaining_balance, promised_payment_date, payment_reference, payment_preference
- status (Pending Review → Pending → Assigned → Picked Up → In Transit → Arrived at Hub → Out for Delivery → Delivered, plus Pending Cancellation/Cancelled)
- pickup_photos, delivery_photos (JSONB arrays)
- service_area_status/remarks (out-of-coverage review)
- featured_on_website, featured_title/caption/image_type (public success-story flag)
- reassignment_history (JSONB — trip reassignment history)
- cancellation_details (JSONB — reason, requested_at, reviewed_by, previous_status)
- last_reminder_sent_at

READ BY:
- Virtually every customer and admin order-facing page: `BookShipmentPage`, `OrdersPage` (both roles), `OrderDetailPage` (both roles), `TrackingPage`, `TripDetailPage`, `SalesReportsPage`, `UnsettledDeliveriesPage`, `CustomerDetailPage`, `getReportData()`, `getSalesData()`

WRITTEN BY:
- Booking creation (`createOrder()`)
- Admin review/assignment/status advance (`updateOrder()`, `assignOrderToCustomer()`)
- Pickup and delivery processing (`recordPickupPayment()`, `recordDeliveryPayment()` — these write both order fields and a payment ledger row in one transaction)
- Cancellation (`requestOrderCancellation()`, `reviewOrderCancellation()`, `cancelOrderAsAdmin()`)
- Trip-cascaded status changes (`bulkUpdateOrdersStatusByTrip()`)

RELATED EVENTS:
- Event 2 — Cargo Booking
- Event 3 — Shipment Tracking
- Event 4 — Trip Scheduling and Cargo Assignment
- Event 5 — Cargo Pickup and Weighing
- Event 6 — Payment Recording and Monitoring
- Event 7 — Shipment Status Monitoring and Updates
- Event 8 — Cargo Delivery and Completion
- Event 9 — Cancellation Request and Review
- Event 11 — Viewing Customer Records
- Event 12 — Generating Reports

SHOW IN EVENT LIST DIAGRAM:
YES

REASON:
This is the single most important business data store in the system — nearly every event either reads or writes it.

---

### Table: trips

THESIS DATA STORE NAME:
trips_db

PURPOSE:
A scheduled cargo run between two fixed points — its route, dates, capacity, shipping rate, and lifecycle status.

MAIN DATA STORED:
- trip_number, origin, destination, departure_date, arrival_date, departure_at
- capacity (kg), price_per_kg
- status (scheduled → in_progress → arrived → completed, or cancelled)
- notes, created_by

READ BY:
- `TripsPage` (both roles), `TripDetailPage`, `BookShipmentPage` (route/rate selection), `CreateTripPage` (duplicate-route check)

WRITTEN BY:
- `CreateTripPage` (`createTrip()`, which also auto-assigns matching pending orders)
- `TripDetailPage` (`updateTrip()` — Start/Arrive/Complete/Cancel, and reschedule)

RELATED EVENTS:
- Event 2 — Cargo Booking (read, for route/rate selection)
- Event 4 — Trip Scheduling and Cargo Assignment
- Event 7 — Shipment Status Monitoring and Updates (read, as context for the trip-cascaded status)

SHOW IN EVENT LIST DIAGRAM:
YES

REASON:
Trips are a first-class business concept distinct from an individual order and are essential to Event 4.

---

### Table: order_status_events

THESIS DATA STORE NAME:
order_status_events_db

PURPOSE:
An automatically-generated history of every status a given order has passed through, with a timestamp — the data source for the tracking timeline shown to both customers and the public.

MAIN DATA STORED:
- order_id, status, changed_at, changed_by, note

READ BY:
- `TrackingPage` (public, via RPC `get_public_order_events`), `OrderDetailPage` (both roles, via `getOrderStatusEvents()`)

WRITTEN BY:
- **Not written by any application code.** A database trigger (`orders_log_status_event` / `log_order_status_event()`) inserts a row automatically every time `orders.status` changes. The "process" that produces this data store is really "any process that changes an order's status" (booking, pickup, trip cascade, delivery, cancellation) — the row appears as an automatic side effect, not a deliberate write.

RELATED EVENTS:
- Event 3 — Shipment Tracking
- Event 7 — Shipment Status Monitoring and Updates

SHOW IN EVENT LIST DIAGRAM:
YES

REASON:
This is the actual, verified source of the tracking timeline — showing only `orders` for the Tracking event would omit the one table that literally holds the history being displayed.

---

### Table: payment_transactions

THESIS DATA STORE NAME:
payment_transactions_db

PURPOSE:
The finalized ledger of every payment actually collected against an order — cash, GCash, or a reconciled online payment — regardless of when in the shipment's life it was collected.

MAIN DATA STORED:
- order_id, amount, payment_method, transaction_reference, payment_status ('paid'/'partial')
- admin_id, admin_name (who recorded it — "System Webhook" for automated GCash reconciliation)
- payment_type ('Initial Payment', 'Additional Payment', 'Balance Settlement', etc.), payment_date, receipt_url

READ BY:
- `PaymentHistoryPage` (customer), `OrderDetailPage` (both roles), `UnsettledDeliveriesPage`, `getSalesData()`/`get_sales_summary()`

WRITTEN BY:
- `recordPickupPayment()`, `recordDeliveryPayment()`, `recordAdditionalPayment()` (cash or manual GCash reference)
- Automated PayMongo/GCash reconciliation (`reconcile_paymongo_payment_attempt` RPC, triggered by the `paymongo-webhook` Edge Function or the client's status-poll)

RELATED EVENTS:
- Event 5 — Cargo Pickup and Weighing (only if payment is collected at pickup)
- Event 6 — Payment Recording and Monitoring
- Event 8 — Cargo Delivery and Completion (only if a balance is collected at delivery)
- Event 12 — Generating Reports

SHOW IN EVENT LIST DIAGRAM:
YES

REASON:
This is the actual system of record for money collected — `orders.amount_paid`/`remaining_balance`/`payment_status` are database-trigger-derived FROM this table, not the other way around, confirmed directly in the migration comments and RPC bodies.

---

### Table: payment_attempts

THESIS DATA STORE NAME:
*(not recommended — see reason)*

PURPOSE:
Tracks one in-progress PayMongo/GCash checkout attempt from source creation through webhook confirmation — an integration-level bridge table, not a finalized payment record.

MAIN DATA STORED:
- source_id, payment_id, order_id, amount, status ('pending'/'chargeable'/'reconciled'/'failed')
- actual_weight, payer_type, pickup_photos (staged copies used to finish the pickup once payment clears)

READ BY:
- `paymongo-create-payment` Edge Function (poll/register actions), `getLatestPaymentAttemptByOrder()`, `getPaymentAttemptBySource()`

WRITTEN BY:
- `paymongo-create-payment` Edge Function (on source registration), `paymongo-webhook` Edge Function (on PayMongo callback)

RELATED EVENTS:
- Event 6 — Payment Recording and Monitoring (internally only)

SHOW IN EVENT LIST DIAGRAM:
NO

REASON:
This is PayMongo integration plumbing — an in-flight checkout state, not a business record. Once payment clears, its outcome is written into `payment_transactions` (the real business data store) and `payment_attempts` is only kept for reconciliation bookkeeping. Showing it on a thesis diagram would expose an implementation detail without adding business meaning; "Payment Recording and Monitoring" is correctly represented by `payment_transactions` + `orders` alone.

---

### Table: customer_feedback

THESIS DATA STORE NAME:
customer_feedback_db

PURPOSE:
A customer's star rating and message about one completed (Delivered) order.

MAIN DATA STORED:
- order_id (unique — one feedback per order), customer_id, rating (1–5), message, is_hidden

READ BY:
- `FeedbackPage` (admin), a public feedback RPC (`get_public_feedback`) for the public site's testimonials

WRITTEN BY:
- `submitFeedback()`, triggered automatically when a customer views a Delivered order's detail page for the first time (`checkIfFeedbackExists()` gates a duplicate)

RELATED EVENTS:
- Event 10 — Customer Feedback Submission

SHOW IN EVENT LIST DIAGRAM:
YES

REASON:
This is a dedicated, purpose-built table for exactly this event.

---

### Table: company_information

THESIS DATA STORE NAME:
company_information_db

PURPOSE:
A single row holding the company's public profile, contact details, default pricing, feature list, and service-coverage areas.

MAIN DATA STORED:
- name, short/long description, banner fields, email, facebook, messenger, phone numbers, office addresses
- default_price_per_kg
- **features** (JSONB array — company feature/highlight list)
- **coverage** (JSONB array — service-coverage regions/municipalities)

READ BY:
- `AboutPage` (public), `BookShipmentPage` (default rate), `SupportChatPage` chatbot (coverage/pricing answers)

WRITTEN BY:
- `CompanyInformationPage` (admin) → `updateCompanyInformation()`, plus dedicated coverage/feature-ordering helpers that all still write into this same row's JSONB columns

RELATED EVENTS:
- Event 13 — Managing Company Information and Coverage Areas

SHOW IN EVENT LIST DIAGRAM:
YES

REASON:
Important correction for the diagram: **there is no separate `coverage_regions`/`coverage_municipalities` table anymore.** Those tables existed at one point and were dropped and consolidated into the `coverage` and `features` JSONB columns on this single table. One data store, `company_information_db`, correctly represents the entire event.

---

### Table: announcements

THESIS DATA STORE NAME:
announcements_db

PURPOSE:
News/notices published by the admin to all customers, optionally by email.

MAIN DATA STORED:
- title, content, author_id, is_active, comments (JSONB), send_email, emailed_at

READ BY:
- `AnnouncementsPage` (admin), `NotificationsPage`/`HomePage` (customer, via the notification linking to the full announcement)

WRITTEN BY:
- `AnnouncementsPage` → `createAnnouncement()`, `addAnnouncementComment()`, `deleteAnnouncement()` (soft-delete via `is_active`)

RELATED EVENTS:
- Event 14 — Publishing Announcements

SHOW IN EVENT LIST DIAGRAM:
YES

REASON:
The dedicated, correct data store for this event.

---

### Table: conversations

THESIS DATA STORE NAME:
conversations_db

PURPOSE:
One row per registered customer's ongoing support thread — its current state (bot-handled, waiting on a human, waiting on the customer, or resolved).

MAIN DATA STORED:
- customer_id (unique — one conversation per customer), status, escalated, first_response_at, last_customer_message_at, resolved_at, bot_resolved

READ BY:
- `SupportChatPage` (customer), `InboxPage` (admin)

WRITTEN BY:
- `getOrCreateConversation()`, `escalateConversation()`, `resolveConversation()`, `recordBotOutcome()` — plus an automatic state-transition trigger reacting to new messages

RELATED EVENTS:
- Event 15 — Customer Support and Inbox Management

SHOW IN EVENT LIST DIAGRAM:
YES

REASON:
This is the actual conversation-state record the admin Inbox is built on.

---

### Table: chat_messages

THESIS DATA STORE NAME:
chat_messages_db

PURPOSE:
Every individual message exchanged within a support conversation (from the customer, an admin, or the automated assistant).

MAIN DATA STORED:
- conversation_id, sender_id, sender_role, message, is_read

READ BY:
- `SupportChatPage`, `InboxPage`

WRITTEN BY:
- `sendMessage()` (customer and admin replies); the rule-based chatbot's replies are also written here by the same function

RELATED EVENTS:
- Event 15 — Customer Support and Inbox Management

SHOW IN EVENT LIST DIAGRAM:
YES

REASON:
Distinct from `conversations` (one holds the thread's state, the other holds its content) — both are needed to represent the event accurately.

---

### Table: contact_inquiries

THESIS DATA STORE NAME:
contact_inquiries_db

PURPOSE:
A message submitted through the public contact form by a visitor who has not created (and is not required to create) an account.

MAIN DATA STORED:
- name, phone, message, status ('new'/'read'/'resolved'), contact_phone, contact_email
- assigned_admin_id, first_response_at, resolved_at, wants_announcements, ip (for rate-limiting)

READ BY:
- `ContactInquiriesPage` (admin)

WRITTEN BY:
- `submit-inquiry` Edge Function only (anonymous, IP rate-limited; there is no direct client insert policy)

RELATED EVENTS:
- Event 15 — Customer Support and Inbox Management

SHOW IN EVENT LIST DIAGRAM:
YES

REASON:
This is a genuinely separate flow from the authenticated chat system — different actor (anonymous visitor vs. logged-in customer), different table, different Edge Function. It belongs in the same event (both end up reviewed by the admin) but as its own actor→process→store line. See Step 5, Question 15 below for the recommended diagram treatment.

---

### Table: notifications

THESIS DATA STORE NAME:
notifications_db

PURPOSE:
An in-app notification for one user (customer or admin) — an order update, a trip update, an announcement, or a system alert.

MAIN DATA STORED:
- user_id, title, message, type ('order_update'/'trip_update'/'announcement'/'general'/'inquiry'/'feedback'/'chat_message'/'system_alert'), reference_id, is_read

READ BY:
- `NotificationsPage` (customer), the admin notification center

WRITTEN BY:
- Almost every business process that changes something a user should know about: booking creation, status/trip changes, announcements, feedback, contact inquiries, low-storage warnings — all via `createNotification()`/`createAdminNotification()`

RELATED EVENTS:
- Touches nearly every event as a secondary side-effect

SHOW IN EVENT LIST DIAGRAM:
OPTIONAL

REASON:
Real and actively used, but it is a cross-cutting notification sink written by almost every process in the system. Showing it on every single Event Diagram would add clutter without much new information. **Recommended only where a customer directly views/acts on it as the point of the event** — most usefully Event 14 (Publishing Announcements), where "the customer is notified" is the actual visible outcome of the process. Elsewhere, note it only as an implicit side effect, not a primary diagram element.

---

### Table: activity_logs

THESIS DATA STORE NAME:
activity_logs_db

PURPOSE:
A 7-day admin audit trail — who did what, to which record, and when — automatically recorded for most administrative actions.

MAIN DATA STORED:
- admin_id, admin_name, module ('Orders'/'Trips'/'Payments'/'Chat'/'Authentication'/'System'/'Sales & Reports'/'Customers'/'Feedback'), action, record_type, record_id, record_ref, previous_value, new_value, details

READ BY:
- `ActivityLogsPage` (admin only)

WRITTEN BY:
- Virtually every admin-facing write path in `database.js`, via `logOrder()`, `logTrip()`, `logPayment()`, `logChat()`, `logAuth()`, `logAnnouncement()`, `logSettings()`, `logCompany()`

RELATED EVENTS:
- Touches nearly every administrative event as a secondary side-effect

SHOW IN EVENT LIST DIAGRAM:
OPTIONAL

REASON:
Same reasoning as `notifications`: genuinely real and business-relevant (it is literally the audit trail feature an admin uses), but cross-cutting across nearly every event in the list. The 15-event list provided does not include a dedicated "Viewing Activity Logs" event; if one is added, `activity_logs_db` is its correct primary store. Until then, recommend omitting it from the other 15 diagrams to avoid repeating the same secondary store on every page.

---

### Table: legal_consents

THESIS DATA STORE NAME:
legal_consents_db

PURPOSE:
A record that a specific user accepted a specific version of the Terms of Service or Privacy Policy, and when.

MAIN DATA STORED:
- user_id, document_type ('terms_of_service'/'privacy_policy'), document_version, accepted_at, source ('registration'/'account_update')

READ BY:
- Not surfaced on any admin or customer page found in this inspection — appears to be a compliance record only, not queried back by the UI

WRITTEN BY:
- Registration (`RegisterPage` → the legal-consent checkboxes), and account updates

RELATED EVENTS:
- Event 1 — Customer Registration (secondary)

SHOW IN EVENT LIST DIAGRAM:
OPTIONAL

REASON:
It is a real, currently-used table capturing a genuine compliance step of registration (matching the two consent checkboxes seen on `RegisterPage`). It can be shown as a secondary store on Event 1 if the thesis wants to depict legal-consent capture explicitly; otherwise it is safe to omit as a supporting compliance detail, since `profiles` already represents "the account was created."

---

### Table: legal_documents

THESIS DATA STORE NAME:
*(not recommended)*

PURPOSE:
Version metadata for the Terms of Service and Privacy Policy documents themselves (which version is "current," when it took effect).

MAIN DATA STORED:
- document_type, version, url_path, effective_at, published_at, is_current

READ BY / WRITTEN BY:
- Legal document publication tooling (not a customer- or admin-workflow page)

RELATED EVENTS:
- None of the 15 listed events directly

SHOW IN EVENT LIST DIAGRAM:
NO

REASON:
Purely a content-versioning detail behind the `/terms` and `/privacy` static pages — not part of any of the 15 business events.

---

### Table: user_device_tokens

THESIS DATA STORE NAME:
*(not recommended)*

PURPOSE:
Stores each device's push-notification token (Firebase Cloud Messaging or Web Push) for a user.

MAIN DATA STORED:
- user_id, token, device_id

READ BY / WRITTEN BY:
- Push notification registration/delivery (`push-notifications.js`, `send-push` Edge Function)

RELATED EVENTS:
- None directly — supports the notification side-effect of several events

SHOW IN EVENT LIST DIAGRAM:
NO

REASON:
Pure push-delivery infrastructure (device identity), not a business record.

---

### Table: notification_delivery_attempts

THESIS DATA STORE NAME:
*(not recommended)*

PURPOSE:
A log of each individual push-delivery attempt (success/failure/skipped) for a notification.

READ BY / WRITTEN BY:
- `send-push` Edge Function

RELATED EVENTS:
- None directly

SHOW IN EVENT LIST DIAGRAM:
NO

REASON:
Delivery/transport logging — an implementation detail of the push system, not a business process output.

---

### Table: notification_delivery_jobs

THESIS DATA STORE NAME:
*(not recommended)*

PURPOSE:
A job queue for the push-delivery system (newer table, added after the schema.sql snapshot).

READ BY / WRITTEN BY:
- Push delivery Edge Functions

RELATED EVENTS:
- None directly

SHOW IN EVENT LIST DIAGRAM:
NO

REASON:
Infrastructure queueing detail, same category as `notification_delivery_attempts`.

---

### Table: email_usage_logs

THESIS DATA STORE NAME:
*(not recommended)*

PURPOSE:
A local counter of email batches the app has dispatched through Resend, used only for the admin Email Service monitoring page.

READ BY / WRITTEN BY:
- `process-daily-reminders` / `broadcast-announcement` Edge Functions (write); `EmailServiceTab.jsx` (read, via `get_email_usage_summary()`)

RELATED EVENTS:
- None of the 15 listed events directly (it is an operations/monitoring feature, not a customer- or admin-workflow business event)

SHOW IN EVENT LIST DIAGRAM:
NO

REASON:
Purely an internal usage counter for a third-party service quota — not a business record a Chapter 2 event produces or consumes.

---

### Table: email_activity_log

THESIS DATA STORE NAME:
*(not recommended)*

PURPOSE:
A per-recipient log of individual emails sent (payment reminders, announcements) and whether each succeeded.

READ BY / WRITTEN BY:
- Same Edge Functions as above (write); `EmailServiceTab.jsx` (read)

RELATED EVENTS:
- None of the 15 listed events directly

SHOW IN EVENT LIST DIAGRAM:
NO

REASON:
Same reasoning as `email_usage_logs` — an operational delivery log, not a business data store.

---

### Table: photo_storage_events / photo_storage_settings / photo_cleanup_queue

THESIS DATA STORE NAME:
*(not recommended, all three)*

PURPOSE:
Photo-storage monitoring event log, the admin's storage-routing preference, and a queue of files scheduled for cleanup — all part of the admin "Storage Monitoring" ops page, unrelated to any of the 15 listed events.

SHOW IN EVENT LIST DIAGRAM:
NO

REASON:
Pure backend/infrastructure monitoring, already confirmed in a prior audit of that page as intentionally kept out of business-facing workflows.

---

### auth.users (Supabase-managed, not in the `public` schema)

THESIS DATA STORE NAME:
*(not recommended)*

PURPOSE:
Supabase Auth's own internal table — holds the login credential (hashed password), session tokens, and email confirmation state.

SHOW IN EVENT LIST DIAGRAM:
NO

REASON:
This is Supabase's authentication infrastructure, not an application-level business table. `profiles` is the actual, application-owned record of "who is this person" and is the correct thesis data store for Event 1. `auth.users` should be omitted exactly as an internal-auth-table implementation detail, the same way a thesis would not diagram a framework's session-cookie storage.

---

## 3. Classification Summary

**A. PRIMARY BUSINESS DATA STORE** (10): `profiles`, `orders`, `trips`, `payment_transactions`, `customer_feedback`, `company_information`, `announcements`, `conversations`, `chat_messages`, `contact_inquiries`

**B. SUPPORTING BUSINESS DATA STORE** (4): `order_status_events`, `notifications`, `activity_logs`, `legal_consents`

**C. TECHNICAL / IMPLEMENTATION DETAIL** (11, to omit): `payment_attempts`, `legal_documents`, `user_device_tokens`, `notification_delivery_attempts`, `notification_delivery_jobs`, `email_usage_logs`, `email_activity_log`, `photo_storage_events`, `photo_storage_settings`, `photo_cleanup_queue`, `auth.users`

---

## 4. Event-by-Event Data Store Mapping

### EVENT 1 — Customer Registration
PRIMARY ACTOR: Visitor (registering as a new Customer)
PRIMARY DATA STORE: profiles
SECONDARY DATA STORES: legal_consents (optional — Terms/Privacy acceptance)
READS: none (new account)
WRITES: profiles (name, email, phone, address, role='customer'); legal_consents (ToS/Privacy acceptance record)
RECOMMENDED THESIS DATA STORE LABEL: profiles_db
DO NOT SHOW: auth.users (Supabase Auth's internal credential store — the account's business identity is `profiles`, not this)
EXPLANATION: The registration form's real business output — name, contact info, address, role — lands in `profiles`. Supabase Auth's own `auth.users` handles only the password/session mechanics and is correctly treated as infrastructure, not a Chapter 2 data store.

### EVENT 2 — Cargo Booking
PRIMARY ACTOR: Registered Customer (or Administrator, for a walk-in booking)
PRIMARY DATA STORE: orders
SECONDARY DATA STORES: trips (read-only — for route/rate/capacity context; written to only if the customer selects a specific scheduled trip, which then also updates that order's own trip_id in orders)
READS: trips (available routes, rates, remaining capacity)
WRITES: orders (new booking row — tracking number, sender/receiver/cargo details, initial status)
RECOMMENDED THESIS DATA STORE LABEL: orders_db (+ trips_db as secondary)
DO NOT SHOW: none needed beyond the standard omission list
EXPLANATION: `orders` is unambiguously where a booking is stored. `trips` is read for context and, in the "book directly onto a scheduled trip" path, receives no write itself — the order stores its own `trip_id`.

### EVENT 3 — Shipment Tracking
PRIMARY ACTOR: Registered Customer / Public Visitor
PRIMARY DATA STORE: orders
SECONDARY DATA STORES: order_status_events (the actual source of the status timeline shown)
READS: orders (current status, route, weight, dates); order_status_events (full status history with timestamps)
WRITES: none (tracking is read-only)
RECOMMENDED THESIS DATA STORE LABEL: orders_db + order_status_events_db
DO NOT SHOW: none
EXPLANATION: `orders` alone would only show the *current* status; the visible timeline (each past status with its timestamp) is verified to come from `order_status_events`. Both belong on this diagram for an accurate representation.

### EVENT 4 — Trip Scheduling and Cargo Assignment
PRIMARY ACTOR: Administrator
PRIMARY DATA STORE: trips
SECONDARY DATA STORES: orders (assignment writes trip_id + status='Assigned' onto matching orders)
READS: orders (pending, unassigned bookings on the matching route, for auto-assignment)
WRITES: trips (new trip, or status/date changes); orders (trip_id + status, for both automatic and manual assignment)
RECOMMENDED THESIS DATA STORE LABEL: trips_db + orders_db
DO NOT SHOW: none
EXPLANATION: Confirmed — trip scheduling is genuinely a two-store event: the trip itself, and the orders that get attached to it (including an automatic assignment sweep at trip-creation time).

### EVENT 5 — Cargo Pickup and Weighing
PRIMARY ACTOR: Administrator
PRIMARY DATA STORE: orders
SECONDARY DATA STORES: payment_transactions (only if a payment is collected at this step — sender-pays "Freight Prepaid" orders)
READS: orders (assigned booking to be picked up)
WRITES: orders (actual_weight, shipping_cost, payer_type, pickup_photos, status='Picked Up'); payment_transactions (only if money is collected now)
RECOMMENDED THESIS DATA STORE LABEL: orders_db (+ payment_transactions_db shown only for the Prepaid path)
DO NOT SHOW: payment_attempts (PayMongo checkout-in-progress bridge table — irrelevant unless the pickup payment happens to be GCash, and even then only its *result* lands in payment_transactions)
EXPLANATION: `actual_weight`, `shipping_cost`, `pickup_photos`, and `payer_type` are all confirmed columns on `orders` itself — no separate table is needed for the weighing part of this event. Payment only enters the picture conditionally, exactly as the question anticipated.

### EVENT 6 — Payment Recording and Monitoring
PRIMARY ACTOR: Administrator (recording) / Registered Customer (viewing history, or paying via GCash)
PRIMARY DATA STORE: payment_transactions
SECONDARY DATA STORES: orders (the running payment summary — amount_paid, remaining_balance, payment_status — which are database-derived FROM payment_transactions, not independently entered)
READS: payment_transactions (payment history); orders (current balance)
WRITES: payment_transactions (every recorded payment — cash, GCash, additional/counter payments); orders (summary fields, updated automatically by a database trigger reacting to payment_transactions writes)
RECOMMENDED THESIS DATA STORE LABEL: payment_transactions_db + orders_db
DO NOT SHOW: payment_attempts — confirmed to be PayMongo/GCash integration plumbing (an in-progress checkout's source/status before it clears), not the finalized payment record. It is genuinely too technical for a thesis-level diagram; the business event "a payment was recorded" is fully and correctly represented by `payment_transactions`.
EXPLANATION: This is the clearest possible example of a real business ledger (`payment_transactions`) versus a technical bridge table (`payment_attempts`) that exists only to make an online-payment provider's asynchronous confirmation work.

### EVENT 7 — Shipment Status Monitoring and Updates
PRIMARY ACTOR: Administrator
PRIMARY DATA STORE: orders
SECONDARY DATA STORES: order_status_events (the resulting history); trips (read-only context — a trip's own status change is what cascades several orders to "In Transit"/"Arrived at Hub" at once)
READS: orders; trips (to know if a status change is being driven by the trip itself)
WRITES: orders (status field); order_status_events (automatic, via trigger)
RECOMMENDED THESIS DATA STORE LABEL: orders_db + order_status_events_db
DO NOT SHOW: none
EXPLANATION: Confirmed — `trips` is read-only context here (an admin changing a trip's status is really Event 4/8's concern), while the actual status field being monitored and changed lives on `orders`, with `order_status_events` as its automatically-recorded history.

### EVENT 8 — Cargo Delivery and Completion
PRIMARY ACTOR: Administrator
PRIMARY DATA STORE: orders
SECONDARY DATA STORES: payment_transactions (if a remaining balance is collected at the door)
READS: orders (order awaiting delivery, its remaining balance)
WRITES: orders (delivery_photos, status='Delivered'); payment_transactions (if money is collected)
RECOMMENDED THESIS DATA STORE LABEL: orders_db + payment_transactions_db
DO NOT SHOW: none beyond the standard omission list
EXPLANATION: `delivery_photos`, the 'Delivered' status, and the remaining-balance figure are all confirmed columns on `orders`; any payment collected at this step is confirmed to land in `payment_transactions`, exactly mirroring Event 5's structure.

### EVENT 9 — Cancellation Request and Review
PRIMARY ACTOR: Registered Customer (request) / Administrator (review)
PRIMARY DATA STORE: orders
SECONDARY DATA STORES: none
READS: orders (the order being cancelled)
WRITES: orders (status='Pending Cancellation', then 'Cancelled' or reverted; cancellation_details JSONB column holding reason/requested_at/reviewed_by/previous_status)
RECOMMENDED THESIS DATA STORE LABEL: orders_db
DO NOT SHOW: none — there is no separate cancellation table
EXPLANATION: Confirmed directly from the schema: `cancellation_details` is a JSONB column on `orders` itself. An earlier, separate set of cancellation columns existed briefly and was consolidated into this one JSONB column — there has never been, and is not now, a standalone cancellations table.

### EVENT 10 — Customer Feedback Submission
PRIMARY ACTOR: Registered Customer
PRIMARY DATA STORE: customer_feedback
SECONDARY DATA STORES: orders (read-only — confirms the order is Delivered and not already reviewed)
READS: orders (delivery status check)
WRITES: customer_feedback (rating, message)
RECOMMENDED THESIS DATA STORE LABEL: customer_feedback_db
DO NOT SHOW: none
EXPLANATION: Confirmed — a dedicated table exists for exactly this purpose.

### EVENT 11 — Viewing Customer Records
PRIMARY ACTOR: Administrator
PRIMARY DATA STORE: profiles
SECONDARY DATA STORES: orders (order history and lifetime spend shown on the same screen)
READS: profiles (customer identity/contact); orders (that customer's bookings)
WRITES: none (view-only; confirmed no edit/deactivate action exists on this screen)
RECOMMENDED THESIS DATA STORE LABEL: profiles_db + orders_db
DO NOT SHOW: none
EXPLANATION: Confirmed directly from `getCustomerById()` — it queries `profiles` for the account and `orders` for that customer's history in the same call.

### EVENT 12 — Generating Reports
PRIMARY ACTOR: Administrator
PRIMARY DATA STORE: orders
SECONDARY DATA STORES: payment_transactions (sales/collections breakdown by payment method)
READS: orders (filtered by date range/status, for the Reports and Sales tabs); payment_transactions (to correctly split collections by the method actually used per payment, since an order's own payment_method field only reflects its most recent payment event)
WRITES: none (reports are read-only)
RECOMMENDED THESIS DATA STORE LABEL: orders_db + payment_transactions_db
DO NOT SHOW: none
EXPLANATION: Confirmed directly from `getReportData()` (reads `orders` joined to `profiles`) and `getSalesData()` (reads `orders`, then `payment_transactions` for an accurate per-method breakdown). No separate "reports" table exists — reports are always computed on demand from these two.

### EVENT 13 — Managing Company Information and Coverage Areas
PRIMARY ACTOR: Administrator
PRIMARY DATA STORE: company_information
SECONDARY DATA STORES: none
READS: company_information
WRITES: company_information (including its `coverage` and `features` JSONB columns)
RECOMMENDED THESIS DATA STORE LABEL: company_information_db
DO NOT SHOW: none — there is no separate coverage table to omit; it was already consolidated
EXPLANATION: Confirmed directly from the schema — `coverage` and `features` are JSONB columns on this single table, not separate tables. One data store fully and correctly represents this event.

### EVENT 14 — Publishing Announcements
PRIMARY ACTOR: Administrator
PRIMARY DATA STORE: announcements
SECONDARY DATA STORES: notifications (one row created per customer, as the direct, visible outcome of publishing)
READS: none (new announcement)
WRITES: announcements (the announcement itself); notifications (fan-out to every customer)
RECOMMENDED THESIS DATA STORE LABEL: announcements_db (+ notifications_db as secondary)
DO NOT SHOW: none
EXPLANATION: Unlike most other events, `notifications` is genuinely worth showing here — "the customer is notified" is not an incidental side effect but the actual point of publishing an announcement, and it is a real, confirmed write (`createNotification()` called once per customer inside `createAnnouncement()`).

### EVENT 15 — Customer Support and Inbox Management
PRIMARY ACTOR: Registered Customer (chat) and Public Visitor (contact form), reviewed by Administrator
PRIMARY DATA STORE: conversations + chat_messages
SECONDARY DATA STORES: contact_inquiries (a separate, parallel public-facing flow that also ends up reviewed by the administrator)
READS: conversations, chat_messages, contact_inquiries
WRITES: conversations (thread state), chat_messages (message content), contact_inquiries (public contact-form submissions)
RECOMMENDED THESIS DATA STORE LABEL: conversations_db + chat_messages_db (+ contact_inquiries_db as a parallel secondary flow)
DO NOT SHOW: none
EXPLANATION: Confirmed these are genuinely two separate, non-merged systems in the actual implementation — different actor (logged-in customer vs. anonymous visitor), different table, different Edge Function/insert path. They should be drawn as two parallel Actor→Process→Store lines feeding the same Administrator review activity, rather than forced into a single line. See Step 5, Question 15 for the recommended diagram treatment in more detail.

---

## 5. Answers to the Specific Table-Mapping Questions

**1. Customer Registration** — Yes, `profiles` is the correct thesis data store. Yes, `auth.users` should be omitted — it is Supabase's own authentication infrastructure (password hash, session tokens), not an application-level business table. `legal_consents` may optionally appear as a secondary store if the thesis wants to depict ToS/Privacy acceptance explicitly.

**2. Cargo Booking** — Yes, `orders` is the main data store. `trips` can be omitted at thesis level *if* the diagram is meant to show only the act of booking in isolation, but it is more accurate to include it as a secondary (read-only) store, since the booking form reads live trip/route/rate/capacity data from it.

**3. Shipment Tracking** — The better representation is **orders + order_status_events**, not orders alone. Verified directly: the visible tracking timeline (each status with its own timestamp) is generated from `order_status_events`, not read off the single current-status field on `orders`.

**4. Trip Scheduling and Cargo Assignment** — Confirmed: **trips + orders**. Both are written to (a new/updated trip, and the orders that get attached to it, including an automatic assignment sweep).

**5. Cargo Pickup and Weighing** — `actual_weight`, `shipping_cost`, `pickup_photos`, and `payer_type` are all confirmed columns directly on `orders` — no other table is needed for the weighing itself. Yes, `payment_transactions` should appear only conditionally/secondarily, and only for the "payment collected at pickup" (Freight Prepaid) path — for "Freight Collect" bookings, no payment table is touched at this step at all.

**6. Payment Recording and Monitoring** — `payment_transactions` is the actual, finalized ledger of money collected. `orders` holds a running summary (amount_paid, remaining_balance, payment_status) that is database-derived from that ledger, not independently entered. Yes, `payment_attempts` is too technical for the thesis diagram — it is PayMongo/GCash checkout-in-progress bookkeeping, not a business record of a completed payment.

**7. Shipment Status Monitoring and Updates** — Confirmed: **orders + order_status_events** are the correct stores. Yes, `trips` is read-only context here — its own status transitions are what cascade several orders' statuses at once, but the event itself is about the order's status field and history.

**8. Cargo Delivery and Completion** — `delivery_photos`, the 'Delivered' status, and `remaining_balance` are all columns on `orders`. Any payment collected at the door is recorded in `payment_transactions`. Both stores should appear, exactly mirroring the Pickup event's structure.

**9. Cancellation Request and Review** — Confirmed: cancellation is stored entirely inside `orders.cancellation_details` (a JSONB column holding reason, requested_at, reviewed_by, review_notes, previous_status). There is no separate cancellations table; one existed briefly as individual columns and was consolidated into this JSONB column.

**10. Customer Feedback** — Confirmed: `customer_feedback` is a dedicated table for exactly this purpose.

**11. Viewing Customer Records** — Confirmed: **profiles + orders**, verified directly from `getCustomerById()`, which queries both in the same call.

**12. Reports** — Confirmed source: `orders` (via `getReportData()`, joined to `profiles` for display) and, for the Sales breakdown specifically, `payment_transactions` as well (via `getSalesData()`/`get_sales_summary()`). No dedicated "reports" table exists anywhere — every report is computed live from these two.

**13. Company Information and Coverage Areas** — Confirmed: `company_information` alone, including its `coverage` and `features` JSONB columns. The coverage data used to live in separate `coverage_regions`/`coverage_municipalities` tables; those were dropped and consolidated into this single table.

**14. Announcements** — Confirmed: `announcements`. `notifications` should be **shown**, not omitted, for this specific event — unlike most other events, the customer being notified is the direct, visible business outcome of publishing an announcement, and it is a real, confirmed write triggered by the same action.

**15. Customer Support** — Confirmed: `conversations` + `chat_messages` for the authenticated support-chat system. `contact_inquiries` should be represented as a **parallel secondary flow within the same Event 15**, not a 16th event and not omitted — it is a genuinely separate table and actor (anonymous public visitor) from the authenticated chat system, but both are reviewed by the same Administrator inbox-management activity described by this event.

---

## 6. Plain-English Data Store Descriptions

**profiles_db**
"Stores every registered customer and administrator account — name, contact details, address, and role."

**orders_db**
"Stores cargo booking details, sender and receiver information, trip assignment, weight, shipping cost, payment summary, shipment status, pickup photos, delivery photos, and cancellation details."

**trips_db**
"Stores scheduled cargo trips, route, departure date, capacity, shipping rate, and trip status."

**order_status_events_db**
"Stores a timestamped history of every status a shipment has passed through, used to display the tracking timeline."

**payment_transactions_db**
"Stores finalized payment records for cargo orders, including amount, payment method, transaction reference, status, and receipt information."

**customer_feedback_db**
"Stores a customer's star rating and written feedback for one completed delivery."

**company_information_db**
"Stores the company's public profile, contact details, default shipping rate, feature list, and service coverage areas."

**announcements_db**
"Stores news and notices published by the company to its customers, including whether each was also sent by email."

**conversations_db**
"Stores the current state of each customer's support conversation — whether it is being handled automatically, waiting for a staff reply, or resolved."

**chat_messages_db**
"Stores every individual message exchanged in a customer support conversation."

**contact_inquiries_db**
"Stores messages submitted through the public contact form by visitors who have not created an account."

**notifications_db** *(secondary use only)*
"Stores in-app notifications sent to a customer or administrator about an order, trip, or announcement."

**legal_consents_db** *(optional use only)*
"Stores a record that a specific user accepted a specific version of the Terms of Service or Privacy Policy."

---

## 7. Final Recommended Data Store Set

**A. DATA STORES TO USE IN CHAPTER 2 EVENT DIAGRAMS**
- profiles_db
- orders_db
- trips_db
- order_status_events_db
- payment_transactions_db
- customer_feedback_db
- company_information_db
- announcements_db
- conversations_db
- chat_messages_db
- contact_inquiries_db
- notifications_db *(Event 14 only; optional elsewhere)*
- legal_consents_db *(Event 1 only, optional)*

**B. TABLES TO OMIT FROM CHAPTER 2 EVENT DIAGRAMS**
- auth.users (Supabase Auth's own credential/session table)
- payment_attempts (PayMongo/GCash checkout-in-progress bridge table)
- legal_documents (Terms/Privacy version metadata, not a workflow event)
- user_device_tokens (push-notification device registration)
- notification_delivery_attempts (push-delivery attempt log)
- notification_delivery_jobs (push-delivery job queue)
- email_usage_logs (internal Resend usage counter)
- email_activity_log (internal per-recipient email send log)
- photo_storage_events (photo-storage monitoring event log)
- photo_storage_settings (admin photo-routing preference)
- photo_cleanup_queue (scheduled photo-deletion queue)
- activity_logs (cross-cutting admin audit trail — recommended only if a dedicated "Viewing Activity Logs" event is added; otherwise omit from all 15 to avoid repeating it on every diagram)

---

## 8. Master Event → Data Store Mapping Table

| Event No. | Event Name | Actor | Primary Data Store | Secondary Data Store(s) | Recommended Diagram Label |
|---|---|---|---|---|---|
| 1 | Customer Registration | Visitor (new Customer) | profiles | legal_consents *(optional)* | profiles_db |
| 2 | Cargo Booking | Registered Customer / Administrator (walk-in) | orders | trips *(read-only context)* | orders_db + trips_db |
| 3 | Shipment Tracking | Registered Customer / Public Visitor | orders | order_status_events | orders_db + order_status_events_db |
| 4 | Trip Scheduling and Cargo Assignment | Administrator | trips | orders | trips_db + orders_db |
| 5 | Cargo Pickup and Weighing | Administrator | orders | payment_transactions *(Prepaid only)* | orders_db (+ payment_transactions_db) |
| 6 | Payment Recording and Monitoring | Administrator / Registered Customer | payment_transactions | orders | payment_transactions_db + orders_db |
| 7 | Shipment Status Monitoring and Updates | Administrator | orders | order_status_events, trips *(context)* | orders_db + order_status_events_db |
| 8 | Cargo Delivery and Completion | Administrator | orders | payment_transactions *(if balance collected)* | orders_db + payment_transactions_db |
| 9 | Cancellation Request and Review | Registered Customer / Administrator | orders | — | orders_db |
| 10 | Customer Feedback Submission | Registered Customer | customer_feedback | orders *(read-only check)* | customer_feedback_db |
| 11 | Viewing Customer Records | Administrator | profiles | orders | profiles_db + orders_db |
| 12 | Generating Reports | Administrator | orders | payment_transactions | orders_db + payment_transactions_db |
| 13 | Managing Company Information and Coverage Areas | Administrator | company_information | — | company_information_db |
| 14 | Publishing Announcements | Administrator | announcements | notifications | announcements_db + notifications_db |
| 15 | Customer Support and Inbox Management | Registered Customer / Public Visitor / Administrator | conversations + chat_messages | contact_inquiries *(parallel flow)* | conversations_db + chat_messages_db (+ contact_inquiries_db) |

---

*End of guide. No source code, migrations, Supabase data, or Chapter 2 files were modified in the preparation of this report.*
