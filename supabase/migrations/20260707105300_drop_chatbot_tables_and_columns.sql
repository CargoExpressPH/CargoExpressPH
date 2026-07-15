-- 20260707105300_drop_chatbot_tables_and_columns.sql

-- 1. Drop the requested tables
DROP TABLE IF EXISTS public.chatbot_logs;
DROP TABLE IF EXISTS public.chat_faqs;

-- 2. Remove the requested columns from company_information
ALTER TABLE public.company_information
  DROP COLUMN IF EXISTS visitor_assistant_status,
  DROP COLUMN IF EXISTS visitor_assistant_welcome_title,
  DROP COLUMN IF EXISTS visitor_assistant_welcome_message,
  DROP COLUMN IF EXISTS visitor_assistant_offline_message,
  DROP COLUMN IF EXISTS visitor_assistant_quick_questions;
