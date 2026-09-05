# CargoExpress PH Proposed System Workflow Audit

**Scan date:** 2026-09-05
**Method:** Direct source-code inspection (READ-ONLY), performed by six independent parallel research passes over the codebase (customer journey, admin/trip/pickup workflow, payments, status-lifecycle schema, tracking/notifications/support, reports/activity logs), cross-checked against one another and against direct spot-checks of the source during synthesis. No files were modified. No database records were created, changed, or deleted.

---

## 1. Scope and Source of Truth

### 1.1 Critical correction to the assignment brief

The audit request describes the target system as a **PHP** application ("root PHP/pages," "PHP, AJAX, JavaScript, database schema"). That description does not match the current implementation.

The actual current codebase in this project root is:

| Layer | Technology (confirmed from source) |
|---|---|
| Frontend | React 19 + React Router 7, built with Vite (`src/pages`, `src/components`, `src/App.jsx`) |
| Backend / database | Supabase (hosted PostgreSQL, Row-Level Security, RPC functions, realtime) — no custom PHP backend exists anywhere in the tree |
| Serverless functions | Supabase Edge Functions written in TypeScript/Deno (`supabase/functions/*`) — the closest equivalent to "AJAX/API endpoints" |
| Push notifications | Firebase Cloud Messaging (`src/lib/firebase.js`, `firebase-messaging.js`) |
| Online payment gateway | PayMongo (GCash) — REST API calls from the client plus two Edge Functions |
| Database schema/history | 125 SQL migration files under `supabase/migrations/` |

There is no `.php` file anywhere in the project. Every workflow described below is therefore described in terms of React pages, Supabase tables/RPCs, and Edge Functions — the real implementation — not PHP pages. This substitution should be reflected in Chapter 2's technical description of the proposed system (tech stack), separate from the operational narrative, which is stack-agnostic and remains accurate as written below.

### 1.2 Files inspected

Primary source of truth, read directly (not inferred from docs):
- `src/App.jsx` — full route table and role guards
- `src/contexts/AuthContext.jsx` — registration/login/session logic
- `src/pages/auth/*`, `src/pages/customer/*`, `src/pages/admin/*`, `src/pages/public/*`, `src/pages/shared/*`
- `src/lib/database.js` (~3,200 lines — the single data-access layer for the whole app), `src/lib/paymongo.js`, `src/lib/supportChatEngine.js`, `src/lib/activityLog.js`, `src/lib/bookingDraft.js`
- `src/constants/status.js` (canonical status enums and transition rules)
- `src/components/ui/PickupModal.jsx`, `DeliveryModal.jsx`, `PaymentCollectionPanel.jsx`, `TripAssignModal.jsx`, `AssignCustomerModal.jsx`, `CancelBookingModal.jsx`
- `supabase/functions/paymongo-create-payment/index.ts`, `paymongo-webhook/index.ts`, `submit-inquiry/index.ts`, `broadcast-announcement/index.ts`
- Selected `supabase/migrations/*.sql` referenced by inline code comments (constraint names, trigger names)

Existing documentation (`docs/*.md`, `README.md`) was **not** used as the source of facts — it was only used, where present, to locate relevant source files faster. Every claim below is backed by a specific file read during this session.

### 1.3 No Chapter 2 manuscript found

A search of the entire project (`find . -iname "*chapter*"`, `*thesis*`, `*manuscript*`, `*.docx`, `*.pdf`) found **no thesis manuscript, Chapter 2 document, diagram file, or PDF** anywhere in the repository or its history folders. Section 18 (Chapter 2 Mismatches) is therefore based on the general, well-known drift between a PHP-based System Rules/Context Diagram description and the actual React+Supabase implementation, not a line-by-line comparison against a specific manuscript. If the Chapter 2 file is provided later, this section should be redone against it directly.

---

## 2. Confirmed System Actors

Confirmed from `src/App.jsx` route guards (`ProtectedRoute`, `AuthRoute`, `RootRedirect`) and `AuthContext.jsx`:

| Actor | Confirmed from code | Role value |
|---|---|---|
| **Visitor / Public user** (not logged in) | Routes `/track`, `/about`, `/terms`, `/privacy`, `/schedules`, `/faq` render with no auth check | none |
| **Registered Customer** | `profiles.role = 'customer'`; gates every `/customer/*` route | `customer` |
| **Administrator** | `profiles.role = 'admin'`; gates every `/admin/*` route | `admin` |

There is **no separate "staff/driver" role, "cashier" role, or "super-admin" role** anywhere in the route guards, the `profiles` table usage, or the RLS-related code comments encountered. Only two account roles exist: `customer` and `admin`. A `profiles` row with no role, or a role not equal to `admin`/`customer`, is treated as unusable and redirected to `/login` (`App.jsx` `ProtectedRoute`/`RootRedirect`).

**Walk-in / guest bookings** are not a third actor with its own login — they are orders created by an **admin**, recorded under the **admin's own `user_id`**, and later optionally re-linked to a real customer account (`AssignCustomerModal.jsx`, `assignOrderToCustomer()` in `database.js`). This is documented explicitly in the component's own comment: *"AdminCreateBookingPage inserts a walk-in booking under the ADMIN's own account, on purpose, so a customer who doesn't want to register still gets a trackable order."*

---

## 3. Complete Customer Journey

Traced from `src/App.jsx`, `AuthContext.jsx`, `BookShipmentPage.jsx`, `OrdersPage.jsx`, `OrderDetailPage.jsx`.

1. **Visitor lands on the public site.** No route requires login for `/track`, `/about`, `/schedules` (trip list), `/faq`, `/terms`, `/privacy`.
2. **Registration** (`/register`, `RegisterPage.jsx`) — a two-step form:
   - Step 1 — Personal Information: Full Name, Facebook Name, Email, Password (+ confirm), phone.
   - Step 2 — Address fields (lot/block, street, barangay, city, province, landmark) and mandatory Terms of Service + Privacy Policy consent checkboxes (`legal_consent.termsAccepted`, `legal_consent.privacyAccepted`, tied to a versioned `LEGAL_DOCUMENT_VERSION`).
   - On submit, `AuthContext.register()` calls `supabase.auth.signUp()`, then separately upserts a full `profiles` row (`createProfile()`), and finally fetches that profile back. A database trigger (`handle_new_user()` / `on_auth_user_created`, referenced in code comments) also inserts a minimal `profiles` row atomically with the auth user, so the account is always usable even if the detailed profile upsert fails (the code retries once, then tells the customer to complete their profile later).
3. **Login** (`/login`, `LoginPage.jsx`) — `supabase.auth.signInWithPassword()`; on success `AuthContext` fetches the `profiles` row and `ProtectedRoute`/`RootRedirect` sends the user to `/customer` or `/admin` based on `profiles.role`.
4. **Customer home** (`/customer`, `HomePage.jsx`) is the landing screen after login.
5. **Viewing trip schedules** — `/customer/trips` and the public `/schedules` both render `TripsPage.jsx`, listing trips fetched via `getTrips('active')` (only `status = 'scheduled'` trips whose PH-calendar departure day has not passed).
6. **Booking a shipment** (`/customer/book`, requires the `customer` role — `BookShipmentPage.jsx`) is a **5-step wizard**, persisted to `sessionStorage` so it survives a refresh:
   - **Step 1 — Route.** The customer picks one of the fixed routes defined in `ROUTES` (Bohol ⇄ Manila-area provinces only — the coverage banner states *"CargoExpress PH currently operates routes to and from Bohol only"*). Optionally selects a specific scheduled trip on that route; the trip's remaining capacity and per-kg rate are shown.
   - **Step 2 — Sender Details.** Full name, mobile number, Facebook name, and a full PH address (province → city → barangay → street → lot/block → landmark), each required. A checkbox can auto-fill this from the customer's own registered profile address when the customer's own province matches the route's expected pickup side. An "Other Area" province is only allowed when the route destination is Bohol, and triggers a `service_area_status = 'for_review'` / `status = 'Pending Review'` booking instead of a normal one.
   - **Step 3 — Receiver Details.** Same address structure for the receiver, plus server/client cross-validation that sender and receiver provinces are on the correct sides of the selected route.
   - **Step 4 — Package Details.** A free-text package description (required), "Who Pays?" (Sender/Receiver), an optional "Payment Preference" (Cash / GCash / "I'll decide later"), and optional special instructions. **No weight and no cost are entered by the customer** — the screen states *"We weigh the parcel at pickup and the exact cost is confirmed then."*
   - **Step 5 — Review & Confirm.** Read-only summary of route, sender, receiver, and the applicable ₱/kg rate, then a single "Confirm Booking" submit.
7. **Booking submission** — `handleSubmit()` calls `createOrder()` in `src/lib/database.js`. This function:
   - Generates the tracking number **client-side**, in the browser, with the pattern `CE-YYYYMMDD-####` (`generateTrackingNumber()`), not via a database trigger or sequence.
   - If a specific trip was chosen, verifies the trip still exists, checks it is not already over its capacity ceiling (`assertTripCapacity`), and sets the order's initial `status` to `'Assigned'` with that `trip_id`.
   - If no specific trip was chosen, sets `status` to `'Pending'` with `trip_id = null`.
   - If the sender province is "Other Area," overrides both fields to `service_area_status: 'for_review'` and `status: 'Pending Review'` regardless of whether a trip was picked.
   - Inserts the order with `actual_weight: null`, `shipping_cost: 0`, `amount_paid: 0`, `remaining_balance: 0`, `payment_status: 'unpaid'`, `payment_method: null`, empty photo arrays.
   - Fires a non-blocking admin notification ("New Booking").
8. **Booking confirmation screen** displays the generated tracking number (copyable), the route, sender/receiver names, the declared package description, and the initial status ("Pending" or "Assigned"), with the note *"Final cost is confirmed when we weigh your parcel at pickup."*
9. **Post-booking, the customer can:**
   - View all their bookings at `/customer/orders` (`OrdersPage.jsx`), filterable into four coarse groups (Processing / In Transit / Delivered / Cancelled) via `CUSTOMER_ORDER_FILTERS`, with a live Supabase Realtime subscription (`useRealtimeOrders`) so admin-side changes appear without a manual refresh.
   - Open a single booking at `/customer/orders/:id` (`OrderDetailPage.jsx`) to see full details, the status timeline, payment summary, and payment history for that order.
   - **Request cancellation** on a not-yet-in-network order (see Section 9) via a reason-required modal.
   - **Pay an outstanding balance by GCash** directly from the order detail page once the parcel has been weighed and the order is in a payable status (see Section 7).
   - View **Payment History** across all orders at `/customer/payments` (`PaymentHistoryPage.jsx`).
   - View and manage their **Profile** (`/customer/profile`, `/customer/personal-info`), change email/password (`/customer/change-email`, `/customer/change-password`), and view **Notifications** (`/customer/notifications`).
   - Use **Support Chat** (`/customer/support`) — see Section 13.
   - Submit **feedback** (rating + message) on a delivered order from the order detail page, once per order (`checkIfFeedbackExists()` gates a second submission).
   - View static **Help/Guidelines** (`/customer/help-guidelines`, also public at `/faq`) and **About/Version** info.

---

## 4. Complete Administrator Workflow

Traced from `src/pages/admin/*`, `src/components/ui/*Modal.jsx`, and `src/lib/database.js`.

1. **New bookings arrive** in the `orders` table already carrying a generated tracking number, status `Pending`/`Assigned`/`Pending Review`, and a non-blocking notification is created for admin accounts. The **Orders list** (`/admin/orders`, `OrdersPage.jsx`) and **Dashboard** (`/admin`, `DashboardPage.jsx`) surface these.
2. **Reviewing an out-of-coverage booking.** For an order with `service_area_status = 'for_review'` (customer selected "Other Area" pickup), the Order Detail page shows an Approve/Reject panel:
   - Approve → `updateOrder(id, { status: 'Pending', service_area_status: 'approved' })`.
   - Reject → `updateOrder(id, { status: 'Cancelled', service_area_status: 'rejected', service_area_remarks: reason })`.
3. **Admin can create a booking directly** (`/admin/create-booking`, `AdminCreateBookingPage.jsx`) — a walk-in/manual booking form that calls the same `createOrder()` used by the customer flow, but with `user_id` set to the **admin's own account** (there is no separate anonymous "guest" account type). It can later be **linked to a real customer** via `AssignCustomerModal.jsx` → `assignOrderToCustomer()`, which validates the target profile has `role = 'customer'` and that the order is not already linked to one.
4. **Assigning a booking to a trip** (`TripAssignModal.jsx`, reached from the Order Detail page when the next status is "Assigned" and no trip is yet attached) sets `orders.trip_id` and advances `status` to `'Assigned'`.
5. **Processing pickup** (`PickupModal.jsx`, reached when the next status is "Picked Up"): the admin
   - enters the **actual weight from the scale** (required; this is the only weight ever recorded — customers never declare one),
   - chooses **who pays** — Sender ("Freight Prepaid," collected now) or Receiver ("Freight Collect," collected on delivery),
   - if Sender pays, the shared `PaymentCollectionPanel` (Section 7) is used to record Full Payment or Pay Later (partial) in Cash or GCash,
   - attaches 1–3 required pickup-proof photos,
   - submits, which calls `recordPickupPayment()` — a single RPC/transaction that updates order metadata (weight, payer_type, photos) and, if money was collected, inserts a `payment_transactions` ledger row. `amount_paid`/`remaining_balance`/`payment_status` are **never written directly by the client** — they are derived server-side from the ledger.
   - Status becomes `'Picked Up'`.
6. **Creating a trip** (`/admin/trips/create`, `CreateTripPage.jsx`): admin selects a fixed route, departure date (date-only, must not be in the past per Philippine calendar day), optional arrival date, planned capacity (kg, default 1000), price per kg (default ₱70), notes, and an optional "announce via email" toggle. On save (`createTrip()`):
   - a trip number `TRIP-YYYYMMDD-###` is generated client-side,
   - the system **auto-assigns** any existing `Pending` orders whose origin/destination match the new trip and whose cumulative weight fits the trip's capacity, setting their status to `'Assigned'`,
   - if "announce via email" was checked, a bilingual announcement is created and broadcast the same way the Announcements page does.
7. **Trip detail management** (`/admin/trips/:id`, `TripDetailPage.jsx`): admin can **Start Trip** (`status → 'in_progress'`, blocked if another trip is already `in_progress` — `updateTrip()` in `database.js` queries for any other trip with that status before allowing the write and throws `"Another trip (TRIP-...) is already in progress"` if one exists; this is an application-layer check, not a database constraint), **Cancel Trip**, or **Complete Trip**. Starting or marking a trip **Arrived** cascades every attached order's status in one batched update (`bulkUpdateOrdersStatusByTrip()`, itself application-layer — no database trigger performs this cascade) (see Section 8/9). **Completing a trip is blocked** if any non-cancelled order on it still has an outstanding balance (`outstandingBalance(order) > 0`).
8. **Advancing an order past Arrived at Hub → Out for Delivery** is a manual, per-order action on the Order Detail page (not trip-controlled), gated by `canDispatchForDelivery()` (Section 7).
9. **Completing delivery** (`DeliveryModal.jsx`, reached when the next status is "Delivered"): admin attaches delivery-proof photos and, if a balance remains, collects the remaining payment through the same `PaymentCollectionPanel`, capped at the authoritative `remaining_balance`. Saves via `recordDeliveryPayment()`, status becomes `'Delivered'`.
10. **Cancellation handling** — two paths:
    - **Customer-requested**: `review_order_cancellation()` RPC lets the admin Approve (→ `Cancelled`) or Decline (→ reverts to the order's previous status) a request the customer filed.
    - **Admin-initiated force cancellation** (`cancelOrderAsAdmin()`): allowed for any order up to and including "Picked Up," blocked once the shipment is `In Transit` or later ("it has already left for the other island").
11. **Announcements** (`/admin/announcements`, `AnnouncementsPage.jsx`): admin writes a title/content, and `createAnnouncement()` inserts the row, creates an **in-app notification for every customer profile**, sends a **push notification** to all customers, and — only if `send_email` is set — invokes the `broadcast-announcement` Edge Function, which emails only recipients who opted in (`profiles.wants_announcements = true` or `contact_inquiries.wants_announcements = true`), deduplicated by email, via Resend, in batches of 50.
12. **Inbox / support chat** (`/admin/inbox`, `InboxPage.jsx`): admin sees conversations in states `bot_active`, `waiting` (escalated to human), `waiting_customer`, `resolved`; can reply, mark resolved, and search across conversations/customers.
13. **Contact inquiries** (`/admin/contact-inquiries`, `ContactInquiriesPage.jsx`): admin reviews messages submitted by the public through the `AboutPage.jsx` contact form (unauthenticated, IP-rate-limited via the `submit-inquiry` Edge Function).
14. **Customer management** (`/admin/customers`, `/admin/customers/:id`): paginated, searchable directory of `profiles` where `role = 'customer'`; the detail page shows that customer's full order history, counts of completed/pending orders, and total spend (excluding cancelled orders).
15. **Reports** (`/admin/sales`, `/admin/reports`, `SalesReportsPage.jsx`) pull from `get_sales_summary()` and the unsettled-orders query (`getUnsettledOrders()`), which mirror the same `outstandingBalance()` definition used everywhere else in the client, specifically to avoid two screens disagreeing on "how much is owed." A dedicated **Unsettled Deliveries** page (`/admin/... UnsettledDeliveriesPage.jsx`) lists orders with `outstandingBalance > 0`.
16. **Company information** (`/admin/company-info`, `CompanyInformationPage.jsx`): admin edits the default price-per-kg, business features, and coverage-area list stored in a single `company_information` row plus related tables.
17. **Activity Logs** (`/admin/activity-logs`, `ActivityLogsPage.jsx`): a read-only audit trail of actions logged by `src/lib/activityLog.js` — see Section 15.
18. **Profile / storage tools**: `/admin/profile`, `/admin/storage-monitoring` (photo-storage health), `/admin/feedback` (customer feedback list).
19. **Featuring a delivered order publicly**: from a `Delivered` order's detail page, an admin may flag it (with its pickup/delivery photos, a title, and a caption) as a public "featured delivery" success story, which then surfaces through a public feedback/highlights RPC on the public site.
20. **Daily payment-reminder emails**: a scheduled (cron-triggered, not user-initiated) Edge Function, `process-daily-reminders`, runs once daily at 8:00 AM Philippine time. It selects every order with a `remaining_balance > 0` whose `promised_payment_date` has arrived or passed and that has not already been reminded that day, emails each affected customer through the system's transactional-email provider, and logs the attempt. This runs independently of any admin action.

---

## 5. Booking Workflow

(See Section 3, steps 6–8, for the full step-by-step; this section is the condensed state-machine view.)

- **Entry point:** `/customer/book`, customer role required. No unauthenticated/guest booking exists on the customer side — the route is behind `ProtectedRoute`.
- **Inputs collected:** route, optional specific trip, sender identity+address+phone+Facebook name, receiver identity+address+phone+Facebook name, package description, payer type, payment preference (advisory only), notes.
- **Inputs explicitly NOT collected at booking:** weight, cost/price, any payment.
- **Tracking number:** generated in the browser at submit time (`CE-YYYYMMDD-####`), not by the database.
- **Initial status logic** (all client-decided in `createOrder()`):
  - Trip selected → `Assigned`
  - No trip selected → `Pending`
  - Sender province = "Other Area" → always `Pending Review` (overrides the above), with `service_area_status = 'for_review'`
- **Duplicate-submit protection:** a `submittingRef` guard in `BookShipmentPage.jsx` prevents a double network call from a double click.
- **Draft persistence:** the in-progress form and current step are saved to `sessionStorage` (`bookingDraft.js`) once the customer has entered "meaningful" data, and a navigation-blocker modal warns before discarding an in-progress booking.

---

## 6. Pickup, Weight, and Shipping Cost Workflow

- **Weight is captured exactly once**, at pickup, by the admin, from a physical scale, into `orders.actual_weight` (`PickupModal.jsx`). There is no customer-declared weight anywhere in the current implementation (a code comment notes it was deliberately removed: *"the customer-declared estimate was removed"*).
- **Shipping cost formula:** `actual_weight × price_per_kg`, where `price_per_kg` comes from the assigned trip if the trip has a rate set (`trips.price_per_kg`), otherwise from the company-wide default (`company_information.default_price_per_kg`, default ₱70).
- Until weighed, `shipping_cost` is `0` and the order is explicitly treated as **"unpriced"** rather than "paid" (`isOrderPriced()` / `SETTLEMENT_STATE.UNPRICED` in `constants/status.js`) — the code specifically guards against a `₱0` balance being misread as "settled."
- **Trip capacity enforcement:** every path that adds weight to a trip (customer booking onto a trip, admin assigning a booking, admin recording pickup weight) is checked against a hard ceiling of `planned capacity + 200 kg allowance` (`TRIP_CAPACITY_ALLOWANCE_KG`), enforced client-side only — a code comment notes the equivalent database-level trigger was intentionally removed to allow admin judgment/overbooking within the allowance.
- **Who pays is decided at pickup**, not (only) at booking: the admin can accept or change the customer's declared payer preference. Sender-pays ("Freight Prepaid") collects money at pickup; receiver-pays ("Freight Collect") defers all collection to delivery and skips the payment panel entirely at pickup.
- Pickup requires **1–3 proof photos** before it can be confirmed.

---

## 7. Payment Workflow

### 7.1 Payment methods confirmed in code

`PAYMENT_METHODS = ['cash', 'gcash', 'paylater']` and `PAYMENT_STATUSES = ['paid', 'partial', 'unpaid']` (`constants/status.js`). "Paylater" is a payment-method label used at booking-preference level; the actual settlement mechanism for a deferred balance is the **Promise Date** field (`promised_payment_date`), not a distinct payment method row.

### 7.2 Shared collection mechanism

Both the pickup counter and the delivery counter use the **same** `PaymentCollectionPanel` component (`src/components/ui/PaymentCollectionPanel.jsx`) — the code comments explicitly call this out: *"Pickup collects from the sender against the freight total; delivery collects from the receiver against the remaining balance. Those are the same act against a different number."* Differences between the two usages:
- Pickup's expected amount is a **client-side estimate** (not capped — an admin can legitimately collect more or less pending server recomputation).
- Delivery's expected amount is the **authoritative remaining balance** from the database and **is capped** — the admin cannot record collecting more than what is owed.

### 7.3 Confirmed payment sequences

- **Full payment in Cash** — admin selects "Full Payment," "Cash," enters/accepts the full amount, order settles in full at that step.
- **Full payment via GCash (PayMongo)** — admin clicks "Process via PayMongo," which calls `createGCashSource()` (browser → PayMongo REST API directly, using a **public** key only) then `registerSource()` (Supabase Edge Function `paymongo-create-payment`, action `register`, which stores a `payment_attempts` row server-side). A QR code and checkout link are shown; the customer scans/opens it and completes payment in the GCash app. The **secret** PayMongo key never touches the browser — capture happens either via the `paymongo-webhook` Edge Function reacting to PayMongo's `source.chargeable`/`payment.paid` events, or via the admin's "Check payment" button polling `pollPaymentStatus()` → the same Edge Function's `poll` action. Either path calls the `reconcile_paymongo_payment_attempt` database RPC, which is the only writer of the `payment_transactions` ledger and, via trigger, of `orders.amount_paid`/`remaining_balance`/`payment_status`. While unconfirmed, the confirm button is **locked** ("submitLocked") so cargo cannot be released mid-checkout; the admin has an explicit "Cancel payment — pay another way" escape hatch that does **not** void the PayMongo source (a late customer payment still reconciles).
- **Partial payment ("Pay Later")** — admin selects "Pay Later," enters a downpayment amount (optional, can be ₱0), chooses a method, and — if anything remains owing — **must** enter a **Promised Payment Date** before the system will let the pickup/delivery be confirmed. The UI states plainly: *"The cargo may be released, but ₱X remains owing... This order stays unsettled and its trip cannot be completed until it is paid."*
- **Freight Collect (receiver pays)** — no payment step at pickup at all; the full balance is deferred to the delivery counter, where the receiver settles it (fully, partially with a new Promise Date, or fully via GCash) before delivery is marked complete.
- **Customer-initiated GCash payment of an outstanding balance** — from `/customer/orders/:id`, once the order is weighed (`isOrderPriced`), has a positive balance, is not cancelled, and is in a payable status, the customer can trigger the same `initiateGCashPayment()`/PayMongo flow themselves and is redirected to GCash checkout, returning to `/payment/return` for confirmation.
- **Manual GCash reference fallback** — if the checkout is not used or fails, the admin can instead type in a GCash reference number and payment date manually, with an optional receipt-screenshot upload (stored as a photo, referenced from `payment_transactions.receipt_url`). Unlike the automated checkout path, this manually typed reference is **not independently checked against PayMongo's records** — it is accepted on the admin's attestation alone. Verification of payment is therefore **automated for the QR/checkout path** (via webhook or poll against PayMongo's own source status) but **admin-attested only** for the manual-reference and cash paths; there is no separate "pending verification → approved" review queue for either.
- **Automated overdue-balance reminders** — independently of any admin action, a daily scheduled job emails customers whose promised payment date has arrived or passed while a balance remains (see Section 4, item 20).

### 7.4 Dispatch/settlement gating rules (confirmed in `constants/status.js`)

- `isOrderPriced(order)` — true only once `actual_weight > 0`. An unweighed order is never treated as "paid" even though its `₱0` balance would otherwise look settled.
- `outstandingBalance(order) = max(0, shipping_cost − amount_paid)`, computed the same way on every screen (client) to avoid the balance disagreeing between the Orders list, the Order Detail page, and the Sales Reports.
- `canDispatchForDelivery(order)` — blocks moving a **sender-pays** order to "Out for Delivery" while unweighed or while a balance remains **unless** a Promise Date has been recorded. Receiver-pays orders are exempt (payment is due at the door by design).
- Trip **completion** is blocked while any attached, non-cancelled order still has `outstandingBalance > 0`.

---

## 8. Trip Management and Cargo Assignment

| Question | Confirmed answer |
|---|---|
| Who creates a trip? | Admin only, `/admin/trips/create` |
| What is entered? | Route (fixed origin/destination pair), departure date (date-only), optional arrival date, capacity (kg), price per kg, notes, optional email-announcement toggle |
| How do bookings join a trip? | Three ways: (a) customer selects a specific trip while booking, (b) admin manually assigns via `TripAssignModal`, (c) **automatic**: creating a trip auto-assigns any existing unassigned `Pending` orders on the same route that fit within capacity |
| Must cargo be approved before assignment? | Not a separate approval step; `Pending Review` (out-of-coverage) orders must first be Approved by an admin (→`Pending`) before they can be assigned like any other order |
| Does weight affect capacity? | Yes — capacity accounting only counts orders that have been **weighed** (`actual_weight`); an unweighed booking contributes 0 kg toward the ceiling regardless of how many are attached |
| How does trip status change? | Admin actions: Start Trip (`scheduled → in_progress`, only one trip may be `in_progress` system-wide at a time), Mark Arrived (`in_progress → arrived`), Complete Trip (`arrived → completed`, blocked while any order is unsettled), Cancel Trip (`→ cancelled`) |
| What happens to shipments when the trip starts? | Every order on the trip with status `Assigned` or `Picked Up` is bulk-updated to `In Transit` in the same action |
| What happens when the trip arrives? | Every order with status `In Transit` is bulk-updated to `Arrived at Hub` |
| What happens when the trip is cancelled? | Every non-terminal order on the trip is bulk-updated to `Cancelled` |
| Is delivery routing/sequencing implemented? | **NOT FOUND.** No driver-route-ordering, stop-sequencing, or map-based delivery-run feature was found. `Out for Delivery`→`Delivered` is a per-order, per-parcel manual action, not a routed multi-stop run. |
| How does an individual shipment become Delivered? | Admin opens the order, advances to "Out for Delivery" manually (gated by the dispatch rule above), then completes the `DeliveryModal` (photos + remaining payment) to reach `Delivered` |

**Classification:** Trip creation, auto-assignment, capacity enforcement, and the in-progress/arrived/cancelled cascade are **CONFIRMED IMPLEMENTED**. Delivery-route optimization/sequencing is **NOT FOUND**.

---

## 9. Shipment Status Lifecycle

Canonical source: `src/constants/status.js` (`ORDER_STATUS`, `STATUS_FLOW`, `TRIP_STATUS`).

### 9.1 Order statuses (exact strings used in the database/UI)

```
Pending Review → Pending → Assigned → Picked Up → In Transit
→ Arrived at Hub → Out for Delivery → Delivered
```
plus two side-statuses that interrupt the line:
- **Pending Cancellation** — a customer has requested cancellation; the order is frozen (no further status change permitted) until an admin approves (→ `Cancelled`) or declines (→ reverts to whatever status it held before the request).
- **Cancelled** — terminal.

`STATUS_FLOW` is a strict one-step-at-a-time map; the client-side `validateStatusTransition()` refuses any transition that is not the next status in this sequence (mirrored, per code comments, by server-side checks).

### 9.2 What causes each transition

| Status | Set by |
|---|---|
| `Pending Review` | Customer booking with an "Other Area" pickup province |
| `Pending` | Customer booking with no trip selected, OR admin approving a `Pending Review` order |
| `Assigned` | Customer booking directly onto a specific trip, OR admin assigning a trip, OR a new trip's auto-assignment sweep |
| `Picked Up` | Admin completing the Pickup modal (weight + payer + optional payment + photos) |
| `In Transit` | **Trip-cascaded** — every `Assigned`/`Picked Up` order on a trip when the admin starts that trip |
| `Arrived at Hub` | **Trip-cascaded** — every `In Transit` order on a trip when the admin marks that trip arrived |
| `Out for Delivery` | Admin, per order, manual "Advance" action (blocked by the payment-settlement gate for sender-pays orders) |
| `Delivered` | Admin completing the Delivery modal (photos + any remaining payment) |
| `Pending Cancellation` | Customer's "Request Cancellation" action (only available before the order is `Picked Up` or later) |
| `Cancelled` | Admin approving a cancellation request, OR admin force-cancelling directly (only allowed up to `Picked Up`), OR the whole trip being cancelled |

### 9.3 Trip statuses

`scheduled → in_progress → arrived → completed`, with `cancelled` reachable from any non-terminal state. Only one trip may be `in_progress` at a time (enforced client-side before the update).

### 9.4 Payment statuses

`unpaid`, `partial`, `paid` — written **only** by server-side derivation from the `payment_transactions` ledger (never set directly by client code), triggered by `record_pickup_payment`, `record_delivery_payment`, `record_additional_payment`, and `reconcile_paymongo_payment_attempt` RPCs.

### 9.5 Cancellation-request statuses

Not a separate table/enum — represented as the order status `Pending Cancellation` plus a `cancellation_details` JSONB column holding `{reason, requested_at, reviewed_at, reviewed_by, review_notes, previous_status}`.

### 9.6 Chat/inquiry statuses

`bot_active`, `waiting` (escalated, needs a human), `waiting_customer` (admin has replied, waiting on customer), `resolved` — confirmed from `InboxPage.jsx`'s `STATUS_BADGE` map and `CONVERSATION_STATUS` import from `database.js`. The separate `contact_inquiries` table (public contact form, not the authenticated chat) uses its own, simpler set: `new`, `read`, `resolved`.

### 9.7 Other operational status enums (not part of the customer-facing narrative)

Present in the schema but internal/operational only — not customer- or thesis-narrative-relevant, included here for completeness of the system-rules picture: `push_notification_log.status` (`sent`/`failed`/`skipped`), `email_activity_log.status` (`sent`/`failed`), and `payment_reconciliation.status` (`pending`/`chargeable`/`reconciled`/`failed` — the PayMongo-side reconciliation state, distinct from `orders.payment_status`).

---

## 10. Tracking and Customer Updates

- **Public tracking** (`/track`, no login) — `TrackingPage.jsx`. Customer enters a tracking number; the page calls the `track_order_public` RPC (a security-definer function that intentionally does **not** return the order's internal `id`, keeping the public surface minimal). Shows a status timeline (`STATUS_TIMELINE`), current weight/route/dates once available, and **auto-refreshes every 45 seconds** while the tab is focused. Client-side rate-limit handling exists for repeated lookups (`detectRateLimit`).
- **Logged-in customer tracking** — the same `TrackingPage` component is reused inside the authenticated shell at `/customer/track` (`embedded` prop), and the full order detail is available at `/customer/orders/:id` with the same timeline plus payment/status history (`getOrderStatusEvents()`).
- **Status timeline / history** — `TrackingTimeline` component renders `STATUS_TIMELINE` with the order's `timelineStatus()` (falls back to the pre-cancellation status while a cancellation request is pending, so the timeline doesn't blank out).
- **Realtime updates** — `useRealtimeOrders` subscribes to Postgres changes on the `orders` table (RLS-scoped to the customer's own rows) so the Orders list and Order Detail page update live when an admin advances a status or a payment webhook lands, without a manual refresh.
- **Notifications** — in-app (`/customer/notifications`, `getNotifications()`/`markNotificationRead()`) and **push** via Firebase Cloud Messaging (`src/lib/push-notifications.js`, `firebase-messaging.js`, Edge Function `send-push`), triggered non-blockingly alongside most order/announcement/payment events in `database.js`.
- **Announcements** appear both as in-app notifications and, if opted in, as email (see Section 4.11 / Section 12).
- **Support chat and contact form** — see Section 13.

---

## 11. Delivery and Completion Workflow

1. Order reaches `Arrived at Hub` (via trip cascade).
2. Admin manually advances the order to `Out for Delivery` — gated by `canDispatchForDelivery()`: blocked if unweighed, or if sender-pays and a balance remains with no Promise Date recorded; unblocked automatically for receiver-pays orders.
3. Admin opens the **Delivery modal** at the point of hand-off: attaches 1–3 delivery-proof photos, and — if a balance remains — collects payment through the shared `PaymentCollectionPanel`, capped at the exact remaining balance (cash, GCash/PayMongo, or a further Pay-Later with a new Promise Date).
4. `recordDeliveryPayment()` writes the photos and, if money was collected, a `payment_transactions` row; order status becomes `Delivered`.
5. Customer receives an in-app + push notification ("Delivery Complete").
6. Customer may leave **feedback** (rating + free-text message) once per delivered order from the Order Detail page; this creates a non-blocking admin notification and appears in the admin **Feedback** page and the public feedback RPC (`get_public_feedback`).
7. Separately, at the trip level, **Complete Trip** can only be confirmed once every non-cancelled order on that trip has `outstandingBalance ≤ 0` — i.e., trip completion is an operational/administrative closing step distinct from any individual parcel's delivery.

---

## 12. Announcements and Public Information

- **Creation:** Admin-only, `/admin/announcements`.
- **Distribution:** (a) always — a `notifications` row for every `profiles.role='customer'`; (b) always — a push notification broadcast to all customers; (c) optionally — an email broadcast via the `broadcast-announcement` Edge Function, sent only to addresses that opted in (`profiles.wants_announcements` or `contact_inquiries.wants_announcements`), deduplicated, batched through Resend, with a signed per-recipient unsubscribe link (`unsubscribe-announcements` Edge Function).
- **Trip announcements:** creating a trip can optionally auto-generate and broadcast a bilingual (Filipino/English) "new trip" announcement through the exact same path.
- **Public company information:** `AboutPage.jsx` (public, no login) surfaces business information via `get_public_business_profile()`/related public RPCs and hosts the public **contact inquiry form**.

---

## 13. Customer Support / Chat / Chatbot

Two **separate** channels exist:

1. **Authenticated in-app support chat** (`/customer/support`, `SupportChatPage.jsx` + `src/lib/supportChatEngine.js`, ~1,100 lines):
   - A **rule-based, pattern-matching chatbot** ("CargoMate PH") — not a generative/LLM chatbot. It runs entirely client-side against regular expressions and direct, authenticated Supabase queries against the logged-in customer's own orders/payments/trips.
   - Understands English, Tagalog, and Bisaya/Cebuano (mixed freely), matching against a table of `INTENTS` (shipment status, tracking number, payment/balance, modes of payment, booking info, delivery timeline, pricing, coverage area, prohibited items, weight limits, office locations).
   - **Escalation:** a dedicated set of `ESCALATION_PATTERNS` (complaints, damaged/lost/stolen cargo, "still not arrived" complaints, refund requests) causes the bot to skip entirely and hand the conversation to a human admin instead of attempting an automated answer.
   - Escalated or human-requested conversations move to the admin **Inbox** (`/admin/inbox`), with conversation states `bot_active → waiting → waiting_customer → resolved`.
2. **Public contact inquiry form** (unauthenticated, on `AboutPage.jsx`): name, message, optional phone/email, optional "wants announcements" opt-in. Submitted through the `submit-inquiry` Edge Function, which enforces server-side IP-based rate limiting (5 per 15 minutes per IP, 15 global per minute) before inserting into `contact_inquiries` — there is **no RLS insert policy for direct client writes**, making the Edge Function the only path in. Reviewed by admin at `/admin/contact-inquiries`.

These two channels are **not merged** — a public visitor's contact-form message and a logged-in customer's support-chat conversation are different tables/flows, though both eventually surface to the admin for a human reply.

---

## 14. Customer Account Management

- **Registration / profile fields:** name, Facebook name, email, phone, and a structured PH address (lot/block, street, barangay, city, province, landmark), plus `wants_announcements` consent and a versioned legal-document acceptance record.
- **Self-service:** Profile view/edit (`/customer/profile`, `/customer/personal-info`), Change Email (re-authenticates with current password, then Supabase sends a confirmation link to the new address before the change takes effect), Change Password.
- **Admin-side:** Customers directory with search (`/admin/customers`), per-customer detail page showing order history and lifetime spend (`/admin/customers/:id`).
- **Account linking:** a walk-in booking recorded under the admin's account can later be reassigned to a genuine customer profile once that person registers (`AssignCustomerModal`).
- There is **no account-deletion or deactivation feature** found in the scanned pages.

---

## 15. Reports and Activity Logs

- **Activity Logs** (`/admin/activity-logs`): a structured audit log written by `src/lib/activityLog.js`, with typed helpers — `logOrder`, `logTrip`, `logPayment`, `logChat`, `logAuth`, `logAnnouncement`, `logSettings`, `logCompany` — each recording an action label, the affected record's id/reference, and optional before/after values and free-text details. Calls are queued (locally, with a client-generated idempotency key so a retried call cannot duplicate an entry) and flushed (`flushActivityLogQueue`) rather than always synchronous. Confirmed logged events include: booking creation, status advances, pickup/delivery processing, trip creation/status changes, payment recording, login/logout, and settings changes. **Retention:** log entries are automatically purged after 7 days by a scheduled server-side job — the admin page itself states "logs are kept for 7 days, older entries are deleted automatically."
- **Sales / financial reports** (`/admin/sales`, `/admin/reports`, `SalesReportsPage.jsx`): pulls from the `get_sales_summary()` database RPC and from an unsettled-orders query, both intentionally kept consistent with the client-side `outstandingBalance()` formula used throughout the app to avoid the report and the operational screens showing different figures for "what is owed." A dedicated **Unsettled Deliveries** admin page lists these orders directly.
- **PDF export:** a shared `exportPrintDocumentToPdf()` utility (`src/lib/exportPdf.js`, using `html2pdf.js`) is available and referenced from reporting pages for print/PDF output, including a `PrintHeader` component carrying the company logo (per recent commit history).
- **Feedback:** `/admin/feedback` lists customer-submitted ratings/messages tied to delivered orders.

---

## 16. Implemented vs Partial vs Not Found Features

| Feature | Classification | Basis |
|---|---|---|
| Customer registration/login with role-based routing | **CONFIRMED IMPLEMENTED** | `AuthContext.jsx`, `App.jsx` |
| 5-step guided booking wizard, weight-free at booking | **CONFIRMED IMPLEMENTED** | `BookShipmentPage.jsx` |
| Client-generated tracking number | **CONFIRMED IMPLEMENTED** (client-side generation, not a DB sequence) | `generateTrackingNumber()` in `database.js` |
| Admin walk-in/manual booking + later customer linking | **CONFIRMED IMPLEMENTED** | `AdminCreateBookingPage.jsx`, `AssignCustomerModal.jsx` |
| Trip creation, auto-assignment, capacity ceiling | **CONFIRMED IMPLEMENTED** | `createTrip()`, `assertTripCapacity()` |
| Trip-level status cascade to all attached orders | **CONFIRMED IMPLEMENTED** | `updateTrip()` in `database.js` |
| Pickup weighing + shipping-cost calculation | **CONFIRMED IMPLEMENTED** | `PickupModal.jsx` |
| Cash payment (full/partial) | **CONFIRMED IMPLEMENTED** | `PaymentCollectionPanel.jsx` |
| GCash/PayMongo payment, source→webhook→ledger reconciliation | **CONFIRMED IMPLEMENTED** | `paymongo.js`, `paymongo-create-payment`, `paymongo-webhook` |
| Manual GCash reference entry (fallback to automated checkout) | **CONFIRMED IMPLEMENTED** | `PaymentCollectionPanel.jsx` |
| Partial payment with mandatory Promise Date | **CONFIRMED IMPLEMENTED** | `derivePaymentCollection()`/`validatePaymentCollection()` |
| Freight Prepaid vs Freight Collect (payer-type) branching | **CONFIRMED IMPLEMENTED** | `PickupModal.jsx`, `DeliveryModal.jsx` |
| Payment-gated dispatch for delivery | **CONFIRMED IMPLEMENTED** | `canDispatchForDelivery()` |
| Payment-gated trip completion | **CONFIRMED IMPLEMENTED** | `TripDetailPage.jsx` |
| Public tracking by tracking number, no login | **CONFIRMED IMPLEMENTED** | `TrackingPage.jsx`, `track_order_public` RPC |
| Realtime order/status updates on customer screens | **CONFIRMED IMPLEMENTED** | `useRealtimeOrders` |
| Push notifications (FCM) | **CONFIRMED IMPLEMENTED** | `push-notifications.js`, `send-push` function |
| Announcements: in-app + push always, email opt-in only | **CONFIRMED IMPLEMENTED** | `createAnnouncement()`, `broadcast-announcement` function |
| Rule-based multilingual support chatbot with escalation | **CONFIRMED IMPLEMENTED** | `supportChatEngine.js` |
| Admin Inbox for human-handled chat | **CONFIRMED IMPLEMENTED** | `InboxPage.jsx` |
| Public contact form, IP rate-limited | **CONFIRMED IMPLEMENTED** | `submit-inquiry` function |
| Customer-initiated cancellation request + admin review | **CONFIRMED IMPLEMENTED** | `request_order_cancellation`/`review_order_cancellation` RPCs |
| Admin force-cancellation (status-limited) | **CONFIRMED IMPLEMENTED** | `cancelOrderAsAdmin()` |
| Out-of-coverage ("Other Area") booking review | **CONFIRMED IMPLEMENTED** | `service_area_status` handling in `OrderDetailPage.jsx` |
| Post-delivery customer feedback | **CONFIRMED IMPLEMENTED** | `submitFeedback()` |
| Sales/unsettled reports, PDF export | **CONFIRMED IMPLEMENTED** | `SalesReportsPage.jsx`, `exportPdf.js` |
| Activity/audit logging (7-day retention) | **CONFIRMED IMPLEMENTED** | `activityLog.js`, `ActivityLogsPage.jsx` |
| Automated daily overdue-payment reminder emails | **CONFIRMED IMPLEMENTED** (cron-triggered, not user-initiated) | `supabase/functions/process-daily-reminders` |
| Public "featured delivery" highlighting | **CONFIRMED IMPLEMENTED** | Order Detail page (delivered orders), public feedback/highlights RPC |
| Automated payment verification | **CONFIRMED for GCash/PayMongo checkout (webhook + poll reconciliation)**; **PARTIALLY IMPLEMENTED for manual reference entry** (admin-attested only, not checked against PayMongo) | `paymongo-webhook`, `paymongo-create-payment`, `PaymentCollectionPanel.jsx` |
| Delivery route/stop sequencing or driver routing | **NOT FOUND** | No routing/sequencing code located anywhere in `src/` |
| A distinct "driver" or "rider" account role | **NOT FOUND** | Only `customer`/`admin` roles exist in route guards and `profiles.role` usage |
| Server-side (database trigger) trip-capacity hard block | **PARTIALLY IMPLEMENTED** | Enforced only in the browser (`assertTripCapacity`); an explicit code comment states the equivalent database trigger was deliberately removed to allow admin overbooking judgment |
| Server-side (database trigger) single-active-trip enforcement | **PARTIALLY IMPLEMENTED** | Enforced only in application code (`updateTrip()` pre-check), not a database constraint |
| Admin edit/deactivate of a customer account | **NOT FOUND** | `CustomersPage.jsx`/`CustomerDetailPage.jsx` are view/search only — no edit, suspend, or deactivate action located |
| PHP-based backend described in the assignment brief | **DOCUMENTED-BRIEF ONLY / NOT FOUND IN CODE** | No `.php` file exists in the repository; the actual backend is Supabase/Postgres with Deno Edge Functions |

---

## 17. End-to-End Proposed System Sequence

```
Visitor
 ↓ browses public site (About, Schedules, Track, FAQ) — no login required
 ↓
Registration (2-step form: personal info → address + legal consent)
 ↓
Login → routed by profiles.role to /customer or /admin
 ↓
Customer views available trips (Trips / Schedules page)
 ↓
Customer opens Book Shipment wizard
 ↓  Step 1: select route, optionally a specific scheduled trip
 ↓  Step 2: enter sender name/phone/Facebook/address
 ↓  Step 3: enter receiver name/phone/Facebook/address (+ route-side validation)
 ↓  Step 4: enter package description, who pays, payment preference, notes
 ↓  Step 5: review, Confirm Booking
 ↓
Order row inserted — tracking number generated client-side,
status = Pending / Assigned / Pending Review (out-of-coverage)
 ↓
[If Pending Review] Admin approves (→ Pending) or rejects (→ Cancelled)
 ↓
Admin assigns booking to a trip (manually, or automatically at trip creation)
 → status = Assigned
 ↓
Admin processes Pickup: weighs parcel (only weight-entry point in the system),
records who pays, collects payment now if Sender pays (cash / GCash / partial +
Promise Date), attaches pickup-proof photos
 → status = Picked Up, shipping_cost computed from weight × rate
 ↓
Admin Starts the Trip → every Assigned/Picked-Up order on it becomes In Transit
 ↓
Admin marks the Trip Arrived → every In-Transit order on it becomes Arrived at Hub
 ↓
Admin advances an individual order to Out for Delivery
(blocked for a Sender-pays order with an unpaid, unpromised balance)
 ↓
Admin processes Delivery: attaches delivery-proof photos, collects any
remaining balance (cash / GCash / further partial + Promise Date)
 → status = Delivered
 ↓
Customer may submit feedback (rating + message) on the delivered order
 ↓
Admin later marks the Trip Completed
(blocked while any non-cancelled order on it still owes money)
```

Running in parallel with the above at any point:
- Customer can view live status via public tracking (tracking number) or the logged-in Orders/Order Detail pages, both realtime-updated.
- Customer can request cancellation before the order reaches Picked Up/beyond; admin reviews and approves/declines.
- Customer/admin can exchange messages through Support Chat (bot-first, escalating to a human admin on complaint/damage/loss language); the public can separately submit a Contact Inquiry.
- Admin can publish Announcements (in-app + push always, email to opted-in recipients).
- All of the above generate entries in the Activity Log and, for most order/payment/status events, in-app and push notifications to the affected customer.

---

## 18. Chapter 2 Mismatches

No Chapter 2 manuscript file exists anywhere in this project (see Section 1.3), so a clause-by-clause comparison against the actual document could not be performed in this session. Based on the assignment brief's own wording (which itself assumes a PHP backend), the following mismatches can already be stated with confidence and should be checked against whatever manuscript draft exists outside this repository:

1. **Technology stack.** Any Chapter 2 text describing "PHP pages," a PHP/MySQL backend, or PHP-based AJAX endpoints does not match the implementation. The actual stack is React + Supabase (PostgreSQL) + Deno Edge Functions + Firebase Cloud Messaging + PayMongo.
2. **Weight/cost entry point.** If Chapter 2's System Rules describe the customer declaring or estimating a weight or cost at booking time, this does not match the code: weight is captured exactly once, by the admin, from a physical scale, at pickup. The customer-declared weight field was explicitly removed (per an in-code comment referencing the specific migration that removed it).
3. **Tracking number generation.** If Chapter 2 describes tracking numbers as database-generated (sequence/trigger), note that the actual implementation generates them in client-side JavaScript at the moment of booking submission.
4. **Actor set.** If Chapter 2's Event List or Context Diagram includes a distinct "Driver," "Rider," "Dispatcher," or "Cashier" actor, this does not match the code — only `customer` and `admin` roles exist; pickup/delivery/payment actions are all performed through the same admin account/interface.
5. **Delivery routing.** If Chapter 2 describes route-optimized or sequenced multi-stop delivery, this is **not implemented** — delivery is a manual, per-parcel status advance with no routing/sequencing logic in the codebase.
6. **Guest/anonymous booking.** If Chapter 2 describes an anonymous public visitor being able to book a shipment without any account, this does not match the code — booking requires the `customer` role; the closest equivalent is an admin-entered walk-in booking recorded under the admin's own account.
7. **Payment method list.** If Chapter 2 lists payment options differently (e.g., omitting "Pay Later"/Promise Date, or describing PayMongo/GCash differently from the source/webhook/reconciliation flow above), the code's actual set is Cash, GCash (via PayMongo, both automated checkout and manual reference fallback), and a Pay-Later/partial-payment mechanism gated by a mandatory Promise Date once a balance would otherwise be released unpaid.
8. **Trip capacity enforcement.** If Chapter 2 states capacity is a hard, unconditional constraint, note the code enforces it only in the browser and with a 200 kg allowance above the planned capacity — an in-code comment states the database-level hard trigger was deliberately removed to let admins overbook by judgment within that allowance.

**Recommendation:** once the actual Chapter 2 draft (Word/PDF) is placed in or shared with this project, re-run this comparison directly against its System Rules, Context Diagram, Event List, Process Specifications, and Program Hierarchy sections for a precise, itemized mismatch list.

---

## 19. THESIS-READY PROPOSED SYSTEM NARRATIVE

*(Chapter 2, Section B — System Narrative. Chronological description only; no problems, constraints, comparisons, or benefit claims.)*

The proposed system is accessed through a web-based application that presents different interfaces depending on whether the person using it is a visitor, a registered customer, or an administrator. A visitor who has not created an account may browse the public pages of the system, which include general company information, the list of currently scheduled trips, a public shipment-tracking page, and a contact form through which an inquiry may be sent to the administrator without logging in.

A person who wishes to book a shipment first creates a customer account. Registration is completed in two steps: the first step collects the customer's full name, Facebook name, email address, password, and mobile number; the second step collects the customer's complete address, broken down into lot/block, street, barangay, city, and province, together with an acknowledgment of the system's Terms of Service and Privacy Policy. Once the account is created, the customer logs in using the registered email and password, and the system directs the customer to a personal dashboard.

From the customer dashboard, the customer may view the trips currently scheduled by the company, each trip showing its route, departure date, per-kilogram rate, and remaining capacity. To book a shipment, the customer proceeds through a guided sequence of screens. The first screen requires the customer to select a route and, if desired, a specific scheduled trip on that route. The second screen collects the sender's name, mobile number, Facebook name, and complete address. The third screen collects the same information for the receiver, together with a check that the sender's and receiver's addresses correspond to the correct ends of the selected route. The fourth screen collects a description of the item or items being sent, an indication of whether the sender or the receiver will pay for the shipment, and an optional statement of how payment is intended to be made. The fifth and final screen presents a summary of the entered information for the customer's review before the booking is confirmed. No weight and no shipping cost are entered by the customer at this stage; the applicable rate per kilogram is shown, but the total cost is determined later, once the parcel is weighed.

Upon confirmation, the system generates a unique tracking number for the booking and records it together with all the entered information. If the customer selected a specific trip during booking, the booking is immediately associated with that trip; if no trip was selected, the booking is recorded and left available for a trip to be assigned to it later by the administrator. If the sender's declared pickup location falls outside the system's standard coverage area, the booking is instead placed into a review state, and the administrator subsequently either approves it to proceed as a normal booking or declines it with a stated reason. After the booking is recorded, the customer is shown the generated tracking number, together with the current status of the booking, and this information becomes accessible at any time afterward from the customer's list of bookings or from the public tracking page using the tracking number alone.

On the administrative side, the administrator receives notice of each new booking and may also enter a booking directly on behalf of a customer who prefers not to create an account; such a booking is recorded under the administrator's own account and may later be transferred to the customer's own account once that customer registers. The administrator organizes shipments by creating trips, each trip specifying a route, a departure date, a planned carrying capacity, and a rate per kilogram. When a trip is created, any existing bookings on the matching route that have not yet been assigned to a trip are automatically attached to it, up to the trip's available capacity. The administrator may also attach individual bookings to a trip directly.

When a shipment is physically collected from the sender, the administrator processes the pickup within the system. This is the point at which the parcel is weighed, and the weight entered by the administrator becomes the basis on which the shipping cost is calculated, using the rate associated with the assigned trip. At this same step, the administrator confirms who is responsible for payment. If the sender is paying, the amount may be collected in cash, through GCash, or in part with the remainder recorded against a promised future payment date; a GCash payment is processed through the system's integrated payment gateway, which generates a payment link and QR code for the customer to complete the payment, and the system subsequently records the payment automatically once it is confirmed by the payment gateway, or the administrator may enter a manual payment reference if needed. If the receiver is designated to pay instead, no payment is collected at this stage, and the full amount remains payable at the time of delivery. Regardless of the payment arrangement, the administrator attaches photographs of the parcel as proof of pickup before the pickup is finalized. Once finalized, the shipment's status changes to indicate that it has been picked up.

When the administrator starts a trip, every booking that had been assigned to that trip and already picked up is updated together to indicate that the cargo is now in transit. When the trip reaches its destination and the administrator records its arrival, every shipment on that trip is updated together to indicate that it has arrived at the destination hub. From this point, the administrator advances each shipment individually toward delivery. A shipment whose payment remains unsettled and for which the sender was responsible for payment is held at the hub unless a promised payment date has already been recorded for it; a shipment for which the receiver is responsible for payment proceeds without this hold, since payment for it is expected only at the point of delivery.

When a shipment is delivered, the administrator records the delivery within the system, attaching photographs as proof of delivery and, where a balance remains outstanding, collecting the remaining payment in the same manner available at pickup — in cash, through GCash, or with a further promise date if only part of the balance is collected. Once this is recorded, the shipment's status changes to indicate that it has been delivered, and the customer may then submit a rating and a message regarding that particular booking. Separately, once every shipment on a given trip has been fully paid or cancelled, the administrator may mark that trip as completed.

Throughout this sequence, the customer may open any individual booking at any time to view its current status, its position along the standard progression of statuses, and a record of any payments made against it. The customer may also request the cancellation of a booking, stating a reason, provided the shipment has not yet been collected from the sender; such a request places the booking in a waiting state until the administrator either approves it, which cancels the booking, or declines it, which returns the booking to its previous status. The administrator may likewise cancel a booking directly at any point up to and including the moment the parcel is collected from the sender.

Communication between customers and the company is supported in two ways. A logged-in customer may open a support conversation, which is first answered by an automated assistant capable of responding, in English, Tagalog, or Bisaya, to common questions about shipment status, payment balances, accepted payment methods, and similar topics; a message describing a complaint, damage, or loss is instead routed directly to an administrator for a personal reply. A visitor who has not created an account may separately send a message through the public contact form, which is likewise made available to the administrator for review and response. The administrator may also publish announcements, which are delivered to every customer within the system and, for customers who have indicated a preference to receive them, by email as well.

The administrator additionally maintains the list of registered customers and their booking histories, reviews submitted customer feedback, generates reports summarizing completed transactions and outstanding balances, and consults a running log of the significant actions taken within the system, including bookings created, statuses changed, payments recorded, and trips managed.

---

*End of audit.*
