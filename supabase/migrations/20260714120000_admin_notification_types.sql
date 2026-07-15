-- =====================================================================
-- Migration: Expand notification types for admin notification system
-- Adds 'inquiry', 'feedback', 'chat_message' to the allowed types
-- =====================================================================

-- Drop the existing constraint and recreate with expanded types
ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('order_update', 'trip_update', 'announcement', 'general', 'inquiry', 'feedback', 'chat_message'));
