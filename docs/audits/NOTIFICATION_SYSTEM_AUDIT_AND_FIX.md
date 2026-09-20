# Admin Notification System — Audit & Fix

Date: 2026-09-16. Triggered by: customer requested an order cancellation; no notification (in-app or
push) appeared on an admin account, despite that account's Push Notifications showing "Enabled".

## TL;DR

**This is not primarily a code bug — it's a deployment gap.** The correct logic already exists in
this repo's migration files. A large batch of migrations (roughly everything from
`20260904235457` onward) was written correctly but was **never applied to the live Supabase
database**. Verified directly against the live project (read-only), not assumed:

- The live `request_order_cancellation()` function has no notification-insert code at all — an
  older version, from before a later migration restored that behavior.
- The entire push-delivery outbox (`notification_delivery_jobs` table, its enqueue trigger, its
  claim/complete RPCs, and the `process-push-deliveries` pg_cron worker) does not exist live.
- The "new booking → notify admins" trigger does not exist live.
- The "order finalized as Cancelled → notify admins" trigger does not exist live.

One genuine, narrow **code bug** was also found and fixed, independent of the deployment gap: in
`supabase/functions/send-push/index.ts`, a routing flag was hardcoded to `true` instead of being
computed from the request payload, which — once the missing migrations above are deployed — would
still have silently broken any non-worker caller of that function.

## 1. How this was verified (not guessed)

`npx supabase migration list` failed (`Cannot find project ref` — no linked project/credentials in
this environment). Two other verification methods were used instead:

**A. `supabase/schema.sql` is a genuine, near-real-time live snapshot**, not a stale file —
confirmed via `git log`: it was last regenerated on **2026-09-15**, one day before this
conversation, by `scripts/sync-schema-from-live.mjs` (which pulls the *live* database via
Supabase's read-only Management API — see that script's own header comment). Its contents are
therefore direct evidence of what the live database actually had, as of yesterday.

**B. A direct, read-only PostgREST request** against the live project (anon key only, `GET`
requests, nothing mutated):
```
GET /rest/v1/email_subscriptions?select=*&limit=1  → 404 PGRST205 "table not found"  (unrelated to
                                                       this task — confirms this technique works)
GET /rest/v1/contact_inquiries?select=*&limit=1     → 200 [] (RLS-filtered — confirms requests
                                                       reach the real project)
```

Both methods agree with each other and with the migration-file dates, giving high confidence in
the findings below. A live RPC *call* (even one designed to fail) was attempted to further confirm
function existence and was blocked by this environment's own safety controls as a
"modify shared resources" action — that specific check was not completed, but is not needed: the
schema.sql function-body comparison in §2 is direct and conclusive on its own.

## 2. Layer 1 — Database triggers

### Cancellation *request* (the exact scenario tested)

The customer-facing "Request Cancellation" button calls `requestOrderCancellation()`
(`src/lib/database.js:597`) → `supabase.rpc('request_order_cancellation', ...)`. Comparing the
function body:

| | Live (`supabase/schema.sql:2737-2784`) | In the repo's migrations (`20260904235517_server_notification_event_coverage.sql:264-339`) |
|---|---|---|
| Updates order status to `Pending Cancellation` | ✅ | ✅ |
| Writes an `activity_logs` row | ✅ | ✅ |
| **Inserts a `notifications` row for every admin** | ❌ **absent** | ✅ present |

The migration's own comment even names this exactly: *"Restore the cancellation-request
notification removed by a later JSONB refactor"* — that restoration itself was written correctly,
but never deployed. **This is the entire reason nothing appeared**: no `notifications` row was ever
created, so there was nothing for Realtime to push to the bell and nothing for the (also-missing)
outbox to turn into a push notification.

### New booking

`orders_notify_new_booking` (from the same migration, calling `notify_new_order()`) is also absent
from the live trigger list. Confirmed the triggers that *do* exist live on `orders`
(`orders_guard_customer_insert`, `orders_guard_update`, `orders_log_status_event`,
`orders_prepare_insert`, `orders_updated_at`) — read each of their live function bodies — and none
of them writes to `notifications` either. A new booking today updates `order_status_events` and
nothing else notifies an admin about it.

### Order finalized as `Cancelled`

`orders_notify_admins_of_cancellation` (`20260910000000_notify_admins_order_cancelled.sql`) is also
absent live, for the same reason.

### What *is* live and working today

`contact_inquiries_notify_admins` (an older migration, `20260822150000`) **is** live, and its body
matches the repo exactly (`notify_admins_of_contact_inquiry()`, schema.sql:2185-2208 vs. the
migration file — identical). **A new contact inquiry does correctly create an in-app notification
row for every admin today.** It just can't reach push (see §4) or, if the admin isn't watching the
bell live, may go unnoticed.

## 3. Layer 2 — In-app Realtime (admin dashboard)

**This layer is already correct and was not the problem.** Verified in code, both places:

- `src/components/layout/AdminLayout.jsx:64-94` — subscribes to `postgres_changes` on
  `public.notifications` filtered to `user_id=eq.${user.id}` (the signed-in admin's own row),
  updating the unread badge count on INSERT/UPDATE/DELETE. `AdminLayout` wraps every admin route
  (`src/App.jsx`), so this subscription is genuinely global across all admin pages, not per-page.
- `src/components/ui/AdminNotificationCenter.jsx:100-111` — the dropdown panel itself has its own,
  identically-filtered realtime subscription, so the list content (not just the badge count) also
  updates live.

Both correctly rely on each `notifications` row having a real per-admin `user_id` — which is
exactly how every admin-fan-out trigger in this codebase inserts (one row per admin profile, from
`SELECT p.id FROM profiles WHERE role='admin'`), not a shared sentinel value. Nothing here needed
fixing; once §2's triggers are deployed, these subscriptions will surface them instantly with no
further change.

## 4. Layer 3 — Push delivery (Firebase / Web Push)

### The intended, current architecture (already correctly written in the repo)

```
notifications INSERT (any producer)
  → trigger: notifications_enqueue_delivery_jobs()
    → INSERT notification_delivery_jobs (one row per registered device for that user)
  → pg_cron 'process_push_deliveries' (every minute)
    → Edge Function process-push-deliveries
      → claim_notification_delivery_jobs() RPC (atomic claim)
      → POST send-push { job_id, job_claim_id, notification_id, device_token_id }
        → send-push loads the trusted notification row, sends via FCM or Web Push,
          calls complete_notification_delivery_job() to record the outcome
```

**None of the outbox half of this exists live**: `notification_delivery_jobs` is absent from
`schema.sql`'s table list entirely (confirmed against the full `CREATE TABLE` list — 21 tables
live, this is not one of them), so `notifications_enqueue_delivery_jobs`, the two claim RPCs, and
`process-push-deliveries`'s target table are all missing. **Push delivery is currently
non-functional for every notification type, not only cancellations** — a device showing "Enabled"
only reflects that the browser registered a token in `user_device_tokens` (confirmed that table
*does* exist live, and its registration RPC does too, from earlier verification this session); it
says nothing about whether anything server-side ever turns a notification into an actual push, and
right now nothing does.

Also confirmed live-but-orphaned: `contact_inquiries.push_dispatched_at` /
`push_dispatch_started_at` / `push_dispatch_claim_id`, and the `claim_contact_inquiry_push()` /
`complete_contact_inquiry_push()` RPCs — remnants of an even earlier, contact-inquiry-specific push
mechanism. Searched the entire repo (`supabase/` and `src/`) for anything that still calls
`send-push` for a contact inquiry, a cancellation, or any event-shaped payload: **the only caller
found anywhere is `process-push-deliveries`**, using the job-based shape. Nothing (live or in the
repo) still drives that older claim mechanism — it's dead scaffolding on both sides.

### The one real code bug (found and fixed)

`supabase/functions/send-push/index.ts` had:
```ts
const isServiceJobRequest = true
```
Since this is checked first and always true, every other branch in the function
(`event === 'cancellation_request'`, `event === 'cancellation_review'`, the contact-inquiry branch,
and the generic authenticated path) was **unreachable code** — any call shaped like those would get
an immediate `400 "A valid claimed delivery job is required"`. This didn't cause today's reported
symptom (nothing calls those shapes right now, confirmed by the same repo-wide search above), but
it was a live landmine: the next attempt to call `send-push` directly (bypassing the outbox, e.g.
for an "instant" push) would have silently failed with a confusing error.

**Fixed** to derive the flag from the actual payload:
```ts
const isServiceJobRequest = isUuid(requestedJobId)
  && isUuid(requestedJobClaimId)
  && isUuid(requestedNotificationId)
  && isUuid(requestedDeviceTokenId)
```
This restores the function's original dynamic routing without touching the (correct, and the only
currently-used) job-based path — `process-push-deliveries` always supplies all four fields as valid
UUIDs, so its behavior is unchanged.

## 5. Files changed

| File | Change |
|---|---|
| `supabase/functions/send-push/index.ts` | One condition fixed (§4) — no other logic touched. |

No migrations were added or modified. The correct logic for §2 and §4's outbox already exists in
already-committed migration files; the fix is deploying them, not writing new ones (see §6).
Rewriting or duplicating that logic in a new migration would only create drift against what's
already correctly written — not requested, and not done.

## 6. What actually needs to happen next (deployment, not code)

I do not have a linked Supabase project or credentials in this environment, and would not run a
live database migration without your explicit go-ahead regardless — this is exactly the kind of
hard-to-reverse, shared-resource action that needs a deliberate decision, not an automatic one.

**To fix this for real:**
1. `supabase link --project-ref <your-project-ref>` (once, if not already linked from wherever you
   normally deploy).
2. `supabase db push` — applies every migration from wherever the live database currently is, up
   through the newest file in `supabase/migrations/`. Given the scope found here, review the
   pending migration list first (`supabase migration list`) rather than assuming it's only the
   handful named in this report — the gap appears to start around `20260904` and may include other
   unrelated migrations from that window.
3. **Prerequisite for the push worker specifically**: `private.trigger_push_delivery_worker()`
   reads `project_url` / `service_role_key` from Supabase Vault. If those weren't already set up
   for the *other* Vault-dependent workers in this project (daily payment reminders, photo storage
   health — both already live and presumably working), they'll need to be added:
   ```sql
   select vault.create_secret('https://<PROJECT_REF>.supabase.co', 'project_url');
   select vault.create_secret('<SERVICE_ROLE_KEY>',                'service_role_key');
   ```
   (Migration comments suggest these may already exist, shared with those other workers — worth
   checking `select name from vault.decrypted_secrets` before assuming either way.)
4. Redeploy `send-push` (`supabase functions deploy send-push`) so the fix in §4 actually reaches
   the live function — a local code fix has no effect until deployed, same as with any Edge
   Function change.
5. After deploying, confirm the cron job is actually scheduled and running:
   `select * from cron.job where jobname = 'process_push_deliveries';` and
   `select * from cron.job_run_details order by start_time desc limit 5;`

## 7. Tests performed and results

| Check | Result |
|---|---|
| `npm run test:edge-functions` (builds/typechecks all 18 Edge Functions, including the fixed `send-push`) | Passed |
| `node scripts/push-notification-contract-test.mjs` | Passed |
| `node scripts/notification-ux-contract-test.mjs` | Passed |
| `node scripts/smoke-check.mjs`, `axe-lint.mjs`, `token-lint.mjs` | Passed |
| `npx vite build` | Passed |
| Live read-only verification of table/trigger/function existence (§1) | Done, as described |

**Not tested — would require live deployment access this environment doesn't have:**
- Actually running `supabase db push` and confirming the migrations apply cleanly against the real
  current live state (there could be an intermediate state or conflict not visible from
  `schema.sql` alone — always review `supabase migration list`'s diff before pushing).
- An actual end-to-end cancellation request → admin bell update → admin device push, after
  deployment.
- Whether the Vault secrets in §6 step 3 already exist.
- Whether `FIREBASE_SERVICE_ACCOUNT_B64` / `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` /
  `VAPID_SUBJECT` are actually configured as `send-push` secrets in the deployed project — required
  regardless of the outbox, and not verifiable from here.

## 8. Summary of what's fixed vs. what's still blocked

- **Fixed in this repo, right now**: the `send-push` dead-code/misrouting bug (§4).
- **Already correct in this repo, waiting on deployment**: the cancellation-request notification
  insert, the new-booking notification trigger, the finalized-cancellation notification trigger,
  the entire push delivery outbox + worker + cron schedule, and the `notifications.type` CHECK
  constraint's missing `payment_update` value.
- **Already correct and already live, unaffected by any of this**: the in-app Realtime bell/panel
  subscriptions (Layer 2), and the new-contact-inquiry admin notification (in-app only — its push
  delivery is blocked by the same missing outbox as everything else).
- **Cannot be completed from this environment**: linking the project, running `supabase db push`,
  redeploying `send-push`, and confirming Vault/provider secrets — all genuinely need your access,
  not just code changes.
