<div align="center">

# 🚚 CargoExpress PH

### Web-Based Cargo Delivery Booking and Tracking System

**Connecting Bohol ⇄ Manila with door-to-door cargo logistics**

[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vitejs.dev)
[![Supabase](https://img.shields.io/badge/Supabase-Backend-3ECF8E?style=flat-square&logo=supabase&logoColor=white)](https://supabase.com)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-RLS%20Enforced-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![PWA](https://img.shields.io/badge/PWA-Installable-5A0FC8?style=flat-square&logo=pwa&logoColor=white)](https://web.dev/progressive-web-apps/)
[![PayMongo](https://img.shields.io/badge/PayMongo-GCash-00A1E0?style=flat-square)](https://www.paymongo.com)
[![Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-000000?style=flat-square&logo=vercel&logoColor=white)](https://vercel.com)

</div>

---

## 📖 Overview

Cargo forwarding between **Manila and Bohol** is traditionally coordinated over
Facebook Messenger and text message. Bookings live in chat threads, prices are
quoted verbally, and a customer who wants to know where their parcel is has to
ask someone and wait for a reply.

**CargoExpress PH** replaces that workflow with a single system of record. It is
an installable Progressive Web App serving two roles — **customer** and
**admin** — backed by a PostgreSQL database that is not merely a store but the
*authorization and business-rule engine* for the entire product.

The design commitment that shapes everything else: **the browser is never
trusted.** Pricing, status transitions, payment totals, settlement gates and
row-level access are all computed and enforced inside the database. The React
client is a presentation layer that can be lied to without consequence.

---

## ✨ Key Features

### For Customers

| Feature | Description |
|---|---|
| 📦 **Online Booking** | Door-to-door booking with full sender/receiver addressing and Philippine location data |
| 📍 **Real-Time Tracking** | Live status timeline driven by an append-only event log, updated over WebSockets |
| 🔓 **Public Tracking** | Track by number without an account — results are privacy-masked at the database layer |
| 💳 **GCash Payments** | Online settlement through PayMongo, plus cash and deferred "pay later" options |
| 🔔 **Push Notifications** | Native-style alerts on Android, desktop **and installed iOS PWAs** |
| 💬 **Support Chat** | Rule-based assistant that answers from the customer's own order data, with escalation to a human |
| 🧾 **Payment History** | Per-month statement view with full transaction detail and outstanding balances |
| 📱 **Installable App** | Add to home screen, launches standalone, no app store required |

### For Administrators

| Feature | Description |
|---|---|
| 📊 **Operations Dashboard** | Live order, trip and revenue overview |
| 🗓️ **Trip Management** | Scheduling, capacity tracking in kilograms, and cascading status updates |
| ⚖️ **Weigh-and-Price** | Price is computed from the scale reading at pickup — never from a customer estimate |
| 🚦 **Dispatch Gating** | Unpaid cargo is held at the destination warehouse unless an admin records a promise date |
| 📨 **Shared Inbox** | Support conversations and public contact inquiries in one queue |
| 📈 **Sales & Analytics** | Revenue, per-method payment breakdown, unsettled deliveries, exportable PDF reports |
| 🔍 **Audit Trail** | Every status change and administrative action recorded with actor and timestamp |

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 19 (JavaScript + JSX), React Router 7 data router |
| **Build** | Vite 6, `@vitejs/plugin-react` |
| **Styling** | Hand-written CSS — 36 files, design tokens, cascade layers, light/dark themes |
| **Backend** | Supabase — PostgreSQL, PostgREST, GoTrue, Realtime, Storage |
| **Database** | PostgreSQL — 18 tables, 57 RLS policies, 20 triggers, 88 tracked migrations |
| **Serverless** | 5 Deno Edge Functions (the only place secrets are held) |
| **Auth** | Supabase Auth — email/password, JWT, versioned legal consent at sign-up |
| **Payments** | PayMongo (GCash) — split public/secret key model |
| **Push** | Firebase Cloud Messaging **+** raw VAPID Web Push (dual protocol) |
| **Maps** | Leaflet / React-Leaflet |
| **Animation** | Framer Motion |
| **Testing** | Playwright (E2E) + custom static invariant, accessibility and design-token linters |
| **Hosting** | Vercel (static SPA with SPA rewrite) |

---

## 🏗️ System Architecture

```
┌──────────────────────────────────────────────────────┐
│   React 19 SPA  ·  Installable PWA  ·  Vercel CDN     │
└───────────────────────┬──────────────────────────────┘
                        │  HTTPS  +  WebSocket
┌───────────────────────▼──────────────────────────────┐
│                     SUPABASE                          │
│                                                       │
│  PostgreSQL   ← system of record AND authorization    │
│               (RLS · triggers · SECURITY DEFINER)     │
│  PostgREST    ← auto-generated REST / RPC API         │
│  GoTrue       ← authentication, JWT issuance          │
│  Realtime     ← RLS-respecting change streams         │
│  Storage      ← private bucket, signed URLs only      │
│                                                       │
│  Edge Functions (Deno) — secrets live here, only here │
│    ├── paymongo-create-payment   verify_jwt = true    │
│    ├── paymongo-webhook          HMAC-authenticated   │
│    ├── send-push                 dual-protocol push   │
│    ├── store-photo-fallback                           │
│    └── get-photo-fallback                             │
└──────────────────────────────────────────────────────┘
```

**Order lifecycle**

```
Pending Review → Pending → Assigned → Picked Up → In Transit
    → Arrived at Hub → Out for Delivery → Delivered
```

`Pending Cancellation` is a **hold**, not a step: a customer submits a reason,
an admin approves or rejects, and a rejection restores the exact prior status.
Cancellation is a *request*, not an act.

---

## 🎓 For Evaluators & Panelists

This section highlights the engineering decisions that carry the most technical
weight, with pointers to the code that implements them.

### 1. Authorization Is Enforced in the Database, Not the Client

Route guards in `src/App.jsx` exist purely for user experience. **Every**
security boundary is a PostgreSQL Row Level Security policy or a
`SECURITY DEFINER` function.

- **57 RLS policies** across all 18 tables, with a shared `public.is_admin()` helper.
- Customer order inserts are **value-constrained, not merely ownership-constrained** — status, weight, payment and photo fields are all forced server-side.
- **20 triggers** enforce invariants that a compromised client cannot bypass, including:
  - `guard_profile_write` — a self-registered profile *cannot* become an admin
  - `prepare_order_insert` — server-generates the tracking number and nulls any client-supplied price or weight
  - `guard_order_update` — recomputes cost and balance; refuses to dispatch unweighed cargo
  - `guard_chat_message_insert` — overwrites sender identity from `auth.uid()`, making impersonation structurally impossible

> **Demonstrable claim:** a hostile client can submit any payload it likes. It
> cannot set its own price, grant itself admin, or forge a chat message,
> because none of those values are ever read from the request.

### 2. Anonymous Access Is Served by Purpose-Built RPCs, Never Widened Grants

Public tracking is a genuine privacy surface: anyone with a tracking number can
query it. Rather than loosening table permissions, five dedicated functions
expose exactly what is intended and nothing more:

`track_order_public` · `get_public_order_events` · `get_public_business_profile` ·
`get_featured_deliveries` · `get_public_feedback`

`track_order_public()` applies a `mask_name()` transform — *"Juan Dela Cruz"*
is returned as *"Juan C."* — and **never** returns phone number, address, or
payment fields.

### 3. Payment Integrity: Idempotent, Race-Safe, Double-Confirmed

GCash settlement is reconciled through **two redundant paths** that are safe to
run in either order or simultaneously:

1. **Webhook** — PayMongo calls `paymongo-webhook`, authenticated by HMAC-SHA256 over `{timestamp}.{rawBody}` with a **constant-time comparison, verified before the body is parsed**.
2. **Polling** — if the customer closes the browser before redirect, the client polls on return.

Whichever lands first wins. Correctness is protected by:

- `SELECT … FOR UPDATE` row locks inside `reconcile_paymongo_payment_attempt()`
- UNIQUE constraints on `source_id` and `payment_id`, plus a partial unique index on transaction reference
- Orphan recovery — a payment captured but not reconciled is **re-reconciled, never re-charged**
- A **key-split security model**: the browser holds only a publishable key able to *create* a payment source; the secret key that can *capture funds* exists solely as an Edge Function secret and is never shipped to a client

**Money is derived, never asserted.** `amount_paid`, `remaining_balance` and
`payment_status` are computed by trigger from the `payment_transactions` ledger.
No client writes them.

### 4. A Deliberate Distinction Between "Unpriced" and "Paid"

Customer-declared package weight was **removed** from the system. Weight enters
exactly once — from the scale, at pickup — because customer estimates were the
root cause of billing disputes.

The consequence is faced honestly rather than papered over: **a new booking has
no price.** ₱0 therefore means *"not priced yet"*, never *"paid"*. Both look
identical to a naive `balance <= 0` check, and conflating them once allowed
unweighed cargo through the dispatch gate. Settlement is modelled as **three
states** — `unpriced` / `settled` / `owing` — never a boolean, and the server
refuses to dispatch an unweighed order for delivery regardless of payer type.

### 5. Dual-Protocol Push Notifications

Apple does not support the Firebase JS SDK in Safari, so a single push
implementation cannot reach every user. `send-push` therefore speaks **two
protocols from one function**:

- **FCM HTTP v1** — Android, Chrome, desktop
- **Raw VAPID Web Push** — iOS 16.4+ installed PWAs, with JWT signing, ECDH key agreement, HKDF-SHA-256 derivation and AES-128-GCM encryption implemented directly against RFC 8291

Delivery outcomes are logged to `notification_delivery_attempts`, stale device
tokens are pruned automatically, and the Android notification badge is a
transparent alpha-mask silhouette — because Android tints the badge's alpha
channel and renders a full-colour icon as a solid white square.

### 6. Storage Is Private by Construction

Proof-of-pickup and proof-of-delivery photos are stored under paths containing
the tracking number, and tracking numbers follow a predictable
`CE-YYYYMMDD-NNNN` format. A public bucket would therefore make **every proof
photo and receipt enumerable by anyone**.

The bucket is fully private. Reads require an admin session, ownership of the
order, or a deliberately minted **1-hour signed URL**. Images are validated,
compressed in a Web Worker, and persisted as structured descriptors rather than
raw URLs.

### 7. Engineering Discipline

- **88 timestamped migrations** — the complete schema history is reproducible and auditable; applied migrations are never edited
- **Automated quality gates** in `npm test`:
  - `smoke-check` — asserts that critical security functions and booking safeguards still exist in the schema and data layer
  - `axe-lint` — fails the build on missing `alt` text, unlabelled controls, empty ARIA labels or duplicate IDs
  - `token-lint` — fails the build on references to undefined CSS custom properties, a class of silent bug that once shipped invisible white-on-white text
- **Playwright E2E suite** covering the full admin↔customer journey, the dispatch gate, and responsive layouts
- **Hand-rolled PWA** — no `vite-plugin-pwa`; the service worker uses three versioned caches, four routing strategies, an offline fallback and build-time precache injection that deliberately excludes heavy lazy chunks

---

## 🚀 Getting Started

### Prerequisites

- **Node.js 18+** (native `fetch` is required by the tooling)
- A **Supabase** project
- **Supabase CLI** — for applying migrations
- A **PayMongo** account and a **Firebase** project, for payments and push

### Installation

```bash
# 1. Clone
git clone https://github.com/CargoExpressPH/CargoExpressPH.git
cd CargoExpressPH

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env      # then fill in your own keys

# 4. Apply the database schema
supabase link --project-ref <your-project-ref>
supabase db push

# 5. Deploy the Edge Functions
supabase functions deploy

# 6. Run
npm run dev               # → http://localhost:5173
```

### Environment Variables

Client variables are prefixed `VITE_` and are **inlined into the bundle** —
never place a secret among them.

| Variable | Purpose |
|---|---|
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Supabase project connection |
| `VITE_FIREBASE_*` | Firebase Cloud Messaging configuration |
| `VITE_PAYMONGO_PUBLIC_KEY` | Publishable key — can create a source, cannot capture funds |
| `VITE_APP_URL` | Public origin, used for redirects |

Server-side secrets live **only** as Edge Function secrets:
`PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`,
`FIREBASE_SERVICE_ACCOUNT_B64`, `VAPID_PRIVATE_KEY`.

---

## 📜 Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Vite dev server on port 5173 |
| `npm run build` | Production build; stamps the service-worker version and precache list |
| `npm run preview` | Serve the production build locally |
| `npm test` | Smoke, accessibility and design-token linters |
| `npm run check` | `test` + `build` — **run this before deploying** |
| `npm run test:e2e` | Playwright end-to-end suite |
| `npm run test:e2e:ui` | Playwright interactive UI mode |

---

## 📂 Project Structure

```
CargoExpressPH/
├── src/
│   ├── pages/              43 route components
│   │   ├── auth/      (4)  Login, Register, Forgot / Reset Password
│   │   ├── customer/ (12)  Home, Booking, Orders, Tracking, Payments, Support
│   │   ├── admin/    (21)  Dashboard, Orders, Trips, Inbox, Reports, Settings
│   │   ├── shared/    (2)  Change Password / Change Email
│   │   └── public/    (4)  Public Tracking, About, Legal, 404
│   ├── components/         40 UI components + layouts
│   ├── contexts/           Auth and Theme providers
│   ├── hooks/         (8)  Toast, push, realtime orders, network recovery …
│   ├── lib/                Integration layer — all data access lives here
│   ├── constants/          Status state machines, settlement rules, PH locations
│   └── styles/       (36)  Token-driven CSS in explicit cascade layers
├── supabase/
│   ├── schema.sql          Full DDL — 18 tables, RLS, triggers, RPCs
│   ├── migrations/   (88)  Incremental, timestamped, append-only history
│   └── functions/     (5)  Deno Edge Functions
├── public/                 PWA manifest, service workers, icons
├── scripts/                Build-time invariant and accessibility linters
├── tests/                  Playwright end-to-end suite
└── docs/                   Architecture studies, audits, ERD documentation
```

---

## 🧪 Testing & Quality Gates

```bash
npm test          # static invariants, accessibility, design tokens
npm run test:e2e  # full Playwright journey
npm run check     # everything, plus a production build
```

The E2E suite drives a **real** Supabase project and creates data on every run.
Point it at a development or staging project — never production.

---

## 📚 Documentation

Deeper technical documentation lives in [`docs/`](./docs):

| Document | Contents |
|---|---|
| [`TECHNICAL-OVERVIEW.md`](./docs/TECHNICAL-OVERVIEW.md) | Full system walkthrough |
| [`database_design.md`](./docs/database_design.md) | ERD and per-column documentation |
| [`SECURITY_AUDIT_2026-08-17.md`](./docs/SECURITY_AUDIT_2026-08-17.md) | Security audit findings and verification |
| [`GOLIVE_GUIDE.md`](./docs/GOLIVE_GUIDE.md) | Production deployment checklist |
| [`ui-ux-audit.md`](./docs/ui-ux-audit.md) | Interface and accessibility review |
| [`WHY_FIX_TECHNICAL_DEBT.md`](./docs/WHY_FIX_TECHNICAL_DEBT.md) | Rationale for the refactoring programme |

`CLAUDE.md` in the repository root is the working engineering brief — the
authoritative description of architecture, invariants and conventions.

---

## 🌐 Deployment

The application deploys to **Vercel** as a static SPA with a catch-all rewrite
(`vercel.json`). Database changes are applied through the Supabase CLI in
migration timestamp order, and Edge Functions are deployed separately.

```bash
npm run check                     # never deploy without this passing
supabase db push                  # apply pending migrations
supabase functions deploy         # deploy Edge Functions
```

---

## 👥 Authors

> _To be completed by the project team._

| | |
|---|---|
| **Researchers** | _Name, Name, Name_ |
| **Adviser** | _Name_ |
| **Institution** | _Institution, Department_ |
| **Academic Year** | _e.g. A.Y. 2026–2027_ |

---

## 📄 License

This project was developed as an undergraduate thesis / capstone requirement.
All rights reserved by the authors and the institution unless stated otherwise.

---

<div align="center">

**CargoExpress PH** — Manila ⇄ Bohol
*Built with React, Supabase and PostgreSQL.*

</div>
