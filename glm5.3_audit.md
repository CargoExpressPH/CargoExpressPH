# CargoExpressPH — Full Frontend UI/UX Audit

**Auditor:** GLM-5.3 (via ZCode), acting as senior product designer
**Date:** 2026-08-17
**Scope:** Every page, layout, component, stylesheet, and rendered screenshot of the deployed frontend
**Method:** Line-by-line code reading of all core surfaces + systematic pattern sweeps of every file + pixel-statistical measurement of all 104 screenshots (92 e2e light/dark/mobile + 12 responsive-width) + region-forensic layout analysis (banding, column density, per-slice color) of the visual-pass screens + vision-model aesthetic reviews (admin dashboard, login) + measurement-based aesthetic judgments (customer order desktop / iPhone SE, About page)

---

## 1. Verdict

**No — the system is not world-class in *all* areas. It is top-decile, genuinely excellent in interaction design, form UX, resilience, and theming reliability — and it is held back from the world-class bar (Stripe / Linear / Shopify) by four specific, measurable debts.**

| Dimension | Score | One-line judgment |
|---|---|---|
| UX flow engineering | 9.5/10 | Booking wizard is senior-product-company quality |
| Forms & validation | 9/10 | Full aria wiring, friendly errors, focus management |
| Component primitives | 9/10 | CustomSelect, ConfirmModal, FocusTrap, toasts are textbook |
| Design token system | 9/10 (design) / 7 (enforcement) | Documented AA contrast; leaked in practice |
| Theming (dark/light) | 8.5/10 | Measured correct on every captured surface |
| Accessibility culture | 8/10 | Rare lint discipline; data tables fail screen readers |
| Responsive / mobile | 7.5/10 | dvh hardening, keyboard handling; conflicting breakpoints |
| PWA / performance | 8.5/10 | Precache strategy, chunk retry, dual-protocol push |
| Testing culture | 8.5/10 | Real-journey E2E + custom a11y/token linters |
| Visual polish (measured + 2 judged + 3 measured screens) | ~8/10 | Dashboard 8.5 & login 8 by vision; order pages clean; About collapses its middle |
| CSS architecture | 5.5/10 | Six stacked override layers; 3.5k-line `remaining.css` |
| Consistency discipline | 6/10 | 742 inline styles, 281 hex values, locale drift |

**Summary sentence:** the *behavior* of this frontend is world-class; the *discipline at scale* (tables, tokens, CSS layers) is what separates it from the claim.

---

## 2. Coverage statement (what this audit actually examined)

**Read line-by-line:** all 3 layouts, `App.jsx`, `index.html`, `tokens.css`, `LoginPage`, `BookShipmentPage` (full), `HomePage`, admin `OrderDetailPage` (~700 lines incl. all handlers), `InboxPage` (core logic), `RegisterPage` (password step), `SupportChatPage` (states/banners), `NotificationsPage` (handlers), admin `OrdersPage` (render), `AboutPage` (map/lightbox architecture), and components: `CustomSelect`, `ConfirmModal`, `FocusTrap`, `Toast`, `EmptyState`, `StatusBadge`, `CommandPalette`, `TrackingTimeline`, `OnboardingModal`, `PickupModal`, `PaymentCollectionPanel` (validation core), `Sidebar`, `CustomerLayout`; plus `axe-lint.mjs`, `completeness.spec.js`, `responsive.css`, `main.css`, `viewport-hardening.css`.

**Swept with per-file pattern metrics (every file, no exceptions):** all 45 pages (loading/empty/error-state presence, aria density, inline-style counts), all 34 tables (`scope`/`caption`), all 25 CSS files (`!important`, hex, breakpoints, `focus-visible`).

**Measured pixel-forensically:** all 104 screenshots — luminance histograms and dominant-color buckets per file, plus crop-region analysis (center vs edges) on the anomalous set.

**Aesthetic judgment:** the vision service allowed exactly two calls across sessions (admin dashboard light: 8.5/10; login light: 8/10). Every subsequent call was rejected by an account-level rate limit, and the session that closed this report had no vision model at all. The remaining three screens (customer order desktop 1280, customer order iPhone SE 375, About light) were therefore judged by the documented measurement method: per-slice color/luminance forensics, banding and column-density geometry, whitespace ratios, and the line-by-line code that produces each surface — calibrated against the two vision-judged screens. That method answers hierarchy, density, palette, and contrast; it cannot judge fine typographic taste the way a retina can. All five verdicts below are labeled by which method produced them.

**One capture-set defect discovered:** all 29 desktop customer e2e screenshots are shot through the `OnboardingModal` scrim (`remaining.css:1871`, `rgba(0,0,0,.65)`) — the capture script ran a fresh profile and never dismissed it. These captures are unusable as design evidence for the pages behind them (the pages themselves are fine; mobile and responsive captures of the same pages are clean). Re-capture recommended.

---

## 3. What is genuinely world-class (evidence attached)

### 3.1 The booking flow — `src/pages/customer/BookShipmentPage.jsx`
- 5-step wizard with `sessionStorage` persistence (survives refresh mid-form).
- `useBlocker` navigation guard with a Discard/Stay confirm — unsaved work is never silently lost.
- **Double-submit guard via ref**, with the rationale documented in-code: state updates are async, two clicks in one React batch both pass a `disabled` check, and "a second POST is a second booking, not a retry."
- Full-viewport submitting overlay: the wait is visible from anywhere on the page, so a slow `createOrder()` can't read as a dead page.
- On validation failure: jumps to the step containing the error **and focuses the first invalid field** (queried from the DOM, with a comment explaining why a key→id mapping would break silently).
- Honest pricing: no fake estimate — "Weighed at pickup — you pay for the actual weight, nothing estimated."
- Success screen: animated checkmark with particle burst that **respects `useReducedMotion`**, ticket-style receipt with perforation, copy-to-clipboard with fallback for non-secure contexts.

### 3.2 Component primitives
- **`CustomSelect`** — a hand-rolled listbox with complete keyboard support (arrows, Enter, Space, Tab, Escape), `aria-activedescendant`, `role="option"`/`aria-selected`, viewport-aware flip-up placement with `visualViewport` math, disabled-option skipping in arrow navigation. Most commercial custom selects fail at least two of these.
- **`ConfirmModal`** — portals to `document.body` with the stacking-context bug documented in a comment (framer-motion's transform on `PageTransition` confines fixed-position overlays below the mobile tab bar; "no z-index on the overlay can escape that"). Auto-focuses **Cancel** — least-destructive action per WAI-ARIA APG. Full dialog semantics, Escape handling, scroll lock.
- **`FocusTrap`** — filters to *visible* focusables (`getClientRects().length > 0`), wrap-around Tab cycling, focus restoration on deactivate.
- **`Toast`** (`useToast.jsx`) — hover-to-pause with remaining-time arithmetic (pausing recomputes the remainder instead of restarting), stack capped at 4, `role="alert"` only for errors, `role="status"` otherwise.
- **`PaymentCollectionPanel`** — the strongest file in the codebase. Validation with race-condition reasoning documented in comments: a live GCash checkout is "an OPEN question — the customer may still be paying, may abandon, or may already have paid without us having heard. Releasing cargo inside that window is the race this closes." Full-payment shortfall checked at submit, not per keystroke, because "every prefix of a full amount ('8', '86', '860' against ₱8,600) is a shortfall." The failing field is returned as a contract, not parsed from message prose — "a substring match against prose is a bug waiting for a copy edit."

### 3.3 Accessibility *engineering culture*
- `scripts/axe-lint.mjs` — a zero-dependency linter in `npm test` that rejects placeholder-as-label with WCAG 2.5.3/3.3.2 rationale, catches empty `aria-label`s, duplicate ids, broken `aria-describedby` references, and **undefined CSS tokens** (`var(--x)` with no definition and no fallback), with the shipped-bug war stories documented in comments.
- Programmatic error association everywhere in forms: `aria-invalid` + `aria-describedby` → `role="alert"` inline errors.
- Skip link, `aria-live` step announcements, sr-only h1s where the visual heading is an h2, `usePageTitle` per route.

### 3.4 Resilience & failure design
- Dashboard: `Promise.allSettled` + **surfaced partial failures** ("Failed to load order statistics. Some data may be incomplete." + Dismiss) + per-section `ErrorBoundarySection` so one widget can't blank the page.
- Tracking page: rate-limit detection with a visible countdown, silent background refresh (no flicker), 45s focus-gated auto-refresh.
- `lazyWithRetry` re-tries chunk loads after a redeploy invalidates old hashes.
- `AuthContext`/`ProtectedRoute` hardening (documented in CLAUDE.md and code): no half-authenticated state, no spontaneous eject from a half-filled booking form.
- Inbox: scroll-anchor preservation when loading older messages (`prevHeight` math in `requestAnimationFrame`), near-bottom-only autoscroll respecting reduced motion, PostgREST delimiter stripping on search input.

### 3.5 Theming — measured, not assumed
- All 46 dark-mode captures render 88.9–98.5% dark pixels (mean luminance 16–41), dark-navy token palette dominant on every page. **The 281 hardcoded hex values flagged as a risk have not broken any dark screen** — verified by pixel statistics across the entire captured surface.
- Light theme: admin pages 86–96% white-dominant; customer + public pages white/mint consistent.
- Responsive-width sweep (360 / 375 / 390 / 430 / 768 / 1280px): same palette holds at every width; no theme breakage at any breakpoint.
- `tokens.css` itself: per-token documented WCAG contrast ratios, separate `-text` / `-fill` / `-strong` variants with reasoning, `@supports` fallback for no-backdrop-filter devices, reduced mobile blur cost.

### 3.6 Visual pass — all five judged screens

**Vision-judged (quota open):**

1. **admin/dashboard-light — 8.5/10** (vision model). Strengths: clear visual hierarchy with scannable KPI cards; cohesive green/white professional palette; clean modern card design; readable data table with good row spacing. Weaknesses: KPI band feels cramped at the top (cards nearly touch); donut-chart legend text ~11–12px (too small); chart column slightly crowded; charts collapse to empty state at reduced viewport heights.
2. **login-light — 8/10** (vision model). Cohesive split-screen with mesh-gradient brand panel; clean form card; friendly errors. Noted as slightly below the dashboard: the brand panel's decorative gradient does more emotional work than the form's denser typography.

**Measured (this report, method in §2):**

3. **customer-order-desktop-1280 — 8/10** (region forensics + code). 97.8% light pixels, mean luminance 240 on a 1280-wide capture; white-dominant page with mint-tinted surfaces (`#ddeeee`/`#eeffff` families ≈ 8–9% each) and a single green accent (`#11bb55`, the primary button/status color) at 3–7%. Content density per horizontal slice is 0–8% — a genuinely airy layout: the tracking header + one card occupy the top third, and whitespace rows account for 216/267 sampled rows. Left-column banding confirms the sidebar-adjacent layout holds a narrow centered content column (peaks at x≈568–720 CSS on the 2560-device image). **Verdict: clean, consistent, and calm — but thin.** The desktop view under-utilizes 1280px width (a ~300px content spine flanked by large empty margins), and the hierarchy relies almost entirely on card white-space rather than any visual density gradient. It reads *correct*, not *confident*. The same page on mobile (below) is better composed because the constraint forces intent.
4. **customer-order-iphone-se-375 — 8.5/10** (region forensics + code). 375-wide capture; mint-tinted page background (`#ddeeee` 47–67% in the header band) that grades into white card surfaces, with the green primary appearing at 5% and slate text (`#445566`) holding contrast. Content density ramps from 2% (top header) to 14–28% (card stack) — the vertical rhythm is *intentional*: airy top, dense detail card, then a bottom-nav band. Whitespace rows drop to 147/267. **Verdict: the strongest screen in the customer surface.** The SE width forces single-column discipline; the mint-background/white-card layering gives the page a quiet premium feel, the status badge and primary button are the only saturated elements (correct focus strategy), and the code confirms the detail cards follow one consistent 16px-padded card-body recipe (`OrderDetailPage.jsx` 504–666). The only deduction: it's the same card-stack pattern as every other customer page — excellent execution, low variety across the surface.
5. **about-light — 6.5/10** (region forensics + code). **This is the one real visual defect found anywhere in the pass.** The capture (1440×4775 full-page) shows: dark-navy hero with the hand-drawn SVG map (slices 0–1: `#001122`/`#112233` 61% — the bespoke ocean/land artwork, legitimately impressive), then a white story section (slice 3: 78% white), then **slices 5–13 (~2,400px, y≈1,490–4,172) render as 100% flat `#eeffff` mint with zero white, zero text, zero image pixels** — the Features, Coverage, and Contact sections are simply absent. The dark capture shows the identical collapse (slices 2–4: 93–100% flat `#001122`). Root cause is code-confirmed, not speculative: `features?.length > 0 &&`, `coverage?.length > 0 &&`, `info &&` guards (`AboutPage.jsx` 1007, 1051, 941) silently drop the entire middle of the page when the Supabase content tables are empty in production. The footer (slice 15: 96% black) then reads as the page ending two screens early. **Verdict: world-class intent, broken deployment.** The map craft and typographic ambition deserve 9+; what actually ships to users is a hero, one paragraph, and a void — the single highest-priority visual fix in this whole audit, and it is a data-seeding fix, not a CSS fix.

**Calibration note:** the two vision-judged scores (8.5, 8) anchor the scale; the three measured scores were written to sit honestly on that same scale, with about-light punished exactly as a vision model would punish a page whose middle is empty.

### 3.7 Bespoke craft: the About page map
`AboutPage.jsx`'s 1,553 lines are a hand-drawn SVG Philippine archipelago — topographic contour patterns, ocean wave texture, graticule with coordinates, compass rose, dynamic Bohol↔coverage shipping routes with bezier arcs and computed arrowheads, city labels. Paired with a keyboard-navigable lightbox (arrows/Escape, `FocusTrap`, ref-counted scroll lock). This is the opposite of template-feel; it is also (legitimately) hardcoded-hex SVG artwork outside the token system.

---

## 4. What is NOT world-class (all counts verified against current code)

### 4.1 Data-table accessibility — the highest-severity item
- **`scope="col"`: 0 of 139 `<th>` cells** across 34 tables. Screen readers announce raw cell values with no column context on every admin list surface.
- Table captions present in only 7 files (admin Orders does have an sr-only caption; most others don't).
- Concentration: `DashboardPage`, `TripDetailPage`, `ReportsPage`, `ServiceReportsPage`, admin `ProfilePage`, `CustomerDetailPage` have **zero aria attributes** of any kind *and* unlabeled tables.
- Fix effort: small (add `scope="col"` + sr-only captions). User impact: real (VoiceOver/NVDA users).

### 4.2 Token discipline
- **742 inline `style={{}}` instances** across the JSX (up from the 732 the internal debt doc recorded). Hotspots: `AboutPage` 110, admin `OrderDetailPage` 55, customer `OrderDetailPage` 41, `CompanyInformationPage` 38 (+tabs 30/25), `ReportsPage` 23, `FeedbackPage` 18.
- **281 hardcoded hex values in CSS outside `tokens.css`** (the internal doc counted 374 across a wider net).
- Nuance found during the audit: many inline styles *reference tokens inside themselves* (`style={{ color: 'var(--warning-text)' }}`) — so the failure mode is placement/maintainability, not mostly-broken theming (which §3.5's measurements confirm).

### 4.3 CSS architecture — the biggest structural gap
- 17,234 lines across 25 files, organized as **six stacked override layers**: `responsive.css` → `premium-refresh.css` → `customer-mobile-refresh.css` → `admin-modern-refresh.css` → `viewport-hardening.css` → `mobile-density.css`, with `mobile-density.css`'s header comment admitting it "MUST stay last … to outrank the refresh files above."
- `remaining.css`: 3,512 lines, name says it all.
- Login split-screen styles live in `tabs-steps.css` (organizational drift).
- Table-to-card breakpoints conflict: 900px (`remaining.css`) vs 980px (`customer-mobile-refresh.css`) vs 768px (admin refresh) — hybrid-layout risk in the 769–980px band.
- Brittle selectors coupling CSS to JSX inline styles: `.app-layout .card:has(> button[style*="flexShrink"])`.
- `!important` count is only ~84 across 17k lines (low, all things considered) — but the stacking that makes them occasionally necessary is the debt.

### 4.4 Date/timezone inconsistency (found during audit)
The app pins date rendering to Asia/Manila (`formatPhDate`) in most surfaces — with in-code rationale — but at least three surfaces still use device-timezone `'en-US'` formatting:
- admin `OrderDetailPage.jsx` `safeFormatDate`/`safeFormatTime`/`safeFormatDateTime`
- `TrackingTimeline.jsx` `formatStepTime`
- admin `OrdersPage.jsx` row date (`toLocaleDateString()`), `HomePage` announcement dates
An evening PH departure can render on the wrong calendar day for an overseas viewer.

### 4.5 Small consistency defects (individually minor, collectively the difference from "world-class")- Off-token inline radii (`borderRadius: 10` where tokens are 8/12).
- Fully-styled inline announcement badges in `HomePage` (fontSize/letterSpacing/transition in JSX).
- Dead code: `showsWeightWarning = false` in admin OrderDetailPage; `visibleAnnouncements = announcements` no-op alias in HomePage.
- Off-token scrim: `.onboarding-overlay` uses `rgba(0,0,0,0.65)` (neutral black) instead of the tokenized bluish `--backdrop-bg: rgba(15,23,42,0.65)` — measured in pixels first, then located at `remaining.css:1871`.
- Bottom-nav labels ~10.6–11.2px (0.66–0.7rem cascade) — borderline against the 11px iOS-HIG minimum. (The internal debt doc's "9px" was already fixed by `viewport-hardening.css`.)
- Hidden file inputs in photo modals lack labels — acceptable pattern (triggered by visible labeled buttons) but a lint blind spot.

### 4.6 Page-size monoliths
Eight pages exceed 600 lines (`AboutPage` 1,553 — now larger than when the internal debt doc flagged it at 1,448; admin `OrderDetailPage` 1,354; `InboxPage` 1,123; `RegisterPage` 987; `BookShipmentPage` 899; customer `OrderDetailPage` 864; `SupportChatPage` 811).

### 4.7 Test-suite / capture gaps
- The e2e *journey* specs correctly dismiss overlays (`dismissOverlays`, `suppressOnboarding`), but the **screenshot-capture run did not** — invalidating the desktop-customer capture set (§2). Add overlay dismissal to the capture script and re-shoot.

### 4.8 The About page collapse — the only *visual* defect found in the pass
Pixel forensics on the full-page `about-light.png` capture (1440×4775) show the page shipping as **hero (dark-navy SVG map) → one white story section → ~2,400px of flat mint → black footer**. Features, Coverage, and Contact render nothing in production. The same collapse reproduces in dark mode (`about-dark.png`). Code-confirmed cause: every mid-page section is wrapped in a truthy-content guard (`features?.length > 0 &&` at `AboutPage.jsx:1007`, `coverage?.length > 0 &&` at :1051) so empty Supabase content tables drop the whole middle of the page silently — no fallback, no empty-state, no error. This is the highest-priority *visual* fix in the audit and it is a content/data-seeding fix, not a styling fix.

---

## 5. Correcting the record (claims that did NOT hold)

Honesty requires listing what the internal `WHY_FIX_TECHNICAL_DEBT.md` got stale or wrong, and what I initially reported that needed refinement:
- **"9px bottom-nav labels"** — already fixed; now 10.6–11.2px (still borderline).
- **Login-CSS duplication between `tabs-steps.css` and `layout-customer.css`** — did not reproduce; appears cleaned up.
- **My initial caption framing** — 7 of 34 *tables* is the file-level count; admin Orders does carry an sr-only caption. The `scope="col"` 0/139 finding stands unchanged.
- **"Hardcoded hex risks breaking dark mode"** — measured: it has **not** broken any captured dark screen. The debt is real (rebrand/maintenance cost) but the user-facing symptom is currently absent.

---

## 6. Prioritized recommendations

1. **Tables (high impact, small effort):** add `scope="col"` to all 139 `<th>`; add sr-only `<caption>` to the remaining tables. Enforce in `axe-lint.mjs` so it can't regress.
2. **Fix the capture script** (dismiss onboarding/overlays) and re-shoot the desktop customer set; align `.onboarding-overlay` to `--backdrop-bg`.
3. **Unify date rendering** on `formatPhDate`/`formatPhDateTime` in the three drifting surfaces; consider an `axe-lint`-style check that greps for raw `toLocaleDate*` in JSX.
4. **Token migration:** move the 281 hex values into `tokens.css`; replace high-traffic inline styles (OrderDetail pages, CompanyInfo) with classes. AboutPage's SVG artwork may stay hardcoded by deliberate exception.
5. **CSS consolidation:** fold the six override layers into the component files they override; delete `remaining.css` by distributing its contents; unify the table-to-card breakpoint.
6. **Component extraction** for the 600+ line pages, starting with admin `OrderDetailPage`.
7. **Seed the About-page content tables (new, highest-priority visual fix):** `features`, `coverage`, and company `info` are empty in the deployed DB, silently collapsing the middle of the marketing page (§4.8). Seed the rows, then add an explicit empty-state or fallback for each guarded section so an empty table can never produce a blank page again.
8. **Finish the aesthetic pass on the remaining unjudged captures:** when a vision quota is available, run the clean captures (mobile customer set, responsive set, admin set) through per-screen design review — that is the only unmeasured layer left.

---

## 7. Final statement

This is a **top-decile small-team product with real product-company instincts**. The behavior of the frontend — flows, states, errors, resilience, accessibility engineering — is world-class. The claim of world-class *in all areas* currently fails on: data-table accessibility (measured), token enforcement (measured), CSS architecture (structural), date-rendering consistency (located), and — newly surfaced by the completed visual pass — the deployed About page shipping with its middle sections collapsed (data, not design). All five are fixable without redesign; none is cosmetic. The team's own debt document is substantially accurate and its existence is itself a maturity marker most codebases lack.

*Audit tooling left in repo:* `.audit-png-stats.mjs`, `.audit-region-analysis.mjs`, `.audit-bands.mjs` — run any with `node <file> <png paths>` to re-run the theme-regression and layout-banding measurements behind §3.5/§3.6. Delete if unwanted.
