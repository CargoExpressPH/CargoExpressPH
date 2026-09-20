# Admin Email-Subscription Toggle — Rollback

Date: 2026-09-16. Targeted rollback of the unfinished "corrected email subscription" feature
described in `../audits/CONTACT_INQUIRIES_EMAIL_FLOW_AUDIT.md` (Section G). No replacement system was
introduced — this restores the behavior that existed before that feature was requested.

## Live deployment check (done before touching anything)

No Supabase CLI link or service-role credentials were available in this environment, so a
read-only PostgREST request was made directly against the live project using the local anon key:

```
GET /rest/v1/email_subscriptions?select=*&limit=1        → 404 PGRST205 "Could not find the table"
GET /rest/v1/email_subscription_events?select=*&limit=1  → 404 PGRST205 "Could not find the table"
GET /rest/v1/contact_inquiries?select=*&limit=1          → 200 [] (RLS-filtered, confirms the
                                                             request itself was valid)
```

**Confirmed: the `email_subscriptions`/`email_subscription_events` migration was never applied to
the live database.** Per the instructions, the unused migration file was therefore removed outright
rather than replaced with a corrective migration — there is no live schema state to correct, and no
live subscription/consent rows exist to preserve or migrate.

I could not verify whether the modified `submit-inquiry` / `unsubscribe-announcements` /
`broadcast-announcement` Edge Functions had actually been deployed to the live project (no
dashboard/CLI access). If they had been, live unsubscribe requests would have been failing with a
500 error — the new code checked `email_subscriptions` first and returned an error response before
ever reaching the original `profiles`/`contact_inquiries` update, and that table doesn't exist live.
**If you have dashboard access, it would be worth redeploying `unsubscribe-announcements` and
`submit-inquiry` from the now-restored source to be sure**, since I cannot confirm what's currently
live from here.

## What was restored

| File | Action |
|---|---|
| `src/lib/database.js` | Restored to the pre-feature version — removed `setMyEmailSubscription`, `getEmailSubscription`, `getEmailSubscriptionHistory`, `recordEmailSubscription`. |
| `src/pages/customer/ProfilePage.jsx` | Restored to the pre-feature version — this also fixes the reported `ReferenceError` (the import had been switched to `setMyEmailSubscription` but the handler still called `updateProfile`, which was no longer imported). The customer's "Email Announcements" toggle works exactly as it did before. |
| `supabase/functions/broadcast-announcement/index.ts` | Restored to the pre-feature version — recipients are resolved from `profiles.wants_announcements` OR `contact_inquiries.wants_announcements` again (deduped by email), with no per-batch subscription recheck (that was new code, removed with it). |
| `supabase/functions/submit-inquiry/index.ts` | Restored to the pre-feature version (git-restored from the commit immediately before the feature commit) — no longer writes to `email_subscriptions`/`email_subscription_events`. |
| `supabase/functions/unsubscribe-announcements/index.ts` | Restored to the pre-feature version, same method — unsubscribing again only updates `profiles`/`contact_inquiries` directly, and a failure there is reported as an error again (the intermediate version's early-return before that update is gone). |
| `supabase/migrations/20260916100000_email_subscription_corrected_scope.sql` | Deleted — never applied anywhere live (see above). |

No other files were touched.

## What was explicitly preserved (not part of this rollback)

- `src/lib/firebase-messaging.js` — the unrelated Firebase push-notification fix from a separate
  task. Verified untouched (`git diff HEAD` is empty for this file); still contains the
  `getReadyServiceWorkerRegistration()` fix and the `[push-debug]` diagnostic logging.
- `src/pages/public/AboutPage.jsx` — the public Contact Us form and its opt-in checkbox were never
  modified by the canceled feature in the first place; confirmed untouched.
- `../audits/PASSWORD_RESET_FLOW_FIX.md`, `../audits/PUSH_NOTIFICATION_ENABLEMENT_FIX.md` — unrelated reports from
  earlier tasks, left in place.
- `../audits/CONTACT_INQUIRIES_EMAIL_FLOW_AUDIT.md` — kept as a historical record, with a note added at the
  top pointing to this rollback so it isn't mistaken for a description of the current code.
- Commit `bc11420` itself was **not reverted or reset** — its `firebase-messaging.js` change stays
  committed; the parts of it that introduced this feature (`submit-inquiry`,
  `unsubscribe-announcements`, the migration) are undone as working-tree changes on top of it,
  ready for a normal commit if you want one. Nothing was force-reset or checked out destructively
  (`git reset --hard` was not used).

## Tests performed and results

| Check | Result |
|---|---|
| `npx vite build` | Passed. |
| `npm run test:edge-functions` (builds all 18 Deno Edge Functions, including the two restored ones) | Passed. |
| `node scripts/smoke-check.mjs` | Passed. |
| `node scripts/axe-lint.mjs` | Passed (161 files). |
| `node scripts/token-lint.mjs` | Passed (217 tokens, 198 files). |
| `git diff` of all three git-restored files against their correct pre-feature versions | Empty — confirms an exact, clean restoration, not a manual approximation. |
| `grep -r "email_subscription"` across `src/` and `supabase/` | No matches — no leftover imports, calls, or references anywhere. |
| `grep -r "email_subscription"` across `scripts/` (test suite) | No matches — no test ever depended on the canceled feature. |

**Pre-existing, unrelated failures observed while running the wider `npm test` chain** (not caused
by this rollback — confirmed both files are untouched by any change in this session):
- `scripts/security-hardening-contract-test.mjs` fails trying to `JSON.parse` `vercel.json`, which
  has a UTF-8 byte-order-mark already committed in `HEAD` (`git diff HEAD -- vercel.json` is empty).
- `scripts/payment-refund-pgtest/run.mjs` fails on a Windows path-resolution bug unrelated to this
  feature (seen and noted in an earlier task's report too).

**Not tested** (would require live network/Supabase access, explicitly out of scope per
instructions not to send real emails, publish announcements, create trips, or modify customer
data):
- An actual Contact Us form submission end-to-end.
- An actual customer toggling Profile → Email Announcements in a running browser.
- An actual announcement/trip publish triggering `broadcast-announcement` against real data.
- An actual click of a real unsubscribe link.

## Still needs a decision from you

- Whether to commit these working-tree changes (nothing was auto-committed).
- Whether `submit-inquiry`/`unsubscribe-announcements` need redeploying to Supabase, in case the
  in-between (feature) version had already been deployed live — I have no way to check this from
  here.
- The `vercel.json` BOM and the pgtest path bug are pre-existing issues unrelated to this task;
  flagging them but leaving them untouched since they weren't part of what was asked.

---

## Simple Taglish explanation

**Ano ang na-restore:** binalik ko lahat ng apat na file (`database.js`, `ProfilePage.jsx`,
`broadcast-announcement`, `submit-inquiry`, `unsubscribe-announcements`) sa dating gumagana nilang
bersyon — bago pa dumating yung "admin subscription toggle" na feature. Kasama dito, naayos na rin
yung sirang Profile toggle (yung `ReferenceError` na dulot ng hindi kumpletong edit dati) —
awtomatikong naayos ito dahil bumalik lang ito sa orihinal, tamang code. Tinanggal ko rin yung bagong
migration file dahil kumpirmado, VIA live check gamit ang totoong Supabase project, na HINDI pa
pala ito na-apply kahit saan — kaya ligtas siyang burahin nang buo, wala namang datos na mawawala.

**Ano ang pinanatili (hindi ginalaw):** yung ayos sa push notifications (ibang task yun, hiwalay) —
buo pa rin ito, chinek ko at walang pagbabago. Ganun din yung Contact Us form sa AboutPage — hindi
naman talaga ito nagalaw kahit noong ginagawa pa yung canceled feature.

**Ano ang na-test:** build, edge function build/typecheck, smoke test, accessibility lint, at CSS
token lint — lahat pasado. Chinek ko rin nang detalyado na EXACT match ang na-restore na files sa
kanilang orihinal na bersyon (walang pagkakaiba), at wala nang natitirang reference sa buong
codebase sa tinanggal na feature.

**Ano ang hindi pa na-verify:** hindi ko masusubukan ang totoong pag-submit ng form, pag-toggle sa
browser, o totoong pag-send ng email — kailangan ng live browser/network para dito, at hindi rin
ako dapat magpadala ng totoong email o gumawa ng totoong trip/announcement ayon sa instructions.

**May kailangan pa bang gawin sa deployment/database?** Wala nang kailangang i-clean sa database —
kumpirmado, hindi naman na-apply yung migration kahit saan. Ang tanging bagay na dapat mong tingnan:
kung na-deploy na noon yung "gitnang bersyon" (yung may bug sa unsubscribe) ng `submit-inquiry` o
`unsubscribe-announcements` sa Supabase, mabuting i-redeploy mo na lang ulit gamit yung bagong
(restored) na source code, dahil wala akong access para i-check mismo ang live na deployed function
code.
