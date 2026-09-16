-- =========================================================================
-- CARGOEXPRESS PH - DEFENSE DATA RESET SCRIPT
-- =========================================================================
-- WARNING: This will permanently DELETE ALL DATA from the tables listed below.
-- It DOES NOT delete the tables themselves, only the rows inside them.
-- 
-- Kept Tables (Data preserved):
--   profiles, legal_consents, legal_documents, company_information, 
--   photo_storage_settings, user_device_tokens
-- =========================================================================

TRUNCATE TABLE
  public.orders,
  public.order_status_events,
  public.trips,
  public.payment_attempts,
  public.payment_transactions,
  public.customer_feedback,
  public.conversations,
  public.chat_messages,
  public.activity_logs,
  public.notifications,
  public.notification_delivery_jobs,
  public.photo_cleanup_queue,
  public.photo_storage_events,
  public.contact_inquiries,
  public.announcements
CASCADE;

-- Note: The CASCADE keyword ensures that if there are any hidden dependencies 
-- (like foreign keys pointing to orders), those are safely cleared out too 
-- without causing an error.
