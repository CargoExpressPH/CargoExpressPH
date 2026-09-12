# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CargoExpress PH — a React 19 + Supabase (Postgres) cargo booking/tracking PWA for a Manila↔Bohol
freight route. Two roles (`customer`, `admin`) share one codebase, routed in `src/App.jsx`.

The one fact that governs almost every design decision here: **the browser is never trusted.**
Pricing, status transitions, payment totals, settlement gating and row-level access are all
computed and enforced in PostgreSQL (RLS policies + triggers + `SECURITY DEFINER` RPCs), not in
React. When changing any customer- or admin-facing write path, the client-side change is not the
security boundary — the matching migration/trigger/RLS policy is. See `README.md` §"For
Evaluators & Panelists" and `docs/TECHNICAL-OVERVIEW.md` for the full rationale; this file only
covers what's needed to work in the code day-to-day.

Deeper reference docs (read before large changes in these areas):
- `docs/TECHNICAL-OVERVIEW.md` — full architecture walkthrough, section-numbered
- `docs/database_design.md` — ERD and per-column documentation
- `docs/GOLIVE_GUIDE.md` — production deployment checklist

## Commands

```bash
npm run dev              # Vite dev server, http://localhost:5173
npm test                 # chain of ~17 node-script contract tests + smoke/a11y/token linters
npm run check            # test + edge-function build test + photo-fallback browser test + build + pwa-offline test — run before every deploy
npm run build             # production build (stamps service-worker version + precache list)
npm run test:e2e         # Playwright, runs against a PRODUCTION build (see below)
npm run test:e2e:ui      # Playwright interactive UI mode
npm run test:e2e:headed  # Playwright headed
```

**Running a single contract test** — `npm test` is a chain of individual `node` scripts in
`scripts/*.mjs`; run any one directly, e.g.:
```bash
node scripts/payment-return-state-contract-test.mjs
node scripts/security-hardening-contract-test.mjs
```
Domain-specific suites not in the default `npm test` chain: `npm run test:payment-ledger`,
`npm run test:payment-notifications`, `npm run test:shipping-discount` (each runs a
`scripts/*-pgtest/run.mjs` against `@electric-sql/pglite`, an in-memory Postgres — no live DB
needed), `npm run test:pwa-offline`, `npm run test:edge-functions`.

**Running a single Playwright spec:**
```bash
npx playwright test tests/dispatch-gate.spec.js
npx playwright test -g "some test name"
```
The E2E suite (`tests/*.spec.js`) builds the app and drives it via `npm run preview` (production
bundle, not `vite dev` — see the comment in `playwright.config.js` for why) against a **real**
Supabase project and creates live data on every run. Only point `E2E_BASE_URL`/the configured
Supabase project at a dev/staging project — never production.

There is no separate lint command; `scripts/axe-lint.mjs` (accessibility) and
`scripts/token-lint.mjs` (undefined CSS custom properties) are part of `npm test`.

## Database changes

- Schema lives in `supabase/schema.sql` (full DDL) plus `supabase/migrations/` (88+ timestamped,
  append-only files — **never edit an applied migration**; add a new one).
- Apply with `supabase db push`; the Supabase CLI must be linked to a project first
  (`supabase link --project-ref <ref>`).
- Edge Functions (`supabase/functions/*`, Deno) are the only place server secrets live
  (`PAYMONGO_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VAPID_PRIVATE_KEY`, etc.). Deploy with
  `supabase functions deploy`. Never move a secret into a `VITE_`-prefixed env var — those are
  inlined into the client bundle.

## Architecture

### Routing and layout (`src/App.jsx`)
Single `createBrowserRouter` tree. Layouts (`AdminLayout`, `CustomerLayout`, `PublicShell`) and
auth pages are eager; every other page is `lazyWithRetry`-loaded per-route. `ProtectedRoute`
gates on `userProfile.role` from `AuthContext` — this is a UX convenience only, not a security
boundary (RLS is). `/payment/return` is deliberately outside the auth guards so PayMongo's
redirect renders instantly without waiting on app boot.

### Data access layer (`src/lib/`)
**All** Supabase reads/writes are funneled through `src/lib/database.js` (~3,300 lines, one
exported function per operation — `getOrders`, `createTrip`, `updateOrder`, `getSalesData`,
etc.). Pages/components call these functions; they do not construct `supabase.from(...)` queries
inline. When adding a new data operation, add it here rather than in the component.

`src/lib/supabase.js` is the client factory — notable non-defaults: a custom `fetch` wrapper adds
60s timeout + retry-with-backoff **only for idempotent GETs** (never retries a write, to avoid
duplicate bookings/payments on a flaky network), forces `cache: 'no-store'` on REST GETs, and
uses a custom `navigator.locks` fallback for token-refresh races on HTTP/non-secure contexts.

Other `src/lib/` modules worth knowing before touching related features: `paymongo.js` (GCash
checkout), `activityLog.js` (audit trail writes), `photoReference.js`/`storage.js` (private bucket
+ Firestore fallback descriptors), `push-notifications.js`/`firebase-messaging.js` (dual FCM +
raw VAPID push), `supportChatEngine.js` (rule-based chat bot).

### State machines and business rules (`src/constants/status.js`)
The order status flow, trip→order status cascade, settlement-bucket logic
(`unpriced`/`settled`/`owing`), and discount-editable-status rules are all defined here as the
**client-side mirror** of server-side enforcement (triggers + CHECK constraints named in the
comments, e.g. `guard_order_update`, `orders_trip_required_for_active_status`). If you change a
transition rule, the migration is the actual enforcement — this file is UI hinting and must be
kept in sync with it, not the other way around.

Key invariants encoded here:
- Order status is sequential (`STATUS_FLOW`); `Assigned` onward requires a `trip_id`.
- A new booking has **no price** — `actual_weight` is captured only at pickup (from a scale, not
  a customer estimate); `shipping_cost`/`remaining_balance` are 0 until then. Never treat
  `balance <= 0` as "paid" without checking whether the order has been weighed.
- `Pending Cancellation` is a hold state (customer requests, admin approves/rejects), not a
  terminal action.
- Dispatch-for-delivery is gated on payment unless `payer_type === 'receiver'` (Freight
  Collect/COD is exempt by definition) or an admin has recorded a promise date.
- `orders.amount_paid`, `remaining_balance`, `payment_status` are derived by DB trigger from the
  `payment_transactions` ledger — never written directly from the client.

### Pages (`src/pages/`)
Grouped by audience: `auth/`, `customer/`, `admin/`, `shared/` (used by both roles, e.g.
change-password/email), `public/` (no-auth: public tracking, legal, 404). Route wiring for all of
them is centralized in `App.jsx`, not colocated with the page files.

### PWA / service worker
Hand-rolled (no `vite-plugin-pwa`) — three versioned caches, four routing strategies, offline
fallback, and build-time precache-list injection that deliberately excludes heavy lazy chunks.
`npm run build` stamps the service-worker version; don't hand-edit that stamp.

## Environment variables

`VITE_`-prefixed vars are inlined into the client bundle — **never** put a secret there.
Client: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_FIREBASE_*`,
`VITE_PAYMONGO_PUBLIC_KEY`, `VITE_APP_URL`. Server-only (Edge Function secrets):
`PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`,
`FIREBASE_SERVICE_ACCOUNT_B64`, `CARGOEXPRESS_SUPABASE_PAT`, `VAPID_PRIVATE_KEY`. See
`.env.example` for the full list.
