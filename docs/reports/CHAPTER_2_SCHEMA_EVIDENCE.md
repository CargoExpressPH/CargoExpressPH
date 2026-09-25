# CHAPTER 2 SCHEMA EVIDENCE

## 1. Column Definitions and Primary Keys

### Table: activity_logs
| Column Name | Data Type | Primary Key |
|---|---|---|
| id | `uuid` | Yes |
| admin_id | `uuid` | No |
| admin_name | `text` | No |
| module | `text` | No |
| action | `text` | No |
| record_type | `text` | No |
| record_id | `uuid` | No |
| record_ref | `text` | No |
| previous_value | `jsonb` | No |
| new_value | `jsonb` | No |
| details | `text` | No |
| created_at | `timestamp with time zone` | No |
| client_event_id | `uuid` | No |

### Table: announcements
| Column Name | Data Type | Primary Key |
|---|---|---|
| id | `uuid` | Yes |
| title | `character varying(200)` | No |
| content | `text` | No |
| author_id | `uuid` | No |
| is_active | `boolean` | No |
| created_at | `timestamp with time zone` | No |
| updated_at | `timestamp with time zone` | No |
| comments | `jsonb` | No |
| send_email | `boolean` | No |
| emailed_at | `timestamp with time zone` | No |
| cta_label | `text` | No |
| cta_url | `text` | No |
| audience | `text` | No |

### Table: cancellation_settlements
| Column Name | Data Type | Primary Key |
|---|---|---|
| order_id | `uuid` | Yes |
| decision_type | `text` | No |
| agreed_retained_amount | `numeric(10,2)` | No |
| customer_agreement_confirmed | `boolean` | No |
| customer_agreement_confirmed_at | `timestamp with time zone` | No |
| internal_notes | `text` | No |
| decided_by | `uuid` | No |
| decided_at | `timestamp with time zone` | No |
| updated_at | `timestamp with time zone` | No |
| version | `integer` | No |
| last_idempotency_key | `uuid` | No |

### Table: chat_messages
| Column Name | Data Type | Primary Key |
|---|---|---|
| id | `uuid` | Yes |
| conversation_id | `uuid` | No |
| sender_id | `uuid` | No |
| sender_role | `character varying(20)` | No |
| message | `text` | No |
| is_read | `boolean` | No |
| created_at | `timestamp with time zone` | No |

### Table: company_information
| Column Name | Data Type | Primary Key |
|---|---|---|
| id | `uuid` | Yes |
| name | `text` | No |
| short_description | `text` | No |
| long_description | `text` | No |
| banner_image_url | `text` | No |
| banner_title | `text` | No |
| banner_description | `text` | No |
| banner_button_text | `text` | No |
| banner_button_link | `text` | No |
| email | `text` | No |
| facebook | `text` | No |
| smart_phone | `text` | No |
| globe_phone | `text` | No |
| manila_address | `text` | No |
| bohol_address | `text` | No |
| created_at | `timestamp with time zone` | No |
| updated_at | `timestamp with time zone` | No |
| default_price_per_kg | `numeric` | No |
| features | `jsonb` | No |
| coverage | `jsonb` | No |
| default_capacity | `integer` | No |

### Table: contact_inquiries
| Column Name | Data Type | Primary Key |
|---|---|---|
| id | `uuid` | Yes |
| name | `text` | No |
| message | `text` | No |
| status | `text` | No |
| created_at | `timestamp with time zone` | No |
| contact_phone | `text` | No |
| contact_email | `text` | No |
| assigned_admin_id | `uuid` | No |
| first_response_at | `timestamp with time zone` | No |
| resolved_at | `timestamp with time zone` | No |
| push_dispatched_at | `timestamp with time zone` | No |
| push_dispatch_started_at | `timestamp with time zone` | No |
| push_dispatch_claim_id | `uuid` | No |
| ip | `text` | No |
| wants_announcements | `boolean` | No |

### Table: conversations
| Column Name | Data Type | Primary Key |
|---|---|---|
| id | `uuid` | Yes |
| customer_id | `uuid` | No |
| created_at | `timestamp with time zone` | No |
| status | `text` | No |
| escalated | `boolean` | No |
| first_response_at | `timestamp with time zone` | No |
| last_customer_message_at | `timestamp with time zone` | No |
| resolved_at | `timestamp with time zone` | No |
| bot_resolved | `boolean` | No |

### Table: customer_feedback
| Column Name | Data Type | Primary Key |
|---|---|---|
| id | `uuid` | Yes |
| order_id | `uuid` | No |
| customer_id | `uuid` | No |
| rating | `integer` | No |
| message | `text` | No |
| is_hidden | `boolean` | No |
| created_at | `timestamp with time zone` | No |

### Table: notifications
| Column Name | Data Type | Primary Key |
|---|---|---|
| id | `uuid` | Yes |
| user_id | `uuid` | No |
| title | `character varying(200)` | No |
| message | `text` | No |
| type | `character varying(30)` | No |
| reference_id | `uuid` | No |
| is_read | `boolean` | No |
| created_at | `timestamp with time zone` | No |
| payment_transaction_id | `uuid` | No |
| payment_refund_id | `uuid` | No |

### Table: order_status_events
| Column Name | Data Type | Primary Key |
|---|---|---|
| id | `uuid` | Yes |
| order_id | `uuid` | No |
| status | `character varying(30)` | No |
| changed_at | `timestamp with time zone` | No |
| changed_by | `uuid` | No |
| note | `text` | No |

### Table: orders
| Column Name | Data Type | Primary Key |
|---|---|---|
| id | `uuid` | Yes |
| user_id | `uuid` | No |
| trip_id | `uuid` | No |
| origin | `character varying(100)` | No |
| destination | `character varying(100)` | No |
| tracking_number | `character varying(50)` | No |
| sender_phone | `character varying(20)` | No |
| receiver_phone | `character varying(20)` | No |
| package_description | `text` | No |
| actual_weight | `numeric(10,2)` | No |
| shipping_cost | `numeric(10,2)` | No |
| payer_type | `character varying(20)` | No |
| payment_method | `character varying(20)` | No |
| payment_status | `character varying(20)` | No |
| amount_paid | `numeric(10,2)` | No |
| remaining_balance | `numeric(10,2)` | No |
| promised_payment_date | `date` | No |
| status | `character varying(30)` | No |
| notes | `text` | No |
| created_at | `timestamp with time zone` | No |
| updated_at | `timestamp with time zone` | No |
| sender_facebook | `text` | No |
| sender_city | `text` | No |
| receiver_facebook | `text` | No |
| receiver_city | `text` | No |
| receiver_province | `text` | No |
| sender_province | `text` | No |
| pickup_photos | `jsonb` | No |
| delivery_photos | `jsonb` | No |
| payment_reference | `character varying(255)` | No |
| service_area_status | `text` | No |
| service_area_remarks | `text` | No |
| featured_on_website | `boolean` | No |
| featured_title | `text` | No |
| featured_caption | `text` | No |
| featured_image_type | `text` | No |
| featured_at | `timestamp with time zone` | No |
| reassignment_history | `jsonb` | No |
| payment_preference | `text` | No |
| cancellation_details | `jsonb` | No |
| last_reminder_sent_at | `timestamp with time zone` | No |
| sender_barangay | `text` | No |
| sender_street | `text` | No |
| sender_lot_block | `text` | No |
| sender_landmark | `text` | No |
| receiver_barangay | `text` | No |
| receiver_street | `text` | No |
| receiver_lot_block | `text` | No |
| receiver_landmark | `text` | No |
| discount_amount | `numeric(10,2)` | No |
| discount_reason | `text` | No |
| discount_notes | `text` | No |
| discount_applied_by | `uuid` | No |
| discount_applied_at | `timestamp with time zone` | No |
| package_quantity | `integer` | No |
| sender_first_name | `text` | No |
| sender_last_name | `text` | No |
| receiver_first_name | `text` | No |
| receiver_last_name | `text` | No |

### Table: payment_refunds
| Column Name | Data Type | Primary Key |
|---|---|---|
| id | `uuid` | Yes |
| refund_id | `text` | No |
| idempotency_key | `uuid` | No |
| payment_transaction_id | `uuid` | No |
| order_id | `uuid` | No |
| payment_id | `text` | No |
| amount | `numeric(10,2)` | No |
| currency | `text` | No |
| status | `text` | No |
| reason | `text` | No |
| notes | `text` | No |
| livemode | `boolean` | No |
| initiated_by | `uuid` | No |
| initiated_by_name | `text` | No |
| last_error | `text` | No |
| last_event_id | `text` | No |
| provider_created_at | `timestamp with time zone` | No |
| provider_updated_at | `timestamp with time zone` | No |
| created_at | `timestamp with time zone` | No |
| updated_at | `timestamp with time zone` | No |
| outcome_uncertain | `boolean` | No |
| public_failure_reason | `text` | No |
| succeeded_at | `timestamp with time zone` | No |
| refund_channel | `text` | No |
| return_method | `text` | No |
| return_reference | `text` | No |
| returned_at | `timestamp with time zone` | No |

### Table: payment_transactions
| Column Name | Data Type | Primary Key |
|---|---|---|
| id | `uuid` | Yes |
| order_id | `uuid` | No |
| amount | `numeric(10,2)` | No |
| payment_method | `text` | No |
| transaction_reference | `text` | No |
| payment_status | `text` | No |
| admin_id | `uuid` | No |
| admin_name | `text` | No |
| notes | `text` | No |
| created_at | `timestamp with time zone` | No |
| payment_type | `text` | No |
| payment_date | `date` | No |
| receipt_url | `text` | No |
| idempotency_key | `uuid` | No |
| gcash_channel | `text` | No |
| transaction_reference_normalized | `text` | No |

### Table: profiles
| Column Name | Data Type | Primary Key |
|---|---|---|
| id | `uuid` | Yes |
| name | `character varying(100)` | No |
| email | `character varying(100)` | No |
| phone | `character varying(20)` | No |
| address_lot_block | `character varying(255)` | No |
| address_street | `character varying(255)` | No |
| address_barangay | `character varying(255)` | No |
| address_city | `character varying(255)` | No |
| address_province | `character varying(255)` | No |
| role | `character varying(20)` | No |
| created_at | `timestamp with time zone` | No |
| updated_at | `timestamp with time zone` | No |
| facebook_name | `text` | No |
| address_landmark | `text` | No |
| wants_announcements | `boolean` | No |

### Table: trips
| Column Name | Data Type | Primary Key |
|---|---|---|
| id | `uuid` | Yes |
| trip_number | `character varying(50)` | No |
| origin | `character varying(100)` | No |
| destination | `character varying(100)` | No |
| departure_date | `timestamp with time zone` | No |
| arrival_date | `timestamp with time zone` | No |
| status | `character varying(20)` | No |
| notes | `text` | No |
| created_by | `uuid` | No |
| created_at | `timestamp with time zone` | No |
| updated_at | `timestamp with time zone` | No |
| departure_at | `timestamp with time zone` | No |
| estimated_arrival_at | `timestamp with time zone` | No |
| arrived_at | `timestamp with time zone` | No |

## 2. Targeted Resolves

1. **`cancellation_settlements.id`**: Does NOT exist. `order_id` is the primary key.
2. **`payment_transactions.payment_status`**: Enforced in trigger/logic to strictly be `paid`, `partial`, or `unpaid`. It is a `text` field.
3. **`trips.departure_date`**: `timestamp with time zone`.
4. **`orders.sender_first_name`**: `text`.
5. **`orders.shipping_cost`**: Computed strictly BEFORE discount (`shipping_cost = weight * price`). The payable formula is `shipping_cost - discount_amount`.
6. **200 kg capacity allowance**: Applied in `guard_customer_order_insert` and related triggers (`v_capacity + 200`). This is a hard limit; if exceeded, the database raises an exception.
7. **Activity-log cleanup timezone**: Uses `GMT` (UTC) as verified by `SELECT current_setting('cron.timezone')`.

