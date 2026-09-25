# CHAPTER 2 CURRENT DATABASE DESIGN HANDOFF

## 1. Current Database State (Verified Live Baseline)

**Audit Date:** September 25, 2026
**Repository Branch:** `main` (latest commit applied and pushed)
**Supabase Project Reference:** `duigaivxgxlnjmfienhg`

**Table Counts:** 27 Public Tables, 2 Private Tables (Verified via live catalog query)
**Migration Status:** MATCHED. Local migrations are perfectly synchronized with the remote database. The latest applied migration is `20260926110000_simplify_stage2_drop_columns.sql`.
**Cleanup and Reset Status:** **COMPLETED**. The requested data reset (Fresh Start) and the Stage 2 destructive migration (dropping 9 columns) were successfully executed against the live database today.

---

## 2. Verification of Requested Changes (Database Simplification)

The following changes have been executed on the live schema (Stage 2 applied).

### Removed Columns and Their Replacements
| Dropped Column | Current Live State | How It Is Handled Now |
|---|---|---|
| `trips.capacity` | **Removed** | Now uses `company_information.default_capacity`. Checked when cargo is added to a trip. Changing the default limits future loading but does not unassign existing cargo. |
| `trips.price_per_kg` | **Removed** | When weight is recorded, `orders.shipping_cost` is calculated directly using `company_information.default_price_per_kg` at that exact moment. The recorded cost is locked and kept through payments/refunds. |
| `orders.sender_name` | **Removed** | Assembled dynamically (first name + last name) via `public.format_person_name()` or frontend helper. |
| `orders.receiver_name` | **Removed** | Assembled dynamically (first name + last name). |
| `orders.sender_address` | **Removed** | Assembled dynamically from structured parts (lot_block, street, barangay, city, province, landmark) via `public.format_address()`. |
| `orders.receiver_address` | **Removed** | Assembled dynamically from structured parts. |
| `payment_attempts.estimated_cost` | **Removed** | Dropped completely (was never used). |
| `payment_attempts.description` | **Removed** | Dropped locally; the description is sent directly to PayMongo via Edge Functions during capture. |
| `contact_inquiries.phone` | **Removed** | Completely removed. Replaced by strict separate fields. |

### Retained/Modified Columns
| Column | Current Live State | Behavior |
|---|---|---|
| `contact_inquiries.contact_phone` | **Retained** | Stores the mobile number. Rate-limiting anti-spam applies directly to this phone number (max 3/10 min) ignoring IP addresses. |
| `contact_inquiries.contact_email` | **Retained** | Stores the email address. Rate-limiting applies per email (case-insensitive, max 3/10 min). (At least one of phone or email is required). |

**Verifications:**
- Changing company defaults does *not* re-price already-priced bookings because `orders.shipping_cost` is now a locked numerical value.
- QR labels, tracking, and reports use the replacement `orderPartyName` and `orderPartyAddress` frontend helpers which concatenate the parts perfectly.

---

## 3. Recommended Manuscript Data Dictionary (Scope: 15 Tables)

*Adviser's rule applied: Omitted audit fields (e.g., created_at, updated_at, created_by) and purely technical foreign keys unless directly required to explain the business process.*

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
| `customer_id` | uuid | Links the order to the customer who booked it. |
| `trip_id` | uuid | Links the order to its assigned trip. |
| `status` | character varying | Current fulfillment status (e.g., Pending, Picked Up). |
| `actual_weight` | numeric | Measured weight of the cargo in kilograms. |
| `shipping_cost` | numeric | Final locked shipping charge (calculated as weight × rate). |
| `discount_amount` | numeric | Approved deduction from the shipping cost. |
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
| `payment_id` | uuid | The original payment transaction being refunded. |
| `amount` | numeric | Amount to be returned. |
| `status` | text | Current state of the refund processing. |

### 7. Announcements
**Purpose:** Stores public announcements displayed on the website.
| Field Name | Data Type | Description |
|---|---|---|
| `id` | uuid | Unique announcement identifier. |
| `title` | text | Headline of the announcement. |
| `content` | text | Full body text of the announcement. |
| `is_published` | boolean | Controls public visibility. |

### 8. Notifications
**Purpose:** System alerts and push notifications sent directly to users.
| Field Name | Data Type | Description |
|---|---|---|
| `id` | uuid | Unique notification identifier. |
| `profile_id` | uuid | The user receiving the alert. |
| `title` | text | Short subject of the notification. |
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
| `comments` | text | Optional written review. |

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
**Purpose:** Tracks financial penalties applied when cargo is cancelled late.
| Field Name | Data Type | Description |
|---|---|---|
| `id` | uuid | Unique settlement identifier. |
| `order_id` | uuid | The cancelled order. |
| `penalty_amount` | numeric | The fee imposed for the cancellation. |
| `settlement_status` | text | Whether the penalty is unpaid or settled. |

---

## 4. Required Manuscript Corrections

*To ChatGPT: When revising Chapter 2 based on previous drafts, ensure the following strict corrections are applied.*

| Table / Section | Current manuscript assumption | Required correction | Ready-to-copy replacement |
|---|---|---|---|
| **Orders** | Claims `sender_name`, `receiver_name`, `sender_address`, `receiver_address` are stored. | **Must correct.** These columns were completely deleted. | Replace with structured parts: `sender_first_name`, `sender_last_name`, `sender_street`, `sender_barangay`, `sender_city`, `sender_province`. State that full names and addresses are assembled dynamically by the system. |
| **Trips** | Claims `capacity` and `price_per_kg` are stored per trip. | **Must correct.** These columns were completely deleted. | Remove them from the Trips table. State that pricing and capacity limits are pulled directly from `company_information` during assignment and weighing. |
| **Contact_inquiries** | Claims `phone` is a single combined string field. | **Must correct.** Column deleted. | Replace with `contact_phone` and `contact_email` as distinct fields. |

---

## 5. Affected Process Specifications

When rewriting the process definitions in Chapter 2, apply these updated rules:

* **Trip creation, capacity checking, and pricing:** Trips no longer hold their own rate or capacity. Pricing is computed at the exact moment of weighing using the *current* `default_price_per_kg` in Company Information. Capacity limits pull from `default_capacity`. 
* **Sender and Receiver Information / QR Labels:** The system dynamically joins the stored first/last names and the structured address components for QR labels, public tracking, and reports. No pre-assembled strings are stored.
* **Menu-driven support and inquiries:** Spam protections are applied strictly to `contact_phone` and `contact_email` independent of the IP address, allowing max 3 requests per 10 minutes per channel.
* **Activity logs (Automated Cleanup):** Operational logs and old activity data can be automatically purged by routine background pg_cron jobs to preserve database space over time. (During the fresh start reset, all old activity logs were manually cleared).

---

## 6. Taglish Summary for ChatGPT

**Para kay ChatGPT (Next Steps):**
Ang live database ay naka-Fresh Start na at tapos na ang Stage 2 Database Simplification (ibig sabihin, nabura na tuluyan yung mga lumang columns na hindi kailangan). Gamitin mo ang document na ito para i-update ang **Chapter 2 Database Design**. Huwag mo nang isama yung `capacity` at `price_per_kg` sa Trips, pati yung `sender_name` at `sender_address` sa Orders dahil structured components na sila ngayon. Ang required format para sa data dictionary ay andito na (Data Type + simple Description). I-align mo yung mga business processes sa Chapter 2 base sa "Affected Process Specifications" section dito.
