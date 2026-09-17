# CargoExpressPH Post-Deployment Regression Audit

**Audit date:** 2026-09-16 (Asia/Manila)
**Scope:** live Supabase project `duigaivxgxlnjmfienhg` (linked, authorized CLI access), live production frontend at `https://www.cargoexpress-ph.online`, repository at commit `50f589a` on `main`.
**Mode:** verification only. No migrations were applied, no Edge Functions were deployed, no application code was changed, no bookings/payments/refunds/emails were created. All database access was read-only (`supabase db query`, `supabase migration list`, `supabase functions list/download`). All HTTP access to production was read-only GET/anonymous-RPC requests.
**Not available in this session:** a browser automation tool, a designated staging project, or designated test accounts/mailboxes/devices. Where the task required these, they are listed as remaining manual work rather than claimed as done.

---

## A. Simple Taglish summary

Na-verify ko gamit ang **live** Supabase project (hindi lang local files) na deployed na talaga ang tatlong pangunahing fixes: ang financial report RPC (F-01), ang announcement email durability system (F-03), at ang validation gate (F-04). Pinatakbo ko mismo ang binagong SQL query laban sa totoong database — may 1 tunay na cash payment (₱5,000) at bumalik ang tamang JSON, walang `GROUP BY` error. Na-download at na-diff ko rin ang aktwal na na-deploy na Edge Function code (`broadcast-announcement`, `email-trip-reschedule`, `paymongo-webhook`) laban sa repository — magkapareho, wala akong nakitang drift. Pumasa rin ang buong `npm run check` sa parehong commit na naka-deploy.

**Pero may isang malaking butas na hindi pa naayos, at ito mismo ang partikular na hiniling mong i-verify:** ang trip-reschedule email ay **hindi pa rin** umaabot sa lahat ng naka-enable na subscriber. Binasa ko ang aktwal na na-deploy na `email-trip-reschedule` function at ang trigger na nagpapatakbo nito — direktang sinasabi sa sariling comment ng bagong migration (`20260916150000_email_updates_subscription.sql`) na "the separate, pre-existing trip-reschedule courtesy email... untouched here" at "[email_subscriptions] is NOT read by [it]." Ibig sabihin: kapag na-reschedule ang isang trip, ang mga taong nag-inquiry lang (walang account) at ang mga rehistradong customer na walang booking sa specific trip na iyon ay **hindi** makakatanggap ng email — kahit naka-enable sila sa "Email Updates." Ito ang parehong butas na nakita sa dating audit, at hindi ito naayos ng fix report (malinaw na sinabi doon: "The separate private booking/payment and trip-reschedule recipient paths were not broadened").

Walang bagong critical na na-discover akong ibang malaking security hole sa live system — pero hindi ko rin ma-verify nang buo ang mga browser workflow (login, booking form, print/PDF, push, email delivery) dahil walang designated test account/staging environment/browser tool na ibinigay para dito. Kailangan pa ring gawin iyon bago ang defense.

---

## B. Deployment verification matrix

| Item | Method | Result |
|---|---|---|
| Migration history (local vs remote) | `supabase migration list` (linked, Management API) | **Match.** All 179 local migration timestamps through `20260916161000` (the F-01 and F-03 fix migrations) show identical `local`/`remote` pairs. No remote-only or local-only migrations. |
| `get_financial_report_data` live definition | `supabase db query --linked` reading `pg_proc.prosrc` | **Confirmed deployed.** No `method_agg` CTE present; matches the F-01 fix migration exactly. |
| `get_financial_report_data` live execution | Reconstructed the function's own CTE chain and ran it directly against production data via `supabase db query` | **Executes successfully.** Returned real aggregated data (1 payment, ₱5,000, method `cash`, 0 refunds) for the last 365 days — no SQL error. |
| `get_financial_report_data` admin gate | Raw RPC call with no admin/auth context | **Rejected**, `P0001: Admin access required` (server-side `RAISE EXCEPTION`, function-body guard, confirmed live). |
| `get_financial_report_data` via public REST as anon | `POST .../rest/v1/rpc/get_financial_report_data` with the app's anon key, no session | **Rejected, HTTP 401**, `permission denied for function get_financial_report_data` (PostgREST-level EXECUTE grant, not just the in-function check — two independent layers both hold). |
| Announcement durability tables/RPCs | `information_schema` + `pg_proc` via `supabase db query --linked` | **Confirmed deployed.** `announcement_email_broadcasts`, `announcement_email_recipients` exist; all 5 RPCs (`claim_announcement_email_broadcast`, `claim_announcement_email_recipient`, `finish_announcement_email_broadcast`, `prepare_announcement_email_payload`, `record_announcement_email_outcome`) exist, `SECURITY DEFINER`, `EXECUTE` granted **only** to `service_role`/`postgres` — no `authenticated`/`anon` grant. |
| Announcement tables — RLS/grants | `pg_policies`, `role_table_grants` | `announcement_email_broadcasts`: RLS on, one SELECT policy for `authenticated` gated by `is_admin()`, aggregate columns only. `announcement_email_recipients`: RLS on, **zero** policies and **no grant at all** to `authenticated`/`anon` — only reachable through the `SECURITY DEFINER` RPCs above. Correctly locked down. |
| Deployed Edge Functions — inventory | `supabase functions list` | 18 functions, all `ACTIVE`, all with `updated_at = 1789569462363` (2026-09-16 22:37:42 PHT) — a single bulk redeploy event. |
| `broadcast-announcement` source drift | `supabase functions download --use-api` into an isolated scratch dir, diffed against repo | **Byte-identical** except a stripped UTF-8 BOM in the local file (cosmetic, harmless). |
| `_shared/announcement-broadcast-worker.ts` source drift | Same method | **Byte-identical.** |
| `email-trip-reschedule` source drift | Same method | **Byte-identical** (same harmless BOM difference only). |
| `paymongo-webhook` source drift | Same method | **Byte-identical.** |
| Frontend build freshness | Fetched `https://www.cargoexpress-ph.online/`, inspected `index.html`, `sw.js` | Live `index.html` references hashed bundles that resolve (HTTP 200); `sw.js` `CACHE_VERSION = 'v1789569507114'` (2026-09-16 22:38:27 PHT) — **within ~45 seconds of the Edge Function redeploy timestamp**, consistent with one coordinated deployment, not a stale/partial rollout. |
| Frontend build reproducibility | `npm run build` locally at the same commit, diffed asset filenames against production | Vendor chunk hashes (`vendor-react`, `vendor-supabase`, CSS) matched exactly on the **first** local build attempt found already in the tree; a **second, fresh** local build produced different hashes for some route chunks (e.g. `HomePage-*.js`) than both the first local build and production. **Conclusion:** this bundler's chunk hashing is not perfectly deterministic run-to-run on this machine (route-chunk filenames vary slightly across otherwise-identical builds), so asset-hash-for-hash matching cannot be used as proof of freshness here — content size/structure and the timestamp correlation above are the reliable signals. This should be treated as a build-reproducibility gap worth fixing (pin bundler/minifier versions, verify with `--minify=false` diff) but is not evidence of a stale deploy.
| PWA precache font assets | `sw.js` precache list | Two Inter WOFF2 files precached (`inter-latin-opsz-normal`, `inter-latin-opsz-italic`) — matches the F-04 fix's "at least one, verify what's actually emitted" behavior, live-confirmed rather than assumed. |
| Config/project match | `.env` `VITE_SUPABASE_URL` vs linked project ref vs production's actual Supabase calls | `.env`'s `VITE_SUPABASE_URL=https://duigaivxgxlnjmfienhg.supabase.co` matches the linked/verified project. `.env` `VITE_APP_URL=http://localhost:5173` is a local-dev-only value and was **not** used as deployment evidence (per the prior audit's own caveat) — production env vars live in Vercel, which this session has no access to enumerate; only their *effects* (the served HTML/CSS/JS/CSP headers) were checked. |
| Secrets exposure | Repo scan + response headers | No secret values observed in transit or in repo; only public/placeholder names. Not exhaustively re-scanned this session — relying on the prior audit's dedicated pass, which is still valid (no new secret-handling code was touched by the fix report). |

**No 401/permission errors were hit against the Management API in this session** — CLI access was authorized and worked throughout, unlike the prior audit. This means this audit's "deployed vs repo" conclusions are **actual live evidence**, not repository inference.

---

## C. Previous findings — current status

### F-01 — Financial report RPC crash — **VERIFIED FIXED (live)**
- Evidence level: **live execution against production data**, plus live source inspection, plus live admin-gate rejection test, plus a full clean `npm run check` pass at the deployed commit.
- The exact reconstructed query (minus the `is_admin()` guard, which needs a real admin JWT this session doesn't have) ran without error and returned correct aggregates for real rows.
- **Not yet done:** an actual authenticated **admin** browser session generating a report end-to-end (screen → print → PDF) was not exercised — no admin test credentials were available this session. The `financial-report-pgtest` suite (which does exercise the RPC with admin/non-admin roles inside PGlite) passed as part of `npm run check`.
- **Remaining verification:** log in as a real admin in a browser, generate a report for a known date range with at least one cash and one GCash payment and one refund, and manually reconcile the totals shown against the underlying `payment_transactions`/`payment_refunds` rows.

### F-02 — Booking-draft privacy — **VERIFIED FIXED (static, live-deployed code)**
- Confirmed the live-deployed frontend bundle is built from the commit containing the fix (see build/timestamp correlation in §B); read the actual fixed source (`src/lib/bookingDraft.js`, `AuthContext.jsx`, `BookShipmentPage.jsx`) line by line:
  - Draft keys are `cargoexpress.booking-draft.v2:<userId>:form|step`; no read/write happens without a resolved `userId`.
  - Legacy global `booking_form`/`booking_step` keys are deleted (never adopted) on every read/write path.
  - Logout (`AuthContext.jsx:412`) calls `clearBookingDraftStorage(signedInUserId)` before clearing session state.
  - The delayed-autosave race is guarded by an `activeDraftUserRef` checked inside the debounced `setTimeout` callback, and the effect's cleanup cancels the pending timer whenever `user?.id` changes — a genuine account-switch mid-typing will not leak into the next account's storage.
- **Not yet done:** no actual two-account browser session (A logs out mid-draft, B logs in on the same tab) was run — this is a real browser interaction and no second test account was available. `scripts/booking-dirty-state-contract-test.mjs` (21 fields, A/B isolation, legacy-key deletion) passed as part of `npm run check`, but that is a Node-level contract test simulating `sessionStorage`, not a live browser session.
- **Remaining verification:** the two-account shared-tab rehearsal in a real browser, exactly as F-01/F-02's own checklist describes.

### F-03 — Announcement broadcast reliability — **VERIFIED FIXED (live schema/RPCs/Edge Function), delivery unverified**
- Live-confirmed: durable tables, 5 RPCs with correct `SECURITY DEFINER`/service-role-only grants, RLS on both new tables, and byte-identical deployed Edge Function source for both `broadcast-announcement/index.ts` and `_shared/announcement-broadcast-worker.ts`.
- `broadcast-announcement-worker-test.mjs` (mocked provider: concurrency, partial failure, retry-only-failed, stable-key-after-timeout, consent-recheck-failure, completion-write-failure) and `announcement-broadcast-pgtest` (real migration, lease expiry, payload persistence, transaction rollback) both passed inside `npm run check` at the deployed commit.
- **Not yet done — and this is a real gap, not just "unverified":**
  1. **No real Resend send was made.** Provider-side idempotency-key behavior, 24-hour retention, and the `409 concurrent_idempotent_requests` vs `409 invalid_idempotent_request` distinction are implemented per Resend's documentation but have never touched the live Resend account. This is a **documentation-level** guarantee, not an **observed** one.
  2. **True multi-connection PostgreSQL concurrency was still not exercised** — PGlite is one backend. The lease/`FOR UPDATE SKIP LOCKED` logic is visible and correct by inspection of the live function source, but two genuinely concurrent admin clicks against production have not been observed.
  3. The 25-recipient-per-invocation batch limit (documented in the fix report) means any announcement to more than 25 enabled subscribers requires a **manual admin retry click** to finish sending; the UI's "unfinished" state was not visually confirmed in a browser this session.
- **Remaining verification:** send one announcement to 1–2 controlled test mailboxes from a staging/admin session; fire two overlapping send requests and confirm one accepted row per recipient; force one failure and confirm partial + admin retry works with only the failed recipient re-sent.

### F-04 — Validation gate — **VERIFIED FIXED (live, reproduced this session)**
- Ran `npm run check` in this checkout (which is the exact deployed commit — see §B) and it **passed end-to-end**: `smoke-check`, `axe-lint` (161 files), `token-lint`, all contract/PGlite suites including the new financial-report and announcement-broadcast suites, `test:edge-functions` (18 functions), `photo-fallback-browser-test`, production `build`, and `test:pwa-offline` (71 assets precached). No failures, no skipped steps.
- This directly falsifies the prior state described in the original audit (19 axe-lint errors, ENOENT on a renamed page, stale two-font PWA assertion) — all three are gone.
- **Caveat:** this was run in the existing checkout, not a fully clean `npm ci` from a fresh clone. `node_modules` was already installed and (per the fix report) had a previously-missing font package restored into it outside the lockfile-tracked flow. A clean-room `npm ci && npm run check` from a bare clone was not performed this session and is the one remaining gap in "the gate is trustworthy" — if that font package is not actually pinned correctly in `package-lock.json`, a fresh CI/deploy checkout could still fail even though this checkout passes.
- **Remaining verification:** `rm -rf node_modules && npm ci && npm run check` in this exact directory (safe, no live side effects) before the defense, to close that one gap.

### F-05 — Stale schema snapshot — **PARTIALLY FIXED, as previously reported; not independently re-verified in depth**
- Confirmed `supabase/schema.sql` still does not reflect current migrations (spot-checked: still lacks the F-01/F-03 objects). The fix report's claim that the file is now labeled historical was spot-checked and the header text is present.
- Still not regenerated (Docker/local Postgres unavailable, as before). This is unchanged from the original audit and is **not a live-security risk** — `supabase db push`/`migration list` (confirmed above) are what's actually authoritative and in sync.

### F-06 — PayMongo webhook timestamp hardening — **STILL OPEN, confirmed live, severity unchanged**
- Read the **live-deployed** `paymongo-webhook/index.ts` (byte-identical to repo, confirmed by diff in §B): still accepts `te` or `li` with no timestamp freshness check (`[parts.te, parts.li].some(...)`).
- This matches the fix report's own statement that F-06 was left open by instruction. No new risk found; severity assessment (Low, hardening, mitigated by idempotent reconciliation) still holds and was not re-derived from scratch this session — no webhook replay was attempted against the live endpoint, per the audit's explicit prohibition.

### F-07 — Report period/snapshot labeling — **VERIFIED FIXED (live source)**
- Confirmed in the actual `src/pages/admin/ReportsPage.jsx` at the deployed commit: both the on-screen table (line 309) and the print/PDF section (line 412) now say "Deliveries Completed in Period — **Current Financial Snapshot**" and explicitly state the values are "as of {generatedAt}" and "not expected to total to the period collections."
- **Not yet done:** actual print-preview/PDF-export visual inspection in a browser (no browser tool available this session). The wording is confirmed present in source; whether it renders without clipping/blank pages in the real print dialog was not observed.

---

## D. Section 3 — Reschedule-email rule: **STILL FAILING, confirmed against the live deployed path**

This was explicitly called out as something not to assume from the general announcement sender alone, so it was traced end-to-end against the actual deployed database trigger and Edge Function, not the repo in the abstract.

**Traced path:** `RescheduleTripModal.jsx` → `updateTrip(...)` (departure/arrival date change) → live DB trigger `trips_notify_reschedule_email` (`20260910020000_trip_reschedule_email_trigger.sql`, confirmed present in migration history) → `net.http_post` to the live `email-trip-reschedule` Edge Function (source byte-diffed against repo — identical) → that function queries `orders` for **active (non-cancelled) bookings on that specific trip**, then `profiles` filtered to `role='customer' AND wants_announcements=true`, and emails only those people.

**Confirmed live, by reading both the deployed Edge Function and the deployed migration comment for `email_subscriptions` (`20260916150000_email_updates_subscription.sql`, which the fix report added and which is itself explicit about this):**

> "the former [`profiles.wants_announcements`] keeps gating the separate, pre-existing trip-reschedule courtesy email (email-trip-reschedule Edge Function, **untouched here**)... **Neither is read by the sender going forward** — `email_subscriptions` is the sole recipient source for `broadcast-announcement`."

This is the fix's own authors documenting, in the migration they shipped, that they deliberately did **not** connect the new unified `email_subscriptions` table (which is what "Enabled" now authoritatively means, and which does include inquiry-only subscribers) to the trip-reschedule email path.

| Case from the task | Current live behavior |
|---|---|
| Enabled inquiry subscriber, no account | **Not emailed.** No `orders`/`profiles` row exists for them at all; the reschedule function only ever queries `orders.user_id`. |
| Enabled registered customer, no booking on the rescheduled trip | **Not emailed.** The function's first query is `orders` filtered `WHERE trip_id = <this trip>`; a customer with zero orders on that trip never enters `trackingByUser`. |
| Customer already booked on the trip, opted in | **Emailed** — this is the only case the live path covers. |
| Disabled/unsubscribed email | **Correctly excluded** both ways: `unsubscribe_email_updates()` and `admin_set_email_subscription(..., false)` both force `profiles.wants_announcements = false` for a matching account, which the reschedule query does read. So opt-outs propagate correctly even though opt-ins for non-account emails cannot. |
| Duplicate email across inquiry/profile records | Not applicable to this path — the reschedule function never consults `email_subscriptions` or `contact_inquiries` at all, so there's no duplicate-send risk there, only the coverage gap above. `email_subscriptions.email` being a `PRIMARY KEY` does correctly collapse inquiry+profile duplicates for the **announcement/broadcast** path (F-03), which is separate. |
| Overlap between public broadcast and booked-customer paths | No overlap exists because the two systems are completely disjoint — the reschedule trigger never calls `broadcast-announcement`, and an admin sending a manual announcement through `AnnouncementsPage` does not know about a specific trip's rider list. |
| Private booking/payment details leaking into a public broadcast | Not applicable — no unified "public broadcast" reschedule path exists yet to check for this leak. If one is built later, this must be re-checked then (the current per-trip email does include the customer's own tracking numbers, which is fine since it's addressed only to that customer). |

**This finding is new relative to the two prior reports in one respect:** neither `SYSTEM_BUG_SECURITY_AUDIT.md` nor `SYSTEM_BUG_SECURITY_FIX_REPORT.md` lists this as a numbered finding (F-01…F-07) at all — it surfaces only as a one-line aside inside F-03's writeup ("The separate private booking/payment and trip-reschedule recipient paths were not broadened") and inside the new migration's own code comment. Given the task explicitly asked to verify this exact requirement, it is called out here as its own item:

### NEW-01 — Trip-reschedule emails do not reach all enabled subscribers
- **Severity:** Medium (courtesy notification gap, not a security/financial issue — no private data is exposed, no money is at risk)
- **Classification:** Confirmed deployment gap against a stated requirement; not a regression (this is how it has always worked; the requirement to broaden it was never implemented, not broken by the recent fixes)
- **Evidence level:** Live-verified — deployed Edge Function source read and byte-diffed, deployed trigger migration read, deployed `email_subscriptions` migration's own comments read
- **Affected components:** `supabase/functions/email-trip-reschedule/index.ts` (deployed, version 8), `supabase/migrations/20260910020000_trip_reschedule_email_trigger.sql` (deployed)
- **Reproduction:** Reschedule any `scheduled` trip's departure/arrival date. Observe (via `net._http_response` or Resend dashboard, not tested live here) that only customers with an active order on that trip and `profiles.wants_announcements = true` receive mail.
- **Expected vs actual:** Expected — every address with `email_subscriptions.subscribed = true` gets a reschedule notice when the admin chooses to send one. Actual — only trip-booked, opted-in account holders do; inquiry-only subscribers and opted-in customers without a booking on that trip never receive it, regardless of their `email_subscriptions` state.
- **Practical impact:** A defense panelist asking "does an inquiry-only subscriber get trip updates" will get a **no** if tested live. This is a real, demonstrable gap against the stated requirement, not a hypothetical.
- **Smallest fix:** Either (a) extend `email-trip-reschedule`'s recipient query to also select `email_subscriptions` rows with `subscribed = true` that aren't already covered by the per-trip booking list (as a separate, clearly-labeled "trip schedule update" broadcast segment, still excluding private tracking-number/booking details from that segment's email body), or (b) if the product decision is that this is intentionally a "courtesy notice only for people this specific trip actually affects," update the requirement/spec instead of the code, and say so explicitly in the demo. Both are legitimate outcomes — what isn't legitimate is presenting it as already working.
- **Verification needed after fixing:** Re-run this same trace against the live deployed function/trigger; confirm an inquiry-only test address and a booking-less opted-in customer both receive the notice, and confirm no private booking/tracking data appears in whatever is sent to non-booked recipients.

---

## E. Workflow verification matrix

| Workflow | Environment | What was actually exercised | Result |
|---|---|---|---|
| Migration deployment state | Live Supabase, Management API via `supabase` CLI | Full migration list diff, local vs remote | **Passed** |
| `get_financial_report_data` execution | Live Supabase, direct SQL | Reconstructed query executed against real payment data | **Passed** |
| `get_financial_report_data` authorization | Live Supabase (no-auth) + live PostgREST (anon key) | Two independent rejection paths (function guard, PostgREST grant) | **Passed** |
| Announcement schema/RPCs/grants | Live Supabase | Table/policy/grant introspection | **Passed** |
| Edge Function source drift (4 of 18 functions) | Live Supabase, downloaded via CLI | Byte diff vs repo | **Passed — no drift** |
| Frontend deploy freshness | Live production HTTPS | Timestamp correlation across SW cache version, function redeploy time, asset resolution | **Passed** (with the build-nondeterminism caveat noted in §B) |
| `npm run check` at deployed commit | This checkout (not a clean `npm ci`) | Full test/build/PWA chain | **Passed** |
| Clean-room `npm ci && npm run check` | — | Not run | **Untested — recommended before demo** |
| Booking draft account isolation (real browser, 2 accounts) | — | Not run, no second test account | **Untested — recommended before demo** |
| Admin report generation end-to-end (browser, real login) | — | Not run, no admin test credentials/browser tool | **Untested — recommended before demo** |
| Report print/PDF visual inspection | — | Not run | **Untested — recommended before demo** |
| Announcement send to real/test mailbox | — | Not run, no designated test mailbox provided | **Untested — recommended before demo** (see §F for what's needed) |
| Trip reschedule → email-trip-reschedule live trigger fire | — | Traced by code/config only, not fired live (would email real opted-in customers with real bookings) | **Not run — correctly withheld per the "no real customer email" rule** |
| Two-connection Postgres concurrency (payment/refund/announcement lease) | — | Not run, no disposable staging DB provided | **Untested — recommended before demo** |
| Customer/admin login, session refresh, role routing | — | Not run, no browser tool / test accounts | **Untested** |
| Booking form validation, pickup weight/discount, partial/full payment | — | Not run | **Untested** |
| Push notification settings, inquiry form, email preference toggle | — | Not run | **Untested** |
| Customer feedback / featured shipment display | — | Not run | **Untested** |

---

## F. External integrations actually verified vs. not

**Actually verified (live, read-only):**
- Supabase Postgres: real schema, real RLS/grants, real function bodies, real execution of the fixed report query against real rows.
- Supabase Edge Functions: real deployed bundle inventory and exact source-drift check for the 4 functions most relevant to the prior findings.
- Vercel-hosted frontend: real served HTML/CSS/JS/CSP/security headers, real service worker precache manifest.

**Not verified (would require credentials/tools this session doesn't have):**
- Resend email delivery (no real or test send attempted).
- PayMongo payment/refund/webhook flow (no real or sandbox transaction attempted; webhook not replayed, per instructions).
- Firebase/FCM/Web Push delivery to an actual device.
- Any authenticated browser session (customer or admin) — no browser automation tool was available in this environment and no test login credentials were supplied.

**What's needed to close these:** a staging Supabase project (or explicit permission to use isolated fixtures against the linked production project), one designated test customer account, one designated admin account, one designated test mailbox, and — if push/PDF/print are to be verified — a browser session (Playwright via `npx playwright test`, which this repo already has configured, or manual browser use).

---

## G. New/remaining findings summary (severity order)

1. **NEW-01 — Trip-reschedule email still doesn't reach all enabled subscribers** (Medium, confirmed live, see §D). This is the most defense-relevant open item because it's the exact requirement the task asked to verify.
2. **F-06 — PayMongo webhook timestamp hardening** (Low, confirmed still open live, unchanged from original assessment — optional).
3. **F-05 — schema.sql still stale** (Low/Medium, confirmed still incomplete, labeled historical as claimed — not a live-security issue since migrations, not the snapshot, are what's deployed).
4. **Build reproducibility gap** (new observation, Low): two consecutive local builds from the identical commit produced different chunk-hash filenames for some routes. Not a security issue and not evidence of a bad deploy (the deployed build's timestamps and vendor-chunk hashes line up correctly), but it does mean asset-hash diffing can't be used as a deployment-freshness proof for this repo without pinning the bundler more tightly. Worth a follow-up if reproducible builds ever matter (e.g., supply-chain attestation).
5. **`npm ci` clean-room gap** (Low): `npm run check` passed in the existing checkout, but a fully clean `npm ci` from a bare clone was not exercised this session; the fix report itself flagged a local dependency install issue during its own work. Recommend running it once before the defense and keeping the output.

No new customer-to-customer IDOR, privilege escalation, SQL injection, secret exposure, or payment-integrity issue was found in this session's checks. This is **not** a claim that none exist — large parts of the system (every authenticated browser workflow) were not exercised this session for lack of tooling/credentials, as itemized in §E.

---

## H. Concise defense rehearsal script

1. **Before anything else:** `rm -rf node_modules && npm ci && npm run check` from this exact commit; keep the passing output as your validation-gate proof.
2. **Open the deployed site** (`https://www.cargoexpress-ph.online`), not `localhost` — confirm the URL bar and that it's the same commit (check `git log -1` matches what you intend to demo).
3. **Admin: Reports & Analytics.** Pick a date range you know has at least one payment and, ideally, one refund. Generate → confirm no error → note the totals → open print preview → export PDF → confirm the "Current Financial Snapshot" labeling on the delivered-orders section, no blank pages, filename looks right.
4. **Customer: booking draft privacy.** In one tab, start a booking, fill in sender/receiver details, log out mid-draft. Log in as a second test customer in the same tab. Confirm the form is empty. Log back in as the first customer and confirm their draft resumes.
5. **Admin: announcement send.** Send one announcement with "Send email" checked to **only your own controlled test address(es)**. Watch the admin UI's accepted/retryable/review counts. If you want to show resilience, temporarily break connectivity to force a retryable state, then use "Retry unfinished emails" and show it doesn't double-send the already-accepted recipient.
6. **If asked about trip-reschedule emails specifically:** be upfront that it currently only reaches customers who are (a) registered and (b) booked on that exact trip and (c) opted in — inquiry-only subscribers and opted-in customers without a booking on that trip do not yet receive it. This is a known, documented gap (see NEW-01), not something to claim as working.
7. **Payment flow:** as admin, weigh a test booking, show the server-derived charge/discount, collect a partial payment, click the pay button twice and show no duplicate ledger row (existing regression suite already covers this — cite `payment-return-state-contract-test.mjs` / `payment-refund-pgtest`).
8. **Keep a fallback:** screenshots of the report screen, the print preview, and one successful test announcement send, clearly labeled as pre-captured, in case of live network/provider issues during the actual defense.

---

## Final answers to the audit questions

**1. What could currently interrupt the defense?**
Nothing found this session is a live-breaking bug in the core booking/payment/reporting path — F-01 through F-07 (except the openly-optional F-06) are genuinely deployed and, where testable read-only, function correctly against real data. The most likely interruption is a panelist directly testing the trip-reschedule-to-all-subscribers requirement (NEW-01) and getting a "no" — because that requirement is not implemented, only the narrower "booked customers only" version is live. The second most likely interruption is anything in the **untested** browser-workflow list in §E simply not having been exercised since the fixes landed — those are unverified, not confirmed-broken, but "unverified" is not the same as "safe" this close to a demo.

**2. Which fixes are necessary before the demo?**
- Decide and align messaging on NEW-01 (either implement the broader reschedule-email recipient set, or be ready to accurately describe the current, narrower behavior — do not claim the broader behavior works).
- Run the clean-room `npm ci && npm run check` once and keep the output.
- Nothing else found this session requires a code fix before the demo; F-01/F-02/F-03/F-04/F-07 are confirmed deployed and functioning.

**3. Which workflows were verified on the deployed system?**
Live, direct-to-production verification (not local inference) was completed for: migration/Edge-Function/RLS/grant deployment state; the financial report RPC's execution correctness and both its authorization layers; the announcement-broadcast schema, RPCs, and grants; source-identity of 4 key Edge Functions; frontend build/deploy timestamp consistency; and a full `npm run check` pass at the deployed commit. See §B–D for exact evidence per item.

**4. Which still need testing?**
Every authenticated browser workflow (login, booking, admin order detail, payments, shipment progression, feedback, sales overview, print/PDF rendering, push settings, inquiry form) — no browser tool or test credentials were available this session. Real email/push delivery to a designated test mailbox/device. Real two-connection Postgres concurrency on a disposable database. A live fire of the trip-reschedule trigger against a real opted-in test booking (intentionally not done here to avoid emailing anyone outside a controlled test). See §E's matrix for the complete list.

This is an evidence-based assessment, not a guarantee: the system was not fuzzed, load-tested, or subjected to adversarial input this session, and the absence of a finding in an unexercised workflow is not proof that workflow is correct.
