-- 20260626000000_visitor_assistant_enhancements.sql

-- 1. Alter chat_faqs table
ALTER TABLE public.chat_faqs
ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Others',
ADD COLUMN IF NOT EXISTS faq_type TEXT DEFAULT 'static', -- 'static', 'system', 'action', 'navigation'
ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft', -- 'published', 'draft', 'disabled'
ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'Normal', -- 'Critical', 'High', 'Normal', 'Low'
ADD COLUMN IF NOT EXISTS supported_languages TEXT[] DEFAULT ARRAY['en'],
ADD COLUMN IF NOT EXISTS quick_actions JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS dependencies TEXT[] DEFAULT '{}'::text[],
ADD COLUMN IF NOT EXISTS last_reviewed_at TIMESTAMPTZ DEFAULT NOW();

-- Create an index to quickly find published FAQs
CREATE INDEX IF NOT EXISTS idx_chat_faqs_status ON public.chat_faqs(status);

-- Seed initial global settings for Visitor Assistant if they don't exist
INSERT INTO public.global_settings (setting_key, setting_value)
VALUES 
    ('visitor_assistant_status', 'online'),
    ('visitor_assistant_offline_message', 'Our virtual assistant is currently unavailable. Please use Track Package or Contact Us.'),
    ('visitor_assistant_welcome_title', 'CargoExpress Assistant'),
    ('visitor_assistant_welcome_message', 'Hi! How can I help you today?'),
    ('visitor_assistant_quick_questions', '["Track Package", "Estimate Shipping Cost", "Contact Us"]')
ON CONFLICT (setting_key) DO NOTHING;

-- 2. Create chatbot_unanswered_queries table
CREATE TABLE IF NOT EXISTS public.chatbot_unanswered_queries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT,
    query TEXT,
    detected_language TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    resolved BOOLEAN DEFAULT false
);

-- RLS for chatbot_unanswered_queries
ALTER TABLE public.chatbot_unanswered_queries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can insert unanswered queries" ON public.chatbot_unanswered_queries;
CREATE POLICY "Anyone can insert unanswered queries"
    ON public.chatbot_unanswered_queries
    FOR INSERT
    WITH CHECK (true);

DROP POLICY IF EXISTS "Admins can view unanswered queries" ON public.chatbot_unanswered_queries;
CREATE POLICY "Admins can view unanswered queries"
    ON public.chatbot_unanswered_queries
    FOR SELECT
    TO authenticated
    USING (true);
    
DROP POLICY IF EXISTS "Admins can update unanswered queries" ON public.chatbot_unanswered_queries;
CREATE POLICY "Admins can update unanswered queries"
    ON public.chatbot_unanswered_queries
    FOR UPDATE
    TO authenticated
    USING (true);

-- 3. Alter chatbot_analytics table
ALTER TABLE public.chatbot_analytics
ADD COLUMN IF NOT EXISTS response_time_ms INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS visitor_satisfaction BOOLEAN,
ADD COLUMN IF NOT EXISTS visitor_journey TEXT[] DEFAULT '{}'::text[];
