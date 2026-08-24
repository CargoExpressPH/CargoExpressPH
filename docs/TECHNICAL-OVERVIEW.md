# CargoExpress PH — Complete Technical Overview

**System title:** CargoExpress PH — Web-Based Cargo Delivery Booking and Tracking System
**Business domain:** Door-to-door sea cargo delivery on the Manila ⇄ Bohol route
**Architecture pattern:** Serverless Single-Page Application (SPA) with a Backend-as-a-Service (BaaS) core
**Document revised:** 5 August 2026
**Basis:** Direct analysis of the project source tree — `package.json`, `vite.config.js`,
`supabase/schema.sql`, the 84 files in `supabase/migrations/`, `database_design.md`, and the
full `src/` tree.

---

## 1. Executive Summary

CargoExpress PH is a **serverless, single-page web application** delivered as an installable
Progressive Web App (PWA). It replaces the traditional three-tier
(browser → application server → database) model with a **two-tier BaaS architecture**:

```
┌──────────────────────────────────────────────────────────────────┐
│  CLIENT TIER — React 19 SPA (PWA, served as static files)        │
│  • React Router v7 route tree, lazy-loaded per page              │
│  • Service Worker: offline precache + background push            │
│  Hosted on: Vercel (static CDN + SPA rewrite)                    │
└──────────────────────┬───────────────────────────────────────────┘
                       │  HTTPS / WebSocket
┌──────────────────────┴───────────────────────────────────────────┐
│  BACKEND TIER — Supabase (Backend-as-a-Service)                  │
│  • PostgreSQL + Row Level Security (authorization layer)         │
│  • PostgREST auto-generated REST API                             │
│  • GoTrue Authentication (JWT)                                   │
│  • Realtime (WebSocket / logical replication)                    │
│  • Storage (S3-compatible object store, private bucket)          │
│  • Edge Functions (Deno) — privileged server-side logic          │
└──────────────────────┬───────────────────────────────────────────┘
                       │
      ┌────────────────┼──────────────────┐
      ▼                ▼                  ▼
┌───────────┐   ┌──────────────┐   ┌──────────────┐
│ PayMongo  │   │ Firebase FCM │   │  Firestore   │
│ (GCash)   │   │ + Web Push   │   │ (photo       │
│           │   │              │   │  fallback)   │
└───────────┘   └──────────────┘   └──────────────┘
```

The defining architectural characteristic is that **there is no custom application server for
ordinary CRUD traffic**. The browser talks directly to PostgreSQL through PostgREST, and all
authorization is enforced *inside the database* using Row Level Security (RLS) policies and
`SECURITY DEFINER` trigger functions. A conventional server tier exists only where operations
require secrets or privileges the browser must never hold — payment capture, push notification
signing, and cross-cloud writes — and those are implemented as five Supabase Edge Functions.

### 1.1 What changed since the 2 August 2026 revision

This document previously carried a note stating that `CLAUDE.md` described a React Native /
Express / MySQL stack. **That note is withdrawn** — `CLAUDE.md` was corrected and now agrees
with this document. Both files are maintained against the same source tree.

Substantive system changes since the last revision:

| Area | Change |
|---|---|
| Schema | 14 → **16 tables**; `order_status_events` added; migrations 38 → **63** |
| Booking | Customer-declared weight **removed** — a new booking now has no price until an admin weighs the parcel |
| Order history | Append-only `order_status_events` timeline replaces inference from `updated_at` |
| Payments | Atomic pickup/delivery payment RPCs; the ledger is now the sole writer of order totals |
| Settlement | Warehouse-hold rules enforced in the database, with a Freight Collect exemption |
| Customer service | Conversation state machine rebuilt around four derived states |
| Storage | `cargo-photos` taken **fully private**; reads now require signed URLs |
| Realtime | Publication membership asserted by migration rather than assumed |
| PWA | `beforeinstallprompt` install banner, build-time asset precaching |

---

## 2. Frontend Framework

### 2.1 Core stack

| Concern | Technology | Version | Evidence |
|---|---|---|---|
| UI library | React | ^19.1.0 | `package.json` |
| DOM renderer | React DOM | ^19.1.0 | `package.json` |
| Routing | React Router DOM | ^7.14.2 | `src/App.jsx` |
| Build tool / bundler | Vite | ^6.3.0 | `vite.config.js` |
| React compilation | `@vitejs/plugin-react` | ^4.3.4 | `vite.config.js` |
| Language | JavaScript (ESM, JSX) — **not** TypeScript | — | `"type": "module"` |
| Styling | Hand-authored CSS with custom-property design tokens | — | `src/styles/` (24 files) |

The application is written in plain JavaScript with JSX. No CSS framework (Tailwind,
Bootstrap) and no component library (MUI, Chakra) is used; the entire visual system is
custom CSS organised into 24 stylesheets, with a design-token layer in
`src/styles/tokens.css` driving light/dark theming through CSS custom properties.

### 2.2 Supporting frontend libraries

| Library | Version | Purpose in the system |
|---|---|---|
| `lucide-react` | ^1.11.0 | Icon set (tree-shaken to per-icon ESM imports) |
| `framer-motion` | ^12.40.0 | Page transitions and micro-interactions |
| `@dnd-kit/core`, `/sortable`, `/utilities` | ^6.3.1 / ^10.0.0 / ^3.2.2 | Drag-and-drop reordering of coverage areas and company features in the admin panel |
| `react-qr-code` | ^2.2.0 | Renders tracking QR codes on printable waybills |
| `html2pdf.js` | ^0.14.0 | Client-side PDF export of reports and waybills (`src/lib/exportPdf.js`) |
| `browser-image-compression` | ^2.0.2 | Compresses proof-of-delivery photos before upload (max 0.8 MB, 1200 px) |
| `@supabase/supabase-js` | ^2.104.1 | Backend SDK (data, auth, realtime, storage, functions) |
| `firebase` | ^12.16.0 | Cloud Messaging client SDK (push only) |
| `dotenv` | ^17.4.2 | Environment loading for build/CLI scripts |

### 2.3 Application state management

No external state library (Redux, Zustand, MobX) is used. State is managed with React's
built-in primitives:

- **`AuthContext`** (`src/contexts/AuthContext.jsx`) — session, user profile, role flags
  (`isAdmin` / `isCustomer`), and the `login` / `register` / `logout` / `resetPassword` /
  `changePassword` / `changeEmail` / `refreshProfile` operations.
- **`ThemeContext`** (`src/contexts/ThemeContext.jsx`) — light/dark theme, persisted to
  `localStorage` under `cargoexpress_theme` and applied pre-paint by an inline script in
  `index.html` to eliminate flash-of-wrong-theme.
- **`ToastProvider`** (`src/hooks/useToast.jsx`) — application-wide notification toasts.
- Page-local state via `useState` / `useEffect`, with data fetched on mount through the
  `src/lib/database.js` data-access layer.

Seven custom hooks encapsulate cross-cutting behaviour:

| Hook | Responsibility |
|---|---|
| `useToast` | Toast queue and provider |
| `usePushNotification` | Dual-path push subscription (FCM / iOS Web Push) |
| `useCustomerChatUnread` | Customer-side unread badge, realtime-driven |
| `useRealtimeOrders` | **Debounced batch** subscription to `orders` changes |
| `useNetworkRecovery` | Refetch coordination after connectivity returns |
| `usePageTitle` | Document title per route |
| `useScrollLock` | iOS-safe background scroll lock for modals |

`useRealtimeOrders` batches deliberately. A single admin action fans out into many row updates
— assigning a trip touches every order on it, and a trip status cascade rewrites the whole
manifest — while PayMongo webhooks arrive in bursts when several customers pay together.
One callback per event would hammer the database and make tables flicker.

`useScrollLock` pins the body with `position: fixed` and restores the scroll offset, because
iOS Safari ignores `overflow: hidden` on `<body>`.

### 2.4 Routing and access control

`src/App.jsx` defines a `createBrowserRouter` data router with three route guards:

| Guard | Behaviour |
|---|---|
| `ProtectedRoute` | Requires an authenticated user **and** a profile whose `role` matches `requiredRole`; otherwise redirects to `/login` or to the user's own role home |
| `AuthRoute` | Prevents an already-authenticated user from reaching `/login`, `/register`, `/forgot-password` |
| `RootRedirect` | Sends `/` to `/admin` or `/customer` based on role |

Route groups:

- **Public** — `/track` (guest tracking), `/about` (public marketing page)
- **Auth** — `/login`, `/register`, `/forgot-password`, `/reset-password` (eagerly loaded)
- **Customer** — 15 routes under `/customer`
- **Admin** — 19 routes under `/admin`
- **Fallback** — `*` → 404 page

Two pages in `src/pages/shared/` — `ChangePasswordPage` and `ChangeEmailPage` — are mounted
under **both** role subtrees rather than duplicated.

Note that the guards are a **user-experience** control only. The authoritative access control
is the RLS policy set in PostgreSQL (§6.3); a user who bypasses the client guard still cannot
read or write rows the database refuses to release.

### 2.5 Build and performance engineering

`vite.config.js` implements three notable optimisations:

1. **`lucideTreeShakePlugin`** — a custom Vite transform that rewrites barrel imports
   (`import { Truck } from 'lucide-react'`) into direct per-icon ESM imports
   (`import Truck from 'lucide-react/dist/esm/icons/truck.mjs'`), preventing the entire icon
   library from entering the bundle.
2. **`swVersionPlugin`** — a two-job build hook (§2.6).
3. **Manual chunking** — `vendor-react` (react, react-dom, react-router-dom) and
   `vendor-supabase` are split into separately-cacheable chunks.

Additionally, every page component is code-split via `lazyWithRetry`
(`src/lib/lazyWithRetry.js`), a wrapper around `React.lazy` that retries a failed dynamic
import — this recovers the app when a chunk request fails after a redeploy invalidates the
previous build's asset hashes. A production build emits 77 chunks totalling ~3 MB, of which
the boot path is four files (~1.2 MB).

### 2.6 Progressive Web App layer

The PWA layer is **hand-authored**. The project uses no `vite-plugin-pwa`, no Workbox, no
`next-pwa`, and no CRA service worker; the same specification is implemented directly.

| Element | File | Function |
|---|---|---|
| Manifest | `public/manifest.json` | Installability: name, short_name, start_url, `display: standalone`, theme/background colour, 10 icons (72→512 px, incl. 2 maskable), 2 shortcuts |
| Service worker | `public/sw.js` | Precache, offline caching, push receipt, notification click routing |
| Registration | `index.html` | Automatic on `window.load`, scope `/`, hourly `registration.update()` |
| FCM worker | `public/firebase-messaging-sw.js` | Background FCM message handling |
| Install prompt — Android/Windows/macOS | `src/components/ui/InstallAppBanner.jsx` | Captures `beforeinstallprompt`, presents in-app install UI |
| Install prompt — iOS | `src/components/ui/IosInstallBanner.jsx` | Guides Add-to-Home-Screen (required for iOS web push) |

**Caching architecture.** Three versioned caches — `static`, `dynamic` (limit 80 entries),
and `images` (limit 60 entries) — with requests routed by type:

| Request class | Strategy |
|---|---|
| Supabase / API calls | Network-first; returns a 503 JSON envelope offline |
| Navigation requests | Network-first → cached response → cached `/index.html` → inline offline page |
| Images | Stale-while-revalidate (dedicated cache) |
| Google Fonts | Cache-first (immutable) |
| Other static assets | Stale-while-revalidate |

**Build-time precaching.** `swVersionPlugin` walks the entry chunk's *static* import graph in
`generateBundle` and injects the resulting hashed filenames into the `__PRECACHE_ASSETS__`
placeholder in `sw.js`, alongside a `__BUILD_VERSION__` timestamp. The service worker caches
that list during `install`, so a cold install followed by disconnection renders the real UI
rather than the offline fallback.

Route chunks reached only through dynamic import are deliberately excluded — precaching all 77
would pull ~3 MB including a 985 KB PDF-export bundle most sessions never load. Precaching is
per-item (`Promise.allSettled`) rather than `cache.addAll`, so one missing asset cannot void
the entire offline shell.

**Installability status.** All Chromium install criteria are satisfied: HTTPS, a valid
manifest, 192 px and 512 px icons whose real dimensions match their declarations, a registered
service worker, and a `fetch` handler. The app installs on Android, Windows, and macOS; iOS
requires the manual Add-to-Home-Screen flow, which is an Apple platform limitation.

**Known limitation, stated deliberately.** Offline support covers the *application shell*, not
business data — API calls return an offline envelope rather than stale cached records. This is
a correctness choice: displaying a stale shipment status or payment balance would be worse
than displaying none. Background Sync is not implemented.

`vercel.json` sends `Cache-Control: no-cache, no-store, must-revalidate` for `/sw.js` so the
worker itself is never served stale, sets `Service-Worker-Allowed: /`, and applies an SPA
rewrite (`/(.*)` → `/index.html`) so deep links resolve client-side. It also sets HSTS,
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, a `frame-ancestors 'none'` CSP,
and a restrictive `Permissions-Policy`.

---

## 3. Backend Framework

### 3.1 The BaaS core

There is **no Express, Django, Laravel, or equivalent application server.** The backend is
Supabase, which provides:

| Supabase component | Underlying technology | Role in CargoExpress PH |
|---|---|---|
| Database | PostgreSQL 15+ | System of record; also the authorization engine |
| REST API | PostgREST | Auto-generated CRUD + RPC endpoints over the schema |
| Auth | GoTrue | Email/password identity, JWT issuance, password reset |
| Realtime | Elixir/Phoenix over logical replication | WebSocket change streams, RLS-filtered |
| Storage | S3-compatible object store | Proof photos, company assets |
| Edge Functions | Deno runtime | The privileged server tier |

### 3.2 Supabase Edge Functions (the server tier)

Five functions, each deployed independently. JWT verification is declared per function in
`supabase/config.toml`:

| Function | `verify_jwt` | Responsibility |
|---|---|---|
| `paymongo-create-payment` | `true` | Registers a payment source, polls status, captures with the secret key, triggers reconciliation |
| `paymongo-webhook` | `false` | Receives PayMongo callbacks; authenticates by HMAC signature instead of JWT |
| `send-push` | `false`* | Dual-protocol push delivery (§7.3) |
| `store-photo-fallback` | — | Writes a data-URL photo copy to Firestore when Storage fails |
| `get-photo-fallback` | — | Reads a fallback photo back |

\* `send-push` disables gateway JWT verification only because its anonymous contact-inquiry
mode is required; authenticated events verify the caller JWT inside the function.

The webhook is public by necessity — PayMongo cannot present a user JWT — and compensates with
HMAC-SHA256 verification performed *before* the body is parsed. `send-push` is gateway-public
because the anonymous contact form needs its inquiry event; that event derives its payload from
the saved inquiry, while every other event verifies the caller JWT and authorization internally.

These functions exist for exactly one reason: they hold secrets. `PAYMONGO_SECRET_KEY`,
`PAYMONGO_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `FIREBASE_SERVICE_ACCOUNT_B64`, and
the VAPID key pair never reach the browser.

### 3.3 Client-side resilience layer

`src/lib/supabase.js` wraps the official SDK with production hardening:

- **15-second request timeout** on every call, so a hung socket surfaces as an error instead
  of an indefinite spinner.
- **`fetchWithRetry` retries `GET` only.** Retrying a write would duplicate a booking or a
  payment. This asymmetry is intentional and load-bearing.
- **`cache: 'no-store'`** to defeat intermediate caches on authenticated reads.
- **A custom token-refresh lock**, preventing concurrent refresh storms across tabs.

`src/lib/database.js` is the single data-access boundary — roughly 97 exported functions, each
wrapped in `withTimeout()`. Pages never call `supabase.from(...)` directly.

---

## 4. Database

### 4.1 Engine

PostgreSQL, managed by Supabase. `supabase/schema.sql` holds the complete DDL — tables, RLS
policies, functions, triggers, and indexes. `supabase/migrations/` holds 84 timestamped
incremental migrations forming the change history. `database_design.md` carries the ERD and
per-column documentation for thesis presentation.

Applied migrations are never edited; changes are additive files, mirrored into `schema.sql`.

### 4.2 Entity model

**16 tables.**

| Table | Purpose |
|---|---|
| `profiles` | User records, 1:1 with `auth.users`; carries `role` |
| `trips` | Scheduled voyages with capacity (kg) and optional per-trip pricing |
| `orders` | The booking aggregate — parties, cargo, status, money |
| `order_status_events` | Append-only status-change timeline |
| `payment_transactions` | The payment **ledger** — the only writer of order totals |
| `payment_attempts` | PayMongo gateway attempts, pre-reconciliation |
| `conversations` | One support thread per customer (UNIQUE on `customer_id`) |
| `chat_messages` | Messages within a thread |
| `contact_inquiries` | Public contact-form submissions |
| `notifications` | In-app notification feed |
| `user_device_tokens` | Push tokens (FCM tokens and `webpush:`-prefixed subscriptions) |
| `notification_delivery_attempts` | Per-device push delivery outcomes |
| `announcements` | Admin-published announcements |
| `company_information` | Singleton configuration row |
| `customer_feedback` | Post-delivery ratings (UNIQUE on `order_id`) |
| `activity_logs` | Admin audit trail, 7-day retention |

Consolidations already performed — these tables must not be reintroduced:

- `global_settings` → `company_information.default_price_per_kg`
- `coverage_regions` + `coverage_municipalities` → `company_information.coverage` (JSONB)
- Company features → `company_information.features` (JSONB)
- Chatbot analytics, FAQ, and visitor-assistant tables → dropped entirely

`company_information` is a singleton with the fixed id
`00000000-0000-0000-0000-000000000001`.

### 4.3 Denormalisation and deprecation decisions

- `orders` stores sender/receiver details **inline** rather than referencing `profiles`. A
  booking is a historical document; if a customer later edits their profile, the waybill must
  not retroactively change.
- `orders.amount_paid`, `remaining_balance`, and `payment_status` are **derived columns**,
  maintained by trigger from the `payment_transactions` ledger. They exist so that list views
  and reports avoid an aggregate per row.
- `reassignment_history` (JSONB) logs trip reassignments inline on the order.
- Columns prefixed `_deprecated_` (`orders._deprecated_payment_date`,
  `orders._deprecated_receipt_url`, `trips._deprecated_available_slots`) are retained for
  historical rows but are dead — they must not be read or populated
  (`20260803150000_deprecate_dead_columns.sql`).

### 4.4 Domain state machines

**Order status** — sequential, defined in `src/constants/status.js` and enforced server-side:

```
Pending Review → Pending → Assigned → Picked Up → In Transit
    → Arrived at Hub → Out for Delivery → Delivered
Cancelled — terminal, reachable from any state
```

`In Transit` and `Arrived at Hub` require an assigned trip. Every transition is appended to
`order_status_events` with `changed_at`, `changed_by`, and an optional note.

**Trip status** cascades to its orders:

| Trip status | Order effect |
|---|---|
| `scheduled` | — |
| `in_progress` | → `In Transit` |
| `arrived` | → `Arrived at Hub` |
| `completed` | Blocked while any order still owes money |
| `cancelled` | → `Cancelled` |

**Conversation service state** — four values, all *derived by trigger* from who spoke last
except `resolved`:

| Status | Meaning |
|---|---|
| `bot_active` | Bot handling — a new chat, or a customer returning to a resolved thread |
| `waiting` | The customer spoke last — our turn; this is the queue |
| `waiting_customer` | An admin spoke last — their turn |
| `resolved` | An admin said so |

A fifth value, `open`, was deleted in `20260804260000`: once every admin reply implies
"waiting on the customer", `open` described nothing that `assigned_admin_id` did not already
say. `escalated` is modelled as a **flag, not a state** — it answers "how urgent" while
`status` answers "whose turn". Conflating the two produced the original defect this migration
repaired. `bot_resolved` is nullable, and NULL means *unknown* rather than *false*.

### 4.5 Pricing and the removal of customer-declared weight

`orders.package_weight` — the customer's "estimated weight" — was removed in
`20260805130000_remove_package_weight.sql`. Weight now enters the system exactly once, from
the scale at pickup, as `actual_weight`.

The consequence is significant and is documented rather than hidden: **a newly created booking
has no price.** `shipping_cost` and `remaining_balance` are zero until an admin weighs the
parcel, because weight was the only quantity in the pricing formula. This is by design — a
customer-supplied estimate was precisely what generated the billing disputes the change
removes — but it means the booking confirmation can no longer quote a figure, and trip
capacity (`current_trip_weight`) counts only parcels that have actually been weighed.

Pricing resolution: `global_price_per_kilo()` reads
`company_information.default_price_per_kg` (fallback ₱70); `effective_trip_price(trip_id)`
prefers a trip's own `price_per_kg` when set.

Tracking numbers follow `CE-YYYYMMDD-NNNN`, generated by
`generate_order_tracking_number()`.

### 4.6 Settlement rules

Codified in `20260804100000_settlement_guards.sql` and mirrored client-side in
`canDispatchForDelivery()`:

1. Cargo always travels to the destination warehouse, paid or not.
2. An **unpaid** shipment is **held** at the warehouse — not dispatched for doorstep delivery
   until the balance is settled.
3. An admin may override by recording a **promise date**; the override is logged.
4. **Freight Collect (`payer_type = 'receiver'`) is exempt.** Payment is due at the door, so a
   COD order is unpaid by definition until delivery; gating it would deadlock it in the
   warehouse permanently.
5. A trip cannot be completed while any of its orders still owes money.

`Delivered` is deliberately **not** gated on payment. `orders.status` answers "where is the
cargo"; `payment_status` answers "where is the money". Keeping the two independent is what
makes the real state "delivered, balance owing, payment promised" representable. Gating
`Delivered` would strand such a parcel at `Out for Delivery` and show the customer a tracking
timeline that contradicts the box in their hands.

### 4.7 Indexing

29 indexes in `schema.sql`, targeting the actual access paths:

- **Foreign-key traversals** — `idx_orders_user_id`, `idx_orders_trip_id`,
  `idx_chat_messages_conversation_id`, `idx_order_status_events_order_id`,
  `idx_payment_transactions_order_id`, `idx_payment_attempts_order_id`
- **Filtered list views** — `idx_orders_status`, `idx_trips_status`,
  `idx_contact_inquiries_status`, `idx_payment_attempts_status`, `idx_profiles_role`
- **Sort keys** — `idx_orders_created_at`, `idx_trips_departure_date`,
  `idx_activity_logs_created_at`, `idx_contact_inquiries_created_at`
- **Partial indexes for badge counts** — `idx_notifications_user_unread`,
  `idx_chat_messages_unread`, `idx_orders_featured`
- **Full-text search** — `chat_messages_message_trgm_idx`, a trigram index supporting
  `search_conversation_messages()`
- **Correctness, not performance** — `unique_tx_ref`, a partial unique index on
  `payment_transactions.transaction_reference` that makes duplicate reconciliation impossible

Additional constraints and indexes were consolidated in
`20260803130000_constraints_and_indexes.sql`, including a trip date-ordering constraint
(`20260803131000`).

---

## 5. Storage

### 5.1 Primary — Supabase Storage

Bucket `cargo-photos`: **private**, 5 MB per object, `image/jpeg | png | webp` only.
Overridable via `VITE_SUPABASE_PHOTOS_BUCKET`.

Upload pipeline (`src/lib/storage.js`):

```
validate MIME + ≤10 MB
      ↓
compress  (browser-image-compression: ≤0.8 MB, 1200 px, JPEG, Web Worker)
      ↓
upload    (upsert: true)
      ↓
return a DESCRIPTOR, not a URL
```

```js
{ type: 'supabase_storage', bucket, path, content_type, size_bytes, created_at }
```

Descriptors — not URLs — are what get persisted into `orders.pickup_photos` and
`delivery_photos` (JSONB). Rendering calls `resolvePhotoUrl()` / `resolvePhotoUrls()`, which
mint a **signed URL with a 1-hour TTL**, falling back to a public URL only for buckets that
remain public. Storing a descriptor rather than a URL is what allowed the bucket to be taken
private later without rewriting historical rows.

Path convention:

```
pickup-proofs/CE-20260802-1234/pickup-1.jpg
delivery-proofs/CE-20260802-1234/delivery-1.jpg
receipts/CE-20260802-1234/receipt-1.jpg
gallery/gallery-<ts>.jpg          ← company assets, no order context
```

### 5.2 Storage access policies

The bucket was taken fully private in `20260804200000_lock_cargo_photos.sql`, completing a
transition staged one migration earlier. The `/object/public/` endpoint no longer serves it.

The reasoning is worth recording: object paths embed the tracking number, and tracking numbers
follow the predictable pattern `CE-YYYYMMDD-NNNN`. A public bucket therefore made every proof
photo and payment receipt in the system enumerable by anyone who could guess a date and a
counter.

After the migration, shipment evidence is readable only by:

- an **admin** session (`Admins manage cargo photos`);
- the **owning customer** (`Users read own cargo photos`), which resolves the order from the
  path segment via `public.safe_uuid()`;
- a **signed URL** minted for a photo the business explicitly featured publicly — the carve-out
  required by `get_featured_deliveries()`.

### 5.3 Secondary — Firestore fallback

If a Storage write fails, `store-photo-fallback` writes a ≤700 KB data-URL copy of the image
into Firestore, and `get-photo-fallback` reads it back. Firebase service-account credentials
live in Edge Function secrets and never reach the browser. This is the only use of Firestore
in the system — it is not a primary datastore.

---

## 6. Authentication and Authorization

### 6.1 Identity provider

Supabase Auth (GoTrue), email + password, JWT-based. There are **no OAuth providers and no
Firebase Auth**. A `handle_new_user` trigger creates the matching `profiles` row on signup,
and `sync_auth_email_to_profile` keeps `profiles.email` consistent when a user changes their
GoTrue email.

### 6.2 Authentication flows

`AuthContext` implements several deliberate behaviours that must be preserved:

- **Login signs the user out if the profile fetch fails.** There is no half-authenticated
  state in which a session exists without a known role.
- **`fetchProfile` races a 15-second timeout and retains an existing valid profile** on
  transient failure, rather than downgrading the user to a role-less placeholder that would
  bounce them out of their own dashboard.
- **An `isAuthAction` ref suppresses the duplicate profile fetch** that `onAuthStateChange`
  would otherwise trigger immediately after an explicit login.
- **Logout deletes this device's push token** and clears only `sb-*` localStorage keys, so
  unrelated preferences (theme, dismissed banners) survive.

### 6.3 Authorization — Row Level Security

RLS is enabled on all 16 tables, with **54 policies** in `schema.sql`. `public.is_admin()` is
the shared privilege helper.

| Table | Policy summary |
|---|---|
| `profiles` | Own read/update; admins read/update all; insert restricted to self |
| `orders` | Own read; admins full; anonymous read limited to `featured_on_website = true` |
| `order_status_events` | Own order's events; public timeline only via RPC |
| `trips`, `announcements`, `company_information` | Public read, admin write |
| `chat_messages` | Participants only; customers may flip `is_read` on **admin** messages only |
| `conversations` | Customer sees own; admins insert/update; customer updates constrained |
| `contact_inquiries` | Anonymous INSERT (the public form); admin read/update/delete |
| `notifications` | Own read/update/insert/delete; admins read and insert |
| `user_device_tokens` | Own full control; admins may insert |
| `customer_feedback` | Customer inserts and reads own; admins manage all |
| `payment_transactions` | Admins insert/select; customers read their own |
| `payment_attempts` | Admin only; the reconcile RPC is granted to `service_role` alone |
| `activity_logs` | Admin read; insert guarded by trigger; users may insert their own |
| `storage.objects` | Five policies implementing §5.2 |

Customer order INSERT is **value-constrained, not merely ownership-constrained**: the status
must be `Pending` or `Assigned`, and the weight, payment, and photo fields must be empty. A
customer cannot self-insert a paid, delivered order.

Function execute privileges were audited and tightened in
`20260804190000_function_privileges.sql`; blanket `GRANT EXECUTE ... TO public` is not the
default.

### 6.4 Server-side guards (database triggers)

Authorization that RLS cannot express — value coercion, derivation, and cross-row invariants —
lives in triggers:

| Trigger function | Guarantee |
|---|---|
| `guard_profile_write` | Non-admins forced to `role='customer'`; `id`/`email`/`role`/`created_at` reverted on update |
| `prepare_order_insert` | Server-generates the tracking number, nulls payment/weight/photo fields, computes `shipping_cost` |
| `guard_order_update` | Recomputes `shipping_cost` and `remaining_balance` on weight/trip/payment change; enforces the warehouse hold |
| `guard_trip_completion` | Blocks completion while any order on the trip owes money |
| `guard_chat_message_insert` | Overwrites `sender_id`/`sender_role` from `auth.uid()` — impersonation is impossible |
| `guard_conversation_update` | Restricts which conversation fields a client may change |
| `guard_activity_log_insert` | Prevents forged audit entries |
| `maintain_conversation_service_state` | Derives `conversations.status` from the last message |
| `stamp_conversation_resolved_at` / `stamp_inquiry_service_state` | Stamp service timestamps |
| `log_order_status_event` | Appends to `order_status_events` on every status change |
| `update_order_payment_totals` | Derives `amount_paid` / `remaining_balance` / `payment_status` from the ledger |

The consistent principle: **a client-supplied price, weight, status, or payment amount is
never trusted.** If a rule is not in a trigger or an RLS policy, it is not enforced.

### 6.5 Public-data protection

Anonymous surfaces are served by purpose-built RPCs rather than widened table grants:

| RPC | Exposes |
|---|---|
| `track_order_public()` | Masked tracking result. `mask_name()` renders "Juan Dela Cruz" as "Juan C."; phone, address, and payment fields are never returned |
| `get_public_order_events()` | Status timeline for a tracked order |
| `get_public_business_profile()` | Only the contact details intended to be public |
| `get_featured_deliveries()` | Orders explicitly flagged `featured_on_website` |
| `get_public_feedback()` | Non-hidden customer feedback |

Public tracking was further hardened in `20260723120000_harden_public_tracking.sql`, and the
broader policy set in `20260723181500_harden_rls_policies.sql`.

---

## 7. Realtime Features

### 7.1 Mechanism

Supabase Realtime streams PostgreSQL logical-replication events over WebSockets. Crucially,
**Realtime respects RLS** — a subscriber receives only rows they are permitted to read, so the
change stream cannot be used to bypass the policy set.

Published tables: `orders`, `conversations`, `chat_messages`, `notifications`,
`contact_inquiries`.

Publication membership is asserted idempotently by
`20260805140000_enable_realtime_publications.sql`. Before that migration, the publication was
configured through the Supabase dashboard but never captured in SQL — meaning a database
rebuilt from `schema.sql` alone would have had subscriptions that connected successfully and
then silently never fired.

### 7.2 Subscription inventory

| Location | Watches |
|---|---|
| `SupportChatPage` | Own conversation + messages |
| Admin `InboxPage` | Four channels: conversations, messages, assignment, inquiries |
| Customer `NotificationsPage` | Own notifications |
| `CustomerLayout` / `AdminLayout` | Badge counts, service-worker messages |
| `AdminNotificationCenter`, `Sidebar` | Notification and queue badges |
| `useCustomerChatUnread` | Unread admin messages |
| `useRealtimeOrders` | `orders`, debounced into batches |

Per-user channels are namespaced with the user id (`notif_badge_${user.id}`) and every
subscription unsubscribes on unmount.

### 7.3 Push notifications (out-of-app realtime)

`send-push` is **dual-protocol**, and both paths are required:

| Path | Target | Mechanism |
|---|---|---|
| FCM HTTP v1 | Android, Chrome, desktop | Firebase service-account JWT |
| Web Push (RFC 8030/8291/8292) | iOS 16.4+ installed PWAs | Raw VAPID-signed payloads |

Apple does not support the Firebase Messaging JS SDK in Safari, so an FCM-only implementation
would silently exclude every iPhone user. `usePushNotification` routes by platform: an
installed iOS PWA subscribes through `PushManager` and stores the subscription with a
`webpush:` prefix, which `send-push` uses to select the delivery protocol; every other
platform receives an FCM token. iOS Safari that is *not* installed is refused explicitly
rather than falling through to FCM, because Apple requires Home Screen installation before
Web Push is available.

Tokens live in `user_device_tokens` with a stable browser/PWA `device_id`: one account can keep
registrations on many devices, while account switching claims only the current device. Logout
removes the current device registration. Every delivery outcome is written to
`notification_delivery_attempts`, and stale tokens are pruned — the operational hardening added
in `20260711190000` and `20260824000726`.

### 7.4 Support chat and the rule-based assistant

`src/lib/supportChatEngine.js` is a **regex-based** assistant. There is no LLM and no
third-party chatbot service. It runs authenticated and queries only the signed-in customer's
own orders, so it can answer "where is my parcel" without any privileged data access.

Roughly 20 escalation patterns — complaint, damaged, refund, lost, urgent, "talk to a human",
and similar — bypass the bot entirely and hand the thread to an admin. Bot outcomes are
captured in `conversations.bot_resolved`, and `auto_resolve_stale_conversations()` closes
threads that go quiet.

Admin-side search is served by `search_conversation_messages()`
(`20260805100000_search_conversations_rpc.sql`), backed by the trigram index on
`chat_messages.message`, so the inbox can search message *contents* rather than only
participant names.

---

## 8. Payment System

### 8.1 Provider and methods

PayMongo, GCash channel. Three order payment methods:

| Method | Behaviour |
|---|---|
| `cash` | Recorded manually by an admin at pickup or delivery |
| `gcash` | Online, via the PayMongo source/capture flow |
| `paylater` | Deferred, with a `promised_payment_date` |

`orders.payment_preference` records what the customer *requested* at booking (default
`'unspecified'`); `payment_method` records what actually happened.

### 8.2 Key-splitting model

This is the system's core payment-security property:

| Key | Location | Capability |
|---|---|---|
| `VITE_PAYMONGO_PUBLIC_KEY` | Browser bundle | Create a source; read its status |
| `PAYMONGO_SECRET_KEY` | Edge Function secret | **Capture** payments |
| `PAYMONGO_WEBHOOK_SECRET` | Edge Function secret | Verify webhook signatures |

The browser can *initiate* a payment but can never *capture* one. Compromising the client
bundle yields no ability to move money.

### 8.3 Transaction flow

```
1. Browser  createGCashSource()          → PayMongo /v1/sources   [public key]
2. Browser  registerSource()             → Edge Fn; INSERT payment_attempts (pending)
3. User authorises in the GCash app
4a. PayMongo webhook → paymongo-webhook  → verify HMAC → capture → reconcile
4b. User returns    → pollPaymentStatus() → Edge Fn 'poll' → capture → reconcile
5. reconcile_paymongo_payment_attempt()   [SECURITY DEFINER, SELECT … FOR UPDATE]
       updates orders + payment_attempts, sets order status 'Picked Up'
```

Paths 4a and 4b are **redundant and idempotent** — whichever arrives first completes the
payment. This is a deliberate response to the most common real-world failure: the customer
closing the browser before the redirect returns.

### 8.4 Counter payments and ledger atomicity

`record_pickup_payment()` and `record_delivery_payment()`
(`20260803100000_atomic_order_payment.sql`) are the only correct way to take a manual payment.

Before this migration, the admin flow issued two separate round trips: an `UPDATE orders`
carrying client-computed totals, followed by an `INSERT payment_transactions` whose trigger
recomputed the same three columns. If the insert failed — for example on a unique-reference
collision from a retry or a webhook race — the order was left **marked paid with zero backing
ledger rows**, and because `get_sales_summary()` sums `orders.amount_paid`, the drift
propagated silently into revenue reporting.

The RPCs collapse this into one transaction that writes order *metadata* only; the ledger
trigger derives the money columns. The internal ordering is load-bearing:

1. `UPDATE orders` → fires `guard_order_update`, recomputing `shipping_cost` from the new
   `actual_weight`.
2. `INSERT payment_transactions` → fires `update_order_payment_totals`, which **reads** that
   `shipping_cost` to derive the remaining balance.

Reversing the two steps would derive the balance from a stale cost.

### 8.5 Idempotency and correctness controls

- Row locks (`SELECT … FOR UPDATE`) inside the reconcile RPC
- UNIQUE constraints on `source_id` and `payment_id`; partial unique index on
  `payment_transactions.transaction_reference`
- **Duplicate-payment guard** — refuses only when the order is already fully paid under a
  *different* reference, so a genuine retry is not blocked
- **Orphan recovery** — `payment_id` present but status ≠ `reconciled` triggers
  re-reconciliation, never a re-charge
- **Self-healing** — on a "not chargeable" response, the source is re-queried; if PayMongo
  reports `paid`, it reconciles under `auto_{sourceId}`
- **Webhook verification** — HMAC-SHA256 over `{t}.{rawBody}`, constant-time comparison,
  performed before the body is parsed

### 8.6 Payment state machine

`payment_attempts.status`: `pending → chargeable → reconciled`, with `failed` carrying
`last_error`.

`orders.payment_status` (`unpaid` / `partial` / `paid`) is **derived** by
`derive_payment_status` from the ledger and is never written directly by a client. Re-weighing
a delivered order recomputes it (`20260805120000_payment_status_on_weight_edit.sql`), so a
"Paid" badge cannot go stale after the shipping cost changes.

### 8.7 Financial and service reporting

| RPC | Returns |
|---|---|
| `get_sales_summary()` | Admin-gated: totals, per-method breakdown, 24-month series, and up to 100 unpaid/partial orders in a single round trip |

It is exposed through the admin **Sales & Reports** screen, which is a tab shell
(`SalesReportsPage`) composing three sections: Sales Overview, Unsettled Deliveries, and
Reports & Analytics. (A fourth, Customer Service, and its `get_service_summary()` RPC were
removed in `20260824090000_remove_service_reporting.sql`.)

---

## 9. APIs

### 9.1 Auto-generated REST API (PostgREST)

Every table is reachable at `/rest/v1/{table}` with filtering, ordering, pagination, and
embedded resource expansion. Access is governed entirely by RLS, so the same URL returns
different rows for different callers. All client access is funnelled through
`src/lib/database.js`.

### 9.2 Database RPC endpoints (`/rest/v1/rpc/{name}`)

Selected endpoints of architectural significance:

| RPC | Purpose |
|---|---|
| `track_order_public` | Anonymous, masked tracking |
| `get_public_order_events` | Public status timeline |
| `get_public_business_profile` | Public contact details |
| `get_featured_deliveries`, `get_public_feedback` | Public marketing content |
| `cancel_own_pending_order` | Customer self-service cancellation |
| `record_pickup_payment`, `record_delivery_payment` | Atomic counter payments |
| `reconcile_paymongo_payment_attempt` | Gateway reconciliation (`service_role` only) |
| `get_sales_summary` | Aggregated reporting |
| `search_conversation_messages` | Trigram-backed inbox search |
| `reassign_trip` | Trip reassignment with history logging |
| `create_admin_notifications_rpc` | Fan-out notification creation |
| `purge_old_activity_logs`, `auto_resolve_stale_conversations` | Retention and housekeeping |

### 9.3 Edge Function endpoints

`/functions/v1/{name}` — the five functions listed in §3.2.

### 9.4 Third-party APIs consumed

| Service | Endpoints | Auth |
|---|---|---|
| PayMongo | `/v1/sources`, `/v1/payments` | Public key (browser) / secret key (Edge) |
| Firebase FCM | HTTP v1 send API | Service-account JWT (Edge) |
| Web Push | Endpoint URLs from the subscription | VAPID signature (Edge) |
| Firestore | REST API | Service account (Edge) |

### 9.5 Realtime API

WebSocket channels over `/realtime/v1`, subscribed through `supabase-js`, filtered by RLS.

---

## 10. Folder Structure

```
CargoExpressPH-main/
├── index.html                  SPA entry; PWA meta, theme bootstrap, SW registration
├── package.json                Dependencies and scripts
├── vite.config.js              Build config + 2 custom plugins
├── vercel.json                 SPA rewrite, security headers, SW cache policy
├── docs/database_design.md     ERD + per-column documentation
├── CLAUDE.md                   Engineering operating rules
├── docs/TECHNICAL-OVERVIEW.md  This document
│
├── public/
│   ├── manifest.json           Web App Manifest
│   ├── sw.js                   Service worker
│   ├── firebase-messaging-sw.js
│   ├── icons/                  10 PWA icons (72→512, incl. maskable)
│
├── src/
│   ├── main.jsx                React root — StrictMode + ErrorBoundary
│   ├── App.jsx                 Router, guards, lazy route imports
│   ├── pages/
│   │   ├── auth/       (4)     Login, Register, ForgotPassword, ResetPassword
│   │   ├── customer/  (12)     Home, Orders, OrderDetail, BookShipment, Trips,
│   │   │                       Notifications, Profile, PersonalInfo, SupportChat,
│   │   │                       PaymentMethods, HelpGuidelines, AboutVersion
│   │   ├── admin/     (22)     Dashboard, Orders, OrderDetail, Trips, TripDetail,
│   │   │                       CreateTrip, Customers, CustomerDetail, Inbox,
│   │   │                       ContactInquiries, Announcements, ActivityLogs,
│   │   │                       CompanyInformation (+2 tabs), Feedback, Profile,
│   │   │                       SalesReports (+4 sections)
│   │   ├── shared/     (2)     ChangePassword, ChangeEmail — mounted under both roles
│   │   └── public/     (3)     Tracking, About, NotFound
│   ├── components/
│   │   ├── layout/     (3)     AdminLayout, CustomerLayout, Sidebar
│   │   └── ui/        (33)     Modals, charts, skeletons, error boundaries,
│   │                           StatusBadge, TrackingTimeline, CapacityTracker,
│   │                           CommandPalette, InstallAppBanner, IosInstallBanner …
│   ├── contexts/       (2)     AuthContext, ThemeContext
│   ├── hooks/          (7)     See §2.3
│   ├── lib/           (13)     Integration and data layer
│   ├── constants/      (2)     status.js (state machines + settlement rules), phLocations.js
│   ├── utils/          (3)     password.js, string.js, statusTimestamps.js
│   └── styles/        (24)     tokens.css drives light/dark theming
│
├── supabase/
│   ├── schema.sql              Full DDL — 16 tables, 54 policies, triggers, RPCs, 29 indexes
│   ├── config.toml             Per-function verify_jwt declarations
│   ├── migrations/    (84)     Timestamped change history
│   └── functions/      (5)     Deno Edge Functions
│
├── scripts/
│   ├── smoke-check.mjs         Architectural invariant checks
│   └── axe-lint.mjs            Static accessibility linting
│
└── docs/                       Design studies and diagnostic SQL
```

Note that `SalesPage`, `UnsettledDeliveriesPage`, `ReportsPage`,
`CompanyInfoCoverageTab`, and `CompanyInfoFeaturesTab` are **sections composed into parent
pages**, not independently routed screens.

### Layering summary

```
pages/ + components/     ← rendering only
        ↓
hooks/ + contexts/       ← client state and subscriptions
        ↓
lib/database.js          ← the single data-access boundary
        ↓
lib/supabase.js          ← hardened transport (timeout, GET-only retry)
        ↓
PostgREST / GoTrue / Realtime / Storage
        ↓
PostgreSQL — RLS + triggers = the authorization and business-rule engine
```

Each layer may call only the layer beneath it. The rule that pages never call
`supabase.from(...)` directly is enforced by convention and reviewed in `CLAUDE.md`.

---

## 11. Environment Configuration

**Client variables** (`VITE_`-prefixed — inlined into the bundle at build time, therefore
**never secret**):

`VITE_APP_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
`VITE_SUPABASE_PHOTOS_BUCKET`, `VITE_FIREBASE_*` (5 values), `VITE_FIREBASE_VAPID_KEY`,
`VITE_VAPID_PUBLIC_KEY`, `VITE_PAYMONGO_PUBLIC_KEY`.

**Edge Function secrets** (server-side only):

`PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`,
`FIREBASE_SERVICE_ACCOUNT_B64`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.

`.env` additionally holds `SUPABASE_PERSONAL_ACCESS_TOKEN` for Supabase CLI use. It is
gitignored and must never be referenced from client code.

The anon key is *designed* to be public — it identifies the project, and RLS is what protects
the data. This is why widening a table's anon policy is treated as a serious change (§6.5).

---

## 12. Development Workflow

```bash
npm run dev       # Vite dev server on :5173, auto-opens
npm run build     # → dist/, stamps build version + precache list into sw.js
npm run preview   # serve the production build locally
npm test          # smoke-check.mjs + axe-lint.mjs
npm run check     # test + build — the pre-deploy gate
```

Deployment is to Vercel as static assets. Database changes are applied with the Supabase CLI
from `supabase/migrations/` in timestamp order.

### Enforced invariants

`npm test` is not a unit-test suite; it is an **architectural guard**. It fails the build if a
developer:

- deletes `src/lib/{supabase,storage,database}.js`, `supabase/schema.sql`, or any Edge Function;
- removes any of `track_order_public`, `cancel_own_pending_order`,
  `get_public_business_profile`, `get_sales_summary`, `cargo-photos`, `guard_profile_write`,
  `prepare_order_insert`, or `guard_order_update` from `schema.sql`;
- removes the selected-trip booking safeguards from `database.js` (`assertTripCapacity`, the
  "Selected trip is no longer available" error, `finalStatus = 'Assigned'`);
- reintroduces a silent trip-downgrade fallback (any `skip auto-assignment` text);
- ships JSX with a missing `alt`, an unlabelled `button`/`a`/`input`, an empty `aria-label`,
  or duplicate `id`s within one file.

Encoding these as executable checks means the architectural decisions in this document cannot
be silently reverted by a later change.

---

## 13. Architectural Characteristics for Thesis Discussion

**Database-enforced authorization.** The system's most defensible property is that
authorization is not implemented in application code at all. RLS policies and `SECURITY
DEFINER` triggers mean a bypassed React guard, a crafted `fetch`, or a stolen anon key still
cannot read or write a row the database refuses to release. The client is treated as
fundamentally untrusted.

**Derived state over stored state.** Order payment totals, order status history, and
conversation service state are all *derived* by triggers rather than written by clients. Each
of these replaced an earlier design where the client computed the value, and each replacement
was prompted by a specific observed defect — payment drift into revenue reporting, history
inferred from `updated_at`, and a conversation state that conflated urgency with turn-taking.

**Honest absence over plausible defaults.** Several design decisions deliberately leave values
empty rather than filling them with estimates: an unweighed parcel has no price, an unanswered
conversation has no response time, and `bot_resolved` is NULL when unknown. The removal of
customer-declared weight is the clearest instance — it costs the booking confirmation a quoted
figure, and that cost was accepted because a fabricated estimate was the source of real
billing disputes.

**Idempotency as a first-class concern.** The payment system assumes messages arrive twice, out
of order, or not at all. Redundant webhook and polling paths, row-level locking, unique
constraints on gateway identifiers, orphan recovery, and self-healing reconciliation are all
responses to the observation that a user closing their browser mid-payment is the normal case,
not the exception.

**Progressive enhancement across hostile platforms.** The dual-protocol push implementation
exists because Apple does not support the FCM JS SDK in Safari; the iOS install banner exists
because Apple provides no install prompt; `useScrollLock` exists because iOS ignores
`overflow: hidden`. The system treats platform divergence as a requirement rather than a bug.

**Documented trade-offs.** Offline support covers the application shell but not business data,
trip capacity checking was removed intentionally so admins can overbook, and `Delivered` is not
gated on payment. Each is a considered decision with a recorded rationale rather than an
oversight — and each is documented at the point in the code where a future developer would be
tempted to "fix" it.
