# Manual Cash / Manual-GCash Refund Recording — Change & Test Report

**Status:** Implemented locally. Nothing was deployed, no real refund/transfer/notification was
sent, and no `git commit` was run by me during this work (a note on that at the end of this
document — see "A note on git state").

This document follows the **corrected** requirements, which explicitly override the original
spec's "invent a `man_...` refund_id" and "frontend-only reauth is acceptable" suggestions. Every
"IMPORTANT SECURITY REQUIREMENT" / "mandatory correction" in your message was treated as binding;
where the original spec and the corrections disagreed, the corrections won, and that is called out
below wherever it changed the design.

---

## 1. What was verified before writing any code

Per your instruction to inspect the schema and re-derive the plan rather than implement the
original spec blindly:

| Original spec's assumption | What was actually found | Consequence for the design |
|---|---|---|
| Generate `refund_id = 'man_' || gen_random_uuid()` | `refund_id`'s format CHECK is `refund_id IS NULL OR refund_id ~ '^ref_[A-Za-z0-9_-]{4,128}$'` — a `man_...` value would pass that regex-free NULL branch only by accident of it being NULL-checked first, but doing so would still plant a fabricated identifier in a column every provider-facing function (`reconcile_paymongo_refund`, the recovery worker) treats as PayMongo's own id. | **Left `refund_id` and `payment_id` NULL for manual refunds.** Added a new `refund_channel` column (`'paymongo' \| 'manual'`) as the actual, explicit distinguisher, plus a CHECK constraint tying `refund_channel='manual'` to both ids being NULL. |
| "Verify password inside the RPC using pgcrypto, OR frontend-only reauth" | Postgres has no access to Supabase Auth's password hashes at all (they live in GoTrue, not readable via SQL), and frontend-only reauth is exactly what the correction explicitly rules out. | Password verification happens in a new **Edge Function** (`record-manual-refund`), via a real `supabase.auth.signInWithPassword()` call against Supabase Auth — the only correct way to check a password without touching `auth.users`. The database write RPC is reachable only by `service_role`, so a browser session cannot skip the Edge Function and write directly. |
| `initiated_by` should be "strictly set to the verified `auth.uid()`" | Under a `service_role` call (which is what the Edge Function uses), `auth.uid()` is **NULL** — there is no browser JWT in that context. The existing `guard_activity_log_insert()` trigger already documents this exact gap: it only auto-derives `admin_id`/`admin_name` when `auth.uid()` is non-null, and passes rows through untouched otherwise. | `record_manual_refund` takes `p_admin_id` as an explicit parameter (supplied only by the Edge Function, after it verified the identity), **re-checks that id is really an admin** via `profiles` before trusting it, and explicitly writes both `payment_refunds.initiated_by` and `activity_logs.admin_id/admin_name` from that checked value — it cannot rely on `auth.uid()` at all. |
| "Ensure it's automatically picked up by `get_financial_report_data`" | Not automatic by default — the refunds CTE joins `payment_transactions` for its `method` label but otherwise just sums `payment_refunds` rows with `status='succeeded'`, with no channel filter. This turned out to already work correctly once the schema/RPC changes were in place — but only because I proved it with a test, not because I assumed it. | Added a dedicated section of `scripts/manual-refund-pgtest/run.mjs` that runs a real manual refund through the real `get_financial_report_data()` RPC and checks the Cash/GCash method buckets, gross/net/refund totals, and the combined ledger — see §5. |

---

## 2. Files / functions / migrations changed

### Database (forward migration, no existing migration file edited)
**`supabase/migrations/20260918020000_manual_refund_recording.sql`** (new). In order:

1. **Schema.** Adds to `payment_refunds`: `refund_channel` (`'paymongo'`/`'manual'`, default
   `'paymongo'` so every existing row is correctly classified with no backfill needed),
   `return_method` (`'cash'`/`'gcash'`, only for manual rows), `return_reference` (GCash transfer
   ref, admin-visible only), `returned_at`. Drops `payment_id`'s `NOT NULL`, keeps its PayMongo-
   format CHECK strict for any row that does have a value. Adds three CHECK constraints:
   `payment_refunds_channel_identity` (a paymongo row must have `payment_id`; a manual row must
   have neither `payment_id` nor `refund_id`), `payment_refunds_return_method_channel` (manual ⇔
   has a return method; paymongo ⇔ doesn't), `payment_refunds_manual_return_evidence` (a GCash
   return needs a ≥4-char reference; a Cash return needs a ≥5-char acknowledgement note) — the
   same rules the modal enforces, restated as real database constraints so they hold even if
   something other than the RPC ever writes to this table.
2. **Rate limiting.** New service-role-only table `private.manual_refund_reauth_attempts` and two
   RPCs: `check_manual_refund_reauth_lockout` and `record_manual_refund_reauth_attempt` — 5 failed
   password attempts locks re-verification for 15 minutes; a success resets the counter.
3. **`record_manual_refund(...)`** — the write. Service-role-only, re-verifies `p_admin_id` is an
   admin, row-locks the original `payment_transactions` row, rejects any payment that's a verified
   PayMongo GCash payment (must use the existing provider flow instead), computes the remaining
   refundable amount the same way `prepare_paymongo_refund` does (sum of all non-`failed`
   `payment_refunds` for that payment), inserts with `status='succeeded'` and `succeeded_at`
   immediately (no intermediate state — the money was already handed back before this is
   submitted), and writes the `activity_logs` audit row in the same statement sequence.
4. **Provider-path isolation.** `mark_paymongo_refund_uncertain`, `mark_paymongo_refund_failed`,
   and `reconcile_paymongo_refund`'s webhook-redelivery heuristic all gained an explicit
   `refund_channel = 'paymongo'` guard. The recovery worker's wake trigger
   (`wake_paymongo_refund_recovery_for_refund`) now returns immediately for a manual row. (These
   were already structurally unreachable for a manual refund — a manual refund's parent payment
   is never `gcash_channel='paymongo'`, so it was never enqueued for recovery in the first place —
   but the correction asked for this explicitly, not just implicitly, so it's now a direct,
   testable guarantee rather than a coincidence of the data.)
5. **Customer notification copy fixed.** The existing `notify_refund_succeeded()` trigger is
   generic (fires on any `payment_refunds` row reaching `status='succeeded'`, regardless of
   channel) and previously always said "...may take additional time to appear in your original
   GCash account" — true for a PayMongo refund, false and confusing for a manual return. It now
   branches by `refund_channel`/`return_method`.
6. **`get_payment_refund_history` extended** (dropped and recreated — its output columns changed,
   which `CREATE OR REPLACE` cannot do). Adds `refund_channel`, `return_method`, `returned_at`,
   `succeeded_at` to both admin and customer views; `return_reference` stays admin-only (same
   redaction pattern as `payment_id`/`refund_id`) since it's an internal transfer reference, not
   something the customer needs to see.

### Backend (Edge Function)
**`supabase/functions/record-manual-refund/index.ts`** (new). Verifies the bearer token → resolves
admin role → checks the reauth lockout → calls `signInWithPassword` on a **throwaway** client
(never the caller's own session-bound client, and it's explicitly signed out again after use, so
the admin's real browser session is untouched) → confirms the verified user id matches the bearer
token's id → records the attempt (success or failure) for rate limiting → only then calls
`record_manual_refund` via the service-role client, with `p_admin_id` set to its own verified
identity, never a request-body field.

### Frontend
- **`src/lib/manualRefund.js`** (new) — client wrapper posting to the Edge Function, mirroring
  `createPayMongoRefund`'s shape.
- **`src/components/ui/ManualRefundModal.jsx`** (new) — amount (capped at remaining refundable),
  reason dropdown, **return method** (Cash / GCash — independently of how it was originally paid),
  a required transfer reference (GCash) or acknowledgement note (Cash), an explicit "the money has
  already been returned" checkbox, and a password field. Banner text: *"This only records a refund
  in CargoExpress's system for accounting purposes — it does not transfer any money."*
- **`src/lib/database.js`** — fixed a real bug in `mergePaymentActivity`: refund rows were
  hardcoded to `payment_method: 'gcash', gcash_channel: 'paymongo'` regardless of what kind of
  refund they actually were. A manual Cash refund would have displayed as if it were a GCash/
  PayMongo refund. Now derives method/channel from `refund_channel`/`return_method`.
- **`src/pages/admin/OrderDetailPage.jsx`** — the Payment History table's Cash/manual-GCash action
  cell, which (from the prior UI-alignment pass) showed a static "Manual refund only" label with
  no action, now opens `ManualRefundModal` via a **"Record Manual Refund"** button when the
  payment is still refundable. The same button was added to the cancellation-review/cancelled-
  order payment summary's "unrefundable" list, alongside the existing PayMongo "Start Refund"
  list — an admin reviewing a cancellation sees both options for whichever payments qualify for
  each, in one place.

### Tests (new)
- **`scripts/manual-refund-pgtest/run.mjs`** — 39 assertions against the real migration files (see
  §5).
- **`scripts/manual-refund-edge-function-contract-test.mjs`** — static/structural checks on the
  Edge Function's source (see §5 and its own header comment for what this can and cannot prove).
- Registered both in `package.json`'s main `test` chain and as `npm run test:manual-refund`.

### Explicitly not touched
No existing migration file was edited. `prepare_paymongo_refund`, `reconcile_paymongo_refund`'s
core logic, `RefundPaymentModal.jsx`, the cancellation RPCs, and every other refund/cancellation
code path from the prior audit/alignment passes are unchanged except for the narrow
`refund_channel` guards listed above.

---

## 3. Security design, restated plainly

**Why the password can't be checked "inside the RPC with pgcrypto."** Supabase Auth (GoTrue)
stores password hashes in `auth.users` using its own hashing scheme; Postgres functions have no
supported way to verify a plaintext password against that hash without either (a) reading
`auth.users` directly — which the correction explicitly forbids, since it's the "elevated
privileges, read the hash yourself" shortcut — or (b) calling Supabase Auth's own verification
endpoint, which is exactly what `signInWithPassword` does. That call can only happen somewhere with
network access to the Auth server: an Edge Function, not a Postgres function.

**Why the browser can't bypass this.** `record_manual_refund` is granted to `service_role` only
(`REVOKE ALL ... FROM PUBLIC, anon, authenticated`). A browser session — even an authenticated
admin's — has no credential that lets it call a `service_role`-only function. The only way to the
database write is through the Edge Function, which is the only place `SUPABASE_SERVICE_ROLE_KEY`
exists (per `CLAUDE.md`'s own architecture rule).

**Why `initiated_by` can't be spoofed even if the Edge Function had a bug.** The RPC independently
re-queries `profiles` for `p_admin_id` and rejects it if that id isn't currently an admin — it does
not trust that the caller already checked this. This is defense in depth: even a hypothetical
compromised or buggy Edge Function could not attribute a manual refund to an arbitrary id unless
that id is a real, current admin.

**Why the admin's browser session survives.** `signInWithPassword` is called on a **separate**
Supabase client instance (`passwordVerificationClient()`), created fresh inside the Edge Function,
never returned to or shared with the browser. It has no relationship to the admin's actual login
session. It's explicitly signed out again immediately after the check, though even without that it
would never have touched the browser's own session storage.

**Rate limiting.** 5 failed attempts within the tracked window locks further attempts for 15
minutes, enforced server-side (`private.manual_refund_reauth_attempts`, checked and updated only by
`service_role`). This is deliberately in addition to whatever limits Supabase Auth itself applies —
this flow authorizes a financial write, so it gets its own bound.

---

## 4. Final labels, formulas, and status mapping

**No new database status value was invented.** `payment_refunds.status` is still exactly
`creating | pending | processing | succeeded | failed` — a manual refund is inserted directly as
`succeeded` (there is no intermediate state; the money was already handed back before the admin
submits the form). `'uncertain'` was never a real status anywhere in this codebase (before or after
this change) — it's the separate `outcome_uncertain` boolean, which manual refunds never set.

**New, explicit fields (not overloading existing ones):**
- `refund_channel`: `'paymongo'` (all pre-existing rows, and every future provider refund) |
  `'manual'` (this feature). The one true distinguisher.
- `return_method`: `'cash'` | `'gcash'` — how the money actually went back out. Independent of the
  original `payment_transactions.payment_method` (a Cash payment can be returned via GCash, and
  vice versa — the modal lets the admin choose either).
- `return_reference`: the GCash transfer reference, required when `return_method='gcash'`,
  admin-only in the read RPC.
- `returned_at` / `succeeded_at`: both set to the same instant at insert time (the actual return
  moment, defaulting to "now"). `succeeded_at` is the column period-based reporting already reads
  (from the prior alignment migration) — a manual refund plugs directly into that existing,
  already-tested mechanism with no separate reporting code path.

**Formula, unchanged from the existing refund system, now applying uniformly to both channels:**
`Refundable (per transaction)` = `payment.amount − SUM(payment_refunds.amount WHERE status IN
('creating','pending','processing','succeeded'))`. Enforced identically by `prepare_paymongo_refund`
(PayMongo path) and `record_manual_refund` (manual path) — same reservation math, same rounding
tolerance, verified by the same style of test.

---

## 5. Tests and results

All commands run against an in-memory Postgres (`@electric-sql/pglite`) with the real migration SQL
applied verbatim — nothing here touches a live project.

```
$ npm run test:manual-refund
  ... 39 ok / 0 failed (scripts/manual-refund-pgtest/run.mjs)
  ... structural checks passed (scripts/manual-refund-edge-function-contract-test.mjs)
```

**What the 39 database-layer assertions cover (mapped to your required list):**

| Required scenario | Covered by |
|---|---|
| Wrong password / non-admin requests | "record_manual_refund rechecks eligibility itself and rejects a non-admin p_admin_id" |
| Direct RPC attempts bypassing reauthentication | "the browser/authenticated role cannot call record_manual_refund directly" |
| A different user's identity | The RPC-level test covers the *authorization* half (non-admin id rejected); the *password-belongs-to-a-different-user* half is covered by the Edge Function's own logic (`signInData.user.id === userData.user.id` check) and asserted structurally by the contract test — see the limitation note below. |
| Duplicate submission / concurrent refund requests | "resubmitting the exact same idempotency key does not create a second row"; "a second admin cannot refund past the fully-reserved amount" |
| Prior partial refunds and pending reservations | The concurrent-refund test above reserves against a payment that already has one succeeded refund, proving the reservation sum accounts for prior activity |
| Manual refunds excluded from provider recovery | "mark_paymongo_refund_uncertain/failed... does not touch a manual refund row"; "the Cash payment was never queued for PayMongo refund recovery in the first place" |
| Cash paid and GCash returned | "manual GCash-return refund is created with its transfer reference recorded" — this is exactly the paid-Cash-refunded-differently case per your correction #4/#5 |
| Payment and refund in different reporting periods | Deliberately delegated to the **dedicated** `refund-period-bucketing-pgtest` (from the prior alignment pass), since manual refunds reuse the exact same `succeeded_at` column and code path that test already exercises — re-proving period math here would duplicate that suite. This file instead proves manual refunds are *included* in the report at all (see next row). |
| Consistent totals and cancelled-order balance handling | "period financial report gross/successful refunds/net..."; "the Cash method bucket... is_fully reduced..."; "the GCash method bucket is reduced... but not by the unrelated never-refunded PayMongo fixture" (proves no cross-contamination); "a cancelled order that was fully manually refunded settles at amount_paid=0" |

**Structural (not live) contract test on the Edge Function** — proves the source code:
uses `signInWithPassword` (never reads `auth.users`, never uses `pgcrypto`/`crypt()`); confirms the
verified identity matches the bearer token's identity; passes `p_admin_id` only from that verified
identity, never a body field, and doesn't even read an admin-id-shaped body field at all; calls the
write RPC only via the service-role client; checks the lockout *before* verifying the password and
records the attempt *after*; never logs or echoes the password; uses a separate throwaway client for
verification and signs it out again.

**What none of this can prove — stated plainly, not glossed over:** whether
`signInWithPassword` actually, correctly rejects a wrong password and accepts a right one when
talking to a *real* Supabase Auth server. Postgres/pglite has no GoTrue server to talk to, so the
pgtest suite cannot exercise that call at all, and the contract test only confirms the call exists
and is used correctly — it cannot execute it. **This needs a real integration test against a
deployed (dev/staging) Supabase project before this feature is trusted in production** — create a
test admin account, hit the deployed Edge Function with a wrong password (expect 401, then a real
correct password (expect 200), and confirm 5 wrong attempts in a row actually returns 429. This is
listed again in §6 as a required step before go-live, not silently assumed to be fine.

Also re-ran, to confirm no regression:
```
$ npm test                     # full 27+3-script chain — all passed
$ npm run test:edge-functions  # 19 functions build cleanly (18 existing + record-manual-refund)
$ npm run build                # clean production build, exit 0
```
`node scripts/token-lint.mjs` and `node scripts/axe-lint.mjs` also pass against the new/edited
frontend files.

**Not visually tested.** No browser tool was available this session. `ManualRefundModal.jsx` reuses
`RefundPaymentModal.jsx`'s exact modal shell (`modal-body-scroll`, `FocusTrap`, same footer
pattern), which is already visually established in this codebase, but the new fields (return
method selector, conditional reference/notes, password field) were not opened in an actual browser
at any viewport width. Flagging this explicitly rather than claiming it was checked.

---

## 6. Remaining unsupported features and business decisions

1. **Live password-verification integration test is required before go-live** (§5) — the single
   most important gap. Everything else about this feature can be trusted from the tests above;
   this one specific call cannot be, from this sandbox.
2. **No "approved amount vs. eligible amount" database field**, same limitation noted in the prior
   UI-alignment report — the modal caps the input at the technical maximum, but "how much did the
   business actually decide to return" still lives only in the admin's judgment when they type the
   amount, for both refund channels.
3. **No charge-correction feature** (still, as before) — a manual refund records money that has
   already moved; it does not and should not change `orders.shipping_cost`. If the business wants
   a mistaken charge corrected on an active shipment, that is a separate, not-yet-built feature —
   not silently addressed by this one.
4. **No cargo-return tracking** — unrelated to this feature, still an open business decision from
   the earlier study.
5. **Business question**: should `record_manual_refund` require a *second* admin's confirmation
   (four-eyes), given there is no independent provider check (like PayMongo's own validation) to
   catch a mistaken or fraudulent manual entry the way there is for a provider refund? Not
   implemented — flagged as a decision, not assumed either way.

---

## 7. Deployment steps (if applied)

1. `supabase db push` — applies `20260918020000_manual_refund_recording.sql`. Non-breaking: one
   `NOT NULL` is dropped (widens, not narrows, what's allowed), new columns are nullable/defaulted,
   new CHECK constraints only apply to new manual-channel rows (existing paymongo rows already
   satisfy them since they already have non-null `payment_id`). `get_payment_refund_history` is
   dropped and recreated with more output columns — any client code calling it with the *old*
   column list would still work (callers select by name, not position), and `src/lib/database.js`
   already expects the extra fields.
2. `supabase functions deploy record-manual-refund` — needs `SUPABASE_SERVICE_ROLE_KEY`,
   `SUPABASE_URL`, `SUPABASE_ANON_KEY` (already configured for the other Edge Functions in this
   project; no new secret to add).
3. Frontend: standard build + deploy.
4. **Before enabling this for real admins:** run the live integration test from §5 against a
   dev/staging Supabase project first.

---

## A note on git state

`git log` shows the repository's most recent two commits (`6c97331`, `e1c5f2a`) were authored by
the actual account (`justhulaanmo`) and already include the prior turn's UI-alignment changes —
this appears to be the user's own tooling auto-committing the working tree between turns, not
something I did. **I did not run `git commit` at any point in this session** — every change
described above is a local, uncommitted (or, if the same auto-commit process runs again, committed
by that external process, not by me) working-tree edit, consistent with your "do not commit"
instruction. Flagging this for transparency rather than silently ignoring it.

---

## Taglish summary

**Bakit sa Edge Function ginawa ang pag-verify ng password, hindi sa database mismo.** Wala
talagang access ang Postgres sa mismong naka-encrypt na password sa Supabase Auth — kaya ang tama
at ligtas na paraan ay tawagan mismo ang Supabase Auth (`signInWithPassword`) sa isang Edge
Function (server-side), hindi sa browser lang, at hindi rin sa pagbasa ng `auth.users` mismo.
Ang RPC na sumusulat sa database ay **hindi na-access ng browser mismo** kahit sino pa — service
role lang ang puwede tumawag dito, kaya kailangan talagang dumaan muna sa Edge Function.

**Ano ang binago.** Idinagdag ang "Record Manual Refund" button para sa Cash at manual-GCash na
bayad na hindi kayang i-refund ng automated na PayMongo system. Kapag pinindot ito, hihingin ang
amount, dahilan, kung paano talaga ibinalik ang pera (Cash o GCash — hindi kailangan parehas sa
paraan ng orihinal na bayad), ebidensya (reference number kung GCash, note kung Cash), kumpirmasyon
na naibalik na talaga ang pera, at password ng admin. **Hindi ito nagpapadala ng pera** — record
lang ito na naibalik na ang pera, para tama na ang Sales Reports (hindi na mag-iinflate ang Cash
Sales pagkatapos ma-cancel at ma-refund ang isang booking).

**Ano ang hindi pa nasusubukan nang buo.** Ang password verification mismo laban sa totoong
Supabase Auth server — walang GoTrue server dito sa sandbox para masubukan nang live. Kailangan pa
itong subukan sa isang tunay (dev/staging) na Supabase project bago ito buksan sa totoong mga
admin. Lahat ng ibang parte — ledger math, locking, idempotency, rate limiting, pag-exclude sa
provider recovery, at pagsama sa financial reports — sinubukan na nang buo gamit ang totoong
migration files, 39 passing tests.
