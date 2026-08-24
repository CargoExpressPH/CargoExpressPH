# CargoExpress PH

Web-based cargo delivery booking and tracking system for the Manila ⇄ Bohol route.
Installable PWA. Door-to-door service, two roles: **customer** and **admin**.

---

## Stack

| Concern | Actual technology |
|---|---|
| Frontend | React 19 (JavaScript + JSX, **not** TypeScript) |
| Build | Vite 6 + `@vitejs/plugin-react` |
| Routing | React Router DOM 7 (`createBrowserRouter` data router) |
| Styling | Hand-written CSS, 35 files in `src/styles/`, tokens in `tokens.css`. No Tailwind, no component library |
| Backend | **Supabase** (PostgreSQL + PostgREST + GoTrue + Realtime + Storage + Edge Functions) |
| Database | PostgreSQL — schema in `supabase/schema.sql`, history in `supabase/migrations/` |
| Auth | Supabase Auth (email/password, JWT) |
| Push | Firebase Cloud Messaging **only** — Firebase Auth and Firestore-as-primary-DB are not used |
| Payments | PayMongo (GCash) |
| Hosting | Vercel (static SPA + rewrite in `vercel.json`) |

**There is no Node/Express server, no MySQL, and no React Native.** Server-side work happens
in PostgreSQL triggers/RPCs and five Deno Edge Functions.

Key dependencies: `@supabase/supabase-js`, `firebase`, `lucide-react`, `framer-motion`,
`@dnd-kit/*`, `react-qr-code`, `html2pdf.js`, `browser-image-compression`.

---

## Architecture

```
React SPA (Vercel static)
   │  HTTPS + WebSocket
Supabase
   ├── PostgreSQL      ← system of record AND the authorization engine (RLS + triggers)
   ├── PostgREST       ← auto-generated REST/RPC API
   ├── GoTrue          ← auth
   ├── Realtime        ← WebSocket change streams
   ├── Storage         ← proof photos, company assets (private bucket)
   └── Edge Functions  ← the only place secrets live
          ├── paymongo-create-payment   (verify_jwt = true)
          ├── paymongo-webhook          (verify_jwt = false — HMAC instead)
          ├── send-push                 (verify_jwt = false — public contact path; internal JWT checks)
          ├── store-photo-fallback
          └── get-photo-fallback
```

JWT verification per function is declared in `supabase/config.toml`. The webhook is public and
authenticates by HMAC signature; `send-push` is also gateway-public only so the anonymous contact
form can trigger its narrowly scoped inquiry event, while every other send-push event verifies the
caller JWT and authorization inside the function.

The browser talks directly to PostgreSQL through PostgREST. **All authorization is enforced
in the database**, not in React. Route guards in `src/App.jsx` are UX only.

### Where logic belongs

| Kind of rule | Lives in |
|---|---|
| Pricing, tracking numbers, status transitions, payment totals, settlement gates | PostgreSQL triggers (`supabase/schema.sql`) — authoritative |
| Row/field access control | RLS policies + `SECURITY DEFINER` functions |
| Anything needing a secret (capture payment, sign push, write Firestore) | Edge Functions |
| Data fetching, orchestration, display formatting | `src/lib/database.js` |
| Rendering | `src/pages/`, `src/components/` |

Client-side price math is **display only** — the database recomputes and overwrites it.
Rules mirrored in `src/constants/status.js` exist only to produce a good error message before
the round trip; the database is the authority in every case.

---

## Folder structure

```
src/
  main.jsx              React root (StrictMode + ErrorBoundary)
  App.jsx               Router, guards (ProtectedRoute/AuthRoute/RootRedirect), lazy imports
  pages/
    auth/      (4)      Login, Register, ForgotPassword, ResetPassword — eagerly loaded
    customer/ (12)      Home, Orders, OrderDetail, BookShipment, Trips, Notifications,
                        Profile, PersonalInfo, SupportChat, PaymentHistory,
                        HelpGuidelines, AboutVersion
    admin/    (21)      Dashboard, Orders, OrderDetail, Trips, TripDetail, CreateTrip,
                        Customers, CustomerDetail, Inbox, ContactInquiries, Announcements,
                        ActivityLogs, CompanyInformation (+2 tab components), Feedback,
                        Profile, SalesReports (+3 section pages)
    shared/    (2)      ChangePasswordPage, ChangeEmailPage — mounted under BOTH roles
    public/    (3)      Tracking, About, NotFound
  components/
    layout/    (3)      AdminLayout, CustomerLayout, Sidebar
    ui/       (33)      Modals, charts, skeletons, error boundaries, StatusBadge,
                        TrackingTimeline, CapacityTracker, CommandPalette,
                        InstallAppBanner, IosInstallBanner, …
  contexts/           AuthContext (session/profile/role), ThemeContext (light/dark)
  hooks/       (7)     useToast, usePushNotification, useCustomerChatUnread,
                       useNetworkRecovery, usePageTitle, useRealtimeOrders, useScrollLock
  lib/                Integration + data layer — see below
  constants/          status.js (state machines + settlement rules), phLocations.js
  utils/              password.js, string.js, statusTimestamps.js
  styles/             35 CSS files; tokens.css drives theming

supabase/
  schema.sql          Full DDL: 18 tables, RLS, triggers, RPCs
  migrations/  (84)   Incremental history — add new changes here, never edit old files
  functions/    (5)   Deno Edge Functions
  config.toml         Per-function verify_jwt declarations

public/               manifest.json, sw.js, firebase-messaging-sw.js, icons/
scripts/              smoke-check.mjs, axe-lint.mjs (run by `npm test`)
```

`SalesReportsPage` is a tab shell composing three sections: `SalesPage`,
`UnsettledDeliveriesPage`, `ReportsPage`. Routed twice —
`/admin/sales` and `/admin/reports` (the latter via `initialSection="reports"`).
`CompanyInformationPage` similarly composes `CompanyInfoCoverageTab` and
`CompanyInfoFeaturesTab`. These five files are sections, not routes.

### `src/lib/` map

| File | Role |
|---|---|
| `supabase.js` | Hardened client: 15 s timeout, GET-only retry, `no-store`, custom refresh lock |
| `database.js` | ~97 exported data-access functions — **all backend reads/writes go through here** |
| `storage.js` | Photo compress → validate → upload → descriptor; signed-URL resolution |
| `paymongo.js` | GCash source creation, capture, polling |
| `firebase.js` / `firebase-messaging.js` | FCM app init and token lifecycle |
| `supportChatEngine.js` | Rule-based (regex) support bot — no LLM |
| `activityLog.js`, `announcements.js`, `exportPdf.js`, `address.js`, `lazyWithRetry.js`, `featureIcons.js` | Helpers |

---

## Database

18 tables. `supabase/schema.sql` is the single source of truth; `docs/database_design.md` holds the
ERD and per-column documentation.

`profiles` · `trips` · `orders` · `order_status_events` · `announcements` · `notifications` ·
`user_device_tokens` · `notification_delivery_attempts` · `conversations` · `chat_messages` ·
`contact_inquiries` · `company_information` · `activity_logs` · `customer_feedback` ·
`payment_transactions` · `payment_attempts`

### Domain rules

- Routes are Manila → Bohol and Bohol → Manila.
- Trip capacity is in **kilograms**. The capacity *check* was deliberately removed
  (`20260526010000_remove_capacity_guard.sql`) so admins can overbook manually.
- Bookings can exist **without** a trip (`orders.trip_id` is nullable). No trip → status
  `Pending`; trip assigned → status `Assigned`.
- Trips whose `departure_date` has passed are hidden from the **customer** booking flow only
  (`isTripBookable`) — admins keep seeing them so they can be closed.
- One conversation per customer (UNIQUE on `conversations.customer_id`).
- One feedback per order (UNIQUE on `customer_feedback.order_id`).
- Announcements expire from view after **60 days** (`ANNOUNCEMENT_MAX_AGE_DAYS`,
  applied inside `getAnnouncements`). Nothing is deleted — the rows stay and are
  simply no longer served, to the admin list as well as the customer feed.
  `getAnnouncementById` deliberately ignores both this window and `is_active`:
  it backs the detail modal a customer opens from a notification they still
  hold, and refusing to show that would be nonsense.

### Weight and pricing — read this before touching booking

`orders.package_weight` (customer-declared "estimated weight") was **removed**
(`20260805130000_remove_package_weight.sql`). Weight now enters the system exactly once, from
the scale at pickup, as `actual_weight`.

Consequence, stated plainly: **a new booking has no price.** `shipping_cost` and
`remaining_balance` are 0 until an admin weighs the parcel. Weight was the only quantity in
the pricing formula, so this is unavoidable — and it is the point, since a customer-supplied
estimate was what generated the billing disputes. Do not reintroduce a client-side estimate
to "fix" the empty figure on the booking confirmation.

Trip capacity (`current_trip_weight`) therefore counts only parcels that have been weighed.

**₱0 means "not priced yet", never "paid".** Both zeros look identical to a `balance <= 0`
test, and that conflation is a live defect class: it let unweighed cargo through the dispatch
gate and rendered `Unpaid` next to `Settled` on the same order. Anything answering a money
question must ask `actual_weight > 0` first. Client side that is `isOrderPriced()` /
`getSettlementState()` in `src/constants/status.js` — three states (`unpriced` / `settled` /
`owing`), not a boolean. Server side `guard_order_update` refuses to dispatch an unweighed
order for delivery (`20260806030000`), before the payment check and for **every** payer type,
freight collect included — collect governs who pays and when, not whether a price exists.

Pricing: `global_price_per_kilo()` reads `company_information.default_price_per_kg`
(fallback 70); `effective_trip_price(trip_id)` prefers the trip's own `price_per_kg`.

Tracking format: `CE-YYYYMMDD-NNNN`, generated by `generate_order_tracking_number()`.

### Settlement rules (`20260804100000_settlement_guards.sql`)

1. Cargo always travels to the destination warehouse, paid or not.
2. An **unpaid** shipment is **held** there — not dispatched for doorstep delivery until the
   balance is settled.
3. Override: an admin may dispatch anyway by recording a **promise date**. It is logged.
4. **Freight Collect (`payer_type = 'receiver'`) is exempt** — payment is due at the door, so
   a COD order is unpaid by definition until delivery. Gating it would deadlock it forever.
5. A trip cannot be completed while any of its orders still owes money (`guard_trip_completion`).

**"Outstanding" has one definition** (`20260806040000`): the *derived*
`GREATEST(shipping_cost - amount_paid, 0)`, never the stored `remaining_balance`, which can
lag a ledger write. `outstandingBalance()` in `src/constants/status.js` is the single client
implementation — `deriveSettlement`, `qualifiesAsUnsettled`, the trip-completion guard and the
admin badges all call it. `get_sales_summary()` reports it at two **named** scopes:
`outstandingTotal` (the five settlement-tracked statuses — reconciles to the peso with the
Unsettled Deliveries tab) and `outstandingAllOrders` (every non-cancelled order).
`outstandingStored` exists only to make drift visible; never render it as the figure. Two
views reading two different columns over two different populations under one label is what
produced two contradictory "Outstanding" numbers in one report.

`Delivered` is deliberately **not** gated on payment. `orders.status` answers "where is the
cargo"; `payment_status` answers "where is the money". Keeping them independent is what makes
"delivered, balance owing, payment promised" representable. Mirrored client-side by
`canDispatchForDelivery()` / `isOrderSettled()` in `src/constants/status.js`.

### Order status flow (`src/constants/status.js`)

```
Pending Review → Pending → Assigned → Picked Up → In Transit
    → Arrived at Hub → Out for Delivery → Delivered
Pending Cancellation — a hold, not a step (see below)
Cancelled — terminal, reachable from any state
```

**Cancellation is a request, not an act** (`20260816100000`). A customer
submits a *reason* and the order moves to `Pending Cancellation`; an admin then
approves (→ `Cancelled`) or rejects (→ back to `cancellation_previous_status`,
the exact status it held when asked). The booking keeps its trip slot and keeps
moving to the warehouse in the meantime, because a request is not a decision.

`Pending Cancellation` is a **status**, not a flag beside one: the whole point
is that the order stops advancing while a human looks at it, and every surface
already keys off `status`. It is deliberately absent from `STATUS_FLOW` and
`STATUS_TIMELINE` — it is a hold, not a place the cargo has reached, so
`timelineStatus()` resolves it back to the previous status before any timeline
or progress bar indexes on it (a raw `indexOf` returns -1 and renders an empty
timeline / a negative progress bar).

`cancellation_previous_status` is what makes a rejection lossless — without it,
an `Assigned` booking would come back as `Pending`, silently detached from a
trip it is still physically on. `request_order_cancellation()` and
`review_order_cancellation()` are the only correct entry points; they write the
notification and the activity log in the same transaction as the status change,
and `guard_order_update` refuses every other exit from the hold.
`cancel_own_pending_order()` is retired to a raising stub with EXECUTE revoked.

Trip status `scheduled → in_progress → arrived → completed` (+ `cancelled`) cascades to
orders: `in_progress → In Transit`, `arrived → Arrived at Hub`, `cancelled → Cancelled`.

Every status change is appended to **`order_status_events`** by `log_order_status_event`
(`20260803110000`) — an append-only timeline with `changed_by` and an optional note. This is
what the tracking timeline reads; do not reconstruct history from `orders.updated_at`.

### Conversation service state (`20260804260000`, `20260807120000`, `20260807140000`, `20260808150000`, `20260816110000`)

> `20260816110000` repaired `maintain_conversation_service_state`, which had
> reverted to an older revision writing a column (`last_message_at`) that does
> not exist. Being an AFTER INSERT trigger, it raised 42703 and rolled back
> **every** `chat_messages` insert — customer, bot and admin alike — so support
> chat was entirely dead. Same revision had the grace window at 15 seconds
> rather than 12 hours and lacked both `SECURITY DEFINER` and the
> `app.conversation_service_write` flag, so `guard_conversation_update` reverted
> whatever status it computed. If chat "stops working", check this function
> first, and check it against the migration rather than against the live DB.

`conversations.status` is **derived by trigger** from who spoke last. Four values:

| Status | Meaning |
|---|---|
| `bot_active` | Bot handling — a new chat. The only status a customer message does not move |
| `waiting` | The customer spoke last — **our turn**, this is the queue |
| `waiting_customer` | An admin spoke last — their turn |
| `resolved` | An admin said so — the only human-set value |

`'open'` was deleted: once every admin reply means "waiting on the customer", it described
nothing the assignment did not already say. `escalated` is a **flag, not a state** —
it answers "how urgent", `status` answers "whose turn". Collapsing the two is what produced
the original defect. `bot_resolved` is nullable; NULL means unknown, which is the honest
default.

**A customer writing into a `resolved` thread splits on a 12-hour grace window**
(`20260807140000_reopen_grace_window.sql`, refining the unconditional reopen in
`20260807120000_reopen_resolved_conversations.sql`):

| Resolved | Goes to |
|---|---|
| ≤ 12 h ago | `waiting` — a **follow-up**, straight back to the queue |
| > 12 h ago, or `resolved_at` NULL | `bot_active` — a **new session**; `escalated` cleared |

The window exists because `conversations.customer_id` is UNIQUE: one row per customer forever,
so the same row is both "the ticket just closed" and "every question this person will ever
ask". Reopening unconditionally sent someone asking `magkano per kilo?` three weeks later
straight into the admin queue; never reopening let the bot answer a follow-up to a thread it
could not see while, because `bot_active` carries no badge and is excluded from the inbox
unread count, no admin was ever told the customer came back. `resolved_at` is trustworthy —
`stamp_conversation_resolved_at` stamps every transition into `resolved` — so a NULL means a
pre-trigger row, correctly treated as old.

**Support chat is a shared inbox** (`20260808150000`): `conversations.assigned_admin_id` was
dropped, so no thread has an owner and no reply locks one. Ownership was introduced so someone
was answerable and two admins could not answer at once; on a two-person team the auto-claim on
first reply meant the lock was applied by the act of helping, and a thread another admin had
opened read as "not mine". What was actually wanted was attribution, and attribution was
already in `chat_messages.sender_id` — so the admin inbox names the author of each reply
instead of naming an owner of the thread. The customer still sees an anonymous "Admin".
`contact_inquiries.assigned_admin_id` is untouched; only chat is shared. (The
`get_service_summary()` reporting RPC that surfaced these queue counts was dropped with the
Customer Service report tab in `20260824090000`; the conversation state machine itself is
unchanged.)

The routing is server-side on purpose: a client PATCH after the insert is two round trips with
a failure window that loses the message. `SupportChatPage` mirrors the window only to phrase
its banner, and after sending into a resolved thread it **re-reads the conversation** to learn
which branch fired rather than recomputing the deadline against a clock that may differ from
the server's.

### Consolidations already done — do not reintroduce these tables

- `global_settings` → `company_information.default_price_per_kg`
- `coverage_regions` + `coverage_municipalities` → `company_information.coverage` (JSONB)
- Company features → `company_information.features` (JSONB)
- Chatbot analytics / FAQ / visitor-assistant tables → dropped
  (`20260707105300`, `20260707103600`)

`company_information` is a **singleton** row with fixed id `00000000-0000-0000-0000-000000000001`.

Columns prefixed `_deprecated_` are retained but write-only-dead — do not read or populate them.

### Triggers you must not bypass

| Trigger | Guarantees |
|---|---|
| `guard_profile_write` | Non-admins forced to `role='customer'`; `id`/`email`/`role`/`created_at` reverted on update |
| `prepare_order_insert` | Server-generates tracking number, nulls payment/weight/photo fields, computes `shipping_cost` |
| `guard_order_update` | Recomputes `shipping_cost` + `remaining_balance` on weight/trip/payment change; enforces the warehouse hold |
| `guard_trip_completion` | Blocks trip completion while any order on it owes money |
| `guard_chat_message_insert` | Overwrites `sender_id`/`sender_role` from `auth.uid()` — impersonation impossible |
| `guard_conversation_update` | Restricts which conversation fields a client may change |
| `guard_activity_log_insert` | Stops forged audit entries |
| `maintain_conversation_service_state` | Derives `conversations.status` from the last message |
| `stamp_inquiry_service_state` | Stamps `first_response_at` / `resolved_at` on inquiries |
| `log_order_status_event` | Appends to `order_status_events` on every status change |
| `update_order_payment_totals` | Derives `amount_paid`/`remaining_balance`/`payment_status` from the `payment_transactions` ledger |

### Payment atomicity (`20260803100000_atomic_order_payment.sql`)

`record_pickup_payment()` and `record_delivery_payment()` are the **only** correct way to take
a counter payment. They write order *metadata* only; the ledger trigger derives the totals.

Ordering inside each RPC is load-bearing:
1. `UPDATE orders` → fires `guard_order_update`, recomputing `shipping_cost` from the new weight.
2. `INSERT payment_transactions` → fires `update_order_payment_totals`, which **reads** that
   `shipping_cost` to derive the balance.

Reversing the two derives the balance from a stale cost. Never write `amount_paid`,
`remaining_balance`, or `payment_status` directly from a client — they are derived columns.

---

## Authentication & authorization

**Supabase Auth**, email + password. No OAuth providers, no Firebase Auth.

`AuthContext` exposes `user`, `userProfile`, `loading`, `isAdmin`, `isCustomer`,
`login`, `register`, `logout`, `resetPassword`, `changePassword`, `changeEmail`,
`refreshProfile`.

Behaviours that exist for a reason — preserve them when editing `AuthContext.jsx`:

- Login signs the user **out** if the profile fetch fails (no half-authenticated state).
- `fetchProfile` races a 15 s timeout and **keeps an existing valid profile** on transient
  failure instead of downgrading to a role-less placeholder.
- `isAuthAction` ref suppresses the duplicate profile fetch from `onAuthStateChange`.
- **A plain `SIGNED_IN` does not refetch the profile.** GoTrue re-emits `SIGNED_IN` on every
  token refresh and on tab focus — it does not mean someone signed in. The refetch is gated on
  `lastProfileUserId` actually changing (or `USER_UPDATED`). Refetching on every emission put a
  network round trip on a ~1-minute cadence whose failure path rewrites `userProfile`, and a
  role-less `userProfile` makes `ProtectedRoute` redirect: that was the spontaneous eject out
  of a half-filled booking form. `setUser` likewise keeps the previous object when the id and
  email are unchanged, so a refresh does not re-render every consumer.
- **`ProtectedRoute` shows `<LoadingScreen/>` only on the FIRST resolve.** Once a valid profile
  for the required role is in hand, a later `loading` flip is ignored — honouring it would swap
  the whole authenticated subtree for the loading screen, unmounting the current page and
  destroying its in-progress form state.
- Logout deletes this device's push token and removes only `sb-*` localStorage keys.
- `sync_auth_email_to_profile` keeps `profiles.email` in step with a GoTrue email change.

### RLS

Enabled on all 18 tables; `public.is_admin()` is the shared helper. Summary:

- **profiles** — own read/update; admins all
- **orders** — own read; admins all; anon reads only `featured_on_website = true`
- **order_status_events** — own order's events; public timeline via `get_public_order_events()`
- **trips / announcements / company_information** — public read, admin write
- **chat_messages** — participants only; customers may only flip `is_read` on admin messages
- **contact_inquiries** — anon INSERT (public form), admin read/update
- **activity_logs** — admin read; insert guarded; purged after 7 days (`purge_old_activity_logs`)
- **payment_attempts** — admin only; the reconcile RPC is granted to `service_role` alone

Customer order INSERT is value-constrained, not just ownership-constrained — status must be
`Pending`/`Assigned`, weight/payment/photo fields must be empty.

Function execute privileges were tightened in `20260804190000_function_privileges.sql` —
do not blanket-grant `EXECUTE ... TO public` when adding a function.

### Public data

Anonymous surfaces are served by dedicated RPCs, never by widened table grants:

| RPC | Exposes |
|---|---|
| `track_order_public()` | Masked tracking result — `mask_name()` turns "Juan Dela Cruz" into "Juan C."; never returns phone, address, or payment fields |
| `get_public_order_events()` | Status timeline for a tracked order |
| `get_public_business_profile()` | Intended public contact details only |
| `get_featured_deliveries()` | Orders explicitly flagged `featured_on_website` |
| `get_public_feedback()` | Non-hidden customer feedback |

**Never widen table-level anon access to serve public pages — add or extend an RPC.**

---

## Storage

Bucket `cargo-photos` — **private**, 5 MB limit, `image/jpeg|png|webp` only.
Override via `VITE_SUPABASE_PHOTOS_BUCKET`.

The bucket was taken fully private in `20260804200000_lock_cargo_photos.sql`. The
`/object/public/` endpoint no longer serves it, which is the point: paths embed the tracking
number and tracking numbers run `CE-YYYYMMDD-NNNN`, so a public bucket made every proof photo
and receipt enumerable. Reads now require an admin session, ownership of the order, or a
signed URL minted for a deliberately featured photo.

Pipeline in `src/lib/storage.js`: validate MIME + ≤10 MB → compress
(`browser-image-compression`, ≤0.8 MB, 1200 px, JPEG, Web Worker) → upload with `upsert: true`
→ return a **descriptor object**, not a URL:

```js
{ type: 'supabase_storage', bucket, path, content_type, size_bytes, created_at }
```

Descriptors are what get persisted into `orders.pickup_photos` / `delivery_photos` (JSONB).
Call `resolvePhotoUrl()` / `resolvePhotoUrls()` to render — they mint a **signed URL**
(1 hour TTL) and fall back to a public URL only for buckets that are still public.

Paths:
```
pickup-proofs/CE-20260802-1234/pickup-1.jpg
delivery-proofs/CE-20260802-1234/delivery-1.jpg
receipts/CE-20260802-1234/receipt-1.jpg
gallery/gallery-<ts>.jpg          ← company assets, no order context
```

Storage RLS lets admins do everything and lets a customer read only photos whose path segment
resolves to an order they own (via `public.safe_uuid()`).

**Firestore fallback:** if a Storage write fails, `store-photo-fallback` writes a ≤700 KB
data-URL copy to Firestore; `get-photo-fallback` reads it back. Firebase service-account
credentials stay in Edge Function secrets.

---

## Payment system

PayMongo, GCash. Order payment methods: `cash` (manual), `gcash` (online), `paylater`
(deferred with `promised_payment_date`). `orders.payment_preference` records what the customer
*asked for* at booking (default `'unspecified'`); `payment_method` records what actually
happened.

**Key split — the core security property:**

| Key | Where | Can do |
|---|---|---|
| `VITE_PAYMONGO_PUBLIC_KEY` | Browser | Create a source, read its status |
| `PAYMONGO_SECRET_KEY` | Edge secret | Capture payments |
| `PAYMONGO_WEBHOOK_SECRET` | Edge secret | Verify webhooks |

Flow:

```
1. Browser  createGCashSource()          → PayMongo /v1/sources  [public key]
2. Browser  registerSource()             → Edge Fn, INSERT payment_attempts (pending)
3. User authorises in GCash
4a. PayMongo webhook → paymongo-webhook  → verify HMAC → capture → reconcile
4b. User returns    → pollPaymentStatus()→ Edge Fn 'poll' → capture → reconcile
5. reconcile_paymongo_payment_attempt()  [SECURITY DEFINER, SELECT … FOR UPDATE]
       updates orders + payment_attempts, sets order status 'Picked Up'
```

4a and 4b are **redundant and idempotent** — whichever lands first wins. This handles the
common case where the user closes the browser before redirect.

Correctness controls already in place — keep them:

- Row locks in the reconcile RPC; UNIQUE on `source_id`, `payment_id`,
  and a partial unique index on `payment_transactions.transaction_reference`
- Duplicate-payment guard: refuses only if already fully paid under a *different* reference
- Orphan recovery: `payment_id` set but status ≠ `reconciled` → re-reconcile, never re-charge
- Self-heal: on "not chargeable", re-query the source; if `paid`, reconcile as `auto_{sourceId}`
- Webhook HMAC-SHA256 over `{t}.{rawBody}`, constant-time compare, checked before parsing

`payment_attempts.status`: `pending → chargeable → reconciled` (`failed` carries `last_error`).
`orders.payment_status` is **derived by trigger** (`derive_payment_status`), never written
directly by a client. Re-weighing a delivered order recomputes it
(`20260805120000_payment_status_on_weight_edit.sql`) so a "Paid" badge cannot go stale after
the cost changes.

Reporting: `get_sales_summary()` — admin-gated RPC returning totals, per-method breakdown,
24-month series, and up to 100 unpaid/partial orders in one round trip.

**The per-method breakdown is grouped by `payment_transactions.payment_method`, never by
`orders.payment_method`** (`20260806020000`). The order column holds the method of the *most
recent* payment event, so bucketing the cumulative `amount_paid` by it files every peso of a
twice-paid order under whichever method landed last — a GCash pickup settled in cash at the
door reported the whole amount as GCash. The ledger is already the sole writer of
`amount_paid`, so the split and the total come from the same rows. Only rows with
`payment_status IN ('paid','partial')` are summed — the same predicate
`update_order_payment_totals` uses, which is what makes the buckets add up to `paidTotal`.
`unattributedTotal` is the gap left by pre-ledger orders that have `amount_paid` with no
backing transaction; it is reported as its own figure rather than folded into Cash. The same
rule applies to `getReportData()` in `database.js`, where the counts are **payments, not
orders** — one order can appear in two buckets.

The customer-service reporting equivalent, `get_service_summary()`, and its Customer Service
report tab were removed in `20260824090000_remove_service_reporting.sql`. Conversations,
inquiries and feedback are still served by the Inbox, Contact Inquiries and Feedback pages —
only the aggregate reporting RPC is gone.

---

## Realtime & notifications

Published tables: `orders`, `conversations`, `chat_messages`, `notifications`,
`contact_inquiries`. Membership is asserted idempotently by
`20260805140000_enable_realtime_publications.sql` — a fresh database rebuilt from
`schema.sql` alone would otherwise have silent, non-functioning subscriptions.
Realtime respects RLS.

Subscriptions live in: `SupportChatPage`, admin `InboxPage` (4 channels), customer
`NotificationsPage`, `CustomerLayout`, `AdminLayout`, `AdminNotificationCenter`, `Sidebar`,
`useCustomerChatUnread`, and `useRealtimeOrders`. Namespace per-user channels with the user id
(`notif_badge_${user.id}`) and always unsubscribe on unmount.

`useRealtimeOrders` **debounces into batches on purpose**: one admin action fans out into many
row updates (assigning a trip rewrites every order on it), and webhooks arrive in bursts.
Refetching per event would hammer the database and make tables flicker. Do not "simplify" it
into a per-event callback.

**Push is dual-protocol** (`send-push`): FCM HTTP v1 for Android/Chrome/desktop, raw
VAPID-signed Web Push for iOS 16.4+ PWAs — Apple does not support the FCM JS SDK in Safari,
so both paths are required. `user_device_tokens` stores one registration per user/device while
preserving registrations on the same user’s other devices; logout removes only the current device.
Delivery outcomes are logged to `notification_delivery_attempts` and stale tokens are pruned.

Support chat bot (`supportChatEngine.js`) is **regex-based**, runs authenticated, and queries
the signed-in customer's own orders. ~20 escalation patterns (complaint, damaged, refund,
lost, urgent, "talk to a human", …) bypass the bot and hand off to an admin.
`auto_resolve_stale_conversations()` closes threads that go quiet.

---

## PWA

Hand-rolled — there is **no** `vite-plugin-pwa`, Workbox, or equivalent. The PWA layer is
`public/manifest.json` + `public/sw.js` + the registration block in `index.html`.

| Element | File |
|---|---|
| Manifest | `public/manifest.json` — 10 icons (72→512, incl. maskable), 2 shortcuts |
| Service worker | `public/sw.js` — 3 versioned caches, 4 routing strategies, offline fallback, push |
| FCM worker | `public/firebase-messaging-sw.js` |
| Install prompt (Android/desktop) | `src/components/ui/InstallAppBanner.jsx` — `beforeinstallprompt` |
| Install prompt (iOS) | `src/components/ui/IosInstallBanner.jsx` — Add-to-Home-Screen guidance |

Both banners mount in `CustomerLayout`; `InstallAppBanner` also mounts in `AdminLayout`.
`InstallAppBanner` returns early on iOS and in standalone mode so the two never collide.

`swVersionPlugin` in `vite.config.js` does two build-time jobs:

1. Stamps `__BUILD_VERSION__` with a timestamp so browsers detect new deploys.
2. Walks the entry chunk's **static** import graph and injects the hashed JS/CSS filenames
   into `__PRECACHE_ASSETS__`, which `sw.js` precaches during `install`.

Route chunks reached only through `lazyWithRetry`'s dynamic imports are excluded on purpose —
precaching all of them would pull ~3 MB including the 985 KB `html2pdf` bundle. If you change
the placeholder names, change them in **both** files or offline boot silently degrades.

Precached assets live in `STATIC_CACHE`, so `staleWhileRevalidate` falls back to a cross-cache
`caches.match()` and `STATIC_CACHE` is never trimmed. Both behaviours are load-bearing.

The manifest declares **no `screenshots`**. They were removed (along with the 4.5 MB of PNGs
in `public/screenshots/`) at the client's request: the array's only effect is to give Chromium
a richer install dialog, and nothing in the app reads it. Re-adding screenshots means adding
back both the files and the array — the manifest is the only reference.

---

## Development workflow

```bash
npm run dev       # Vite dev server on :5173, auto-opens
npm run build     # → dist/, stamps build version + precache list into sw.js
npm run preview   # serve the production build
npm test          # smoke-check.mjs + axe-lint.mjs
npm run check     # test + build — run this before deploying
```

Deploy: Vercel. Migrations: Supabase CLI, applied from `supabase/migrations/` in timestamp order.

### `npm test` enforces invariants — it will fail if you

- delete `src/lib/{supabase,storage,database}.js`, `supabase/schema.sql`, or any Edge Function
- remove any of these from `schema.sql`: `track_order_public`, `cancel_own_pending_order`,
  `get_public_business_profile`, `get_sales_summary`, `cargo-photos`, `guard_profile_write`,
  `prepare_order_insert`, `guard_order_update`
- remove the selected-trip booking safeguards in `database.js`
  (`assertTripCapacity`, the "Selected trip is no longer available" error, `finalStatus = 'Assigned'`)
- reintroduce a silent trip-downgrade fallback (any `skip auto-assignment` text)
- ship JSX with a missing `alt`, an unlabelled `button`/`a`/`input`, an empty `aria-label`,
  or duplicate `id`s in one file

### Environment variables

Client (`VITE_`-prefixed → **inlined into the bundle, never put a secret here**):
`VITE_APP_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SUPABASE_PHOTOS_BUCKET`,
`VITE_FIREBASE_*` (5), `VITE_FIREBASE_VAPID_KEY`, `VITE_VAPID_PUBLIC_KEY`,
`VITE_PAYMONGO_PUBLIC_KEY`.

Edge Function secrets: `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`,
`SUPABASE_SERVICE_ROLE_KEY`, `FIREBASE_SERVICE_ACCOUNT_B64`, `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.

`.env` also holds `SUPABASE_PERSONAL_ACCESS_TOKEN` for CLI use. It is gitignored — keep it
that way, and never reference it from client code.

---

## Conventions

- New pages go in `src/pages/{auth,customer,admin,shared,public}/` and are lazy-loaded in
  `App.jsx` via `lazyWithRetry` (retries failed chunk loads after a redeploy), wrapped in
  `<Suspense>`.
- Never call `supabase.from(...)` from a page — add a function to `src/lib/database.js` and
  wrap it in `withTimeout()`.
- Import icons as `import { X } from 'lucide-react'`; the Vite plugin rewrites these to
  per-icon ESM imports automatically. Do not hand-write deep icon paths.
- Style with existing CSS custom properties from `src/styles/tokens.css`; both light and dark
  themes must work (`data-theme` on `<html>`).
- Schema changes: add a **new** timestamped file in `supabase/migrations/` and mirror the
  result into `schema.sql`. Never edit an applied migration. Update `docs/database_design.md` when
  columns change.
- Never auto-retry a non-idempotent request. `fetchWithRetry` in `supabase.js` retries `GET`
  only — a retried write would duplicate bookings or payments.
- Never trust a client-supplied price, weight, status, or payment amount. Enforce it in a
  trigger or RLS policy, or it is not enforced.
- Prefer leaving a value absent over backfilling a plausible one. An unweighed parcel has no
  price; an unanswered conversation has no response time. The schema says so deliberately.
