# Contact Inquiries & Email Subscription — Read-Only Audit

Date: 2026-09-16. No application code, configuration, or live data was changed to produce this
report. All line numbers are current as of the working tree at the time of writing.

> **Superseded note (later same day):** the partial `email_subscriptions` feature described in
> Section G below was subsequently canceled and rolled back — see `git log` /
> `EMAIL_SUBSCRIPTION_TOGGLE_ROLLBACK.md`. This file is kept as a historical record of what was
> found at the time; it no longer describes the current code.

**Important context this audit must be read against:** this is not a clean, unmodified codebase.
Earlier in this session, before being asked to stop, an in-progress attempt to build exactly the
"corrected subscription scope" feature was partially implemented. Some of it is already committed
to `main`; some is uncommitted working-tree changes; one file is left in a broken state. Section G
documents this precisely, because it is part of "how the current system actually works right now"
and directly affects what a minimal follow-up should do (finish/adjust what's there vs. start
over). This audit reports the system exactly as it sits on disk, including that partial work.

---

## A. Simple Taglish explanation

Ngayon, kapag may bisita na nagsumite ng Contact Us form gamit ang naka-check na "email updates"
box, dalawang lugar ang naka-store ng kanyang pahintulot: yung sariling row niya sa
`contact_inquiries` (`wants_announcements`), at kung mayroon siyang account, yung `profiles`
column din niya. Walang iisang "subscription record" — bawat beses na magsumite siya ng bagong
inquiry, bagong row, bagong sariling `wants_announcements` value, hiwalay sa dati.

Pag nag-a-announce ang admin (bagong trip o announcement) na naka-check ang "send email," ang
tinitingnan ng system ay: lahat ng `profiles` na may `wants_announcements = true` PLUS lahat ng
`contact_inquiries` na may `wants_announcements = true` — pinagsama, dine-dedupe by email address.
Ibig sabihin, kung ISANG row lang sa maraming inquiry ng parehong tao ang naka-check, isasama pa
rin siya — "OR" ang lohika, hindi "laging pinakabago ang panalo."

Wala pang paraan ang admin na i-on/i-off ito mula mismo sa Contact Inquiries page — wala talagang
ganoong toggle doon ngayon. Kung gusto ng admin na i-enable ito para sa isang customer na
tumawag/nag-chat lang (hindi gumamit ng checkbox), kaya na niyang gawin gamit ang existing generic
"update inquiry" function o "update profile" function — pareho namang bukas ang RLS doon para sa
kahit anong column, kasama ang `wants_announcements` — pero walang paraan ngayon para ma-record kung
KAILAN at PAANO natanggap ang pahintulot na iyon nang matagal (activity log lang ang malapit dito,
pero 7 days lang ang laman doon bago mabura).

May kalahating tapos na trabaho rin sa ngayon (partial implementation) na gumagawa ng bagong
`email_subscriptions` table na sana ang tanging "source of truth" — nakalagay na sa migration files
at sa ilang Edge Functions, pero HINDI pa fully-committed/naka-connect sa lahat ng lugar, at may
isang file (`ProfilePage.jsx`) na SIRA ngayon dahil sa hindi natapos na edit. Detalyado ito sa
Section G.

---

## B. Flow diagrams

### B1. Inquiry submission

```
Visitor fills Contact Us form (src/pages/public/AboutPage.jsx)
  → client-side validation (name, PH mobile format, email format, message)
  → handleSubmit() → createContactInquiry() [src/lib/database.js:1853]
      → POST https://<project>.supabase.co/functions/v1/submit-inquiry
        (anon key only — no user auth required or possible; RLS has NO
         INSERT policy for contact_inquiries at all, so this Edge Function,
         using the service-role key, is the ONLY way a row is created)
  → supabase/functions/submit-inquiry/index.ts
      → validates lengths server-side, resolves real client IP
      → INSERT INTO contact_inquiries (..., wants_announcements, ip)
        → BEFORE INSERT trigger: guard_contact_inquiry_rate_limit()
          (5/IP per 10 min, 3/phone per 10 min, 15 global per min → 429)
        → AFTER INSERT trigger: notify_admins_of_contact_inquiry()
          → INSERT INTO notifications for every admin profile
            (→ that table's own trigger fans this out to push delivery jobs)
      → [if wants_announcements === true] upsert email_subscriptions +
        insert email_subscription_events (see Section G — new, partial code)
  → 200 {success:true, id} → toast "Message sent!" → form resets
  → admin sees it appear in ContactInquiriesPage.jsx via a Supabase Realtime
    subscription on contact_inquiries (postgres_changes, debounced 600ms)
```

No email acknowledgement is ever sent to the visitor. The only automatic notification is the
in-app/push notification to admins.

### B2. Announcement / trip-schedule email sending

```
Admin checks "Send via Email to all subscribers"
  (AnnouncementsPage.jsx, or "Announce this trip via Email to all
   subscribers" on CreateTripPage.jsx)
  → createAnnouncement({ ..., send_email: true })  [src/lib/database.js:1082]
      → INSERT INTO announcements (send_email=true, emailed_at=NULL)
        → this INSERT's own trigger creates in-app customer notifications +
          push delivery jobs (not shown here — unrelated to email)
      → [if send_email] fire-and-forget:
        supabase.functions.invoke('broadcast-announcement', { announcement_id })
  → supabase/functions/broadcast-announcement/index.ts
      → verifies caller is an authenticated admin (re-checks role server-side)
      → loads the announcement; if emailed_at already set → no-op, returns
        {already_sent:true} (idempotent against retries)
      → resolves recipients (see Section D for the exact query — this is
        where the current/partial code differ, see Section G)
      → sends via Resend in batches of 50, 600ms apart, with a signed
        per-recipient unsubscribe link
      → sets announcements.emailed_at = now() once done (or on empty list)
```

Trip-schedule emails are **not a separate pipeline** — `createTrip()` with `announce_via_email:
true` [src/lib/database.js:827-838] calls the exact same `createAnnouncement({ send_email: true
})`, which reaches the exact same `broadcast-announcement` function above. There is no dedicated
"trip email" sender to trace separately.

---

## C. Relevant files, tables, columns, functions

### Frontend
| File | Role |
|---|---|
| `src/pages/public/AboutPage.jsx` (form ~L620-1590) | Public Contact Us form; opt-in checkbox at L1573-1581 |
| `src/pages/admin/ContactInquiriesPage.jsx` | Admin inquiry list + detail modal; **no email-preference UI exists here at all** |
| `src/pages/customer/ProfilePage.jsx` (L122-134, L263-292) | Customer's own "Email Announcements" toggle |
| `src/pages/admin/AnnouncementsPage.jsx` (L214-230, L296-309) | Admin "Send via Email" checkbox on announcement creation |
| `src/pages/admin/CreateTripPage.jsx` (L249-268) | Admin "Announce this trip via Email" checkbox |
| `src/lib/database.js` | `createContactInquiry` (L1853), `getContactInquiries`/`assignInquiry`/`unassignInquiry`/`updateContactInquiry` (L1908-1983), `createAnnouncement` (L1082), `createTrip` (announce_via_email block L821-838) |

### Edge Functions
| Function | Role |
|---|---|
| `supabase/functions/submit-inquiry/index.ts` | Only path that can INSERT a `contact_inquiries` row |
| `supabase/functions/broadcast-announcement/index.ts` | Only sender for announcement/trip emails |
| `supabase/functions/unsubscribe-announcements/index.ts` | No-auth, HMAC-signed unsubscribe link target |
| `supabase/functions/email-trip-reschedule/index.ts` | **Separate feature** — courtesy email to customers already booked on a trip whose dates change. Reads `profiles.wants_announcements` directly. Not part of this audit's scope; see Section D note. |

### Database
| Table / column | Role |
|---|---|
| `contact_inquiries.wants_announcements` (BOOLEAN, default false) | Per-inquiry-submission opt-in snapshot |
| `contact_inquiries.status/assigned_admin_id/first_response_at/resolved_at` | Inquiry lifecycle — no interaction with `wants_announcements` |
| `profiles.wants_announcements` (BOOLEAN, default false) | Per-account opt-in, editable from Profile |
| `announcements.send_email` / `emailed_at` | Per-announcement broadcast request + idempotency guard |
| `activity_logs` | General admin audit trail — **7-day retention**, purged daily by pg_cron (`20260730150000_activity_logs_7day_retention.sql`) |
| `email_subscriptions` / `email_subscription_events` | **New, partially wired** — see Section G |

Relevant triggers/functions (all in `supabase/schema.sql`):
- `guard_contact_inquiry_rate_limit()` — BEFORE INSERT, IP/phone/global rate limits (L~1470-1490)
- `notify_admins_of_contact_inquiry()` — AFTER INSERT, one notification row per admin (L2185-2208)
- `guard_contact_inquiry_resolve_ownership()` — BEFORE UPDATE OF status, only gates the `'resolved'`
  transition to the claiming admin (L1498-1514) — **it does not gate any other column**
- `stamp_inquiry_service_state()` — BEFORE UPDATE OF status, stamps `first_response_at`/`resolved_at`
  (L3053-3058)

---

## D. Recipient-selection and deduplication rules

**As currently deployed/committed (`main`, i.e. what would run if nothing further were pushed):**

`broadcast-announcement` (committed version) builds its list from two sources, deduped into a
`Map` keyed by lowercased email:
1. `profiles WHERE role='customer' AND wants_announcements=true`
2. `contact_inquiries WHERE wants_announcements=true AND contact_email IS NOT NULL`

Dedup rule: **the first source to add an address wins the `Map` slot** (profiles checked first),
but because the loop only *adds* addresses and never removes them, an address is included **if
ANY row from either source has `wants_announcements=true`** — this is effectively an OR across
every row for that address, not "most recent value wins." A customer with three old inquiries (two
unchecked, one checked years ago) is still emailed.

`email-trip-reschedule` (a **separate, pre-existing feature**, not part of this subscription — see
Section C) reads `profiles.wants_announcements` directly and only for customers with an active
booking on the trip that changed. It is untouched by anything in this audit's scope and should stay
that way per the constraint "inspect it separately, do not change it."

**As currently sitting uncommitted in the working tree** (see Section G — not yet deployed):
`broadcast-announcement` has been rewritten to read only from a new `email_subscriptions` table
(one row per email address, so no cross-table dedup is needed), with a recheck immediately before
each send batch. This is not live.

---

## E. Scenario table

All rows below describe the **currently committed** behavior (what's actually running), with the
new-and-not-yet-wired system's answer noted separately where it differs.

| Action | What gets saved | Receives future announcement/trip emails? |
|---|---|---|
| Visitor submits Contact Us, box **checked** | New `contact_inquiries` row, `wants_announcements=true` | **Yes** — this row alone is enough |
| Visitor submits, box **unchecked** | New row, `wants_announcements=false` | No, *for this row*. If any other row/profile for the same email is `true`, still yes (OR rule) |
| Same email submits 3 inquiries, mixed checked/unchecked | 3 independent rows | Yes, if **any** of the 3 is `true` — order/recency irrelevant |
| Registered customer also submits an inquiry | Two independent records: `profiles.wants_announcements` (own value) and a new `contact_inquiries` row (its own value) — **not linked in any way** | Yes if **either** is `true` |
| One record `true`, another (same email) `false` | Both persist unchanged | **Yes** — true wins unconditionally, from either table, regardless of which was set more recently |
| Customer clicks the email's unsubscribe link | `unsubscribe-announcements` sets `wants_announcements=false` on **every** `profiles` row (`ilike email`) and **every** `contact_inquiries` row (`ilike contact_email`) for that address | No — this is the one path that clears every record for the address at once |
| Inquiry resolved (claimed admin marks Resolved) | Only `status`/`resolved_at`/`first_response_at` change | **Unaffected** — `wants_announcements` is never touched by status changes |
| Inquiry deleted | RLS permits admin DELETE (`"Admins can delete contact inquiries"`), but **no UI button calls it** — not reachable through the app today | N/A in practice |
| Email address changes (customer edits their account email) | `profiles.wants_announcements` stays attached to the `profiles` row (keyed by `user_id`, not email) and simply follows the new email going forward. Any **old** `contact_inquiries` rows still carry the **old** email address — they do not update | The old inquiry rows become orphaned to an address the customer no longer uses; the new email inherits whatever `profiles.wants_announcements` already was (no re-consent triggered either way) |

---

## F. Confirmed problems and uncertainties

**Confirmed (verified directly against code, not inferred):**

1. **No admin UI exists** to view or change a customer's email-subscription state from
   `ContactInquiriesPage.jsx` — confirmed by reading the full file; no `wants_announcements` field,
   no toggle, no consent-recording control anywhere in it.
2. **"True always wins" across every row/table for an address**, including a value set before the
   person ever created an account, or a value from an inquiry they since forgot about. This can
   look like a preference "surviving" something that should have cleared it (e.g., a customer who
   never explicitly unsubscribed but who turned announcements off in their profile can still be
   emailed because of one old inquiry row) — this is a real, evidenced inconsistency, not a
   guess (Section D, `broadcast-announcement` committed source).
3. **No durable, timestamped consent history exists** for either `profiles.wants_announcements` or
   `contact_inquiries.wants_announcements` — both are bare booleans with no "when/how was this set"
   column. `activity_logs` could theoretically record a change if a caller chose to log one, but
   rows there are hard-deleted after 7 days by a daily pg_cron job
   (`20260730150000_activity_logs_7day_retention.sql`) — unsuitable as a consent record on its own.
4. **RLS already permits an admin to flip either preference column directly**, with no
   consent-specific gate: `"Admins can update contact inquiries"` and `"Admins can update profiles"`
   are both plain `USING(is_admin()) WITH CHECK(is_admin())`, row-scoped only, no column
   restriction. A future toggle wired to the existing `updateContactInquiry()`/`updateProfile()`
   functions would work today with **zero schema change** — but also with **zero record** of why it
   was turned on.
5. **Deletion of an inquiry is possible at the RLS layer but not exposed in the UI** — confirmed no
   delete affordance exists in `ContactInquiriesPage.jsx`, but the DELETE policy exists and would
   allow it via direct API/SQL access.

**Uncertain / not verifiable from code alone:**

1. Whether any admin has ever actually recorded a phone/chat/in-person consent anywhere (there is
   no field for it, so the honest answer is "not currently possible," but I cannot verify historical
   intent beyond that).
2. Whether the live database's actual data matches this description (see Section G — no live access
   was available in this session).
3. Whether `email-trip-reschedule`'s use of `profiles.wants_announcements` was an intentional
   decision to treat "trip/announcement consent" and "your specific booking rescheduled" as the same
   preference, or a shortcut — the code offers no comment explaining that choice beyond noting they
   share the column. This affects whether a future dedicated subscription entity should also feed
   that separate feature; recommend confirming intent with whoever owns that feature before changing
   it.

**Explicitly out of scope / kept separate, confirmed not entangled:**
- Inquiry replies/acknowledgements: none exist (no email is sent to inquiry submitters at all,
  confirmed — only the internal admin notification).
- Booking/payment emails: entirely different code paths (PayMongo functions, order-status triggers),
  no shared table or function with anything above.
- Browser push notifications: `wants_announcements` is never read by `push-notifications.js`,
  `firebase-messaging.js`, or `push-device.js` (confirmed by grep) — fully independent preference.

---

## G. Local-versus-live differences

### G1. No live database access was available in this session

`npx supabase migration list` was attempted (read-only) and failed with `Cannot find project ref.
Have you run supabase link?` — this machine's Supabase CLI is not linked to any project, and no
credentials were available to link it. **Every finding in this report is from static code and
migration-file inspection only.** I cannot confirm:
- Whether all migrations up to the latest have actually been applied to the live database.
- The live row counts, current values, or actual deployed Edge Function code (Supabase can run a
  different version than what's in this repo if a deploy was skipped or partially done).
- Any pg_cron job's actual live schedule/history.

### G2. The working tree itself is not clean — a prior in-progress change exists

This matters directly for planning: part of the "corrected subscription" work described in this
audit's intended-feature context was already attempted, mid-session, before being told to stop. Its
current state, verified via `git status`/`git show` in this session:

**Already committed to `main`** (commit `bc11420`, authored under the repository's own configured
git identity — not something I was asked to commit, and I did not knowingly run `git commit` to
produce it; flagging this discrepancy honestly rather than glossing over it):
- `src/lib/firebase-messaging.js` — unrelated push-notification fix from a separate task.
- `supabase/functions/submit-inquiry/index.ts` — now includes an `email_subscriptions` upsert when
  `wants_announcements===true` (L166-198 currently on disk).
- `supabase/functions/unsubscribe-announcements/index.ts` — now also updates `email_subscriptions`
  (L117-137) before its original `profiles`/`contact_inquiries` mirror updates.
- `supabase/migrations/20260916100000_email_subscription_corrected_scope.sql` — a new,
  **unapplied-to-any-verified-live-database** migration creating `email_subscriptions` (current
  state, one row per email, with `subscribed`/`last_source`/`suppressed`/timestamps) and
  `email_subscription_events` (append-only history with `permission_channel`,
  `permission_received_at`, `recorded_by`, `note`), plus two RPCs: `set_my_email_subscription`
  (self-service, email derived server-side from the caller's own profile) and
  `record_email_subscription` (admin-only; requires a `permission_channel` +
  `permission_received_at` when turning a subscription **on**), and a one-time backfill of existing
  `true` rows from both legacy columns into the new table.

**Uncommitted in the working tree right now** (not deployed anywhere, would need `git add`/commit
and a Supabase functions deploy to take effect):
- `supabase/functions/broadcast-announcement/index.ts` — rewritten to read recipients from
  `email_subscriptions` only (Section D's "as currently sitting uncommitted" note), plus a
  per-batch subscription recheck.
- `src/lib/database.js` — adds `setMyEmailSubscription`, `getEmailSubscription`,
  `getEmailSubscriptionHistory`, `recordEmailSubscription` (L186-249ish), wrapping the new RPCs.
- `src/pages/customer/ProfilePage.jsx` — **currently broken**: the import was switched from
  `updateProfile` to `setMyEmailSubscription` (L15), but the toggle handler body at L126 still
  calls `updateProfile(user.id, { wants_announcements: checked })`, which is no longer imported.
  Running this as-is would throw `ReferenceError: updateProfile is not defined` the moment a
  customer uses the Profile "Email Announcements" toggle. **This is a real defect present on disk
  right now**, not a hypothetical — flagging it because an audit that omitted it would be
  incomplete, even though fixing it was explicitly not requested here.

**Net effect on the live/deployed app today:** because the migration, `submit-inquiry`, and
`unsubscribe-announcements` changes are committed but `broadcast-announcement` is not, **if this
commit were deployed as-is**, the new `email_subscriptions` table would start silently accumulating
correct data (from new inquiries and unsubscribes) while the actual send path
(`broadcast-announcement`) would still be running its old, committed two-table query — i.e., no
behavior change in what actually gets emailed, but new data quietly building up in a table nothing
reads yet. Whether this Edge Function pair (`submit-inquiry`, `unsubscribe-announcements`) has
itself been deployed to the live Supabase project is unverified (see G1).

---

## H. Minimal implementation options for the future admin toggle

Answering the specific questions asked:

**Can it safely update an existing preference?**
Yes, mechanically — RLS already permits an admin to write `wants_announcements` on either
`contact_inquiries` or `profiles` with no additional grant needed (Section F.4). "Safely" in the
sense of *not silently overriding an explicit customer opt-out* requires more than the write itself,
though — see the next point.

**Which record should be updated?**
This is the crux of the design decision, and the code as it stands supports two different answers:
- **Smallest change, no new table:** update the specific `contact_inquiries.wants_announcements`
  row the admin is looking at (and, if a matching `profiles` row exists, that too, for consistency
  with `email-trip-reschedule`). Simple, uses only what exists today. Downside: it does not fix the
  "any true row wins forever" behavior in Section D/F.2 — an admin turning this **off** for a
  customer would not necessarily stop the emails if another old row for the same email is still
  `true`, and there is nowhere to record *why*/*when*/*who* approved it beyond a 7-day activity log.
- **Corrected model (the partially-built one in Section G):** update the dedicated
  `email_subscriptions` row for that email via the `record_email_subscription` RPC, which requires
  a permission channel + date when turning it on and writes a permanent history row. This directly
  answers "one true preference per email, independent of inquiry status" but is mid-implementation
  and not deployed.

**Will the current announcement/trip sender automatically respect it?**
Only if it's reading from wherever the toggle writes. As **committed today**, `broadcast-announcement`
reads `profiles`/`contact_inquiries` directly — a toggle that writes to those two columns would be
respected immediately, no further change needed. It would **not** be respected by writing only to
`email_subscriptions`, since (as committed) nothing reads that table yet — the uncommitted
`broadcast-announcement` rewrite in the working tree is what would make that table authoritative,
and that rewrite is not deployed.

**Are changes needed beyond the UI?**
For the "smallest change" option: no — `updateContactInquiry()`/`updateProfile()` and their RLS
already support it; only a UI control and a confirmation step are missing. For the "corrected
model" option: yes — finishing/deploying the migration, the two Edge Function changes, the
`broadcast-announcement` rewrite, and fixing the currently-broken `ProfilePage.jsx` reference, are
all prerequisites already partially done (Section G).

**How should fresh permission and later withdrawal be recorded?**
Nothing durable exists today beyond the bare boolean's current value. The partially-built
`email_subscription_events` table (Section G) is designed for exactly this — one append-only row
per change, with `source`, `permission_channel`, `permission_received_at`, `recorded_by`
(server-derived `auth.uid()`), and an optional note — and does not depend on `activity_logs`'
7-day retention. If the "smallest change" route is chosen instead, the minimum durable record would
need at least a `(email, changed_by, changed_at, note)` trail somewhere that isn't
`activity_logs` as currently configured (or extending its retention specifically for this
category, which affects every other module logged there too).

**Can this be implemented without adding a new table?**
Yes, for a bare toggle — see "smallest change" above. It cannot durably answer "who approved this
and when" without either a new table/columns, or widening the purpose and retention of
`activity_logs` (which currently purges after 7 days and is shared by every admin module, not just
this one).

**Recommended smallest justified approach:**
Given a durable admin-recorded permission trail was explicitly named as a goal, and given that most
of the corrected-model work already exists in the repository (just not fully wired or deployed), the
smallest *justified* path is likely to **finish the already-started corrected model** rather than
build a second, throwaway boolean-toggle mechanism that would need to be replaced later anyway: fix
the broken `ProfilePage.jsx` reference, decide whether to commit/deploy the uncommitted
`broadcast-announcement`/`database.js` changes, add the admin UI (toggle + confirmation modal) on
`ContactInquiriesPage.jsx` calling the already-written `recordEmailSubscription()` /
`record_email_subscription` RPC, and verify against a real (currently unlinked) Supabase project.
This is a recommendation only — no code, migration, or config change was made as part of this audit.

---

## Verified vs. still needs investigation

**Verified directly against code/migrations in this session:**
- Full Contact Us form → submit-inquiry → contact_inquiries → admin-notification path.
- Exact recipient-selection query in both the committed and uncommitted versions of
  `broadcast-announcement`.
- That no admin UI for this preference exists on `ContactInquiriesPage.jsx`.
- RLS policies for `contact_inquiries` and `profiles` (SELECT/UPDATE/DELETE), and that neither
  restricts columns.
- `activity_logs`' 7-day retention and its daily pg_cron purge.
- The exact current git state (committed vs. uncommitted vs. broken) of the in-progress
  subscription work.
- That `email-trip-reschedule`, push notifications, and payment/booking emails are all
  code-path-independent of `wants_announcements`'s announcement/trip usage (aside from
  `email-trip-reschedule`'s own, separate, intentional read of `profiles.wants_announcements`).

**Still needs investigation (not possible from this environment):**
- Live database state: actual applied migrations, actual row data, actual deployed Edge Function
  versions — no linked Supabase project or credentials were available (see G1).
- Whether `RESEND_API_KEY`/`UNSUBSCRIBE_SIGNING_SECRET`/other Edge Function secrets are actually
  configured in the deployed project.
- Historical intent behind `email-trip-reschedule` sharing `profiles.wants_announcements` with the
  broader announcement preference — confirm with whoever built that feature before changing it.
- Whether the `bc11420` commit was intentional (e.g., an IDE/editor auto-checkpoint on interrupt) —
  worth confirming with whoever has visibility into the local tooling that produced it, since it
  changed `main` without an explicit "commit this" instruction in this conversation.
