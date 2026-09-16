# CargoExpress PH Chapter 2 Process Specification Audit

**Scope:** Read-only audit. No application code, database, Chapter 2 document, or diagram was modified while producing this report. Sources consulted: the live React application in this repository (`/Users/beasarong/Downloads/CargoExpressPH-main`), the current Chapter 2 draft (`~/Desktop/IMPORTANT FILE FOR THESIS FINALIZATION/Chapter 2 REVISED.docx`, last saved today), and two reference Chapter 2 samples (`~/Desktop/sample thesis/FINAL DOCUMENTATION (chapter2).pdf` and `~/Desktop/sample thesis/Ready for Burn chapter2.pdf`).

---

## 1. Reference Format Analysis

Both reference samples confirm the same Process Specification convention, and it is **module-based, not transaction-based**:

- Each top-level heading is a real screen/menu the user opens (e.g. "Dashboard," "Point of Sale," "Inventory," "Reports," "System Settings," "User Management" in one sample; "User Verification," "Cashier Dashboard," "Point of Sale," "Inventory," "Reports" in the other) — i.e., the sidebar/module label itself, not a database action like "insert order."
- Each module is one `Begin ... End` block containing plain, formal, user-facing verbs: *Display*, *Enter*, *Select*, *Click*, *Submit*, *If / Else / End If*.
- Sub-actions inside one module (e.g. Point of Sale's "Search Item," "Pending Orders," "Mode of Payment," "Pay and Print") are nested under the same `Begin/End`, not split into separate top-level processes — related screen sections stay grouped under their parent module.
- Detail level is moderate: field names and button labels are named, but no database tables, SQL, or internal code is ever mentioned.
- Multi-step admin workflows (e.g. meter reading → confirm → generate bill) are written as one flowing sequence of `If` blocks, not one process per button.

**Conclusion for CargoExpress PH:** the Process Specification section should have one heading per actual sidebar/menu item (per role), each containing every screen and sub-action that lives under that menu entry, written as `Begin/End` with `If/Else`, in plain user-facing language.

**REFERENCE FORMAT ANALYZED: YES**

---

## 2. Current Navigation / Sidebar Inventory

Traced directly from `src/App.jsx` (routing), `src/components/layout/Sidebar.jsx` (admin), `src/components/layout/CustomerLayout.jsx` (customer top nav + bottom tab bar + profile dropdown), `src/components/layout/PublicShell.jsx`, `src/pages/public/AboutPage.jsx` (public landing nav + in-page sections), and `src/components/layout/Footer.jsx` (the only place `/schedules`, `/faq`, `/terms`, `/privacy` are actually linked from).

### Program Hierarchy diagrams — current Chapter 2 draft (as embedded, not as intended)

The current draft contains three figure captions — "PROGRAM HIERARCHY (PUBLIC)," "PROGRAM HIERARCHY (CUSTOMER)," "PROGRAM HIERARCHY (ADMIN)" — but the embedded images do **not** match their captions:

| Caption in document | Image actually embedded there |
|---|---|
| Figure 28 — PROGRAM HIERARCHY (PUBLIC) | Shows the **Customer** hierarchy (Dashboard, Place Order, Orders, Trips, Chat Support, Notifications, Profile Management) |
| Figure 29 — PROGRAM HIERARCHY (CUSTOMER) | Shows the **Admin** hierarchy (Dashboard, Bookings, Trips, Customers, Sales & Reports, Announcements, Inbox Chat, Inquiries, Customer Feedback, Activity Logs, Company Information, Profile) |
| Figure 30 — PROGRAM HIERARCHY (ADMIN) | **No image is embedded at all** — the caption exists with no diagram beneath it. |

There is consequently **no diagram of the Public hierarchy anywhere in the document.** This is worth flagging to the adviser/panel independent of the Process Specification rewrite, since it affects the diagrams the panel will see, not just the text. This audit does not correct it (diagrams are out of scope), but the Program Hierarchy comparison below treats the mislabeled images as "old Customer diagram" and "old Admin diagram" by their actual content, not their caption.

### 2.1 Public / Guest navigation (unauthenticated)

| Item | Route | Where it's linked from |
|---|---|---|
| Home / About Us | `/about` | Brand logo, Footer, default guest destination |
| Track Your Cargo | `/track` | About page nav, Footer, Home hero |
| View Trip Schedules | `/schedules` (reuses the Trips page under a guest shell) | Footer only |
| FAQs | `/faq` (reuses Help & Guidelines under a guest shell) | Footer only |
| Contact Us | `/about#contact` (section on the About page, not a separate route) | About nav, Footer, Home hero CTA |
| Coverage Areas | `/about#coverage` (section) | Footer |
| Terms of Service | `/terms` | Footer, Register page |
| Privacy Policy | `/privacy` | Footer, Register page |
| Sign In / Sign Up | `/login`, `/register` | About nav, PublicShell header |
| Forgot / Reset Password | `/forgot-password`, `/reset-password` | Login page link, emailed link |

### 2.2 Customer navigation (authenticated, role = customer)

Desktop top nav (`CustomerLayout.jsx`): **Book Shipment, Bookings, Trips, Chat Support**, plus a notification bell and an avatar menu.
Mobile bottom tab bar: **Home, Bookings, Book, Trips, Profile.**
Profile page acts as a hub linking to: **Personal Info & Addresses, Change Password, Change Email, Payment History, Live Support Chat, Help & Guidelines, About & Version**, plus Dark Mode / Push Notifications / Email Announcements toggles and Sign Out.

| Sidebar/menu label | Route | Purpose |
|---|---|---|
| Home | `/customer` (index) | Dashboard: snapshot stats, next trip, announcements, active shipments, tracking search |
| Book Shipment | `/customer/book` | 5-step booking wizard |
| Bookings | `/customer/orders`, `/customer/orders/:id` | List + detail of the customer's own shipments |
| Trips | `/customer/trips` (same component as public `/schedules`) | Browse scheduled trips |
| Notifications | `/customer/notifications` | Notification center |
| Chat Support | `/customer/support` | Bot + human support chat |
| Payment History | `/customer/payments` | Read-only payment ledger |
| Profile | `/customer/profile` | Account hub |
| Personal Info | `/customer/personal-info` | Edit name/address/contact |
| Change Password | `/customer/change-password` | Shared component |
| Change Email | `/customer/change-email` | Shared component |
| Help & Guidelines | `/customer/help-guidelines` (same as public `/faq`) | FAQ / policies reference |
| About & Version | `/customer/about-version` | App/version info |
| (legacy) Payment Methods | `/customer/payment-methods` | Redirect only, kept for old links/bookmarks |

### 2.3 Administrator navigation (authenticated, role = admin)

From `Sidebar.jsx`, grouped exactly as rendered:

**Main** — Dashboard, Bookings, Trips, Customers
**Management** — Sales & Reports, Announcements, Inbox, Inquiries, Customer Feedback, Activity Logs
**System** — Company Information, Storage Monitoring
**Account menu (footer)** — Profile, Sign Out

| Sidebar label | Route | Purpose |
|---|---|---|
| Dashboard | `/admin` | Operational overview |
| Bookings | `/admin/orders`, `/admin/orders/:id` | All shipments; status tabs: All / Action Needed / Pending / Active / Completed / Cancelled |
| — Add Booking (button on Bookings page) | `/admin/create-booking` | Walk-in / guest booking |
| Trips | `/admin/trips`, `/trips/create`, `/trips/:id` | Trip scheduling and lifecycle |
| Customers | `/admin/customers`, `/customers/:id` | Registered customer directory |
| Sales & Reports | `/admin/sales`, `/admin/reports` (same page, 3 tabs) | Revenue, unsettled balances, analytics |
| Announcements | `/admin/announcements` | Publish/delete customer-facing notices |
| Inbox | `/admin/inbox` | Admin side of customer chat support |
| Inquiries | `/admin/contact-inquiries` | Public contact-form submissions |
| Customer Feedback | `/admin/feedback` | Review moderation |
| Activity Logs | `/admin/activity-logs` | Audit trail |
| Company Information | `/admin/company-info` | 5 tabs: Basic Info, Contact Info, Why Choose Us, Coverage Areas, Pricing |
| Storage Monitoring | `/admin/storage-monitoring` | 2 tabs: Photo Storage, Email Service (system health, not a business transaction) |
| Profile | `/admin/profile` | Admin account, links to Change Email/Change Password |

**PUBLIC MODULES FOUND: 10** (Home/About, Track Package, Trip Schedules, FAQ, Terms, Privacy, Login, Register, Forgot Password, Reset Password — Contact Us and Coverage counted as sections of Home/About, not separate routes)
**CUSTOMER SIDEBAR MODULES FOUND: 13**
**ADMIN SIDEBAR MODULES FOUND: 13**

---

## 3. Public Modules

| Module | Route | Purpose | Should have a Process Specification? |
|---|---|---|---|
| Home / About Us (incl. Our Story, Features, Coverage, Gallery, Reviews, Contact) | `/about` | Marketing landing page; the only place with a live Contact form | **YES** — the Contact form is a real transaction |
| Track Package | `/track` (guest) / embedded at `/customer/track` | Look up a shipment by tracking number, no account needed | **YES** |
| Trip Schedules | `/schedules` (guest) / `/customer/trips` | Browse upcoming trips and capacity | **YES**, one shared spec (see §9) |
| FAQ / Help & Guidelines | `/faq` (guest) / `/customer/help-guidelines` | Static reference content | Minimal only — no transaction |
| Terms of Service / Privacy Policy | `/terms`, `/privacy` | Static legal text | Minimal only — no transaction |
| Login / Register / Password Recovery | `/login`, `/register`, `/forgot-password`, `/reset-password` | Authentication | **YES** |

---

## 4. Customer Modules

| Module | Route | Purpose |
|---|---|---|
| Customer Home | `/customer` | Dashboard: stats, next trip, announcements, active shipments |
| Book Shipment | `/customer/book` | 5-step booking wizard (Route → Sender → Receiver → Package → Review) |
| Bookings | `/customer/orders`, `/customer/orders/:id` | List + detail; pay, request cancellation, leave feedback |
| Trips | `/customer/trips` | Browse scheduled trips, jump into booking |
| Notifications | `/customer/notifications` | Grouped, actionable notification center |
| Chat Support | `/customer/support` | Bot-first, escalates to a human admin |
| Payment History | `/customer/payments` | Read-only ledger (no payment action here) |
| Profile Management | `/customer/profile`, `/personal-info`, `/change-password`, `/change-email` | Account hub + edit forms |
| Help & Guidelines / About & Version | `/customer/help-guidelines`, `/customer/about-version` | Static reference, reached from Profile |

---

## 5. Administrator Modules

| Module | Route | Purpose |
|---|---|---|
| Dashboard | `/admin` | Read-only operational overview |
| Bookings Management | `/admin/orders`, `/admin/orders/:id` | List, filter, and process every shipment: assign to trip, weigh & record pickup payment, complete delivery, cancel/review cancellation, record/verify payment, reassign trip, review out-of-coverage pickups |
| Walk-in Booking | `/admin/create-booking` | Admin books on behalf of a guest/walk-in customer |
| Trip Management | `/admin/trips`, `/create`, `/:id` | Create trips; advance Scheduled → In Progress → Arrived → Completed; reschedule/cancel |
| Customer Management | `/admin/customers`, `/:id` | Directory + order history per customer |
| Sales & Reports | `/admin/sales`, `/admin/reports` | 3 tabs: Sales Overview, Unsettled Deliveries, Reports & Analytics |
| Announcements | `/admin/announcements` | Publish/delete customer-facing notices, optional email blast |
| Inbox | `/admin/inbox` | Take over bot conversations, reply to customers |
| Contact Inquiries | `/admin/contact-inquiries` | Review/resolve public contact-form messages |
| Customer Feedback | `/admin/feedback` | View, filter, hide/restore customer reviews |
| Activity Logs | `/admin/activity-logs` | Filterable audit trail, CSV export |
| Company Information | `/admin/company-info` | 5 tabs: Basic Info, Contact Info, Why Choose Us, Coverage Areas, Pricing |
| Storage Monitoring | `/admin/storage-monitoring` | System health (Photo Storage, Email Service) — not a customer-facing business process |
| Admin Profile | `/admin/profile` | Account, Change Email/Password |

---

## 6. Current Process Specification Problems

Classification of each of the 19 processes currently in the Chapter 2 draft:

| # | Current process | Classification | Reason |
|---|---|---|---|
| 1 | Tracking Process | **KEEP** (rename → "Track Package") | Matches a real module; rename only for consistency with the UI label |
| 2 | Customer Registration Process | **KEEP** | Matches the real 2-step wizard (Account → Address) almost exactly, legal consent included. Minor addition needed: the optional "email me announcements" checkbox is real but missing |
| 3 | Login Process | **KEEP** | Matches the real form and role-based redirect |
| 4 | Customer Home Page Process | **KEEP** (rename → "Customer Home / Dashboard") | Matches, but is missing the Announcements feed shown on this same page |
| 5 | Cargo Booking Process | **KEEP, NEEDS LOGIC CORRECTION** | **Outdated core behavior**: describes a GCash/PayMongo checkout happening during booking. The actual system never charges at booking — it only records a stated payment *preference*; the real cost is calculated later from the actual weighed parcel (see §12) |
| 6 | Payment Monitoring Process | **RENAME** → "Payment History" | Content is close to correct (read-only balances/history), just misnamed against the real sidebar label |
| 7 | Admin Trip Management Process | **KEEP, NEEDS LOGIC CORRECTION** | Only covers trip creation. Missing the entire Trip Detail lifecycle (Start Trip, Mark Arrived, Complete, Reschedule, Cancel) and its guard rules (a trip cannot start until all its cargo is picked up; cannot complete until all its cargo is delivered/cancelled and fully paid) |
| 8 | Admin Booking Management Process | **MERGE** (with #10 and #11, into one "Bookings Management") | Describes only the list/filter view; the real status-advancement flow lives on the Order Detail page, described separately (and incorrectly) in #10 |
| 9 | Admin-Assisted Guest Booking Process | **RENAME** → "Walk-in Booking" | Matches the real single-page form; rename to the actual page's working name |
| 10 | Admin Order Processing and Status Update Process | **MERGE, NEEDS LOGIC CORRECTION** | The real system has **no free-choice status dropdown**. Status advances through specific actions gated by business rules: "Assign to Trip," then "Process Pickup" (enter actual weight, record who pays, upload pickup photos), then "Complete Delivery" (collect remaining balance, upload delivery photos). "In Transit" and "Arrived at Hub" are set in bulk when the *trip* advances, not per order |
| 11 | Admin Payment Verification Process | **MERGE, OUTDATED FRAMING** | The real system has no manual pending-payment "Verify/Reject" queue as described. Payment is recorded directly by the admin (cash, at pickup or delivery) or auto-reconciled by the payment gateway (GCash) — there is no approve/reject decision screen matching this description |
| 12 | Password Recovery Process | **KEEP** | Matches the real 2-stage flow (email link → token verification → new password), minor detail additions possible (resend cooldown, expired-link handling) |
| 13 | Customer Feedback Submission Process | **MERGE** (into Bookings, customer side) | Feedback is submitted from inside the Order Detail screen for a Delivered order, not a separate page — keep as a sub-process, not a standalone one |
| 14 | Report Generation Process | **RENAME, NEEDS LOGIC CORRECTION** → "Sales & Reports" | The real module has three tabs (Sales Overview / Unsettled Deliveries / Reports & Analytics), each independently exportable; the draft implies one generic report screen |
| 15 | Public Contact Inquiry Process | **MERGE** (into Home/About Us) | The contact form is a section of the About page, not its own route |
| 16 | Managing Customer Accounts Process | **KEEP** (rename → "Customer Management") | Matches |
| 17 | Managing Company Information Process | **KEEP, NEEDS LOGIC CORRECTION** | Only 3 of the real 5 tabs are named (missing "Why Choose Us" and "Pricing") |
| 18 | Publishing Announcements Process | **KEEP, NEEDS LOGIC CORRECTION** | Missing the optional "notify by email" checkbox and the Delete action |
| 19 | Customer Support and Inbox Management Process | **RENAME / SPLIT** | Conflates two different modules for two different roles into one process. The real system is bot-first-then-human on the customer side (a distinct module, "Chat Support") and a queue with explicit states (`bot_active`, `waiting`, `waiting_customer`, `resolved`) on the admin side (a distinct module, "Inbox") |

**Entirely missing from the current 19 that the real system has as their own modules:** Admin Dashboard, Trip Detail lifecycle, Trip Schedules (customer/public "Trips" browsing), Notifications, Profile Management (Personal Info / Change Password / Change Email), Admin Customer Feedback (moderation side), Cancellation Request & Review, Storage Monitoring.

---

## 7. Database/Technical Language to Remove

Every implementation-specific line found in the current Process Specification section (lines 143–424 of the current draft):

| Current wording | Problem | Recommended thesis wording |
|---|---|---|
| "System updates order with **trip_id**" | Names a database column | "System records the assigned trip on the booking" |
| "System saves new status in **order_status_events database**" | Names a database table | "System records the status change in the shipment's tracking history" |
| "System updates **payment_status** to 'Paid' in **payment_transactions**" | Names a database column and table | "System marks the payment as verified" |
| "System updates **payment_status** to 'Rejected'" | Names a database column | "System marks the payment as rejected" |
| "If email exists in **the database**" | Generic "the database" | "If the email address is registered" |
| "System updates password in **profiles database**" | Names a database table | "System updates the account password" |
| "System saves feedback to **customer_feedback database**" | Names a database table | "System records the customer's feedback" |
| "System saves inquiry to **contact_inquiries database**" | Names a database table | "System records the inquiry" |
| "System updates **company_information database**" | Names a database table | "System saves the updated company information" |
| "System saves announcement to **announcements database**" | Names a database table | "System publishes the announcement" |
| "System saves message to **chat_messages database**" | Names a database table | "System sends the message" |

No occurrences of "Supabase," "RPC," "trigger," "Edge Function," "storage bucket," "Firebase," or "PayMongo internal IDs" were found written directly into the Process Specification section itself — the outdated *behavior* (GCash checkout at booking time) is the bigger problem there, not vendor-name leakage. (Those vendor names do appear elsewhere in Chapter 2 — in the Software Requirements and Cost-Benefit sections — but that is outside the Process Specification and outside this audit's scope.)

**DATABASE/TECHNICAL REFERENCES REMOVED FROM RECOMMENDED DRAFT: 11**

---

## 8. Recommended Module-Based Structure

One numbered sequence, grouped by role in this order — matching how the reference samples read (single running numbered list, not lettered sections) while still keeping Public → Customer → Admin as a natural reading order for a panel:

**A. Shared / Public** (Home & About Us, Track Package, Trip Schedules, Login, Customer Registration, Password Recovery, Legal Policies)
**B. Customer** (Customer Home, Book Shipment, Bookings, Notifications, Chat Support, Payment History, Profile Management)
**C. Administrator** (Dashboard, Bookings Management, Walk-in Booking, Trip Management, Customer Management, Sales & Reports, Announcements, Inbox, Contact Inquiries, Customer Feedback, Activity Logs, Company Information, Storage Monitoring, Admin Profile)

This mirrors both reference samples (one continuous numbered list) and the adviser's instruction to base structure on real modules/sidebar items rather than transactions.

---

## 9. Final Process Specification Module List

| # | Module | Role | Route | Spec? | Sub-processes included |
|---|---|---|---|---|---|
| 1 | Home & About Us | Public | `/about` | YES | Browse company info; submit Contact Us inquiry |
| 2 | Track Package | Public/Shared | `/track` | YES | Search by tracking number |
| 3 | Trip Schedules | Public/Shared | `/schedules`, `/customer/trips` | YES | Browse trips; jump to booking (customer only) |
| 4 | Login | Shared | `/login` | YES | Authenticate, role-based redirect |
| 5 | Customer Registration | Shared | `/register` | YES | 2-step account creation |
| 6 | Password Recovery | Shared | `/forgot-password`, `/reset-password` | YES | Email link → reset |
| 7 | Legal Policies | Public | `/terms`, `/privacy` | Minimal | Static display only |
| 8 | Customer Home | Customer | `/customer` | YES | Snapshot, next trip, announcements |
| 9 | Book Shipment | Customer | `/customer/book` | YES | 5-step booking wizard |
| 10 | Bookings | Customer | `/customer/orders(/:id)` | YES | View/filter list; pay balance; request cancellation; submit feedback |
| 11 | Notifications | Customer | `/customer/notifications` | YES | View, act on, clear notifications |
| 12 | Chat Support | Customer | `/customer/support` | YES | Bot Q&A, escalate to admin |
| 13 | Payment History | Customer | `/customer/payments` | YES | Read-only balances/history |
| 14 | Profile Management | Customer | `/customer/profile`, `/personal-info`, `/change-password`, `/change-email` | YES | Edit personal info, password, email |
| 15 | Admin Dashboard | Admin | `/admin` | YES | Read-only KPIs |
| 16 | Bookings Management | Admin | `/admin/orders(/:id)` | YES | Assign to trip, pickup weighing & payment, delivery & payment, cancellation review, record payment, reassign trip |
| 17 | Walk-in Booking | Admin | `/admin/create-booking` | YES | Book on behalf of a guest |
| 18 | Trip Management | Admin | `/admin/trips`, `/create`, `/:id` | YES | Create trip; Start/Arrived/Complete/Reschedule/Cancel |
| 19 | Customer Management | Admin | `/admin/customers(/:id)` | YES | Directory + history |
| 20 | Sales & Reports | Admin | `/admin/sales`, `/admin/reports` | YES | 3 tabs, export |
| 21 | Announcements | Admin | `/admin/announcements` | YES | Publish/delete, notify by email |
| 22 | Inbox | Admin | `/admin/inbox` | YES | Take over bot chats, reply |
| 23 | Contact Inquiries | Admin | `/admin/contact-inquiries` | YES | Review/resolve |
| 24 | Customer Feedback | Admin | `/admin/feedback` | YES | Filter, hide/restore reviews |
| 25 | Activity Logs | Admin | `/admin/activity-logs` | YES | Filter, export CSV |
| 26 | Company Information | Admin | `/admin/company-info` | YES | 5 tabs |
| 27 | Storage Monitoring | Admin | `/admin/storage-monitoring` | Minimal | System health, not a business transaction |
| 28 | Admin Profile | Admin | `/admin/profile` | Minimal | Links to Change Email/Password |

**Not given a standalone spec** (folded into the module above as a sub-process, per reference-sample precedent of not writing a full spec for pure static reads): Help & Guidelines/FAQ, About & Version.

**FINAL PROCESS SPECIFICATION MODULE COUNT: 28**

---

## 10. COMPLETE REVISED PROCESS SPECIFICATION DRAFT

### A. Shared / Public Processes

**1. Home & About Us**
```
Begin
    Display Company Overview (Our Story, Features, Coverage Areas, Gallery, Customer Reviews)
    If Visitor selects "Sign In"
        Redirect to Login Page
    End If
    If Visitor scrolls to Contact Us
        Display Contact Form
        Visitor enters Name, Mobile Number, Email Address, and Message
        Visitor optionally checks "Receive announcement updates by email"
        Click "Send Message"
        If input is valid
            System records the inquiry
            Display "Message sent! We will contact you soon."
        Else
            Display field validation errors
        End If
    End If
End
```

**2. Track Package**
```
Begin
    Display Tracking Search Box
    User enters Tracking Number
    Click "Track"
    If tracking number is valid and found
        Display Current Status, Route, and Package Details
        Display Shipment Journey Timeline and progress bar
        System automatically refreshes the tracking status
    Else
        Display "Shipment Not Found" message
    End If
    If repeated searches occur too quickly
        Display a temporary cooldown message
    End If
End
```

**3. Trip Schedules**
```
Begin
    Display list of scheduled trips with Route, Departure Date, and Available Capacity
    If User is not logged in and selects a trip
        Display "Log in to book this schedule" message
        Redirect to Login Page
    Else If Customer selects a trip
        Redirect to Book Shipment with the route and trip pre-selected
    End If
End
```

**4. Login**
```
Begin
    Display Login Form
    User enters Email Address and Password
    Click "Sign In"
    If credentials are valid
        If account role is Administrator
            Redirect to Admin Dashboard
        Else
            Redirect to Customer Home
        End If
    Else
        Display "Incorrect password or email" message
    End If
End
```

**5. Customer Registration**
```
Begin
    Display Registration Form — Account Step
    Customer enters Full Name, Facebook Name, Email Address, Mobile Number, Password, and Confirm Password
    Click "Continue to Address"
    If account input is valid
        Display Registration Form — Address Step
        Customer selects Province and City/Municipality
        Customer enters Barangay, Street, Lot/Block/Purok, and Landmark
        Customer checks "I agree to the Terms of Service and Privacy Policy" (required)
        Customer optionally checks "Email me announcements"
        Click "Create Account"
        If registration is successful
            System saves the account details
            Display "Account Created!" confirmation
            Redirect to Customer Home
        Else
            Display error message
        End If
    Else
        Display field validation errors
    End If
End
```

**6. Password Recovery**
```
Begin
    Display Email Input Form
    User enters Registered Email Address
    Click "Send Reset Link"
    If email is registered
        System sends a password reset link to the email
        Display "Check Your Inbox" confirmation
        If user clicks "Resend Email" before 60 seconds pass
            Display cooldown message
        End If
    Else
        Display "Email not found" message
    End If
    User opens the emailed link
    System verifies the reset link
    If link is invalid or expired
        Display "Link Expired or Invalid" message
        User may request a new link
    Else
        Display New Password and Confirm Password fields
        User enters New Password and Confirm Password
        Click "Update Password"
        If password meets requirements and both entries match
            System updates the account password
            Display "Password Updated!" confirmation
            Redirect to Login Page
        Else
            Display validation error
        End If
    End If
End
```

**7. Legal Policies**
```
Begin
    Display Terms of Service or Privacy Policy content
End
```

### B. Customer Processes

**8. Customer Home**
```
Begin
    Display greeting and booking summary (Total, Active, Delivered)
    System loads latest bookings, announcements, and the next available trip
    If a next available trip exists
        Display trip route, dates, and available capacity
        If Customer clicks "Book Cargo for This Trip"
            Redirect to Book Shipment with the route and trip pre-selected
        End If
    End If
    If announcements exist
        Display latest announcements with option to view and comment
    End If
    If active shipments exist
        Display active shipment cards
        If Customer selects a shipment
            Redirect to Order Detail
        End If
    End If
    If Customer enters a tracking number in the search box
        Click "Track"
        Redirect to Track Package
    End If
End
```

**9. Book Shipment**
```
Begin
    Display Route Step
    Customer selects Route
    Customer optionally selects a specific Trip
    Click "Continue"
    Display Sender Details Step
    Customer enters Sender Name, Mobile Number, Facebook Name, and Address
    Click "Continue"
    Display Receiver Details Step
    Customer enters Receiver Name, Mobile Number, Facebook Name, and Address
    Click "Continue"
    Display Package Details Step
    Customer describes the package, selects Who Pays, and optionally states a Payment Preference
    Click "Review Booking"
    Display Review & Confirm Step
    Customer reviews Route, Sender, Receiver, and Package details
    Click "Confirm Booking"
    If all required information is valid
        System saves the booking and generates a Tracking Number
        Display Success Page with Tracking Number
        (Note: no payment is collected here — final cost is confirmed once the parcel is weighed at pickup)
    Else
        Display validation error and return to the incomplete step
    End If
End
```

**10. Bookings**
```
Begin
    Display list of the Customer's bookings with status filters
    Customer searches or selects a booking
    Redirect to Order Detail
    Display Tracking Timeline, Sender/Receiver, Package Details, and Shipment Proof photos
    Display Payment Details (Shipping Cost, Paid, Balance, Method, Status)
    If a balance is owed and the shipment has been weighed and picked up
        Customer enters an amount to pay
        Click "Pay [amount] with GCash"
        System opens the GCash checkout
        If payment succeeds
            Display "Payment confirmed!" and update the balance
        Else
            Display payment failed/still-processing message with a retry option
        End If
    Else If the shipment has not yet been picked up and weighed
        Display "Payment will become available once your shipment has been picked up and weighed"
    End If
    If booking is still eligible for cancellation
        Click "Request Cancellation"
        Customer enters a reason
        System records the cancellation request
        Display "Cancellation request sent" message
    End If
    If booking status is "Delivered" and feedback has not yet been given
        Display "Leave a Review" prompt
        Customer selects a Star Rating and enters a message
        Click "Submit Feedback"
        If input is valid
            System records the feedback
            Display "Thank you for your feedback" message
        Else
            Display validation error
        End If
    End If
End
```

**11. Notifications**
```
Begin
    Display notifications grouped by date, each marked read or unread
    If Customer selects a notification
        If notification relates to a booking or trip
            Redirect to the related Bookings or Trips screen
        Else If notification is an announcement
            Display the full announcement and its comments
        End If
    End If
    If Customer clicks "Mark all read"
        System marks all notifications as read
    End If
    If Customer clicks "Clear all"
        Display confirmation prompt
        If confirmed
            System removes all notifications
        End If
    End If
End
```

**12. Chat Support**
```
Begin
    Display chat conversation window
    Customer enters a message
    Click "Send"
    System's automated assistant responds first
    If the assistant's answer helps
        Conversation continues with the assistant
    Else If Customer selects "Talk to an Admin" (or an urgent request is detected)
        System escalates the conversation to an administrator
        Display "Connecting you to an admin…" message
    End If
    If an administrator resolves the conversation and the Customer sends a new message soon after
        Conversation reopens with the same administrator
    Else
        A new message begins a fresh assistant session
    End If
End
```

**13. Payment History**
```
Begin
    Display Outstanding Balance, Total Paid, and Active Orders summary
    If open balances exist
        Display list of unpaid or partially paid bookings
        If Customer selects a booking
            Redirect to Order Detail
        End If
    End If
    If payment records exist
        Display Recent Payments list with Date, Order, Type, Amount, Method, and Status
        Customer may filter by month
        If Customer selects a payment
            Display payment detail (reference number, recorded by, notes)
        End If
    End If
End
```

**14. Profile Management**
```
Begin
    Display account summary and profile completion status
    If Customer selects "Personal Info & Addresses"
        Display current Full Name, Facebook Name, Mobile Number, and Address
        Customer edits fields
        Click "Save Changes"
        If input is valid
            System updates the profile
            Display "Profile updated successfully!" message
        Else
            Display validation error
        End If
    Else If Customer selects "Change Password"
        Customer enters Current Password, New Password, and Confirm Password
        Click "Update Password"
        If current password is correct and new password meets requirements
            Display success message
        Else
            Display error message
        End If
    Else If Customer selects "Change Email"
        Customer enters New Email Address and Current Password
        Click "Update Email"
        If input is valid
            Display "Check your new inbox" message
        Else
            Display error message
        End If
    Else If Customer selects "Help & Guidelines" or "About & Version"
        Display the corresponding reference content
    End If
    If Customer clicks "Sign Out"
        Display confirmation prompt
        If confirmed
            End session and redirect to Login Page
        End If
    End If
End
```

### C. Administrator Processes

**15. Admin Dashboard**
```
Begin
    Display Pending Bookings, Awaiting Departure, In Transit, and Active Trips counts
    Display current trip capacity gauge
    Display order status distribution chart
    Display Recent Orders list
    If Admin selects a recent order
        Redirect to Bookings Management
    End If
End
```

**16. Bookings Management**
```
Begin
    Display list of bookings with status tabs (All, Action Needed, Pending, Active, Completed, Cancelled)
    Admin searches or selects a status tab
    If Admin selects a booking
        Display booking details, tracking timeline, and payment summary
        If booking is unassigned
            Admin selects an available Trip
            Click "Assign to Trip"
            System marks the booking as Assigned
        End If
        If next step is pickup
            Click "Process Pickup"
            Admin enters the Actual Weight
            System displays the computed shipping cost (weight × rate per kilo)
            Admin selects Who Pays (Sender now, or Receiver on delivery)
            If Sender pays now
                Admin selects Full Payment or Pay Later, enters amount and payment method
            End If
            Admin attaches pickup photos
            Click "Confirm Pickup"
            If weight and photos are provided
                System records the weight, payment, and photos; marks the booking as Picked Up
            Else
                Display validation error
            End If
        End If
        If next step is delivery
            Click "Complete Delivery"
            If a balance remains
                Admin collects the remaining balance and payment method
            End If
            Admin attaches delivery photos
            Click "Complete Delivery"
            System marks the booking as Delivered
        End If
        (Note: "In Transit" and "Arrived at Hub" are set automatically for every booking on a trip when that trip's own status advances — see Trip Management)
        If a cancellation request is pending
            Admin reviews the customer's stated reason
            Click "Approve & Cancel" or "Decline"
            System updates the booking accordingly and notifies the customer
        End If
        If booking needs a later payment recorded
            Click "Record Payment"
            Admin enters amount, method, and optional reference/receipt
            System records the payment
        End If
        If booking needs to move to a different trip
            Admin selects a new Trip and enters a reason
            Click "Reassign"
        End If
        If booking was flagged for out-of-coverage pickup
            Admin reviews the request
            Click "Approve Request" or "Reject Request"
        End If
    End If
End
```

**17. Walk-in Booking**
```
Begin
    Display Booking Form
    Admin selects Route
    Admin enters Sender Details and Receiver Details
    Admin enters Package Details and states a Payment Preference
    Click "Create Booking"
    If input is valid
        System saves the booking, marks it as a walk-in booking, and generates a Tracking Number
        Display Success Message with Tracking Number
    Else
        Display validation error
    End If
End
```

**18. Trip Management**
```
Begin
    Display list of trips with Route, Date, and Capacity
    Click "Create Trip"
    Admin selects Route, enters Departure and Estimated Arrival dates, Capacity, and Amount per Kilo
    Admin optionally checks "Announce by email"
    Click "Create Trip"
    If input is valid and no duplicate trip exists
        System saves the new trip
        Display success message
    Else
        Display validation error
    End If
    If Admin opens a trip
        Display assigned bookings and capacity usage
        If trip status is Scheduled and every assigned booking has been picked up
            Click "Start Trip"
        Else
            Display reason the trip cannot start yet
        End If
        If trip status is In Progress
            Click "Mark Arrived"
        End If
        If trip status is Arrived and every assigned booking is Delivered or Cancelled and fully paid
            Click "Complete"
        Else
            Display reason the trip cannot be completed yet
        End If
        If Admin clicks "Reschedule"
            Admin enters new Departure/Arrival dates
        End If
        If Admin clicks "Cancel"
            Display confirmation prompt
        End If
    End If
End
```

**19. Customer Management**
```
Begin
    Display list of registered customers
    Admin searches by name, email, phone, or province
    If Admin selects a customer
        Display customer profile and booking history
    End If
End
```

**20. Sales & Reports**
```
Begin
    Display Sales & Reports Page with three sections: Sales Overview, Unsettled Deliveries, Reports & Analytics
    If Admin selects Sales Overview
        Display revenue totals, payment method breakdown, and monthly revenue chart
    Else If Admin selects Unsettled Deliveries
        Display bookings with an outstanding balance
    Else If Admin selects Reports & Analytics
        Admin selects a date range
        Display operational analytics for that range
    End If
    If Admin clicks "Export PDF" or "Print Report"
        System generates the report for the active section
        Prompt Admin to download or print
    End If
End
```

**21. Announcements**
```
Begin
    Display list of published announcements
    Click "New Announcement"
    Admin enters Title and Content, and selects or confirms a Category
    Admin optionally checks "Send Email"
    Click "Publish"
    If Title and Content are provided
        System publishes the announcement (and emails customers, if selected)
        Display success message
    Else
        Display validation error
    End If
    If Admin clicks "Delete" on an announcement
        Display confirmation prompt
        If confirmed
            System removes the announcement
        End If
    End If
End
```

**22. Inbox**
```
Begin
    Display list of customer conversations with status (Bot Active, Waiting, Waiting on Customer, Resolved)
    Admin selects a conversation
    Display message thread
    Admin enters a reply
    Click "Send"
    System delivers the reply and marks the conversation as Waiting on Customer
    If the customer replies again
        Conversation returns to Waiting
    End If
End
```

**23. Contact Inquiries**
```
Begin
    Display list of public contact-form submissions with status tabs
    Admin selects an inquiry
    Display inquiry details
    Click "Resolved" (or update status)
    System updates the inquiry status
End
```

**24. Customer Feedback**
```
Begin
    Display list of customer reviews with rating and message
    Admin filters by rating or searches
    If Admin clicks "Hide" on a review
        System hides the review from public display
    Else If Admin clicks "Restore"
        System makes the review visible again
    End If
End
```

**25. Activity Logs**
```
Begin
    Display log of Date & Time, Admin, Module, Action, and Details
    Admin filters by search text, by Module, or hides sign-in entries
    If Admin clicks "Clear Filters"
        System resets all filters
    End If
    If Admin clicks "Export CSV"
        System generates a CSV of the filtered log
    End If
End
```

**26. Company Information**
```
Begin
    Display Company Information Page with five tabs: Basic Info, Contact Info, Why Choose Us, Coverage Areas, Pricing
    Admin selects a tab and edits its fields
    Click "Save Changes"
    If input is valid
        System saves the updated company information
        Display "Changes saved successfully" message
    Else
        Display validation error
    End If
End
```

**27. Storage Monitoring**
```
Begin
    Display Photo Storage and Email Service health status
End
```

**28. Admin Profile**
```
Begin
    Display admin account information
    If Admin selects "Change Email" or "Change Password"
        (see Customer Profile Management — same shared screens)
    End If
End
```

---

## 11. Cross-Check Against Actual System

Every module above was verified against a route that exists in `src/App.jsx` and a page component that exists in the repository; every button/action named was confirmed in that component's source, not assumed. Points specifically re-verified per the adviser's concern:

- **Booking-time payment is confirmed absent.** `BookShipmentPage.jsx` has exactly 5 steps (Route, Sender, Receiver, Package, Review) and its submit handler (`handleSubmit`) only calls the order-creation step — there is no PayMongo/GCash call anywhere in that file. The success screen explicitly states: *"Final cost is confirmed when we weigh your parcel at pickup."*
- **Actual weighing happens at pickup, on the admin side.** The GCash/PayMongo integration is only ever invoked from two places: the customer's Order Detail "Pay Now" action (gated on the order already having `actual_weight > 0` and being in a post-pickup status) and the admin's Pickup/Delivery recording flow. This confirms the adviser's understanding: shipping cost is determined at pickup by weighing, not at booking.
- **No obsolete functionality was found still referenced** in the routes or sidebars — every route in `App.jsx` maps to a component that is reachable from the nav structures described above; no dead/legacy top-level page was found active (the one true legacy route, `/customer/payment-methods`, is a redirect stub kept only so old links don't 404 — it does not need its own spec entry, only the note already given in §2.2).
- **Status vocabulary verified** against `src/constants/status.js`: `Pending Review → Pending → Assigned → Picked Up → In Transit → Arrived at Hub → Out for Delivery → Delivered`, with `Pending Cancellation`/`Cancelled` as a side branch, and trip statuses `Scheduled → In Progress → Arrived → Completed`/`Cancelled`.
- **Company Information tab count verified as 5**, not the 3 implied by the current draft, by reading the tab components directly (`CompanyInfoFeaturesTab.jsx`, `CompanyInfoCoverageTab.jsx` are sub-tabs of Company Information; `EmailServiceTab.jsx` and `PhotoStorageTab.jsx` belong to the separate Storage Monitoring module, not Company Information).
- **Sales & Reports confirmed as one page, three tabs** (`SalesReportsPage.jsx`, switched by an `initialSection`/query-param, mounted at both `/admin/sales` and `/admin/reports`) — not two separate modules.

---

## 12. Chapter 2 Revision Instructions

1. Replace the current 19-process Process Specification section with the 28-module draft in §10, in the order given in §8 (Public/Shared → Customer → Administrator, one continuous numbered sequence to match the reference samples' style).
2. Remove every database/table/column reference listed in §7 and use the recommended wording.
3. Rewrite the Cargo Booking Process to remove the GCash/PayMongo checkout step during booking — this is the single most important correction. Booking ends with a tracking number and a stated payment preference only; no charge occurs there.
4. Add the new "Bookings Management" admin process (merging the old #8/#10/#11) so that pickup weighing, photo evidence, and payment collection appear in their real place — inside pickup and delivery processing, not a generic status dropdown or a payment-verification queue.
5. Add the previously-missing modules: Admin Dashboard, Trip Detail lifecycle rules, Trip Schedules (customer/public browsing), Notifications, Profile Management, Cancellation Request & Review, Admin Customer Feedback moderation.
6. Split the old "Customer Support and Inbox Management Process" into the customer-facing "Chat Support" module and the admin-facing "Inbox" module.
7. Update Company Information (5 tabs, not 3) and Sales & Reports (3 tabs of one page, not a single generic report).
8. Decide with the adviser whether Storage Monitoring warrants a full spec at all — it has no customer-facing business transaction, only system health status.
9. Independently of the Process Specification: flag to the panel/adviser that the Program Hierarchy figures (28/29/30) are mislabeled and the Public hierarchy diagram is missing entirely (§2), since the diagrams should be corrected alongside the text even though diagram editing is outside this audit's scope.

---

## Final Report Summary

```
REFERENCE FORMAT ANALYZED: YES

PUBLIC MODULES FOUND: 10
CUSTOMER SIDEBAR MODULES FOUND: 13
ADMIN SIDEBAR MODULES FOUND: 13

CURRENT PROCESS SPECS REVIEWED: 19

KEEP: 10
MERGE: 5
RENAME: 4
REMOVE/OUTDATED: 0 (content merged/corrected rather than deleted outright; the "Payment Verification" approve/reject framing is outdated and was folded into a corrected "record payment" sub-process)

DATABASE/TECHNICAL REFERENCES REMOVED FROM RECOMMENDED DRAFT: 11

FINAL PROCESS SPECIFICATION MODULE COUNT: 28

REPORT CREATED:
CARGOEXPRESS_CHAPTER2_PROCESS_SPECIFICATION_AUDIT.md

SOURCE CODE MODIFIED: NO
DATABASE MODIFIED: NO
CHAPTER 2 MODIFIED: NO
```
