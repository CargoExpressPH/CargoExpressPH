# CargoExpressPH — Module Coverage Checklist

Layunin ng file na ito: patunayan na walang page/module na na-skip sa scan, at ipakita kung gaano kasigurado (evidence level) ang bawat entry. Legend:
- ✅ = Directly read/confirmed in code this pass
- 🟡 = Confirmed exists, summarized from imports/grep, not read line-by-line
- 🔵 = Proposed/not implemented (confirmed by explicit search)
- ⚪ = Could not verify

| Page / Module | Route | Files inspected | Complete Guide section | Evidence level | Remaining gaps |
|---|---|---|---|---|---|
| Root redirect | `/` | `src/App.jsx` | §1, §4 | ✅ | none |
| Public tracking | `/track` | `src/pages/public/TrackingPage.jsx` | §4.1, §5.12 | ✅ | none |
| About / company info | `/about` | `src/pages/public/AboutPage.jsx` | §4.1 | ✅ | none |
| Terms of Service | `/terms` | `src/pages/public/LegalPage.jsx` | §4.1, §5.1 | ✅ | none |
| Privacy Policy | `/privacy` | `src/pages/public/LegalPage.jsx` | §4.1 | ✅ | none |
| Public schedules | `/schedules` | `src/pages/customer/TripsPage.jsx` (reused) | §4.1, §4.3 | ✅ | none |
| Public FAQ | `/faq` | `src/pages/customer/HelpGuidelinesPage.jsx` (reused) | §4.1, §4.3 | 🟡 | static content, not deep-read |
| 404 | `*` | `src/pages/public/NotFoundPage.jsx` | §4.1 | ✅ | none |
| Login | `/login` | `src/pages/auth/LoginPage.jsx`, `AuthContext.jsx` | §4.2, §5.1 | ✅ | none |
| Register | `/register` | `src/pages/auth/RegisterPage.jsx`, `AuthContext.jsx` | §4.2, §5.1 | ✅ | none |
| Forgot password | `/forgot-password` | `src/pages/auth/ForgotPasswordPage.jsx` | §4.2, §5.2 | ✅ | none |
| Reset password | `/reset-password` | `src/pages/auth/ResetPasswordPage.jsx` | §4.2, §5.2 | ✅ | none |
| Payment return | `/payment/return` | `src/pages/shared/PaymentReturnPage.jsx` | §4.5, §5.11 | ✅ | uses direct `supabase.from()` calls, not fully via `database.js` — flagged inconsistency |
| Customer home | `/customer` | `src/pages/customer/HomePage.jsx` | §4.3 | ✅ | none |
| Customer orders list | `/customer/orders` | `src/pages/customer/OrdersPage.jsx` | §4.3 | ✅ | none |
| Customer order detail | `/customer/orders/:id` | `src/pages/customer/OrderDetailPage.jsx` (1,343 lines) | §4.3, §5.13, §5.14 | ✅ | none |
| Book shipment | `/customer/book` | `src/pages/customer/BookShipmentPage.jsx`, `bookingDraft.js` | §4.3, §5.7 | ✅ | none |
| Customer track (embedded) | `/customer/track` | `TrackingPage.jsx` (embedded mode) | §4.3 | ✅ | none |
| Customer trips | `/customer/trips` | `src/pages/customer/TripsPage.jsx` | §4.3, §5.8 | ✅ | none |
| Notifications inbox | `/customer/notifications` | `src/pages/customer/NotificationsPage.jsx` | §4.3, §5.17 | ✅ | none |
| Profile settings | `/customer/profile` | `src/pages/customer/ProfilePage.jsx` | §4.3 | 🟡 | no direct `database.js` import found; likely via `AuthContext` |
| Personal info | `/customer/personal-info` | `src/pages/customer/PersonalInfoPage.jsx` | §4.3 | ✅ | none |
| Change password (shared) | `/customer/change-password` | `src/pages/shared/ChangePasswordPage.jsx` | §4.5, §5.2 | ✅ | none |
| Change email (shared) | `/customer/change-email` | `src/pages/shared/ChangeEmailPage.jsx` | §4.5, §5.2 | ✅ | DB trigger for email sync post-`USER_UPDATED` not independently verified |
| Support chat | `/customer/support` | `src/pages/customer/SupportChatPage.jsx`, `supportChatEngine.js` | §4.3, §5.15 | ✅ | none |
| Payment history | `/customer/payments` | `src/pages/customer/PaymentHistoryPage.jsx` | §4.3 | ✅ | none |
| Legacy payment-methods redirect | `/customer/payment-methods` | `App.jsx` (Navigate) | §4.3 | ✅ | none — intentional redirect, not a real page |
| Help/guidelines (auth) | `/customer/help-guidelines` | `src/pages/customer/HelpGuidelinesPage.jsx` | §4.3 | 🟡 | static content |
| About/version | `/customer/about-version` | `src/pages/customer/AboutVersionPage.jsx` | §4.3 | 🟡 | static content |
| Admin dashboard | `/admin` | `src/pages/admin/DashboardPage.jsx` | §4.4 | ✅ | none |
| Admin orders list | `/admin/orders` | `src/pages/admin/OrdersPage.jsx` | §4.4 | ✅ | none |
| Admin order detail | `/admin/orders/:id` | `src/pages/admin/OrderDetailPage.jsx` (1,677 lines) | §4.4, §5.9, §5.10, §5.12 | ✅ | none — largest, most-critical page |
| Admin create booking | `/admin/create-booking` | `src/pages/admin/AdminCreateBookingPage.jsx` | §4.4, §5.7 | ✅ | none |
| Admin trips list | `/admin/trips` | `src/pages/admin/TripsPage.jsx` | §4.4 | ✅ | none |
| Create trip | `/admin/trips/create` | `src/pages/admin/CreateTripPage.jsx` | §4.4, §5.8 | ✅ | none |
| Trip detail | `/admin/trips/:id` | `src/pages/admin/TripDetailPage.jsx`, `RescheduleTripModal.jsx` | §4.4, §5.8 | ✅ | none |
| Customers list | `/admin/customers` | `src/pages/admin/CustomersPage.jsx` | §4.4 | ✅ | none |
| Customer detail | `/admin/customers/:id` | `src/pages/admin/CustomerDetailPage.jsx` | §4.4 | ✅ | none |
| Sales overview | `/admin/sales` | `src/pages/admin/SalesReportsPage.jsx`, `SalesPage.jsx` | §4.4, §8.7 | 🟡 | exact tab-composition JSX of `SalesReportsPage.jsx` not read in full |
| Financial reports | `/admin/reports` | `src/pages/admin/SalesReportsPage.jsx`, `ReportsPage.jsx` | §4.4, §8.4-8.7 | 🟡 | same caveat as above |
| Unpaid shipments | (sub-view, not separately routed) | `src/pages/admin/UnpaidShipmentsPage.jsx` | §5.13, §6 | ✅ | not confirmed whether it's a distinct route or a tab inside `SalesReportsPage.jsx` |
| Announcements | `/admin/announcements` | `src/pages/admin/AnnouncementsPage.jsx` | §4.4, §5.16 | ✅ | none |
| Support inbox (admin) | `/admin/inbox` | `src/pages/admin/InboxPage.jsx` | §4.4, §5.15 | ✅ | none |
| Contact inquiries | `/admin/contact-inquiries` | `src/pages/admin/ContactInquiriesPage.jsx` | §4.4, §5.5, §6 | ✅ | confirmed: no resolution-notes field exists |
| Admin profile | `/admin/profile` | `src/pages/admin/ProfilePage.jsx` | §4.4 | ⚪ | no `database.js` import found via grep |
| Admin change email/password | `/admin/change-email`, `/admin/change-password` | `src/pages/shared/*` | §4.5 | ✅ | none |
| Activity logs | `/admin/activity-logs` | `src/pages/admin/ActivityLogsPage.jsx` | §4.4, §7.4 | ✅ | none |
| Company information CMS | `/admin/company-info` | `CompanyInformationPage.jsx`, `CompanyInfoCoverageTab.jsx`, `CompanyInfoFeaturesTab.jsx` | §4.4, §3.1 | ✅ | none |
| Storage monitoring | `/admin/storage-monitoring` | `StorageMonitoringPage.jsx`, `PhotoStorageTab.jsx` | §4.4, §5.18 | ✅ | none |
| Feedback moderation | `/admin/feedback` | `src/pages/admin/FeedbackPage.jsx` | §4.4, §5.14 | ✅ | none |

## Non-page modules also covered

| Module | Files | Guide section | Evidence level |
|---|---|---|---|
| Authentication context | `src/contexts/AuthContext.jsx` | §5.1, §5.3, §9 | ✅ |
| Data-access layer | `src/lib/database.js` | §3.1(d) | ✅ |
| Supabase client wrapper | `src/lib/supabase.js` | §2.3 | ✅ |
| Booking draft privacy | `src/lib/bookingDraft.js` | §5.7, §9.13 | ✅ |
| Status/business-rules constants | `src/constants/status.js` | §6 | ✅ |
| Service worker | `public/sw.js`, `vite.config.js` | §1.5, §10 | ✅ |
| 18 Edge Functions | `supabase/functions/*` | §5, §9.6 | ✅ (all 18 individually confirmed) |
| Database schema (18+ tables) | `supabase/migrations/*.sql` | §7 | ✅ |
| Payment/discount/report calculations | migrations + `database.js` | §8 | ✅ |
| Refund functionality | `payment_refunds` table, `paymongo-refund*` functions | §8.10 | ✅ (implemented scope), 🔵 (manual refund — confirmed not implemented) |

## Explicitly searched and confirmed NOT implemented

- **Manual/cash refund or "charge-correction" workflow** — 🔵 zero matches in application/migration code; exists only as a proposal in `audit_reports/DISCOUNT_OVERPAYMENT_REFUND_AUDIT.md` and `audit_reports/F-006-refund-reconciliation-gap.md`.
- **Resolution-notes field on contact inquiries** — 🔵 no such column/UI field exists; only claim/release/resolve-ownership gating is real.
- **Separate `cleanup-orphaned-photos` Edge Function** — 🔵 removed; its job was absorbed into `delete-storage-photos`.

## Items flagged ⚪ unknown / needs direct follow-up before citing in defense

1. Exact composition of `SalesReportsPage.jsx` — whether `SalesPage.jsx`/`ReportsPage.jsx`/`UnpaidShipmentsPage.jsx` are literally its child tabs (not directly routed in `App.jsx`, so likely, but not read line-by-line).
2. `src/pages/admin/ProfilePage.jsx` — no `database.js` import found; unclear how it persists changes.
3. Exact pg_cron schedule expressions for `paymongo-refund-recovery` and `process-push-deliveries` (confirmed cron-driven, cadence not opened).
4. Whether a DB trigger syncs `profiles.email` after a Supabase Auth `USER_UPDATED` email-change event.
5. Exact wording of trip-capacity re-enforcement in migration `20260909094000_restore_trip_capacity_enforcement.sql` (confirmed it exists, not diffed line-by-line against the earlier removal).
6. Whether any dedicated "session expired" UI banner exists distinct from the generic `SIGNED_OUT` → redirect path.
7. Live production deployment status of the newest migration (`20260917100000_public_trip_reschedule_broadcast.sql`) — this research pass had no live Supabase access; confirmed only that it exists correctly in the local codebase.
