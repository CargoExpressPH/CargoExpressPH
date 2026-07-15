-- Migration: Add detected_language to chatbot_analytics
-- Description: Adds a column to log the language detected in visitor queries.

ALTER TABLE public.chatbot_analytics
ADD COLUMN IF NOT EXISTS detected_language TEXT;
