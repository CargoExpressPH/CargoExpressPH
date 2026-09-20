# CargoExpress PH - Backend Automation and Retention Guide

This guide is designed as a read-only architectural overview for the CargoExpress PH thesis defense. It explains the "invisible" backend components that automate business rules, reconcile finances, and automatically delete or archive data.

## A. Beginner-Friendly Backend Glossary

For the panelists, here is how the different backend technologies function in this system:

*   **Supabase Edge Functions:** Small scripts hosted on global servers that run on-demand (like AWS Lambda). They are used when the system needs to securely talk to the outside world (like calling PayMongo, Resend for emails, or Firebase for push notifications) without exposing secret API keys to the user's browser.
*   **PostgreSQL Functions (RPCs):** Code that runs directly *inside* the database. They can be called from the frontend or Edge Functions to perform complex data updates securely in one step (e.g., `record_delivery_payment`).
*   **Database Triggers:** Automatic "tripwires" attached to database tables. If a row is inserted or updated, the trigger automatically fires a Postgres Function to do something else (e.g., automatically updating `remaining_balance` every time a payment row is added).
*   **Scheduled Jobs / pg_cron:** A time-based scheduler running inside the database. It wakes up at specific times (e.g., `0 3 * * *` which means 3:00 AM UTC) to perform maintenance, like deleting old photos or sending daily reminders.
*   **Webhooks:** A "reverse API" where an external service calls *our* system. E.g., when a GCash payment succeeds, PayMongo sends a webhook to our `paymongo-webhook` Edge Function to tell us it's done.
*   **RLS (Row Level Security):** Security rules inside the database that act as a bouncer. They ensure that even if someone figures out the database URL, they can only see or edit rows that belong to them or that they have admin rights to.

## B. Backend Architecture Overview

The backend operates on a strict **Database-Centric** and **Event-Driven** architecture:

1.  **Frontend Clients** (Browser/App) never calculate critical financial balances. They simply submit requests (e.g., "Add Payment").
2.  **RPCs and Triggers** handle all financial math safely under database locks, preventing race conditions if two admins click "Pay" at the exact same millisecond.
3.  **Edge Functions** handle external integrations. They run securely on Supabase infrastructure and use stored secrets (in Supabase Vault or environment variables).
4.  **pg_cron** handles time-based automation, running directly on the database engine.

## C. Edge Function Catalog

These 19 Edge Functions handle the application's external communication and background logic:

### 1. Payment Processing (PayMongo)
*   **`paymongo-create-payment`**: Called by the customer UI. Takes a PayMongo source/intent ID and attempts to finalize a GCash checkout. Interacts with the PayMongo API.
*   **`paymongo-webhook`**: Public endpoint. Called by PayMongo automatically when a customer payment succeeds or fails asynchronously. Triggers database updates to record the payment.
*   **`paymongo-refund`**: Called by admins. Submits a refund request to PayMongo and records the initial refund attempt in the database.
*   **`paymongo-refund-recovery`**: Scheduled/background job. Sweeps the database for "pending" or "processing" PayMongo refunds and queries the PayMongo API to see if they finally succeeded or failed, automatically updating the ledger.
*   **`record-manual-refund`**: Called by admins. Records a manual return of cash or GCash without hitting PayMongo. Secures the process by strictly enforcing single-session admin authentication limits and checking GCash reference uniqueness.

### 2. Notifications & Communication (Resend & Firebase)
*   **`send-push`**: Called by database triggers via HTTP or queued jobs. Connects to Firebase Cloud Messaging (FCM) and Apple Push Notification service (APNs) to send real-time alerts to mobile phones and browsers.
*   **`process-push-deliveries`**: Scheduled job. Sweeps the `notification_delivery_jobs` table and attempts to deliver any queued push notifications that failed their first attempt.
*   **`broadcast-announcement`**: Called by admins. Connects to the Resend API to blast marketing emails/announcements to subscribed customers.
*   **`process-daily-reminders`**: Scheduled job. Checks for overdue shipments and automatically sends email reminders via Resend API to customers.
*   **`email-trip-reschedule`**: Triggered automatically when an admin reschedules a trip. Blasts emails via Resend API to all customers affected by the delay.
*   **`submit-inquiry`**: Called by the public website. Submits a contact form payload.
*   **`unsubscribe-announcements`**: Public endpoint. Allows users to click "Unsubscribe" in marketing emails and instantly updates their preferences in the database.

### 3. Storage & Cleanup
*   **`archive-expired-evidence-photos`**: Scheduled job. Moves photos from active storage buckets to an archive or deletes them based on retention policies.
*   **`delete-storage-photos`**: Scheduled job/Helper. Hard-deletes actual files from Supabase Storage buckets to save costs.
*   **`photo-storage-health`**: Scheduled job. Checks if the storage buckets match the database records and logs discrepancies.
*   **`record-photo-storage-event`**, **`delete-photo-fallback`**, **`get-photo-fallback`**, **`store-photo-fallback`**: Internal functions used to manage base64 fallback images when standard storage has issues.

## D. RPC / Database Trigger Catalog

The database handles business logic automatically using triggers.

### Core Automation Triggers
*   **Payment Ledger Updates (`update_order_payment_totals`)**: Whenever a row is added, updated, or deleted in `payment_transactions` or `payment_refunds`, this trigger fires immediately. It recalculates `amount_paid`, `refunded_amount`, and `remaining_balance` on the main `orders` table. **This is why the frontend never calculates balances.**
*   **Booking Lifecycle (`orders_status_update`)**: When an order transitions to `Out for Delivery`, a trigger automatically locks the contact details (preventing the customer from changing their address while the truck is driving). When it hits `Delivered`, it sets the `delivered_at` timestamp.
*   **Stale Conversations (`chat_messages_maintain_service_state`)**: Updates the `conversations` table's status (`waiting`, `bot_active`, `open`) based on who sent the last chat message (customer vs. admin) and resets SLA timers.

## E. Scheduled Jobs and Background Processes (pg_cron)

The backend runs on an automated heartbeat. These pg_cron schedules were found active in the migrations:

| Job Name | Schedule | Purpose |
| :--- | :--- | :--- |
| `scheduled_old_photo_cleanup` | `30 1 * * *` (Daily 1:30 AM) | Triggers the Edge Function to archive or delete old proof-of-delivery photos to save server space. |
| `photo_storage_health_check` | Varies | Checks integrity between database records and actual files. |
| `daily_payment_reminders` | Varies | Scans for unsettled deliveries and emails reminders to customers via Resend. |
| `process_push_deliveries` | Varies | Retries failed push notification deliveries. |
| `purge_old_notification_delivery_jobs` | Varies | Hard deletes push notification logs older than 30 days. |
| `purge_old_activity_logs` | `0 3 * * *` (Daily 3:00 AM) | Hard deletes system audit logs older than 7 days. |
| `auto_resolve_stale_conversations` | `30 3 * * *` (Daily 3:30 AM) | Closes customer support chats that have been inactive for over 7 days. |
| `paymongo_refund_recovery` | Varies | Re-checks stuck PayMongo refunds to see if they finally settled overnight. |

## F. Automatic Deletion and Retention Matrix

CargoExpress PH implements strict automatic deletion to comply with data privacy and save database space.

| Data Type | Retention Period | Deletion Mechanism | Hard Delete or Archive? |
| :--- | :--- | :--- | :--- |
| **System Activity Logs** | 7 Days | `purge_old_activity_logs` (pg_cron) | **HARD DELETE** (`DELETE FROM activity_logs`) |
| **Push Notification Logs** | 30 Days | `purge_old_notification_delivery_jobs` | **HARD DELETE** (`DELETE FROM notification_delivery_jobs`) |
| **Stale Chat Threads** | 7 Days of Inactivity | `auto_resolve_stale_conversations` | **ARCHIVE** (Status changes to `resolved`, data kept) |
| **Proof of Delivery Photos** | Dynamic (Admin Configured, likely 30-90 Days) | `evidence_photo_archive` / `scheduled_old_photo_cleanup` | **HARD DELETE** from DB and Supabase Storage |
| **Authentication Sessions** | Browser-dependent | Supabase Auth JWT Expiry | Expiry / Session Revocation |
| **Bookings & Payments** | Indefinite | None | Kept indefinitely for financial auditing. |

**Important Note for Panelists:** Hard deletions cannot be undone unless the database is restored from a Point-in-Time Recovery (PITR) backup managed in the Supabase Dashboard.

## G. External Integrations and Failure Handling

1.  **PayMongo (Payments):** Handled via standard API calls and asynchronous Webhooks. If a webhook fails to arrive, the payment stays "processing" in the UI. 
2.  **Resend (Emails):** Used for bulk announcements and automated reminders. Edge functions use the `/emails/batch` endpoint. If Resend is down, the function logs an error, but the core booking system continues to work.
3.  **Firebase/APNs (Push Notifications):** Uses service account JSON configured as `FIREBASE_SERVICE_ACCOUNT_B64`. If a token expires or Firebase rejects the request (e.g., user uninstalled the app), the Edge Function marks the token as invalid so the system stops attempting to message it.

## H. Important Operational Risks and Unknowns

*   **Silent Deletions:** Activity logs literally vanish after 7 days. If a security incident needs investigation, it must be reported within that week.
*   **Webhook Dependency:** If PayMongo is experiencing outages, online checkouts might succeed on the customer's phone but fail to record in the database instantly. The admin would have to manually verify the PayMongo dashboard.
*   **Manual Refund Reconciliation:** While the system allows cancelling a booking with money tied to it, it is up to the admin to physically initiate the refund (either via the PayMongo integration or manually returning cash/GCash) and record it using the "Record Manual Refund" button.

## I. Thesis Defense FAQ

**Q: How do you prevent two admins from recording the same GCash payment twice?**
*A: We use Idempotency Keys and Database Locks. The `record_delivery_payment` RPC locks the `orders` row (`FOR UPDATE`) so concurrent clicks are forced into a line. The system also checks if the exact same GCash Reference Number was already used (`transaction_reference_normalized` UNIQUE constraint).*

**Q: Where are the remaining balances computed?**
*A: They are computed automatically on the backend using Database Triggers (`update_order_payment_totals`), NOT in the React frontend. This ensures that the math is 100% accurate and tamper-proof.*

**Q: Do you keep images forever?**
*A: No. We have a pg_cron scheduled job running at 1:30 AM (`scheduled_old_photo_cleanup`) that triggers an Edge Function to hard-delete expired proof-of-delivery photos from the Supabase Storage bucket based on our retention settings, saving us bandwidth and storage costs.*
