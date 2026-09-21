# "Email Updates" Toggle for Contact Inquiries — Implementation

Date: 2026-09-16. Implements the admin-side "Email Updates" toggle described in this task, on top
of the previously-canceled/rolled-back subscription attempt (see
`CONTACT_INQUIRIES_EMAIL_FLOW_AUDIT.md` and `EMAIL_SUBSCRIPTION_TOGGLE_ROLLBACK.md`).

## 1. Current state, re-verified (not assumed from the old audit)

- `git status` was clean before starting — the earlier rollback was intact, no leftover
  `email_subscriptions` references anywhere in `src/` or `supabase/` (confirmed by grep).
- **Live database, checked read-only** via the anon key against the actual Supabase project:
  - `GET /rest/v1/email_subscriptions` → `404 PGRST205` — confirms no such table exists live (this
    task's new migration is genuinely new, not a duplicate of anything already deployed).
  - `GET /rest/v1/contact_inquiries?select=wants_announcements` → `200 []` and
    `GET /rest/v1/profiles?select=wants_announcements` → `200 []` — both legacy columns exist live
    and are queryable (empty array is RLS filtering the anon caller, not a missing column).
- Re-read the actual current contents of `AboutPage.jsx`'s contact form, `ContactInquiriesPage.jsx`,
  `ProfilePage.jsx`, `submit-inquiry`/`unsubscribe-announcements`/`broadcast-announcement`, and
  `src/lib/database.js` before writing anything, rather than trusting the older audit's line numbers.

## 2. Data model — why one new table, and why it's small

**The requirement that forces a new table**: the same email can exist as a `contact_inquiries` row
(possibly several), a `profiles` account, or both, and each of those already has its *own*
`wants_announcements` boolean. There is no existing place to put "the one current answer for this
address" without one of them arbitrarily winning — which is exactly the bug this feature must
avoid ("Do not simply add independent toggles to individual inquiry rows if that leaves conflicting
preferences"). A dedicated table keyed by email is the smallest structure that can express that.

**What's deliberately *not* in it, versus the earlier canceled attempt**: no permission-channel
field, no manual date field, no required-note field, and no separate append-only history table —
this task's spec only asks for a single current-state record (state, timestamp, source, actor), not
a full audit trail, so one table with those four columns is sufficient.

`supabase/migrations/20260916150000_email_updates_subscription.sql` adds:

```sql
CREATE TABLE public.email_subscriptions (
  email TEXT PRIMARY KEY,       -- normalized lowercase, one row per address
  subscribed BOOLEAN,
  source TEXT,                  -- 'contact_form' | 'admin' | 'profile' | 'unsubscribe_link'
  updated_by UUID,               -- admin who made the change; NULL for self-service sources
  updated_at TIMESTAMPTZ,        -- server clock — label as "Last updated"/"Enabled on", not the
                                  -- exact moment of verbal agreement
  created_at TIMESTAMPTZ
);
```

RLS: admins can `SELECT`; there is no direct `INSERT`/`UPDATE`/`DELETE` grant for anyone —
every write goes through a trigger or a `SECURITY DEFINER` RPC (below), so authorization lives in
one place per write path, not scattered across RLS policies.

`profiles.wants_announcements` and `contact_inquiries.wants_announcements` are **untouched** —
neither their columns nor their existing write paths changed. The former keeps gating the separate,
pre-existing trip-reschedule courtesy email (`email-trip-reschedule`, which reads it directly and
was explicitly out of scope); the latter remains each inquiry's own historical record of what was
checked on that particular submission, never rewritten after the fact.

## 3. How each source reaches the authoritative table

| Source | Mechanism | File |
|---|---|---|
| Public contact form, box checked | New `AFTER INSERT` trigger on `contact_inquiries`, fires only when `wants_announcements = true` | migration only — **`AboutPage.jsx` and `submit-inquiry` are unchanged** |
| Public contact form, box unchecked | Trigger writes nothing | — |
| Customer's own Profile toggle | New `AFTER UPDATE OF wants_announcements` trigger on `profiles` | migration only — **`ProfilePage.jsx` is unchanged** |
| Admin, from the inquiry detail modal | New RPC `admin_set_email_subscription(email, subscribed)` — requires `is_admin()`, actor from `auth.uid()`, timestamp from `now()` | `ContactInquiriesPage.jsx` (new UI) |
| Unsubscribe link in an email | New RPC `unsubscribe_email_updates(email)`, replacing two direct table updates with one atomic call | `unsubscribe-announcements/index.ts` |

Two of the five paths needed **zero application-code changes** — the public form and the Profile
toggle already write to columns a trigger now listens on, so their existing, already-working
behavior was reused exactly as asked ("reuse suitable existing code and structures").

**A same-transaction cycle had to be broken deliberately**: the admin RPC and the unsubscribe RPC
both need to mirror a *disable* into `profiles.wants_announcements` (see §5), which would otherwise
re-fire the profile→subscription sync trigger and overwrite the correct `source`/`updated_by` back
to `'profile'`/`NULL`. Both RPCs set a transaction-local `cargoexpress.suppress_subscription_sync`
flag immediately before that mirror write, and the profile trigger checks it first. This is
verified directly by the pgTest suite (§7), not just reasoned about.

## 4. Admin UI (`src/pages/admin/ContactInquiriesPage.jsx`)

- **List**: a compact `Email: On` / `Email: Off` badge next to the contact email, only when a
  preference has ever been recorded for that address (no badge at all for "never set" — a distinct
  state from an explicit "Off").
- **Detail modal**: an "Email Updates" panel showing Enabled/Disabled/"Not set", a
  "Last updated"/"Enabled on" date when a record exists, and a toggle switch (reusing the same
  `.toggle-switch` styling already used on the customer Profile page).
- **Enabling** opens the existing shared `ConfirmModal` component with exactly the specified copy
  ("Enable email updates? … Confirm & Enable" / Cancel) — no channel dropdown, no date picker, no
  note field. Cancel closes it with no RPC call at all, so state is provably unchanged.
- **Disabling** calls the RPC directly, no confirmation (per spec — only enabling needs one).
- The toggle is disabled while a save is in flight, and the checked state is always derived from
  the last *confirmed* server state — it never flips before the RPC resolves, and a failure shows
  `toast.error(...)` with the confirmation dialog left open for retry (enable) or the toggle simply
  unchanged (disable). Both admin actions also write a normal `activity_logs` entry via the existing
  `logActivity()` helper, for visibility in the existing Activity Log page (no new logging
  infrastructure).

## 5. Connecting to the existing send flow

`supabase/functions/broadcast-announcement/index.ts` — the **only** sender for both announcements
and newly published trips (`createTrip(..., announce_via_email: true)` already calls
`createAnnouncement({ send_email: true })`, which already calls this same function; neither of
those two call sites changed) — now resolves recipients from `email_subscriptions WHERE
subscribed = true` alone, instead of the old two-table OR-query. Because the table is keyed by
email, there is no cross-table dedup left to do: one row per address, one email per send. A
per-batch recheck immediately before each Resend call was added so a mid-broadcast unsubscribe
is honored (was previously only checked once at the very start).

**Identified shared dependency, and the decision made about it** (per instruction to flag rather
than silently change): `email-trip-reschedule` reads `profiles.wants_announcements` directly for
its own, narrower purpose (customers with an active booking on a trip that gets rescheduled). To
avoid silently breaking it:
- Any **disable** (admin, or the unsubscribe link) mirrors into `profiles.wants_announcements` for
  a matching account, so a person who opts out is not left still receiving that separate email.
- An admin **enable** deliberately does *not* mirror into `profiles` — agreeing to hear about trip
  schedules through a phone/chat conversation on one inquiry is not treated as blanket consent for
  every future account-level email a different feature might send.

Enabling never sends anything by itself — it only changes future eligibility. Sending only ever
happens from the existing "Send email" checkbox on a new announcement/trip, unchanged.

## 6. Historical data — handled conservatively, not backfilled

Per instruction 7, **no backfill was performed**. Existing `wants_announcements = true` values on
old `contact_inquiries`/`profiles` rows are **not** copied into the new table automatically — doing
so could resubscribe someone who separately opted out through a channel the old boolean never
recorded (exactly the ambiguity this table exists to resolve). The new table only starts
accumulating rows from the moment this migration is applied, driven by real, current
events (a new inquiry, a real toggle, a real admin confirmation, a real unsubscribe click).
**Consequence to flag explicitly**: this means broadcast-announcement will not treat any
pre-existing consent as valid until that person interacts with one of the five paths in §3 again —
existing subscribers effectively start at "no preference recorded" rather than being silently
carried over. This is deliberate, per "Do not automatically subscribe all inquiry emails" and "Flag
ambiguous historical preferences instead of guessing consent," but it is worth a conscious decision
before deploying: if preserving currently-subscribed people matters more than avoiding any risk of
wrongly carrying over a since-revoked consent, a separate, explicit backfill migration would need to
be proposed and approved on its own — deliberately not done here.

## 7. Tests performed

A new pgTest suite, `scripts/email-updates-subscription-pgtest/`, follows this repo's existing
pattern (`@electric-sql/pglite`, a hand-built minimal schema, the **real** migration file applied
verbatim on top — same approach as `contact-details-lock-pgtest` etc.). **38 assertions, all
passing**, covering every scenario from this task's §8 that is testable at the database layer:

- New inquiry, checkbox checked → creates a `subscribed=true` row; unchecked → creates nothing.
- A later unchecked inquiry from the same email leaves an existing subscription unchanged.
- Three duplicate inquiries from the same email collapse to exactly one row.
- Admin enable: rejected for a non-admin (`Admin privileges required`), succeeds for an admin,
  records `source='admin'` and the real acting admin's id.
- "Cancel" (i.e., no RPC call) leaves state byte-for-byte identical.
- Admin disable mirrors into a matching `profiles.wants_announcements`, without the mirror
  overwriting `source` back to `'profile'` (the suppress-flag cycle-break, verified directly).
- A registered customer's own Profile toggle syncs both directions (on and off).
- A later profile disable overrides an older enabled inquiry-sourced record.
- `unsubscribe_email_updates`: sets `subscribed=false`, `source='unsubscribe_link'`, and mirrors
  into both `profiles` and `contact_inquiries` atomically.
- A fresh checked inquiry after an unsubscribe legitimately re-enables.
- The actual recipient-selection query (`subscribed = true`) returns exactly the right set.
- Malformed emails are rejected by both RPCs.
- Case/whitespace normalization (`MixedCase@Example.Test` is found as `mixedcase@example.test`).

Also ran, all passing:
- `npm run test:edge-functions` — all 18 Edge Functions (including the two modified ones) build
  and typecheck.
- `node scripts/smoke-check.mjs`, `axe-lint.mjs`, `token-lint.mjs`, `activity-log-contract-test.mjs`.
- `npx vite build` — production build succeeds, including the modified `ContactInquiriesPage.jsx`.

**A real bug was caught by actually running the tests, not by inspection**: the first draft of
`admin_set_email_subscription` used `RETURNS TABLE (email TEXT, ...)`. In PL/pgSQL, naming an OUT
column `email` declares a same-named variable that shadows every bare `email` column reference in
the function body, causing `column reference "email" is ambiguous` on every real call. Fixed by
returning `public.email_subscriptions` (the whole row) instead of a hand-picked column list — this
is exactly the kind of bug that only shows up when the SQL actually executes, which is why this
suite runs the real migration file against a real embedded Postgres rather than only reading it.

**Not tested — explicit gaps, not claimed as passing:**
- The admin React UI was not driven in an actual browser (list badge, modal toggle, confirm dialog
  interaction) — verified by code review and a successful production build only.
- The public contact form and the three Edge Functions were not exercised over real HTTP — verified
  by their build/typecheck passing and by direct reading against the pgTest-verified SQL they call.
- No live or staging Supabase project was used — this environment has no linked project or
  deploy credentials (same limitation as prior tasks this session).
- Real email delivery via Resend was not exercised, and no real announcement/trip was published, per
  the explicit instruction not to do so.

## 8. Files changed

| File | Change |
|---|---|
| `supabase/migrations/20260916150000_email_updates_subscription.sql` | New — table, RLS, 2 sync triggers, 2 RPCs |
| `supabase/functions/broadcast-announcement/index.ts` | Recipient query switched to `email_subscriptions`; added per-batch recheck; header comment updated |
| `supabase/functions/unsubscribe-announcements/index.ts` | Two direct table updates replaced with one `unsubscribe_email_updates` RPC call |
| `src/lib/database.js` | `getContactInquiries()` now annotates each row with `email_subscription`; new `adminSetEmailSubscription()` |
| `src/pages/admin/ContactInquiriesPage.jsx` | Compact list badge, "Email Updates" modal section + toggle, enable-confirmation dialog |
| `src/pages/admin/AnnouncementsPage.jsx`, `src/pages/admin/CreateTripPage.jsx` | One line of "Send email" helper text updated to describe the new recipient source accurately |
| `scripts/email-updates-subscription-pgtest/*` | New pgTest suite (38 assertions) |
| `package.json` | Added `test:email-updates-subscription` script |

**Not changed**: `AboutPage.jsx` (public form), `submit-inquiry/index.ts`, `ProfilePage.jsx` — all
three already had the correct write path; the new triggers listen on what they already write.
`src/lib/firebase-messaging.js` and the push-notification fix from an earlier task were verified
untouched.

## 9. Deployment steps (not performed — no live/staging access in this environment)

1. Review `supabase migration list` against the real project before pushing — confirm what's
   already applied (per this session's earlier finding that a batch of unrelated migrations from
   `20260904` onward was not yet deployed; this new migration should be layered on top of whatever
   that resolution looks like, not assumed to be the very next one in sequence).
2. `supabase db push` to apply `20260916150000_email_updates_subscription.sql`.
3. `supabase functions deploy broadcast-announcement` and
   `supabase functions deploy unsubscribe-announcements` — a local code change has no live effect
   until redeployed.
4. Decide on the historical-data question in §6 before or shortly after deploying — currently every
   existing "opted in" record starts as "no preference recorded" in the new table until that person
   interacts with the form/profile/admin/unsubscribe again.

---

## Simple Taglish explanation

**Paano gumagana ngayon ang buong flow:** May isang bagong table, `email_subscriptions`, na
siyang TANGING pinagbabasehan kung sino ang dapat makatanggap ng email pag may bagong trip schedule
o announcement. Isang row lang bawat email address — kahit ilang beses pang mag-submit ng inquiry
ang parehong tao, o mag-gawa pa siya ng account, iisa lang ang "totoong sagot" na tinitingnan.

Kung mag-che-check ang bisita ng checkbox sa Contact Us form, awtomatikong nagre-record ito bilang
"subscribed." Kung hindi naman nila chine-check, walang ginagalaw — hindi ito basta nagpapawalang-bisa
sa dati nang naka-enable na preference. Kapag gusto ng admin na i-enable ito para sa isang customer
na kumausap lang (hindi gumamit ng checkbox), pupunta sila sa Contact Inquiry details, i-toggle ang
"Email Updates," at may lalabas na maikling confirmation — "Enable email updates? The customer
agreed..." — Cancel or Confirm & Enable lang, wala nang date picker o dropdown pa. Pag Disable
naman, direkta na, walang kailangang i-confirm.

Yung Profile toggle ng customer at yung public form — HINDI ko na ginalaw ang code nila, kasi
gumamit ako ng database trigger na basta nakikinig na lang sa kanilang existing na "wants_announcements"
column — kaya automatic na silang naka-connect sa bagong authoritative table nang hindi
na-edit ang kanilang files.

**Ano ang binago at bakit:** Isang bagong migration file lang talaga (isang table, dalawang RPC
para sa admin at unsubscribe, dalawang trigger para sa form at profile). Binago ko rin yung
`broadcast-announcement` (yung tunay na nagpapadala ng email) para doon lang sa bagong table
kumuha ng listahan ng dapat padalhan — hindi na sa dalawang magkaibang column na puwedeng
magkasalungat. Hindi ko binago ang AboutPage.jsx, ProfilePage.jsx, o submit-inquiry — gumagana na
sila, kaya hindi na kailangang hawakan.

**Ano ang na-test:** Gumawa ako ng totoong runnable test (38 checks, gamit ang totoong in-memory
Postgres, hindi lang basta simulate) — checked/unchecked na inquiry, admin enable/cancel/disable,
paulit-ulit na inquiry sa parehong email, profile disable na nag-o-override sa lumang enabled
record, unsubscribe, bagong opt-in pagkatapos mag-unsubscribe, at yung talagang query na ginagamit
para pumili ng padadalhan ng email. May nahuli pa nga akong totoong bug (isang naka-confuse na
column name sa loob ng function) DAHIL mismo pinatakbo ko ang test, hindi lang binasa ang code.

**Ano ang hindi pa na-verify:** Hindi ko pa nasubukan sa totoong browser yung bagong admin UI
(button clicks, modal), at wala akong access sa live/staging Supabase project — kaya hindi ko rin
ma-deploy mismo ang migration o ma-check kung tama ang setup doon. Kailangan pa rin: i-review at
i-apply ang migration (`supabase db push`), i-redeploy ang dalawang binagong Edge Function, at
mag-desisyon kung gusto pa ring i-backfill (o hindi) ang mga LUMANG "opted in" na record — sinadya
kong huwag munang i-backfill para hindi ma-resubscribe nang basta-basta ang sinumang tumigil na
talaga.
