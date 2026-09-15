# Chapter 2 Database Comparison Report

**Inspection Date:** 2026-09-13
**Evidence Sources:** Live Supabase database schema (via `supabase db query --linked`)

## 1. Verified Current Table Inventory
The application currently runs on **22 active tables**.

## 2. Manuscript-Versus-Database Coverage
* **Missing Manuscript Tables (Present in DB but undocumented):** 4
* **Obsolete Manuscript Tables (Documented but removed from DB):** 1 (`notification_delivery_attempts`)
* **Existing Tables Requiring Field Corrections:** 9

## 3. Field-by-Field Discrepancies

### Table 4. company_information (Page 52)
* **Missing from DB:** `website`. (No longer present).
* **Missing from MS:** `features`. (Documentation omission).
* **Missing from MS:** `coverage`. (Documentation omission).
* **Correction Required:** Remove `website`, add `features` and `coverage`.

### Table 9. notifications (Page 55)
* **Missing from MS:** `title`. (Documentation omission).
* **Missing from MS:** `payment_transaction_id`. (Documentation omission).
* **Missing from MS:** `payment_refund_id`. (Documentation omission).
* **Correction Required:** Add these three missing fields. 

### Table 11. orders (Page 56)
* **Missing from MS:** `sender_barangay`, `sender_street`, `sender_lot_block`, `sender_landmark`.
* **Missing from MS:** `receiver_barangay`, `receiver_street`, `receiver_lot_block`, `receiver_landmark`.
* **Missing from MS:** `discount_amount`, `discount_reason`, `discount_notes`, `discount_applied_by`, `discount_applied_at`.
* **Correction Required:** Add the 8 structured address fields and 5 discount fields.

### Table 12. payment_attempts (Page 59)
* **Missing from MS:** `promised_payment_date`.
* **Correction Required:** Add `promised_payment_date` to the table documentation.

### Table 13. payment_transactions (Page 60)
* **Missing from MS:** `created_at`, `payment_type`, `payment_date`, `idempotency_key`, `gcash_channel`, `transaction_reference_normalized`.
* **Correction Required:** Add the 6 missing columns.

### Table 15. trips (Page 61)
* **Missing from MS:** `notes`.
* **Correction Required:** Add `notes` to the table documentation.

### Table 17. legal_consents (Page 62)
* **Data Type Correction:** `accepted_at`. MS states `text`, live DB uses `timestamptz`.
* **Correction Required:** Update data type.

### Table 19. notification_delivery_jobs (Page 63)
* **Missing from MS:** `attempt_count`, `available_at`, `claimed_at`, `claim_id`, `completed_at`, `last_error`, `created_at`, `updated_at`.
* **Correction Required:** Add these operational columns.

## 4. Tables with No Required Changes
These tables were verified and exactly match the manuscript:
* `activity_logs`
* `announcements`
* `chat_messages`
* `contact_inquiries`
* `conversations`
* `customer_feedback`
* `order_status_events`
* `profiles`
* `user_device_tokens`
* `legal_documents`

## 5. Obsolete Entries
* **Table 8. notification_delivery_attempts** (Page 55): This table no longer exists in the current database. It must be removed from the manuscript.

## 6. Numbering Corrections

The manuscript has a numbering conflict: **Table 19** is used twice (for `notification_delivery_jobs` on page 63, and for `Proposed System Annual Operating Cost` on page 80).

Due to the removal of Table 8, all subsequent tables shift up by one. The four newly documented tables are appended sequentially.

### Old-to-Proposed Numbering Map:
* Table 1-7: Keep numbers 1-7
* Table 8 (notification_delivery_attempts): REMOVED
* Table 9 (notifications) -> **New Table 8**
* Table 10 (order_status_events) -> **New Table 9**
* Table 11 (orders) -> **New Table 10**
* Table 12 (payment_attempts) -> **New Table 11**
* Table 13 (payment_transactions) -> **New Table 12**
* Table 14 (profiles) -> **New Table 13**
* Table 15 (trips) -> **New Table 14**
* Table 16 (user_device_tokens) -> **New Table 15**
* Table 17 (legal_consents) -> **New Table 16**
* Table 18 (legal_documents) -> **New Table 17**
* Table 19 (notification_delivery_jobs) -> **New Table 18**
* (NEW) payment_refunds -> **New Table 19**
* (NEW) photo_cleanup_queue -> **New Table 20**
* (NEW) photo_storage_events -> **New Table 21**
* (NEW) photo_storage_settings -> **New Table 22**
* Table 19 (Proposed System Annual Operating Cost) -> **New Table 23**

## 7. Revision Checklist
- [ ] Remove `notification_delivery_attempts`.
- [ ] Replace existing Tables 4, 9, 11, 12, 13, 15, 17, and 19 with the corrected entries.
- [ ] Append the four new tables (payment_refunds, photo_cleanup_queue, photo_storage_events, photo_storage_settings).
- [ ] Update table numbers based on the mapping above.
- [ ] Update Table 19 on page 80 to become Table 23.
