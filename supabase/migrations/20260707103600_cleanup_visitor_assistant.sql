-- 20260707103600_cleanup_visitor_assistant.sql

DROP TABLE IF EXISTS public.chat_faqs;
DROP TABLE IF EXISTS public.chatbot_analytics;
DROP TABLE IF EXISTS public.chatbot_unanswered_queries;

DELETE FROM public.global_settings WHERE setting_key LIKE 'visitor_assistant_%';
