# CargoExpress PH — Chapter 2 Update Review & Manuscript Revision Specification

**Document Version:** 1.0  
**Date:** September 24, 2026  
**Target Repository:** `/Users/beasarong/Downloads/CargoExpressPH-main`  
**Manuscript Reviewed:** `Chapter-2-CHECKED-1-1(3).pdf` (111 Pages total)  
**Role:** Lead Thesis Manuscript Reviewer, Senior System Analyst, & Database Documentation Specialist  

---

## 1. Executive Summary & Baseline Inventory

### 1.1 Scope & Purpose
This audit and revision specification evaluates `Chapter-2-CHECKED-1-1(3).pdf` against the active CargoExpress PH application codebase, database migrations, Edge Functions, and routing layer. The objective is to produce exact manuscript updates ensuring system descriptions, process logic, data dictionaries, program hierarchies, and system diagrams reflect the **actual implemented software** while preserving the manuscript's academic structure, formatting, and tone.

### 1.2 Inventory of the Manuscript Structure
Based on direct inspection of `Chapter-2-CHECKED-1-1(3).pdf` (Pages 1 to 111), the document contains:

*   **Chapter 2: PRESENTATION OF THE PRESENT AND PROPOSED SYSTEM**
    *   **A. PRESENT SYSTEM** (Pages 1–8)
        *   System Narrative (Pages 1–3)
        *   Constraints (Pages 3–5)
        *   Figure 11. Context Diagram of Present System (Page 6)
        *   Event List (Events 1–9) (Page 7)
        *   Event List Diagram (Figures 12–20) (Pages 7–8)
    *   **B. PROPOSED SYSTEM** (Pages 9–97)
        *   System Rules (Pages 9–13)
        *   Figure 21. Context Diagram of Proposed System (Page 14)
        *   Event List (Events 1–16) (Page 15)
        *   Event List Diagrams (Figures 22–37) (Pages 15–18)
        *   Process Specifications (Processes 1–27) (Pages 19–47)
        *   Program Hierarchy Diagrams (Figures 38–40) (Pages 48–50)
            *   Figure 38. PROGRAM HIERARCHY (PUBLIC) (Page 48)
            *   Figure 39. PROGRAM HIERARCHY (CUSTOMER) (Page 49)
            *   Figure 40. PROGRAM HIERARCHY (ADMIN) (Page 50)
        *   Database Design (Introductory text + Tables 1 to 22) (Pages 51–66)
        *   Test Data/Cases (Test Cases 1–10, Previews 1–10) (Pages 67–76)
        *   Revision of the System (First, Second, Third Revision) (Page 77)
        *   Technical Requirements (Pages 77–81)
            *   Hardware Specification (Pages 77–78)
            *   Software Requirements (Pages 78–80) (Operating System, Application Program, Database)
            *   Peopleware (Pages 80–81)
        *   Cost-Benefit Analysis (Pages 81–83)
            *   Table 19. Proposed System Annual Operating Cost (Page 82) *(Note: Numbering duplication with Table 19 on p. 63)*
            *   Benefits: Tangible & Intangible (Pages 82–83)
        *   Interface Design (Objectives, Descriptions, Screen Layouts Previews 11–25) (Pages 84–97)
*   **Chapter 3: SUMMARY, CONCLUSION AND RECOMMENDATIONS** (Pages 98–100)
*   **ACTION PLAN** (Pages 101–103)
*   **REFERENCES** (Pages 104–105)
*   **APPENDICES** (Pages 106–111)

### 1.3 System & Codebase Baseline (Ground Truth)
The verified implementation baseline in `/Users/beasarong/Downloads/CargoExpressPH-main` comprises:
1.  **Frontend & Routing:** React 19 + Vite progressive web app (PWA) with dual role dashboards (`customer`, `admin`) and public routes declared in `src/App.jsx`.
2.  **Database Layer:** 210 SQL migration files in `supabase/migrations/`. The schema models **27 public tables** and **2 private schema tables** (total **29 application tables**), supported by Row-Level Security (RLS) policies, atomic triggers, and `SECURITY DEFINER` RPC functions.
3.  **Backend Services & Edge Functions:** 21 Deno Edge Functions in `supabase/functions/` executing PayMongo GCash payments/webhooks, automated refund recovery, durable announcement email broadcasts, push notifications, daily payment reminders, out-of-coverage review workflows, and photo storage archiving.
4.  **Security Model:** "Never trust the browser." Financial totals, status transitions, weight enforcement, cancellation settlement gates, and user access controls are strictly enforced at the PostgreSQL engine level.

---

## 2. Section-by-Section Comparison & Diagnostic Matrix

The following matrix compares every section of Chapter 2 against the current code implementation evidence:

| Manuscript Section / Page | Existing Manuscript Statement | Current Implementation Evidence | Required Manuscript Change | Verification & Release Status |
|---|---|---|---|---|
| **System Rules** <br>*(Pages 9–13)* | Describes manual route selection, general booking steps, cash/GCash payments, trip scheduling, status progress, and basic chat support. | `BookShipmentPage.jsx`, `20260910025000_add_order_address_components.sql`, `20260911010000_shipping_discount_schema.sql`, `20260922100000_split_sender_receiver_names.sql`, `20260920110000_cancellation_settlement_workflow.sql`. | Expand system rules to document structured contact names (first/last), detailed address components (lot/block, street, barangay, landmark), shipping discounts, cancellation settlement workflows, package box quantities, and durable email/push notifications. | **Implemented & Deployed** |
| **Context Diagram (Proposed)** <br>*(Figure 21, Page 14)* | Shows generic flows between Customer, Public User, Admin, and System. | `src/lib/push-notifications.js`, `broadcast-announcement`, `record-manual-refund`, `cancellation_settlements`. | Update Diagram Revision Specification to include QR Parcel Label data flows, Cancellation Settlement decisions, Push Device Tokens, and Announcement Email Broadcasts. | **Implemented & Deployed** |
| **Event List & Diagrams** <br>*(Figures 22–37, Pages 15–18)* | Lists 16 system events and 16 event list diagrams. DFD symbols link processes to outdated table names (e.g. `notification_delivery_attempts`). | `supabase/migrations/20260908010000_drop_push_delivery_attempts.sql`, `20260920110000_cancellation_settlement_workflow.sql`, `20260916161000_durable_announcement_broadcasts.sql`. | Replace `notification_delivery_attempts` with `notification_delivery_jobs` in Fig 22-37 specifications. Update Event 9 (Cancellation) to link to `cancellation_settlements`, Event 14 to include `announcement_email_broadcasts` and `email_subscriptions`. | **Implemented & Deployed** |
| **Process Specifications** <br>*(Processes 1–27, Pages 19–47)* | 27 pseudo-code processes representing user interactions. Some steps lack recent UI validations (e.g., box count caps, structured name validation, discount rules). | `BookShipmentPage.jsx`, `OrderDetailPage.jsx`, `CompanyInformationPage.jsx`, `StorageMonitoringPage.jsx`, `UnpaidShipmentsPage.jsx`. | Revise Process 5, Process 8, Process 9, Process 15, Process 17, Process 19, Process 20, Process 25, Process 26 to reflect exact UI fields, validation limits, and database triggers. | **Implemented & Deployed** |
| **Program Hierarchy** <br>*(Figures 38–40, Pages 48–50)* | Figures 38–40 outline Public, Customer, and Admin screen structure. Missing newer tabs (e.g., Unpaid Shipments, Storage Monitoring, Legal Policies, Unsubscribe). | `src/App.jsx`, `src/pages/admin/UnpaidShipmentsPage.jsx`, `StorageMonitoringPage.jsx`, `LegalPage.jsx`, `UnsubscribePage.jsx`. | Update Program Hierarchy revision specifications for Admin (Main, Management, System branches) and Customer/Public trees. | **Implemented & Deployed** |
| **Database Design (Tables)** <br>*(Pages 51–66)* | Documents 22 database tables (Tables 1 to 22). Table 8 (`Notification_delivery_attempts`) is dropped in code. Omits 7 active application tables. | `DATABASE_TABLE_AND_COLUMN_AUDIT.md`, `supabase/migrations/`. 27 public tables + 2 private tables = 29 application tables. | Update introductory text (stating 29 tables across core operational, financial ledger, messaging, and system management schemas). Replace Table 8 with `Notification_delivery_jobs`. Add missing columns to Tables 1-22. Add dictionary tables 23 to 29. | **Implemented & Deployed** |
| **Table 11. Orders** <br>*(Pages 57–59)* | Lists 44 columns for `orders`. | `20260910025000`, `20260911010000`, `20260922080000`, `20260922100000`. | Add 17 missing columns: `sender_barangay`, `sender_street`, `sender_lot_block`, `sender_landmark`, `receiver_barangay`, `receiver_street`, `receiver_lot_block`, `receiver_landmark`, `discount_amount`, `discount_reason`, `discount_notes`, `discount_applied_by`, `discount_applied_at`, `package_quantity`, `sender_first_name`, `sender_last_name`, `receiver_first_name`, `receiver_last_name`, `featured_at`. | **Implemented & Deployed** |
| **Table 4. Company_information** <br>*(Page 53)* | Lists `messenger` column; missing `default_capacity`, `features`, `coverage`. | `20260920205500_remove_messenger_link.sql`, `20260922090000_add_company_default_capacity.sql`. | Remove `messenger` column. Add `default_capacity`, `features`, `coverage` columns. | **Implemented & Deployed** |
| **Table 19. Operating Cost** <br>*(Page 82)* | Table caption labeled "Table 19. Proposed System Annual Operating Cost". | Manuscript page 63 already has "Table 19. Payment_refunds". | Renumber Operating Cost Table to **Table 30** (or Table 23 if counting outside the DB sequence) to eliminate duplicate table numbering. | **Formatting Correction** |
| **Preview 24 Caption** <br>*(Page 96)* | Caption reads "Preview 24: Sales and Reports Page" on the Announcement screen screenshot. | OCR & visual inspection of Page 96 screenshot shows Announcement Management screen. | Correct caption to **"Preview 24: Announcement Management"**. | **Formatting Correction** |

---

## 3. Complete Updated Database Documentation (Data Dictionary)

The manuscript’s Database Design section must be updated to document all **29 application tables** (27 public tables and 2 private security/recovery tables). Infrastructure tables managed exclusively by Supabase (`auth.users`, `storage.objects`, `realtime`) remain separate.

### Introductory Text Update (Page 51)
> **Database Design**  
> The following tables present the complete relational database structure of the CargoExpress PH system, modeling 27 public application tables and 2 private security tables. The schema separates core operational business records from financial ledgers, asynchronous queues, security rate-limiters, and system audit logs.

---

### Revised & Expanded Data Dictionary Tables (Tables 1 to 29)

#### Table 1. Activity_logs
*Tracks administrative and system actions for security auditing (7-day automated SQL retention).*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Unique primary key identifier for each activity log entry. |
| `admin_id` | `uuid` | Foreign key referencing the profile/admin who performed the action. |
| `admin_name` | `text` | Display name of the admin at the time of action logging. |
| `module` | `text` | System module name where the event occurred (e.g., Bookings, Trips, Payments). |
| `action` | `text` | Specific administrative action performed. |
| `record_type` | `text` | Category of data record affected. |
| `record_id` | `uuid` | Primary key identifier of the modified record. |
| `record_ref` | `text` | Human-readable reference string (e.g., tracking number or trip number). |
| `previous_value` | `jsonb` | JSON snapshot of data prior to modification. |
| `new_value` | `jsonb` | JSON snapshot of data following modification. |
| `details` | `text` | Additional contextual notes regarding the operation. |
| `created_at` | `timestamptz` | Timestamp when the action was logged. |
| `client_event_id` | `uuid` | Client-generated idempotency key preventing duplicate log entries. |

#### Table 2. Announcements
*Stores system advisories, trip announcements, and marketing broadcasts published by administrators.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key identifier for the announcement. |
| `title` | `varchar` | Headline title of the announcement (max 100 characters). |
| `content` | `text` | Full body text content (max 1,500 characters). |
| `author_id` | `uuid` | Foreign key referencing the admin author. |
| `is_active` | `bool` | Flag indicating whether the announcement is visible to users. |
| `audience` | `text` | Target audience scope (`public`, `customer`, or `all`). |
| `cta_label` | `text` | Optional button label for call-to-action link. |
| `cta_url` | `text` | Optional target URL for call-to-action link. |
| `send_email` | `bool` | Flag specifying whether an email notification should be dispatched. |
| `emailed_at` | `timestamptz` | Timestamp when email delivery was initiated. |
| `comments` | `jsonb` | JSON array storing user comments on the announcement. |
| `created_at` | `timestamptz` | Creation timestamp. |
| `updated_at` | `timestamptz` | Last update timestamp. |

#### Table 3. Chat_messages
*Stores individual chat messages exchanged between customers, the automated bot assistant, and administrators.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key identifier for the chat message. |
| `conversation_id` | `uuid` | Foreign key referencing the parent conversation thread. |
| `sender_id` | `uuid` | Foreign key referencing the user or bot who sent the message. |
| `sender_role` | `varchar` | Role of the sender (`customer`, `admin`, or `bot`). |
| `message` | `text` | Text content of the chat message. |
| `is_read` | `bool` | Read receipt status indicator. |
| `created_at` | `timestamptz` | Message dispatch timestamp. |

#### Table 4. Company_information
*Singleton configuration table managing global business details, default rates, and company settings.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key identifier (enforced single-row table). |
| `name` | `text` | Official business name. |
| `short_description` | `text` | Brief business summary tagline. |
| `long_description` | `text` | Detailed company overview and story. |
| `banner_image_url` | `text` | URL link to the main homepage banner illustration. |
| `banner_title` | `text` | Main headline text displayed on the homepage. |
| `banner_description` | `text` | Supporting subtext on the homepage banner. |
| `banner_button_text` | `text` | Primary call-to-action button label. |
| `banner_button_link` | `text` | Destination path for primary call-to-action button. |
| `email` | `text` | Official contact email address. |
| `facebook` | `text` | Official Facebook page URL. |
| `smart_phone` | `text` | Primary Smart cellular contact number. |
| `globe_phone` | `text` | Primary Globe cellular contact number. |
| `manila_address` | `text` | Physical address of the Manila hub/warehouse. |
| `bohol_address` | `text` | Physical address of the Bohol hub/warehouse. |
| `default_price_per_kg` | `numeric` | Default shipping rate per kilogram used when initializing trips. |
| `default_capacity` | `integer` | Default maximum weight capacity (kg) used when creating trips. |
| `features` | `jsonb` | JSON array of highlighted company features. |
| `coverage` | `jsonb` | JSON array of supported coverage areas and routes. |
| `created_at` | `timestamptz` | Profile creation timestamp. |
| `updated_at` | `timestamptz` | Profile last update timestamp. |

#### Table 5. Contact_inquiries
*Records public messages submitted by visitors through the contact form.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key identifier for the inquiry. |
| `name` | `text` | Full name of the inquiring visitor. |
| `phone` | `text` | Primary contact telephone number. |
| `message` | `text` | Inquiry message body. |
| `status` | `text` | Operational state (`new`, `in_progress`, or `resolved`). |
| `contact_phone` | `text` | Alternative contact phone number. |
| `contact_email` | `text` | Visitor email address for response. |
| `assigned_admin_id` | `uuid` | Foreign key referencing the admin handling the inquiry. |
| `first_response_at` | `timestamptz` | Timestamp of initial admin response. |
| `resolved_at` | `timestamptz` | Timestamp when the inquiry was marked resolved. |
| `push_dispatched_at` | `timestamptz` | Timestamp when admin push notification was sent. |
| `push_dispatch_started_at` | `timestamptz` | Dispatch queue lock start timestamp. |
| `push_dispatch_claim_id` | `uuid` | Claim worker identifier for push notification dispatch. |
| `ip` | `text` | IP address of submission source for security rate-limiting. |
| `wants_announcements` | `bool` | Visitor opt-in consent flag for announcement emails. |
| `created_at` | `timestamptz` | Submission timestamp. |

#### Table 6. Conversations
*Manages support chat sessions, escalation status, and automated assistant resolution state.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key identifier for the support conversation. |
| `customer_id` | `uuid` | Foreign key referencing the customer account owner. |
| `status` | `text` | Current conversation state (`bot_active`, `waiting`, `waiting_on_customer`, `resolved`). |
| `escalated` | `bool` | Flag indicating if human admin intervention was requested. |
| `bot_resolved` | `bool` | Flag indicating if automated chatbot resolved the issue without admin. |
| `first_response_at` | `timestamptz` | Timestamp of first administrative response. |
| `last_customer_message_at` | `timestamptz` | Timestamp of customer's most recent message. |
| `resolved_at` | `timestamptz` | Timestamp when conversation was closed/resolved. |
| `created_at` | `timestamptz` | Thread initiation timestamp. |

#### Table 7. Customer_feedback
*Stores customer ratings and written reviews for delivered orders.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key identifier for feedback record. |
| `order_id` | `uuid` | Foreign key referencing the specific delivered order. |
| `customer_id` | `uuid` | Foreign key referencing the customer reviewer. |
| `rating` | `int4` | Star rating integer value between 1 and 5. |
| `message` | `text` | Detailed written review commentary. |
| `is_hidden` | `bool` | Moderation flag enabling admin to hide inappropriate reviews. |
| `created_at` | `timestamptz` | Submission timestamp. |

#### Table 8. Notification_delivery_jobs
*(Replaces legacy `notification_delivery_attempts`). Durable background queue for web push notification delivery.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key identifier for the push delivery job. |
| `notification_id` | `uuid` | Foreign key referencing the target in-app notification. |
| `user_id` | `uuid` | Foreign key referencing the target user recipient. |
| `device_token_id` | `uuid` | Foreign key referencing the specific user device token. |
| `dedupe_key` | `text` | Unique deduplication key preventing duplicate pushes. |
| `status` | `text` | Queue state (`pending`, `in_progress`, `completed`, `failed`). |
| `attempt_count` | `integer` | Number of execution retry attempts made. |
| `available_at` | `timestamptz` | Scheduled execution time for retry backoff. |
| `claimed_at` | `timestamptz` | Timestamp when background worker claimed job lock. |
| `claim_id` | `uuid` | Unique worker claim lease identifier. |
| `completed_at` | `timestamptz` | Job completion timestamp. |
| `last_error` | `text` | Error log details if delivery attempt failed. |
| `created_at` | `timestamptz` | Enqueue timestamp. |
| `updated_at` | `timestamptz` | Last job status update timestamp. |

#### Table 9. Notifications
*Stores in-app user notifications for shipment progress, payments, and system advisories.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key identifier for notification. |
| `user_id` | `uuid` | Foreign key referencing recipient user account. |
| `title` | `varchar` | Short notification header title. |
| `message` | `text` | Detailed message content body. |
| `type` | `varchar` | Category classification (`order`, `trip`, `payment`, `announcement`). |
| `reference_id` | `uuid` | Foreign key referencing related entity (e.g. order or trip ID). |
| `payment_transaction_id` | `uuid` | Optional foreign key linking specific payment transaction. |
| `payment_refund_id` | `uuid` | Optional foreign key linking specific refund record. |
| `is_read` | `bool` | Status flag indicating if user opened notification. |
| `created_at` | `timestamptz` | Generation timestamp. |

#### Table 10. Order_status_events
*Provides an immutable chronological audit trail of all tracking status changes for a shipment.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key identifier for status event. |
| `order_id` | `uuid` | Foreign key referencing the associated order. |
| `status` | `varchar` | Tracking status applied (`Pending`, `Assigned`, `Picked Up`, `In Transit`, `Arrived at Hub`, `Out for Delivery`, `Delivered`, `Cancelled`). |
| `changed_by` | `uuid` | Foreign key referencing user or admin who triggered change. |
| `note` | `text` | Optional remarks describing reason for status update. |
| `changed_at` | `timestamptz` | Status change timestamp. |

#### Table 11. Orders
*Core operational table containing shipment details, address components, financial totals, status, and discount records.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key identifier for cargo booking order. |
| `user_id` | `uuid` | Foreign key referencing customer account holder. |
| `trip_id` | `uuid` | Foreign key referencing assigned cargo trip run. |
| `tracking_number` | `varchar` | Unique tracking code provided to customer (e.g., `CE-20260924-1234`). |
| `sender_name` | `varchar` | Full display name of cargo sender. |
| `sender_first_name` | `text` | Structured first name of sender. |
| `sender_last_name` | `text` | Structured surname of sender. |
| `sender_phone` | `varchar` | Contact telephone number of sender. |
| `sender_address` | `text` | Compiled full address string of sender. |
| `sender_lot_block` | `text` | Specific house/lot/block building address details of sender. |
| `sender_street` | `text` | Street name of sender. |
| `sender_barangay` | `text` | Barangay location of sender. |
| `sender_city` | `text` | City or municipality of sender. |
| `sender_province` | `text` | Province location of sender. |
| `sender_landmark` | `text` | Notable landmark near sender address. |
| `sender_facebook` | `text` | Facebook profile name of sender. |
| `receiver_name` | `varchar` | Full display name of cargo receiver. |
| `receiver_first_name` | `text` | Structured first name of receiver. |
| `receiver_last_name` | `text` | Structured surname of receiver. |
| `receiver_phone` | `varchar` | Contact telephone number of receiver. |
| `receiver_address` | `text` | Compiled full address string of receiver. |
| `receiver_lot_block` | `text` | House/lot/block address details of receiver. |
| `receiver_street` | `text` | Street name of receiver. |
| `receiver_barangay` | `text` | Barangay location of receiver. |
| `receiver_city` | `text` | City or municipality of receiver. |
| `receiver_province` | `text` | Province location of receiver. |
| `receiver_landmark` | `text` | Notable landmark near receiver address. |
| `receiver_facebook` | `text` | Facebook profile name of receiver. |
| `package_description` | `text` | Comprehensive description of goods being shipped. |
| `package_quantity` | `integer` | Total number of physical boxes/parcels in shipment (1–50). |
| `actual_weight` | `numeric` | Physical verified cargo weight in kilograms (recorded at pickup). |
| `shipping_cost` | `numeric` | Final computed shipping total amount (weight × price per kg - discount). |
| `discount_amount` | `numeric` | Total shipping discount amount applied (PHP). |
| `discount_reason` | `text` | Administrative category for discount. |
| `discount_notes` | `text` | Detailed notes explaining reason for discount. |
| `discount_applied_by` | `uuid` | Foreign key referencing admin who applied discount. |
| `discount_applied_at` | `timestamptz` | Timestamp when discount was recorded. |
| `payer_type` | `varchar` | Responsible payer (`Sender` or `Receiver`). |
| `payment_method` | `varchar` | Primary payment method (`Cash` or `GCash`). |
| `payment_preference` | `text` | Customer's payment preference selected during booking. |
| `payment_status` | `varchar` | Current payment ledger state (`unpaid`, `partially_paid`, `paid`). |
| `amount_paid` | `numeric` | Cumulative monetary amount paid to date. |
| `remaining_balance` | `numeric` | Current outstanding monetary balance due. |
| `promised_payment_date` | `date` | Agreed deferred payment settlement deadline date. |
| `status` | `varchar` | Current tracking status (`Pending`, `Assigned`, `Picked Up`, `In Transit`, `Arrived at Hub`, `Out for Delivery`, `Delivered`, `Cancelled`). |
| `service_area_status` | `text` | Service area coverage status (`standard` or `out_of_coverage`). |
| `service_area_remarks` | `text` | Evaluation notes for out-of-coverage pickup requests. |
| `pickup_photos` | `jsonb` | JSON array of photo URLs captured during pickup. |
| `delivery_photos` | `jsonb` | JSON array of photo URLs captured during delivery. |
| `cancellation_details` | `jsonb` | JSON object storing customer cancellation request reason and review notes. |
| `reassignment_history` | `jsonb` | JSON log of previous trip reassignments. |
| `featured_on_website` | `bool` | Flag designating order for public homepage showcase. |
| `featured_title` | `text` | Title banner for featured delivery showcase. |
| `featured_caption` | `text` | Caption text for featured delivery showcase. |
| `featured_image_type` | `text` | Designated image type (`pickup` or `delivery`). |
| `featured_at` | `timestamptz` | Timestamp when order was featured. |
| `notes` | `text` | Internal administrative operational notes. |
| `last_reminder_sent_at` | `timestamptz` | Timestamp of last automated payment reminder email. |
| `created_at` | `timestamptz` | Booking creation timestamp. |
| `updated_at` | `timestamptz` | Last record update timestamp. |

#### Table 12. Payment_attempts
*Tracks PayMongo online checkout sessions, return token hashes, and payment reconciliation attempts.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key identifier for payment attempt. |
| `order_id` | `uuid` | Foreign key referencing associated order. |
| `source_id` | `text` | PayMongo checkout source identifier (`src_...`). |
| `payment_id` | `text` | PayMongo payment transaction ID (`pay_...`). |
| `amount` | `numeric` | Monetary value attempted in checkout. |
| `estimated_cost` | `numeric` | Projected total cost calculated at attempt time. |
| `actual_weight` | `numeric` | Package weight snapshot at time of checkout. |
| `description` | `text` | Transaction checkout description. |
| `status` | `text` | Attempt outcome state (`pending`, `paid`, `failed`, `expired`). |
| `payment_status` | `text` | Direct status payload returned by payment provider. |
| `payment_type` | `text` | Checkout type (`full` or `pay_later`). |
| `payer_type` | `varchar` | Payer role designated during attempt. |
| `promised_payment_date` | `date` | Deferred payment date associated with attempt. |
| `pickup_photos` | `jsonb` | Photo attachments linked to attempt session. |
| `return_token_hash` | `text` | SHA-256 hash of secure verification token for checkout return. |
| `return_token_expires_at` | `timestamptz` | Expiration time for checkout return verification link. |
| `reconciled_at` | `timestamptz` | Timestamp when payment was reconciled into database ledger. |
| `last_error` | `text` | Provider error message if transaction failed. |
| `created_by` | `uuid` | Foreign key referencing user who initiated checkout. |
| `created_at` | `timestamptz` | Creation timestamp. |
| `updated_at` | `timestamptz` | Last update timestamp. |

#### Table 13. Payment_transactions
*Official financial ledger recording all finalized payments and partial collections.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key identifier for payment transaction entry. |
| `order_id` | `uuid` | Foreign key referencing associated order. |
| `amount` | `numeric` | Exact monetary amount collected (PHP). |
| `payment_method` | `text` | Payment channel (`Cash` or `GCash`). |
| `payment_type` | `text` | Payment classification (`Full Payment`, `Pickup Payment`, `Delivery Payment`, `Partial Payment`). |
| `payment_status` | `text` | Verification state (`completed`, `pending`, `refunded`). |
| `transaction_reference` | `text` | External provider reference or bank transaction number. |
| `transaction_reference_normalized` | `text` | Cleaned alphanumeric reference string for search deduplication. |
| `gcash_channel` | `text` | Specific GCash entry point (`paymongo` or `manual_qr`). |
| `idempotency_key` | `uuid` | Unique idempotency key preventing duplicate ledger postings. |
| `receipt_url` | `text` | Link to uploaded payment receipt image proof. |
| `admin_id` | `uuid` | Foreign key referencing admin who verified/recorded payment. |
| `admin_name` | `text` | Name of recording admin. |
| `notes` | `text` | Administrative ledger notes. |
| `payment_date` | `date` | Effective collection date. |
| `created_at` | `timestamptz` | Timestamp when payment entry was committed. |

#### Table 14. Profiles
*Stores user account details, role assignments, address profiles, and announcement preferences.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key matching `auth.users` UUID. |
| `name` | `varchar` | User's full display name. |
| `email` | `varchar` | Registered email address. |
| `phone` | `varchar` | Primary cellular phone number. |
| `facebook_name` | `text` | User's Facebook profile handle. |
| `address_lot_block` | `varchar` | House/lot/block number details. |
| `address_street` | `varchar` | Street address. |
| `address_barangay` | `varchar` | Barangay location. |
| `address_city` | `varchar` | City or municipality. |
| `address_province` | `varchar` | Province location. |
| `address_landmark` | `text` | Nearby landmark. |
| `role` | `varchar` | System access role (`customer` or `admin`). |
| `wants_announcements` | `bool` | Marketing email subscription preference flag. |
| `created_at` | `timestamptz` | Account profile creation timestamp. |
| `updated_at` | `timestamptz` | Last profile update timestamp. |

#### Table 15. Trips
*Records scheduled vessel departure runs, cargo weight capacities, pricing rates, and trip progress.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key identifier for trip run. |
| `trip_number` | `varchar` | Unique trip alphanumeric code (e.g. `TRIP-20260924-881`). |
| `origin` | `varchar` | Port of origin (`Manila` or `Bohol`). |
| `destination` | `varchar` | Port of destination (`Bohol` or `Manila`). |
| `departure_date` | `timestamptz` | Scheduled departure date and time. |
| `arrival_date` | `timestamptz` | Estimated/actual arrival date and time. |
| `departure_at` | `timestamptz` | Actual timestamp when trip was marked `in_transit`. |
| `capacity` | `int4` | Maximum cargo weight allowance in kilograms. |
| `price_per_kg` | `numeric` | Applied freight pricing rate per kilogram (PHP/kg). |
| `status` | `char` | Operational trip state (`scheduled`, `in_transit`, `arrived`, `completed`, `cancelled`). |
| `notes` | `text` | Operational trip notes or weather advisories. |
| `created_by` | `uuid` | Foreign key referencing admin who created trip. |
| `created_at` | `timestamptz` | Creation timestamp. |
| `updated_at` | `timestamptz` | Last update timestamp. |

#### Table 16. User_device_tokens
*Manages browser and mobile web push notification device tokens.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key identifier for device token entry. |
| `user_id` | `uuid` | Foreign key referencing user account. |
| `token` | `text` | Web Push subscription token string. |
| `device_id` | `text` | Hardware/browser installation fingerprint identifier. |
| `created_at` | `timestamptz` | Token registration timestamp. |

#### Table 17. Legal_consents
*Records formal user acceptance of terms of service and privacy policy versions.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key identifier for consent record. |
| `user_id` | `uuid` | Foreign key referencing agreeing user. |
| `document_type` | `text` | Type of legal document (`terms_of_service` or `privacy_policy`). |
| `document_version` | `text` | Exact version string agreed to (e.g., `v1.0`). |
| `source` | `text` | Context where consent was given (`registration`, `checkout`, `modal`). |
| `accepted_at` | `timestamptz` | Consent timestamp. |

#### Table 18. Legal_documents
*Stores versioned content and effective publication dates for legal policies.*
| Field Name | Data Type | Description |
|---|---|---|
| `document_type` | `text` | Document category identifier (composite primary key part 1). |
| `version` | `text` | Document version string (composite primary key part 2). |
| `url_path` | `text` | Path to full legal document text. |
| `is_current` | `bool` | Flag designating current active version. |
| `effective_at` | `timestamptz` | Date when version takes legal effect. |
| `published_at` | `timestamptz` | Publication timestamp. |

#### Table 19. Payment_refunds
*Manages and logs provider-issued (PayMongo) and manually recorded financial refunds.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key identifier for refund record. |
| `order_id` | `uuid` | Foreign key referencing refunded order. |
| `payment_transaction_id` | `uuid` | Foreign key linking original payment transaction. |
| `payment_id` | `text` | External payment provider transaction ID. |
| `refund_id` | `text` | PayMongo refund ID (`ref_...`) or manual reference. |
| `amount` | `numeric` | Refund monetary value (PHP). |
| `currency` | `text` | Currency code (`PHP`). |
| `status` | `text` | Refund state (`creating`, `pending`, `succeeded`, `failed`, `confirmed`). |
| `refund_channel` | `text` | Refund channel (`paymongo` or `manual`). |
| `return_method` | `text` | Settlement method for manual returns (`Cash` or `GCash`). |
| `return_reference` | `text` | Reference number for manual return. |
| `returned_at` | `timestamptz` | Date when funds were handed back to customer. |
| `reason` | `text` | Justification for refund. |
| `notes` | `text` | Detailed administrative refund notes. |
| `livemode` | `bool` | Production vs test mode indicator. |
| `initiated_by` | `uuid` | Foreign key referencing admin who processed refund. |
| `initiated_by_name` | `text` | Name of initiating admin. |
| `outcome_uncertain` | `bool` | Flag indicating if external gateway confirmation is pending. |
| `public_failure_reason` | `text` | Customer-safe sanitized error summary. |
| `last_error` | `text` | Detailed technical diagnostic log. |
| `last_event_id` | `text` | Gateway webhook event reference. |
| `provider_created_at` | `timestamptz` | Provider refund creation timestamp. |
| `provider_updated_at` | `timestamptz` | Provider last update timestamp. |
| `succeeded_at` | `timestamptz` | Effective financial success timestamp used for reporting. |
| `idempotency_key` | `uuid` | Unique key preventing duplicate refund requests. |
| `created_at` | `timestamptz` | Record creation timestamp. |
| `updated_at` | `timestamptz` | Record last update timestamp. |

#### Table 20. Photo_cleanup_queue
*Asynchronous retry queue for removing deleted or replaced cargo proof photos from storage.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `bigint` | Primary key identifier for cleanup item. |
| `provider` | `text` | Cloud storage host provider (`supabase` or `firebase`). |
| `storage_path` | `text` | Direct file path targeted for removal. |
| `queued_at` | `timestamptz` | Enqueue timestamp. |
| `completed_at` | `timestamptz` | Successful deletion execution timestamp. |
| `attempts` | `int4` | Count of deletion attempts executed. |
| `last_error` | `text` | Error log from failed deletion attempt. |

#### Table 21. Photo_storage_events
*Operational audit log tracking photo upload, archiving, and deletion events.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key identifier for storage event. |
| `event_type` | `text` | Event category (`upload`, `archive`, `deletion`, `fallback`). |
| `provider` | `text` | Target storage provider (`supabase` or `firebase`). |
| `outcome` | `text` | Result status (`success` or `error`). |
| `photo_type` | `text` | Photo classification (`pickup` or `delivery`). |
| `order_id` | `uuid` | Optional foreign key linking order. |
| `storage_path` | `text` | Target file storage path. |
| `size_bytes` | `bigint` | File size in bytes. |
| `message` | `text` | System diagnostic remarks. |
| `metadata` | `jsonb` | Additional technical execution metadata. |
| `created_by` | `uuid` | Foreign key referencing actor who triggered event. |
| `created_at` | `timestamptz` | Event timestamp. |

#### Table 22. Photo_storage_settings
*Global configuration managing primary and fallback photo storage providers.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `bool` | Primary key enforced single-row constraint (`true`). |
| `upload_mode` | `text` | Active storage routing mode (`automatic`, `supabase`, `firebase`). |
| `force_firebase_expires_at` | `timestamptz` | Override expiration timestamp when forced to fallback. |
| `reason` | `text` | Administrative justification for storage mode selection. |
| `updated_by` | `uuid` | Foreign key referencing admin who updated settings. |
| `updated_at` | `timestamptz` | Configuration update timestamp. |

#### Table 23. Cancellation_settlements
*(New Table). Stores current agreed financial decision for cancelled orders.*
| Field Name | Data Type | Description |
|---|---|---|
| `order_id` | `uuid` | Primary key and foreign key referencing cancelled order. |
| `decision_type` | `text` | Settlement decision (`full_refund`, `partial_refund`, `forfeit`). |
| `agreed_retained_amount` | `numeric` | Amount retained by business to cover incurred costs (PHP). |
| `customer_agreement_confirmed` | `bool` | Flag indicating customer confirmed settlement terms. |
| `customer_agreement_confirmed_at` | `timestamptz` | Timestamp of customer agreement confirmation. |
| `internal_notes` | `text` | Administrative notes detailing settlement agreement. |
| `decided_by` | `uuid` | Foreign key referencing admin who finalized decision. |
| `decided_at` | `timestamptz` | Decision commitment timestamp. |
| `updated_at` | `timestamptz` | Last update timestamp. |
| `version` | `integer` | Revision counter for settlement updates. |
| `last_idempotency_key` | `uuid` | Unique key preventing duplicate settlement entries. |

#### Table 24. Cancellation_settlement_history
*(New Table). Immutable audit log of all initial and revised cancellation settlement decisions.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key identifier for settlement audit entry. |
| `order_id` | `uuid` | Foreign key referencing associated cancelled order. |
| `tracking_number` | `text` | Tracking number of cancelled order. |
| `action` | `text` | Settlement action logged (`created`, `updated`, `refund_recorded`). |
| `old_decision` | `jsonb` | JSON snapshot of previous settlement state. |
| `new_decision` | `jsonb` | JSON snapshot of newly applied settlement state. |
| `changed_by` | `uuid` | Foreign key referencing acting admin. |
| `changed_by_name` | `text` | Display name of acting admin. |
| `idempotency_key` | `uuid` | Unique transaction idempotency identifier. |
| `changed_at` | `timestamptz` | Audit timestamp. |

#### Table 25. Announcement_email_broadcasts
*(New Table). Durable background job queue for email announcement broadcasts.*
| Field Name | Data Type | Description |
|---|---|---|
| `announcement_id` | `uuid` | Primary key and foreign key referencing source announcement. |
| `subject` | `text` | Email subject header string. |
| `content` | `text` | Email body text snapshot. |
| `from_email` | `text` | Sender email address. |
| `status` | `text` | Broadcast status (`pending`, `processing`, `completed`, `failed`). |
| `claim_token` | `uuid` | Worker lease token identifier. |
| `claim_expires_at` | `timestamptz` | Lease expiration timestamp. |
| `total_recipients` | `integer` | Total queued target recipient count. |
| `accepted_count` | `integer` | Successfully delivered email count. |
| `skipped_count` | `integer` | Skipped/unsubscribed address count. |
| `retryable_count` | `integer` | Temporary failure count pending retry. |
| `failed_count` | `integer` | Permanent delivery failure count. |
| `needs_review_count` | `integer` | Entries requiring admin review. |
| `cta_label` | `text` | Optional email button label snapshot. |
| `cta_url` | `text` | Optional email button URL snapshot. |
| `created_at` | `timestamptz` | Queue creation timestamp. |
| `updated_at` | `timestamptz` | Last broadcast status update timestamp. |
| `completed_at` | `timestamptz` | Completion timestamp. |

#### Table 26. Announcement_email_recipients
*(New Table). Tracks per-recipient delivery status and retry schedules for email broadcasts.*
| Field Name | Data Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key identifier for email delivery record. |
| `announcement_id` | `uuid` | Foreign key referencing parent broadcast job. |
| `email` | `text` | Target recipient email address. |
| `status` | `text` | Delivery status (`pending`, `accepted`, `failed`, `skipped`). |
| `attempts` | `integer` | Delivery retry attempt counter. |
| `claim_token` | `uuid` | Background worker claim lease token. |
| `claim_expires_at` | `timestamptz` | Lease expiration timestamp. |
| `first_attempt_at` | `timestamptz` | Initial delivery attempt timestamp. |
| `next_attempt_at` | `timestamptz` | Scheduled retry timestamp. |
| `provider_message_id` | `text` | Resend/email gateway response ID. |
| `last_error` | `text` | Error details from failed email delivery. |
| `accepted_at` | `timestamptz` | Successful delivery timestamp. |
| `idempotency_key` | `text` | Unique key preventing duplicate emails. |
| `created_at` | `timestamptz` | Record creation timestamp. |
| `updated_at` | `timestamptz` | Last update timestamp. |

#### Table 27. Email_subscriptions
*(New Table). Centralized registry of customer announcement email marketing opt-in preferences.*
| Field Name | Data Type | Description |
|---|---|---|
| `email` | `text` | Normalized email address (primary key). |
| `subscribed` | `bool` | Marketing subscription opt-in status flag. |
| `source` | `text` | Origin of subscription preference (`registration`, `contact_form`, `unsubscribe_link`). |
| `updated_by` | `uuid` | Foreign key referencing updating user/admin profile. |
| `created_at` | `timestamptz` | Record creation timestamp. |
| `updated_at` | `timestamptz` | Preference update timestamp. |

#### Table 28. Private.manual_refund_reauth_attempts
*(New Table - Private Schema). Security rate-limiter tracking failed admin password attempts during manual refund authorization.*
| Field Name | Data Type | Description |
|---|---|---|
| `admin_id` | `uuid` | Foreign key referencing admin profile (primary key). |
| `failed_count` | `integer` | Count of consecutive failed re-authentication password entries. |
| `first_failed_at` | `timestamptz` | Timestamp of first failed attempt in window. |
| `locked_until` | `timestamptz` | Security lockout expiration timestamp. |
| `updated_at` | `timestamptz` | Last counter update timestamp. |

#### Table 29. Private.paymongo_refund_recovery_jobs
*(New Table - Private Schema). Automated background worker queue for polling and recovering asynchronous PayMongo refund events.*
| Field Name | Data Type | Description |
|---|---|---|
| `payment_transaction_id` | `uuid` | Primary key and foreign key referencing payment transaction. |
| `payment_id` | `text` | External PayMongo payment identifier. |
| `livemode` | `bool` | Production environment flag. |
| `status` | `text` | Recovery queue state (`active`, `completed`, `failed`). |
| `scan_until` | `timestamptz` | End boundary timestamp for polling window. |
| `next_check_at` | `timestamptz` | Scheduled timestamp for next polling check. |
| `last_checked_at` | `timestamptz` | Last executed check timestamp. |
| `last_success_at` | `timestamptz` | Last successful recovery timestamp. |
| `last_refund_count` | `integer` | Count of detected provider refunds. |
| `consecutive_failures` | `integer` | Failures counter before flagging for admin review. |
| `last_error` | `text` | Technical error description. |
| `claim_token` | `uuid` | Background recovery worker lease token. |
| `claimed_at` | `timestamptz` | Worker claim timestamp. |
| `created_at` | `timestamptz` | Queue creation timestamp. |
| `updated_at` | `timestamptz` | Last record update timestamp. |

---

## 6. Summary of Action Items for Document Finalization

1.  **DOCX Manuscript Updating:** Apply the text and data dictionary updates detailed above directly to the manuscript source file.
2.  **Visual Diagram Editing:** Using the Diagram Revision Specifications in Section 4.2, update the graphical figures for Figure 21 (Context Diagram), DFD Event List Diagrams (Figures 22–37), and Program Hierarchy Diagrams (Figures 38–40) in your diagram software (Visio / Draw.io / LucidaChart).
3.  **Renumbering & Captions:** Renumber the Proposed System Operating Cost table on Page 82 to **Table 30** and update the caption on Page 96 to **Preview 24: Announcement Management**.

*All review items and manuscript specifications are derived directly from the audited production code repository.*
