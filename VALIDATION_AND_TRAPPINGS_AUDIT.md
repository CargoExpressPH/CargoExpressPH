# CargoExpress PH — Validation and Trappings Audit

> ## Remediation status — updated 2026-09-22 (local implementation only)
>
> Four of the five findings below have been fixed in the working tree and
> verified by executable database tests. **Nothing has been committed, pushed,
> deployed or applied to any remote Supabase project**, so every statement
> about production in this document remains unverified. The new migrations
> exist as files; they have NOT been run against the live database.
>
> | Finding | Original classification | Now |
> |---|---|---|
> | F-01 public tracking exposes fee + full description | Broken (reproduced) | **Fixed locally, verified by executable DB test** (`20260922140000`). Deployed state still unverified. |
> | F-02 pickup RPC accepts negative `p_amount` | Broken (reproduced) | **Fixed locally, verified by executable DB test** (`20260922150000`). |
> | P-01 upper bound for money collected at pickup | Needs owner confirmation | **Decided and implemented**: a collection above the final payable is refused. See "Overpayment decision" below. |
> | R-01 trip-capacity race | Source-identified risk | **Still UNVERIFIED — unchanged.** No concurrent environment is available here; no locking change was made. Reproduction script added. |
> | P-02 name validator narrower than documented | Needs owner confirmation | **Policy chosen and implemented** across browser and backend (`20260922160000`, `20260922170000`). |
>
> ### Overpayment decision (resolves P-01)
> The repository has **no tip, gratuity or excess-collection model** — no such
> column, table or RPC exists. Every `payment_transactions` row is shipping
> money: it counts as shipping revenue in the sales reports and is refundable
> as shipping money. An excess accepted at the counter would therefore be
> recorded as something it is not. So money entered at pickup may not exceed
> the final post-weighing, post-discount, refund-aware payable;
> `record_pickup_payment()` refuses the excess and the whole call rolls back.
> The admin is warned live, before submitting, and corrects the amount.
> A separate optional-tip model is *proposed*, not built.
>
> ### What was NOT done
> * No migration was applied to any database.
> * R-01 was not "fixed"; a speculative locking rewrite was deliberately avoided.
> * No browser, device, PayMongo, email or push test was performed.
>
> Full write-up: `REMEDIATION_REPORT.md`.


Review date: 2026-09-22 (Asia/Manila)

## Executive result

One **High** security/privacy regression is confirmed in the repository’s latest migration: the anonymous shipment-tracking RPC again returns the exact shipping charge and an untruncated package description. A synthetic-data PostgreSQL-compatible test reproduced the difference between the previously hardened projection and the current one. No Critical issue was confirmed.

The latest pickup-payment RPC also accepts a negative amount as if no money were collected and accepts amounts above the fixture’s payable value. Negative input is a confirmed backend validation gap (Low, admin-only); whether pickup is allowed to collect more than the final post-weighing fee is **Needs owner confirmation**, because the UI intentionally does not cap against its non-authoritative estimate.

Trip-capacity limits are enforced in source, but the order trigger does not visibly serialize simultaneous actual-weight changes for different orders on the same trip. The existing embedded PostgreSQL harness is single-connection, so this remains a source-identified concurrency risk, not a reproduced failure.

No production code, schema, migration, remote project, payment provider, or customer data was changed. The only additions are this report and two isolated PGlite audit tests.

## Reviewed version and environment

| Item | Evidence / result |
|---|---|
| Branch and revision | `main`, `399c3ff881d3ea47c8201dcbafc20d42a0022b93` (`feat: standardise next trip selection and capacity realtime`), dated 2026-09-22. `origin/main` pointed to this revision during inspection. |
| Worktree | Clean before the audit. At handoff, the only changes are the new report and two focused audit-test files; no tracked application, migration, or service-worker files were modified. |
| Migration chain | 212 timestamped SQL migrations, sorted from `20260524190000_production_hardening.sql` through `20260922130000_publish_trips_for_capacity_realtime.sql`; no duplicate 14-digit migration prefixes found. Current source review follows the migrations, not `supabase/schema.sql`. |
| Schema snapshot | `supabase/schema.sql` identifies itself as a historical September 1 snapshot and non-authoritative. It was not used as the effective schema. |
| Local backend | Supabase CLI is present. Local Supabase status could not be verified because Docker is not installed/running in this environment. |
| Deployed backend | Not verified. No remote migration-history query or deployed function/policy inspection was completed, so repository migrations and `config.toml` are **not proof of production deployment**. `.env` contents and credentials were not read or printed. |
| Tests | Repository tests use PGlite/isolated fixtures and mocked Edge/provider behavior. These are not a substitute for live Supabase Auth, PostgREST/RLS, provider, or multi-session concurrency tests. |
| Browser/device | No interactive browser, installed PWA, in-app browser, or mobile-device test was performed in this audit. |

## Route and module inventory

Routes were enumerated from `src/App.jsx`; protected-route placement and public exceptions were inspected there.

- Public: `/track`, `/about`, `/terms`, `/privacy`, `/unsubscribe`, `/schedules`, `/faq`, `/payment/return`, `/` redirect, and not-found route.
- Authentication: `/login`, `/register`, `/forgot-password`, `/reset-password`.
- Customer: `/customer` home; `/customer/orders`, `/customer/orders/:id`, `/customer/book`, `/customer/track`, `/customer/trips`, `/customer/notifications`, `/customer/profile`, `/customer/personal-info`, `/customer/change-password`, `/customer/change-email`, `/customer/support`, `/customer/payments`, `/customer/payment-methods` (compatibility redirect), `/customer/help-guidelines`, `/customer/about-version`.
- Admin: `/admin` dashboard; `/admin/orders`, `/admin/orders/:id`, `/admin/create-booking`; `/admin/trips`, `/admin/trips/create`, `/admin/trips/:id`; `/admin/customers`, `/admin/customers/:id`; `/admin/sales`, `/admin/reports`, `/admin/announcements`, `/admin/inbox`, `/admin/contact-inquiries`, `/admin/profile`, `/admin/change-email`, `/admin/change-password`, `/admin/activity-logs`, `/admin/company-info`, `/admin/storage-monitoring`, `/admin/feedback`.

Important shared action surfaces include order cancellation/edit/assignment, pickup and delivery, manual/additional payments, refunds and cancellation settlements, trip start/arrival/completion/rescheduling/reassignment, package-count and QR-label printing, inquiry assignment/replies, announcement publishing/retry, chat handoff, feedback visibility, and photo review/deletion.

## Findings

### F-01 — Anonymous tracking response regressed to expose fee and full cargo description

**Severity:** High  
**Evidence:** Broken — reproduced locally with synthetic data; deployed state unverified.  
**STATUS 2026-09-22: FIXED LOCALLY.** `supabase/migrations/20260922140000_restore_public_tracking_privacy.sql` removes `shipping_cost` from the return type and re-truncates `package_description` to 40 characters, keeping the masked names, status, route and the four trip-timing columns. Verified by `npm run test:public-tracking-privacy` (32 checks, executable PGlite test asserting the fields are absent from the RPC *response*, not hidden in markup). The migration has NOT been applied to any remote project.  
**Affected path:** Public `/track` → `track_order_public(TEXT)`; `supabase/migrations/20260922120000_trip_start_dates_and_actual_arrival.sql` (RPC definition/grant near lines 358–406).

**Preconditions and reproduction:** Call the granted RPC as `anon` with a valid or guessed tracking number. Tracking codes are generated as `CE-YYYYMMDD-XXXX` (4 random digits); an earlier hardening migration explicitly documented roughly 9,000 possibilities per day as enumerable. The tracking page’s 45-second retry/poll interval is a browser behavior, not a server-side limit on direct PostgREST RPC calls.

**Expected versus actual:** `20260806000000_harden_public_rpcs.sql` deliberately removed `shipping_cost` and truncated `package_description` to 40 characters because anonymous tracking codes were enumerable. The latest migration recreates the RPC and returns the exact `shipping_cost`, `actual_weight`, and the complete `package_description`, while granting execution to `anon`. Names remain masked, but the monetary value and detailed cargo text are again public. `TrackingPage` renders the description; the exact shipping cost is not needed by the inspected page.

**Reproduction:** `node scripts/audit-public-tracking-projection.mjs` executes both real migration projections against synthetic rows. It confirms the old public projection omits `shipping_cost` and truncates the description, then reproduces the current anonymous projection returning the exact fee, weight, and full description. This test does not establish that the migration has been applied remotely.

**Root cause:** The latest trip-arrival migration dropped/recreated `track_order_public` and copied a broader projection instead of preserving the established privacy allowlist. Its comment describes the projection as narrow, but its returned columns include these sensitive values.

**Impact:** Someone who knows or enumerates tracking numbers can learn cargo contents and the exact shipping fee without a session. The front-end cooldown does not prevent direct RPC enumeration. Exact weight was already part of the earlier hardened projection; this regression newly restores the full description and shipping charge.

**Minimal recommendation:** Restore the earlier restricted projection while retaining only the new trip timing fields needed by the tracking UI. Keep any necessary cargo description truncation. Consider server/API-side abuse controls or a higher-entropy public lookup capability; client polling is not a security boundary. Do not make `orders` publicly selectable.

**Cross-module effects:** Public tracking and any cached client consuming the positional/typed RPC response must be checked when changing the return signature. The tracking UI needs `package_description` and status/trip dates, but the inspected UI does not need `shipping_cost`; do not remove the trip arrival/departure data required for its timeline.

### F-02 — Pickup payment RPC silently accepts negative `p_amount`

**Severity:** Low (requires an authenticated admin; no negative ledger credit occurs)  
**Evidence:** Broken — reproduced in an isolated RPC fixture.  
**STATUS 2026-09-22: FIXED LOCALLY.** `supabase/migrations/20260922150000_pickup_payment_amount_guards.sql` rejects `p_amount < 0` before any mutation, preserving NULL/zero, Pay Later, Freight Collect, fully discounted and PayMongo-reconciled cases. Verified by `npm run test:pickup-payment-amount` (60 checks). Not applied remotely.  
**Affected path:** Admin pickup → `record_pickup_payment(...)`, latest body in `20260920120000_fix_pickup_payment_discount_race.sql`.

**Reproduction:** `node scripts/audit-pickup-payment-boundaries.mjs` runs the latest RPC body with a synthetic admin identity. With `p_amount = -25`, the RPC returns successfully, changes status to `Picked Up`, and writes no payment row. The same test verifies that an exact ₱1,000 payment records once. The fixture does not model every production pricing trigger, so its over-amount scenario is a characterization of the RPC amount boundary, not a complete production pricing simulation.

**Expected versus actual:** The UI’s shared validator rejects negative amounts, and the latest delivery-payment RPC rejects them server-side. The pickup RPC only inserts a ledger row when `COALESCE(p_amount, 0) > 0`; it has no negative-value rejection. A direct authenticated RPC call can therefore bypass the UI and turn malformed payment input into a no-payment pickup.

**Impact:** Invalid input is silently treated as an intentional zero/no-collection operation. That can leave a pickup confirmed without recording the admin’s intended collection and can complicate reconciliation/audit review. It does not itself create a negative financial credit.

**Minimal recommendation:** Add an explicit negative-amount rejection in the pickup RPC, preserving supported `NULL`/zero semantics for Pay Later/no-collection and the existing PayMongo reconciliation path. Cover `-0.01`, zero, and positive values in a migration-level test.

**Cross-module effects:** Preserve discount-only/fully discounted pickups, Freight Collect, Pay Later, payments already reconciled through PayMongo, and retry idempotency. Avoid copying the delivery rule wholesale because pickup’s measured-weight pricing differs.

### P-01 — Confirm the intended upper bound for money collected at pickup

**Classification:** ~~Needs owner confirmation~~ → **DECIDED AND IMPLEMENTED 2026-09-22.** A collection above the final post-weighing, post-discount, refund-aware payable is refused by `record_pickup_payment()`, because no tip/excess model exists to hold the difference honestly. The check runs AFTER the weight is written (that is the first moment an authoritative fee exists) and its RAISE rolls the whole call back, so a rejected pickup leaves weight, status, discount and ledger untouched. `PickupModal` still sets `capAtExpected: false` — the browser must not cap against its estimate — and shows a non-blocking warning instead. Original text follows.  
The latest pickup RPC records any positive `p_amount` without checking it against the post-weight, post-discount payable. The PGlite characterization fixture accepts ₱1,500 against its ₱1,000 payable. However, `PickupModal` deliberately sets `capAtExpected: false` because its displayed amount is an estimate and the database recomputes the price from actual weight and the trip rate. The PayMongo admin path also intentionally permits an amount above the previously stored balance before pickup pricing is updated. Confirm whether a pickup collection above the final database-calculated payable is allowed (e.g. accepted overpayment) or must be rejected/refunded. If capped, compare against the authoritative post-update payable—not the old balance or the client estimate—and test the staged PayMongo flow.

### R-01 — Simultaneous pickups/assignments may race the trip-capacity guard

**Classification:** **UNCHANGED — STILL UNVERIFIED.** No fix was made. A genuine concurrent environment is unavailable here: `psql`, `pg_ctl`, `postgres` and `docker` are all absent from PATH, `pg` is not a dependency, and PGlite is a single Postgres backend that fully serializes transactions (probe result: `A begin -> A commit -> B begin -> B commit`). Sequential tests cannot prove or disprove this, so no speculative locking rewrite was introduced. A runnable two-session reproduction script is provided at `scripts/trip-capacity-race/two-session-race.mjs` (`npm run test:trip-capacity-race`); it exits 2 with a SKIP message until `DATABASE_URL` points at a throwaway PostgreSQL and `pg` is installed. Original text follows.  
`guard_order_update()` in the current migration chain checks `SUM(actual_weight)` for other orders and enforces the configured capacity plus its 200 kg allowance. The update locks the order being changed, but the inspected capacity aggregate does not visibly lock a common trip row or use another per-trip serialization mechanism. Two concurrent updates to different orders on one trip could each read the other order’s old load and both pass. The existing PGlite capacity tests are sequential; their single connection cannot establish concurrent behavior. Verify with two real database sessions before deciding severity. If confirmed, serialize the authoritative load check and weight/assignment write per trip without weakening the existing allowance or cancellation exclusions.

### P-02 — Name character support is narrower than the validator comment suggests

**Classification:** ~~Needs owner confirmation~~ → **POLICY CHOSEN AND IMPLEMENTED 2026-09-22.** `validateName()` now allows Unicode letters of any script plus combining marks, spaces, periods, hyphens and apostrophes (including U+2019), requires at least one letter, trims, and normalises to NFC before testing; it keeps the existing 2–100 character bounds. Commas and backticks, which the old regex allowed, are no longer accepted. Registration now uses the same shared validator instead of its own laxer check. The same policy is enforced server-side by `public.is_valid_person_name()` in `prepare_order_insert()`, `guard_order_update()` and `guard_profile_write()` — every check gated on the value actually changing, so legacy names are neither rewritten nor frozen. Verified by `npm run test:person-name-policy` (76 checks). Original text follows.  
`src/utils/validation.js:1` says it allows letters “including diacritics,” but its regular expression accepts only ASCII letters plus a small Spanish/Latin set (`ñ`, selected accented vowels, and `ü`). The customer booking, admin booking, and personal-info forms reuse it. Names containing other valid Unicode letters (for example, `Å` or `ł`) are rejected in those forms. Registration uses a different, less restrictive name check. Confirm the supported name/script policy; do not add a business restriction solely from the existing regex. If broad human names are intended, use Unicode letter categories and retain the existing length/blank checks, with cross-form tests.

## Validation coverage matrix

“Functional” means exercised by a local isolated behavior test, not verified against the deployed project. “Source” means traced in the current frontend/backend/migration code but not executed through a live authenticated browser/backend path.

### How much was executable versus source-only

- **Executable:** all 39 scripts in `npm test`; 7 additional isolated suites outside that chain (`payment-ledger`, `shipping-discount`, `delivery-cash-payment`, `contact-details-lock`, `service-area-mass-assignment`, `legacy-rpc-overload-cleanup`, `email-updates-subscription`); the 20-function Edge build; the trip start-date and trip-capacity suites; and the two new focused PGlite probes. This covers payment/refund/settlement/report calculations, trip-date/capacity selectors and SQL gates, booking/service-area rules, contact locks, chat/notification contracts, email consent, and photo/security contracts.
- **Source-only or mixed:** route and form inventory, every Edge Function’s entry/auth pattern, RLS/grants in the repository migration chain, browser lifecycle/realtime wiring, account ownership against live JWTs, public/deployed gateway settings, provider delivery, actual storage, and genuine multi-session concurrency. Many matrix rows combine a local test of a helper/RPC with source inspection of the complete UI/backend chain.
- I do **not** report a percentage: the 39+7 test commands overlap, some are structural contracts, and no test count maps one-to-one to the route/action inventory. The route groups and all 20 Edge Function entries were source-inventoried; production behavior was not verified.

| Module / action | Rule examined | Frontend enforcement | Backend enforcement / security boundary | Test / evidence | Classification and result |
|---|---|---|---|---|---|
| Public tracking `/track` | Tracking lookup, public fields, status timeline, retries | Input/form handling; 45-second focused-tab refresh and client cooldown | Anonymous `track_order_public` and `get_public_order_events` RPCs; latest tracking projection is too broad (F-01) | `audit-public-tracking-projection.mjs`; migration comparison | **Broken (reproduced)** for fee/full-description privacy. Other event fields source-inspected. |
| Public about, schedules, FAQ, legal pages | Public content, trip summaries, legal pages | Public layouts/forms | Public data RPCs and public trip reads; `get_trips_load` is intentionally executable by `anon` for public schedule capacity and returns aggregate weight only | Source: `src/App.jsx`, `database.js`, public RPC migrations | **Present in source**; public aggregate’s business visibility is intentional in migrations. Live grants unverified. |
| Public contact inquiry | Required fields, normalization, abuse throttling | About/contact form validation | Public `submit-inquiry`; DB trigger applies IP/global rate limits and inserts admin notification transactionally | `submit-inquiry`, `20260825175302_ip_rate_limit_worldclass.sql`; security/inquiry tests | **Functional/source**; no live IP-header/proxy test. |
| Public email unsubscribe | One-click/email-client access, consent scope | `/unsubscribe` public page | Public Edge Function verifies email-bound HMAC token; does not require account session | Source: `unsubscribe-announcements`, `email_subscriptions` policies | **Present in source**, provider/email-client behavior not live-tested. |
| Public payment return | Device B requires no session; success only after backend confirmation | `/payment/return` is outside guards; simple success/close fallback and polling state | JWT disabled only for the verifier; high-entropy return capability is hashed; Edge Function uses service role for a narrow status lookup; attempt/RLS data is not made public | Payment-return state tests; `verify-payment-return` source and config | **Functional (local UI/state tests) + source**; no real provider/browser/device test. |
| Login, registration, forgot/reset password | Credentials, consent version, role creation, reset states | Form validation; registration stores non-sensitive draft fields only; password omitted from `sessionStorage` | Auth provider and DB registration trigger create customer role/profile/legal-consent records; route guard requires role/profile | Password recovery, registration transition, security hardening tests | **Functional/source**; live Auth email, rate limits and account-switch browser behavior unverified. |
| Customer home/orders/order detail | Owner-only list/detail, statuses, payment/read history | Customer route guard and state refresh | `orders` RLS is owner-or-admin SELECT; no general customer UPDATE policy; scoped payment/refund reads | Payment, refund, history, order-query sources/tests | **Functional/source** for isolated business rules; cross-account access not exercised against live RLS. |
| Customer booking wizard | Required sender/receiver/contact/address/package/route fields, supported areas, duplicate submit, draft isolation | Shared validators, service-area checks, submit guard and per-user draft namespace | Insert policy and order triggers force server-generated/controlled financial and status fields; service-area restrictions in latest insert trigger | Booking-draft isolation (23 checks), registration transition, source: `BookShipmentPage`, order insert migrations | **Functional/source**; Unicode limitation is P-02. No live RLS/API bypass test. |
| Customer contact/profile | Personal-information formats and edit restrictions | `validateName`, address and phone validators | Profile policies restrict ownership; contact changes use scoped RPC/trigger checks where applicable | Profile and account source; relevant order contact trigger tests | **Source**, not live user-account testing; name-script policy P-02. |
| Customer password/email | Current-password/re-authentication and confirmation flows | Shared change forms | Supabase Auth operations; no table-field shortcut found in inspected page flow | Source only | **Present in source**; live provider/email confirmation unverified. |
| Customer trips/schedules | Active trip options and route/date display | Trip filters and Manila date formatting | RLS/public trip read policy plus `get_trips_load`; booking eligibility remains separate from dashboard summary selection | Trip date, capacity selection tests | **Functional/source** for selection/date helpers; live public schedule/access unverified. |
| Customer notifications and push registration | Own notifications/device tokens; background delivery | Customer-only page and permission prompts | RLS scopes own devices/notifications; durable delivery worker uses service-role authentication | Push and notification UX tests; worker source | **Functional/source**; actual OS delivery/browser permission not tested. |
| Customer chat/support | One conversation per customer context, message ownership, menu/handoff | Menu-driven support and handoff UI | Conversation/message RLS and message guard; no payment/order mutation exposed through chat menu | Support-chat contract tests | **Functional/source**; live two-account RLS not tested. |
| Customer payment history/refund status | Paid/pending/failed and refund event display | Read-only history views | Payment attempts, transactions and refunds are read through scoped policies/RPCs; anonymous payment-return uses capability verifier only | Payment/refund/history and financial RPC tests | **Functional/source**; live RLS and provider outcome timing unverified. |
| Customer feedback | Eligibility, one response/order, visibility | Form limits and customer flow | Insert/visibility policies and admin moderation path | Featured/feedback source and relevant smoke/contract tests | **Present in source**; no full anonymous/customer/admin browser matrix. |
| Admin dashboard / capacity card | Earliest scheduled/ongoing trip, Manila date, one selected trip’s own load | Deterministic departure date, stable trip-number/ID tie-break, overdue label, distinct empty/error states; realtime/focus/reconnect refresh | `get_trips_load` is authoritative for selected trip; order trigger enforces capacity + 200 kg allowance | `trip-capacity-selection-test.mjs`; trip-start-date tests; migration/source | **Functional** for selector/date contract; Realtime subscription and separate-session capacity race not proven. Card selects one earliest trip globally; separate per-direction cards are not present in inspected route. |
| Admin order list/detail | Status filters, owner assignment, contact edits, cancellation, dispatch, delivery, logs | Role-guarded admin routes, modal validations, double-submit controls | Admin RLS, status/contact/discount/capacity triggers, cancellation and contact RPCs; customer cannot raw-update orders by policy | Cancellation-settlement 23; contact/payment/order contracts; migration source | **Functional/source**; actual JWT/RLS role matrix unverified. |
| Admin booking creation | Required inputs, service-area eligibility, trip assignment | Same field validators/route checks as customer wizard | Admin create path still passes DB order guards; server derives tracking/status/price and validates trip | Source and booking tests | **Functional/source**; Unicode/last-name policy noted separately. |
| Pickup payment / discounts | Cash/GCash, exact/full vs partial, Pay Later/date, references, photos, discount ≤ fee, paid-order lock, retry | `PaymentCollectionPanel` validation; pickup estimate deliberately not capped; photo types/count checked | `record_pickup_payment` admin-only, order-lock/idempotency/discount guard; latest RPC misses negative rejection; PayMongo reconciles through provider path | Payment-ledger, payment UI, refund-aware tests; added pickup-boundary PGlite test | **Broken (negative direct-RPC input reproduced)**; upper bound is **Needs owner confirmation** (P-01). |
| Delivery payment and dispatch | Delivery status/proofs, amount ≤ authoritative balance, payment method, promise date, unsettled balance | Modal checks 1–3 photos and payment amount; delivery cap enabled | `record_delivery_payment` checks status/photos, negative and over-balance amounts, cash/GCash rule, promise date; dispatch trigger blocks unpriced/unsettled shipments without allowed exception | Delivery/payment-ledger/refund-aware tests | **Functional/source**; provider/device payment not live-tested. |
| Additional payment | Positive amount, remaining amount after successful refunds, GCash reference, duplicate retry | Admin modal, amount/reference controls | Locked `record_additional_payment` computes refund-aware outstanding, requires positive amount and manual GCash attestation/reference, idempotency | Manual payment/refund PGlite tests | **Functional** in isolated database fixture; true multi-session locking remains limited. |
| PayMongo create/poll/webhook | Order ownership, amount authority, provider state, no duplicate credit | Payment UI gates unresolved checkout and prevents frontend credit | `paymongo-create-payment` verifies user/admin and order binding; customer amount capped; webhook validates provider signature and reconciles server-side; idempotent attempt/payment identity | PayMongo auth, ledger/refund, return tests; Edge build | **Functional/source** for RPC/provider mocks; no live PayMongo event/signature test. |
| Provider/manual refunds and recovery | Per-payment and per-order refund caps, pending/failed/uncertain state, retry/reauth | Admin refund UI requires confirmation/password as designed | Admin Edge checks role; manual path rechecks admin identity/reauth limits; provider reservations lock payment and account for active refunds; retries are idempotent; only successful refunds change totals | Refund request/provider tests; PGlite refund 14, recovery 22, manual refund 46; manual Edge contract 21; cancellation 23 | **Functional** in fixtures/mocks; production GoTrue password reauth and real provider uncertain outcomes unverified. |
| Cancellation and retained-fee settlement | Review state, confirmed fee/consent, refund reservation, idempotency, cancelled debt not treated as collectible | Admin/customer cancellation and settlement modals distinguish review/decision states | Locked settlement/refund RPCs; explicit agreement and fee caps; cancellation transition held for review; paid totals follow refund ledger | Cancellation-settlement PGlite 23 and sales/cancellation UI contract | **Functional** in PGlite; PGlite does not prove true multi-session lock contention. |
| Trips: create/reschedule/start/arrive/complete/cancel | Chronology, Manila day gate, readiness, timestamp authority, reason/history, completion settlement | Date gate, reschedule reason, status confirmation and readiness UI | Admin-only gate RPC; transition trigger stamps server departure/arrival and enforces start date/readiness, unsettled balances and state; direct date edits blocked; locked reason-bearing reschedule RPC | Trip-start-date tests (26 in prior run), reschedule broadcast 15; current rerun included below | **Functional/source**; no browser/device-clock manipulation or live concurrent transition test. |
| Trip assignment/reassignment and capacity | Valid trip/status, route agreement, load ceiling, reassignment history | Admin assignment/reassignment controls and capacity estimate | DB triggers and `reassign_trip` enforce active trip, route and capacity; no common trip lock was found around simultaneous different-order weight updates (R-01) | Sequential PGlite/source tests; no multi-session execution | **Present in source**; concurrency **blocked/unverified**, not asserted as reproduced. |
| Parcel count, QR labels, printing | 1–50 boxes, stable box index/tracking identity, no new identity on reprint, lock after dispatch | Stepper clamps 1–50 and locks after Out for Delivery/Delivered/Cancelled; QR points to admin-only order route | Current package-quantity constraint and admin access; order ID/box index in QR is behind admin route | Migration/source and existing smoke/contract coverage | **Present in source**; physical scan/print/browser tests not run. |
| Sales, reports, unpaid shipments | Period/Manila boundaries, refund dates, per-trip vs period scope, cancellation handling, amount meaning | Filters/export/print and UI summaries | Financial report RPCs compute payments/refunds separately and enforce admin authorization; RLS prevents public ledger access | Financial report PGlite (empty/mixed/refund/boundary/auth), refund period 10, per-trip report, cancellation tests | **Functional** for named isolated report scenarios; visual print/mobile/browser comparison not run here. |
| Announcements and email subscribers | Audience/consent, duplicate job/retry, unsubscribe scope | Admin publish/retry and preference controls | Durable job/claim/outcome tables; admin broadcast Edge; public unsubscribe requires HMAC; scheduled jobs use service-role bearer verification | Mocked worker + DB broadcast tests; email subscription source | **Functional/source**; no real email provider delivery test. |
| Admin inbox, chat handoff, contact inquiries | Assignment, reply ownership, inquiry state | Admin-only inbox/contact screens | Admin policies/RPCs; public inquiry insert has DB rate guard; notification trigger is transactional | Support chat, inquiry/security source | **Functional/source**; no live two-admin race test. |
| Company info, coverage, pricing/settings | Public fields versus admin-only edits; rates/coverage formats | Admin settings pages validate form values | RLS/admin-only writes; public data RPCs expose intended business/coverage data | Company-info audit tests; source | **Functional/source**; live data and deployed RLS not verified. |
| Activity log | Actor/record trace and pagination | Admin filters/export; queued client logging for supported client events | DB-triggered logs cover critical transitions; admin view RLS; user insert path scoped | Activity-log tests and migration source | **Functional/source**; logs are not sole authority for payment/refund facts. |
| Photos/storage/cleanup | Type/count/size, order ownership, eligible deletion, health/archive safety | Upload helpers and admin gallery, explicit delete confirmation | Photo Edge functions self-authenticate admin when gateway JWT is disabled; storage policies and delete RPC recheck eligibility; archive/cleanup functions are service-job protected | Photo refs/fallback/storage-monitoring tests and Edge build | **Functional/source**; actual storage provider/bucket policies, large-file and cleanup-job behavior not exercised. |

## Supabase Edge Function inventory and gateway/auth review

`supabase/config.toml` defines 20 functions and every function passed the repository Edge build check. Gateway `verify_jwt = false` is not, by itself, evidence of an auth bypass: the reviewed public endpoints have an application-level capability/signature/HMAC/admin check, or are deliberately public. Live gateway settings were not queried.

| Function(s) | Intended caller / reviewed protection | Evidence status |
|---|---|---|
| `paymongo-create-payment` | JWT user; function verifies Supabase user and profile role, binds order to owner/admin, and validates customer amount | Source + authorization/payment tests; no live JWT test |
| `paymongo-webhook` | Public gateway because provider cannot present Supabase JWT; verifies PayMongo webhook signature before reconciliation | Source + reconciliation fixtures; no provider signature call against live service |
| `verify-payment-return` | Public Device B capability endpoint; hashes high-entropy capability, looks up only return status with service role, returns enum only | Source + payment-return tests; no live deployed capability/RLS check |
| `paymongo-refund`, `record-manual-refund` | Admin user; role checked; manual flow performs separate password reauthentication and lockout checks | PGlite/provider/structural Edge tests; real GoTrue password operation unverified |
| `paymongo-refund-recovery` | Scheduled service-role job; bearer compared to configured service role; claims durable recovery work | Provider/PGlite recovery tests; live cron/secret configuration unverified |
| `store-photo-fallback`, `get-photo-fallback`, `delete-photo-fallback` | Gateway JWT disabled for provider fallback compatibility; function checks authenticated user/order ownership or admin before private photo access/mutation | Source and fallback contract tests; no live Storage/Firebase test |
| `delete-storage-photos`, `record-photo-storage-event`, `photo-storage-health` | Gateway JWT disabled; each admin action checks admin identity; delete path also rechecks DB eligibility | Source/contract tests; no live Storage test |
| `archive-expired-evidence-photos` | Scheduled service-role archive worker | Source/config/build only; job not run (intentionally) |
| `send-push`, `process-push-deliveries` | Authenticated authorized sender or durable worker; worker requires service-role token; target/source scopes are validated | Push/notification tests and source; actual OS push unverified |
| `process-daily-reminders` | Scheduled service-role bearer; not an ordinary browser/admin action | Source/config/build only; job not run (intentionally) |
| `email-trip-reschedule` | Triggered service-role courtesy email; recipient rows re-read by backend | Source/config/build only; email not sent |
| `broadcast-announcement` | JWT admin only; durable worker constrains audience/consent and retries by idempotent delivery state | Worker and database tests; email provider not called |
| `unsubscribe-announcements` | Public email-client endpoint; HMAC token scoped to subscription/email | Source/config only; no live email-link test |
| `submit-inquiry` | Public insert; database enforces rate-limit guard and creates admin notification transactionally | Source and tests; live proxy/IP header behavior unverified |

## Cross-module effects and business-rule notes

- The public-tracking fix should be narrowly scoped to the function’s public return fields; it must preserve tracking status/timeline, masked names and new trip departure/arrival facts. It should not grant anonymous table access.
- The pickup negative-amount fix must keep `NULL`/zero no-payment and Pay Later cases valid, and must not double-record a payment already reconciled from PayMongo. If an upper cap is adopted, calculate from actual weight, trip-specific rate and discount after the authoritative DB update.
- Capacity serialization, if later confirmed, touches pickup weight recording, trip assignment/reassignment, the dashboard capacity card, and trip start readiness. It must retain the 200 kg allowance and existing treatment of cancelled/pending-cancellation orders.
- The Unicode name validator is shared by customer booking, admin booking and personal-info editing; a correction needs coordinated form tests and must not silently change stored legacy names.
- Refund and cancellation tests cover calculations and idempotency in isolated SQL fixtures, but they do not establish deployed cron cadence, live RLS, or true lock contention.

## Tests and checks performed

| Check | Result |
|---|---|
| `npm test` | Passed all 39 configured scripts in the current repository suite. Includes support-chat, static accessibility/token/security checks, authentication/payment UI contracts, payment reconciliation/refunds, period reports, cancellation settlement, trip rescheduling/notifications, booking-draft isolation, photo, push, and notification checks. |
| `npm run test:edge-functions` | Passed; all 20 configured Edge Functions built. |
| `npm run test:trip-start-dates` | Passed in the current verification sequence. These are isolated database/date-gate tests, not a device-clock/browser test. |
| `npm run test:trip-capacity-selection` | Passed in the current verification sequence; deterministic selector, Manila date, status, tie-break, load-RPC and refresh wiring contract covered. |
| `npm run test:payment-ledger` | Passed, 52 checks. Note: that legacy harness applies migrations only through `20260911060218`; the added pickup-boundary probe separately executes the latest pickup RPC migration. |
| `npm run test:shipping-discount` | Passed, 95 isolated SQL checks for discount, totals, refunds/settlement, idempotency and status rules. Its cases did not include the latest pickup RPC’s negative-input boundary. |
| `npm run test:delivery-cash-payment` | Passed, 47 isolated SQL checks, including amount bounds, cash-at-delivery and later GCash settlement. |
| `npm run test:contact-details-lock` | Passed: 24 RPC checks plus 8 raw-table-update bypass checks. |
| `npm run test:service-area-mass-assignment` | Passed, 12 isolated database checks for server-derived service-area decisions. |
| `npm run test:legacy-rpc-overload-cleanup` | Passed, 8 checks for removal of old payment RPC signatures and compatibility with named legacy parameters. |
| `npm run test:email-updates-subscription` | Passed, 38 isolated database checks for opt-in, unsubscribe, case normalization and admin controls. |
| `node scripts/audit-public-tracking-projection.mjs` | Passed the historical-safe projection assertions and reproduced the current anonymous field regression using synthetic fixture data. |
| `node scripts/audit-pickup-payment-boundaries.mjs` | Passed valid-payment characterization; reproduced negative amount acceptance and over-amount acceptance in its intentionally minimal isolated RPC fixture. |
| `npm run build` | Passed. Vite reports the existing 528.92 kB `vendor-react` chunk-size warning and an empty `vendor-pdf` chunk; neither failed the build. |
| Supabase live schema/migration list | Not performed: local Docker stack unavailable and no verified linked remote project was established. No secrets were inspected. |
| Real-browser, provider, two-device, multi-session race tests | Not performed. No real payments, refunds, notifications, cleanup jobs, or production writes were initiated. |

## Open questions / limits

1. Is an intentional pickup overpayment above the final post-weight, post-discount payable allowed? If so, how is the excess represented/reconciled? If not, the server RPC needs a cap using the final authoritative amount.
2. Which Unicode scripts/diacritics must sender, receiver, and profile names accept? The current booking validator and registration validator disagree.
3. Does production have a server/API rate limit on public tracking that is absent from this repository? The reviewed UI cooldown is not one.
4. Is the latest migration chain applied to production, and do deployed function grants/RLS/Edge gateway settings match it? This was not verified.
5. Capacity concurrency needs two genuine PostgreSQL sessions with overlapping updates to distinct orders on one trip; PGlite’s single-connection model cannot settle R-01.
6. Actual browser behavior for installed PWA, in-app browser, email confirmations, storage-provider fallback, and OS push remains unverified.

## Minimal recommended order

1. Restore the public tracking privacy projection and add an abuse-control check at a server/API boundary; verify anonymous calls against the deployed route with synthetic data.
2. Reject negative pickup amounts in the RPC and add exact boundary tests. Obtain owner direction on the positive upper bound before changing overpayment behavior.
3. Run the two-session capacity race test; only then design a trip-scoped serialization fix.
4. Confirm Unicode-name policy and align registration, booking, admin booking and profile validation.
5. After authorization, compare the deployed migration ledger, function definitions/grants, RLS policies, Edge gateway config, and real test-mode browser/provider behavior with this source review.

## Simple Taglish summary

May isang **High** na privacy regression sa public tracking: dahil sa latest migration, puwedeng makita ng kahit walang login ang eksaktong shipping fee at buong package description kapag alam o nahulaan ang tracking number. Na-reproduce ito sa isolated test gamit ang synthetic data. Wala akong nakumpirmang Critical issue.

May maliit pero totoong backend gap din sa pickup: kapag direktang tinawag ang RPC bilang admin, tinatanggap nito ang negative amount at itutuloy ang pickup na walang payment record. Hindi ito dumadaan sa normal UI validation. Hindi pa malinaw kung dapat payagan ang sobrang bayad sa pickup, kaya kailangan muna ng business-owner decision. Ang sabay-sabay na capacity updates ay posibleng mag-race, pero hindi ito napapatunayan ng single-connection test.

Pumasa ang local automated suite; hindi ito live production verification. Walang payment, refund, notification, cleanup, deployment, o production data na ginalaw.
