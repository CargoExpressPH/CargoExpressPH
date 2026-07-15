-- Migration: Chatbot Analytics and Dynamic FAQs
-- Description: Adds tables for managing dynamic chatbot FAQs and logging visitor queries.

-- 1. Create chat_faqs table
CREATE TABLE IF NOT EXISTS public.chat_faqs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  intent_id TEXT NOT NULL UNIQUE,
  patterns TEXT[] NOT NULL,
  answer TEXT NOT NULL,
  follow_ups JSONB DEFAULT '[]'::jsonb,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS for chat_faqs
ALTER TABLE public.chat_faqs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view active faqs"
  ON public.chat_faqs
  FOR SELECT
  USING (is_active = true);

CREATE POLICY "Admins can manage faqs"
  ON public.chat_faqs
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- 2. Create chatbot_analytics table
CREATE TABLE IF NOT EXISTS public.chatbot_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT,
  event_type TEXT NOT NULL, -- 'matched', 'fallback', 'escalated', 'tracking', 'estimate'
  intent_id TEXT,
  query TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS for chatbot_analytics
ALTER TABLE public.chatbot_analytics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can insert chatbot analytics"
  ON public.chatbot_analytics
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Admins can view chatbot analytics"
  ON public.chatbot_analytics
  FOR SELECT
  TO authenticated
  USING (true);
