# CargoExpress PH Page, Route & Folder Organization Audit

**Type:** Read-only structural audit — no files moved, renamed, deleted, or edited.
**Purpose:** Prepare ground truth for a future folder cleanup so every page file's location matches its actual role and UI placement.

---

## 1. Current Route Inventory

Source: `src/App.jsx` (the only router configuration in the project — confirmed via `grep -rl "createBrowserRouter\|useRoutes\|<Routes>" src`, one hit).

| # | Route | Component | Current File Path | Role | Access |
|---|---|---|---|---|---|
| 1 | `/` | RootRedirect | `App.jsx` (inline) | — | redirect-only (role dispatch) |
| 2 | `/track` | TrackingPage | `src/pages/public/TrackingPage.jsx` | Public | direct public route |
| 3 | `/about` | AboutPage | `src/pages/public/AboutPage.jsx` | Public | direct public route |
| 4 | `/terms` | TermsPage (named export) | `src/pages/public/LegalPage.jsx` | Public | direct public route |
| 5 | `/privacy` | PrivacyPage (named export) | `src/pages/public/LegalPage.jsx` | Public | direct public route |
| 6 | `/schedules` | CustTripsPage (aliased) | `src/pages/customer/TripsPage.jsx` | Shared (Public-facing reuse) | direct public route, wrapped in `PublicShell` |
| 7 | `/faq` | HelpGuidelinesPage | `src/pages/customer/HelpGuidelinesPage.jsx` | Shared (Public-facing reuse) | direct public route, wrapped in `PublicShell` |
| 8 | `/login` | LoginPage | `src/pages/auth/LoginPage.jsx` | Public | direct public route |
| 9 | `/register` | RegisterPage | `src/pages/auth/RegisterPage.jsx` | Public | direct public route |
| 10 | `/forgot-password` | ForgotPasswordPage | `src/pages/auth/ForgotPasswordPage.jsx` | Public | direct public route |
| 11 | `/reset-password` | ResetPasswordPage | `src/pages/auth/ResetPasswordPage.jsx` | Public | direct public route (token-based; deliberately NOT wrapped in `AuthRoute` guard, unlike the other 3 auth pages) |
| 12 | `/payment/return` | PaymentReturnPage | `src/pages/shared/PaymentReturnPage.jsx` | Shared (Customer + Admin) | direct route, outside auth guards by design (PayMongo redirect target) |
| 13 | `/customer` (index) | HomePage | `src/pages/customer/HomePage.jsx` | Customer | authenticated route |
| 14 | `/customer/orders` | OrdersPage (aliased `CustOrdersPage`) | `src/pages/customer/OrdersPage.jsx` | Customer | authenticated route |
| 15 | `/customer/orders/:id` | OrderDetailPage (aliased `CustOrderDetailPage`) | `src/pages/customer/OrderDetailPage.jsx` | Customer | nested/detail route |
| 16 | `/customer/book` | BookShipmentPage | `src/pages/customer/BookShipmentPage.jsx` | Customer | authenticated route |
| 17 | `/customer/track` | TrackingPage (`embedded` prop) | `src/pages/public/TrackingPage.jsx` | Shared (Public component reused) | nested route |
| 18 | `/customer/trips` | TripsPage (aliased `CustTripsPage`) | `src/pages/customer/TripsPage.jsx` | Customer | authenticated route |
| 19 | `/customer/notifications` | NotificationsPage | `src/pages/customer/NotificationsPage.jsx` | Customer | authenticated route |
| 20 | `/customer/profile` | ProfilePage (aliased `CustProfilePage`) | `src/pages/customer/ProfilePage.jsx` | Customer | authenticated route |
| 21 | `/customer/personal-info` | PersonalInfoPage (aliased `CustPersonalInfoPage`) | `src/pages/customer/PersonalInfoPage.jsx` | Customer | nested route (Profile child) |
| 22 | `/customer/change-password` | ChangePasswordPage | `src/pages/shared/ChangePasswordPage.jsx` | Shared (Customer + Admin) | nested route (Profile child) |
| 23 | `/customer/change-email` | ChangeEmailPage | `src/pages/shared/ChangeEmailPage.jsx` | Shared (Customer + Admin) | nested route (Profile child) |
| 24 | `/customer/support` | SupportChatPage | `src/pages/customer/SupportChatPage.jsx` | Customer | authenticated route |
| 25 | `/customer/payments` | PaymentHistoryPage | `src/pages/customer/PaymentHistoryPage.jsx` | Customer | nested route (Profile child) |
| 26 | `/customer/payment-methods` | `<Navigate to="/customer/payments" replace>` | `App.jsx` (inline) | Customer | **redirect-only / legacy** |
| 27 | `/customer/help-guidelines` | HelpGuidelinesPage | `src/pages/customer/HelpGuidelinesPage.jsx` | Customer | nested route (Profile child) |
| 28 | `/customer/about-version` | AboutVersionPage | `src/pages/customer/AboutVersionPage.jsx` | Customer | nested route (Profile child) |
| 29 | `/admin` (index) | DashboardPage | `src/pages/admin/DashboardPage.jsx` | Admin | authenticated route |
| 30 | `/admin/orders` | OrdersPage (aliased `AdminOrdersPage`) | `src/pages/admin/OrdersPage.jsx` | Admin | authenticated route |
| 31 | `/admin/orders/:id` | OrderDetailPage (aliased `AdminOrderDetailPage`) | `src/pages/admin/OrderDetailPage.jsx` | Admin | nested/detail route |
| 32 | `/admin/create-booking` | AdminCreateBookingPage | `src/pages/admin/AdminCreateBookingPage.jsx` | Admin | nested route (Bookings child) |
| 33 | `/admin/trips` | TripsPage (aliased `AdminTripsPage`) | `src/pages/admin/TripsPage.jsx` | Admin | authenticated route |
| 34 | `/admin/trips/create` | CreateTripPage | `src/pages/admin/CreateTripPage.jsx` | Admin | nested route (Trips child) |
| 35 | `/admin/trips/:id` | TripDetailPage | `src/pages/admin/TripDetailPage.jsx` | Admin | nested/detail route |
| 36 | `/admin/customers` | CustomersPage | `src/pages/admin/CustomersPage.jsx` | Admin | authenticated route |
| 37 | `/admin/customers/:id` | CustomerDetailPage | `src/pages/admin/CustomerDetailPage.jsx` | Admin | nested/detail route |
| 38 | `/admin/sales` | SalesReportsPage (`initialSection="sales"`) | `src/pages/admin/SalesReportsPage.jsx` | Admin | authenticated route |
| 39 | `/admin/reports` | SalesReportsPage (`initialSection="reports"`) | `src/pages/admin/SalesReportsPage.jsx` | Admin | authenticated route (same component as #38) |
| 40 | `/admin/announcements` | AnnouncementsPage | `src/pages/admin/AnnouncementsPage.jsx` | Admin | authenticated route |
| 41 | `/admin/inbox` | InboxPage | `src/pages/admin/InboxPage.jsx` | Admin | authenticated route |
| 42 | `/admin/contact-inquiries` | ContactInquiriesPage | `src/pages/admin/ContactInquiriesPage.jsx` | Admin | authenticated route |
| 43 | `/admin/profile` | ProfilePage (aliased `AdminProfilePage`) | `src/pages/admin/ProfilePage.jsx` | Admin | authenticated route |
| 44 | `/admin/change-email` | ChangeEmailPage | `src/pages/shared/ChangeEmailPage.jsx` | Shared (Customer + Admin) | nested route (Profile child) |
| 45 | `/admin/change-password` | ChangePasswordPage | `src/pages/shared/ChangePasswordPage.jsx` | Shared (Customer + Admin) | nested route (Profile child) |
| 46 | `/admin/activity-logs` | ActivityLogsPage | `src/pages/admin/ActivityLogsPage.jsx` | Admin | authenticated route |
| 47 | `/admin/company-info` | CompanyInformationPage | `src/pages/admin/CompanyInformationPage.jsx` | Admin | authenticated route |
| 48 | `/admin/storage-monitoring` | StorageMonitoringPage | `src/pages/admin/StorageMonitoringPage.jsx` | Admin | authenticated route |
| 49 | `/admin/feedback` | FeedbackPage | `src/pages/admin/FeedbackPage.jsx` | Admin | authenticated route |
| 50 | `*` (catch-all) | NotFoundPage | `src/pages/public/NotFoundPage.jsx` | Public | direct route (404) |

**50 route entries → 41 unique routable page components** (several components are mounted at more than one path: `LegalPage` ×2, `TripsPage` ×2, `HelpGuidelinesPage` ×2, `TrackingPage` ×2, `ChangeEmailPage` ×2, `ChangePasswordPage` ×2, `SalesReportsPage` ×2, plus the one pure redirect).

---

## 2. Public Page Structure

| Item | Classification | Evidence |
|---|---|---|
| Home / About Us | **TOP-LEVEL PUBLIC PAGE** | `/about`, own scrollspy nav (`AboutPage.jsx` `SECTIONS`) |
| Our Story / Features / Gallery / Reviews | **ABOUT-PAGE SECTION** | Same `SECTIONS` array, anchors only |
| Coverage Areas | **ABOUT-PAGE SECTION** | `Footer.jsx` links to `/about#coverage`; no dedicated route |
| Contact Us | **ABOUT-PAGE SECTION** | `Footer.jsx` links to `/about#contact`; `LegalPage.jsx` footer link also points to `/about#contact` |
| Track Package | **TOP-LEVEL PUBLIC PAGE** | `/track`, own header, own file `pages/public/TrackingPage.jsx` |
| Trip Schedules | **TOP-LEVEL PUBLIC PAGE** — confirmed NOT an About-Us section | `/schedules` is a real route wrapped in `PublicShell`, linked from `Footer.jsx` as "View Trip Schedules." It is not reachable from Login, but Login is not the only entry point to public pages — the Footer (rendered on About and on PublicShell pages) is. Traced independently of the Login page as instructed. |
| FAQ / Help | **TOP-LEVEL PUBLIC PAGE** | `/faq`, wrapped in `PublicShell`, linked from `Footer.jsx` as "FAQs" |
| Login | **TOP-LEVEL PUBLIC PAGE** | `/login`, entry hub |
| Register | **CHILD OF LOGIN** | Only reachable via Login's "Create account" link; links back to Login |
| Password Recovery | **CHILD OF LOGIN** | Only reachable via Login's "Forgot password?" link; links back to Login. (`/reset-password` is a second, token-only step of the same flow, reached only from the emailed link, never from in-app navigation.) |
| Terms | **LEGAL PAGE** | `/terms`, cross-linked with Privacy, reachable from Footer, Register's consent checkboxes, and `/about#contact`'s Legal Policies grouping |
| Privacy | **LEGAL PAGE** | `/privacy`, same as above |

**Footer-only destinations** (reachable in practice only through `Footer.jsx`, not through any page-level nav): Trip Schedules, FAQ/Help, Coverage Areas anchor, Contact Us anchor, Terms, Privacy.

**Technical-route-only:** none found on the public side — every public route has at least one real UI entry point (Footer, Login, or in-page nav).

---

## 3. Customer Page Structure

Traced from `CustomerLayout.jsx` (`desktopNavItems`, `bottomNavItems`, avatar dropdown) and `ProfilePage.jsx` (menu sections).

| Page | Classification | Visible Entry Points | Parent UI Module |
|---|---|---|---|
| Customer Home | Main module | Logo click, bottom-nav "Home" | — (root) |
| Book Shipment | Main module | Desktop nav "Book Shipment", bottom-nav center FAB | — |
| Bookings (Order list) | Main module | Desktop nav "Bookings", bottom-nav "Bookings" | — |
| Booking Details | Child page | Row click inside Bookings list | Bookings |
| Cancel Booking | Action (modal) | Button on Booking Details | Booking Details |
| Submit Feedback | Action (modal) | Button/auto-prompt on Booking Details | Booking Details |
| Trips | Main module | Desktop nav "Trips", bottom-nav "Trips" | — |
| Notifications | Main module (utility) | Bell icon in navbar (icon-only, own badge) | — |
| Chat Support | Main module | Desktop nav "Chat Support", mobile floating chat bubble (all pages except itself), Profile → Help & Support "Live Support Chat" | — (multiple alternate access points to ONE page) |
| Profile | Main module | Avatar dropdown "My Profile", bottom-nav "Profile" | — |
| Personal Info | Child page | Profile → "Personal Info & Addresses"; also a completion-meter CTA on Profile itself | Profile |
| Change Password | Child page | Profile → "Change Password" | Profile |
| Change Email | Child page | Profile → "Change Email" | Profile |
| Payment History | Child page | Profile → "Payment History" ONLY — no nav-bar/bottom-tab presence | Profile |
| Help & Guidelines | Child page | Profile → "Help & Guidelines" | Profile |
| About & Version | Child page | Profile → "About & Version" | Profile |
| Tracking (embedded) | Alternate access point | Search box on Customer Home (`navigate('/customer/track?q=...')`) | Customer Home |

**Main modules:** Home, Book Shipment, Bookings, Trips, Notifications, Chat Support, Profile (7).
**Child pages:** Booking Details, Personal Info, Change Password, Change Email, Payment History, Help & Guidelines, About & Version (7).
**Actions (not pages):** Cancel Booking, Submit Feedback (modals).
**Alternate access point:** embedded Tracking, reached only via the Home search widget.

---

## 4. Administrator Page Structure

Traced from `Sidebar.jsx` (`mainNav`, `toolsNav`, `systemNav`, profile dropdown).

| Sidebar Group | Page | Nested/Detail Children |
|---|---|---|
| **MAIN** | Dashboard | — |
| | Bookings | Booking List (page itself) → Create Booking (button) → Booking Details (row click) |
| | Trips | Trip List (page itself) → Create Trip (button) → Trip Details (row click) |
| | Customers | Customer List (page itself) → Customer Details (row click) |
| **MANAGEMENT** | Sales & Reports | In-page tabs: Sales Overview, Unsettled Deliveries, Reports & Analytics (routes `/admin/sales` and `/admin/reports` both mount the same component and only set which tab opens first) |
| | Announcements | In-page panels: Announcement List, New Announcement (inline form) |
| | Inbox | No children — module IS the conversation view |
| | Inquiries (page title: "Contact Inquiries") | Inquiry Details is an in-page **modal**, not a route |
| | Customer Feedback | No children — flat list |
| | Activity Logs | No children — flat page. Its filter row (Search, Module, "Hide sign-ins") and Export CSV button are page controls, not child pages |
| **SYSTEM** | Company Information | In-page tabs: Basic Info, Contact Info, Why Choose Us, Coverage Areas, Pricing |
| | Storage Monitoring | In-page tabs: Photo Storage, Email Service |
| **ACCOUNT** | Profile | Not in the sidebar's `mainNav`/`toolsNav`/`systemNav` lists at all — lives in a separate profile-dropdown at the sidebar footer. Children: Change Email, Change Password (both via `pages/shared/`) |

Confirmed against code:
- **Create Booking**: `AdminCreateBookingPage.jsx`, on-screen title is literally "Create Booking" ("...on behalf of a customer, e.g. via Facebook Messenger"), reached by a button on the Booking List.
- **Booking Details**: `/admin/orders/:id`.
- **Create Trip**: button on Trip List → `/admin/trips/create`.
- **Trip Details**: `/admin/trips/:id`.
- **Customer Details**: `/admin/customers/:id`.
- **Change Email / Change Password**: both are the exact same files as the customer versions (`src/pages/shared/`), reached from the admin Profile page's two menu buttons.

---

## 5. Shared Pages

| File | Used By | Confirmed By |
|---|---|---|
| `src/pages/shared/ChangeEmailPage.jsx` | Customer (`/customer/change-email`) AND Admin (`/admin/change-email`) | Same import in `App.jsx`, two route entries |
| `src/pages/shared/ChangePasswordPage.jsx` | Customer (`/customer/change-password`) AND Admin (`/admin/change-password`) | Same import in `App.jsx`, two route entries |
| `src/pages/shared/PaymentReturnPage.jsx` | Customer AND Admin | Internally branches on a `?role=` query param (`role === 'admin' ? 'admin' : 'customer'`) and redirects to `/{role}/orders/{id}` — genuinely role-aware, correctly shared |
| `src/pages/public/TrackingPage.jsx` | Public (`/track`) AND Customer (`/customer/track`, via `embedded` prop) | Same component, `embedded` prop hides the public header — but the file physically lives in `pages/public/`, not `pages/shared/` |
| `src/pages/customer/TripsPage.jsx` | Customer (`/customer/trips`) AND Public guest (`/schedules`, under `PublicShell`) | Same import (`CustTripsPage` alias) used for both routes — file lives in `pages/customer/`, not `pages/shared/` |
| `src/pages/customer/HelpGuidelinesPage.jsx` | Customer (`/customer/help-guidelines`) AND Public guest (`/faq`, under `PublicShell`) | Same import used for both routes — file lives in `pages/customer/`, not `pages/shared/` |

**Important distinction — look-alike names that are NOT shared components:** `OrdersPage.jsx`, `OrderDetailPage.jsx`, `TripsPage.jsx`, and `ProfilePage.jsx` all exist as **separate, independently-implemented files** in both `pages/customer/` and `pages/admin/`. These are not the same component reused — they are legitimately distinct role-specific pages that happen to share a filename. Do not treat them as duplicate/shared candidates.

---

## 6. Current Folder Tree

```
src/pages/
├── admin/                         (25 files)
│   ├── ActivityLogsPage.jsx
│   ├── AdminCreateBookingPage.jsx
│   ├── AnnouncementsPage.jsx
│   ├── CompanyInfoCoverageTab.jsx      ← tab sub-component, not a route
│   ├── CompanyInfoFeaturesTab.jsx      ← tab sub-component, not a route
│   ├── CompanyInformationPage.jsx
│   ├── ContactInquiriesPage.jsx
│   ├── CreateTripPage.jsx
│   ├── CustomerDetailPage.jsx
│   ├── CustomersPage.jsx
│   ├── DashboardPage.jsx
│   ├── EmailServiceTab.jsx             ← tab sub-component, not a route
│   ├── FeedbackPage.jsx
│   ├── InboxPage.jsx
│   ├── OrderDetailPage.jsx
│   ├── OrdersPage.jsx
│   ├── PhotoStorageTab.jsx             ← tab sub-component, not a route
│   ├── ProfilePage.jsx
│   ├── ReportsPage.jsx                 ← tab sub-component, not a route (no "Tab" suffix — naming inconsistency)
│   ├── SalesPage.jsx                   ← tab sub-component, not a route (no "Tab" suffix)
│   ├── SalesReportsPage.jsx
│   ├── StorageMonitoringPage.jsx
│   ├── TripDetailPage.jsx
│   ├── TripsPage.jsx
│   └── UnsettledDeliveriesPage.jsx     ← tab sub-component, not a route (no "Tab" suffix)
├── auth/                          (4 files)
│   ├── ForgotPasswordPage.jsx
│   ├── LoginPage.jsx
│   ├── RegisterPage.jsx
│   └── ResetPasswordPage.jsx
├── customer/                      (12 files)
│   ├── AboutVersionPage.jsx
│   ├── BookShipmentPage.jsx
│   ├── HelpGuidelinesPage.jsx          ← reused publicly at /faq
│   ├── HomePage.jsx
│   ├── NotificationsPage.jsx
│   ├── OrderDetailPage.jsx
│   ├── OrdersPage.jsx
│   ├── PaymentHistoryPage.jsx
│   ├── PersonalInfoPage.jsx
│   ├── ProfilePage.jsx
│   ├── SupportChatPage.jsx
│   └── TripsPage.jsx                   ← reused publicly at /schedules
├── public/                        (4 files)
│   ├── AboutPage.jsx
│   ├── LegalPage.jsx                   ← exports both TermsPage and PrivacyPage
│   ├── NotFoundPage.jsx
│   └── TrackingPage.jsx                ← reused inside Customer at /customer/track
└── shared/                        (3 files)
    ├── ChangeEmailPage.jsx
    ├── ChangePasswordPage.jsx
    └── PaymentReturnPage.jsx

src/components/
├── auth/
│   └── AuthHeroPanel.jsx               ← visual component shared by Login/Register/ForgotPassword, correctly NOT in pages/
├── layout/
│   ├── AdminLayout.jsx
│   ├── CustomerLayout.jsx
│   ├── Footer.jsx
│   ├── PublicShell.jsx
│   └── Sidebar.jsx
└── ui/  (50 files — generic, reused across all roles)
```

### Per-page placement verdict

| File | Current Folder | Verdict |
|---|---|---|
| All 25 `admin/` files (routes) | `pages/admin/` | CORRECT |
| `CompanyInfoCoverageTab.jsx`, `CompanyInfoFeaturesTab.jsx`, `PhotoStorageTab.jsx`, `EmailServiceTab.jsx`, `SalesPage.jsx`, `ReportsPage.jsx`, `UnsettledDeliveriesPage.jsx` | `pages/admin/` | CORRECT location, but **UNCLEAR by naming** — these are tab sub-components, not routes, yet sit flat alongside real page files with no visual distinction (4 of 7 have a `Tab` suffix, 3 don't) |
| All 4 `auth/` files | `pages/auth/` | CORRECT |
| `HomePage.jsx`, `BookShipmentPage.jsx`, `NotificationsPage.jsx`, `OrderDetailPage.jsx`, `OrdersPage.jsx`, `PaymentHistoryPage.jsx`, `PersonalInfoPage.jsx`, `ProfilePage.jsx`, `SupportChatPage.jsx`, `AboutVersionPage.jsx` | `pages/customer/` | CORRECT |
| `TripsPage.jsx` (customer) | `pages/customer/` | **SHARED BUT DUPLICATED FOLDER LOCATION** — reused at the public `/schedules` route, but lives entirely inside `customer/` with no signal that Public depends on it |
| `HelpGuidelinesPage.jsx` (customer) | `pages/customer/` | Same issue — reused at public `/faq` |
| `AboutPage.jsx`, `LegalPage.jsx`, `NotFoundPage.jsx` | `pages/public/` | CORRECT |
| `TrackingPage.jsx` | `pages/public/` | **ROLE-SPECIFIC BUT ALSO CONSUMED CROSS-ROLE** — genuinely public-owned, but Customer depends on it via `embedded` prop; correct primary home, just worth flagging as a cross-role dependency |
| `ChangeEmailPage.jsx`, `ChangePasswordPage.jsx` | `pages/shared/` | CORRECT — truly used by both Customer and Admin |
| `PaymentReturnPage.jsx` | `pages/shared/` | CORRECT — internally role-aware (`?role=` param) |

**No files were found to be LEGACY, MISPLACED into the wrong role folder outright, or UNREACHABLE.** The one true structural gap is that `pages/customer/TripsPage.jsx` and `pages/customer/HelpGuidelinesPage.jsx` are cross-role dependencies (Public relies on Customer-folder files) that aren't reflected anywhere in the folder structure.

---

## 7. Misplaced / Duplicate / Legacy Pages

| Item | Category | Detail |
|---|---|---|
| `pages/customer/TripsPage.jsx` | Shared but not in `shared/` | Powers both `/customer/trips` and public `/schedules` |
| `pages/customer/HelpGuidelinesPage.jsx` | Shared but not in `shared/` | Powers both `/customer/help-guidelines` and public `/faq` |
| `pages/public/TrackingPage.jsx` | Shared but not in `shared/` | Powers both `/track` and `/customer/track` (via `embedded` prop) |
| `pages/admin/SalesPage.jsx`, `ReportsPage.jsx`, `UnsettledDeliveriesPage.jsx` | Naming inconsistency | Tab sub-components without the `Tab` suffix that `PhotoStorageTab`/`EmailServiceTab`/`CompanyInfoFeaturesTab`/`CompanyInfoCoverageTab` use — no code defect, just an inconsistent convention worth fixing during cleanup |
| `/customer/payment-methods` route | **LEGACY / redirect-only** | `<Navigate to="/customer/payments" replace>` — no component file of its own; kept only because the old path may be bookmarked, cached in the PWA shell, or saved in browser history (per code comment at `App.jsx:239-242`) |

No obsolete route was found pointing at a component that no longer exists, and no duplicate implementation of the same feature was found (the customer/admin `OrdersPage`/`TripsPage`/`ProfilePage` pairs are intentionally separate implementations, not accidental duplicates — see Section 5).

---

## 8. Recommended Folder Tree

The current five-folder split (`public/ auth/ customer/ admin/ shared/`) already matches ownership well and should be **kept**, not replaced. The only structural gaps are the three cross-role files noted above and the tab-file naming inconsistency. Two options, in order of preference:

**Option A (minimal, recommended):** Keep the current folders exactly as-is. Do not move `TripsPage.jsx`/`HelpGuidelinesPage.jsx` into `shared/`, because they are Customer-owned pages that Public happens to reuse wholesale (not generic shared utilities) — moving them would bury them away from the Customer profile/nav code that is their primary home and complicate the `desktopNavItems`/`bottomNavItems` mental model. Instead, just document the cross-role dependency (a one-line comment at the top of each file, matching the style `PublicShell.jsx` already uses) so a future reader doesn't assume they're customer-exclusive.

**Option B (if a stricter "reused = shared" rule is wanted):** Move only the two genuinely dual-role page components into `shared/`:
- `pages/customer/TripsPage.jsx` → `pages/shared/TripsPage.jsx`
- `pages/customer/HelpGuidelinesPage.jsx` → `pages/shared/HelpGuidelinesPage.jsx`

`TrackingPage.jsx` should stay in `public/` either way — it is Public-owned; Customer reuses it via a prop, which is the normal direction of reuse (a role folder importing from `public/`), not evidence it belongs in `shared/`.

**Folder-by-folder file list (Option A — recommended, no moves):**

```
pages/public/    → AboutPage.jsx, LegalPage.jsx, NotFoundPage.jsx, TrackingPage.jsx
pages/auth/      → LoginPage.jsx, RegisterPage.jsx, ForgotPasswordPage.jsx, ResetPasswordPage.jsx
pages/customer/  → HomePage.jsx, BookShipmentPage.jsx, OrdersPage.jsx, OrderDetailPage.jsx,
                   TripsPage.jsx, NotificationsPage.jsx, SupportChatPage.jsx, ProfilePage.jsx,
                   PersonalInfoPage.jsx, PaymentHistoryPage.jsx, HelpGuidelinesPage.jsx,
                   AboutVersionPage.jsx
pages/admin/     → DashboardPage.jsx, OrdersPage.jsx, OrderDetailPage.jsx, AdminCreateBookingPage.jsx,
                   TripsPage.jsx, CreateTripPage.jsx, TripDetailPage.jsx, CustomersPage.jsx,
                   CustomerDetailPage.jsx, SalesReportsPage.jsx, SalesPage.jsx, ReportsPage.jsx,
                   UnsettledDeliveriesPage.jsx, AnnouncementsPage.jsx, InboxPage.jsx,
                   ContactInquiriesPage.jsx, FeedbackPage.jsx, ActivityLogsPage.jsx,
                   CompanyInformationPage.jsx, CompanyInfoFeaturesTab.jsx, CompanyInfoCoverageTab.jsx,
                   StorageMonitoringPage.jsx, PhotoStorageTab.jsx, EmailServiceTab.jsx, ProfilePage.jsx
pages/shared/    → ChangeEmailPage.jsx, ChangePasswordPage.jsx, PaymentReturnPage.jsx
```

**Optional micro-cleanup (naming only, not a move):** rename `SalesPage.jsx` → `SalesOverviewTab.jsx`, `ReportsPage.jsx` → `ReportsAnalyticsTab.jsx`, `UnsettledDeliveriesPage.jsx` → `UnsettledDeliveriesTab.jsx` so all 7 tab sub-components share the `*Tab.jsx` suffix and are visually distinguishable from real routed pages at a glance. This is a rename, not a folder move — listed here for completeness but belongs in Section 11 if pursued.

**Components that must NOT be moved into a `pages/` folder:**
- `src/components/layout/*` (`AdminLayout.jsx`, `CustomerLayout.jsx`, `Footer.jsx`, `PublicShell.jsx`, `Sidebar.jsx`) — these are chrome/shells, not routed pages.
- `src/components/auth/AuthHeroPanel.jsx` — a shared decorative panel used by 3 auth pages, not a page itself.
- All 50 files under `src/components/ui/` — generic building blocks (modals, spinners, field errors, toggles) used across every role.

---

## 9. Route → UI → File Master Mapping

| Route | UI Label | Role | Parent Module | Entry Point | Component | Current Path | Recommended Path | Status |
|---|---|---|---|---|---|---|---|---|
| `/` | — | — | — | direct URL | RootRedirect | `App.jsx` (inline) | no change | KEEP |
| `/track` | "Track Your Shipment" | Public | — | direct URL / Login footer "Track Package" | TrackingPage | `pages/public/TrackingPage.jsx` | no change | KEEP |
| `/about` | "About Us" / "Home" | Public | — | direct URL / Login footer "About Us" | AboutPage | `pages/public/AboutPage.jsx` | no change | KEEP |
| `/terms` | "Terms of Service" | Public | Legal Policies | Footer, Register consent | LegalPage (TermsPage) | `pages/public/LegalPage.jsx` | no change | KEEP |
| `/privacy` | "Privacy Policy" | Public | Legal Policies | Footer, Register consent | LegalPage (PrivacyPage) | `pages/public/LegalPage.jsx` | no change | KEEP |
| `/schedules` | "View Trip Schedules" | Public (reuses Customer file) | — | Footer "Quick Links" | TripsPage | `pages/customer/TripsPage.jsx` | Option B: `pages/shared/TripsPage.jsx` | REVIEW |
| `/faq` | "FAQs" | Public (reuses Customer file) | — | Footer "Quick Links" | HelpGuidelinesPage | `pages/customer/HelpGuidelinesPage.jsx` | Option B: `pages/shared/HelpGuidelinesPage.jsx` | REVIEW |
| `/login` | "Log In" | Public | — | Direct URL, PublicShell nav, TrackingPage footer "Sign In" | LoginPage | `pages/auth/LoginPage.jsx` | no change | KEEP |
| `/register` | "Sign Up" / "Create account" | Public | Login | Login page CTA, PublicShell nav "Sign Up" | RegisterPage | `pages/auth/RegisterPage.jsx` | no change | KEEP |
| `/forgot-password` | "Forgot password?" | Public | Login | Login page link | ForgotPasswordPage | `pages/auth/ForgotPasswordPage.jsx` | no change | KEEP |
| `/reset-password` | (email link only) | Public | Login → Password Recovery | Emailed reset link | ResetPasswordPage | `pages/auth/ResetPasswordPage.jsx` | no change | KEEP |
| `/payment/return` | (no visible label; system redirect) | Shared | Booking Details (payment) | PayMongo GCash return | PaymentReturnPage | `pages/shared/PaymentReturnPage.jsx` | no change | KEEP |
| `/customer` | "Home" | Customer | — | Logo, bottom-nav "Home" | HomePage | `pages/customer/HomePage.jsx` | no change | KEEP |
| `/customer/orders` | "Bookings" | Customer | — | Desktop nav, bottom-nav "Bookings" | OrdersPage | `pages/customer/OrdersPage.jsx` | no change | KEEP |
| `/customer/orders/:id` | (booking tracking #) | Customer | Bookings | Row click in Bookings | OrderDetailPage | `pages/customer/OrderDetailPage.jsx` | no change | KEEP |
| `/customer/book` | "Book Shipment" | Customer | — | Desktop nav, bottom-nav center FAB | BookShipmentPage | `pages/customer/BookShipmentPage.jsx` | no change | KEEP |
| `/customer/track` | "Track" (embedded) | Customer (reuses Public file) | Home | Home page tracking search box | TrackingPage (`embedded`) | `pages/public/TrackingPage.jsx` | no change | KEEP |
| `/customer/trips` | "Trips" | Customer | — | Desktop nav, bottom-nav "Trips" | TripsPage | `pages/customer/TripsPage.jsx` | see `/schedules` row | REVIEW |
| `/customer/notifications` | (bell icon) | Customer | — | Navbar bell icon | NotificationsPage | `pages/customer/NotificationsPage.jsx` | no change | KEEP |
| `/customer/profile` | "My Profile" / "Profile" | Customer | — | Avatar dropdown, bottom-nav "Profile" | ProfilePage | `pages/customer/ProfilePage.jsx` | no change | KEEP |
| `/customer/personal-info` | "Personal Info & Addresses" | Customer | Profile | Profile menu item | PersonalInfoPage | `pages/customer/PersonalInfoPage.jsx` | no change | KEEP |
| `/customer/change-password` | "Change Password" | Shared | Profile | Profile menu item | ChangePasswordPage | `pages/shared/ChangePasswordPage.jsx` | no change | KEEP |
| `/customer/change-email` | "Change Email" | Shared | Profile | Profile menu item | ChangeEmailPage | `pages/shared/ChangeEmailPage.jsx` | no change | KEEP |
| `/customer/support` | "Chat Support" | Customer | — | Desktop nav, mobile FAB, Profile → Help & Support | SupportChatPage | `pages/customer/SupportChatPage.jsx` | no change | KEEP |
| `/customer/payments` | "Payment History" | Customer | Profile | Profile menu item | PaymentHistoryPage | `pages/customer/PaymentHistoryPage.jsx` | no change | KEEP |
| `/customer/payment-methods` | — | Customer | — | old bookmarks/PWA cache only | `<Navigate>` | `App.jsx` (inline) | no change | LEGACY — KEEP as redirect |
| `/customer/help-guidelines` | "Help & Guidelines" | Customer | Profile | Profile menu item | HelpGuidelinesPage | `pages/customer/HelpGuidelinesPage.jsx` | see `/faq` row | REVIEW |
| `/customer/about-version` | "About & Version" | Customer | Profile | Profile menu item | AboutVersionPage | `pages/customer/AboutVersionPage.jsx` | no change | KEEP |
| `/admin` | "Dashboard" | Admin | — | Sidebar "Main" | DashboardPage | `pages/admin/DashboardPage.jsx` | no change | KEEP |
| `/admin/orders` | "Bookings" | Admin | — | Sidebar "Main" | OrdersPage | `pages/admin/OrdersPage.jsx` | no change | KEEP |
| `/admin/orders/:id` | (booking tracking #) | Admin | Bookings | Row click | OrderDetailPage | `pages/admin/OrderDetailPage.jsx` | no change | KEEP |
| `/admin/create-booking` | "Create Booking" | Admin | Bookings | "New Booking" button on list | AdminCreateBookingPage | `pages/admin/AdminCreateBookingPage.jsx` | no change | KEEP |
| `/admin/trips` | "Trips" | Admin | — | Sidebar "Main" | TripsPage | `pages/admin/TripsPage.jsx` | no change | KEEP |
| `/admin/trips/create` | "Create Trip" | Admin | Trips | "Create Trip" button on list | CreateTripPage | `pages/admin/CreateTripPage.jsx` | no change | KEEP |
| `/admin/trips/:id` | (trip number) | Admin | Trips | Row click | TripDetailPage | `pages/admin/TripDetailPage.jsx` | no change | KEEP |
| `/admin/customers` | "Customers" | Admin | — | Sidebar "Main" | CustomersPage | `pages/admin/CustomersPage.jsx` | no change | KEEP |
| `/admin/customers/:id` | (customer name) | Admin | Customers | Row click | CustomerDetailPage | `pages/admin/CustomerDetailPage.jsx` | no change | KEEP |
| `/admin/sales` | "Sales & Reports" (Sales Overview tab) | Admin | — | Sidebar "Management" | SalesReportsPage | `pages/admin/SalesReportsPage.jsx` (+ `SalesPage.jsx` tab) | rename tab file → `SalesOverviewTab.jsx` | REVIEW (naming only) |
| `/admin/reports` | "Sales & Reports" (Reports & Analytics tab) | Admin | — | Sidebar "Management" | SalesReportsPage | `pages/admin/SalesReportsPage.jsx` (+ `ReportsPage.jsx` tab) | rename tab file → `ReportsAnalyticsTab.jsx` | REVIEW (naming only) |
| `/admin/announcements` | "Announcements" | Admin | — | Sidebar "Management" | AnnouncementsPage | `pages/admin/AnnouncementsPage.jsx` | no change | KEEP |
| `/admin/inbox` | "Inbox" | Admin | — | Sidebar "Management" | InboxPage | `pages/admin/InboxPage.jsx` | no change | KEEP |
| `/admin/contact-inquiries` | "Inquiries" | Admin | — | Sidebar "Management" | ContactInquiriesPage | `pages/admin/ContactInquiriesPage.jsx` | no change | KEEP |
| `/admin/profile` | "Profile" | Admin | — | Sidebar footer profile dropdown | ProfilePage | `pages/admin/ProfilePage.jsx` | no change | KEEP |
| `/admin/change-email` | "Account Email" | Shared | Profile | Profile menu item | ChangeEmailPage | `pages/shared/ChangeEmailPage.jsx` | no change | KEEP |
| `/admin/change-password` | "Change Password" | Shared | Profile | Profile menu item | ChangePasswordPage | `pages/shared/ChangePasswordPage.jsx` | no change | KEEP |
| `/admin/activity-logs` | "Activity Logs" | Admin | — | Sidebar "Management" | ActivityLogsPage | `pages/admin/ActivityLogsPage.jsx` | no change | KEEP |
| `/admin/company-info` | "Company Information" | Admin | — | Sidebar "System" | CompanyInformationPage | `pages/admin/CompanyInformationPage.jsx` (+ 2 tab files) | no change | KEEP |
| `/admin/storage-monitoring` | "Storage Monitoring" | Admin | — | Sidebar "System" | StorageMonitoringPage | `pages/admin/StorageMonitoringPage.jsx` (+ 2 tab files) | no change | KEEP |
| `/admin/feedback` | "Customer Feedback" | Admin | — | Sidebar "Management" | FeedbackPage | `pages/admin/FeedbackPage.jsx` | no change | KEEP |
| `*` | 404 | Public | — | any unmatched URL | NotFoundPage | `pages/public/NotFoundPage.jsx` | no change | KEEP |

---

## 10. Program Hierarchy Impact

(For reference only — Chapter 2 itself is not being redrawn here.)

| Item | Real module or only a route? |
|---|---|
| **Trip Schedules** | Real, standalone **top-level Public module**. It is not an About-Us section and is not gated behind Login — confirmed via its own route + `PublicShell` wrapper + Footer link, independent of the Login page. |
| **Contact Us** | **Not a module** — an About-page anchor section only (`/about#contact`). |
| **Coverage Areas** | **Not a module** — an About-page anchor section only (`/about#coverage`). |
| **Password Recovery** | Real module, but a **child of Login**, not a peer of it — both the request step (`/forgot-password`) and the token step (`/reset-password`) only exist inside the Login → "Forgot password?" flow. |
| **Payment History** | Real page/route, but a **child of Profile** in the actual UI — no nav-bar or bottom-tab entry point exists; Profile is its only door. |
| **Chat Support** | Real **top-level Customer module** — it has its own persistent desktop-nav slot and mobile FAB; its appearance inside Profile → Help & Support is an additional shortcut to the same page, not a second feature. |
| **Notifications** | Real **top-level Customer module (utility)** — persistent bell icon with its own route and live badge, functioning like a nav item despite having no text label. |
| **Storage Monitoring** | Real **top-level Admin module** (Sidebar "System" section) with two genuine tab-children, Photo Storage and Email Service — must be present in the Program Hierarchy if it currently is not. |

---

## 11. Safe Reorganization Plan (proposed only — not executed)

No files were moved. If Option B from Section 8 is later approved, here is the exact, minimal plan:

### Move 1
- **FROM:** `src/pages/customer/TripsPage.jsx`
- **TO:** `src/pages/shared/TripsPage.jsx`
- **IMPORTS AFFECTED:** `src/App.jsx` — two import lines (`CustTripsPage` used for both `/customer/trips` and `/schedules`) would need their path updated from `./pages/customer/TripsPage` to `./pages/shared/TripsPage`.
- **ROUTES AFFECTED:** `/customer/trips`, `/schedules` (component reference only — URL paths do not change).
- **RISK:** LOW — a single component, only referenced from `App.jsx`; no other file imports `customer/TripsPage.jsx` directly (would need a final grep confirmation before executing).

### Move 2
- **FROM:** `src/pages/customer/HelpGuidelinesPage.jsx`
- **TO:** `src/pages/shared/HelpGuidelinesPage.jsx`
- **IMPORTS AFFECTED:** `src/App.jsx` — two import lines (`/customer/help-guidelines` and `/faq`).
- **ROUTES AFFECTED:** `/customer/help-guidelines`, `/faq` (component reference only).
- **RISK:** LOW — same profile as Move 1.

### Rename 1 (optional, naming clarity only)
- **FROM:** `src/pages/admin/SalesPage.jsx`, `ReportsPage.jsx`, `UnsettledDeliveriesPage.jsx`
- **TO:** `SalesOverviewTab.jsx`, `ReportsAnalyticsTab.jsx`, `UnsettledDeliveriesTab.jsx`
- **IMPORTS AFFECTED:** `src/pages/admin/SalesReportsPage.jsx` only (3 import statements).
- **ROUTES AFFECTED:** none (these files are never referenced from `App.jsx`).
- **RISK:** LOW — single consuming file, no route-level impact.

### Explicitly NOT recommended to move
- `src/pages/public/TrackingPage.jsx` — stays in `public/`; Customer's reuse via the `embedded` prop is normal downstream reuse, not evidence of misplacement.
- `src/pages/admin/OrdersPage.jsx` / `TripsPage.jsx` / `ProfilePage.jsx` / `OrderDetailPage.jsx` and their `customer/` namesakes — these are separate implementations, not duplicates; consolidating them is out of scope for a folder reorg and would be a much larger refactor with real behavioral risk.
- `/customer/payment-methods` legacy redirect — leave in place; removing it would 404 any customer with the old URL bookmarked, cached in the PWA shell, or in browser history (per the existing code comment).

**No HIGH or MEDIUM risk moves were identified.** Everything proposed above is LOW risk and touches at most two files each.

---

## 12. Risks and Files That Should Not Be Moved

- **`src/App.jsx`** — the single source of routing truth; any future move requires updating its import paths in the same commit as the file move, never separately.
- **`src/lib/routePreloads.js`** — hardcodes the import path `'../pages/customer/HomePage'` for prefetching; irrelevant to the two proposed moves above, but any future move of `HomePage.jsx` would need this file updated too.
- **`src/components/layout/*` and `src/components/auth/AuthHeroPanel.jsx`** — chrome/shell components, correctly outside `pages/`; do not fold into any pages folder during cleanup.
- **`src/components/ui/*`** (50 files) — generic cross-role primitives; out of scope for a pages-folder reorg entirely.
- **`/customer/payment-methods` redirect route** — keep permanently; it costs nothing and protects old bookmarks/cached PWA shells from a hard 404.
- **Any move touching `pages/admin/CompanyInformationPage.jsx`, `StorageMonitoringPage.jsx`, or `SalesReportsPage.jsx` and their tab files together** should be done as one atomic change per page (parent + its own tab files), never split across commits, since the parent hardcodes relative `./TabFileName` imports.

---

## Final Summary

```
ACTIVE ROUTES FOUND: 50
PUBLIC PAGES: 8      (AboutPage, LegalPage[Terms+Privacy], NotFoundPage, TrackingPage, LoginPage, RegisterPage, ForgotPasswordPage, ResetPasswordPage)
CUSTOMER PAGES: 12
ADMIN PAGES: 18      (routed pages only; +7 tab sub-components also live in admin/)
SHARED PAGES: 6      (3 in pages/shared/ + TrackingPage, TripsPage, HelpGuidelinesPage reused cross-role from their home folders)

MISPLACED FILES: 0
DUPLICATE/SHARED FILES: 3   (TripsPage.jsx, HelpGuidelinesPage.jsx, TrackingPage.jsx — cross-role reuse, not misplacement)
LEGACY ROUTES: 1            (/customer/payment-methods redirect)

CURRENT FOLDER ORGANIZATION:
GOOD

SAFE REORGANIZATION PLAN:
READY

TRIP SCHEDULES UI CLASSIFICATION:
TOP-LEVEL PUBLIC PAGE (standalone route under PublicShell, linked from Footer — NOT an About-Us section, confirmed independent of the Login page)

REPORT CREATED:
CARGOEXPRESS_PAGE_ROUTE_FOLDER_ORGANIZATION_AUDIT.md

FILES MOVED: NONE
ROUTES MODIFIED: NO
SOURCE CODE MODIFIED: NO
DATABASE MODIFIED: NO
```
