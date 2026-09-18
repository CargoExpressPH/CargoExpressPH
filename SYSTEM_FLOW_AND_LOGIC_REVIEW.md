# CargoExpress PH — System Flow & Logic Review

**Scope:** Read-only audit. No code, config, or data was changed while producing this document.
**Prepared for:** BSIT thesis defense preparation.
**Reviewed as of:** commit `af027f7` on `main`, 2026-09-18 (working tree clean, no uncommitted changes).

> **Taglish note:** *Taglish* dito ay simpleng paghahalo ng Tagalog at English para mas madali maintindihan — hindi porma, kundi para malinaw. Every technical term (RLS, trigger, RPC, webhook, idempotency, etc.) is explained in plain words the first time it's used.

---

## 1. Executive Summary & Highest-Priority Findings

CargoExpress PH follows one governing design rule, stated in its own `CLAUDE.md`: **"the browser is never trusted."** Pricing, payment totals, status transitions, and access control are supposed to be enforced inside PostgreSQL (the database), not in the React code the user's browser runs. After tracing the actual code and migrations (not just documentation), this rule is **mostly followed correctly and consistently** — this is a genuinely above-average student capstone in terms of backend discipline. But the audit found **real, confirmed gaps**, not just theoretical ones.

### Highest-priority findings (fix before defense if time allows)

| # | Finding | Severity | Confirmed or Suspected |
|---|---|---|---|
| 1 | `get_sales_overview_data()` (the "Sales Overview" tab) still buckets refunds by `payment_refunds.updated_at`, which a duplicate/late webhook can bump — the *sibling* RPC `get_financial_report_data()` (the "Reports" tab) already had this exact bug fixed on 2026-09-18, but the fix was never applied to Sales Overview. Two report screens can now disagree on which month/day a refund belongs to. | **Medium-High** | Confirmed (read both function bodies) |
| 2 | Changing the company's price-per-kilo setting can **retroactively re-price an already-weighed shipment** if that shipment hasn't been assigned to a trip yet and a later event (e.g. an additional payment) touches it. The parcel's weight never changed, but its billed amount can. | **Medium-High** | Confirmed (read the trigger) |
| 3 | A customer can, in theory, rewrite the **text of an admin's chat message** while appearing to only "mark it as read," because the database rule (`RLS policy`) that allows a customer to flip a message's read-flag doesn't also lock the message's content column. | **Medium** | Suspected — reasoned from the policy's exact wording; not confirmed with a live browser test |
| 4 | Changing your password or email does **not** log out your other devices. A stolen session on another device/browser keeps working until it naturally expires (usually ~1 hour). | **Medium** | Confirmed (no `signOut({scope:'others'})` call exists anywhere) |
| 5 | An admin's "leftover" audit-log queue (a browser-side retry list for activity logs) is **not cleared on logout**, and it's tagged with the previous user's ID. On a shared computer, the next person to log in could inspect browser storage and see a trace of the prior user's actions for up to 7 days. | **Low-Medium** | Confirmed |
| 6 | The "Record Manual Refund" feature, GCash reference validation, discount editing, and the entire payment ledger were the **most heavily tested and hardened** parts of the system — every automated test (46+21+10+more) passed, and the code shows multiple rounds of self-correction (the team found and fixed its own bugs across several dated migrations). This is good evidence of iterative engineering, worth citing positively in the defense. | — | Confirmed via test run |

**Overall verdict:** No critical, "drop everything" security hole was found (no way for a customer to read another customer's data, no way to self-promote to admin, no way to steal money undetected). The findings above are realistic, fixable gaps — not signs the system is fundamentally broken. Automated tests passing does **not** by itself prove all business logic is correct (see §9); several of the findings above would not be caught by any existing test.

---

## 2. Architecture, in Simple Terms

**Frontend:** React 19, built with Vite, styled as a PWA (Progressive Web App — installable, works offline for cached pages). Runs entirely in the customer's or admin's browser.

**Backend:** Supabase, which is a hosted PostgreSQL database plus:
- **RLS (Row Level Security)** — rules written directly into the database that say "a customer can only see/change rows that belong to them." This runs no matter what the browser sends, so even a technically skilled customer poking at the API directly can't bypass it.
- **Triggers** — small pieces of database code that run automatically before/after a row is written (e.g., "before saving this order, recalculate the shipping cost yourself; don't trust whatever number the browser sent").
- **RPCs (Remote Procedure Calls)** — named database functions the frontend can call, like `record_pickup_payment(...)`, instead of the frontend writing raw INSERT/UPDATE statements. Many of these are `SECURITY DEFINER`, meaning they run with elevated database privileges but are supposed to re-check *who is actually calling* from inside the function itself (this audit verified that almost all of them do this correctly).
- **Edge Functions** — small server programs (written in Deno/TypeScript) that hold secrets the browser must never see (payment provider keys, push-notification keys). They talk to Supabase using a special "service role" key that bypasses RLS, so they must do their own careful checking.

**External services:**
- **PayMongo** — the payment processor for GCash. It sends a "webhook" (a server-to-server callback) when a payment succeeds.
- **Resend** — sends real emails (reminders, announcements, reschedule notices).
- **Firebase Cloud Messaging (FCM) + raw Web Push** — sends push notifications to phones/browsers.

**Golden rule check:** every money-related number the customer or admin sees (`shipping_cost`, `amount_paid`, `remaining_balance`, `payment_status`) is written by a database trigger from a ledger table (`payment_transactions` + `payment_refunds`), never directly by the frontend. This was independently verified across all four financial audit passes.

### Verification legend used throughout this document
- **Verified from code** — read directly in `src/`, `supabase/migrations/`, or `supabase/functions/`.
- **Verified through executable tests** — a script in `scripts/*.mjs` or `npm test` actually ran and passed/failed.
- **Verified live** — actually exercised against a running app/browser. *(None of this audit's findings are in this category — see §9 for why.)*
- **Inferred** — reasoned from code/tests but not run directly.
- **Unverified/blocked** — could not be checked in this pass; explicitly marked, not silently skipped.

---

## 3. Complete Page/Module Inventory by Role

### Guest (no login)
| Route | Page | Purpose |
|---|---|---|
| `/` | Home redirect | Sends logged-in users to their dashboard, guests to public content |
| `/track` | Public Tracking | Look up a shipment by tracking number, no login |
| `/about` | About | Company info, public feedback wall, featured shipments |
| `/schedules` | Trip Schedules (public) | Upcoming Manila↔Bohol trips |
| `/faq` | Help/Guidelines | Static help content |
| `/terms`, `/privacy` | Legal pages | Static |
| `/login`, `/register`, `/forgot-password`, `/reset-password` | Auth pages | Account creation/recovery |
| `/payment/return` | PayMongo return page | Deliberately outside auth guards so a GCash redirect renders instantly |
| Contact form (embedded in `/about`) | Public inquiry | No-auth submission via `submit-inquiry` Edge Function |

### Customer (`role='customer'`)
| Route | Page | Purpose |
|---|---|---|
| `/customer` | Home | Dashboard |
| `/customer/orders`, `/customer/orders/:id` | Order list/detail | Track own shipments |
| `/customer/book` | Book Shipment | New booking wizard |
| `/customer/trips` | Trips | Own bookable trips |
| `/customer/notifications` | Notifications | In-app notification list |
| `/customer/profile`, `/personal-info` | Profile | Own info |
| `/customer/change-password`, `/change-email` | Account security | Shared with admin |
| `/customer/support` | Support Chat | Bot + human escalation |
| `/customer/payments` | Payment History | Own ledger view |
| `/customer/help-guidelines`, `/about-version` | Static/info | — |

### Admin (`role='admin'`)
| Route | Page | Purpose |
|---|---|---|
| `/admin` | Dashboard | Overview |
| `/admin/orders`, `/orders/:id` | Orders | Full order management: pickup, discount, cancellation, refund |
| `/admin/create-booking` | Admin-created booking | Phone-in / walk-in bookings |
| `/admin/trips`, `/trips/create`, `/trips/:id` | Trip management | Assignment, start/complete, reschedule |
| `/admin/customers`, `/customers/:id` | Customer directory | Read-only PII view + order history |
| `/admin/sales`, `/admin/reports` | Sales & Reports | Two tabs of `SalesReportsPage`: Sales Overview, Reports & Analytics, Unpaid Shipments |
| `/admin/announcements` | Announcements | In-app/push/email broadcast |
| `/admin/inbox` | Inbox | Live chat with customers |
| `/admin/contact-inquiries` | Contact Inquiries | Claim/note/resolve public inquiries |
| `/admin/profile`, `/change-email`, `/change-password` | Account | — |
| `/admin/activity-logs` | Activity Logs | 7-day rolling audit trail |
| `/admin/company-info` | Company Information | Price-per-kilo, coverage, contact details |
| `/admin/storage-monitoring` | Storage Monitoring | Photo storage health |
| `/admin/feedback` | Feedback | Customer ratings, "feature on website" control |

### Pages that exist but are not directly routed (not dead code — confirmed used as sub-components)
`ReportsPage.jsx`, `SalesPage.jsx`, `UnpaidShipmentsPage.jsx`, `CompanyInfoCoverageTab.jsx`, `CompanyInfoFeaturesTab.jsx`, `PhotoStorageTab.jsx` are all mounted as tabs/children inside their parent page (`SalesReportsPage.jsx`, `CompanyInformationPage.jsx`, `StorageMonitoringPage.jsx`) rather than having their own route. **Verified from code** — no orphaned/unreachable page was found.

---

## 4. Module-by-Module Flows and Validations

### 4.1 Registration, Login, Password Recovery, Account Switching

**Purpose:** Create and secure customer/admin accounts.
**Who can use it:** Guest (register/login/recovery); any logged-in user (change password/email); admin and customer share the same components.

**Normal flow (registration):** 2-step wizard — (1) name, required Facebook name, email, PH mobile number, password (≥8 chars, upper+lower+digit — no special-character rule, no breach check); (2) full PH address + mandatory Terms/Privacy checkbox + optional marketing opt-in (defaults **unchecked**, no dark pattern). On submit, `supabase.auth.signUp()` creates the login account, then a separate call saves the address/profile row.

**Role assignment — can someone register as admin?** **No.** Even if the browser sends `role: 'admin'` in the signup payload, a database trigger (`handle_new_user`) hardcodes `role='customer'` on the very first insert, and a second trigger (`guard_profile_write`) rewrites the `role` column back to its old value on every future update **unless the person making the change is already an admin**. This was checked both from the code and by reasoning through the exact SQL — confirmed safe.

**Password recovery — a real bug, already fixed:** Two related bugs existed and were fixed in commits `7741755` and `cbe688f`. In simple terms: clicking a "reset your password" email link creates a real, logged-in session (this is normal for Supabase). The bug was that if someone **abandoned** the reset (closed the tab, or even closed the whole app/browser) without finishing it, that half-finished session could resurrect itself as a normal login the next time the app opened — on a shared device, this meant whoever used the recovery link could accidentally leave the account "logged in" for the next person. **Verified from code:** every exit path now force-logs-out that session, and a durable marker survives even a full app restart to guarantee cleanup. The fix is confirmed complete for the failure modes described in the two commits; a hypothetical *third*, not-yet-discovered exit path was not something the audit could rule out with certainty.

**Logout / shared-device safety:**
- Booking-draft data (sender/receiver names, addresses) is deliberately stored keyed to the specific user's ID and is wiped on logout — this was clearly built on purpose to prevent one customer's shared-device draft leaking into the next customer's form. **Confirmed good.**
- **Gap found:** the activity-log retry queue (a small "if this failed to save, try again later" list stored in the browser) is **not** cleared on logout, is tagged with the previous user's ID, and can survive up to 7 days. On a shared computer, someone could open browser dev tools after a different person logs in and see fragments of the previous person's actions. **Severity: Low-Medium.** Not a live data breach (requires devtools access), but a real gap in an otherwise careful pattern.
- "Remember me" only remembers the **email address**, not the password, and does not change how long the session lasts — Supabase always keeps you logged in until you explicitly log out, regardless of that checkbox. This is a UX-clarity mismatch worth mentioning, not a security hole.

**Change password / change email:** Both correctly require re-entering your current password before the change is allowed. **Gap:** neither action logs out your *other* devices. If someone stole a session token on another device, changing your password on this device does not immediately kick them out — they stay logged in until their token naturally expires (roughly an hour, by Supabase's defaults). **Severity: Medium.** Recommended smallest fix: call `supabase.auth.signOut({ scope: 'others' })` right after a successful change.

**Client vs DB enforcement table:**

| Rule | Client check | DB check | Verdict |
|---|---|---|---|
| Can't self-register as admin | sends `role:'customer'` | trigger forces it regardless | Confirmed safe |
| Can't escalate own role later | UI has no such control | trigger overwrites `role` for non-admins | Confirmed safe |
| Can't read another customer's profile | — | RLS: `id = auth.uid()` | Confirmed safe |
| Password re-verification | form requires current password | live `signInWithPassword` re-check | Confirmed safe |
| Session kicked on password change | — | **not implemented** | **Gap — Medium** |

---

### 4.2 Booking & Delivery Lifecycle

**Purpose:** Move a shipment from "just booked" to "delivered," with the database — not the app — deciding what's allowed next.

**Status flow (the only allowed order):**
`Pending Review → Pending → Assigned → Picked Up → In Transit → Arrived at Hub → Out for Delivery → Delivered`

`Pending Cancellation` and `Cancelled` sit outside this line — they can interrupt almost any step (see §4.4).

**Step-by-step, with Trigger / System Action / Resulting State:**

| Step | Trigger (who) | System Action | Resulting State |
|---|---|---|---|
| Booking created | Customer submits form | `createOrder()`. If a trip was chosen, capacity is checked and status jumps straight to `Assigned`; otherwise `Pending`. **No price yet.** | New order, `shipping_cost = 0` |
| → Assigned | Admin picks a trip | Database refuses any status from `Assigned` onward without a `trip_id` (a hard rule, `CHECK` constraint — this can't be bypassed even by a raw admin API call) | Order tied to a trip |
| → Picked Up | Admin weighs the parcel at pickup | `record_pickup_payment` RPC atomically records the **real scale weight** (`actual_weight`), computes `shipping_cost = weight × rate`, accepts any discount/payment, uploads photos — all in one transaction | Order is priced for the first time |
| → In Transit → Arrived at Hub | Admin starts/progresses the **trip** (not the order directly) | A trip-level rule blocks starting a trip if any of its orders are unpicked-up, still on hold for cancellation, or the trip's total weight is zero | All eligible orders on that trip flip status together |
| → Out for Delivery | Admin dispatches | Database checks: parcel must be weighed, AND (balance is ₱0 OR the payer is the receiver/COD OR an admin recorded a "Promise Date") | Dispatch blocked otherwise, even by direct API call |
| → Delivered | Admin/driver confirms | Same balance-or-promise-date rule re-checked | Terminal state |

**Concrete example:** A ₱2,500 prepaid shipment (5kg × ₱500/kg) with ₱0 paid cannot be moved to "Out for Delivery" unless the admin either collects the ₱2,500 first, marks it Cash-on-Delivery (`payer_type='receiver'`), or explicitly records a Promise Date (e.g., "customer will pay on 2026-09-25"). This rule lives in the database trigger, so it cannot be skipped by a bug or a modified frontend request.

**Client vs DB enforcement:** the *order* of statuses (Pending→Assigned→...) is mostly a frontend convenience check; the *individual hard rules* (trip required, dispatch payment gate, capacity limit) are enforced in the database and cannot be bypassed from the browser.

**Edge cases traced:**
- **Trip with no bookings / all-cancelled / zero weight:** the database explicitly refuses to *start* a trip if its total eligible weight is zero — confirmed by a dedicated migration and regression test (`a152608 fix(trip): strictly validate actual cargo weight...`).
- **Zero-weight order dispatched:** blocked — "Cannot dispatch order — it has not been weighed" is a hard database exception, not a soft warning.

---

### 4.3 Financials, Billing & Discounts

**Formula chain (this is the single most important thing to memorize for the defense):**

```
shipping_cost   = actual_weight (from the scale) × price_per_kg (trip's own rate, or the company default)
final_charge    = MAX(shipping_cost − discount_amount, 0)
gross_paid      = SUM of all 'paid'/'partial' rows in payment_transactions
net_paid        = MAX(gross_paid − SUM of succeeded refunds, 0)
remaining_balance = MAX(final_charge − net_paid, 0)
payment_status  = 'unpaid' | 'partial' | 'paid'   (derived, never hand-set)
```

All four of these — `shipping_cost`, `amount_paid`, `remaining_balance`, `payment_status` — are written **only** by a database trigger reacting to inserts into `payment_transactions` and `payment_refunds`. No frontend code, and no admin-facing RPC, ever writes these columns directly.

**Discount rules:**
- Only an admin can set a discount, only while the order is in `Pending Review`, `Pending`, or `Assigned` (i.e., **before pickup**), and only if the order has **no** payment recorded yet — even one partial payment permanently locks the discount. All three of these are enforced by the database, not just the UI.
- A discount can never exceed the shipping cost, and a reason is mandatory whenever a discount is applied.

**Cash vs GCash after pickup:** once a parcel is picked up, **cash is no longer accepted** for any additional/remaining balance — the database hard-rejects it with a clear message: "Collect the remaining balance via GCash." Cash is only allowed at pickup and at final delivery-confirmation.

**GCash — two separate paths, same ending:**
1. **Automated (PayMongo QR):** the customer pays through a PayMongo-hosted checkout. Only the PayMongo **webhook** (server-to-server callback, authenticated with a server-only key) is allowed to credit the payment — the browser is structurally incapable of crediting a GCash-QR payment on its own, even if it wanted to.
2. **Manual (admin types in a reference number):** requires the admin to tick "I verified the receipt," and the reference number is checked against a uniqueness rule so the same reference can't be credited twice.

**Worked example — PRIMARY (the user's exact two-refund scenario):**

```
Setup:
  Original fee:         ₱35,000
  Discount:              ₱1,000
  Final charge:         ₱34,000  ← this is what the customer owes

After ₱20,000 payment (cash at pickup):
  gross_paid            = ₱20,000
  successful_refunds    =       ₱0
  net_paid              = ₱20,000
  remaining_balance     = ₱34,000 − ₱20,000 = ₱14,000
  payment_status        = 'partial'

After BOTH refunds succeed (₱10,000 cash + ₱10,000 GCash = ₱20,000 total):
  gross_paid            = ₱20,000  (unchanged — no new payment)
  successful_refunds    = ₱20,000
  net_paid              = ₱20,000 − ₱20,000 = ₱0
  remaining_balance     = ₱34,000 − ₱0 = ₱34,000
  payment_status        = 'unpaid'
  Note: booking is still ACTIVE. Company has returned all collected money.

After a NEW ₱20,000 payment:
  gross_paid            = ₱40,000
  successful_refunds    = ₱20,000  (unchanged)
  net_paid              = ₱40,000 − ₱20,000 = ₱20,000
  remaining_balance     = ₱34,000 − ₱20,000 = ₱14,000  ← correct final answer
  payment_status        = 'partial'
```

**Secondary example — single refund only (for comparison; NOT the above scenario):**
```
  One ₱10,000 cash refund only:
  net_paid          = ₱20,000 − ₱10,000 = ₱10,000
  remaining_balance = ₱34,000 − ₱10,000 = ₱24,000

  Then a new ₱20,000 payment:
  net_paid          = ₱30,000
  remaining_balance = ₱34,000 − ₱30,000 = ₱4,000
```

**Over-refund protection (confirmed in code and by test):** the database sums *all* in-flight or completed refunds against a specific payment (regardless of channel — manual or PayMongo) before allowing a new refund, and rejects any refund that would push the total refunded past the original payment amount. A dedicated test proves "a second admin cannot refund past the fully-reserved amount."

**Billed vs. collected vs. profit — an important distinction this review must state explicitly, since the system does not track business expenses:**

| Term | What it means here | Where it lives |
|---|---|---|
| Billed amount | `final_charge` (shipping cost minus discount) | `orders.shipping_cost`/`discount_amount` |
| Money collected | `gross_paid` | `SUM(payment_transactions)` |
| Money refunded | `SUM(payment_refunds WHERE status='succeeded')` | `payment_refunds` |
| Net collections | `gross_paid − refunded` | trigger-maintained on `orders.amount_paid` |
| Outstanding balance | `final_charge − net_paid` | `orders.remaining_balance` |
| **Profit** | **Not tracked anywhere in this system.** No expense, fuel, driver-pay, or overhead data exists. | N/A |

**"Net collections" must never be reported as "profit" in the thesis** — the system has no concept of cost, so it cannot compute profit. This is a scope limitation to state plainly to the panel, not a bug.

---

### 4.4 Cancellation & Refund Logic — the edge cases

**Two separate cancellation paths, not one:**

| Path | Who | Allowed statuses | Result |
|---|---|---|---|
| Customer requests | Customer, self-service | Pending Review / Pending / Assigned only | → `Pending Cancellation` (a **hold**, not final) |
| Admin cancels directly | Admin | Pending Review / Pending / Assigned / **Picked Up** (one step further than the customer path, because cargo can still be turned back before it leaves for the island) | → `Cancelled` immediately, no hold |

**Once in `Pending Cancellation`, the order is frozen** by a database trigger — nothing can move its status away except the two sanctioned exits (approve → Cancelled, or reject → restored to its exact prior status, trip and all). This freeze is enforced *at the database level*, so even a bug in the admin UI that tried to force-advance a pending-cancellation order would be rejected.

**Cancellation with no payment / partial payment / full payment — what actually happens:**
- **Structurally, cancelling an order never touches money.** Approving or rejecting a cancellation only flips `orders.status`. If a payment was collected, the admin must **separately** open the refund tool — this is intentional, two-step manual reconciliation, not a bug, but it does mean **an admin can cancel a fully-paid order and forget to refund it** — the system will not automatically remind or block this. *(Needs owner confirmation: should a paid-and-cancelled order automatically flag itself as "needs refund" somewhere visible? Currently it does not.)*

**Manual Refund Recording — full flow (this is one of the most carefully engineered parts of the system):**
1. Admin opens the refund modal, picks amount (capped at what's actually still refundable), a reason, a return method (cash or GCash — independent of how the original payment was made), a GCash reference or a cash note, ticks "I confirm the money has already been returned," and **re-enters their own password**.
2. The password is verified with a real, throwaway Supabase login attempt (this is the only way to check a password, since the database itself cannot read password hashes) — and the throwaway session is cleaned up locally so it doesn't log the admin out of their real session (an earlier bug did exactly that, and was fixed).
3. Five wrong password attempts locks re-verification for 15 minutes.
4. The actual database write is reachable **only** by the server (not by any logged-in browser), so an admin cannot skip the password step by calling the database function directly.
5. The database independently re-checks: is this a PayMongo-paid transaction? (if so, refuses — "use the provider refund instead"); does the total refunded (from any source) exceed what was ever paid? (refuses); is the GCash reference actually shaped like a reference number, not an email/phone/internal ID/the original payment's own reference? (refuses each).

**GCash reference validation — exact rule, explained simply:** there is no single fixed format for a GCash reference (wallet transfers and bank-linked transfers look different), so instead of checking length/format exactly, the system checks for *known-wrong shapes*: too short, looks like an email, looks like a phone number, looks like an internal payment-system ID, or is literally the same reference as the original payment (which would misrepresent it as the new outgoing refund). Passing validation proves the text is reference-*shaped* — it does **not** prove money actually moved. That proof is the admin's confirmation checkbox, by design.

---

### 4.5 Notifications & Tracking

**Golden rule:** the browser only ever *causes* a change (records a payment, changes a status); the notification itself is always generated by the **database**, then delivered through a durable, retryable outbox — never a fire-and-forget call from the browser. This means closing a browser tab right after an action can never silently swallow the resulting notification.

**Concrete trigger points:**

| Event | What fires | How |
|---|---|---|
| Admin records a payment (any method, any RPC), or the PayMongo webhook confirms one | "Payment Completed/Recorded" push to the customer | Database trigger on `payment_transactions` insert |
| PayMongo payment fails | "Payment Not Completed" push | Database trigger |
| Admin starts/progresses a trip | "Trip Started/Arrived/Completed/Cancelled" push to every affected customer | Trip-status trigger, same transaction as the order-status cascade |
| Trip dates change | Push + Resend email | Trigger + dedicated Edge Function, server-key only |
| Overdue promised payment | Reminder email | Daily cron job at 08:00 PHT |
| New booking | "Booking Received" (customer) + "New Booking" (admins) | Trigger on order insert |
| Admin broadcasts an announcement | Push to all customers + optional mass email | Trigger (push) + durable outbox (email) |

**Real-time UI:** admin/customer order screens subscribe to live database changes (Supabase Realtime), so when a webhook silently credits a GCash payment in the background, the admin's open payment screen and the customer's own tracking page both update within moments — no manual refresh needed. Verified from code across five separate subscription points.

---

### 4.6 Sales Overview, Reports & Analytics, Print/PDF

**Two report screens, two RPCs, one shared bug pattern:**
- `get_sales_overview_data()` powers the "Sales Overview" tab (today/this-month snapshot).
- `get_financial_report_data()` powers the "Reports & Analytics" tab (custom date range).

**Confirmed bug:** on 2026-09-18, a real bug was found and fixed in `get_financial_report_data()`: it was bucketing a refund into a reporting period using the row's `updated_at` timestamp, which a **duplicate or delayed webhook redelivery** can silently bump forward — even though nothing about the refund actually changed. The fix introduced a `succeeded_at` timestamp that is written exactly once, the moment a refund truly succeeds, and switched the report to use that instead. **This fix was never applied to the sibling function, `get_sales_overview_data()`, which still has the original bug.** In practice: a duplicate webhook redelivery of an already-successful refund can make the Sales Overview tab's "Refunds This Month" or "Collected Today" figures silently shift to the wrong day/month, while the Reports tab (for the same underlying data) would show it correctly. **Severity: Medium-High** — this is exactly the kind of "two different reports show two different numbers" problem a thesis panel is likely to test for.

**Print/PDF:** built with `html2pdf.js` (renders an HTML clone into a PDF via canvas). The on-screen table caps at 50 rows for performance, but the **hidden print/PDF version renders every row with no cap** — for a report spanning a full year with thousands of deliveries, this could hit a browser canvas size limit or become extremely slow, potentially producing a blank or truncated PDF. Not yet tested live with a large dataset — flagged as **Medium, unverified live**.

**Customer Management:** deliberately read-only. The compact customer-list view is confirmed (by an automated test) to withhold email addresses; the detail page shows full PII once an admin drills in. There is no edit/delete/role-change UI anywhere in this module. **However**, the underlying database permission for admins to update a profile has no column restriction — the *trigger* that blocks role changes only applies to non-admins. This means the UI never allows it, but a technically capable admin with direct API access technically could change another user's role. This is a defense-in-depth gap, not an active exploit, since admins are already a trusted role in this system's design.

**Activity Logs — 7-day retention, confirmed:** a scheduled job deletes activity-log rows older than 7 days. **Important nuance:** this does *not* mean financial history disappears — order status changes and every payment/refund have their own separate, non-deletable tables (`order_status_events`, `payment_transactions`, `payment_refunds`) that are immune to this purge. What genuinely disappears after 7 days is the **narrative** of non-financial admin actions (e.g., "why did I edit the company address on this date") — this is a real, if minor, accountability gap for anything that isn't money- or status-related.

**Company price change — confirmed retroactive-pricing bug:** if an admin changes the company's price-per-kilo *after* a parcel has already been weighed but *before* it's been assigned to a trip, and a later event touches that order (most commonly, recording an additional payment), the database silently **recomputes that order's shipping cost using the new rate** — even though the actual parcel was never re-weighed. Orders already assigned to a trip are safe from this, because a trip locks in its own fixed rate at creation. **Severity: Medium-High**, and this appears to be a newly-identified issue not covered by prior audit documents.

---

### 4.7 Contact Inquiries, Support Chat, Feedback, Announcements

**Contact inquiry claiming — race condition, confirmed handled correctly:** if two admins click "Claim" on the same inquiry at the same time, the database uses a conditional update (`... WHERE assigned_admin_id IS NULL`) so only one admin's click can actually succeed — the second gets a clear "this was just claimed by someone else" message. This is genuine database-level protection, not a UI-only lock, and it's one of the cleanest race-condition fixes found in the whole codebase.

**Support chat — XSS-safe by construction:** neither the customer's nor the admin's chat view uses `dangerouslySetInnerHTML` (a React feature that, if misused, would let a malicious message inject working HTML/JavaScript). All messages render as plain, auto-escaped text or through a safe hand-built formatter. **Confirmed safe** — no dangerouslySetInnerHTML usage found anywhere in the chat surfaces.

**Chat privacy:** a customer cannot read another customer's conversation, even by guessing a conversation's ID — the database re-checks ownership on every read, not just on what the frontend chooses to display.

**Feedback:** tied strictly to a delivered order the submitting customer actually owns — enforced by both a uniqueness rule (one feedback per order) and a database policy, not just a form check. "Featured Shipments" (the public gallery) and "Feedback" were previously tangled together (a shipment's photo could accidentally attach to unrelated feedback) and have since been cleanly separated; the public-facing data now exposes only a masked name plus city/province — no phone number or address.

**Email opt-out link — confirmed not exploitable:** the one-click unsubscribe link uses a cryptographically signed token (HMAC), not a guessable ID, checked with a timing-attack-resistant comparison, and fails safely closed if its signing secret is ever missing. **An attacker cannot unsubscribe someone else's email just by knowing the address.**

---

## 5. Complete Customer and Admin Journeys

1. **Registration → login → booking → admin handling:** No dead ends found. Role is locked server-side at creation; booking without a chosen trip lands in `Pending`, with a trip in `Assigned`. Admin sees it via realtime subscription immediately.
2. **Booking → trip assignment → pickup/weighing → payment → transport → delivery:** Fully traced in §4.2. No missing steps found; the "trip owns In Transit/Arrived at Hub" design correctly hides the misleading per-order "Advance" button for those two steps.
3. **Partial → additional → fully paid:** `record_additional_payment` correctly rejects cash after pickup and correctly accounts for prior refunds when computing "how much is still owed" (this exact refund-awareness gap was fixed in commits `bbc4af2`/`3fb04e7`, same week as the reporting fix in §4.6).
4. **Interrupted payment → return/retry/webhook:** the client-side "return from GCash" page only polls status; it never itself credits money — only the verified webhook can. A duplicate webhook redelivery is explicitly handled as a no-op ("already reconciled"), so retries are safe.
5. **Refund → payment history → balance → reports:** balance updates immediately (trigger-driven); **Reports tab is now correct for period-bucketing after a duplicate webhook, but Sales Overview tab is not** (Finding #1).
6. **Cancellation with no/partial/full payment:** cancellation never auto-refunds — confirmed intentional two-step design, but also confirmed there is no visible "still owes a refund" flag after a paid order is cancelled. *(Needs owner confirmation.)*
7. **Trip with no bookings / all cancelled / zero weight / valid cargo:** starting a trip is blocked if total eligible weight is zero or any order is unpicked-up/on cancellation hold — confirmed by dedicated test.
8. **Trip reschedule → affected bookings → emails:** a genuine date change triggers exactly one courtesy email per affected customer; resubmitting identical dates correctly reports "no change" and fires nothing extra (confirmed by test).
9. **Public inquiry → claim → notes → resolution:** race-safe claiming (see §4.7); resolving is separately locked to the claiming admin at the database level, even if the UI were bypassed.
10. **Email opt-in/opt-out → announcement → recipient selection:** a single authoritative subscription table is read at broadcast time; opting out mid-broadcast doesn't retroactively cancel already-queued sends (expected outbox behavior) but does exclude the person from the *next* broadcast.
11. **Report generation → screen totals → print/PDF:** screen and PDF pull from the *same* already-fetched data (not a second, possibly-stale query) — but the PDF renders unbounded rows where the screen caps at 50 (Finding, §4.6).
12. **Logout/account switch → drafts, cache, permissions:** booking drafts are correctly user-scoped and wiped; the activity-log retry queue is not (Finding, §4.1). No shared query-cache library is used in this app, which reduces the overall risk of stale cross-account data after logout.

---

## 6. Computation Examples & Consistency Checks

Covered in depth in §4.3. Summary of what was tested and what wasn't:

| Scenario | Verified how |
|---|---|
| No refund | Executable test (financial-report-pgtest) |
| Partial refund | Executable test |
| Full refund | Executable test (manual-refund-pgtest) |
| Pending/failed refund excluded from totals | Executable test |
| Repeated/duplicate webhook | Executable test (refund-period-bucketing-pgtest) — proves the Reports tab is now correct |
| Retried payment/refund request (idempotency) | Executable test — same idempotency key does not create a duplicate row |
| Concurrent refund attempts (over-refund) | Executable test — "a second admin cannot refund past the fully-reserved amount" |
| Payments/refunds in different reporting periods | Executable test, plus the confirmed **unfixed** sibling bug in Sales Overview (Finding #1) — **not** covered by any existing test |

---

## 7. Confirmed Bugs and Security Risks (Master List)

| Severity | Area | Finding | Status |
|---|---|---|---|
| Medium-High | Reports | `get_sales_overview_data()` refund period-bucketing bug (sibling of an already-fixed bug) | Confirmed, open |
| Medium-High | Pricing | Company price-per-kilo change can retroactively re-price a weighed-but-not-trip-assigned order | Confirmed, open |
| Medium | Chat security | ~~Customer's "mark as read" update policy may not restrict the message-content column~~ **CORRECTED:** A BEFORE UPDATE trigger (`guard_chat_message_update`, migration `20260831070000`) explicitly raises exception '42501' if `NEW.message` differs from `OLD.message`. The RLS policy alone is insufficient, but the trigger closes the gap — this is NOT exploitable. | **Confirmed: not exploitable at database layer** (verified from trigger code) |
| Medium | Auth | Password/email change doesn't invalidate other device sessions | Confirmed, open |
| Medium | Reports/PDF | Print/PDF renders unbounded rows where the screen caps at 50 | Confirmed in code, not tested live |
| Low-Medium | Auth | Activity-log retry queue survives logout, tagged with prior user's ID | Confirmed, open |
| Low-Medium | Admin permissions | Admin DB permission to edit any profile has no column restriction (UI never exposes it) | Confirmed, low real-world risk |
| Low | Auth | Duplicate phone numbers allowed across accounts | Confirmed, open |
| Low | Auth | "Remember me" doesn't control session persistence the way its label implies | Confirmed, UX clarity issue |
| Low | Activity Logs | Non-financial admin actions unrecoverable after 7 days | Confirmed, by design |
| Low | Architecture | Several PayMongo-only database functions rely solely on access permissions (not an internal self-check) for their safety — safe today, but one accidental permission change away from a real hole | Confirmed pattern, not currently exploitable |
| — | Security posture | No customer-to-customer data leak found; no self-promotion to admin possible; no secret keys found in client-facing code | Confirmed safe |

**No Critical-severity finding was confirmed.** The most serious items (#1, #2 above) are data-accuracy/business-logic bugs, not unauthorized-access vulnerabilities.

---

## 8. Business Rules Needing Owner Confirmation

These are **not** bugs — they are decisions the system currently makes implicitly, that should be explicit business rules before defense, in case a panelist asks "what happens if...":

1. **Should a paid order that gets cancelled automatically flag itself as "refund pending"?** Currently, cancellation and refund are fully separate actions with no automatic linkage or reminder.
2. **Should the system prevent starting a trip that has zero eligible cargo weight, or should it just warn?** Currently it hard-blocks (confirmed), which is reasonable, but worth explicitly stating as intended.
3. **Should a company price-per-kilo change apply only going forward, never touching already-weighed parcels regardless of trip assignment?** This is currently *not* the behavior for the not-yet-trip-assigned window (Finding #2) — needs a decision on whether that's acceptable or should be fixed.
4. **Should duplicate phone numbers across different customer accounts be blocked?** Currently allowed.
5. **Should "Remember me" actually control session length (e.g., session-only vs. persistent)?** Currently it only remembers the email text.

---

## 9. Test Results and Verification Limitations

### What was actually run

```
npm test
```
This chains **~30 automated scripts** covering: smoke checks, accessibility linting, token/CSS linting, security-hardening contracts, password-recovery contracts, admin-customer contracts, activity-log contracts, payment UI/return-state contracts, PayMongo authorization, payment refund request/recovery, manual refund (full flow + edge function + GCash validation), financial report RPCs, announcement broadcast (worker + database), trip-reschedule broadcast, booking-draft isolation, registration transition, unpaid-shipments layout, photo reference/fallback/monitoring, Apple platform checks, push notification and notification-UX contracts.

**Result: all scripts passed, exit code 0.** These tests run against `@electric-sql/pglite` — a real, in-memory PostgreSQL engine that actually applies the migration files and runs real SQL — **not** just a regex/text search over the code. This is meaningfully stronger evidence than a plain unit test, but it is still not a live Supabase project or a real browser.

### What was NOT run, and why

| Not run | Reason |
|---|---|
| `npm run test:e2e` (Playwright) | Explicitly documented to require a **real, live Supabase project** and creates **real data** on every run. Running it would have violated the audit's read-only/no-production-data-change requirement, since no disposable staging project was available in this session. |
| Live browser click-through of every journey | No safe, isolated staging environment with real Supabase Auth was available in this non-interactive session. |
| Full enumeration of all ~180+ `SECURITY DEFINER` functions against `is_admin()` coverage | Time-boxed; the highest-value admin endpoints (financial reports, customer directory) were spot-checked and found clean, but this is not a claim of 100% coverage. |
| Live re-verification of the PayMongo double-credit bug documented in an older internal audit (`SYSTEM_MODULE_BUG_AUDIT.md`) | Not re-read line-by-line this pass — flagged as **unconfirmed status**, should be re-verified before citing as fixed or open in the defense. |
| Live test of the suspected chat-message tampering issue (§4.7/Finding table) | Would require an actual authenticated API call against a live database — reasoned from the exact policy text only. |
| Live test of the PDF export with a full year of data | No safe way to generate that volume of test data without touching a real project. |

**A passing `npm test` does not mean the whole system is free of bugs** — several of the confirmed findings in this document (the Sales Overview refund-bucketing bug, the retroactive price-change bug, the chat-message policy gap) are **not** covered by any existing automated test, meaning the test suite passing tells you nothing about them either way. This is an important distinction to be ready to explain to a panel.

---

## 10. Short Defense Reviewer

### What to know per module

- **Booking/Delivery:** the database — not the app — is the source of truth for "what status can this order become next." Be ready to explain why `In Transit`/`Arrived at Hub` are trip-controlled, not order-controlled.
- **Financials:** memorize the four-line formula chain in §4.3. Know that `remaining_balance` is trigger-maintained, never hand-set, and that refunds are subtracted before anything is called "paid."
- **Cancellation/Refund:** know the two separate cancellation paths and that cancellation never auto-refunds — this is a deliberate design choice, but be ready to say you'd add a "refund pending" flag as a future improvement.
- **Notifications:** know that pushing/emailing is always database- or edge-function-driven, never a raw client-side "fire and forget" call — this is what makes it durable.
- **Security:** know that RLS handles *which rows* someone can touch, and triggers handle *which columns* they can change (e.g., `role`) — this two-layer pattern is the single best "we understood the architecture" answer you can give.

### Likely panel questions and grounded answers

**Q: "What stops a customer from editing their own order's price in the browser and submitting it?"**
A: Even if they did, the database recalculates `shipping_cost` itself from the actual weight and the trip's rate every time the row is touched — the client-submitted value is simply overwritten by a trigger before it's saved.

**Q: "What if two admins try to do the same thing at once — like claiming the same customer inquiry?"**
A: The database uses a conditional update (only succeeds if nobody has claimed it yet); the second admin's attempt affects zero rows and they get a clear "someone already claimed this" message. This is real database-level protection, not a UI lock.

**Q: "How do you know your reports are accurate?"**
A: For the "Reports & Analytics" tab, yes — there's a specific, tested fix ensuring a refund is always counted in the period it actually succeeded, even if a payment provider redelivers the same webhook late. **However**, I found during this review that the sibling "Sales Overview" tab still has the old version of that bug — this is a known, documented gap I'd flag rather than hide.

**Q: "Is customer data protected from other customers?"**
A: Yes, confirmed at the database level (Row Level Security) for orders, chat, profiles, and payment history — not just hidden in the UI. A customer directly querying the API for another customer's row gets zero results, not an error, because Postgres itself won't match the row.

**Q: "Does refunding money undo a cancellation, or the other way around?"**
A: They're intentionally separate actions. Cancelling only changes status; refunding is a distinct, password-re-verified admin action against a specific payment record. This is a real design decision worth explaining, not an accidental gap — though I'd acknowledge there's currently no automatic reminder if a cancelled order still has money owed back.

**Q: "Can profit be calculated from this system?"**
A: No — the system tracks billed amounts, collections, and refunds, but has no concept of business expenses (fuel, driver pay, etc.), so "net collected" should never be presented as profit.

---

## Taglish Summary

**Ano ang confirmed na gumagana?**
Yung buong flow — booking, pag-assign ng trip, pagtimbang, pagbayad (cash/GCash), delivery, hanggang sa cancellation at refund — sinuri lahat at gumagana ayon sa disenyo. Lahat ng pera-related na numero (shipping cost, natirang balance, status ng bayad) ay kino-compute ng database mismo, hindi ng browser lang, kaya hindi ito basta-basta mapeke. Yung mga automated test (30+ scripts) ay pumasa lahat, at yung refund/discount system ang pinaka-maingat na ginawang bahagi ng buong system.

**Ano ang may confirmed bug o risk?**
May dalawang medium-high na bug na napansin: (1) yung "Sales Overview" tab ay pwedeng mag-display ng maling refund date/month kung mag-duplicate ang webhook mula sa PayMongo — na-ayos na ito sa "Reports" tab pero hindi pala na-apply sa "Sales Overview." (2) Kung babaguhin ng admin ang presyo per kilo pagkatapos na-timbang na ang isang parcel pero hindi pa naka-assign sa trip, pwedeng mabago ang bayarin niyan kahit hindi na muling tinimbang — dapat ma-lock na dapat ang presyo kapag na-timbang na. May iba pang mas maliliit na risk: hindi na-clear yung activity log queue pag nag-logout (pwedeng makita ng susunod na gumamit ng shared computer), at hindi na-lo-logout yung ibang device kapag nagpalit ng password.

**Ano ang hindi pa verified?**
Hindi pa ito na-test sa totoong browser o live na Supabase project — puro code review at in-memory database test lang ang ginawa dito, dahil delikado at hindi allowed na gumamit ng real production data. Kaya kahit pumasa lahat ng automated test, hindi pa ito garantiya na 100% tama lahat ng business logic — lalo na yung mga bagong natuklasang bug na wala pang existing test.

**Anong business rules ang kailangan kong desisyunan?**
(1) Dapat ba mag-auto-flag ang isang cancelled order na may bayad pa na dapat i-refund? (2) Dapat bang naka-lock na ang presyo ng isang parcel pagkatapos ma-timbang, kahit wala pang trip? (3) Dapat bang ipagbawal ang parehong phone number sa magkaibang accounts? Ikaw ang magdesisyon dito bago i-finalize sa defense.

**Ano ang dapat unahing ayusin bago ang defense?**
Unahin ang dalawang Medium-High na bug (refund date sa Sales Overview, at yung retroactive price change) dahil pareho itong maaaring pagtanungan directly kung mag-request ang panel ng "walk me through a report" o "what if you change the price mid-operation." Pangalawa, alamin kung sino ang gumagamit ng shared devices para malaman kung kailangan pa ayusin yung logout/session issues.
