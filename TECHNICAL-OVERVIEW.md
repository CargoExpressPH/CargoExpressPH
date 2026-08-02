# CargoExpress PH — Complete Technical Overview

**System title:** CargoExpress PH — Web-Based Cargo Delivery Booking and Tracking System
**Business domain:** Door-to-door sea cargo delivery on the Manila ⇄ Bohol route
**Architecture pattern:** Serverless Single-Page Application (SPA) with a Backend-as-a-Service (BaaS) core
**Document generated:** 2 August 2026
**Basis:** Direct analysis of the project source tree (`/Users/beasarong/Downloads/CargoExpressPH-main`)

---

## 1. Executive Summary

CargoExpress PH is a **serverless, single-page web application** delivered as an installable
Progressive Web App (PWA). It replaces the traditional three-tier
(browser → application server → database) model with a **two-tier BaaS architecture**:

```
┌──────────────────────────────────────────────────────────────────┐
│  CLIENT TIER — React 19 SPA (PWA, served as static files)        │
│  • React Router v7 route tree, lazy-loaded per page              │
│  • Service Worker: offline cache + background push               │
│  Hosted on: Vercel (static CDN + SPA rewrite)                    │
└──────────────────────┬───────────────────────────────────────────┘
                       │  HTTPS / WebSocket
┌──────────────────────┴───────────────────────────────────────────┐
│  BACKEND TIER — Supabase (Backend-as-a-Service)                  │
│  • PostgreSQL + Row Level Security (authorization layer)         │
│  • PostgREST auto-generated REST API                             │
│  • GoTrue Authentication (JWT)                                   │
│  • Realtime (WebSocket / logical replication)                    │
│  • Storage (S3-compatible object store)                          │
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

> **Documentation note.** The repository's `CLAUDE.md` describes the stack as
> React Native (Expo) + Node.js/Express + MySQL + Firebase Auth/Firestore. **That file is
> outdated and does not describe the current system.** The actual implementation, verified
> against `package.json`, `vite.config.js`, `supabase/schema.sql`, and the full `src/` tree,
> is React 19 (web) + Supabase (PostgreSQL) + Firebase Cloud Messaging (push only).
> Thesis documentation should follow the present document, not `CLAUDE.md`.

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

### 2.3 Application state management

No external state library (Redux, Zustand, MobX) is used. State is managed with React's
built-in primitives:

- **`AuthContext`** (`src/contexts/AuthContext.jsx`) — session, user profile, role flags
  (`isAdmin` / `isCustomer`), and the `login` / `register` / `logout` / `resetPassword` /
  `changePassword` / `refreshProfile` operations.
- **`ThemeContext`** (`src/contexts/ThemeContext.jsx`) — light/dark theme, persisted to
  `localStorage` under `cargoexpress_theme` and applied pre-paint by an inline script in
  `index.html` to eliminate flash-of-wrong-theme.
- **`ToastProvider`** (`src/hooks/useToast.jsx`) — application-wide notification toasts.
- Page-local state via `useState` / `useEffect`, with data fetched on mount through the
  `src/lib/database.js` data-access layer.

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
- **Customer** — 14 routes under `/customer`
- **Admin** — 17 routes under `/admin`
- **Fallback** — `*` → 404 page

Note that the guards are a **user-experience** control only. The authoritative access control
is the RLS policy set in PostgreSQL (§6.3); a user who bypasses the client guard still cannot
read or write rows the database refuses to release.

### 2.5 Build and performance engineering

`vite.config.js` implements three notable optimisations:

1. **`lucideTreeShakePlugin`** — a custom Vite transform that rewrites barrel imports
   (`import { Truck } from 'lucide-react'`) into direct per-icon ESM imports
   (`import Truck from 'lucide-react/dist/esm/icons/truck.mjs'`), preventing the entire icon
   library from entering the bundle.
2. **`swVersionPlugin`** — stamps a build timestamp into `dist/sw.js` at `closeBundle`,
   replacing the `__BUILD_VERSION__` placeholder so browsers reliably detect new deployments
   and invalidate stale caches.
3. **Manual chunking** — `vendor-react` (react, react-dom, react-router-dom) and
   `vendor-supabase` are split into separately-cacheable chunks.

Additionally, every page component is code-split via `lazyWithRetry`
(`src/lib/lazyWithRetry.js`), a wrapper around `React.lazy` that retries a failed dynamic
import — this recovers the app when a chunk request fails after a redeploy invalidates the
previous build's asset hashes.

### 2.6 Progressive Web App layer

| Element | File | Function |
|---|---|---|
| Manifest | `public/manifest.json` | Installability, icons (72→512 px, incl. maskable), theme colours |
| Service worker | `public/sw.js` | Offline caching + push receipt + notification click routing |
| FCM worker | `public/firebase-messaging-sw.js` | Background FCM message handling |
| iOS install prompt | `src/components/ui/IosInstallBanner.jsx` | Guides iOS users through Add-to-Home-Screen (required for iOS web push) |

The service worker maintains three versioned caches — `static`, `dynamic` (limit 80 entries),
and `images` (limit 60 entries) — and routes requests by type:

- **Navigation requests** → network-first, falling back to cached `/index.html` (SPA shell)
- **Images** → stale-while-revalidate
- **Static assets (JS/CSS)** → cache-first
- **Other** → stale-while-revalidate with cache trimming

`vercel.json` sends `Cache-Control: no-cache, no-store, must-revalidate` for `/sw.js` so the
worker itself is never served stale, and applies an SPA rewrite (`/(.*)` → `/index.html`) so
deep links resolve client-side.

---

## 3. Backend Framework

### 3.1 The BaaS core

There is **no Express, Django, Laravel, or equivalent application server.** The backend is
Supabase, which provides:

| Supabase component | Underlying technology | Role in CargoExpress PH |
|---|---|---|
| Database | PostgreSQL 15+ | System of record; also the authorization engine |
| REST API | PostgREST | Auto-generated CRUD + RPC endpoints from the schema |
| Auth | GoTrue | Email/password identity, JWT issuance, password reset |
| Realtime | Elixir/Phoenix over logical replication | WebSocket change streams |
| Storage | S3-compatible object store | Proof photos and company assets |
| Functions | Deno Edge Runtime | Privileged server-side logic (§3.2) |

Business logic that would conventionally live in a controller layer is instead implemented as
**PostgreSQL trigger functions and RPCs** (§6.4) — pricing, tracking-number generation, order
status transitions, payment total recalculation, and trip reassignment all execute inside the
database. This makes the rules unbypassable regardless of which client issues the request.

### 3.2 Supabase Edge Functions (the server tier)

Five Deno-runtime functions in `supabase/functions/` handle everything that requires secrets
or elevated privileges:

| Function | Trigger | Responsibility | Secrets used |
|---|---|---|---|
| `paymongo-create-payment` | Called by SPA (`supabase.functions.invoke`) | Registers a payment attempt, captures a chargeable PayMongo source, polls source status, and reconciles the order | `PAYMONGO_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| `paymongo-webhook` | HTTP POST from PayMongo | Verifies HMAC-SHA256 signature, handles `source.chargeable` and `payment.paid` events, self-heals stuck payments | `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` |
| `send-push` | Called by SPA on notification creation | Sends push via FCM HTTP v1 (Android/Chrome/desktop) **and** raw Web Push RFC 8030/8291/8292 (iOS 16.4+ PWA); logs delivery attempts; prunes stale tokens | `FIREBASE_SERVICE_ACCOUNT_B64`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |
| `store-photo-fallback` | Called on Storage failure | Writes a size-capped (700 KB) data-URL copy of a photo into Firestore as a redundancy path | `FIREBASE_SERVICE_ACCOUNT_B64` |
| `get-photo-fallback` | Called on Storage read failure | Retrieves the Firestore fallback copy | `FIREBASE_SERVICE_ACCOUNT_B64` |

Both PayMongo functions authenticate the caller's JWT, then verify authorization explicitly:
the caller must be an admin **or** the owner of the order being paid for
(`paymongo-create-payment/index.ts`, lines 200–214). Only after that check does the function
escalate to the service-role client.

### 3.3 Client-side resilience layer

`src/lib/supabase.js` wraps the Supabase client with production hardening that is
methodologically significant:

- **Selective retry.** A custom `fetchWithRetry` retries with exponential backoff (1 s → 2 s →
  4 s) on 5xx and 429 responses — **but only for idempotent `GET` requests.** Writes (`POST`,
  `PATCH`, `PUT`, `DELETE`) are never retried, because a network failure occurring *after* the
  server has committed a write would otherwise produce duplicate bookings or duplicate
  payments.
- **15-second timeout** via `AbortController`, linked to any caller-supplied abort signal.
- **`cache: 'no-store'`** forced on all PostgREST `GET` requests, preventing browsers from
  serving stale rows in newly opened tabs.
- **Custom token-refresh lock.** Uses `navigator.locks` when available, with an in-memory
  mutex fallback for HTTP contexts (local development) where the Lock Manager API is disabled,
  eliminating a concurrent-refresh race condition.
- **Realtime backoff** — reconnection delay `min(tries × 2000 + 1000, 15000)` ms.

---

## 4. Database

### 4.1 Engine

**PostgreSQL**, managed by Supabase. Schema of record: `supabase/schema.sql` (1,462 lines),
with 38 incremental migrations in `supabase/migrations/` spanning 24 May – 2 August 2026,
documenting the schema's evolution — useful as an appendix showing iterative development.

### 4.2 Entity model

Fourteen tables:

| # | Table | Purpose | Key relationships |
|---|---|---|---|
| 1 | `profiles` | User records; extends `auth.users` | PK = `auth.users.id`; `role ∈ {admin, customer}` |
| 2 | `trips` | Van/vessel trips with capacity and pricing | `created_by → profiles` |
| 3 | `orders` | Bookings/shipments — the central entity | `user_id → profiles`, `trip_id → trips` (nullable) |
| 4 | `announcements` | Admin broadcast messages | `author_id → profiles` |
| 5 | `notifications` | Per-user in-app notifications | `user_id → profiles` |
| 6 | `user_device_tokens` | FCM/Web Push subscriptions per device | `user_id → profiles`; `token` UNIQUE |
| 7 | `notification_delivery_attempts` | Push delivery audit (`sent`/`failed`/`skipped`) | → `notifications`, `profiles`, `user_device_tokens` |
| 8 | `conversations` | Support threads — **one per customer** (UNIQUE) | `customer_id → profiles` |
| 9 | `chat_messages` | Messages within a conversation | `conversation_id → conversations`, `sender_id → profiles` |
| 10 | `contact_inquiries` | Public contact-form submissions | none (anonymous) |
| 11 | `company_information` | Singleton CMS row (branding, pricing, coverage, features) | fixed UUID `…0001` |
| 12 | `activity_logs` | Audit trail across 6 modules | `admin_id → profiles`; 7-day retention |
| 13 | `customer_feedback` | Ratings 1–5, one per order (UNIQUE) | `order_id`, `customer_id` |
| 14 | `payment_transactions` | Ledger of individual payments | `order_id → orders`, `admin_id → profiles` |
| 15 | `payment_attempts` | PayMongo reconciliation state machine | `source_id` UNIQUE, `payment_id` UNIQUE, `order_id → orders` |

### 4.3 Denormalisation decisions

Three deliberate consolidations are recorded in the migrations and are worth defending in a
thesis methodology chapter:

1. **`global_settings` → merged into `company_information.default_price_per_kg`**
   (`20260715000000_consolidate_tables.sql`) — eliminates a table that only ever held one
   meaningful value, giving a single source of truth for pricing.
2. **`coverage_regions` + `coverage_municipalities` → `company_information.coverage` (JSONB)**
   — coverage areas are read as a whole tree and never queried relationally, so a nested JSONB
   document removes two tables and a join without loss of function.
3. **`company_information.features` (JSONB)** — same rationale for the marketing feature list.

Additional JSONB columns on `orders` — `pickup_photos`, `delivery_photos`,
`reassignment_history` — store append-only arrays that are always read with the parent row.

### 4.4 Domain state machines

**Order lifecycle** (`src/constants/status.js`, enforced by a `CHECK` constraint):

```
Pending Review → Pending → Assigned → Picked Up → In Transit
    → Arrived at Hub → Out for Delivery → Delivered
                    (Cancelled — terminal, reachable from any state)
```

**Trip lifecycle:** `scheduled → in_progress → arrived → completed`, plus `cancelled`.

Trip status changes cascade to orders via `TRIP_TO_ORDER_STATUS`:
`in_progress → In Transit`, `arrived → Arrived at Hub`, `cancelled → Cancelled`
(`bulkUpdateOrdersStatusByTrip` in `src/lib/database.js`).

**Payment status:** `unpaid → partial → paid`, recomputed by trigger (§6.4) rather than set
directly by any client.

### 4.5 Indexing

Fifteen indexes cover the hot query paths: `orders(user_id)`, `orders(trip_id)`,
`orders(status)`, `orders(tracking_number)`, `notifications(user_id)`, `trips(status)`,
`conversations(customer_id)`, `chat_messages(conversation_id)`,
`chat_messages(created_at)`, `contact_inquiries(created_at)`,
`user_device_tokens(user_id)`, four on `activity_logs`, three on `payment_attempts`, and a
composite on `notification_delivery_attempts(notification_id, attempted_at DESC)`.

A **partial unique index** enforces payment idempotency:
```sql
CREATE UNIQUE INDEX unique_tx_ref ON payment_transactions(transaction_reference)
  WHERE transaction_reference IS NOT NULL;
```

---

## 5. Storage

### 5.1 Primary — Supabase Storage

| Property | Value |
|---|---|
| Bucket | `cargo-photos` (configurable via `VITE_SUPABASE_PHOTOS_BUCKET`) |
| Visibility | **Private** (`public = FALSE`) |
| Size limit | 5,242,880 bytes (5 MB) per object, enforced by the bucket |
| Allowed MIME types | `image/jpeg`, `image/png`, `image/webp` |
| Cache control | `31536000` (1 year) on upload |

**Client-side pipeline** (`src/lib/storage.js`):

1. Validate MIME type against the whitelist and reject sources over 10 MB.
2. Compress with `browser-image-compression` — target ≤ 0.8 MB, max dimension 1200 px,
   normalised to JPEG, executed in a Web Worker so the UI thread is not blocked. On
   compression failure the original file is used rather than aborting the upload.
3. Upload to a structured, human-readable path with `upsert: true`.
4. Return a **storage descriptor object** (`{type, bucket, path, content_type, size_bytes,
   created_at}`) rather than a URL — the descriptor is what is persisted into the `orders`
   JSONB columns, so URLs can be re-derived if the access model changes.

**Path convention:**

```
pickup-proofs/CE-20260802-1234/pickup-1.jpg
delivery-proofs/CE-20260802-1234/delivery-1.jpg
receipts/CE-20260802-1234/receipt-1.jpg
gallery/gallery-1754110000000.jpg          ← company assets (no order context)
hero/hero-1754110000000.jpg
```

Folder segments are sanitised to `[a-zA-Z0-9._-]` and truncated to 60 characters.

### 5.2 Storage access policies

```sql
-- Admins: full control over the bucket
CREATE POLICY "Admins manage cargo photos" ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'cargo-photos' AND public.is_admin());

-- Customers: read only the photos belonging to their own orders
CREATE POLICY "Users read own cargo photos" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'cargo-photos'
    AND EXISTS (SELECT 1 FROM public.orders o
                WHERE o.id = public.safe_uuid((storage.foldername(name))[2])
                  AND o.user_id = auth.uid())
  );
```

The customer policy parses the order identifier out of the object path and joins it against
`orders`. `public.safe_uuid()` is a helper that returns `NULL` instead of raising when the path
segment is not a valid UUID — without it, a malformed object name would abort policy
evaluation with a cast error.

### 5.3 Secondary — Firestore fallback

If a Storage write fails, the SPA calls the `store-photo-fallback` Edge Function, which writes
a base64 data-URL copy (capped at 700 KB) into Cloud Firestore; `get-photo-fallback` retrieves
it. Firebase service-account credentials live only in Edge Function secrets and never reach
the browser. This provides delivery-evidence redundancy across two independent cloud providers
— defensible in a thesis as a data-durability measure for legally significant proof-of-delivery
images.

---

## 6. Authentication and Authorization

### 6.1 Identity provider

**Supabase Auth (GoTrue)** — email and password. Firebase Authentication is **not** used
anywhere in the system; the Firebase SDK is present solely for Cloud Messaging.

Session handling (`src/lib/supabase.js`):

| Setting | Value | Effect |
|---|---|---|
| `persistSession` | `true` | Session survives reloads (localStorage, `sb-` prefixed keys) |
| `autoRefreshToken` | `true` | JWT refreshed before expiry |
| `detectSessionInUrl` | `true` | Handles password-reset and magic-link callbacks |
| `lock` | custom | Prevents concurrent-refresh races (§3.3) |

### 6.2 Authentication flows

| Flow | Implementation |
|---|---|
| **Registration** | `supabase.auth.signUp()` → `createProfile()` inserts the `profiles` row with normalised structured address fields → profile fetched into context |
| **Login** | `signInWithPassword()` → profile fetched; **if the profile fetch fails the session is signed out**, preventing a half-authenticated state |
| **Logout** | Deletes this device's push token, clears React state, removes only `sb-*` localStorage keys (preserving PWA cache, theme, and drafts), then `signOut()` |
| **Password reset** | `resetPasswordForEmail()` with an origin-aware redirect to `/reset-password` |
| **Password change** | `auth.updateUser({ password })` |

Defensive details worth citing: `fetchProfile` races the request against a 15-second timeout
and, on transient failure, **preserves an existing valid profile** rather than downgrading the
user to a role-less placeholder — this prevents a network blip from ejecting an admin
mid-session. An `isAuthAction` ref suppresses the duplicate profile fetch that
`onAuthStateChange` would otherwise trigger during an explicit login or registration.

### 6.3 Authorization — Row Level Security

RLS is enabled on all 14 application tables. Two `SECURITY DEFINER` helpers underpin the
policy set:

```sql
CREATE FUNCTION public.is_admin() RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT role = 'admin' FROM public.profiles WHERE id = auth.uid()), FALSE);
$$;
```

Representative policy matrix:

| Table | Customer | Admin | Anonymous |
|---|---|---|---|
| `profiles` | read/update own | read/update all | — |
| `trips` | read all | full control | read all |
| `orders` | read own; insert own (constrained) | full control | read only `featured_on_website = true` |
| `notifications` | read/update/delete own | read all; insert any | — |
| `conversations` | read/insert/update own | read/insert/update all | — |
| `chat_messages` | read/insert in own conversation; may set `is_read` on admin messages only | full control | — |
| `contact_inquiries` | insert | read/update | **insert** (public form) |
| `company_information` | read | full control | read |
| `activity_logs` | insert own (`admin_id = auth.uid()`) | read/insert | — |
| `customer_feedback` | insert/read own | full control | read non-hidden |
| `payment_transactions` | read own (via order ownership) | full control | — |
| `payment_attempts` | — | full control | — |

The customer **INSERT** policy on `orders` is unusually strict — it constrains not just row
ownership but the initial values of price-sensitive columns:

```sql
CREATE POLICY "Users can create own orders" ON orders
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND status IN ('Pending', 'Assigned')
    AND actual_weight IS NULL
    AND payment_method IS NULL
    AND payment_status = 'unpaid'
    AND amount_paid = 0
    AND pickup_photos = '[]'::jsonb
    AND delivery_photos = '[]'::jsonb
  );
```

A customer therefore cannot self-declare an order as paid, pre-set a weight, or fabricate proof
photos at creation time.

### 6.4 Server-side guards (database triggers)

| Trigger / function | Fires | Guarantee enforced |
|---|---|---|
| `guard_profile_write` | BEFORE INSERT/UPDATE on `profiles` | Non-admins are forced to `role = 'customer'`; on update, `id`, `email`, `role`, `created_at` are reverted to their old values — **privilege escalation is structurally impossible** |
| `prepare_order_insert` | BEFORE INSERT on `orders` | Rejects creating orders for another user; requires weight > 0; server-generates the tracking number; nulls all payment/weight/photo fields; resolves origin/destination from the trip; computes `shipping_cost = weight × price` |
| `guard_order_update` | BEFORE UPDATE on `orders` | Re-derives origin/destination from the trip and recomputes `shipping_cost` and `remaining_balance` whenever weight, trip, or amount paid changes |
| `guard_chat_message_insert` | BEFORE INSERT on `chat_messages` | Overwrites `sender_id` with `auth.uid()` and `sender_role` with the sender's real role — a client cannot impersonate an admin in chat |
| `update_order_payment_totals` | AFTER INSERT/UPDATE/DELETE on `payment_transactions` | Recomputes `amount_paid`, `remaining_balance`, and `payment_status` from the transaction ledger — payment state is always derived, never asserted |
| `log_customer_chat_message` | AFTER INSERT on `chat_messages` | Writes an audit entry distinguishing conversation start from reply |
| `update_updated_at` | BEFORE UPDATE (4 tables) | Maintains `updated_at` |

**Pricing is computed exclusively server-side.** `global_price_per_kilo()` reads
`company_information.default_price_per_kg` (default 70 if absent);
`effective_trip_price(trip_id)` prefers a trip-specific `price_per_kg` and falls back to the
global rate. The client's own price calculation in `createOrder` is display-only — the trigger
overwrites it.

Tracking numbers are generated by `generate_order_tracking_number()`, which loops on the
format `CE-YYYYMMDD-NNNN` until it finds an unused value, guaranteeing uniqueness under
concurrency.

### 6.5 Public-data protection

Anonymous tracking is served by a `SECURITY DEFINER` RPC, not by table access:

```sql
CREATE FUNCTION public.track_order_public(p_tracking_number TEXT) RETURNS TABLE (...)
```

It returns status, route, weight, cost, and an estimated delivery date derived from
`trips.arrival_date`, but **never** phone numbers, addresses, or payment fields. Sender and
receiver names are passed through `mask_name()`, which collapses "Juan Dela Cruz" to
"Juan C." — a documented privacy control aligned with the Philippine Data Privacy Act
(RA 10173). Similarly, `get_public_business_profile()` exposes only the intended public
contact fields from the singleton company row.

---

## 7. Realtime Features

### 7.1 Mechanism

Supabase Realtime streams PostgreSQL logical-replication events to subscribed browsers over
WebSocket. Five tables are published:

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
ALTER PUBLICATION supabase_realtime ADD TABLE orders;
ALTER PUBLICATION supabase_realtime ADD TABLE contact_inquiries;
```

Realtime respects RLS: a subscriber receives only those change events whose rows they are
permitted to read.

### 7.2 Subscription inventory

| Channel | Location | Table(s) | Purpose |
|---|---|---|---|
| `chat_hybrid_{conversationId}` | `src/pages/customer/SupportChatPage.jsx` | `chat_messages`, `conversations` | Live customer chat + escalation state |
| `chat_admin_{conversationId}` | `src/pages/admin/InboxPage.jsx` | `chat_messages` | Live admin side of the active thread |
| `admin_conversations_insert` / `_update` | `src/pages/admin/InboxPage.jsx` | `conversations` | New threads and status changes appear without refresh |
| `admin_chat_messages_all` | `src/pages/admin/InboxPage.jsx` | `chat_messages` | Global unread indicator across all threads |
| `notifications_{userId}` | `src/pages/customer/NotificationsPage.jsx` | `notifications` | Live notification list |
| `notif_badge_{userId}` | `src/components/layout/CustomerLayout.jsx` | `notifications`, `chat_messages` | Customer navigation badges |
| `admin_notif_badge_{userId}` | `src/components/layout/AdminLayout.jsx` | 3 subscriptions | Admin navigation badges |
| `admin_notif_panel_{userId}` | `src/components/ui/AdminNotificationCenter.jsx` | `notifications` | Live notification dropdown |
| `admin_sidebar_badges` | `src/components/layout/Sidebar.jsx` | 2 subscriptions | Sidebar counters (orders, inquiries) |
| — | `src/hooks/useCustomerChatUnread.js` | `chat_messages` × 2 | Reusable unread-count hook |

Channel names are namespaced per user where the data is per-user, avoiding cross-user
subscription collisions in shared browser sessions.

### 7.3 Push notifications (out-of-app realtime)

The `send-push` Edge Function implements **dual-protocol** delivery, which is the key technical
detail: Firebase's FCM JavaScript SDK does not work in an iOS Safari PWA, so iOS is served by
raw Web Push instead.

| Platform | Protocol | Implementation |
|---|---|---|
| Android, Chrome, desktop | FCM HTTP v1 | Service-account JWT (RS256, signed via WebCrypto) exchanged for an OAuth2 access token, then `POST /v1/projects/{id}/messages:send` |
| iOS 16.4+ (installed PWA) | Web Push (RFC 8030/8291/8292) | VAPID-signed requests using P-256 keys held as Edge Function secrets |

Supporting infrastructure:

- `user_device_tokens` — one row per device, `token` UNIQUE; tokens are refreshed if older
  than 12 hours (`refreshFCMTokenIfNeeded`) and deleted on logout so a device is never left
  bound to a previous account.
- `notification_delivery_attempts` — records `sent` / `failed` / `skipped` per device with the
  provider message ID or error, giving an auditable delivery log.
- Stale-token pruning — tokens rejected by the provider are removed automatically.
- Foreground messages are intercepted by `onForegroundMessage` and rendered as in-app toasts
  rather than OS notifications; the service worker's `push` and `notificationclick` handlers
  cover the background case and deep-link into the relevant page.

### 7.4 Support chat and the rule-based assistant

`src/lib/supportChatEngine.js` (474 lines) is a **deterministic, database-aware chatbot** — not
an LLM integration. It runs inside the authenticated session and can safely query the signed-in
customer's own records. Its structure:

- **Escalation patterns** — ~20 regular expressions (complaint, damaged, refund, lost package,
  urgent, "talk to a human", supervisor, …) that bypass the bot entirely and set the
  conversation to await an admin.
- **Intent matchers** — regex-keyed handlers for greeting, booking status, payment details,
  tracking, delivery process, and related queries, each of which queries Supabase for the
  user's actual orders/payments and answers with real data.

Conversations are one-per-customer (UNIQUE constraint), with a `status` field supporting
`open` / `waiting` / closed states so the admin inbox can distinguish bot-handled threads from
those needing human attention.

---

## 8. Payment System

### 8.1 Provider and methods

**PayMongo** (`https://api.paymongo.com/v1`) — a Philippine payment gateway — provides GCash
e-wallet payments. Three payment methods exist in the domain model
(`orders.payment_method`):

| Method | Handling |
|---|---|
| `cash` | Recorded manually by an admin at pickup or delivery |
| `gcash` | Processed online through PayMongo |
| `paylater` | Deferred payment with a `promised_payment_date`, optionally with a downpayment |

### 8.2 Key-splitting model

| Key | Location | Capability |
|---|---|---|
| `VITE_PAYMONGO_PUBLIC_KEY` | Browser (`.env`) | Create a payment *source* and read its status only |
| `PAYMONGO_SECRET_KEY` | Edge Function secret | Capture payments (move money) |
| `PAYMONGO_WEBHOOK_SECRET` | Edge Function secret | Verify webhook authenticity |

The browser can *initiate* a payment but can never *capture* one. This separation is the
central security property of the payment design.

### 8.3 Transaction flow

```
 1. Client   createGCashSource()  ──► PayMongo /v1/sources        [public key]
                                      returns sourceId + checkout_url
 2. Client   registerSource()     ──► Edge Fn (action:'register')
                                      INSERT payment_attempts (status='pending')
 3. User     redirected to GCash, authorises payment
 4a. PayMongo ──webhook──► paymongo-webhook  (source.chargeable)
      verify HMAC-SHA256 ► capture ► reconcile RPC
 4b. User returns to app ► pollPaymentStatus() ──► Edge Fn (action:'poll')
      read source status ► capture if chargeable ► reconcile RPC
 5. reconcile_paymongo_payment_attempt()  [SECURITY DEFINER, row-locked]
      UPDATE orders  SET payment_status, amount_paid, remaining_balance,
                         payment_reference, status='Picked Up'
      UPDATE payment_attempts SET status='reconciled'
```

Paths 4a and 4b are **redundant and idempotent** — whichever completes first wins, and the
other detects the reconciled state and returns the existing result. This is the system's
answer to the classic mobile-payment failure mode where the user closes the browser before
being redirected back.

### 8.4 Idempotency and correctness controls

1. **Row-level locking** — the reconciliation RPC uses `SELECT … FOR UPDATE` on both the
   payment attempt and the order, serialising concurrent webhook and poll reconciliations.
2. **Unique constraints** — `payment_attempts.source_id` and `payment_attempts.payment_id` are
   both UNIQUE; `payment_transactions.transaction_reference` has a partial unique index.
3. **Duplicate-payment guard** — reconciliation is refused if the order is already fully paid
   under a *different* payment reference, while partial and unpaid orders remain open to
   further payments.
4. **No write retries** — the client fetch wrapper never retries non-idempotent methods (§3.3).
5. **Orphan recovery** — if a PayMongo capture succeeded but the database reconciliation
   failed, the attempt retains a `payment_id` with a non-`reconciled` status; the next
   invocation detects this and re-runs reconciliation instead of double-charging.
6. **Self-healing** — when a capture returns "not chargeable", the function re-queries the
   PayMongo source; if the source is in fact `paid`, it reconciles directly using a synthetic
   `auto_{sourceId}` reference.
7. **Webhook signature verification** — HMAC-SHA256 over `{timestamp}.{rawBody}`, compared
   against both the test (`te`) and live (`li`) signature components using a constant-time
   comparison, before any parsing of the payload.

### 8.5 Payment state machine

`payment_attempts.status`: `pending → chargeable → reconciled`, with `failed` as an error state
carrying `last_error`.

`orders.payment_status` is **never written directly by a client**. It is derived by the
`update_order_payment_totals` trigger from the `payment_transactions` ledger:

```
total_paid = Σ payment_transactions.amount WHERE payment_status IN ('paid','partial')
remaining  = max(0, shipping_cost − total_paid)
status     = remaining ≤ 0 ? 'paid' : total_paid > 0 ? 'partial' : 'unpaid'
```

Pay-later reconciliation is treated distinctly: the paid amount is a downpayment measured
against `estimated_cost`, so a balance may legitimately remain and the order is marked
`partial`. A full payment marks the order `paid` with `remaining_balance = 0`.

### 8.6 Financial reporting

`get_sales_summary()` — an admin-gated (`RAISE EXCEPTION` if not `is_admin()`)
`SECURITY DEFINER` RPC — returns a single JSONB payload containing: total revenue, per-method
collection totals (cash/GCash/pay-later), paid and unpaid totals, unpaid count, a 24-month
revenue series, and the 100 most recent unpaid or partially paid orders. Cancelled orders are
excluded from all aggregates. Computing this in one round trip avoids shipping the full order
table to the browser for client-side aggregation.

---

## 9. APIs

### 9.1 Auto-generated REST API (PostgREST)

Every table is exposed at `{SUPABASE_URL}/rest/v1/{table}` with filtering, ordering,
pagination, and embedded-resource syntax. Access is governed entirely by RLS. The SPA never
calls these endpoints directly — all access is funnelled through
**`src/lib/database.js` (1,875 lines, ~80 exported functions)**, the data-access layer.

Representative groupings:

| Domain | Functions |
|---|---|
| Profiles | `getProfile`, `getAdminProfile`, `updateProfile`, `createProfile` |
| Orders | `createOrder`, `getOrders`, `getOrderById`, `updateOrder`, `cancelOwnOrder`, `deleteOrder`, `getPendingGrouped` |
| Trips | `createTrip`, `getTrips`, `getTripById`, `updateTrip`, `deleteTrip`, `reassignTrip`, `getTripReassignments`, `bulkUpdateOrdersStatusByTrip` |
| Notifications | `getNotifications`, `markNotificationRead`, `markAllNotificationsRead`, `deleteNotification`, `deleteAllNotifications`, `getUnreadNotificationCount`, `createNotification`, `createAdminNotification` |
| Chat | `getOrCreateConversation`, `getAdminConversations`, `getMessages`, `getMessagesPage`, `sendMessage`, `markCustomerMessagesRead`, `markAdminMessagesRead`, `assignConversation`, `closeConversation`, `reopenConversation`, `setConversationWaitingAdmin` |
| Payments | `createPaymentAttempt`, `recordPaymentTransaction`, `recordAdditionalPayment`, `getPaymentTransactions`, `getPaymentTransactionsBatch` |
| Analytics | `getDashboardStats`, `getVanCapacity`, `getSalesData`, `getReportData` |
| CMS | `getCompanyInformation`, `updateCompanyInformation`, coverage/feature CRUD and ordering |
| Feedback | `submitFeedback`, `checkIfFeedbackExists`, `getPublicFeedback`, `getAdminFeedback`, `updateFeedbackVisibility` |
| Audit | `getActivityLogs`, `getActivityLogsByRecord` |

All calls are wrapped in `withTimeout(promise, 60000)`, so no request can hang the UI
indefinitely.

### 9.2 Database RPC endpoints (`/rest/v1/rpc/{name}`)

| RPC | Caller | Access | Purpose |
|---|---|---|---|
| `track_order_public` | Tracking page | `anon`, `authenticated` | Privacy-masked public tracking |
| `get_public_business_profile` | About page | `anon`, `authenticated` | Public contact details |
| `cancel_own_pending_order` | Customer | `authenticated` | Cancel only one's own `Pending` order |
| `reassign_trip` | Admin | `authenticated` (admin-checked internally) | Move an order to another trip with an audited reason |
| `get_sales_summary` | Admin | `authenticated` (admin-checked internally) | Aggregated financial report |
| `create_admin_notifications_rpc` | System | `authenticated` | Fan-out a notification to every admin |
| `reconcile_paymongo_payment_attempt` | Edge Functions | **`service_role` only** | Atomic payment reconciliation |

The last is granted exclusively to `service_role` — no browser-held key can invoke it.

### 9.3 Edge Function endpoints

`{SUPABASE_URL}/functions/v1/{name}`

| Endpoint | Method | Auth | Body |
|---|---|---|---|
| `paymongo-create-payment` | POST | Bearer JWT + owner/admin check | `{sourceId, amount, description, orderUpdate, action: 'register'\|'capture'\|'poll'}` |
| `paymongo-webhook` | POST | HMAC signature | PayMongo event payload |
| `send-push` | POST | Bearer JWT | `{userId, title, body, url}` |
| `store-photo-fallback` | POST | Bearer JWT | `{orderId, photoIndex, dataUrl}` |
| `get-photo-fallback` | POST | Bearer JWT | `{orderId, photoIndex}` |

### 9.4 Third-party APIs consumed

| API | Consumed by | Purpose |
|---|---|---|
| PayMongo `/v1/sources` | Browser (public key) | Create GCash source |
| PayMongo `/v1/payments` | Edge Functions (secret key) | Capture payment |
| PayMongo `/v1/sources/{id}` | Edge Functions | Verify source status |
| Google OAuth2 `/token` | Edge Functions | Service-account JWT → access token |
| FCM HTTP v1 `messages:send` | `send-push` | Android/Chrome/desktop push |
| Web Push endpoints | `send-push` | iOS PWA push |
| Firestore REST API | photo-fallback functions | Redundant photo storage |
| Google Fonts | Browser | Inter typeface |

### 9.5 Realtime API

WebSocket at `{SUPABASE_URL}/realtime/v1`, consumed through
`supabase.channel(name).on('postgres_changes', {event, schema, table, filter}, cb).subscribe()`.
See §7.2 for the full subscription inventory.

---

## 10. Folder Structure

```
CargoExpressPH-main/
│
├── index.html                     SPA entry; pre-paint theme script; SW registration
├── package.json                   Dependencies and scripts (dev/build/test/check/preview)
├── vite.config.js                 Build config + 2 custom plugins + manual chunking
├── vercel.json                    SPA rewrite + cache headers for sw.js / manifest.json
├── .env / .env.local              Environment variables (VITE_* → client; git-ignored)
├── CLAUDE.md                      ⚠ Outdated stack description — see §1 note
├── ui-ux-audit.md                 UI/UX audit findings (29 KB)
│
├── public/                        Static assets served verbatim
│   ├── manifest.json              PWA manifest
│   ├── sw.js                      Service worker: 3 caches, 4 strategies, push handling
│   ├── firebase-messaging-sw.js   FCM background message worker
│   ├── favicon.svg
│   ├── cargo-hero.png, "Manila and Bohol.png"
│   └── icons/                     10 PWA icons (72–512 px, incl. 2 maskable)
│
├── scripts/                       Quality gates (run by `npm test`)
│   ├── smoke-check.mjs            Build/import smoke test
│   └── axe-lint.mjs               Accessibility linting
│
├── src/
│   ├── main.jsx                   React root
│   ├── App.jsx                    Router, route guards, lazy imports, provider tree
│   │
│   ├── pages/                     53 route components
│   │   ├── auth/       (4)        Login, Register, ForgotPassword, ResetPassword
│   │   ├── customer/  (13)        Home, Orders, OrderDetail, BookShipment, Trips,
│   │   │                          Notifications, Profile, PersonalInfo, ChangePassword,
│   │   │                          SupportChat, PaymentMethods, HelpGuidelines, AboutVersion
│   │   ├── admin/     (20)        Dashboard, Orders, OrderDetail, Trips, CreateTrip,
│   │   │                          TripDetail, Customers, CustomerDetail, Sales,
│   │   │                          SalesReports, Reports, Announcements, Inbox,
│   │   │                          ContactInquiries, ActivityLogs, CompanyInformation
│   │   │                          (+2 tabs), Feedback, Profile
│   │   └── public/     (3)        Tracking, About, NotFound
│   │
│   ├── components/
│   │   ├── layout/     (3)        AdminLayout, CustomerLayout, Sidebar
│   │   └── ui/        (31)        Modals (Pickup, Delivery, TripAssign, TripReassign,
│   │                              AdditionalPayment, Confirm, Onboarding), charts
│   │                              (Donut, MiniBar, AnimatedCounter), feedback
│   │                              (Skeleton, EmptyState, 3 error boundaries),
│   │                              navigation (CommandPalette, Breadcrumb, Pagination),
│   │                              domain widgets (CapacityTracker, TrackingTimeline,
│   │                              StatusBadge, PrintDocument), a11y (FocusTrap),
│   │                              mobile (PullToRefresh, IosInstallBanner)
│   │
│   ├── contexts/       (2)        AuthContext (session + profile + role)
│   │                              ThemeContext (light/dark, localStorage-backed)
│   │
│   ├── hooks/          (5)        useToast, usePushNotification, useCustomerChatUnread,
│   │                              useNetworkRecovery, usePageTitle
│   │
│   ├── lib/           (14)        Integration & data layer
│   │   ├── supabase.js            Hardened client (retry, timeout, lock, no-store)
│   │   ├── database.js            ~80 data-access functions (1,875 lines)
│   │   ├── storage.js             Upload pipeline, path builder, URL resolution
│   │   ├── paymongo.js            GCash source creation, capture, polling
│   │   ├── firebase.js            Firebase app init (FCM only)
│   │   ├── firebase-messaging.js  Token lifecycle, foreground listener
│   │   ├── supportChatEngine.js   Rule-based, DB-aware support bot (474 lines)
│   │   ├── activityLog.js         Audit-trail writer
│   │   ├── announcements.js       Announcement helpers
│   │   ├── exportPdf.js           html2pdf wrapper
│   │   ├── address.js             PH address normalisation / composition
│   │   ├── lazyWithRetry.js       Chunk-load-failure-tolerant React.lazy
│   │   └── featureIcons.js        Icon name → component map
│   │
│   ├── constants/      (2)        status.js (order/trip state machines)
│   │                              phLocations.js (Philippine provinces/cities)
│   │
│   ├── utils/          (3)        password.js (strength), string.js,
│   │                              statusTimestamps.js
│   │
│   └── styles/        (24)        tokens.css (design tokens) + base, components,
│                                  layout-admin, layout-customer, pages, responsive,
│                                  auth, tracking, charts, data, feedback, validation,
│                                  animations-utils, print-document, viewport-hardening,
│                                  premium-refresh, admin-modern-refresh,
│                                  customer-mobile-refresh, …
│
├── supabase/
│   ├── schema.sql                 Complete DDL: 14 tables, RLS, triggers, RPCs (1,462 lines)
│   ├── config.toml                Supabase CLI project config
│   ├── migrations/     (38)       Incremental schema history, 24 May – 2 Aug 2026
│   └── functions/       (5)       Deno Edge Functions
│       ├── paymongo-create-payment/index.ts   (398 lines)
│       ├── paymongo-webhook/index.ts          (265 lines)
│       ├── send-push/index.ts                 (412 lines)
│       ├── store-photo-fallback/index.ts      (167 lines)
│       └── get-photo-fallback/index.ts        (132 lines)
│
└── dist/                          Vite production build output (generated)
```

### Layering summary

| Layer | Location | Responsibility |
|---|---|---|
| Presentation | `pages/`, `components/`, `styles/` | Rendering and user interaction |
| Application state | `contexts/`, `hooks/` | Cross-cutting client state |
| Data access | `lib/database.js`, `lib/storage.js`, `lib/paymongo.js` | All backend communication |
| Integration | `lib/supabase.js`, `lib/firebase*.js` | SDK configuration and hardening |
| Domain rules (client) | `constants/`, `utils/` | Status machines, validation, formatting |
| Domain rules (authoritative) | `supabase/schema.sql` triggers + RLS | Enforced rules that no client can bypass |
| Privileged services | `supabase/functions/` | Secret-holding operations |

---

## 11. Environment Configuration

| Variable | Scope | Purpose |
|---|---|---|
| `VITE_APP_URL` | Client | Canonical app URL (password-reset redirect fallback) |
| `VITE_SUPABASE_URL` | Client | Supabase project endpoint |
| `VITE_SUPABASE_ANON_KEY` | Client | Anonymous key — safe to expose; RLS is the real gate |
| `VITE_SUPABASE_PHOTOS_BUCKET` | Client | Storage bucket name |
| `VITE_FIREBASE_*` (5) | Client | FCM configuration |
| `VITE_FIREBASE_VAPID_KEY` | Client | Web Push public key |
| `VITE_PAYMONGO_PUBLIC_KEY` | Client | Source creation only |
| `PAYMONGO_SECRET_KEY` | **Edge secret** | Payment capture |
| `PAYMONGO_WEBHOOK_SECRET` | **Edge secret** | Webhook HMAC verification |
| `SUPABASE_SERVICE_ROLE_KEY` | **Edge secret** | Full database access, bypassing RLS |
| `FIREBASE_SERVICE_ACCOUNT_B64` | **Edge secret** | FCM v1 and Firestore authentication |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | **Edge secrets** | Web Push signing |

The `VITE_` prefix is the boundary: Vite inlines those values into the client bundle, so they
must contain nothing privileged. Everything capable of moving money, sending push on the
project's behalf, or bypassing RLS is held exclusively as an Edge Function secret.

---

## 12. Development Workflow

```bash
npm run dev       # Vite dev server, port 5173, auto-opens
npm run build     # Production build → dist/ (SW version stamped)
npm run preview   # Serve the production build locally
npm test          # smoke-check.mjs + axe-lint.mjs (accessibility)
npm run check     # test + build — the full pre-deployment gate
```

**Deployment:** Vercel. `vercel.json` supplies the SPA rewrite and cache headers.
**Database migrations:** Supabase CLI, applying files from `supabase/migrations/` in
timestamp order.

---

## 13. Architectural Characteristics for Thesis Discussion

**Defence-in-depth authorization.** Three independent layers must all agree before a
privileged action succeeds: React route guards (UX), RLS policies (row visibility), and
`SECURITY DEFINER` triggers (field-level invariants). The system's central claim is that a
malicious client holding a valid customer JWT still cannot escalate to admin, alter a price,
mark an order paid, or impersonate an admin in chat — every one of those is blocked in the
database, not the browser.

**Trusted computation placement.** Money amounts, tracking numbers, order status transitions,
and payment totals are all *computed* server-side and *displayed* client-side. The client's
own arithmetic is presentational; the trigger's result is authoritative.

**Idempotency under unreliable networks.** The system is designed for Philippine mobile
conditions: writes are never auto-retried, payment reconciliation is dual-path and row-locked,
chunk loads retry on failure, and profile fetches degrade gracefully rather than logging the
user out.

**Cross-provider redundancy.** Proof-of-delivery photos — the legally significant artefacts in
a cargo business — are stored primarily in Supabase Storage with an automatic Firestore
fallback, so a single provider outage cannot destroy delivery evidence.

**Platform-constraint engineering.** The dual-protocol push implementation exists because
Apple does not support the FCM JavaScript SDK in Safari PWAs; the project implements raw
VAPID-signed Web Push alongside FCM specifically so iOS users are not excluded.

**Privacy by design.** Public tracking is served by a masked, field-restricted RPC rather than
by loosening table permissions, keeping personally identifiable information out of anonymous
responses in line with RA 10173.

**Progressive enhancement.** Full functionality online; cached shell and assets offline; the
app continues to function with service workers, Firebase, or push permission entirely
unavailable — each integration degrades silently rather than failing the application.

---

*Prepared from direct source analysis. All file paths, line references, table definitions,
policy names, and function signatures cited above were verified against the repository at
`/Users/beasarong/Downloads/CargoExpressPH-main` on 2 August 2026.*
