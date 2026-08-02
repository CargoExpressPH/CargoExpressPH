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
| Styling | Hand-written CSS, 24 files in `src/styles/`, tokens in `tokens.css`. No Tailwind, no component library |
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
   ├── Storage         ← proof photos, company assets
   └── Edge Functions  ← the only place secrets live
          ├── paymongo-create-payment
          ├── paymongo-webhook
          ├── send-push
          ├── store-photo-fallback
          └── get-photo-fallback
```

The browser talks directly to PostgreSQL through PostgREST. **All authorization is enforced
in the database**, not in React. Route guards in `src/App.jsx` are UX only.

### Where logic belongs

| Kind of rule | Lives in |
|---|---|
| Pricing, tracking numbers, status transitions, payment totals | PostgreSQL triggers (`supabase/schema.sql`) — authoritative |
| Row/field access control | RLS policies + `SECURITY DEFINER` functions |
| Anything needing a secret (capture payment, sign push, write Firestore) | Edge Functions |
| Data fetching, orchestration, display formatting | `src/lib/database.js` |
| Rendering | `src/pages/`, `src/components/` |

Client-side price math is **display only** — `prepare_order_insert` recomputes and overwrites it.

---

## Folder structure

```
src/
  main.jsx              React root (StrictMode + ErrorBoundary)
  App.jsx               Router, guards (ProtectedRoute/AuthRoute/RootRedirect), lazy imports
  pages/
    auth/      (4)      Login, Register, ForgotPassword, ResetPassword — eagerly loaded
    customer/ (13)      Home, Orders, BookShipment, Trips, SupportChat, Profile, …
    admin/    (20)      Dashboard, Orders, Trips, Customers, SalesReports, Inbox,
                        ActivityLogs, CompanyInformation, Feedback, …
    public/    (3)      Tracking, About, NotFound
  components/
    layout/    (3)      AdminLayout, CustomerLayout, Sidebar
    ui/       (31)      Modals, charts, skeletons, error boundaries, StatusBadge,
                        TrackingTimeline, CapacityTracker, CommandPalette, …
  contexts/           AuthContext (session/profile/role), ThemeContext (light/dark)
  hooks/              useToast, usePushNotification, useCustomerChatUnread,
                      useNetworkRecovery, usePageTitle
  lib/                Integration + data layer — see below
  constants/          status.js (state machines), phLocations.js
  utils/              password.js, string.js, statusTimestamps.js
  styles/             24 CSS files; tokens.css drives theming

supabase/
  schema.sql          Full DDL: 14 tables, RLS, triggers, RPCs
  migrations/  (38)   Incremental history — add new changes here, never edit old files
  functions/    (5)   Deno Edge Functions

public/               manifest.json, sw.js, firebase-messaging-sw.js, icons/
scripts/              smoke-check.mjs, axe-lint.mjs (run by `npm test`)
```

### `src/lib/` map

| File | Role |
|---|---|
| `supabase.js` | Hardened client: 15 s timeout, GET-only retry, `no-store`, custom refresh lock |
| `database.js` | ~80 exported data-access functions — **all backend reads/writes go through here** |
| `storage.js` | Photo compress → validate → upload → descriptor; path builder |
| `paymongo.js` | GCash source creation, capture, polling |
| `firebase.js` / `firebase-messaging.js` | FCM app init and token lifecycle |
| `supportChatEngine.js` | Rule-based (regex) support bot — no LLM |
| `activityLog.js`, `announcements.js`, `exportPdf.js`, `address.js`, `lazyWithRetry.js`, `featureIcons.js` | Helpers |

---

## Database

14 tables. `supabase/schema.sql` is the single source of truth.

`profiles` · `trips` · `orders` · `announcements` · `notifications` · `user_device_tokens` ·
`notification_delivery_attempts` · `conversations` · `chat_messages` · `contact_inquiries` ·
`company_information` · `activity_logs` · `customer_feedback` · `payment_transactions` ·
`payment_attempts`

### Domain rules

- Routes are Manila → Bohol and Bohol → Manila.
- Trip capacity is in **kilograms**. The capacity *check* was deliberately removed
  (`20260526010000_remove_capacity_guard.sql`) so admins can overbook manually.
- Bookings can exist **without** a trip (`orders.trip_id` is nullable). No trip → status
  `Pending`; trip assigned → status `Assigned`.
- One conversation per customer (UNIQUE on `conversations.customer_id`).
- One feedback per order (UNIQUE on `customer_feedback.order_id`).

### Order status flow (`src/constants/status.js`)

```
Pending Review → Pending → Assigned → Picked Up → In Transit
    → Arrived at Hub → Out for Delivery → Delivered
Cancelled — terminal, reachable from any state
```

Trip status `scheduled → in_progress → arrived → completed` (+ `cancelled`) cascades to
orders: `in_progress → In Transit`, `arrived → Arrived at Hub`, `cancelled → Cancelled`.

### Consolidations already done — do not reintroduce these tables

- `global_settings` → `company_information.default_price_per_kg`
- `coverage_regions` + `coverage_municipalities` → `company_information.coverage` (JSONB)
- Company features → `company_information.features` (JSONB)

`company_information` is a **singleton** row with fixed id `00000000-0000-0000-0000-000000000001`.

### Triggers you must not bypass

| Trigger | Guarantees |
|---|---|
| `guard_profile_write` | Non-admins forced to `role='customer'`; `id`/`email`/`role`/`created_at` reverted on update |
| `prepare_order_insert` | Server-generates tracking number, nulls payment/weight/photo fields, computes `shipping_cost` |
| `guard_order_update` | Recomputes `shipping_cost` + `remaining_balance` on weight/trip/payment change |
| `guard_chat_message_insert` | Overwrites `sender_id`/`sender_role` from `auth.uid()` — impersonation impossible |
| `update_order_payment_totals` | Derives `amount_paid`/`remaining_balance`/`payment_status` from the `payment_transactions` ledger |

Pricing: `global_price_per_kilo()` reads `company_information.default_price_per_kg` (fallback 70);
`effective_trip_price(trip_id)` prefers the trip's own `price_per_kg`.

Tracking format: `CE-YYYYMMDD-NNNN`, generated by `generate_order_tracking_number()`.

---

## Authentication & authorization

**Supabase Auth**, email + password. No OAuth providers, no Firebase Auth.

`AuthContext` exposes `user`, `userProfile`, `loading`, `isAdmin`, `isCustomer`,
`login`, `register`, `logout`, `resetPassword`, `changePassword`, `refreshProfile`.

Behaviours that exist for a reason — preserve them when editing `AuthContext.jsx`:

- Login signs the user **out** if the profile fetch fails (no half-authenticated state).
- `fetchProfile` races a 15 s timeout and **keeps an existing valid profile** on transient
  failure instead of downgrading to a role-less placeholder.
- `isAuthAction` ref suppresses the duplicate profile fetch from `onAuthStateChange`.
- Logout deletes this device's push token and removes only `sb-*` localStorage keys.

### RLS

Enabled on all 14 tables; `public.is_admin()` is the shared helper. Summary:

- **profiles** — own read/update; admins all
- **orders** — own read; admins all; anon reads only `featured_on_website = true`
- **trips / announcements / company_information** — public read, admin write
- **chat_messages** — participants only; customers may only flip `is_read` on admin messages
- **contact_inquiries** — anon INSERT (public form), admin read/update
- **payment_attempts** — admin only; the reconcile RPC is granted to `service_role` alone

Customer order INSERT is value-constrained, not just ownership-constrained — status must be
`Pending`/`Assigned`, weight/payment/photo fields must be empty.

### Public data

Anonymous tracking uses the RPC `track_order_public()`, which masks names via `mask_name()`
("Juan Dela Cruz" → "Juan C.") and never returns phone, address, or payment fields.
`get_public_business_profile()` exposes only intended public contact details.
**Never widen table-level anon access to serve public pages — add or extend an RPC.**

---

## Storage

Bucket `cargo-photos` — **private**, 5 MB limit, `image/jpeg|png|webp` only.
Override via `VITE_SUPABASE_PHOTOS_BUCKET`.

Pipeline in `src/lib/storage.js`: validate MIME + ≤10 MB → compress
(`browser-image-compression`, ≤0.8 MB, 1200 px, JPEG, Web Worker) → upload with `upsert: true`
→ return a **descriptor object**, not a URL:

```js
{ type: 'supabase_storage', bucket, path, content_type, size_bytes, created_at }
```

Descriptors are what get persisted into `orders.pickup_photos` / `delivery_photos` (JSONB).
Call `resolvePhotoUrl()` / `resolvePhotoUrls()` to render.

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
(deferred with `promised_payment_date`).

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
`orders.payment_status` is **derived by trigger**, never written directly by a client.

Reporting: `get_sales_summary()` — admin-gated RPC returning totals, per-method breakdown,
24-month series, and up to 100 unpaid/partial orders in one round trip.

---

## Realtime & notifications

Published tables: `conversations`, `chat_messages`, `notifications`, `orders`,
`contact_inquiries`. Realtime respects RLS.

Subscriptions live in: `SupportChatPage`, admin `InboxPage` (4 channels), customer
`NotificationsPage`, `CustomerLayout`, `AdminLayout`, `AdminNotificationCenter`, `Sidebar`,
and `useCustomerChatUnread`. Namespace per-user channels with the user id
(`notif_badge_${user.id}`) and always unsubscribe on unmount.

**Push is dual-protocol** (`send-push`): FCM HTTP v1 for Android/Chrome/desktop, raw
VAPID-signed Web Push for iOS 16.4+ PWAs — Apple does not support the FCM JS SDK in Safari,
so both paths are required. Tokens live in `user_device_tokens` (refreshed if >12 h old,
deleted on logout); delivery outcomes are logged to `notification_delivery_attempts` and
stale tokens are pruned.

Support chat bot (`supportChatEngine.js`) is **regex-based**, runs authenticated, and queries
the signed-in customer's own orders. ~20 escalation patterns (complaint, damaged, refund,
lost, urgent, "talk to a human", …) bypass the bot and hand off to an admin.

---

## Development workflow

```bash
npm run dev       # Vite dev server on :5173, auto-opens
npm run build     # → dist/, stamps a build version into sw.js
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
`VITE_FIREBASE_*` (5), `VITE_FIREBASE_VAPID_KEY`, `VITE_PAYMONGO_PUBLIC_KEY`.

Edge Function secrets: `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`,
`SUPABASE_SERVICE_ROLE_KEY`, `FIREBASE_SERVICE_ACCOUNT_B64`, `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.

---

## Conventions

- New pages go in `src/pages/{auth,customer,admin,public}/` and are lazy-loaded in `App.jsx`
  via `lazyWithRetry` (retries failed chunk loads after a redeploy), wrapped in `<Suspense>`.
- Never call `supabase.from(...)` from a page — add a function to `src/lib/database.js` and
  wrap it in `withTimeout()`.
- Import icons as `import { X } from 'lucide-react'`; the Vite plugin rewrites these to
  per-icon ESM imports automatically. Do not hand-write deep icon paths.
- Style with existing CSS custom properties from `src/styles/tokens.css`; both light and dark
  themes must work (`data-theme` on `<html>`).
- Schema changes: add a **new** timestamped file in `supabase/migrations/` and mirror the
  result into `schema.sql`. Never edit an applied migration.
- Never auto-retry a non-idempotent request. `fetchWithRetry` in `supabase.js` retries `GET`
  only — a retried write would duplicate bookings or payments.
- Never trust a client-supplied price, weight, status, or payment amount. Enforce it in a
  trigger or RLS policy, or it is not enforced.
