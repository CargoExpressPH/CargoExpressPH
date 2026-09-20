# CargoExpress PH Program Hierarchy UI Audit

**Type:** Read-only UI structure audit
**Purpose:** Revise Chapter 2 Program Hierarchy diagrams (Public / Customer / Administrator) to reflect actual visual/navigation structure, not the raw route table.
**Source code modified:** NO · **Database modified:** NO · **Chapter 2 modified:** NO · **Diagrams modified:** NO

---

## 1. Source of Truth

Every claim below is backed by a specific file. No route table was used as a stand-in for navigation — `App.jsx` was read only to confirm which paths exist and which layout wraps them; the actual *hierarchy* claims come from the navigation/menu components and the pages themselves.

| Layer | File(s) inspected |
|---|---|
| Route table (paths only, not structure) | `src/App.jsx` |
| Public chrome | `src/components/layout/PublicShell.jsx`, `src/components/layout/Footer.jsx` |
| Public pages | `src/pages/public/AboutPage.jsx` (incl. `SECTIONS` nav array, anchors), `src/pages/public/TrackingPage.jsx`, `src/pages/public/LegalPage.jsx` |
| Auth pages | `src/pages/auth/LoginPage.jsx`, `RegisterPage.jsx`, `ForgotPasswordPage.jsx` |
| Customer chrome | `src/components/layout/CustomerLayout.jsx` (`desktopNavItems`, `bottomNavItems`, profile dropdown) |
| Customer pages | `HomePage.jsx`, `BookShipmentPage.jsx` (`steps` array), `OrdersPage.jsx`, `OrderDetailPage.jsx` (cancel/feedback modals), `TripsPage.jsx`, `NotificationsPage.jsx`, `ProfilePage.jsx` (hub menu), `PersonalInfoPage.jsx`, `PaymentHistoryPage.jsx`, `SupportChatPage.jsx`, `HelpGuidelinesPage.jsx`, `AboutVersionPage.jsx` |
| Admin chrome | `src/components/layout/Sidebar.jsx` (`mainNav`, `toolsNav`, `systemNav`, profile dropdown), `AdminLayout.jsx` |
| Admin pages | `OrdersPage.jsx`, `AdminCreateBookingPage.jsx`, `TripsPage.jsx`, `CreateTripPage.jsx`, `TripDetailPage.jsx`, `CustomersPage.jsx`, `CustomerDetailPage.jsx`, `SalesReportsPage.jsx` (`SECTIONS` tabs), `AnnouncementsPage.jsx`, `InboxPage.jsx`, `ContactInquiriesPage.jsx`, `FeedbackPage.jsx`, `ActivityLogsPage.jsx` (filter bar, no date-range fields), `CompanyInformationPage.jsx` (`TABS` array), `StorageMonitoringPage.jsx` (tabs), `ProfilePage.jsx` |
| Shared pages | `ChangeEmailPage.jsx`, `ChangePasswordPage.jsx` (used by both Customer and Admin) |

No `.drawio` file or prior Program Hierarchy image was found anywhere in this repository (searched for `*.drawio`, `*chapter*2*`, `*program*hierarchy*`). Section 6/7's "Current Node" column is therefore built from the specific problem-nodes the audit brief itself named as things to verify (Trip Schedules placement, Login→Register→Password Recovery chain, Walk-in Booking, Activity Logs "To Date", Announcement Title/Content, etc.) — i.e., the baseline your thesis draft is assumed to currently show, cross-checked against what actually exists in the app.

---

## 2. Public Navigation Structure

There is **no persistent global header** shared across all public pages. Each public surface has its own minimal chrome:

- **About Page** (`/about`) — a single long scrolling page with a fixed glass nav bar whose links are **in-page anchors**, not routes: `SECTIONS = [Home, Our Story, Features, Coverage, Gallery, Reviews, Contact]` (`AboutPage.jsx:342-350`). Clicking one calls `scrollToSection(id)` — it never navigates anywhere.
- **PublicShell** (`PublicShell.jsx`) — a slim top bar (brand + Log In / Sign Up) wrapping only two guest routes: `/schedules` (reuses the customer `TripsPage` component) and `/faq` (reuses `HelpGuidelinesPage`). Deliberately not shared with About Page.
- **Footer** (`Footer.jsx`) — the one footer used on both About and PublicShell pages. Its "Company" column links to `/about`, `/about#coverage`, `/about#contact` — confirming Coverage and Contact are **About-page sections**, not standalone pages. Its bottom bar has Terms of Service and Privacy Policy as two adjacent links.
- **TrackingPage** (`/track`) — a standalone page with its own tiny header (brand logo only, no nav links). Reused (via an `embedded` prop) inside the customer app at `/customer/track`.
- **LegalPage** (`/terms`, `/privacy`) — one component renders both documents; each has a "back" link plus a cross-link to "the other" legal document, and a small footer with Terms / Privacy / Contact us (`/about#contact`) (`LegalPage.jsx:148-182`).
- **Auth pages** — `LoginPage` links to `/forgot-password`, `/register`, and (footer) `/about`, `/track`. `RegisterPage` links back to `/login` and out to `/terms`, `/privacy` for consent. `ForgotPasswordPage` links back to `/login`.

**Conclusion:** there is no single "Public top nav" — the real top-level modules are the pages a guest actually lands on and the module they belong to is defined by what wraps them (About's own scrollspy nav vs. PublicShell vs. bare page).

---

## 3. Customer Navigation Structure

`CustomerLayout.jsx` defines the *only* two real nav item lists:

```js
desktopNavItems = [Book Shipment, Bookings(/orders), Trips, Chat Support]
bottomNavItems  = [Home, Bookings, Book (center FAB), Trips, Profile]
```

- **Desktop top bar:** logo (→ Home), the 4 links above, a theme toggle, a **Notifications bell icon** (own route, no text label — a persistent utility icon, not part of `desktopNavItems`), and an **avatar dropdown** with exactly two items: "My Profile" and "Logout" (`CustomerLayout.jsx:326-337`).
- **Mobile bottom tab bar:** Home, Bookings, Book (center, elevated), Trips, Profile — Chat Support is **not** in the bottom bar; instead a floating chat bubble (FAB) is rendered on every page except the chat page itself (`CustomerLayout.jsx:407-421`).
- **Profile is a hub page** (`ProfilePage.jsx`), not just a settings form. It has three visually distinct card sections, each a menu of buttons that `navigate()` to a full page:
  - *Account & Security:* Personal Info & Addresses, Change Password, Change Email, **Payment History**
  - *Preferences:* Dark Mode, Push Notifications, Email Announcements — these are **toggles on the page itself**, not sub-pages
  - *Help & Support:* Live Support Chat (→ same `/customer/support` as the top-nav "Chat Support"), Help & Guidelines, About & Version
- **Book Shipment** (`BookShipmentPage.jsx:679`) is one route with an in-page 5-step wizard: `steps = ['Route', 'Sender', 'Receiver', 'Package', 'Review']` — confirmed exactly matches the brief's proposed child list.
- **Home/Dashboard** (`HomePage.jsx`) has an inline tracking-number search box that calls `navigate('/customer/track?q=...')` — this is how a customer actually reaches Track, not via a nav item.
- **Booking Details** (`OrderDetailPage.jsx`) has **Cancel Booking** and **Submit Feedback** as modals triggered by buttons on the page (`showCancelModal`, `showFeedbackModal`) — confirmed to be actions, not separate pages/routes.

**Duplication found:** "Chat Support" is reachable from three places (top nav, mobile FAB, Profile → Help & Support) but is one single route/page — see Section 7.

---

## 4. Administrator Navigation Structure

`Sidebar.jsx` groups the sidebar into three labeled sections (`sidebar-section-label`):

```js
mainNav   = [Dashboard, Bookings(/orders), Trips, Customers]
toolsNav  = [Sales & Reports, Announcements, Inbox, Inquiries, Customer Feedback, Activity Logs]
systemNav = [Company Information, Storage Monitoring]
```

- **Profile is not in the sidebar list at all.** It lives in a separate profile-dropdown at the bottom of the sidebar (`sidebar-profile-menu`), with exactly two items: "Profile" and "Sign Out" (`Sidebar.jsx:268-286`).
- **Sales & Reports** is genuinely one component (`SalesReportsPage.jsx`) with an in-page tab bar: `SECTIONS = [Reports & Analytics, Unsettled Deliveries, Sales Overview]` — reached via two routes (`/admin/sales`, `/admin/reports`) that only set which tab opens first; all three tabs are switchable from either entry point.
- **Company Information** has an in-page tab bar exactly as the brief proposed: `TABS = [Basic Info, Contact Info, Why Choose Us, Coverage Areas, Pricing]` (`CompanyInformationPage.jsx:22-27`).
- **Storage Monitoring** has an in-page tab bar: `[Photo Storage, Email Service]` (`StorageMonitoringPage.jsx:15-16`) — this exactly matches the brief.
- **Bookings**: List page (`OrdersPage.jsx`) has a "New Booking" button → `/admin/create-booking`, whose actual on-screen title is **"Create Booking"** ("Create a booking on behalf of a customer, e.g. via Facebook Messenger") — not literally "Walk-in Booking" (`AdminCreateBookingPage.jsx:486-491`). Plus **Booking Details** (`/admin/orders/:id`).
- **Trips**: List page has a "Create Trip" button → `/admin/trips/create`, plus **Trip Details** (`/admin/trips/:id`).
- **Customers**: List page links each row to **Customer Details** (`/admin/customers/:id`).
- **Announcements**: One page. An inline "New Announcement" panel (title/content form fields — form fields only, never separate nodes) sits above the published list; delete is a button+confirm modal on the list. Two visible sections: the create panel and the list.
- **Inbox**: One page — a conversation list next to a chat panel (split view). There is no separate "Customer Conversations" page; that *is* the Inbox.
- **Contact Inquiries**: One list page; row click opens an in-page **detail modal** ("Inquiry Details"), not a route.
- **Customer Feedback**: One flat list page, no tabs, no detail modal.
- **Activity Logs**: One page. Its actual controls are a filter *row* — Search, Module dropdown, "Hide sign-ins" toggle, Clear — plus an **Export CSV button**. There is **no date-range filter** ("To Date"/"From Date") anywhere in the code; the comment at `ActivityLogsPage.jsx:109` explicitly notes `dateFrom`/`dateTo` are "simply not passed" (dead/unused parameters). Search & Filter and Export CSV are page controls/actions, not hierarchy nodes.
- **Profile**: The page shows a profile *card* (name/email/role badge) inline — that is not a clickable child, just a display block — plus two real menu buttons: "Account Email" (→ Change Email) and "Change Password", plus a Push Notifications toggle and Sign Out. There is no separate "Account Information" page — it's a section on the Profile page itself, not a navigable child.

---

## 5. Route vs Module vs Section Classification

Legend: **A**=Top-Level Module · **B**=Child Module/Submodule · **C**=Page Section · **D**=Action/Button · **E**=Technical Route Only

### Public

| Item | Class | Why |
|---|---|---|
| Home / About Us | A | Landing destination for guests; has its own scrollspy nav |
| Our Story / Features / Gallery / Reviews | C | `AboutPage.jsx` anchor sections (`SECTIONS` array) |
| Coverage Areas | C | `#coverage` anchor inside About; Footer links to `/about#coverage`, not a page |
| Contact Us | C | `#contact` anchor inside About; Footer links to `/about#contact` |
| Track Package | A | Standalone route `/track`, own header, reused embedded in Customer |
| Trip Schedules | A (guest-facing) | Real route `/schedules` under `PublicShell`, linked from Footer as "View Trip Schedules" — a real guest destination, not an About anchor |
| FAQ / Help | A (guest-facing) | Real route `/faq` under `PublicShell`, linked from Footer as "FAQs" |
| Login | A | Entry hub; links to Register and Forgot Password |
| Register | B (of Login) | Only reachable from Login's "Create account"; links back to Login |
| Password Recovery | B (of Login) | Only reachable from Login's "Forgot password?"; links back to Login |
| Terms & Conditions | B (of Legal Policies) | Sibling of Privacy in Footer's bottom bar and in LegalPage's cross-link |
| Privacy Policy | B (of Legal Policies) | Same as above |

### Customer

| Item | Class | Why |
|---|---|---|
| Home / Dashboard | A | Index route, logo + bottom-nav "Home" |
| Book Shipment | A | Desktop nav item + bottom-nav center FAB |
| Route / Sender / Receiver / Package / Review & Confirm | B (of Book Shipment) | `steps` array — a real 5-step wizard the user experiences sequentially |
| Bookings | A | Desktop nav "Bookings" + bottom-nav "Bookings" (`/customer/orders`) |
| Booking List | B (of Bookings) | The page itself |
| Booking Details | B (of Bookings) | `/customer/orders/:id`, reached only from the list |
| Cancel Booking / Submit Feedback | D | Modals triggered by buttons on Booking Details, not routes |
| Trips | A | Desktop nav + bottom nav |
| Chat Support | A | Desktop nav item + mobile FAB (see duplication note, §7) |
| Notifications | A (utility) | Persistent bell icon in navbar, own route, own unread badge |
| Track Package (customer) | B (of Home) | Reached via the tracking search box on Home; also `?embedded` reuse of the public Tracking page |
| Profile | A | Avatar dropdown + bottom-nav "Profile" |
| Personal Info & Addresses | B (of Profile) | Profile menu item |
| Change Password | B (of Profile) | Profile menu item |
| Change Email | B (of Profile) | Profile menu item |
| Payment History | B (of Profile) | Profile menu item — **only** reachable through Profile in the real UI |
| Help & Guidelines | B (of Profile) | Profile menu item (same component reused publicly at `/faq`) |
| About & Version | B (of Profile) | Profile menu item |
| Dark Mode / Push Notifications / Email Announcements | C | Toggles rendered inline on the Profile page, not separate pages |

### Administrator

| Item | Class | Why |
|---|---|---|
| Dashboard | A | Sidebar "Main" section |
| Bookings | A | Sidebar "Main" section |
| Booking List | B | The page itself |
| Create Booking | B | Button on Booking List → `/admin/create-booking` (actual on-screen title, not "Walk-in Booking") |
| Booking Details | B | Row click on Booking List |
| Trips | A | Sidebar "Main" section |
| Trip List | B | The page itself |
| Create Trip | B | Button on Trip List |
| Trip Details | B | Row click on Trip List |
| Customers | A | Sidebar "Main" section |
| Customer List | B | The page itself |
| Customer Details | B | Row click on Customer List |
| Sales & Reports | A | Sidebar "Management" section |
| Sales Overview / Unsettled Deliveries / Reports & Analytics | B | In-page tabs, `SECTIONS` array |
| Announcements | A | Sidebar "Management" section |
| Announcement List / New Announcement | C (kept as B for clarity) | Two visible panels on one page — see note below |
| Announcement Title / Content | — (excluded) | Form fields, not hierarchy nodes |
| Inbox | A | Sidebar "Management" section; the module itself IS the conversation view — no separate child |
| Contact Inquiries (sidebar label: "Inquiries") | A | Sidebar "Management" section |
| Inquiry List | B | The page itself |
| Inquiry Details | D | In-page modal, not a route |
| Customer Feedback | A | Sidebar "Management" section, flat list, no children |
| Activity Logs | A | Sidebar "Management" section, flat page |
| Search & Filter / Export CSV | D | Filter row + button on the same page, not children |
| "To Date" | — (does not exist) | No such filter in code — remove if present in current diagram |
| Company Information | A | Sidebar "System" section |
| Basic Info / Contact Info / Why Choose Us / Coverage Areas / Pricing | B | In-page tabs, `TABS` array |
| Storage Monitoring | A | Sidebar "System" section |
| Photo Storage / Email Service | B | In-page tabs |
| Profile | A | Sidebar footer profile dropdown |
| Account Information | — (page section, not a node) | Just the profile card shown at the top of the Profile page |
| Change Email | B (of Profile) | Profile menu item |
| Change Password | B (of Profile) | Profile menu item |

---

## 6. Current Program Hierarchy Problems

Based on the specific nodes the audit brief flagged for verification (the presumed current/draft state of the Chapter 2 diagrams):

1. **Login → Register → Password Recovery drawn as a flat sibling chain** instead of Register/Password Recovery nested *under* Login. Confirmed by code: both are only reachable from Login and both link back to it — they should be children of Login, not standalone top-level items.
2. **Trip Schedules assumed to be an About-page section.** It is NOT — `/schedules` is a real, guest-accessible route (under `PublicShell`), linked from the Footer as "View Trip Schedules." It belongs as its own Public top-level module, separate from About's anchors.
3. **Contact Us / Coverage Areas assumed to be standalone pages.** Confirmed false — both are `#anchor` sections inside `/about` (`AboutPage.jsx` `SECTIONS`; Footer links to `/about#contact`, `/about#coverage`). They must be Page Sections under Home/About Us, not their own nodes (or omitted from the top-level tree entirely, since the brief says sections shouldn't be separate branches unless useful).
4. **Terms and Privacy assumed to be unrelated top-level items.** Confirmed they should be siblings under a "Legal Policies" grouping — Footer visually groups them adjacent to each other, and LegalPage cross-links them as "the other document."
5. **"Place Order" vs "Book Shipment"** — the actual feature/route/UI label is uniformly **"Book Shipment"** (nav label, page component, FAB aria-label all say "Book"/"Book Shipment"; only one internal aria-label says "Place order / Book shipment" as an accessibility redundancy — `CustomerLayout.jsx:431`). If the current diagram uses "Place Order," rename to "Book Shipment."
6. **"Orders" vs "Bookings"** — the customer-facing **label** is "Bookings" (`desktopNavItems`, `bottomNavItems` both say "Bookings"), even though the route path and component are named `Orders`/`OrdersPage`. Program Hierarchy should show the user-facing label "Bookings," with "Booking List"/"Booking Details" as children — not "Orders."
7. **"Payment Details" vs "Payment History"** — the real page and profile-menu label is "Payment History" ("Your payments, open balances, and receipts"). If the draft says "Payment Details," rename.
8. **Duplicated Chat Support** — appears in the desktop nav, the mobile FAB, and again inside Profile → Help & Support. Confirmed it is one page/route; the diagram should show it once, as a Customer top-level module (see §7).
9. **Missing Storage Monitoring** — confirmed it exists in the sidebar ("System" section) with two real tabs (Photo Storage, Email Service). If absent from the current diagram, it must be added.
10. **Announcement Title/Content as child nodes** — confirmed these are just form-field labels inside the "New Announcement" panel, not navigable nodes. Remove if present.
11. **Activity Logs "To Date"** — confirmed no such field exists anywhere in `ActivityLogsPage.jsx`. The only filters are Search, Module, and a "Hide sign-ins" toggle, plus an Export CSV action. Remove "To Date" (and, if present, treat "Search & Filter"/"Export CSV" as one filter-bar action group rather than formal child nodes).
12. **Profile children overstated** — confirmed "Account Information" is not a separate page for either Customer or Admin; it is a display card on the Profile page itself. Do not give it its own node — Profile's real children are the menu items that navigate elsewhere (Personal Info, Change Password, Change Email, Payment History for Customer; Change Email, Change Password for Admin).
13. **"Walk-in Booking"** — the actual on-screen title at `/admin/create-booking` is **"Create Booking"**, explicitly described in-app as for staff creating a booking on a customer's behalf (e.g., via Messenger), not an in-person walk-in counter flow. Rename "Walk-in Booking" → "Create Booking."

---

## 7. Duplicate/Misplaced Nodes — Recommended Placement

| Feature | Where it appears | Recommended single placement | Reason |
|---|---|---|---|
| **Chat Support** | Desktop top nav, mobile floating bubble, Profile → Help & Support | **Customer top-level module** (sibling of Book Shipment/Bookings/Trips) | It is a persistent primary nav item on desktop; the Profile entry and mobile FAB are just alternate access points to the exact same route, not a separate feature — one node avoids implying two different chat systems |
| **Payment History** | Only inside Profile → Account & Security | **Child of Profile** | It has no nav-bar or bottom-tab presence at all — in the real UI a customer can only reach it through Profile, so it is not a peer of Bookings/Trips |
| **Help & Guidelines** | Public `/faq` (via PublicShell) AND Customer Profile → Help & Support | **Two separate leaf nodes, one per diagram** (Public tree: top-level "FAQ/Help"; Customer tree: child of Profile) | Same component reused for two different audiences/contexts — this isn't UI duplication within one diagram, it's legitimate reuse across the two role-specific diagrams, so no consolidation is needed *within* either tree |
| **Trip Schedules** | Footer link + real guest route `/schedules` | **Public top-level module**, not a Home/About section | Distinct route, distinct page, reachable independent of About |
| **Notifications** | Customer navbar bell icon | **Customer top-level module (utility)** | Own route, own real-time badge, always visible in the chrome — behaves like a nav item even without a text label |
| **Track Package (customer)** | Home page search widget only | **Child of Home/Dashboard** | No persistent nav entry; only reachable by using the widget on Home |
| **Account Information** (both roles) | Static display card atop the Profile page | **Not a node** — merge into the Profile module itself | It's not a destination, it's the header of the destination |

---

## 8. FINAL Public Program Hierarchy

```
PUBLIC

CargoExpress PH
└── Public
    ├── Home / About Us
    │   ├── Our Story (page section)
    │   ├── Features (page section)
    │   ├── Coverage Areas (page section)
    │   ├── Gallery (page section)
    │   ├── Reviews (page section)
    │   └── Contact Us (page section)
    ├── Track Package
    ├── Trip Schedules
    ├── FAQ / Help
    ├── Login
    │   ├── Register
    │   └── Password Recovery
    └── Legal Policies
        ├── Terms & Conditions
        └── Privacy Policy
```

## 9. FINAL Customer Program Hierarchy

```
CUSTOMER

CargoExpress PH
└── Customer
    ├── Home / Dashboard
    │   └── Track Package (embedded)
    ├── Book Shipment
    │   ├── Route
    │   ├── Sender Details
    │   ├── Receiver Details
    │   ├── Package Details
    │   └── Review & Confirm
    ├── Bookings
    │   ├── Booking List
    │   └── Booking Details
    ├── Trips
    ├── Chat Support
    ├── Notifications
    └── Profile
        ├── Personal Info & Addresses
        ├── Change Password
        ├── Change Email
        ├── Payment History
        ├── Help & Guidelines
        └── About & Version
```

## 10. FINAL Admin Program Hierarchy

```
ADMINISTRATOR

CargoExpress PH
└── Administrator
    ├── Dashboard
    ├── Bookings
    │   ├── Booking List
    │   ├── Create Booking
    │   └── Booking Details
    ├── Trips
    │   ├── Trip List
    │   ├── Create Trip
    │   └── Trip Details
    ├── Customers
    │   ├── Customer List
    │   └── Customer Details
    ├── Sales & Reports
    │   ├── Sales Overview
    │   ├── Unsettled Deliveries
    │   └── Reports & Analytics
    ├── Announcements
    │   ├── Announcement List
    │   └── New Announcement
    ├── Inbox
    ├── Contact Inquiries
    ├── Customer Feedback
    ├── Activity Logs
    ├── Company Information
    │   ├── Basic Info
    │   ├── Contact Info
    │   ├── Why Choose Us
    │   ├── Coverage Areas
    │   └── Pricing
    ├── Storage Monitoring
    │   ├── Photo Storage
    │   └── Email Service
    └── Profile
        ├── Change Email
        └── Change Password
```

---

## 11. Draw.io Construction Guide

### PUBLIC (Figure 37)
- **Top-level branches:** 6 — Home / About Us, Track Package, Trip Schedules, FAQ / Help, Login, Legal Policies
- **Child boxes:** 10 total — 6 About-page sections (Our Story, Features, Coverage Areas, Gallery, Reviews, Contact Us), 2 under Login (Register, Password Recovery), 2 under Legal Policies (Terms, Privacy)
- **Left-to-right order:** Home / About Us → Track Package → Trip Schedules → FAQ / Help → Login → Legal Policies (matches Footer's own grouping order: navigation content, then account, then legal)
- **Vertical alignment:** All 6 top-level boxes sit on one row directly under the "Public" role node. Home/About's 6 section-children fan out below it in a single row (they're same-level page sections, no further nesting). Login's two children (Register, Password Recovery) sit below Login, side by side. Legal Policies' two children (Terms, Privacy) sit below it, side by side.
- **Do NOT include:** Coverage Areas or Contact Us as top-level boxes (they're About-page anchors); a standalone "Place Order" node (doesn't exist here — that's Customer-only); any node for the About page's live system-status indicator (a footer widget, not navigation).

### CUSTOMER (Figure 38)
- **Top-level branches:** 6 — Home / Dashboard, Book Shipment, Bookings, Trips, Chat Support, Notifications, Profile *(7 if Notifications and Profile are both counted at top level — see count below)*
- **Child boxes:** 5 under Book Shipment (Route, Sender, Receiver, Package, Review & Confirm) + 2 under Bookings (Booking List, Booking Details) + 6 under Profile (Personal Info & Addresses, Change Password, Change Email, Payment History, Help & Guidelines, About & Version) + 1 under Home (Track Package) = 14 total
- **Left-to-right order:** Home / Dashboard → Book Shipment → Bookings → Trips → Chat Support → Notifications → Profile (mirrors the order items appear left-to-right in the desktop navbar, with Home first and Profile last, matching the avatar's position at the far right)
- **Vertical alignment:** All 7 top-level boxes on one row under "Customer." Book Shipment's 5 wizard-step children run left to right in one row beneath it, in strict sequence (Route → Sender → Receiver → Package → Review & Confirm) since order matters for a wizard. Bookings' 2 children sit side by side beneath it. Profile's 6 children fan out in one row beneath it.
- **Do NOT include:** "Place Order" (use "Book Shipment"); "Orders" (use "Bookings"); Cancel Booking / Submit Feedback as nodes (they're modal actions on Booking Details); Dark Mode / Push Notifications / Email Announcements as nodes (in-page toggles on Profile, not destinations); a second "Chat Support" node under Profile.

### ADMINISTRATOR (Figure 39)
- **Top-level branches:** 11 — Dashboard, Bookings, Trips, Customers, Sales & Reports, Announcements, Inbox, Contact Inquiries, Customer Feedback, Activity Logs, Company Information, Storage Monitoring, Profile *(13 counting Profile and Storage Monitoring — see count below)*
- **Child boxes:** 3 under Bookings + 3 under Trips + 2 under Customers + 3 under Sales & Reports + 2 under Announcements + 5 under Company Information + 2 under Storage Monitoring + 2 under Profile = 22 total
- **Left-to-right order:** Group and order exactly as the sidebar groups them, left to right, top group first: **Main** (Dashboard, Bookings, Trips, Customers) → **Management** (Sales & Reports, Announcements, Inbox, Contact Inquiries, Customer Feedback, Activity Logs) → **System** (Company Information, Storage Monitoring) → **Profile** (drawn last/separately since it lives in the sidebar footer, not the main nav list). Consider three loosely grouped horizontal bands (Main / Management / System) to mirror the sidebar's own section labels, with Profile set apart below or to the side to show it isn't part of the three.
- **Vertical alignment:** Bookings/Trips/Customers children align in one row each beneath their parent, in the sequence List → Create → Details (matches how a user encounters them: browse, then optionally create, then drill into one). Company Information's 5 tab-children align in one row in the exact tab order (Basic Info, Contact Info, Why Choose Us, Coverage Areas, Pricing). Storage Monitoring's 2 tab-children align in the order Photo Storage, Email Service.
- **Do NOT include:** "Walk-in Booking" (use "Create Booking"); "Search & Filter" / "Export CSV" / "To Date" under Activity Logs (Activity Logs has no children — it's a flat page); "Customer Conversations" under Inbox (Inbox has no children — the conversation view IS Inbox); "Inquiry Details" as a permanent child of Contact Inquiries (it's a modal, not a route — omit, or if you want to show it, mark it visually as a modal/action rather than a page node); "Account Information" under Profile (it's the profile card on the Profile page itself, not a separate destination); Announcement Title/Content as grandchildren of Announcements.

---

## 12. Figure Caption Guide

Confirmed, unchanged from your numbering:

- **FIGURE 37.** Program Hierarchy (Public)
- **FIGURE 38.** Program Hierarchy (Customer)
- **FIGURE 39.** Program Hierarchy (Admin)

---

## Final Summary

```
PUBLIC TOP-LEVEL MODULES: 6
CUSTOMER TOP-LEVEL MODULES: 7
ADMIN TOP-LEVEL MODULES: 13   (12 sidebar items + Profile)

PUBLIC CHILD MODULES: 10
CUSTOMER CHILD MODULES: 14
ADMIN CHILD MODULES: 22

CURRENT HIERARCHY NODES TO:
KEEP: 27
RENAME: 5    (Place Order→Book Shipment, Orders→Bookings, Payment Details→Payment History, Walk-in Booking→Create Booking, "Trip Schedules under About"→standalone Public module)
MOVE: 6      (Register & Password Recovery under Login; Terms & Privacy under Legal Policies; Coverage Areas/Contact Us from top-level to About-page sections; Payment History confirmed under Profile, not top-level)
REMOVE: 5    (Activity Logs "To Date"; Activity Logs "Search & Filter"/"Export CSV" as nodes; Announcement Title/Content as nodes; duplicate Chat Support under Profile; "Account Information" as a separate Profile child for both roles)
ADD: 3       (Storage Monitoring with its 2 tab-children; Notifications as a Customer top-level utility node; Trip Schedules as its own Public top-level node if currently missing)

FINAL PUBLIC TREE: READY
FINAL CUSTOMER TREE: READY
FINAL ADMIN TREE: READY

REPORT CREATED:
CARGOEXPRESS_CHAPTER2_PROGRAM_HIERARCHY_UI_AUDIT.md

SOURCE CODE MODIFIED: NO
DATABASE MODIFIED: NO
CHAPTER 2 MODIFIED: NO
```
