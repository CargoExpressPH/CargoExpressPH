
## Replacement Entries for Existing Tables

Table 4. **Company_information**: This table stores the configurable global details and settings of the company.

| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| id | uuid | Unique identifier for the single company information record. |
| name | text | Stores the display name of the company. |
| short_description | text | Stores a brief description or tagline of the company. |
| long_description | text | Stores the comprehensive background information about the company. |
| banner_image_url | text | Stores the link to the main banner image used on the website homepage. |
| banner_title | text | Stores the primary headline displayed on the homepage banner. |
| banner_description | text | Stores the subtext or supporting description on the homepage banner. |
| banner_button_text | text | Stores the label used for the primary call-to-action button. |
| banner_button_link | text | Stores the destination URL for the primary call-to-action button. |
| email | text | Stores the official contact email address of the company. |
| facebook | text | Stores the link to the company's official Facebook page. |
| messenger | text | Stores the link to the company's official Messenger chat. |
| smart_phone | text | Stores the company's primary Smart contact number. |
| globe_phone | text | Stores the company's primary Globe contact number. |
| manila_address | text | Stores the physical address of the Manila warehouse or office. |
| bohol_address | text | Stores the physical address of the Bohol warehouse or office. |
| features | jsonb | Stores an array of structured features displayed on the website. |
| coverage | jsonb | Stores an array of supported service areas and delivery coverage information. |
| created_at | timestamptz | Records the date and time when the company profile was created. |
| updated_at | timestamptz | Records the date and time when the company details were last updated. |
| default_price_per_kg | numeric | Records the default pricing rate applied to cargo shipments. |

---

Table 8. **Notifications**: This table manages automated alerts and notifications sent to users.

| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| id | uuid | Unique identifier for each notification. |
| user_id | uuid | Stores the identifier of the user receiving the notification. |
| title | text | Stores the summary or title of the notification message. |
| message | text | Stores the main content of the notification message. |
| type | varchar | Indicates the category of the notification such as order updates or general alerts. |
| reference_id | uuid | Stores the identifier of the related record like an order or trip ID. |
| payment_transaction_id | uuid | Ties the notification to an exact ledger row that caused it, preventing duplicates. |
| payment_refund_id | uuid | Ties the notification to an exact refund transaction. |
| is_read | bool | Indicates whether the user has already opened or read the notification. |
| created_at | timestamptz | Records the date and time when the notification was created. |

---

Table 10. **Orders**: This table contains information about individual cargo booking records and their tracking details.

| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| id | uuid | Unique identifier for each booking order. |
| user_id | uuid | Stores the identifier of the customer who placed the order. |
| trip_id | uuid | Stores the identifier of the assigned cargo trip for this order. |
| origin | varchar | Indicates the starting location of the cargo for this order. |
| destination | varchar | Indicates the destination location of the cargo for this order. |
| tracking_number | varchar | Stores the unique tracking code provided to the customer. |
| sender_name | varchar | Stores the full name of the person sending the cargo. |
| sender_phone | varchar | Stores the contact number of the sender. |
| sender_address | text | Stores the complete concatenated address of the sender. |
| sender_barangay | text | Structured address component captured at booking time. |
| sender_street | text | Stores the specific street name of the sender. |
| sender_lot_block | text | Stores the house, lot, or block details of the sender. |
| sender_landmark | text | Stores a notable landmark near the sender. |
| receiver_name | varchar | Stores the full name of the person receiving the cargo. |
| receiver_phone | varchar | Stores the contact number of the receiver. |
| receiver_address | text | Stores the complete concatenated address of the receiver. |
| receiver_barangay | text | Structured address component captured at booking time. |
| receiver_street | text | Stores the specific street name of the receiver. |
| receiver_lot_block | text | Stores the house, lot, or block details of the receiver. |
| receiver_landmark | text | Stores a notable landmark near the receiver. |
| package_description | text | Stores the details and description of the items being shipped. |
| actual_weight | numeric | Records the verified weight of the package in kilograms. |
| shipping_cost | numeric | Records the calculated total cost for shipping the cargo. |
| discount_amount | numeric | Fixed peso amount subtracted from the original shipping cost. |
| discount_reason | text | Records the justification for applying the discount. |
| discount_notes | text | Required free-text explanation for the discount given by the admin. |
| discount_applied_by | uuid | Stores the identifier of the admin who applied the discount. |
| discount_applied_at | timestamptz | Records the timestamp when the discount was applied. |
| payer_type | varchar | Indicates whether the sender or receiver is paying for the shipment. |
| payment_method | varchar | Indicates the chosen mode of payment such as cash or gcash. |
| payment_status | varchar | Indicates the current payment state of the order such as paid or unpaid. |
| amount_paid | numeric | Records the total amount already paid by the customer. |
| remaining_balance | numeric | Records the outstanding amount left to be paid. |
| promised_payment_date | date | Records the date when the customer promised to settle the balance. |
| status | varchar | Indicates the current tracking status of the order such as Pending or In Transit. |
| notes | text | Stores additional administrative notes about the order. |
| created_at | timestamptz | Records the date and time when the order was placed. |
| updated_at | timestamptz | Records the date and time when the order was last updated. |
| sender_facebook | text | Stores the Facebook profile name of the sender. |
| sender_city | text | Stores the city of the sender. |
| receiver_facebook | text | Stores the Facebook profile name of the receiver. |
| receiver_city | text | Stores the city of the receiver. |
| receiver_province | text | Stores the province of the receiver. |
| sender_province | text | Stores the province of the sender. |
| pickup_photos | jsonb | Stores a collection of photo URLs taken during pickup. |
| delivery_photos | jsonb | Stores a collection of photo URLs taken during delivery. |
| payment_reference | varchar | Stores the reference number for the payment transaction. |
| service_area_status | text | Indicates if the delivery address is within the standard service area. |
| service_area_remarks | text | Stores notes regarding the review of the service area. |
| featured_on_website | bool | Indicates if this order is showcased as a featured delivery on the website. |
| featured_title | text | Stores the title used when featuring this order. |
| featured_caption | text | Stores the caption used when featuring this order. |
| featured_image_type | text | Indicates the type of image used for featuring the order. |
| featured_at | timestamptz | Records the date and time when the order was featured. |
| reassignment_history | jsonb | Stores a log of the different trips this order was assigned to. |
| cancellation_details | jsonb | Stores the complete details of the cancellation request. |
| payment_preference | text | Indicates the preferred payment method specified during booking. |
| last_reminder_sent_at | timestamptz | Records when the last payment reminder was sent via email to prevent duplication. |

---

Table 11. **Payment_attempts**: This table tracks individual attempts made through payment gateways.

| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| id | uuid | Unique identifier for each payment attempt record. |
| source_id | text | Stores a unique reference from the payment provider. |
| order_id | uuid | Stores the identifier of the associated order being paid for. |
| amount | numeric | Records the monetary value attempted in this transaction. |
| description | text | Stores a brief description of what the payment covers. |
| status | text | Indicates the outcome of the payment attempt such as pending or failed. |
| payment_id | text | Stores the unique identifier returned by the payment gateway. |
| payment_status | text | Records the detailed status directly from the payment provider. |
| actual_weight | numeric | Records the weight of the package at the time of payment processing. |
| payer_type | varchar | Indicates whether the sender or receiver initiated the payment attempt. |
| pickup_photos | jsonb | Stores a collection of photo URLs related to the payment attempt. |
| last_error | text | Records the error message if the payment attempt failed. |
| reconciled_at | timestamptz | Records the date and time when the payment was matched with internal records. |
| created_by | uuid | Stores the identifier of the user who initiated the payment attempt. |
| created_at | timestamptz | Records the date and time when the payment attempt was created. |
| updated_at | timestamptz | Records the date and time when the payment attempt was last updated. |
| payment_type | text | Indicates whether the attempt is for full payment or pay-later. |
| estimated_cost | numeric | Records the projected cost of the shipment during the attempt. |
| promised_payment_date | date | Records the date the customer promised to pay if using a deferred option. |

---

Table 12. **Payment_transactions**: This table logs all finalized payment records and partial payments made for orders.

| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| id | uuid | Unique identifier for each transaction. |
| order_id | uuid | Stores the identifier of the associated order being paid for. |
| amount | numeric | Records the exact monetary value paid in this transaction. |
| payment_method | text | Indicates the method used for this specific payment. |
| transaction_reference | text | Stores the reference number provided by the payment gateway or bank. |
| payment_status | text | Indicates the status of this specific transaction. |
| admin_id | uuid | Stores the identifier of the admin who processed or verified the payment. |
| admin_name | text | Stores the name of the processing admin for quick reference. |
| notes | text | Stores additional remarks regarding the payment transaction. |
| created_at | timestamptz | Records the date and time when the payment transaction was logged. |
| payment_type | text | Identifies the type or classification of the payment made. |
| payment_date | date | Records the actual date when the payment was collected. |
| receipt_url | text | Stores the link to the uploaded proof of payment image. |
| idempotency_key | uuid | Stable identifier to prevent duplicate payment collections during retries. |
| gcash_channel | text | Identifies the trust path (e.g., paymongo vs manual) for a GCash transaction. |
| transaction_reference_normalized | text | Normalized version of the reference used solely for duplicate detection. |

---

Table 14. **Trips**: This table contains records of scheduled cargo trips between origins and destinations.

| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| id | uuid | Unique identifier for each cargo trip record. |
| trip_number | varchar | Stores the unique alphanumeric code assigned to the trip. |
| origin | varchar | Indicates the starting location or port of the trip. |
| destination | varchar | Indicates the ending location or port of the trip. |
| departure_date | timestamptz | Records the scheduled date and time of departure. |
| arrival_date | timestamptz | Records the expected or actual date and time of arrival. |
| capacity | int4 | Stores the maximum allowable weight capacity for the trip in kilograms. |
| price_per_kg | numeric | Indicates the cost per kilogram for shipping cargo on this trip. |
| status | varchar | Indicates the current state of the trip such as scheduled or completed. |
| notes | text | Stores administrative notes or remarks about the specific trip. |
| created_by | uuid | Stores the identifier of the admin who created the trip record. |
| created_at | timestamptz | Records the date and time when the trip was created. |
| updated_at | timestamptz | Records the date and time when the trip was last updated. |
| departure_at | timestamptz | Records the actual timestamp when the trip was started. |

---

Table 16. **Legal_consents**: This table records the users' agreement and acceptance of specific versions of the system's legal policies.

| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| id | uuid | Unique identifier for each consent record. |
| user_id | uuid | Stores the identifier of the user who owns the device. |
| document_type | text | Indicates the type of legal document accepted. |
| document_version | text | Stores the exact version number of the document the user agreed to. |
| accepted_at | timestamptz | Records the exact date and time the user provided consent. |
| source | text | Indicates where the consent occurred. |

---

Table 18. **Notification_delivery_jobs**: This table queues push notifications for asynchronous background delivery.

| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| id | uuid | Unique identifier for the job. |
| notification_id | uuid | Stores the identifier of the notification to be sent. |
| user_id | uuid | Stores the identifier of the user receiving the notification. |
| device_token_id | uuid | Stores the identifier of the target device token. |
| dedupe_key | text | Unique stable key to prevent duplicate push notifications. |
| status | text | Indicates the current delivery status (pending, processing, retry, sent, skipped, dead). |
| attempt_count | int4 | Records the number of times the system attempted to deliver the notification. |
| available_at | timestamptz | Indicates when the job becomes available for the next processing attempt. |
| claimed_at | timestamptz | Records when a worker claimed the job for processing. |
| claim_id | uuid | Stores the identifier of the worker that claimed the job. |
| completed_at | timestamptz | Records the date and time when the delivery was successfully completed. |
| last_error | text | Stores the message of the most recent delivery failure. |
| created_at | timestamptz | Records when the delivery job was originally created. |
| updated_at | timestamptz | Records the last time the job record was updated. |

---

## Newly Documented Tables

Table 19. **Payment_refunds**: This table manages and tracks refund transactions processed through the system and payment gateways.

| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| id | uuid | Unique identifier for each payment refund record. |
| refund_id | text | Stores the unique identifier returned by the external payment gateway. |
| idempotency_key | uuid | Stable identifier to prevent duplicate refund processing. |
| payment_transaction_id | uuid | Links the refund to the original internal payment transaction record. |
| order_id | uuid | Stores the identifier of the associated order being refunded. |
| payment_id | text | Links the refund to the original external payment gateway transaction. |
| amount | numeric | Records the exact monetary value of the refund. |
| currency | text | Specifies the currency of the refund transaction. |
| status | text | Indicates the current processing state of the refund. |
| reason | text | Stores the justification or category for the refund request. |
| notes | text | Stores additional administrative notes regarding the refund. |
| livemode | bool | Indicates whether the refund occurred in a live or test environment. |
| initiated_by | uuid | Stores the identifier of the user or admin who requested the refund. |
| initiated_by_name | text | Stores the name of the user or admin who requested the refund. |
| last_error | text | Records technical diagnostics or the most recent error message if the refund failed. |
| last_event_id | text | Stores the identifier of the most recent gateway event processed for this refund. |
| provider_created_at | timestamptz | Records the timestamp when the payment provider created the refund. |
| provider_updated_at | timestamptz | Records the timestamp when the payment provider last updated the refund. |
| created_at | timestamptz | Records the date and time when the refund record was created in the system. |
| updated_at | timestamptz | Records the date and time when the refund record was last updated. |
| outcome_uncertain | bool | Indicates if the system cannot establish whether the provider accepted the request. |
| public_failure_reason | text | Stores sanitized, non-technical failure text safe for customer visibility. |

---

Table 20. **Photo_cleanup_queue**: This table schedules and tracks asynchronous removal of orphaned or deleted photos from cloud storage.

| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| id | bigint | Unique identifier for the cleanup queue item. |
| provider | text | Indicates the cloud storage provider hosting the photo. |
| storage_path | text | Stores the direct path to the file slated for removal. |
| queued_at | timestamptz | Records the date and time when the cleanup task was scheduled. |
| completed_at | timestamptz | Records the date and time when the cleanup task was successfully executed. |
| attempts | int4 | Records the number of times the system attempted to delete the photo. |
| last_error | text | Stores the error message from the most recent failed deletion attempt. |

---

Table 21. **Photo_storage_events**: This table logs lifecycle and system events related to photo uploads and storage.

| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| id | uuid | Unique identifier for the storage event record. |
| event_type | text | Indicates the category of the event such as upload, deletion, or failure. |
| provider | text | Identifies the cloud storage provider involved in the event. |
| outcome | text | Records the result of the event such as success or error. |
| photo_type | text | Describes the classification of the photo such as pickup or delivery proof. |
| order_id | uuid | Stores the identifier of the order associated with the photo. |
| storage_path | text | Stores the reference path to the affected photo file. |
| size_bytes | bigint | Records the actual file size of the photo in bytes. |
| message | text | Stores descriptive system remarks or errors regarding the event. |
| metadata | jsonb | Stores additional technical metadata collected during the event. |
| created_by | uuid | Stores the identifier of the user who triggered the storage event. |
| created_at | timestamptz | Records the exact date and time when the event occurred. |

---

Table 22. **Photo_storage_settings**: This table manages global administrative configuration for the photo storage system.

| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| id | bool | Unique constraint ensuring only a single settings record exists. |
| upload_mode | text | Specifies the active strategy or provider for handling photo uploads. |
| force_firebase_expires_at | timestamptz | Indicates when a temporary override forcing Firebase storage expires. |
| reason | text | Stores the administrative justification for the current configuration. |
| updated_by | uuid | Stores the identifier of the admin who last modified the settings. |
| updated_at | timestamptz | Records the date and time when the configuration was last changed. |
