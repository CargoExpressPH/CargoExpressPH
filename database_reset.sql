-- ==============================================================================
-- DATABASE CLEANUP SCRIPT (FORMAT)
-- ==============================================================================
-- WARNING: This will delete all operational data (Orders, Trips, Payments, etc.)
-- It will NOT delete user accounts, EXCEPT those identified as test accounts.
-- Run this in the Supabase Dashboard > SQL Editor.
-- ==============================================================================

-- 1. DELETE TEST ACCOUNTS (from auth.users)
-- (This automatically deletes their profile and consents if ON DELETE CASCADE is set)
-- Adjust the conditions below to match your test accounts!
DELETE FROM auth.users 
WHERE email ILIKE '%test%' 
   OR email ILIKE '%dummy%' 
   OR email = 'test@example.com';

-- 2. CLEAR ALL OPERATIONAL TABLES
-- Using CASCADE ensures that any dependent rows are also deleted safely.
TRUNCATE TABLE 
    public.orders,
    public.order_status_events,
    public.trips,
    public.payment_transactions,
    public.payment_attempts,
    public.activity_logs,
    public.chat_messages,
    public.conversations,
    public.contact_inquiries,
    public.customer_feedback,
    public.notifications,
    public.photo_storage_events,
    public.photo_cleanup_queue,
    public.user_device_tokens, public.announcements
CASCADE;

-- Note: The following tables are NOT truncated to preserve system setup:
-- - public.company_information
-- - public.legal_documents
-- - public.photo_storage_settings
-- - public.profiles (except the deleted test accounts)
-- - public.legal_consents
-- - public.announcements (remove this comment and add to TRUNCATE if you want them deleted too)
