# CHAPTER 2 CURRENT DATABASE DESIGN HANDOFF

## 1. Current Database State (Verified Live Baseline)

**Audit Date:** September 25, 2026
**Repository Branch:** `main`
**Supabase Project Reference:** `duigaivxgxlnjmfienhg`

**Table Counts:** 27 Public Tables, 2 Private Tables (Verified via live catalog query)
**Migration Status:** MATCHED. Local migrations are perfectly synchronized with the remote database. 
**Cleanup and Reset Status:** **COMPLETED**. 
* **Repository Commit:** `be1f0ce` for Stage 1/Reset scripts and `394aa8c` for Stage 2 execution.
* **Relevant Migrations Applied:** `20260926100000_simplify_stage1_derive_and_compat.sql` and `20260926110000_simplify_stage2_drop_columns.sql`.
* **Column Absence Verified:** The 9 targeted columns (`capacity`, `price_per_kg`, `sender_name`, `sender_address`, etc.) are completely absent from the live schema catalog.
* **Row Counts (Reset Verification):** 
  * `orders`: 1 (Post-reset test/webhooks execution)
  * `payment_attempts`: 0
  * `email_subscriptions`: 0
  * `announcements`: 0
  * `activity_logs`: 15 (Post-reset logs tracking admin activity)
  * `profiles`: 8 (Intentionally retained).

---

## 2. Verification of Requested Changes (Database Simplification)

The following changes have been executed on the live schema.

### Removed Columns and Their Replacements
| Dropped Column | Current Live State | How It Is Handled Now |
|---|---|---|
| `trips.capacity` | **Removed** | Now checked dynamically against `company_information.default_capacity`. (Verified in trigger logic: `company_default_capacity()` + 200kg allowance). |
| `trips.price_per_kg` | **Removed** | Computed directly using `company_information.default_price_per_kg`. (Verified in trigger logic: computed via `global_price_per_kilo()`). |
| `orders.sender_name` | **Removed** | Assembled dynamically from `sender_first_name` and `sender_last_name`. |
| `orders.receiver_name` | **Removed** | Assembled dynamically from `receiver_first_name` and `receiver_last_name`. |
| `orders.sender_address` | **Removed** | Assembled dynamically from structured parts (`sender_lot_block`, `sender_street`, `sender_barangay`, `sender_city`, `sender_province`, `sender_landmark`). |
| `orders.receiver_address` | **Removed** | Assembled dynamically from structured parts. |
| `payment_attempts.estimated_cost` | **Removed** | Dropped completely. |
| `payment_attempts.description` | **Removed** | Dropped locally; description sent directly to PayMongo via Edge Functions. |
| `contact_inquiries.phone` | **Removed** | Replaced by strict separate fields. |

### Retained/Modified Columns
| Column | Current Live State | Behavior |
|---|---|---|
| `contact_inquiries.contact_phone` | **Retained** | Stores the mobile number. Rate-limiting applies per phone. |
| `contact_inquiries.contact_email` | **Retained** | Stores the email address. Rate-limiting applies per email. |

**Verifications:**
- Changing company defaults only affects future order pricing because `orders.shipping_cost` locks the calculated cost dynamically (verified via trigger).

---

## 3. Recommended Manuscript Data Dictionary (Scope: 15 Tables)

*Adviser's rule applied: Omitted pure audit fields and secondary keys unless directly required to explain the business process. Fields validated against live catalog schema.*

### 1. Profiles
**Purpose:** Stores user accounts, roles, and personal details for both customers and administrators.
| Field Name | Data Type | Description |
|---|---|---|
| `id` | uuid | Unique identifier for the account. |
| `role` | character varying | System role indicating 'admin' or 'customer'. |
| `email` | character varying | The registered email address. |
| `name` | character varying | The user's full name. |
| `phone` | character varying | The user's contact number. |
| `address_city` | character varying | The city where the user resides (along with other address parts). |

### 2. Trips
**Purpose:** Represents scheduled delivery routes and assignments.
| Field Name | Data Type | Description |
|---|---|---|
| `id` | uuid | Unique identifier for the trip. |
| `trip_number` | character varying | Human-readable trip reference code. |
| `origin` | character varying | Starting location of the trip. |
| `destination` | character varying | Ending location of the trip. |
| `status` | character varying | Current state of the trip (e.g., Scheduled, In Transit, Completed). |
| `departure_date` | timestamp | The planned date and time of departure. |

### 3. Orders
**Purpose:** Contains all cargo bookings, shipping costs, and structured sender/receiver details.
| Field Name | Data Type | Description |
|---|---|---|
| `id` | uuid | Unique identifier for the order. |
| `tracking_number` | character varying | Public code used by customers to track cargo. |
| `user_id` | uuid | Links the order to the customer who booked it. |
| `trip_id` | uuid | Links the order to its assigned trip. |
| `status` | character varying | Current fulfillment status (e.g., Pending, Picked Up). |
| `actual_weight` | numeric | Measured weight of the cargo in kilograms. |
| `shipping_cost` | numeric | Final locked shipping charge (calculated as weight × rate). |
| `sender_first_name` | character varying | First name of the sender (receiver equivalent also exists). |
| `sender_street` | character varying | Street name for pickup (along with other structured parts). |

### 4. Order_status_events
**Purpose:** Tracks the historical progression of an order's status.
| Field Name | Data Type | Description |
|---|---|---|
| `id` | uuid | Unique event identifier. |
| `order_id` | uuid | The order being updated. |
| `status` | character varying | The new status applied to the order. |

### 5. Payment_transactions
**Purpose:** Records successful payments and ledger entries (cash or GCash).
| Field Name | Data Type | Description |
|---|---|---|
| `id` | uuid | Unique transaction identifier. |
| `order_id` | uuid | The order being paid for. |
| `amount` | numeric | The amount successfully paid. |
| `payment_method` | text | Mode of payment used (e.g., Cash, GCash). |
| `payment_status` | text | Final status of the transaction (e.g., succeeded). |

### 6. Payment_refunds
**Purpose:** Tracks refunds issued back to customers.
| Field Name | Data Type | Description |
|---|---|---|
| `id` | uuid | Unique refund identifier. |
| `payment_transaction_id` | uuid | The original payment transaction being refunded. |
| `payment_id` | text | External provider reference (e.g. PayMongo ID). |
| `amount` | numeric | Amount to be returned. |
| `status` | text | Current state of the refund processing. |
| `reason` | text | Justification for the refund. |

### 7. Announcements
**Purpose:** Stores public announcements displayed on the website.
| Field Name | Data Type | Description |
|---|---|---|
| `id` | uuid | Unique announcement identifier. |
| `title` | character varying | Headline of the announcement. |
| `content` | text | Full body text of the announcement. |
| `is_active` | boolean | Controls public visibility. |

### 8. Notifications
**Purpose:** System alerts and push notifications sent directly to users.
| Field Name | Data Type | Description |
|---|---|---|
| `id` | uuid | Unique notification identifier. |
| `user_id` | uuid | The user receiving the alert. |
| `title` | character varying | Short subject of the notification. |
| `message` | text | Detailed content of the alert. |
| `is_read` | boolean | True if the user has viewed the notification. |

### 9. Conversations
**Purpose:** Manages support chat sessions between customers and admins.
| Field Name | Data Type | Description |
|---|---|---|
| `id` | uuid | Unique conversation identifier. |
| `customer_id` | uuid | The customer initiating the chat. |
| `status` | text | State of the chat (e.g., Open, Resolved). |

### 10. Chat_messages
**Purpose:** Individual text messages sent within a support conversation.
| Field Name | Data Type | Description |
|---|---|---|
| `id` | uuid | Unique message identifier. |
| `conversation_id` | uuid | The support session this message belongs to. |
| `sender_id` | uuid | The user (admin or customer) who sent the message. |
| `message` | text | The content of the message. |

### 11. Contact_inquiries
**Purpose:** Captures questions from the public website contact form.
| Field Name | Data Type | Description |
|---|---|---|
| `id` | uuid | Unique inquiry identifier. |
| `contact_phone` | text | Mobile number of the person inquiring. |
| `contact_email` | text | Email address of the person inquiring. |
| `message` | text | The inquiry content. |

### 12. Customer_feedback
**Purpose:** Stores post-delivery ratings and reviews from customers.
| Field Name | Data Type | Description |
|---|---|---|
| `id` | uuid | Unique feedback identifier. |
| `order_id` | uuid | The completed order being rated. |
| `rating` | integer | Numerical score given by the customer. |
| `message` | text | Written review or comments. |

### 13. Company_information
**Purpose:** Holds global company settings, including pricing and capacity constraints.
| Field Name | Data Type | Description |
|---|---|---|
| `id` | uuid | Unique record identifier (only one row exists). |
| `company_name` | text | Registered name of the logistics company. |
| `default_capacity` | integer | Global weight limit for newly assigned trips. |
| `default_price_per_kg` | numeric | Base freight rate applied to new cargo weights. |

### 14. Activity_logs
**Purpose:** Audit trail tracking administrative actions within the system.
| Field Name | Data Type | Description |
|---|---|---|
| `id` | uuid | Unique log entry identifier. |
| `admin_id` | uuid | The administrator who performed the action. |
| `action` | text | Description of what was changed or executed. |

### 15. Cancellation_settlements
**Purpose:** Tracks mutual agreements between the company and customer regarding retained amounts after cancellation.
| Field Name | Data Type | Description |
|---|---|---|
| `id` | uuid | Unique settlement identifier. |
| `order_id` | uuid | The cancelled order. |
| `decision_type` | text | Either 'full_refund' or 'retained_fee'. |
| `agreed_retained_amount` | numeric | The mutually agreed amount the business keeps to cover costs. |
| `customer_agreement_confirmed` | boolean | True if the customer confirmed the retained amount. |

---

## 5. Affected Process Specifications

When rewriting the process definitions in Chapter 2, apply these updated rules:

* **Trip creation, capacity checking, and pricing:** Trips no longer hold their own rate or capacity. Pricing is computed at the exact moment of weighing using the *current* `default_price_per_kg` in Company Information. Capacity limits pull from `default_capacity`. 
* **Sender and Receiver Information / QR Labels:** The system dynamically joins the stored first/last names and the structured address components.
* **Cancellation Settlement:** There is NO automatic "late cancellation penalty". Instead, it implements an `agreed_retained_amount` which must be confirmed (`customer_agreement_confirmed = true`) by the customer. If no costs were incurred, a 'full_refund' decision sets the amount to 0.
* **Activity logs (Automated Cleanup):** Operational activity logs are managed by scheduled background jobs. The job `purge_old_activity_logs` is a configured `pg_cron` schedule that runs daily at 03:00 AM (`0 3 * * *`). It automatically hard-deletes (`DELETE FROM activity_logs`) any logs where `created_at < now() - interval '7 days'`. (Note: This is the defined scheduled policy; during our fresh start reset, logs were manually truncated).
