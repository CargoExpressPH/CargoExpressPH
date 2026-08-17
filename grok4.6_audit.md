# CargoExpress PH — Frontend design verdict

**Auditor:** Grok 4.6  
**Date:** 2026-08-17  
**Scope:** Entire frontend surface — UI, UX, visual style, layouts, tokens, public / auth / customer / admin, light and dark, desktop and phone.

**No. It is not world-class in every area.**  
It is a **strong, above-average custom product** for a regional cargo operator. The best rooms (admin desktop, auth, dark mode, tokens) would sit comfortably next to a mid-market SaaS. The weakest rooms (public marketing, phone admin, first-run customer UX, information density) would not survive a Linear / Stripe / Lalamove design review.

**Overall: 6.9 / 10**

That is a compliment relative to most SME logistics sites in the Philippines. It is not a claim that the whole surface is finished.

I did not click through a live authenticated session in a browser this pass. The verdict is grounded in the full screenshot set (light/dark, desktop/mobile), the source of every major page and layout, and the CSS token/override stack. Where a screenshot was blocked (onboarding) or mislabeled, I say so. No subagents were used.

---

## How to read this

“World-class” here means: one visual language, designed for the device it is on (not just stacked), empty states that still look like a product, type and space that never fight the content, and no first-run or marketing surface that looks abandoned. Standard means: consistent, usable, professional, shippable.

This system is **standard-plus**. It is not world-class across the board.

| Area | Score | Verdict |
|---|---:|---|
| Design system / tokens | 7.6 | Real system. Patch layers undermine it. |
| Visual craft (desktop admin) | 7.8 | Best surface in the product. |
| Visual craft (customer app) | 7.0 | Clean cards. First run is blocked. |
| Public / brand / marketing | 4.8 | Weakest surface. Looks unfinished. |
| Auth | 8.2 | Closest thing to world-class. |
| Dark mode | 8.0 | Rarely this complete at this scale. |
| Mobile | 5.6 | Adapted, not designed. |
| Information design | 6.0 | Data is shown; it is not edited. |
| Motion / first-run | 6.2 | Booking success is good. Onboarding is not. |
| Forms | 7.4 | Solid. A few odd required fields. |
| Accessibility intent | 7.2 | Serious tokens and focus work. Not fully proven live. |
| Consistency | 6.0 | Same product, several dialects. |

---

## Method

What was actually inspected:

- Design tokens and the full CSS import stack (`tokens.css`, `base.css`, `main.css`, `premium-refresh.css`, `customer-mobile-refresh.css`, `admin-modern-refresh.css`, `viewport-hardening.css`, `mobile-density.css`, `about-page.css`)
- Layouts: `AdminLayout`, `CustomerLayout`, `Sidebar`
- Pages across public (About, Tracking, 404), auth (Login, Register, Forgot Password), customer (Home, Book, Orders, Order Detail, Trips, Support, Profile, Personal Info, Help, Payments, Notifications, About & Version), and admin (Dashboard, Bookings, Order Detail, Trips, Trip Create, Trip Detail, Customers, Customer Detail, Sales, Reports, Inbox, Inquiries, Announcements, Feedback, Activity Logs, Company Information, Profile, Change Password)
- Shared components: `OnboardingModal`, `EmptyState`, `StatusBadge` usage, booking success, About map/hero
- Screenshot set in `e2e-audit-screenshots/` (light + dark, desktop + mobile) and `ui-audit-shots/`
- Prior code-only write-up in `ui-ux-audit.md` — used as contrast, not as authority

What was **not** claimed:

- Live click-through of an authenticated session in a browser this pass
- Customer phone Home / Book — the files named `cust-home-light.png` and `cust-book-light.png` are the **admin** dashboard. Those screens were not scored.
- Motion quality beyond what source and still frames can prove

---

## What is actually strong

These are real, not polite.

### 1. Auth is the most finished room

Login, register, and forgot-password are a proper split brand + form. Hierarchy is clear. Inputs have icons, a password reveal, a live strength checklist, and a two-step register with a visible stepper. Dark login is not a tinted afterthought. This is the one surface that belongs in a case study without apology.

### 2. Admin desktop has a product language

White sidebar, mint active pill, soft page headers, status pills, calm tables. Dashboard, Bookings, Trips, Customers, Sales, Reports, Trip create, Order detail, Inquiries — they feel like one app. Dark admin holds contrast and does not turn into grey mush. That is harder than it looks, and it was done.

### 3. The token file is adult work

Semantic fills vs decorative greens, WCAG-aware text tokens, status badge pairs, fluid type, z-index scale, `prefers-contrast`, reduced glass on phones, a full dark override. Most custom apps never get this far. The comment at the top of `tokens.css` calling it “WORLD-CLASS” is marketing. The *structure* of the file is professional.

### 4. Empty states exist and they are designed

Inbox (“No Conversation Selected”), trip capacity (“No active trip”), tracking idle, 404 (“package got lost in transit”). The 404 is one of the few brand moments that feels written, not generated.

### 5. Customer settings and Help are coherent

Profile is an iOS-style grouped list. Help is a 2×2 guideline grid plus searchable FAQs. Personal-info fields are labelled, iconned, and spaced. That is standard product design, done properly.

### 6. Booking success was designed, not dumped

Ticket card, perforation, copy-to-clipboard, particle burst with `useReducedMotion`. That is the only motion in the app that feels like a moment instead of decoration.

### 7. Operational detail on desktop is honest

Admin order detail puts timeline, parties, trip, weight, proofs, settlement chips, ledger, and activity in a readable stack. For a two-person ops team, that is the right information architecture.

---

## What is not world-class — and is visible

### 1. The public About page is the worst first impression

Both light and dark full-page captures are the same: a short hero, then a huge empty band, then a footer.

Why:

- Hero is `min-height: 100vh` on small screens. First paint is a slogan and two buttons. No cargo, no route, no proof.
- Story / features / reviews / contact start at `opacity: 0` and wait for `whileInView`. Until they intersect the viewport they are invisible. A tall capture, print, or a flaky IntersectionObserver looks like a blank site.
- Features, Coverage, and Gallery **do not render** when CMS data is empty. The nav still offers “Features / Coverage / Gallery”. Those are dead jumps.
- Company Introduction in admin is still the placeholder. Banner image is empty. The page then falls back to a stock Unsplash warehouse and generic copy.
- Footer says `CargoExpress PH`. Wordmark says `CARGO EXPRESS PH`. CMS name is `CargoExpress PH`. Three spellings of one brand.

A world-class marketing page is a designed object even with empty CMS. This one is a CMS shell that collapses.

### 2. Mobile is a desktop layout that learned to stack

Evidence from the phone shots:

- Admin wordmark clips to **“CARGO EXPRESS F”**. The brand mark is broken on the device customers and admins actually use.
- Bookings on a phone is a stacked key/value list: TRACKING, CUSTOMER, ROUTE, WEIGHT, COST, STATUS, DATE — repeated for every row. Technically responsive. Visually a receipt printer. World-class mobile ops (Lalamove driver, Ninja Van) would be a card: tracking, route, one status, one amount.
- Admin order detail on iPhone is a vertical wall. Timeline labels collide. Payment history of many ₱1 test rows becomes an endless stacked form. The desktop ledger is fine. The phone version was not designed.
- Public tracking input clips the example: `CE-202401(`. Placeholder overflow on a primary public field.
- Mobile About is a compressed hero chip over the same void.

`mobile-density.css` exists because earlier mobile rules **lost the specificity war** to later “refresh” files. That comment in the file is the most honest design document in the repo: the system is being patched from the outside because the cascade no longer has a single owner.

### 3. First-run customer UX fights the product

Almost every customer e2e shot is the same modal: “Welcome to Cargo Express PH” over a blurred page.

That is a finding, not a capture accident:

- It fires on a timer (`800ms`) from `localStorage`, on every first device, on **every** customer route — Home, Book, Orders, Support, Payments, Profile, Help.
- On Support, the composer stays visible under the overlay. The modal does not own the screen.
- On Help, page content punches through the dimmer. Z-index is wrong.
- Four generic slides. No spotlight on the actual Book / Track controls. This is a template tour, not a product tour.

A world-class first run is either invisible (empty home with one CTA) or a single contextual coach mark. This is a gate.

### 4. Information design is unfinished

- Dashboard donut: **Other Orders 10 (77%)**. Most of the chart is a junk bucket. That is not a chart. It is a confession that the breakdown was not designed.
- Sales “Monthly Revenue” with one August bar. A single bar on a full card looks empty, not live.
- Admin order payment history can be a ledger of ₱1 GCash rows. The table does not collapse, group, or summarize. Desktop already feels long; phone is unusable.
- Activity Logs is a login dump. Authentication events drown the operational ones. No grouping, no “hide sign-ins” default.
- Dates mix `8/16/2026`, `Aug 16, 2026`, and `Aug 8, 2026` on adjacent screens.
- Dashboard “Pending = 0” while the table is full of Assigned / Out for Delivery. The KPI does not match what an operator cares about today.

World-class ops UI edits data before it draws it. This UI draws what the query returned.

### 5. Admin Profile is a leftover, not a page

`maxWidth: 520` on a wide admin canvas. A green banner, an initial, two rows, Sign Out. The rest of the viewport is unused. Next to Bookings and Sales it looks like a mobile settings sheet that was never given a desktop layout.

### 6. The visual language is a well-executed 2023 SaaS kit

Mint cards, 16–20px radius, soft shadow, Inter, green pills, Lucide, glass nav, orbs, “premium” in class names (`empty-state-premium`, `profile-card-premium`, `premium-refresh.css`). That kit is competent. It is also generic.

There is almost no photography of the actual service, no custom illustration, no distinctive type pairing, no cargo-specific visual metaphor except a box icon. Auth and 404 have more character than the logged-in app. A world-class brand would be recognizable in grayscale. In grayscale this could be any green fintech or logistics dashboard from a UI kit.

### 7. CSS is a palimpsest, not a system

`main.css` imports tokens → base → components → layouts → pages → animations → responsive → **premium-refresh → customer-mobile-refresh → admin-modern-refresh → viewport-hardening → mobile-density**.

Five “final” layers. Primary buttons are re-hardened to `#166534` in `premium-refresh.css` instead of using `--primary-fill`. About is full of inline `style={{}}`. `mobile-density.css` documents that three earlier mobile rules never reached the phone.

A world-class frontend has one cascade. This has a history of rescues.

### 8. Small brand and UX cuts that add up

- Facebook name is **required** on register and on booking sender/receiver. For a cargo booking that is an unusual tax. It needs a reason on the label, or it should be optional.
- Customer nav: desktop is Place Order / Orders / Trips / Chat. Phone bottom bar is Home / Orders / Book / Trips / Profile. Chat disappears from the thumb bar. Support is a primary job; burying it is a product decision that should be visible.
- Register still asks for Facebook display name as if it were identity.
- Tracking format in the placeholder (`CE-20240101-001`) does not match the real `CE-YYYYMMDD-NNNN` examples on the same page’s help card.
- “Go Back to Login” on the About nav is staff language, not visitor language.
- Inbox empty pane is fine; the conversation list showing a spinner with no rows is a half-state that should resolve to “queue is clear” (the “All caught up” line is already there — the spinner fights it).

---

## Surface-by-surface

### Public

| Screen | Honest read |
|---|---|
| Login / Register / Forgot | A- |
| Tracking idle | B+ (placeholder overflow on phone) |
| 404 | A- |
| About | D+ as a first impression; C if the user scrolls and CMS is filled |

### Customer

| Screen | Honest read |
|---|---|
| Home (below the modal) | B — greeting, snapshot pills, shipment cards, announcements |
| Orders / Trips (glimpsed) | B — card list, capacity chips |
| Order detail (payment block) | B — clear money strip; ₱0-vs-unpriced is handled in logic, less so in type |
| Book | B+ in code (wizard, draft, blocker); not visually verified without the modal |
| Support | B- — composer leaks under the tour |
| Profile / Personal info / Help | B+ |
| Payments / Notifications / Track-in-app | Not reliably visible (modal) |

### Admin

| Screen | Honest read |
|---|---|
| Dashboard desktop | B+ |
| Bookings table | A- |
| Order detail desktop | B+ (ledger can explode) |
| Trips list / create / detail | B+ / A- / B+ |
| Customers / Customer detail | B / B- (hero banner is decorative, not useful) |
| Sales / Reports | B — pretty, sparse charts, one-bar months |
| Inbox | B (empty). Conversation-with-thread not in these shots. |
| Announcements / Feedback / Inquiries | B / B / B |
| Activity Logs | C+ — audit dump |
| Company Information | B — long CMS form, empty banner |
| Profile | C — leftover sheet |
| Change password | B+ |

### Phone

| Screen | Honest read |
|---|---|
| Admin dashboard stack | B- — readable, logo broken |
| Admin bookings stack | C |
| Admin order | D |
| Public track | C+ |
| Public about | D |
| Customer phone home/book | **Not verified.** Files named `cust-home` / `cust-book` are the **admin** dashboard. Those screens were not scored. |

---

## Direct answers

**Is it standard?**  
Yes. Above the standard of a typical commissioned SME web app. Tables, dark mode, PWA, tokens, empty states, form validation, and a consistent admin shell are all present. A competent product designer would recognize the craft.

**Is it world-class in all areas?**  
No.

World-class would not:

- ship a marketing page that can render as hero + void + footer
- clip the company name on a phone
- block every customer screen with a four-step welcome
- stack a 12-column ops table into a phone scroll and call it responsive
- put 77% of a donut in “Other”
- need five CSS “final” layers to make type fit a 390px screen
- leave the admin profile as a 520px card on a 1280px canvas

**What is it, then?**  
A well-built **ops console** with a **polished auth gate** and a **thin public face**. The interior (admin desktop) is the product. The exterior (About, first-run, phone) is still the student project that the interior grew out of.

If you compare it to:

- a typical WordPress cargo site → far ahead
- a good mid-market SaaS (Linear-adjacent admin, Stripe-adjacent forms) → in the building, not on the top floor
- Lalamove / J&T / Ninja Van consumer app → not in that league on mobile
- a world-class brand site → About is not in the conversation

---

## If you only fix five things

1. **About:** stop hiding primary content at `opacity: 0`. Always render Story + Contact. Hide nav items that have no section. Fill or design the empty CMS state. Kill the 100vh hero on phones.
2. **Phone header:** never clip the wordmark. Icon-only or stacked lockup under 400px.
3. **Onboarding:** once, on Home only, or delete it. Fix the z-index leak. Do not cover Book or Chat.
4. **Phone lists:** design order/booking **cards**. Stop stacking every table column.
5. **Charts and ledgers:** never draw “Other 77%”. Summarize payment noise. Give Activity Logs a default that is not “every login.”

None of that requires a new brand. It requires treating the weak rooms with the same seriousness already given to login and the bookings table.

---

## What this audit will not claim

- Motion is not “best-in-class.” There is one good success animation and a lot of fade-up boilerplate.
- Customer phone home/book is not scored. Those audit files are the wrong screen.
- The earlier 8.0 / mobile-9.0 write-up in `ui-ux-audit.md` is not repeated. That audit was code-only. The pictures disagree.
- The product does not look cheap. It looks like a careful team that polished the rooms they live in and has not yet designed the rooms a stranger walks into.

---

## Bottom line

Shippable, professional, better than standard for this business. **Not world-class in all areas.** The gap is not taste — it is unfinished surfaces, phone-as-afterthought, and a public page that does not yet deserve the interior.

---

## Continuation — remaining surfaces and evidence

This section was added after the first write-up. Scores above do not change. The extra passes confirm them.

### More screens judged

| Screen | Theme | Honest read |
|---|---|---|
| Register dark | Dark | A- — same craft as light. Strength chips and stepper hold contrast. Facebook still required. |
| Bookings dark | Dark | A- — the strongest dark table in the product. Status pills stay readable. |
| Admin Profile dark | Dark | C — same leftover 520px sheet. Mint banner is louder than the page needs. |
| Change Email (admin) | Light | B+ — clear labels, current email shown, password confirm, helper copy. Narrow card on a wide canvas, same leftover as Profile. |
| Change Password (admin) | Light | B+ — same family as Change Email. |
| Change Password (customer) | Light | Not scored visually — onboarding modal owns the frame. Source matches the admin form. |
| Booking wizard | Source | B+ — five steps (Route → Sender → Receiver → Package → Review), `aria-current`, live region, draft in `sessionStorage`, unsaved `useBlocker`, “use my registered address”, trip preview with rate and remaining kg. This is the customer flow that most deserves the polish auth already has. The e2e shot never shows it because the tour covers it. |
| Sales & Reports shell | Source + Sales/Reports shots | B — four tabs in the URL (`?tab=`), which is the correct IA. Only Sales Overview and Reports & Analytics were captured. Unsettled Deliveries and Customer Service were not in the screenshot set. |
| Customer bottom nav | Source | B- — Home / Orders / Book / Trips / Profile. Chat is missing from the thumb bar while it is a primary desktop item. Book is correctly emphasized. |

### Wordmark clip — confirmed in code

`BrandWordmark` is `white-space: nowrap` on purpose (`BrandLogo.jsx`). The comment says the HTML text *is* the legible name because the badge artwork is unreadable at 40px. On the phone admin topbar the nowrap string `CARGO EXPRESS PH` is wider than the slot next to the hamburger, theme, search, and bell. The capture shows **CARGO EXPRESS F**. The system chose crisp type over a flexible lockup, then never gave the phone a shorter lockup. That is a design miss, not a screenshot glitch.

### About empty band — two stacked causes

1. Hero is `min-height: 100vh` below 900px (`about-page.css`). First paint is slogan-only.
2. Below-fold sections use Framer `initial={{ opacity: 0 }}` + `whileInView`. Full-page captures, print, and a late IntersectionObserver all look like a blank site.
3. Features / Coverage / Gallery unmount when CMS arrays are empty. `SECTIONS` in `AboutPage.jsx` still lists them. Nav clicks jump to nothing.

Company Information in admin shows an empty introduction and an empty banner. The public page is only as good as that CMS row, and the CMS row in the captured environment is unfinished.

### Onboarding — confirmed in code

`OnboardingModal.jsx`:

- Key: `cargoexpress_onboarding_done`
- Delay: 800ms
- Mounted from `CustomerLayout`, so it covers every customer route
- Four generic slides, no target highlighting
- Support composer and Help cards render through / around the overlay in the captures

### Booking is better than the screenshots imply

The wizard in `BookShipmentPage.jsx` is one of the few customer surfaces that was designed as a flow, not a form dump:

- Step list is a semantic `role="list"` with `aria-current="step"`
- Coverage rules appear only after a route is chosen
- Trip is optional; preview shows departure, ₱/kg, remaining kg
- Address fields are required for a reason (door-to-door). Facebook-as-required is the one field that still feels like an internal habit, not a customer need
- Success is a ticket, not a toast

I still will not give Book a visual grade for the first paint a new user sees, because that paint is the tour.

### Dark mode holds up on the second pass

Register dark, Bookings dark, Inbox dark, Dashboard dark, Profile dark — one palette, one sidebar, one table header tint. This is the dimension closest to world-class. The failures in dark are the same structural failures as light (empty About, leftover Profile, onboarding), not theme bugs.

---

## Prioritized punch list (files)

Ordered by how much they move a stranger’s first impression, then an operator on a phone.

| Pri | Problem | Where |
|---:|---|---|
| P0 | About first paint is a void; nav points at missing sections | `src/pages/public/AboutPage.jsx`, `src/styles/about-page.css` |
| P0 | Wordmark clips on phone admin chrome | `src/components/ui/BrandLogo.jsx`, admin topbar CSS in `layout-admin.css` / `viewport-hardening.css` |
| P0 | Onboarding gates every customer route; z-index leaks | `src/components/ui/OnboardingModal.jsx`, `src/components/layout/CustomerLayout.jsx` |
| P1 | Phone bookings/orders are stacked tables | `src/styles/data.css`, `src/styles/responsive.css`, `src/pages/admin/OrdersPage.jsx` |
| P1 | Phone order detail is an unreadable wall | `src/pages/admin/OrderDetailPage.jsx`, `src/components/ui/TrackingTimeline.jsx` |
| P1 | Donut dumps 77% into “Other” | `src/pages/admin/DashboardPage.jsx`, `src/components/ui/DonutChart.jsx` |
| P1 | Tracking placeholder overflows on phone | `src/pages/public/TrackingPage.jsx` |
| P2 | Admin Profile / Change Email are 520px leftovers | `src/pages/admin/ProfilePage.jsx`, `src/pages/shared/ChangeEmailPage.jsx` |
| P2 | Activity Logs default is every login | `src/pages/admin/ActivityLogsPage.jsx` |
| P2 | Payment ledger does not summarize noise | admin + customer `OrderDetailPage.jsx` |
| P2 | Five CSS “final” layers | `src/styles/main.css` and the five files it imports last |
| P2 | Chat missing from customer thumb bar | `src/components/layout/CustomerLayout.jsx` (`bottomNavItems`) |
| P3 | Facebook name required with no reason | `src/pages/auth/RegisterPage.jsx`, `BookShipmentPage.jsx` |
| P3 | Brand spelling: Cargo Express PH / CargoExpress PH / CARGO EXPRESS PH | About footer, wordmark, CMS name |
| P3 | Date format mix (`8/16/2026` vs `Aug 16, 2026`) | various list pages vs `formatPhDate` |
| P3 | “Go Back to Login” on a public marketing nav | `AboutPage.jsx` |
| P3 | Tracking example format disagrees with the help card | `TrackingPage.jsx` |

---

## Why this disagrees with `ui-ux-audit.md` (8.0 / mobile 9.0)

That earlier document is a **code-intent** audit. It scored skeletons, `data-label` table transforms, focus traps, and PWA completeness. Those things exist. They are not the same as how the product looks and feels on a screen.

| Claim in the 8.0 audit | What the pictures show |
|---|---|
| Mobile 9.0 | Logo clipped. Tables stacked into receipts. Order detail unusable. About hero collapsed. |
| Visual 8.5 | Admin desktop yes. Public About no. Profile leftover. Generic kit. |
| Interaction 9.0 | Booking success is good. Onboarding is a gate. About hides its own content. |
| Overall 8.0 | 6.9 when you judge the rooms a stranger and a phone user actually get |

Code that *can* be accessible and responsive is not the same as a designed phone product. This audit scores the latter.

---

## Evidence index

### Screenshots used

- `e2e-audit-screenshots/public/` — login, register, forgot-password, about, track, 404 (light + dark where present)
- `e2e-audit-screenshots/customer/` — home, book, orders, order-detail, support, trips, profile, personal-info, help, notifications, payments, about-version, change-password, track (almost all first-paint blocked by onboarding)
- `e2e-audit-screenshots/admin/` — dashboard, orders, order-detail, trips, trip-create, trip-detail, customers, customer-detail, sales, reports, inbox, contact-inquiries, announcements, feedback, activity-logs, company-info, profile, change-password, change-email (light + dark)
- `e2e-audit-screenshots/mobile/` — admin-dashboard, admin-orders, pub-about, pub-track; files named `cust-home` / `cust-book` are **admin dashboard** and were discarded
- `ui-audit-shots/` — admin order across 360–1280; customer-order shots are the 404 page and were discarded

### Source used

- `src/styles/tokens.css`, `base.css`, `main.css`, `premium-refresh.css`, `mobile-density.css`, `about-page.css`, `layout-customer.css`
- `src/pages/public/AboutPage.jsx`, `TrackingPage.jsx`
- `src/pages/customer/HomePage.jsx`, `BookShipmentPage.jsx`
- `src/pages/admin/ProfilePage.jsx`, `SalesReportsPage.jsx`
- `src/components/layout/CustomerLayout.jsx`, `Sidebar.jsx`
- `src/components/ui/OnboardingModal.jsx`, `EmptyState.jsx`, `BrandLogo.jsx`
- `public/manifest.json`

### Not in the screenshot set (source only, no visual grade)

- Unsettled Deliveries tab
- Customer Service reports tab
- Inbox with an open thread
- Booking steps 2–5 and the success ticket on a real viewport
- Pickup / Delivery / Payment collection modals in use
- Command palette open
- Customer phone Home / Book / Orders (no trustworthy capture)
- Reset-password after the email link
- Print / PDF report output

---

## What “done” would look like

The product does not need a redesign. It needs the weak rooms brought up to the standard of Login and Bookings.

When this is world-class enough to claim it:

- A first-time visitor on `/about` sees story, coverage, and a contact form without scrolling into empty air
- A phone admin sees the full name of the company and a booking **card**, not a clipped lockup and a stacked spreadsheet
- A first-time customer lands on Home, not a four-step lecture
- Charts never contain a slice called Other that is most of the data
- One CSS cascade, not five files named “final”

Until then the honest label is: **standard-plus ops product, polished gate, unfinished public and phone face.**

---

## Continuation 2 — components, money, and rooms with no screenshot

Scores above do not change. This pass is the interior of the interior: counters, badges, timelines, reports that were never captured, and the words the codebase uses about itself.

### Sales dark: the most important number first-paints as ₱0

`e2e-audit-screenshots/admin/sales-dark.png` shows **Total Revenue as ₱0** while the Payment Methods donut on the same frame reads **₱48k collected**. Light sales on the same dataset showed ₱47,687.

Cause is in `AnimatedCounter.jsx`: display state starts at `0`, then eases to the target over **1000ms**. `SalesPage.jsx` always renders the four tiles; a missing figure is defined as 0 on purpose (so Outstanding never vanishes). Combined, the first second of the most important money page in the business is a lie.

World-class money UI either:

- holds the skeleton until the number is known, then paints the real figure, or
- animates from the last known value, never from zero on first load.

A ₱0 flash next to a ₱48k donut is not a theme bug. It is a first-paint bug on the headline.

The Monthly Revenue card in that same dark frame is worse than the light one: a hairline green mark labeled “Aug” on an empty grid. A single data point does not earn a full chart card. It earns a sentence.

### Order detail dark — the high-water mark, restated

`admin/order-detail-dark.png` is the best dark operational screen in the set. Timeline, parties, trip, weight, one proof thumbnail, settlement chips, a short ledger, activity. Contrast holds. The green “Advance to Delivered” is the only primary action and it is obvious.

That is the standard the phone order, the About page, and the admin Profile should have been held to. They were not.

### Unsettled Deliveries — source only, no visual grade

`UnsettledDeliveriesPage.jsx` is one of the few screens whose **information architecture is better than its absence from the screenshot set**.

Buckets are named in operator language, not schema language:

| Bucket | Tone | What it means |
|---|---|---|
| Overdue promise | error | Promise date passed, still owing |
| Held at hub | warning | Warehouse hold until paid or promised |
| Delivered, unpaid | error | Handed over, balance open |
| Promised | info | Dispatched against a future date |
| Freight collect | info | Due at the door — not late |
| In transit | info | Not at the dispatch gate yet |

Hints exist. Freshness (“just now” / “3m ago”) exists. Realtime refresh does not swap the table for skeletons. Print and PDF exist.

This is the kind of room that *could* be world-class if the visual pass matches the comments. I have not seen it rendered. I will not invent a letter grade.

### Customer Service reports — source only

`ServiceReportsPage.jsx` says, in the file, that it draws **no targets** because there is no real traffic to calibrate them. That sentence is more honest than most dashboards. Queue / response / bot / inquiry / hourly peak are the right questions. Without a capture I will not score the layout. I will say this: a service report that refuses fake goals is already ahead of a service report that invents a 95% SLA.

### Command palette — a jump list, not a command line

`CommandPalette.jsx` is Ctrl+K to twelve admin routes, grouped Navigation / Management / System, with a focus trap and arrow keys. That is standard SaaS chrome.

It is not a command palette in the Linear sense. You cannot “advance order”, “weigh pickup”, or “message Bea”. You can only go to a page.

One label slip: the palette says **Orders**. The sidebar says **Bookings**. Same route. Two names.

### Status badges are one of the few shared atoms that work

`StatusBadge.jsx` maps every order and trip status onto a tokenized pill, with an `aria-label`, and a pulsing dot only on live states (In Transit, Out for Delivery, in_progress). Pending Cancellation is a warning, not a fake step in the cargo path. That matches the domain rule in `Claude.md`.

This is what a design system is for. Most of the app still bypasses it with one-off chips.

### The timeline is semantically correct and typographically mixed

`TrackingTimeline.jsx` is an `<ol>` with `aria-current="step"`. That is the right element. Icons change with the step. On desktop admin order detail it reads.

Two cuts:

- Timestamps format with **`en-US`** (`Jul 19 · 2:30 PM`). Adjacent money and lists use **`en-PH`**. Inbox times use `toLocaleTimeString([])` — whatever the device is. Three clocks.
- On the iPhone admin order capture the same component becomes a cramped vertical stack. The desktop object was not redesigned for 390px. It was allowed to wrap.

### Customer Orders, in source, is already a card list

`OrdersPage.jsx` filters by **group** (`CUSTOMER_ORDER_FILTERS`), not by every internal status. Search covers tracking, sender, receiver, route. Pull-to-refresh. Skeleton cards. That is the pattern admin Bookings on a phone should have copied. Admin Bookings on a phone copied the spreadsheet instead.

I still cannot grade the painted customer Orders page. The e2e frame is the onboarding modal.

### Inbox and Support — product thinking, one empty shot

`InboxPage.jsx` comments are the best writing in the frontend. They explain why `waiting_customer` got a blue “Awaiting Reply” pill (blank looked like `bot_active`) and why `bot_active` stays unbadged. That is design. The captured Inbox is an empty split pane plus a spinner next to “All caught up” — a half-state. An open thread was never captured.

`SupportChatPage.jsx` anonymizes the admin as “Admin” on the customer side, names the bot, retries failed sends, and times out at 15s with a human error. The tour overlay and the composer fighting each other is still the first thing a new customer sees.

### Pickup modal — domain-correct, unseen

`PickupModal.jsx` hides the entire payment panel for freight collect. That is the right product decision (the payer is not in the room). Weight, photos, and `PaymentCollectionPanel` are shared with delivery. I have no screenshot of the modal open. Previous audits claimed a GCash dead-end; current source uses `payment.paymentStep` and a shared panel. I will not re-assert a bug I have not re-verified in the running UI.

### The codebase keeps calling itself world-class

This is a taste problem that becomes a quality problem. When the files name themselves, the bar in the author’s head moves, and review gets softer.

| File | What it calls itself |
|---|---|
| `tokens.css` | “WORLD-CLASS DESIGN SYSTEM” |
| `about-page.css` | “World-Class Premium Styles” |
| `ResetPasswordPage.jsx` | “World-Class Premium Redesign” |
| `AuthContext.jsx` | “world-class email update flow” |
| `base.css` | “world-class responsiveness” |
| `AnimatedCounter.jsx` | “premium feel” |
| `EmptyState.jsx` / profile cards | `*-premium` class names |

About is the weakest public page. Reset password was not in the screenshot set. The token file is good and is not a design system in the Figma/Spectrum/Polaris sense — it is a well-made `:root`. Naming the work “world-class” does not make About stop being a void.

A world-class team almost never writes that word in the CSS.

### New punch-list rows from this pass

| Pri | Problem | Where |
|---:|---|---|
| P1 | Headline money animates from 0 for 1s | `src/components/ui/AnimatedCounter.jsx`, `SalesPage.jsx` |
| P2 | Command palette says Orders; sidebar says Bookings | `CommandPalette.jsx` vs `Sidebar.jsx` |
| P2 | Timeline dates are `en-US`; money is `en-PH`; inbox is device locale | `TrackingTimeline.jsx`, list pages, `InboxPage.jsx` |
| P3 | One-bar / one-pixel monthly charts still occupy a full card | `SalesPage.jsx`, `ReportsPage.jsx` |
| P3 | Inbox list can show a spinner and “All caught up” together | `InboxPage.jsx` |
| P3 | “World-class / premium” labels in source | files in the table above |

### Source added this pass

- `src/pages/admin/UnsettledDeliveriesPage.jsx`, `ServiceReportsPage.jsx`, `SalesPage.jsx`, `InboxPage.jsx`
- `src/pages/customer/OrdersPage.jsx`, `OrderDetailPage.jsx`, `SupportChatPage.jsx`
- `src/components/ui/AnimatedCounter.jsx`, `CommandPalette.jsx`, `StatusBadge.jsx`, `TrackingTimeline.jsx`, `PickupModal.jsx`
- `src/pages/auth/ResetPasswordPage.jsx`

### Still unseen (unchanged)

Unsettled and Service tabs rendered. Inbox with a live thread. Booking steps 2–5 and the success ticket. Pickup / Delivery / additional-payment modals. Command palette open. Customer phone Home / Book / Orders. Reset-password after the email link. Print / PDF output.

The verdict is still **6.9**. The new evidence did not raise it. The ₱0 revenue flash and the “world-class” comments are why it does not go up. The unsettled-bucket IA and the dark order detail are why it does not go down.


