# Activity Logs — Analysis & Defense Guide

> **Purpose of this document**: Prepare the thesis panel defense for the Activity Logs module. Every claim is traced to a specific file in the codebase. Where runtime behaviour could not be verified in a browser, it is labelled **[UNVERIFIED — code inspection only]**.

---

## Executive Summary

Activity Logs is an **append-only operational audit trail** that records admin and select customer actions across the CargoExpress PH system. It is **not** a full forensic audit trail (it does not capture every database mutation), but it covers the actions that matter for daily operations: orders, trips, payments, chat, authentication, system settings, sales reports, and feedback moderation.

Key architectural highlights:

| Aspect | Implementation |
|---|---|
| **Storage** | `public.activity_logs` table in Supabase (Postgres) |
| **Logging origin** | ~60% frontend (via `logActivity()` + localStorage retry queue), ~40% database triggers |
| **Identity enforcement** | Server-side `guard_activity_log_insert()` trigger overwrites `admin_id`/`admin_name` from `auth.uid()` — unforgeable |
| **Deduplication** | `client_event_id` unique index prevents retry duplicates; payment dedup filter prevents trigger/client double-writes |
| **Permissions** | Only admins can **read** logs (RLS). Admins + authenticated users can **insert** (with identity guard). No UPDATE or DELETE policies exist |
| **Retention** | 7-day rolling window. `pg_cron` job runs daily at 03:00 UTC. **Only `activity_logs` is purged** — order history, payments, and shipment status events are permanent |
| **Live updates** | Supabase Realtime subscription + polling fallbacks (focus, visibility, 60s interval) |
| **Export** | CSV with all filtered records (not just current page), with formula-injection protection |

---

## 1. Architecture & Logging Flow

### 1.1 How a Log Entry Is Created

There are **two paths** that create activity log rows:

#### Path A: Frontend → localStorage Queue → `record_activity()` RPC

1. A helper function (e.g., `logOrder()`, `logAuth()`, `logTrip()`) is called from a page component.
2. `logActivity()` generates a UUID `eventId`, writes the event to a **localStorage queue** (`cargoexpress.activity-log.queue.v1`), then immediately attempts to flush.
3. `flushActivityLogQueue()` calls the **`record_activity()`** Postgres RPC for each queued event.
4. The RPC uses `ON CONFLICT (admin_id, client_event_id) DO NOTHING` to prevent duplicates.
5. The `guard_activity_log_insert` BEFORE INSERT trigger overwrites `admin_id` and `admin_name` from the real `auth.uid()` profile.

**File**: `src/lib/activityLog.js`

**Retry behaviour**: If the insert fails with a **transient** error (network failure, serialization conflict, rate limit), the event stays in the queue. If it fails with a **permanent** error (constraint violation, permission denied, P0001 exception), the event is **removed immediately** — it will not block the queue.

**File**: `src/lib/activityLog.js` — `isTransientError()` function (lines 86–101).

Flush triggers:
- On page load (session restore)
- On auth state change (login)
- On `online` event (network recovery)
- On `storage` event (cross-tab sync)
- On `visibilitychange` (tab refocus)
- Every 60 seconds (interval)

#### Path B: Database Triggers (Server-Side)

These triggers insert directly into `activity_logs` without going through the frontend:

| Trigger | Table | What it logs |
|---|---|---|
| `trigger_log_customer_chat` | `chat_messages` | Customer chat messages (module: Chat) |
| `payment_transactions_log_activity` | `payment_transactions` | All payments — pickup, delivery, PayMongo webhook (module: Payments) |
| `customer_feedback_log_visibility_activity` | `customer_feedback` | Admin hides/unhides a review (module: Feedback) |
| `trips_cascade_status_and_notify` | `trips` | Trip status changes cascade to order status changes (modules: Orders, Trips) |

Server-side RPCs that also insert logs:
- `request_order_cancellation()` — customer requests cancellation (module: Orders)
- `review_order_cancellation()` — admin approves/rejects cancellation (module: Orders)
- `update_order_contact_details()` — sender/receiver edit (module: Orders)

### 1.2 Complete List of Logged Actions

#### From Frontend Code (Client-Side)

| Module | Action | Source File |
|---|---|---|
| **Orders** | Booking Created | `BookShipmentPage.jsx:377` |
| **Orders** | Out-of-Coverage Booking Submitted | `BookShipmentPage.jsx:375` |
| **Orders** | Admin Booking Created | `AdminCreateBookingPage.jsx:307` |
| **Orders** | Status Changed to [X] | `OrderDetailPage.jsx:387` |
| **Orders** | Pickup Processed | `OrderDetailPage.jsx:415` |
| **Orders** | Delivery Proof Uploaded | `OrderDetailPage.jsx:427` |
| **Orders** | Assigned to Trip | `OrderDetailPage.jsx:437` |
| **Orders** | Trip Reassigned | `OrderDetailPage.jsx:447` |
| **Orders** | Booking Linked to Customer | `OrderDetailPage.jsx:461` |
| **Orders** | Order Cancelled | `OrderDetailPage.jsx:511` |
| **Orders** | Out-of-Coverage Request Approved/Rejected | `OrderDetailPage.jsx:564,578` |
| **Orders** | Featured/Removed from Website | `OrderDetailPage.jsx:613` |
| **Orders** | Customer Contacted | `OrderDetailPage.jsx:888` |
| **Orders** | Order Assigned (auto) | `database.js:792` |
| **Orders** | Status Changed (bulk via trip) | `database.js:2511` |
| **Trips** | Trip Created | `CreateTripPage.jsx:114` |
| **Trips** | Trip Rescheduled | `TripDetailPage.jsx:138` |
| **Chat** | Conversation Started / Admin Sent Message / Resolved | `InboxPage.jsx:505,546,593` |
| **Chat** | Inquiry Marked / Claimed / Released | `ContactInquiriesPage.jsx:180,220` |
| **Authentication** | User Logged In | `LoginPage.jsx:155` |
| **Authentication** | User/Admin Logged Out | `AuthContext.jsx:370` |
| **System** | Announcement Published / Deleted | `AnnouncementsPage.jsx:222,252` |
| **System** | Company Information Updated | `CompanyInformationPage.jsx:152` |
| **System** | Image Uploaded / Removed | `CompanyInformationPage.jsx:180,199` |
| **System** | Service Feature Added / Updated / Deleted | `CompanyInfoFeaturesTab.jsx:164,184` |
| **System** | Coverage Region/Municipality CRUD | `CompanyInfoCoverageTab.jsx:313-403` |
| **Sales & Reports** | Report Printed / Exported | `ReportsPage.jsx:63,72` |
| **Sales & Reports** | Sales Report Printed / Exported | `SalesPage.jsx:113,122` |
| **Sales & Reports** | Unsettled Deliveries Printed / Exported | `UnsettledDeliveriesPage.jsx:249,262` |

#### From Database Triggers (Server-Side)

| Module | Action | Trigger Source |
|---|---|---|
| **Chat** | Customer Started Conversation / Customer Sent Message | `log_customer_chat_message()` |
| **Payments** | Initial Payment Recorded / Payment Completed / Additional Payment Recorded | `log_payment_transaction_activity()` |
| **Feedback** | Feedback Hidden / Feedback Unhidden | `log_feedback_visibility_activity()` |
| **Orders** | Status Changed to [X] (from trip cascade) | `cascade_trip_status_and_notify()` |
| **Trips** | Trip [status] (from trip cascade) | `cascade_trip_status_and_notify()` |
| **Orders** | Cancellation Requested | `request_order_cancellation()` |
| **Orders** | Cancellation Approved / Rejected | `review_order_cancellation()` |
| **Orders** | [Actor] Updated Sender/Receiver Details | `update_order_contact_details()` |

### 1.3 What Is NOT Logged

- Profile edits (name, phone, address changes)
- Password or email changes
- Notification reads/dismissals
- Admin page views or searches
- Customer browsing, tracking lookups, or trip schedule views
- Direct database edits via Supabase dashboard
- `logSettings()` is defined but **never called** — no settings changes are audited
- `logPayment()` is defined in frontend but **never called** — payments are now exclusively logged by the database trigger

### 1.4 Customer vs Admin Actions

Both admin and customer actions are logged. The `guard_activity_log_insert()` trigger restricts customers to modules: `'Orders'`, `'Authentication'`, `'Chat'`. Customer-authored rows always show the customer's own name (identity is forced by the guard trigger).

However, the **Activity Logs page is admin-only** (RLS `SELECT` policy requires `is_admin()`). Customers cannot view any logs.

---

## 2. Search Bar — Detailed Behaviour

### 2.1 How Search Works

**File**: `src/lib/database.js` — `applyActivityLogFilters()` function.

```javascript
if (search) query = query.or(
  `action.ilike.%${search}%,record_ref.ilike.%${search}%,admin_name.ilike.%${search}%,details.ilike.%${search}%`
);
```

| Property | Behaviour |
|---|---|
| **Where it runs** | Database (Supabase PostgREST `.or()` with `.ilike`) |
| **Searched fields** | `action`, `record_ref`, `admin_name`, `details` |
| **NOT searched** | `module` (use the dropdown), `id`, `record_id`, `record_type`, `previous_value`, `new_value` |
| **Case sensitivity** | **Case-insensitive** (`ilike` = Postgres case-insensitive LIKE) |
| **Matching type** | **Partial/substring** (`%search%` wrapping) |
| **Scope** | All retained database records (not just the current page) |
| **Debounce** | 400ms after the user stops typing |
| **Race conditions** | Protected by `requestIdRef` — stale responses from old searches are discarded |
| **Pagination reset** | Search changes reset page to 1 |
| **Clear Filters** | Clears the search input and resets results |

### 2.2 Search Test Matrix

| Input | Expected Behaviour (from code) |
|---|---|
| `payment` | Matches any row where action, record_ref, admin_name, or details contains "payment" (case-insensitive) |
| `PAYMENT` | Same results as `payment` (ilike is case-insensitive) |
| `Pay` | Matches — partial substring match |
| `Marlon Sarong` | Matches rows where `admin_name` = "Marlon Sarong" |
| `CE-20260910-8863` | Matches rows where `record_ref` = "CE-20260910-8863" |
| `₱4,200` | Matches rows where `details` contains "₱4,200" |
| `  payment  ` | Spaces are included in the LIKE pattern — may miss edge matches. **Minor issue.** |
| `xyznonexistent` | Returns 0 entries |
| `payment` + Module=Orders | Returns rows matching BOTH conditions |
| `payment` + Hide sign in/out ON | Returns payment-matching rows excluding "Logged" actions |

---

## 3. Filters & Controls

### 3.1 Module Dropdown

| Display Label | Filter Value |
|---|---|
| All | (no filter) |
| Orders | `'Orders'` |
| Trips | `'Trips'` |
| Payments | `'Payments'` |
| Chat | `'Chat'` |
| Authentication | `'Authentication'` |
| System | `'System'` |
| Sales & Reports | `'Sales & Reports'` |
| Feedback | `'Feedback'` |

### 3.2 Hide Sign In/Out Checkbox

Hides any row where `action` contains "Logged" (case-insensitive):
- "User Logged In", "User Logged Out", "Admin Logged Out"
- **Default is ON**

### 3.3 Clear Filters

Resets: search text, module to "All", hide sign in/out to checked (true), page to 1.

### 3.4 "Entries Found" Count

Uses Supabase's `count: 'exact'` — returns **total matching rows in the database**, not just the current page.

### 3.5 Pagination

- Page size: 50 rows
- Ordering: `created_at DESC` (newest first)
- Filter changes reset to page 1

---

## 4. Table Fields Explained

| Column | Source | Notes |
|---|---|---|
| **Date & Time** | `created_at` (TIMESTAMPTZ) | Rendered in user's local timezone |
| **Admin** | `admin_name` (TEXT) | Server-enforced identity. Reflects name at time of action. Survives account deletion. |
| **Module** | `module` (CHECK-constrained) | Coloured badge with icon |
| **Action** | `action` (TEXT) | Description of what happened |
| **Reference** | `record_ref` (TEXT) | Tracking number, trip number, customer name, etc. Shows "—" if null |
| **Details** | `details` (TEXT) | Summary, clamped to 2 lines. May contain emails and amounts. No passwords logged. |

---

## 5. Live Updates

Uses **Supabase Realtime subscription** on `activity_logs` with 5 fallback mechanisms:

1. Realtime WebSocket (instant)
2. Window focus refresh
3. Visibility change refresh
4. Online event refresh
5. 60-second polling interval

All refreshes debounced to 250ms.

| State | Meaning | Visual |
|---|---|---|
| `live` | WebSocket confirmed | Green dot |
| `connecting` | Pending/reconnecting | Yellow dot |
| `offline` | No internet | Red dot |

---

## 6. Export CSV

- Exports **all matching records** (not just current page), in batches of 1,000
- Respects active search, module, and hide-logins filters
- Columns: Date & Time, Admin, Module, Action, Reference, Details
- Formula injection protection (prefixes dangerous cells with `'`)
- UTF-8 with BOM for Excel, `\r\n` line endings
- Filename: `activity-logs-YYYY-MM-DD.csv`
- Export disabled when total = 0

---

## 7. Permissions & Security

| Action | Who | Mechanism |
|---|---|---|
| **View** | Admins only | RLS SELECT: `USING (is_admin())` |
| **Insert** | Admins + authenticated users (own ID) | INSERT policies + guard trigger |
| **Update** | Nobody | No policy |
| **Delete** | Nobody (except purge job) | No policy; purge uses SECURITY DEFINER |

Identity Guard (`guard_activity_log_insert`):
1. Overwrites `admin_id` with `auth.uid()`
2. Overwrites `admin_name` from real profile
3. Restricts non-admin modules to Orders, Authentication, Chat
4. Deduplicates payment logs

---

## 8. Seven-Day Retention

```sql
DELETE FROM public.activity_logs WHERE created_at < now() - interval '7 days';
```

- Rolling 168-hour window (not calendar boundaries)
- `pg_cron` daily at 03:00 UTC (11:00 AM PHT)
- Permanent deletion — recovery requires database backup
- **Only `activity_logs` is purged** — orders, payments, shipment history are permanent

---

## 9. Confirmed Issues & Recommendations

| # | Issue | Severity |
|---|---|---|
| 1 | Search includes leading/trailing spaces in LIKE pattern | Low |
| 2 | Table sort lacks tiebreaker for identical timestamps | Low |
| 3 | `logSettings()` is defined but never called (dead code) | Info |

Potentially misleading labels:
- "Admin" column → could be "Performed By" (customer names appear here too)
- "Audit trail of admin actions" → customer actions are also logged

---

## 10. Defense Questions & Answers

**Q: What is the purpose of Activity Logs?**
A: Records every important action — who did it, when, what changed. For monitoring staff activity and investigating issues.
*Tagalog: Record ng lahat ng ginawa sa system — sino, kailan, at ano ang binago.*

**Q: What actions are recorded?**
A: Orders, Trips, Payments, Chat, Authentication, System settings, Sales reports, Feedback moderation.

**Q: What does the search bar search?**
A: Four fields: Action, Reference, Admin/Actor, and Details. NOT the Module column.

**Q: Why does searching "payment" return these records?**
A: Each matched row has "payment" in their Action or Details. Search is case-insensitive and partial.

**Q: Difference between search and module filter?**
A: Module filter = one category. Search = specific text across all categories. Can combine both.

**Q: What does "Hide sign in/out" do?**
A: Removes login/logout entries. On by default.

**Q: What does "entries found" count?**
A: All matching database records (within 7-day window), not just the current page.

**Q: What does "Live updates" mean?**
A: Real-time WebSocket connection. Page updates automatically. Green dot = active. 60-second polling backup.

**Q: What does Export CSV include?**
A: All records matching current filters. Protected against formula injection.

**Q: Why are logs kept for only seven days?**
A: Operational monitoring tool. Payment records and shipment history are permanent — never deleted.

**Q: Can an admin modify or delete logs?**
A: No. No UPDATE or DELETE permissions. Only automatic purge job can delete.

**Q: What happens if internet is interrupted?**
A: Events stored in browser localStorage. Auto-retried when internet returns. Unique IDs prevent duplicates.

**Q: Are payment records deleted after seven days?**
A: Absolutely not. Only Activity Logs are purged. Payments, shipment history, order data are permanent.

**Q: How do you know who performed an action?**
A: Database security trigger stamps every log with the real identity. Server overwrites any fake names.

**Q: Is this a complete audit trail?**
A: It is an operational activity history covering critical operations. Not forensic-grade, but sufficient for cargo logistics.

---

## 11. Unverified Areas (Manual Checks Needed)

| # | What to Verify | How |
|---|---|---|
| 1 | Live updates across tabs | Open in two tabs, create booking in one, check other updates |
| 2 | CSV opens in Excel/Sheets | Export, verify ₱ and ñ render correctly |
| 3 | Offline queue recovery | Disconnect WiFi, login, reconnect, check log appears |
| 4 | Purge job scheduled | `SELECT * FROM cron.job WHERE jobname = 'purge_old_activity_logs';` |
| 5 | Entries count matches export | Apply filter, note count, export CSV, count rows |
| 6 | Search with leading spaces | Compare " payment " vs "payment" results |

---

## File References

| File | Purpose |
|---|---|
| `src/pages/admin/ActivityLogsPage.jsx` | UI page component |
| `src/lib/activityLog.js` | Client-side logging library with offline queue |
| `src/lib/database.js` | Query functions (getActivityLogs, applyActivityLogFilters) |
| `supabase/migrations/20260621150000_activity_logs.sql` | Table creation, indexes, RLS |
| `supabase/migrations/20260730150000_activity_logs_7day_retention.sql` | Purge function + pg_cron |
| `supabase/migrations/20260804160000_activity_log_guard.sql` | Identity guard trigger |
| `supabase/migrations/20260902020000_complete_activity_log_module_coverage.sql` | Payment/feedback triggers, deduplication |
| `supabase/migrations/20260902030000_reliable_realtime_activity_logs.sql` | record_activity RPC, idempotency, realtime |

---

*Report generated: September 10, 2026. Based on code inspection of the CargoExpressPH repository.*
