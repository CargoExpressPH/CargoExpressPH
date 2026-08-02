# CargoExpress PH â€” Frontend UI/UX Deep Audit

**Date:** 2026-08-01 Â· **Auditor:** Codex Â· **Target:** `cargoexpress-ph` (Vercel-deployed React/Vite PWA)

---

## 1. Scope & Method (what was actually checked)

This audit covers the **entire frontend surface**:

- **36 unique page components** across **38 route entries** (3 public, 4 auth, 12 customer, 17 admin; the customer `/track` route reuses the public TrackingPage, and root/404 add two more routes)
- **32 shared UI components** + 3 layout shells
- **24 stylesheet files (14,281 lines)** including the token system and every override layer
- PWA manifest, service worker, offline fallback, SEO/meta layer
- Contexts/hooks that shape UX (auth, theme, toasts, push notifications, page titles)

Verification performed:

| Check | Result |
|---|---|
| `npm test` (smoke + static axe-lint, 98 files) | ✅ Passed — clean exit 0 (outside sandbox) |
| `npm run build` (Vite production build) | âœ… Passed â€” chunk-size warnings |
| Automated class-consistency scan (1,069 classes) | ⚠️ 72 unmatched by strict token check; ~16 have visible styling impact |
| WCAG contrast math on all brand/status color pairs | âš ï¸ Multiple AA failures in light mode |
| Per-screen source review of every page/component | âœ… Completed |
| Live visual capture (headless Edge/Chrome) | âŒ Blocked by environment; no screenshots used |

**Honesty note:** this is a code-evidence audit. Every finding below is backed by a specific file/line or a measured value. No claims are based on screenshots or assumptions about data the app would show at runtime.

---

## 2. Executive Verdict

**CargoExpress PH is a genuinely premium frontend â€” well above the typical standard for this class of application â€” but it is not "world-class in every inch," and a few defects are business-critical.**

Overall score: **8.0 / 10**

| Dimension | Score | Summary |
|---|---:|---|
| Visual design & polish | 8.5 | Cohesive brand system, strong surfaces, consistent dark mode |
| Interaction & motion | 9.0 | Best-in-class micro-interactions, page transitions, feedback |
| Information architecture & navigation | 8.5 | Clear IA; some dead ends and label gaps |
| Responsive & mobile | 9.0 | Tables, nav, chat, modals, keyboard viewport all handled |
| Forms & validation | 9.0 | Draft persistence, inline errors, capacity guards |
| Accessibility | 6.5 | Excellent intent, real WCAG AA failures in light mode |
| Consistency & maintainability | 6.5 | 5 CSS override layers, inline-style bypass, missing utilities |
| Performance & PWA | 7.5 | Route-split, PWA-complete, but heavy CSS and main chunk |
| Workflow correctness | 7.0 | One critical dead-end (GCash pickup) + broken confirm labels |
| **Overall** | **8.0** | Premium product; short, concrete punch list below |

---

## 3. What Is Genuinely World-Class

These are not generic compliments â€” each is verified in code:

- **Complete design-token system** (`tokens.css`): semantic colors, status badges, chart colors, radii, spacing, z-index, typography, shadow, glass tokens, full dark-mode override, `prefers-contrast` handling.
- **Responsive data tables that actually transform**: headers become `data-label`-driven stacked cards on mobile in both customer and admin shells.
- **Loading/empty/error/retry discipline**: skeletons for nearly every screen, `EmptyState` everywhere, `ErrorBoundary` + `ErrorBoundarySection`, 15s timeouts with friendly errors, network-recovery hooks.
- **Tracking timeline** rendered as a semantic `<ol>` with icons, timestamps, horizontalâ†’vertical mobile transform.
- **Booking flow**: 5-step wizard with sessionStorage draft recovery, `useBlocker` unsaved-changes guard, trip-capacity validation, cost preview, animated success "ticket" with copy-to-clipboard.
- **Admin inbox**: realtime conversation list, status routing, auto-assign on first reply, customer directory search, load-older pagination with scroll anchoring, failed-message retry/discard.
- **Reports/Sales**: bond-paper print stylesheet, CSV export, donut/bar charts with keyboard-accessible segments.
- **Operational modals**: pickup/delivery photo capture (1â€“3), receipts, PayMongo scaffolding, capacity-aware trip assignment, reassignment with reason + confirm.
- **Mobile-native touches**: pull-to-refresh, bottom tab bar that hides on keyboard, `dvh`/safe-area hardening, 16px inputs on coarse pointers, 44px targets.
- **A11y intent**: skip links, focus traps, `aria-live` toasts/logs, combobox command palette, `prefers-reduced-motion` respected everywhere including framer-motion.
- **PWA**: complete manifest (maskable icons, shortcuts), service worker with offline fallback page, iOS install banner, web-push support matrix.

---

## 4. Critical & High Findings

### C1 â€” GCash pickup is a functional dead-end (business-critical)

`src/components/ui/PickupModal.jsx`

`handleProceedToGCash()` (line 48) creates the PayMongo source and sets `paymentStep = 'waiting'`, but **it is never rendered or called anywhere in the JSX**. `checkoutUrl` is also never displayed. The submit button is disabled unless `paymentStep === 'successful'` (line 492), a state that can never be reached.

**Impact:** an admin selecting "GCash" in pickup processing can never complete the pickup. The only workaround is to select Cash. This is a real, shippable-blocking workflow bug.

### C2 â€” Delete confirmation buttons show the wrong label

`src/components/ui/ConfirmModal.jsx` only accepts `confirmLabel` (default `"Confirm"`). Three callers pass `confirmText`:

- `CompanyInformationPage.jsx:618` â†’ `confirmText="Remove"`
- `CompanyInfoFeaturesTab.jsx:335` â†’ `confirmText={deleting ? 'Deleting...' : 'Delete'}`
- `CompanyInfoCoverageTab.jsx:487` â†’ same

**Impact:** destructive delete dialogs (image removal, feature delete, coverage delete) render a generic **"Confirm"** button and never show "Deletingâ€¦" while in progress.

### C3 â€” Nested interactive elements in admin notifications

`src/components/ui/AdminNotificationCenter.jsx` lines 264 / 282: a `<button className="admin-notif-item">` contains a second `<button className="admin-notif-delete-btn">`. Nested buttons are invalid HTML, can fire both handlers on activation, and confuse screen readers.

### H1 â€” Light-mode color contrast fails WCAG AA

Measured contrast (normal text requires â‰¥ 4.5:1):

| Pair | Ratio | Used for |
|---|---:|---|
| `#16A34A` (primary) on white | **3.30** | links, `.text-primary`, prices, status text |
| `#22C55E` (primary-light) on white | **2.28** | gradients/buttons with white text |
| White on `#16A34A` / `#22C55E` | 3.30 / 2.28 | primary buttons (14px, weight 600) |
| `#10B981` (success) on white | **2.54** | `.text-success` amounts, "Paid" figures |
| `#F59E0B` (warning) on white | **2.15** | `.text-warning` balances |
| `#EF4444` (error) on white | **3.76** | `.text-error` amounts |
| `#3B82F6` (info) on white | **3.68** | info links/text |

Dark mode is generally excellent (10â€“15:1). Most badge tinted pairs (e.g., `#C2410C` on `#FFF7ED`) pass. The failure is systemic in **light mode**: the brand green is used as body-size text and button label color throughout the customer and admin surfaces.

### H2 â€” Missing utility classes with real visual impact

The automated scan found 1,069 unique classes in JSX; these are used but **not defined in any stylesheet**:

| Class | Where | Visual impact |
|---|---|---|
| `.min-width-0` | HomePage:257, OrdersPage | flex children may not shrink/ellipsis correctly |
| `.opacity-50` | ProfilePage:310/321, AdminOrderDetail:480 | busy/disabled push toggle not dimmed |
| `.py-2` | HomePage:307, AnnouncementsPage | announcement pills lose vertical padding |
| `.bg-surface` / `.br-8` | TripReassignModal:67, AdminOrderDetail:613 | confirmation summary has no background/radius |
| `.border-t` / `.border-color` / `.pt-16` / `.pt-12` | AdminOrderDetail, customer OrderDetail | missing separators/spacing in payment sections |
| `.table-responsive` | customer/admin payment tables | no overflow wrapper (mobile transform still works via sibling class) |
| `.hover-lift` | FeedbackPage cards | no standalone rule (only referenced inside a `:has()` media query), so the intended lift is absent |
| `.page-title` | FeedbackPage | defined only inside a ≤640px media query (not missing); see note below |
| `.p-md`, `.shrink-0`, `.text-left`, `.rounded` | Inbox/Announcements/Coverage | minor padding/flex/radius gaps |
Note: `.page-title` **is** defined, but only inside a `max-width: 640px` media query (`responsive.css:106-111`). On desktop the FeedbackPage header therefore has no dedicated styling, unlike every other admin page that uses `.admin-page-title`.

### H3 â€” Keyboard accessibility gaps in clickable surfaces

- **About page coverage cards** are `<div onClick>` (AboutPage:1015â€“1016) â€” no `tabIndex`, no role; the `.about-region-card:focus-visible` CSS can never trigger.
- **About map pins** are `<g onClick>` SVG groups â€” mouse/hover only, no keyboard equivalent.
- **Company Info "Open 24/7" toggle** is a `<div onClick>` (CompanyInformationPage:488) â€” not a keyboard switch.
- **Personal Info unsaved-changes blocker** is a plain div (PersonalInfoPage ~150) â€” no `role="dialog"`, `aria-modal`, focus trap, or Escape handling, unlike every other modal in the app.
- **Company info forms**: many labels are not programmatically linked (`htmlFor`/`id` missing) â€” screen readers get no reliable field name (hero title/description, contact fields, feature icon, etc.).

### H4 â€” Customer Orders filter omits most real statuses

`OrdersPage.jsx:15`: tabs are `['All', 'Pending', 'In Transit', 'Delivered', 'Cancelled']`.

The system has 9 order statuses (admin side lists all of them: Pending Review, Pending, Assigned, Picked Up, In Transit, Arrived at Hub, Out for Delivery, Delivered, Cancelled). Customers cannot filter **Assigned, Picked Up, Arrived at Hub, Out for Delivery, or Pending Review** â€” those orders are only reachable under "All."

---

## 5. Medium Findings

### UX behavior

- **Push permission auto-prompt after 3â€“4s** on every login (AdminLayout:103, CustomerLayout:170) â€” effective but intrusive; a first-interaction or settings-only prompt would be more standard.
- **Admin Bookings search fires a DB query on every keystroke** (no debounce), while the Customers page debounces at 350ms â€” inconsistent and wasteful.
- **Tracking brand link goes to `/login`** for public visitors (TrackingPage:321) â€” should go to `/about` or stay on `/track`.
- **`role="main"` on the tracking result card** duplicates the page's `<main>` landmark (TrackingPage ~418).
- **Home announcement cards** use `card-interactive` (cursor:pointer) but have no click action (HomePage:299).
- **Reset password "Verifying your reset linkâ€¦" is a cosmetic 1.5s delay** â€” no actual token validation happens before showing the form.
- **Profile â†’ Change Password navigates to `/reset-password`**, a page built for emailed reset links; it shows "Verifying reset link" then relies on the live session. Confusing flow even though it can work.
- **Auto-navigation timers without cleanup** (`setTimeout(navigate)` in Register, ResetPassword, PersonalInfo) â€” stale navigation if the user leaves during the delay.
- **Customer status taxonomy differs from admin**: customer tabs and admin tabs use different labels/sets; align them.
- **Admin order detail hides "Advance to In Transit"** for Picked Up orders (deliberate, driven by trip start) â€” visible-only-to-admins ambiguity; a hint would help.
- **Customer Order Detail photo buttons** have no explicit `aria-label` describing the image (they rely on visible "Photo N" text) â€” acceptable but weak.

### Consistency & design-system debt

- **About page is almost entirely inline-styled** (AboutPage.jsx) â€” it bypasses the token system the rest of the app uses; hero fallback also hotlinks an Unsplash image.
- **CSS architecture has 5 override layers** (`premium-refresh`, `customer-mobile-refresh`, `admin-modern-refresh`, `viewport-hardening`, `remaining`) over the base component layer. Result: 314.69 kB CSS minified (54.6 kB gzip) and duplicate rules (`.modal-overlay` defined twice, `toastSlideIn` twice, `status-timeline` blocks duplicated).
- **Missing-utility clusters** listed in H2 make maintenance harder: a single `utilities.css` with the used set (and a lint rule banning undefined classes) would fix them.
- Hardcoded hex values remain in components.css (`#B91C1C`, `#991B1B`, `#047857`â€¦) instead of semantic tokens.

### Performance

- Main entry chunk: **583.55 kB minified / 165 kB gzip** (build warning).
- Admin Order Detail chunk: **94.96 kB**; Company Information: **84.32 kB**; About: **53.87 kB**.
- CSS total: **314.69 kB / 54.6 kB gzip**.
- Route-splitting is otherwise excellent; fonts are preconnected; images lazy-loaded.

---

## 6. Per-Surface Audit

### Public (3 screens)

| Screen | Grade | Strengths | Issues |
|---|---|---|---|
| `/track` | A- | Live 45s auto-refresh, rate-limit countdown UX, friendly errors, semantic timeline, clear empty state | Brand link â†’ login; duplicate `main` landmark; no share button for tracking number |
| `/about` | B+ | Stunning landing page: scroll progress, animated counters, interactive map, gallery lightbox, feedback filters, contact form | Map/region cards not keyboard accessible; inline styles; Unsplash hotlink fallback; timeline milestones have no real years |
| 404 | A | Branded animated 404, suggestions, smart back button | None significant |

### Auth (4 screens)

| Screen | Grade | Strengths | Issues |
|---|---|---|---|
| Login | A- | Split-panel branding, friendly error mapping, show/hide password, remember-me, footer links | Light-mode contrast on green; "remember me" only stores email (not a true session choice) |
| Register | A | 2-step flow, draft autosave, per-field validation, password strength/rules, caps-lock warning, focus-first-error | Terms/Privacy text isn't linked; phone optional here but required in profile; success redirect timer not cleaned |
| Forgot Password | A- | Clear steps, resend countdown + progress bar, spam guidance | Left panel duplicated via inline styles; no focus trap needed (no modal) |
| Reset Password | A- | Strength meter, live requirements, match indicator, success animation | "Verifying" is cosmetic; no early invalid-token state |

### Customer (13 screens)

| Screen | Grade | Strengths | Issues |
|---|---|---|---|
| Home | A- | Greeting hero, quick track, snapshot pills, next-trip card, active shipments, announcements, pull-to-refresh | `.min-width-0` missing; announcement cards look clickable but aren't; track button inline radius |
| Orders | B+ | Search, tabs, cards, skeletons, empty/error states | Missing 5 status tabs (H4); no per-status counts |
| Order Detail | A- | Timeline, cancel flow, photo proofs with preload/failure states, payment history, feedback modal | `.table-responsive` missing; photo buttons need better aria-labels |
| Book Shipment | A | 5-step wizard, draft persistence, blocker, capacity logic, out-of-coverage flow, success ticket | Dirty check only covers route/sender/receiver/weight; many inline styles |
| Trips | A- | Date badges, capacity chips, route preselect | Minor inline style inconsistencies |
| Notifications | A- | Realtime, swipe-to-delete, date grouping, confirm dialogs | Nested interactive pattern (role=button containing button); swipe hint only |
| Profile | A- | Completion meter, quick stats, settings menu, push toggles | `.opacity-50` missing; Change Password route confusing |
| Personal Info | B+ | Dirty-guard via useBlocker, phone normalization | Blocker modal is not a real dialog (no role/aria/focus); validation differs from registration (Facebook required; province/city/street not validated) |
| Payment Methods | A- | Security reassurance banner, balances, history, empty states | `.table-responsive` missing; 3-column cards stack tall on mobile |
| Support Chat | A | Bot+admin hybrid, retry/discard, resolution votes, typing indicator, pagination | Whole log uses `aria-live` (chatty); textarea disabled while bot types |
| Help & Guidelines | A- | Dynamic FAQs with fallback, search, guidelines cards | None significant |
| About & Version | A- | Network/PWA/notification status, company info, release notes | Minor: contact channels as `<a>` rows without explicit labels |

### Admin (17 screens)

| Screen | Grade | Strengths | Issues |
|---|---|---|---|
| Dashboard | A | Partial-failure warnings, donut, capacity tracker, skeletons, section boundaries | Donut "Other Orders" segment semantics |
| Bookings | A- | Full status tabs, pagination, search, out-of-coverage badge | Search not debounced |
| Order Detail | A- | Full workflow (assign/reassign/pickup/delivery/payment/feature/cleanup), activity timeline, reject modal | GCash dead-end via PickupModal (C1); missing utility classes; RejectModal missing `aria-labelledby` |
| Trips | A | Capacity bars, status counts, bulk status transitions | None significant |
| Create Trip | A | Route cards, revenue preview, field-level errors | None significant |
| Trip Detail | A | Start/arrive/complete guards, bulk order status sync, activity log | None significant |
| Customers | A | Debounced search, pagination, profiles | None significant |
| Customer Detail | A- | Profile card, stats, order history | Tracking numbers not linked to order detail |
| Sales | A | Revenue stats, donut, bar chart, formal print doc | Print button logs before print (minor) |
| Reports | A | Period tabs, custom range, CSV, print doc, route performance | Custom-range error only on generate; okay |
| Announcements | B+ | Category dropdown with keyboard, char limits, delete confirm | `confirmText` bug (C2); custom listbox is pseudo-focus (no `aria-activedescendant`); `.py-2` missing |
| Inbox | A | Realtime, auto-assign, directory, retry, mobile split | None in page itself (notification center C3 is separate) |
| Contact Inquiries | A | Row keyboard handling, status filters, detail modal | Modal overlay lacks role (inner modal has it) |
| Feedback | B+ | Ratings, search, hide/restore | `.hover-lift` has no standalone rule; header uses legacy `.page-title` (only styled ≤640px) instead of `.admin-page-title`; filter label unlinked |
| Activity Logs | A | 7-day retention note, filters, CSV export, pagination | Filter labels not programmatically linked to inputs |
| Company Info | B+ | Comprehensive tabs, image upload, hours, pricing | `confirmText` bug (C2); 24/7 toggle not keyboard accessible; many unlinked labels; dirty-tracking only per tab |

---

## 7. Design System & CSS Architecture

**Strengths**

- Tokens are genuinely excellent: semantic aliases (`--customer-*`, `--admin-*`), RGB triplets for alpha, status badge palettes, theme-aware charts, z-index scale.
- Dark mode is a real dark mode, not an inversion.
- Fluid type, container queries, `:has()` refinements, `@supports` fallbacks for `color-mix` â€” above typical React-app standards.

**Weaknesses**

- **Token bypass**: the About page and dozens of admin/customer spots use inline hex/var strings instead of classes.
- **Layered overrides**: the last four CSS files re-specify core components wholesale; a future design change must be fought in 5 places.
- **Undefined utilities**: see H2 â€” a formal utility layer + lint check would remove ~30 silent styling failures.
- **Bundle cost**: 54.6 kB gzip of CSS for an app this size is heavy and directly caused by the override layers.

---

## 8. Accessibility Checklist (WCAG 2.1 AA)

| Item | Status |
|---|---|
| Skip links | âœ… All layouts + public pages |
| Visible focus | âœ… Global `:focus-visible`, modals |
| Focus trapping / restoration | âœ… Shared FocusTrap; âš ï¸ Personal Info blocker excluded |
| Landmarks & headings | âš ï¸ Duplicate `main` on tracking result; mostly good |
| Dialog semantics | âš ï¸ Most modals good; blocker modal and some overlays missing |
| Form labels | âš ï¸ Customer/auth strong; admin company/activity/feedback forms weak |
| Image alt text | âœ… Static lint passes; photo buttons rely on visible text |
| Color contrast (light) | âŒ Fails AA (H1) |
| Keyboard operability | âš ï¸ About map/regions, 24/7 toggle, some listboxes |
| Nested interactive elements | âŒ Admin notification center |
| Touch targets | âœ… 44px standard; a few 28â€“32px icon buttons in admin dropdowns |
| Reduced motion | âœ… Global reset + framer-motion `reducedMotion="user"` |
| `aria-live` | âœ… Toasts, logs, countdowns; âš ï¸ full chat logs can be chatty |
| Zoom / reflow / safe areas | âœ… `dvh`, safe-area, `viewport-hardening`, 320px breakpoints |

---

## 9. Performance & PWA

- âœ… Route-level code splitting with per-page chunks.
- âš ï¸ Main chunk 583 kB min / 165 kB gzip; CSS 315 kB / 55 kB gzip.
- âœ… Preconnect + preload for Inter; `display=swap`.
- âœ… PWA manifest complete: standalone, maskable icons, shortcuts, categories.
- âœ… Service worker with version-stamped cache, cache limits, offline fallback page.
- âœ… iOS install banner + iOS 16.4+ web-push gating.
- âœ… Automatic SW update checking every 60 min (production).

---

## 10. Priority Fix List

**P0 (blocking quality):**
1. Wire `handleProceedToGCash` + checkout UI into PickupModal, or remove GCash from pickup until PayMongo flow is complete.
2. Add `confirmText` (or rename callers to `confirmLabel`) in ConfirmModal.
3. Replace nested `<button>` in AdminNotificationCenter with `<div role="button">` or split into separate controls.

**P1 (standard/quality):**
4. Introduce light-mode AA tokens: darker primary (`#15803D`-ish) for text/buttons, darker success/warning/error/info for text usage.
5. Add the missing utility classes (or remove the class names).
6. Make About coverage cards + map pins and the 24/7 toggle keyboard accessible.
7. Add missing customer status tabs (or a "More" filter).
8. Debounce admin Bookings search.
9. Convert Personal Info blocker to a real dialog (FocusTrap + role/aria).
10. Link admin form labels to inputs (Company Info, Activity Logs, Feedback).

**P2 (polish):**
11. Align FeedbackPage header with `admin-page-title` (legacy `.page-title` is only styled inside a ≤640px media query).
12. Change tracking brand link target; remove duplicate `main` landmark.
13. Clean up duplicate CSS rules and consolidate override layers.
14. Replace About-page inline styles with tokens/classes.
15. Clean up navigation timers; add explicit hints for Picked Up â†’ In Transit.
16. Add order-detail links in admin customer history table.

---

## 11. Bottom Line

**Is it world-class and standard in every area? No â€” not literally every inch.** The honest answer:

- **Design quality, motion, responsive behavior, and workflow depth: yes, close to world-class.** This is a real product UI, not a template.
- **Accessibility, consistency, and a few critical workflows: not yet.** Light-mode contrast fails AA, one payment path dead-ends, three delete dialogs mislabel their buttons, and several keyboard paths are missing.

With the P0 + P1 list above (roughly 1â€“2 focused work sessions), this frontend would legitimately earn the "world-class" label across the board. Today it is an 8/10: premium, credible, and very close.

---

## 12. Verification Pass (2026-08-01, second pass)

Every critical and high finding was re-checked against source with exact evidence. Corrections from the first pass are listed at the end.

### Re-verified findings (all confirmed)

| # | Finding | Exact evidence |
|---|---|---|
| C1 | GCash pickup dead-end | `handleProceedToGCash` exists only at `PickupModal.jsx:48` and is never referenced in JSX; `checkoutUrl` only set at line 65, never rendered; submit disabled unless `paymentStep === 'successful'` (line 492). `initiateGCashPayment` in `paymongo.js:146` is defined but imported nowhere in the app (`rg` across `src` returns no usage). |
| C2 | Delete dialogs show "Confirm" | `ConfirmModal.jsx:37` destructures only `confirmLabel` (default `"Confirm"`), rendered at line 127. Callers pass `confirmText` at `CompanyInformationPage.jsx:618`, `CompanyInfoFeaturesTab.jsx:335`, `CompanyInfoCoverageTab.jsx:487`. |
| C3 | Nested buttons in admin notifications | `AdminNotificationCenter.jsx:262-291`: outer `<button class="admin-notif-item">` contains inner `<button class="admin-notif-delete-btn">` at line 281. |
| H1 | Light-mode contrast fails AA | Measured ratios re-computed: `#16A34A` on white 3.30:1, `#22C55E` 2.28:1, `#10B981` 2.54:1, `#F59E0B` 2.15:1, `#EF4444` 3.76:1, `#3B82F6` 3.68:1. Verified usages: `.text-primary` = `var(--primary)` (`animations-utils.css:228`), `.text-success/error/warning` = semantic vars (lines 231-233), used on white cards at `PaymentMethodsPage.jsx:159/163/205/243`, `OrderDetailPage.jsx:504/508`, `AdminOrderDetailPage.jsx:727/731`. Buttons: `components.css:18-21` (white on green gradient), `customer-mobile-refresh.css:124-127` (white on `#16A34A → #22C55E`), `admin-modern-refresh.css:735-738` (same). |
| H2 | Missing utility classes | Strict token scan of all 24 CSS files: `.min-width-0` (HomePage:257, OrdersPage:135), `.opacity-50` (ProfilePage:310/321, AdminOrderDetail:480), `.py-2` (HomePage:307, AnnouncementsPage:292), `.bg-surface`/`.br-8` (TripReassignModal:67, AdminOrderDetail:613), `.border-t`/`.border-color`/`.pt-16` (AdminOrderDetail:794,609), `.pt-12` (customer OrderDetail:431), `.table-responsive` (3 payment tables), `.hover-lift` (FeedbackPage:119 — no standalone rule), `.p-md`, `.shrink-0`, `.rounded`, `.text-left` — none matched in CSS. |
| H3 | Keyboard gaps | About region cards: `AboutPage.jsx:1015-1016` `<div onClick>` with no role/tabIndex; map pins: `AboutPage.jsx:429-430` `<g onClick>`; 24/7 toggle: `CompanyInformationPage.jsx:488` `<div onClick>` with no role/tabIndex/switch; Personal Info blocker: `PersonalInfoPage.jsx:137-155` plain divs, no `role`, `aria-modal`, or FocusTrap (verified no `role`/`aria-*`/`tabIndex` tokens in that block). |
| H4 | Customer Orders status tabs incomplete | `OrdersPage.jsx:15` vs `status.js:5-12` (9 statuses) and admin tabs `OrdersPage.jsx:14`. Missing: Pending Review, Assigned, Picked Up, Arrived at Hub, Out for Delivery. |
| M1 | Push auto-prompt | AdminLayout:102-106 (3,000 ms), CustomerLayout:169-173 (4,000 ms). |
| M2 | Admin Bookings search un-debounced | `OrdersPage.jsx:49` effect depends on `search`; `handleSearchChange` (line 62) sets state directly. CustomersPage debounces (line 28+). |
| M3 | Tracking brand link / duplicate landmark | `TrackingPage.jsx:321` (`Link to="/login"`), `TrackingPage.jsx:422` (`role="main"` inside the page `<main>`). |
| M4 | Reset-password "verifying" is cosmetic | `ResetPasswordPage.jsx:30` — 1.5s `setTimeout` only; no token check in effect. |
| M5 | Unclean navigation timers | RegisterPage:338 (1,400 ms), ResetPasswordPage:56 (3,000 ms), PersonalInfoPage:121 (1,200 ms `navigate(-1)`) — no cleanup. |
| M6 | Profile Change Password route | `ProfilePage.jsx:238` → `/reset-password`. |
| M7 | Announcement cards look clickable | `HomePage.jsx:299` `card-interactive` with no `onClick`. |
| M8 | Build sizes | `dist/assets/index-wY4WXhVx.js` = 583,550 B (165.05 kB gzip); CSS = 314,692 B (54.60 kB gzip); build printed the >500 kB chunk warning. |
| M9 | Duplicate CSS rules | `.modal-overlay` in `components.css` and `feedback.css`; `toastSlideIn` in `feedback.css` and `remaining.css`; `status-timeline` blocks in `data.css` and `remaining.css`. |

### Corrections applied in this pass

1. **Counts fixed:** the app has 24 CSS files (14,281 lines), not 22 (~15,700); 36 unique page components across 38 routes (+2 tabs), not 37 screens; 32 shared UI components + 3 layouts, not 35 UI components.
2. **`.page-title` is not missing:** it is defined inside a `max-width: 640px` media query (`responsive.css:106-111`). The finding was restated as a desktop inconsistency, not an undefined class.
3. **`.hover-lift` clarified:** it is not fully undefined — it appears only as a `:has(.hover-lift)` hook (`responsive.css:150`) — but it has no standalone rule, so the intended lift is absent.
4. **Unmatched-class count restated:** 72 unmatched by a strict token check (not 74); ~16 have visible styling impact, with the rest harmless structural wrappers.
5. **`npm test` clarification:** it exits cleanly with code 0 outside the sandbox; the earlier apparent hang was a sandbox artifact, not a test failure.

### Limitations (unchanged, stated honestly)

- Headless browser screenshots of the live deployment could not be captured in this environment (network + browser process restrictions), so visual claims are derived from source/CSS evidence, not pixels.
- Grade letters (A, B+, etc.) are judgment calls on top of the verified evidence; every factual claim beneath them is source-verified.
- Runtime behavior with real production data (e.g., actual orders in every status, real GCash/PayMongo calls) was not executed; the GCash finding is a static-code dead-end proof (no UI path calls the handler), not a live API test.


