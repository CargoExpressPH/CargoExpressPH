# CargoExpress PH — Frontend UI/UX Audit

**Date:** 2026-08-09 · **Commit:** `393b47e` · **Branch:** `claude/cargo-express-ui-ux-audit-ssd8oq`
**Scope:** entire frontend surface — 38 route entries, 43 page components, 38 shared components, 25 stylesheets, PWA layer.

> Companion to `ui-ux-audit.md` (2026-08-01), not a replacement. That audit was code-evidence only;
> this one rendered the running application.

## Status

| Finding | State |
|---|---|
| UX-01 install prompt invisible text | **Fixed** — verified 1.10:1 → 17.85:1 light, 15.08:1 dark |
| UX-07 contrast (4 sites) | **Fixed** — all four pages re-scan clean under axe |
| UX-08 "Loading module…" / "Van Capacity" | **Fixed** |
| Undefined-token guard | **Added** — `scripts/token-lint.mjs`, wired into `npm test` |
| UX-02, UX-03, UX-04, UX-05, UX-06, UX-09 – UX-13 | Open — deferred as higher-regression-risk |
| **UX-14 (new)** admin Reports contrast | Open — see below |

### UX-14 — Medium — Reports page: text on tinted surfaces fails AA

Surfaced only after this audit's fixes, because a 7-second settle lets the report tables finish
loading; earlier scans caught the page while it was still showing skeletons. **Pre-existing — not
introduced by the fixes above** (`ReportsPage.jsx` untouched, and none of these tokens changed).

| Element | Pair | Ratio |
|---|---|---:|
| `.report-financial-value.text-error` | `--error-text` `#DC2626` on `--bg-secondary` `#EBF1F6` | **4.24** |
| `.text-primary` (Tracking # cells) | `--primary-text` `#15803D` on `--bg-secondary` `#EBF1F6` | **4.40** |
| inline `badge` | `--success-dark` `#059669` on `--success-bg` `#ECFDF5` | **3.57** |

This is the same class as UX-07 and the token set already anticipates it — `--error-text-strong`
(5.91:1) and `--primary-text-strong` (documented 6.26:1 on `--bg-secondary`) exist for exactly this.
It was **not** fixed here because `.text-primary` is a global utility class used well beyond this
page, so changing it has a wide blast radius and needs visual review rather than a token swap.

---

## 1. Verdict

**Score: 7.5 / 10. Not yet world-class. Production-ready with two reservations.**

**Is it world-class?** Not quite, and the gap is narrower than the score suggests. In responsiveness,
state handling, modal accessibility and dark mode this app genuinely matches products built by far
larger teams. What holds it back is not the visual design — it is that the design system has real
holes (a colour token that was never defined ships invisible text to production), and the UI layer
quietly violates a data-correctness rule `CLAUDE.md` states three separate times.

**Is it production-ready?** Yes, after one fix:

- **UX-01** (High) makes the PWA install prompt unreadable for every light-mode user.
- **UX-02** (Medium) prints `₱0.00` for parcels that have no price yet, in six places. Strongly
  recommended alongside it, but the booking flow already explains the pricing model well, so this is
  a consistency defect rather than a trust one.

Both are small, well-understood changes. Neither requires redesign.

| Dimension | Score | Basis |
|---|---:|---|
| Layout & responsiveness | 9.0 | Zero horizontal overflow on every route at 390 px and 1440 px, both themes |
| Empty / loading / error states | 9.0 | EmptyState in 22 pages, skeletons in 24, error handling in 41 of 43 |
| Visual design & brand cohesion | 8.5 | Dark mode is a designed second theme, not an inversion |
| Interaction & feedback | 8.5 | Submit states, toasts, pull-to-refresh, command palette |
| PWA & performance posture | 7.5 | Deliberate precache list; 601 kB main chunk, 326 kB CSS in one file |
| Accessibility | 7.0 | 26 of 34 routes clean under axe, but 6 rules fail and 4 contrast pairs miss AA |
| UX writing | 6.5 | Mixed casing; "Loading module…"; "Van Capacity" |
| Design-system maturity | 6.0 | 748 inline styles, 84 `!important`, 5 override layers, ~15 breakpoints |
| Domain correctness in the UI | 6.5 | Booking flow explains "priced at pickup" well; the list and report surfaces then print ₱0.00 |

---

## 2. Method — what is verified, inferred, and unknown

There is no `.env` and no live Supabase project. Rather than fall back to reading source, a mock
Supabase REST/Auth server was written (fixtures shaped against `supabase/schema.sql`), the dev server
was pointed at it, and the audit **logged in as both a customer and an admin**. Findings marked
*verified live* were seen rendered in a browser.

| Check | Result |
|---|---|
| `npm test` (smoke + static axe-lint, 117 files) | PASS |
| `npm run build` (Vite production) | PASS, chunk-size warnings |
| axe-core WCAG 2.1 A/AA across 34 authenticated routes | 28 genuine nodes, 6 rules, 26 routes clean |
| Horizontal-overflow probe, 390 px + 1440 px, light + dark | 0 overflows |
| WCAG contrast maths over 49 declared token pairs | 7 fail (4 already documented decorative-only) |
| Undefined CSS custom properties (211 tokens vs all `var()` uses) | 1 real, 6 references |
| Touch-target measurement at 390 px | 3 below 24×24 |
| Heading-structure probe | 2 × `<h1>` on all 10 admin routes |

**On the axe numbers.** The first pass flagged 27 nodes, but **9 were not real** — 7 on the admin
Inbox were elements caught mid-fade, and 2 were an ErrorBoundary `<pre>` produced by a bad fixture.
Re-running with a 6-second settle cleared the Inbox entirely and, once the fixture was corrected,
revealed **10 previously hidden real nodes** on the two admin detail pages. The raw first-pass number
would have been wrong in both directions.

### Not verified — treat as unknown

- **Real data shapes.** Counts, chart proportions and list density came from fixtures. No finding
  below depends on a number the mock produced.
- **Realtime.** The WebSocket endpoint was not mocked; live badge increments, inbox streaming and
  `useRealtimeOrders` batching were never exercised.
- **PayMongo/GCash, push notifications, photo upload/compression, PDF export.** Untested.
- **Production build, Lighthouse, real devices, Safari, Firefox.** Chromium against the dev server
  only. iOS Safari — which the PWA specifically targets — was not tested.
- **Print stylesheets** (`print-document.css`, 221 lines) were not rendered.

### Ruled out — looked like defects, are not

- **The About page is not blank.** A full-page screenshot showed ~2,400 px of white. Cause:
  `whileInView` with `initial:{opacity:0}` — sections never entered the viewport. Scrolling before
  capture fixed it.
- **The admin Inbox has no contrast failures.** 7 nodes at 1.86–2.50:1 on first pass; clean after a
  6-second settle. They were mid-fade.
- **Admin order/trip detail do not crash.** They crashed because the fixture put an object in
  `activity_logs.details`, which is `TEXT` in the real schema. Notably, the ErrorBoundary caught it,
  kept the sidebar usable and offered Try Again / Reload.
- **Orders do not show "Not set" for their route.** The fixture omitted `orders.origin`/`destination`;
  the columns exist and `createOrder` always populates them.
- **Dark-mode badges are fine.** Not overridden in `tokens.css`, but re-toned at
  `components.css:451+`; all measure 7.4–9.4:1.

---

## 3. What is genuinely strong

- **Responsive behaviour is the best thing here.** Zero horizontal overflow on every route at 390 px
  in both themes; admin tables convert to `data-label` stacked cards that stay readable.
- **Modal accessibility is close to exemplary.** All nine modals carry `role="dialog"`, `aria-modal`,
  `FocusTrap`, `useScrollLock` and Escape; eight of nine also have `aria-labelledby`
  (`OnboardingModal` is the exception).
- **State discipline is thorough**, and empty copy is context-aware — `OrdersPage` distinguishes a
  filtered no-result from a genuinely empty account.
- **Absence is rendered as absence.** Unweighed parcels show `—` for weight and dimensions rather
  than `0` — which makes UX-02 more frustrating, since the same row then prints ₱0.00.
- **The token system has real reasoning.** 211 tokens with separate `-text` and `-fill` ramps. All
  twelve documented ratios were re-derived: every one passes AA, and the four "decorative only"
  warnings are accurate.
- **Dark mode is a designed second theme**, verified across 17 desktop routes.
- **Reduced motion is handled at both layers** — global CSS reset plus `useReducedMotion` and
  `MotionConfig reducedMotion="user"`. Only `CustomerLayout`'s 150 ms dropdown is unguarded.
- **Skip links on both layouts and public pages**; iOS zoom-on-focus prevented via 16 px inputs.

---

## 4. Findings

### UX-01 — High — Both PWA install prompts render near-invisible text in light mode

The install sheets style text with `var(--text-primary, #f1f5f9)`. **`--text-primary` is not defined
anywhere** (all 211 custom properties were extracted and compared against every `var()` reference).
It always falls back to `#f1f5f9` while the sheet background resolves through `var(--surface,#1e293b)`
to `#FFFFFF` in light mode.

```
#f1f5f9 on #FFFFFF = 1.10:1   (light — invisible)
#f1f5f9 on #132033 = 14.95:1  (dark — fine)

src/components/ui/IosInstallBanner.jsx:149, 174, 239, 295
src/components/ui/InstallAppBanner.jsx:169, 191
```

Both components were written against a dark sheet (`var(--surface,#1e293b)`,
`rgba(255,255,255,0.08)` fills), so the bug is light-mode only — which is how it survives review by
anyone working in dark mode. Confirmed visually at 390 px on an iPhone UA: the three benefit rows
render as bare emoji with labels invisible. The affected strings are the entire value proposition of
the prompt.

**Fix:** replace all six with `var(--text)`. Then add a build-time guard that fails on `var(--…)`
references absent from `tokens.css` — this class of bug is silent by construction.

---

### UX-02 — Medium — Unpriced parcels display "₱0.00" on every surface except the one that explains why

> *Severity revised from High to Medium after review.*

The zero is **correct data**: weight enters the system once, from the scale at pickup, so a new
booking genuinely has no price. And the booking flow says so, three times, well:

```
BookShipmentPage.jsx:807  "We weigh the parcel at pickup and the exact cost is confirmed then."
BookShipmentPage.jsx:837  "Your total is calculated when we weigh your parcel at pickup."
BookShipmentPage.jsx:878  "Weighed at pickup — you pay for the actual weight, nothing estimated."
```

That is good UX writing and it defuses the trust problem at the moment of booking. What remains is a
**consistency** defect: the explanation lives only inside the booking wizard. It is gone by the time
the customer opens their order list three days later, where the price slot shows a bare `₱0.00` in
the same green treatment as a real fare — and it was never present on the admin tables and revenue
reports at all.

`CLAUDE.md` is explicit that the *display* is the problem, not the data: *"₱0 means 'not priced yet',
never 'paid'… Anything answering a money question must ask `actual_weight > 0` first."* The helpers
built for this — `isOrderPriced()` and `getSettlementState()` — are **imported by exactly one file**,
`admin/OrderDetailPage.jsx`.

Two adjacent lines give the same row both treatments:

```jsx
// src/pages/admin/OrdersPage.jsx
153: <td data-label="Weight">{o.actual_weight ? `${o.actual_weight} kg` : '—'}</td>
154: <td data-label="Cost">₱{parseFloat(o.shipping_cost || 0).toFixed(2)}</td>   // ₱0.00
```

Weight correctly renders absence; cost, derived from that same absent weight, renders a confident
zero. A mobile card was photographed showing `WEIGHT —` directly above `COST ₱0.00`.

Six unguarded render sites:

```
customer/HomePage.jsx:277          customer/OrdersPage.jsx:156
admin/OrdersPage.jsx:154           admin/CustomerDetailPage.jsx:106
admin/SalesPage.jsx:369-371        admin/ReportsPage.jsx:462, 617
```

The sharper residual risk is on the admin side, where `₱0.00` sits in revenue columns on Sales and
Reports and is visually indistinguishable from a genuinely settled or zero-rated order. That is the
ambiguity `CLAUDE.md` records as having already shipped real defects — unweighed cargo passing the
dispatch gate, and `Unpaid` rendering beside `Settled` on the same row.

**Fix:** route every money render through `getSettlementState()` and print `—` or "Priced at pickup"
for the `unpriced` state — matching the treatment weight already gets, and carrying the booking
flow's existing explanation forward to the screens that show the result. Adoption, not new logic.

---

### UX-03 — Medium — Payment Methods uses the stored balance, not the derived one

`outstandingBalance()` is *"THE single client-side definition of what is owed"*, deriving
`shipping_cost − amount_paid` because the stored `remaining_balance` *"can lag a ledger write"*. It is
adopted in `database.js`, `supportChatEngine.js`, `admin/OrderDetailPage.jsx` and
`admin/TripDetailPage.jsx` — but not in the customer screen whose whole purpose is that question.

```js
// src/pages/customer/PaymentMethodsPage.jsx — does not import outstandingBalance
111: .filter(order => Number(order.remaining_balance || 0) > 0)
112: .sort((a,b) => Number(b.remaining_balance || 0) - …)
117: outstandingTotal: …reduce((s,o) => s + Number(o.remaining_balance || 0), 0)
```

Immediately after a payment posts, this screen can show a stale balance while admin views show the
correct one — the two-numbers-under-one-label failure already fixed on the reporting side.

**Fix:** import `outstandingBalance` and use it for the filter, sort and total.

---

### UX-04 — Medium — The tracking timeline breaks list semantics on every order-detail page

A presentational `<div>` sits between the `<ol>` and its items, so no `<li>` is a direct child.

```jsx
// src/components/ui/TrackingTimeline.jsx
55: <ol className="status-timeline">
59:   <div className="status-timeline-track">     // illegal child of <ol>
75:     <li className="status-timeline-step">
```

axe: `list` (1 node) + `listitem` (8 nodes), serious, on **both** customer and admin order detail. A
screen-reader user hears eight orphaned items instead of "list, 8 items, item 6 of 8, current step" —
losing exactly the positional information a shipment timeline exists to convey. `CLAUDE.md` describes
this component as "a semantic `<ol>`"; the intent is present, the implementation breaks it.

**Fix:** move `status-timeline-track`'s styles onto the `<ol>`, or give the wrapper
`display: contents`.

---

### UX-05 — Medium — Every admin page has two `<h1>`, and the first is the logo

```
src/components/layout/Sidebar.jsx:185       <h1>CARGO<span>EXPRESS</span></h1>
src/pages/admin/DashboardPage.jsx:102       <h1 className="admin-page-title">Dashboard</h1>
```

Measured `h1count = 2` on all ten admin routes in both themes. It also produces the `h1 → h3` jump
seen on most routes. Heading order is a best-practice rule rather than WCAG A/AA, so the axe run
(restricted to A/AA) did not flag it; the structural probe did.

**Fix:** render the wordmark as a `<div>`/`<p>` with the brand class, and demote card titles from
`h3` to `h2`.

---

### UX-06 — Medium — Interactive controls nested inside other interactive controls

**Notification cards** — the card is a `<div role="button" tabIndex={0}>` (with correct Enter/Space
handling and an `aria-label`, so the intent is careful) containing a real `<button>` for delete.

```
src/pages/customer/NotificationsPage.jsx:105–146   → axe nested-interactive × 3
```

**The registration stepper** — a container carries `role="progressbar"` while holding clickable step
buttons, and has no accessible name: two violations on one element. Semantically it is step
navigation, not a progress indicator.

```
src/pages/auth/RegisterPage.jsx:480   → axe nested-interactive + aria-progressbar-name
```

**Fix:** for the card, make the wrapper a plain container with a stretched-link button for the
primary action and delete as a sibling. For the stepper, drop `role="progressbar"` and use an `<ol>`
of steps with `aria-current="step"`.

---

### UX-07 — Medium — Four WCAG AA contrast failures, all light mode

Measured twice — independently by WCAG maths over the token definitions, and by axe against the
rendered DOM after animations settled. The two agree to the second decimal.

| Element | Pair | Size | Ratio |
|---|---|---|---:|
| `.profile-tier-badge` (customer/ProfilePage) | `#D97706` on `#FFFBEB` | 10.4 px bold | **3.07** |
| `.chat-waiting-banner` (customer/SupportChatPage) | `#D97706` on `#FFFBEB` | 14 px | **3.07** |
| `.about-footer-bottom` (about-page.css:1092) | `rgba(255,255,255,.35)` on `#0A0A0A` | 14 px | **3.14** |
| `.badge-cancelled` (tokens.css:108) | `#DC2626` on `#FEF2F2` | 12 px | **4.41** |

The last is the most telling. `tokens.css` already documents this exact problem — *"Stronger variants
for text sitting on a tinted surface, where the standard -text tokens land at 4.41:1"* — and ships
`--error-text-strong: #B91C1C`, which measures **5.91:1** there. The cancelled badge was never
migrated to it. The two amber failures are inline `style` attributes hardcoding `var(--warning-dark)`,
bypassing `--badge-warning-color` (6.84:1).

**Fix:** point `--badge-cancelled-color` at `--error-text-strong`; swap the two inline amber styles to
`--badge-warning-color`; raise the About footer alpha from `.35` to `.5` (5.37:1). Four one-line
changes.

---

### UX-08 — Low — Developer vocabulary in user-facing copy

```
src/components/ui/PageLoader.jsx:7            "Loading module..."
src/pages/admin/DashboardPage.jsx:141         "Van Capacity"
src/components/ui/CapacityTracker.jsx:40, 67  "Van Capacity" (also in aria-label)
```

`PageLoader` is the Suspense fallback for every lazy route, so "Loading module…" is the most-shown
loading string in the product. "Van Capacity" is wrong domain language: the route is Manila ⇄ Bohol
sea cargo, trips carry `vessel_name`, and the login hero advertises "sea cargo shipping".

**Fix:** "Loading…" and "Trip Capacity" (or "Vessel Capacity").

---

### UX-09 — Low — The same status is green in a badge and purple in the chart beside it

```
src/pages/admin/DashboardPage.jsx:88   { label: 'Picked Up', color: 'var(--chart-1)' }  → #8B5CF6
src/styles/components.css:430          .badge-picked-up → --badge-pickedup-color #15803D
```

Pending, In Transit and Delivered agree across both; only Picked Up diverges — on a screen where the
donut and the table are visible together.

**Fix:** drive both from one status→colour map.

---

### UX-10 — Low — Empty-state copy mixes Title Case and sentence case

```jsx
// src/pages/customer/OrdersPage.jsx:124 — both conventions in one ternary
title={search || activeTab !== 'All' ? 'No orders found' : 'No Orders Yet'}
```

Title Case: No Shipments Yet · No Notifications · No Open Balances · No Messages Yet · No Active Trips · No Inquiries
Sentence case: No orders found · No activity logs found · No customers found · No announcements yet · No feedback found · No active trip

Exclamation marks are similarly uneven, so tone shifts between adjacent screens.

**Fix:** pick sentence case, apply across all 22 `EmptyState` call sites, drop the exclamation marks.

---

### UX-11 — Low — Three touch targets below 24×24, and one that shrinks on touch

Measured on rendered pages at 390 px. WCAG 2.2 SC 2.5.8 (AA) sets 24×24 CSS px.

```
login   input.remember-me-checkbox    18 × 18
inbox   input[type=checkbox]          13 × 13
track   a.trk-footer-link "Sign In"   44 × 15
```

Separately, `remaining.css:3498` reduces `.message-customer-btn` to 32 px min-height specifically
under `(hover:none) and (pointer:coarse)` — shrinking a control on exactly the devices where it is
hardest to hit.

**Fix:** 24 px hit areas for the checkboxes (a padded label wrapper preserves the visual size),
vertical padding on footer links, and delete the coarse-pointer shrink rule.

---

### UX-12 — Low — Design-system erosion

```
inline style={{}}   748    (AboutPage 114 · admin/OrderDetailPage 51 · customer/OrderDetailPage 39)
!important           84    (remaining.css 28 · base.css 11 · validation.css 8)
override layers       5    premium-refresh → customer-mobile-refresh → admin-modern-refresh
                           → viewport-hardening → mobile-density
CSS bundle       326 kB    (57 kB gzip), single file, no route splitting
breakpoints        ~15     360 374 380 400 480 520 540 560 600 640 768 820 899.98 900 1024
```

`main.css` documents the problem in its own comment: `mobile-density.css` *"MUST stay last of the
screen layers — it exists to outrank the refresh files above… and beat every earlier mobile rule on
specificity."* That is a specificity arms race described in the file that runs it.

Two smaller symptoms: `--ripple-x`/`--ripple-y` (`remaining.css:1627`) are never set by any
JavaScript, so the click ripple is permanently centred instead of originating at the pointer; and
`about-page.css` uses both `min-width:900px` and `max-width:900px`, so both rule sets apply at
exactly 900 px — four other files correctly use the `899.98px` guard.

**Fix:** not a rewrite. Freeze the layer count, adopt a documented breakpoint scale of four or five
values, and burn down inline styles on the three worst files as they are next touched.

---

### UX-13 — Low — Onboarding interrupts; "Bookings" and "Orders" name the same thing

The onboarding modal fires on an 800 ms timer from layout mount and persists until dismissed, so a
user navigating straight to `/customer/book` gets the welcome tour dropped on top of the booking form
(hit while capturing screenshots). Separately: the admin sidebar and page title say **Bookings**; the
dashboard stat says **Total Orders**, its table **Recent Orders**, the route is `/admin/orders`, and
the customer nav says **Orders**.

**Fix:** suppress onboarding on `/customer/book`; pick one noun for the domain object.

---

## 5. Recommended order of work

1. **Fix the invisible install prompt** — six `var(--text-primary,…)` → `var(--text)`. *(UX-01, minutes)*
2. **Stop printing ₱0.00 for unpriced parcels** — six render sites through `getSettlementState()`, so the list and report screens match the booking flow's own explanation. *(UX-02, hours)*
3. **Add a CI guard for undefined design tokens** — the check that would have caught UX-01; `npm test` is already well-placed to host it. *(minutes)*
4. **Land the four contrast one-liners and the timeline nesting** — zero known contrast failures, clears 22 of the 28 genuine axe nodes. *(UX-04, UX-07)*
5. **Correct heading structure and both nested-interactive controls.** *(UX-05, UX-06)*
6. **Adopt `outstandingBalance()` on Payment Methods.** *(UX-03)*
7. **Copy pass** — one case convention, "Loading…", "Trip Capacity", one noun for bookings/orders. Cheap, and most of the perceived polish gap. *(UX-08, UX-10, UX-13)*
8. **Structural work** — touch targets, status-colour map, documented breakpoint scale with a frozen layer count. *(UX-09, UX-11, UX-12)*

### Before claiming world-class, close the test gap

The three things this audit could not touch are the three most likely to hide the next UX-01:
**real iOS Safari** (the PWA's stated target, and the platform whose install banner is currently
broken), **the realtime layer**, and **the payment flow**. The Playwright suite in `tests/` already
drives a real journey against a live Supabase project; extending it with a light-mode visual check on
the install banners and an axe assertion per route would turn this report into a regression test
rather than a snapshot.
