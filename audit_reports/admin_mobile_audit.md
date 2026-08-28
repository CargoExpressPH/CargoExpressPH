# Admin Panel — Mobile & Business Logic Audit

**Scope:** Every route under `/admin/*`, the admin shell (`AdminLayout`, `Sidebar`), every modal used from an admin page, and the shared CSS that governs table/modal/touch behavior on small screens.
**Method:** Full source read of all 21 admin page components, the 6 admin-invoked modals, `PaymentCollectionPanel`, and the relevant stylesheets (`layout-admin.css`, `admin-composition.css`, `admin-modern-refresh.css`, `tables-mobile.css`, `chat-inbox.css`, `forms-hardening.css`). No code was changed — this is a read-only trace, cross-checked line-by-line against the actual file contents quoted below.
**Note on scope:** the request named a "Drivers" module as an example — no such module exists in this codebase. The closest equivalents are **Trips** (vehicle/route/capacity management) and the **Orders** pickup/delivery flow (which records who physically handled the cargo via free-text names, not a driver account system). I audited what exists rather than inventing a module.

Findings are organized into the three sections requested: **Module Explanations**, **Critical Logic Bugs**, **Mobile UI/UX Issues**. A summary table is first for quick triage.

---

## At a Glance

| # | Finding | Category | Severity |
|---|---|---|---|
| 1 | Admin-created bookings are attributed to the **admin's own account**, not the customer's | Logic | 🔴 Critical |
| 2 | Claiming a contact inquiry has **no ownership enforcement** — any admin can steal another's claim | Logic | 🔴 Critical |
| 3 | Starting a trip can strand a **Pending-Cancellation order** mid-review | Logic | 🟠 Medium |
| 4 | `TripDetailPage` duplicates its "can this trip complete?" validation in two places | Logic / Duplication | 🟡 Minor |
| 5 | Small labelled buttons (`.btn-sm`, 34px) fall under the 44px touch-target guideline almost everywhere in admin | Mobile UI/UX | 🟡 Minor |
| 6 | Drag-to-reorder (Features / Coverage tabs) is not touch-tuned and will fight page scroll | Mobile UI/UX | 🟡 Minor |
| 7 | Company Information mixes two save models (batch vs. instant) with no visual cue | Mobile UI/UX | 🟡 Minor |
| 8 | Contact Inquiries' detail modal is hand-rolled instead of using the shared modal, already caused one missed a11y/mobile fix | Duplication | 🟡 Minor |

Everything else checked — **tables, the chat inbox's two-pane mobile layout, every action modal's scroll/focus handling, realtime sync across every list page** — is well built and I found no correctness issues in it. That's stated plainly in each section below so you know what was actually verified, not just what was flagged.

---

## Module Explanations

### Dashboard (`/admin`, `DashboardPage.jsx`)
On mount, `loadData()` fires two independent calls in parallel via `Promise.allSettled`: `getDashboardStats()` and `getVanCapacity()`. Because they're settled independently, **one can fail while the other succeeds** — the page still renders whatever came back, and a `statsWarning` banner tells the admin which half failed ("Failed to load order statistics") rather than blanking the whole screen. Only if *both* fail does the page show a full error state.
- The four stat tiles are **actionable counts**, not vanity totals: Pending Bookings (needs pricing/assignment), Awaiting Departure (`status = 'Picked Up'` — collected but the trip hasn't left), In Transit, Active Trips.
- The Trip Capacity card shows the single active/in-progress trip's load via `CapacityTracker`; if none exists, an empty state is shown instead of a blank chart.
- Order Distribution is a donut built from the same 4 counts plus a computed "Other Orders" bucket, so it never has to special-case a status it doesn't already track.
- Recent Orders is a 4-column read-only table linking to each order's detail page.

### Bookings / Orders List (`/admin/orders`, `OrdersPage.jsx`)
- Six status **groups** (not 11 raw statuses) drive the filter tabs — "Action Needed" bundles `Pending Review` + `Pending Cancellation`, "Active" bundles everything between Assigned and Out for Delivery. The grouping is applied **in the Supabase query** (`.in('status', statuses)`), not client-side, so pagination and the total count both reflect the same filtered population.
- Tab badge counts come from a separate RPC (`getOrderStatusCounts`) that is deliberately *not* recomputed on every keystroke/page turn — it only refreshes on mount, on a realtime batch, or when the network recovers.
- Search is debounced 350ms before hitting the DB.
- A realtime subscription (`useRealtimeOrders`, 1500ms debounce) refetches both the visible page and the badge counts whenever any order changes anywhere in the system — this is what lets one admin see another admin's status change land live.
- "Add Booking" routes to `AdminCreateBookingPage` — see Critical Bug #1 below for what actually happens to that order's ownership.

### Order Detail (`/admin/orders/:id`, `OrderDetailPage.jsx` — the busiest page in the app)
This is where every admin-side order action lives. Walking through what a click actually does:

- **Advance status** (`handleStatusAdvance`): computes `next` from `STATUS_FLOW[order.status]`. Three statuses are intercepted before any write happens: `Assigned` (no `trip_id` yet → opens the Assign-to-Trip modal instead of writing directly), `Picked Up` (opens `PickupModal`, which is where weight + payment get recorded — the status write happens *inside* that modal's save, not here), `Delivered` (opens `DeliveryModal`, same pattern). Every other transition calls `validateStatusTransition()` **again** client-side (even though the button that triggers this is already hidden for invalid cases) specifically because a trip's bulk cascade can land between when the page rendered and when the admin clicked.
- **Trip-controlled steps** (`In Transit`, `Arrived at Hub`): the button for these is hidden entirely — `isTripControlledAdvance(order)` — because those two transitions are written *once, for every order on the trip* by `TripDetailPage`. Clicking here would race the trip's own bulk write.
- **Pickup** (`handlePickupSave` → `recordPickupPayment` RPC): one DB transaction writes the actual weight, the pickup photos, and (if cash/settled GCash) a payment ledger row. `amount_paid`/`payment_status` are **never** set directly by this page — a trigger (`update_order_payment_totals`) derives them from the ledger, which is why the same money can't be double-counted between here and the Additional Payment modal.
- **Delivery** (`handleDeliverySave` → `recordDeliveryPayment`): same shape, for the last-mile leg.
- **Cancel (admin override)** (`handleCancel` → `cancelOrderAsAdmin`): gated by `canAdminCancelOrder(order)` — allowed for `Pending Review`/`Pending`/`Assigned`/`Picked Up`, refused once `In Transit` or later, and refused while `Pending Cancellation` (that status has its own Approve/Decline flow below, which merges into the existing `cancellation_details` instead of overwriting it).
- **Customer cancellation review** (`handleReviewCancellation` → `reviewOrderCancellation` RPC): approve flips the order to `Cancelled`; decline restores whatever status it held *before* the request (`cancellation_details.previous_status`), written server-side in one transaction along with the customer's notification and the activity log.
- **Out-of-coverage review** (`handleApproveReview` / `handleRejectReview`): a `Pending Review` order (customer booked from an unsupported province) is either approved back to `Pending` or rejected straight to `Cancelled` with a reason.
- **Reassign trip** (`handleTripReassign`): moves the order to a different trip with a mandatory reason, logged with both the old and new trip on the activity entry.
- **Additional payment** (`handleAdditionalPayment` → `recordAdditionalPayment`): the general-purpose "record money against this order" action used outside the pickup/delivery moments (e.g., chasing an unsettled balance).
- **Feature on website** (`handleSaveFeature`): toggles whether this delivery appears as a public testimonial/photo on the marketing site — requires a title if `featured_on_website` is checked, otherwise blocked client-side before the write.
- A dedicated effect handles the **GCash return path** when PayMongo redirects the admin back with `?payment=success` — it polls with backoff (0/2/4/6/8s) *and* holds a realtime channel open, whichever lands first wins, mirroring the same pattern on the customer side.

### Trips List (`/admin/trips`, `TripsPage.jsx`)
Card-based (not tabular) list, filterable by trip status. Each card shows a live capacity bar computed by the shared `tripCapacityState()` — the same function the booking-capacity guard uses — so "FULL" here means the same thing it means when a customer tries to book onto it.

### Trip Detail (`/admin/trips/:id`, `TripDetailPage.jsx`)
The trip's own lifecycle button set: **Start Trip** (`scheduled → in_progress`), **Mark Arrived** (`in_progress → arrived`), **Complete** (`arrived → completed`), **Cancel** (any non-terminal state). Each has its own preconditions checked *before* the confirm dialog is even shown:
- Start: refuses if there are zero assigned orders, or if any assigned order is still `Pending`/`Assigned` (not yet physically picked up).
- Complete: refuses if any order isn't `Delivered` or `Cancelled`, **and** refuses if any non-cancelled order still has an outstanding balance (mirrors the `guard_trip_completion` DB trigger — this is a client-side preview of a rule the database also enforces).
- On Start/Arrive, `bulkUpdateOrdersStatusByTrip()` writes the matching status to every order aboard in one query (`Picked Up → In Transit`, `In Transit → Arrived at Hub`).
- The Orders table lists every order on the trip with a direct link to its detail page and a message-customer shortcut.

### Create Trip (`/admin/trips/create`, `CreateTripPage.jsx`)
Route → schedule → capacity/pricing → notes, in one form. Before submitting, it calls `findDuplicateTrip()` to warn the admin if a trip on the same route/day already exists — a client-side courtesy check; the actual enforcement is a unique DB index, so a race between two admins still can't produce two trips for the same route/day.

### Customers List (`/admin/customers`, `CustomersPage.jsx`)
Single-column, name-only list (deliberately — see the in-code comment: every other detail lives one tap away on the customer's own record, and cramming 4 columns onto this table is what used to force it into a mobile card-restack for no reason). Debounced server-side search across name/email/phone/province.

### Customer Detail (`/admin/customers/:id`, `CustomerDetailPage.jsx`)
Read-only profile (email/phone/address/joined date, each rendered as a real `tel:`/`mailto:` link) plus 4 summary stats and the full order history table.

### Contact Inquiries (`/admin/contact-inquiries`, `ContactInquiriesPage.jsx`)
Public contact-form submissions. Clicking a row opens a hand-rolled detail modal and marks a `new` inquiry `read`. From there an admin can **Claim** (sets `assigned_admin_id` to themselves), **Release** (clears it), or **Mark Resolved**. See Critical Bug #2 — the claim/release mechanism has no actual ownership enforcement.

### Feedback (`/admin/feedback`, `FeedbackPage.jsx`)
Read/search/filter customer reviews and toggle their public visibility (`Hide`/`Restore`) — each toggle is logged to the activity trail as a moderation decision about someone else's words.

### Announcements (`/admin/announcements`, `AnnouncementsPage.jsx`)
Create/delete public announcements with a title (max 100), content (max 1500), and an optional category tag. The category selector doesn't write a separate `category` column — picking one just prepends its emoji to the title (unless already present), and the category shown later is *re-derived* from the title/content by keyword match. This is intentional (the code frames it as "Auto-Detect" being the default), but it means the "Category Tag" control is really "which emoji to stamp," not a stored classification — worth knowing if you ever want to filter or report by category later, since there's nothing to query on.

### Activity Logs (`/admin/activity-logs`, `ActivityLogsPage.jsx`)
Read-only audit trail, server-paginated (50/page), 3 filters (search, module, hide sign-ins). Logs are deleted after 7 days by a scheduled job — the date-range filter that used to exist was removed because it could never narrow anything past a week, which is documented directly in the file.

### Company Information (`/admin/company-info`, `CompanyInformationPage.jsx` + 2 delegated tabs)
Five tabs behind one route. **Basic Info / Contact Info / Pricing** share one `companyInfo` object, one dirty-check (`isDirty`), and one "Save Changes" button that only appears on those three tabs. **Features** and **Coverage Areas** are delegated to their own components that save *immediately* per add/edit/delete/reorder — see Mobile UI/UX #7 for why mixing these two models on one page is worth a second look. Validation on save is a curated subset (name, contact email, price-per-kilo, and any URL-shaped fields) — deliberately not everything, because the DB stays the actual authority and this only exists to name the field before the round trip.

### Inbox / Chat (`/admin/inbox`, `InboxPage.jsx` — second-busiest page)
A two-pane conversation list + thread view, kept in sync by three separate realtime channels (new conversations, conversation status changes, and every chat message system-wide). Key mechanics:
- A thread's **status is never set by hand** except "Resolved" — every other state (`waiting`, `waiting_customer`, `bot_active`) is derived server-side from who spoke last, and this page mirrors that logic locally (`becomesOurTurn`) purely so the badge/ordering don't lag a round trip.
- Deep-linking via `?customerId=` (used by every "Message Customer" button elsewhere in the admin app) opens or creates that customer's thread, then strips the query param via `replace` so back-navigation doesn't re-trigger it.
- Sending a message that failed shows an inline **Retry**/**Discard** action rather than silently vanishing.
- Message history is paginated (50 at a time) with scroll-position preserved when loading older messages.
- Search covers two things at once: the customer directory (name/email) and message bodies (via a dedicated admin-only RPC), so typing a phrase finds both matching people and matching conversations.

### Sales & Reports (`/admin/sales`, `SalesReportsPage.jsx`)
A thin switcher — not its own data page — that renders one of three children based on a `?tab=` URL param (not component state, specifically so a re-mount from route churn can't throw the admin back to "Sales" mid-task):
- **Sales Overview** (`SalesPage.jsx`): all-time revenue/collection tiles, a payment-method donut, a monthly bar chart, and a print/PDF-only formal report. Realtime-refreshed (2s debounce) without ever blanking a tile mid-refresh — a partial response merges over the last good value rather than replacing it.
- **Unsettled Deliveries** (`UnsettledDeliveriesPage.jsx`): every order still owing money, bucketed (Overdue / Held at Hub / Delivered-unpaid / Promised / Freight Collect / In Transit). Realtime updates **patch rows in place** rather than refetching the whole list — a row is only fully refetched when a newly-qualifying order needs the customer join that a bare `postgres_changes` payload doesn't carry. "Record Payment" opens the same `AdditionalPaymentModal` used from Order Detail.
- **Reports & Analytics** (`ReportsPage.jsx`): period-based (daily/weekly/monthly/yearly/custom) operational report — status breakdown, financial summary, route performance, and a full order list, each rendered twice (once for the screen, once as a formal print/PDF document).

### Admin Profile (`/admin/profile`, `ProfilePage.jsx`)
Minimal — identity card, links to Change Email / Change Password (shared pages with the customer side), and Sign Out.

### Admin Shell (`AdminLayout.jsx` + `Sidebar.jsx`)
- Sidebar is a slide-out drawer below 1024px (`DRAWER_QUERY`), a fixed rail above it, with its own collapse/expand toggle persisted to `localStorage`.
- Sidebar badge counts (Inbox, Inquiries) come from a debounced (2s) realtime-triggered refetch, not a running counter — an escalation out of `bot_active` re-fetches the true count rather than guessing at a delta, because `payload.old` on a `conversations` UPDATE only carries the primary key (no `REPLICA IDENTITY FULL`), so the previous status literally isn't knowable from the payload.
- The topbar's notification bell and Cmd/Ctrl+K command palette are global to every admin page.
- Push notification opt-in fires once per session, 3 seconds after mount, and distinguishes the iOS Web Push path from the Android/desktop FCM path.

### Add Booking (`/admin/create-booking`, `AdminCreateBookingPage.jsx`)
A walk-in booking form — same structured address fields as the customer booking wizard, submitted in one page instead of a multi-step wizard. **See Critical Bug #1 — this is the most consequential finding in the audit.**

---

## Critical Logic Bugs

### 1. 🔴 Admin-created bookings are owned by the admin, not the customer

**File:** `src/pages/admin/AdminCreateBookingPage.jsx`, line 90 and line 269.

```js
const { user } = useAuth();          // line 90 — this is the logged-in ADMIN's session
...
const payload = {
  user_id: user.id,                  // line 269
  origin: form.origin,
  ...
```

There is no customer-search, customer-select, or customer-creation step anywhere in this form (verified — no such state or handler exists in the file). Every booking created through "Add Booking" is inserted with `user_id` set to **the admin's own account id**.

**Concrete impact:**
- The customer this booking is actually for has **no account association with it whatsoever**. It will never appear in their "My Bookings" list (`getOrders` filters strictly by `user_id = auth.uid()`).
- They receive **no in-app notification and no push notification** — `createOrder()` only notifies admins, and this page never calls `createNotification()` for a customer.
- The only way anyone can ever look this booking up again is the tracking number on the public (no-login) tracking page, or an admin finding it directly in the Orders list.
- If several admins use this feature, each admin's account silently accumulates a private stash of orders that don't belong to them.

**Why I'm confident this is unintended, not a deliberate "walk-in, no account" design:** the database's own insert trigger (`prepare_order_insert`) has an explicit carve-out for exactly this feature — `IF auth.uid() IS NOT NULL AND NEW.user_id <> auth.uid() AND NOT public.is_admin() THEN RAISE EXCEPTION 'Cannot create orders for another user'` — meaning **only an admin is permitted by the database to insert an order under someone else's `user_id`**. That guard has no purpose unless the intended flow was for the admin to pick the real customer and set `user_id` to *their* id. The frontend simply never implements that step, so the one case the database explicitly opened a door for is the one case this page doesn't use it for.

**Recommended fix direction (not yet implemented, per your instructions):** add a customer lookup/select step (or "register this customer" if new) to the form, and set `payload.user_id` to that customer's id instead of the admin's own.

---

### 2. 🔴 Claiming a contact inquiry has no actual ownership enforcement

**Files:** `src/pages/admin/ContactInquiriesPage.jsx` (`handleAssign`), `src/lib/database.js` (`assignInquiry`/`unassignInquiry`, lines 1771–1788).

The whole point of this feature, per the code's own comment: *"Ownership. Without it nobody is answerable for an inquiry, and with more than one admin two people can answer the same person."* But the actual write is unconditional:

```js
export const assignInquiry = async (inquiryId) => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const { error } = await supabase
    .from('contact_inquiries')
    .update({ assigned_admin_id: user.id })   // no WHERE assigned_admin_id IS NULL, no guard at all
    .eq('id', inquiryId);
  if (error) throw error;
};
```

And the client-side button that calls it isn't disabled when the inquiry already belongs to someone else — it's just *relabeled*:

```jsx
<button
  type="button"
  className={...}
  onClick={() => handleAssign(selectedInquiry)}
  disabled={updating === selectedInquiry.id}   // only disabled while a request is in flight
>
  {selectedInquiry.assigned_admin_id
    ? (selectedInquiry.assigned_admin_id === user?.id ? 'Release' : `With ${selectedInquiry.assigned_admin?.name || 'admin'}`)
    : 'Claim'}
</button>
```

A second admin sees a button that literally says **"With [OtherAdmin]"** and can click it anyway. `handleAssign` computes `mine = inquiry.assigned_admin_id === user?.id`, finds it's `false`, and calls `assignInquiry()` — which reassigns the inquiry to the clicking admin with no check that it was already someone else's. The claim is stolen with one tap, silently, no warning, no confirmation — the exact scenario the feature exists to prevent.

**Recommended fix direction:** disable the button (not just relabel it) when `assigned_admin_id` is set to someone other than the current admin, and add a server-side guard (`.eq('assigned_admin_id', null)` on claim, or an RPC that checks ownership) so a stale page can't race a genuine claim either.

---

### 3. 🟠 Starting a trip can leave a Pending-Cancellation order stranded

**File:** `src/pages/admin/TripDetailPage.jsx`, `handleStatus('in_progress')`.

```js
const unpicked = orders.find(o => o.status === 'Pending' || o.status === 'Assigned');
if (unpicked) {
  toast.error('All assigned orders must be picked up before the trip can start.');
  ...
}
...
await bulkUpdateOrdersStatusByTrip(id, ['Picked Up'], 'In Transit', 'Triggered by Trip Start');
```

The pre-flight check only looks for `Pending`/`Assigned` orders — it does not check for one sitting in `Pending Cancellation` (a customer's cancellation request awaiting review). Such an order is not blocked from being on a starting trip, and the bulk cascade that follows only sweeps orders whose *current* status is `Picked Up` — a `Pending Cancellation` order is left exactly as it is.

Net effect: the trip can depart while one of its orders is frozen awaiting a cancellation decision. If an admin later **declines** that request (via `reviewOrderCancellation`), the order is restored to `cancellation_details.previous_status` (e.g. `Picked Up`) — even though the trip it was supposedly on has *already left*, so it now shows a status that no longer matches physical reality (the order will never get swept into `In Transit`, since that sweep already ran and won't run again for this trip).

**Recommended fix direction:** either block starting a trip while any assigned order is `Pending Cancellation` (force the decision first), or have the review/decline path re-check the trip's current status and correct the restored status accordingly.

---

## Duplicated Logic (flagged per your request, filed here rather than as a separate section)

### 4. 🟡 `TripDetailPage` validates "can complete?" in two places

`handleCompleteClick` (called when the **Complete** button is clicked, to decide whether to even open the confirm dialog) and `handleStatus('completed')` (called when the confirm dialog is actually confirmed) both independently implement:

```js
const undelivered = orders.some(o => o.status !== 'Delivered' && o.status !== 'Cancelled');
...
const unsettled = orders.filter(o => o.status !== 'Cancelled' && outstandingBalance(o) > 0);
```

Word-for-word the same two checks, in two functions, in the same file. It's currently harmless (both read the same `orders` state, so they can't disagree in practice), but it's exactly the shape of duplication that drifts the moment only one of the two gets updated for a new rule later. Worth extracting into one shared `canCompleteTrip(orders)` helper.

---

## Mobile UI/UX Issues

### Table Overflows — ✅ Verified good, no action needed
Every data table in the admin app (`Orders`, `Customers`, `Customer Detail`, `Dashboard`, `Trip Detail`, `Contact Inquiries`, `Activity Logs`, `Unsettled Deliveries`, `Reports`) consistently uses the `data-label` attribute on every `<td>`, which the shared `tables-mobile.css` uses to transform each row into a labelled card below the `.data-table`/`.report-table`/`--wide` variant breakpoints. I checked every single table's markup, not just the CSS rule — none of them have an unlabelled cell that would fall back to raw horizontal scroll. `TripsPage` and `FeedbackPage` avoid the question entirely by using cards instead of tables for their primary list, which is its own form of mobile-safe design.

### Modals & Dialogs — ✅ Mostly verified good
Every action modal I checked (`PickupModal`, `DeliveryModal`, `TripAssignModal`, `TripReassignModal`, `AdditionalPaymentModal`, plus the shared `ConfirmModal`) consistently uses the shared `.modal-overlay`/`.modal` classes, `FocusTrap`, and `useScrollLock`, and the tall ones (`PickupModal`, `DeliveryModal`, `AdditionalPaymentModal`) explicitly use `.modal-body-scroll` for internal scrolling. The shared CSS switches `.modal-overlay` to a bottom-anchored sheet layout on small screens (verified in `premium-refresh.css`), so these all get that treatment automatically.

**One exception:** `ContactInquiriesPage`'s inquiry-detail modal is hand-rolled inline rather than built from a shared component. It uses the same CSS classes (so it visually fits fine), but its own code comment admits *"this detail modal is built inline rather than from components/ui, so it was missed when scroll locking and Escape were added to the shared modals"* — meaning it has already drifted out of sync with the shared modal behavior once, and been manually patched back. It's fine today, but it's a standing risk: any future change to the shared modal pattern (e.g., a new a11y requirement) has to be remembered and re-applied here by hand, because this one doesn't inherit from anywhere.

### Touch Targets — 🟡 One systemic issue found
`.btn-sm` (used for the vast majority of labelled admin action buttons — Cancel Order, Approve & Cancel Order, Decline Request, Reassign Trip, Record Payment, Mark as Resolved, Hide/Restore, trip Start/Arrive/Complete/Cancel, etc.) resolves to **`min-height: 34px`** (`components.css`):

```css
.btn-sm {
  min-height: 34px;
  padding: 8px 14px;
  font-size: 0.8125rem;
  border-radius: var(--radius-xs);
}
```

That's below the commonly-cited 44px (iOS) / 48dp (Material) touch-target guideline. Contrast this with `.btn-icon.btn-sm`, which is explicitly bumped to a proper `44×44`, and with the Inbox page specifically, which has its own coarse-pointer media query in `forms-hardening.css` raising its mobile back button and chat-header buttons to 44px — **that same treatment was never extended to `.btn-sm` generally**, so every other admin page's small labelled buttons stay at 34px on a touchscreen. It's most noticeable where several `.btn-sm` buttons sit side-by-side in one `.admin-action-group` (e.g., Trip Detail's Start/Arrive/Complete/Cancel row), where a slightly-off tap can land on the neighboring button.

### Drag-to-Reorder is not touch-tuned
**Files:** `CompanyInfoFeaturesTab.jsx`, `CompanyInfoCoverageTab.jsx` (features, regions, and municipalities are all reorderable via `@dnd-kit`).

```js
useSensor(PointerSensor, {
  activationConstraint: { distance: 8 },
}),
```

`PointerSensor` with only a `distance: 8` activation constraint is a mouse-oriented setting — it starts a drag the moment a pointer moves 8px, which on a touchscreen is indistinguishable from the first 8px of an intended vertical *scroll*. dnd-kit's own guidance for touch is a **delay-based** constraint (e.g., `{ delay: 200, tolerance: 5 }`) precisely so a quick scroll gesture doesn't get hijacked into a drag. As configured, an admin trying to scroll this list on a phone is at real risk of accidentally picking up and repositioning a feature/region/municipality instead.

### Company Information mixes two save models with no visual distinction
Basic Info / Contact Info / Pricing share one "you have unsaved changes, click Save" banner and button. Features and Coverage Areas save **immediately** on every add/edit/delete/reorder, with no such banner and no "Save" button anywhere on those tabs. Nothing on screen tells an admin which mode a given tab is in — reasonable enough on a wide desktop screen where all 5 tabs are visible at once, but on a phone (one tab visible, the others swiped/scrolled out of view) it's easy to leave the Basic Info tab assuming a save-confirmation pattern that Features/Coverage don't follow, or to expect "unsaved changes" protection on a tab that never had it.

---

## What I checked but found solid (stated explicitly, per your request for a clear picture)

- **Realtime sync** across Orders, Sales, Unsettled Deliveries, and the Inbox/sidebar badges — all correctly debounced, all correctly merge rather than blindly overwrite in-flight state, and none of them can blank a tile or drop a row out from under an admin's cursor.
- **GCash/PayMongo reconciliation** on the admin Order Detail page mirrors the customer-side pattern exactly (bounded polling + realtime channel, whichever lands first), including the same "don't call an unweighed order paid just because its balance is ₱0" guard.
- **Payment ledger integrity** — every payment-writing path (`recordPickupPayment`, `recordDeliveryPayment`, `recordAdditionalPayment`) goes through the ledger; `amount_paid`/`payment_status` are never written directly from these pages, so there's no path here for the client to disagree with the trigger-derived totals.
- **The Inbox's mobile layout** (list ⇄ thread swap via `has-active-conv`, with a real back button) is a correctly-implemented, fully responsive two-pane chat pattern — I verified both the CSS breakpoints and that the JSX actually toggles the class.

---

*End of audit. No code was modified. Awaiting direction on which findings to act on.*
