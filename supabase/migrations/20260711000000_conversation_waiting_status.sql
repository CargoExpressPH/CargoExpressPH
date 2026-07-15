-- Extend conversations.status to include 'waiting_admin'
-- Existing values: 'open', 'closed'
-- New value added: 'waiting_admin' (bot escalated, waiting for human admin)

-- Drop any existing status check constraint (may or may not exist depending on prior migrations)
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_status_check;

-- Add the constraint with all valid values
ALTER TABLE public.conversations ADD CONSTRAINT conversations_status_check
  CHECK (status IN ('open', 'waiting_admin', 'closed'));
