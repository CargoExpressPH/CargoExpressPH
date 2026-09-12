-- Bound high-volume user-authored text at the database boundary. NOT VALID
-- avoids scanning or rejecting historical rows while still enforcing each
-- constraint for every new insert/update after this migration is applied.

BEGIN;

ALTER TABLE public.chat_messages
  DROP CONSTRAINT IF EXISTS chat_messages_message_length;
ALTER TABLE public.chat_messages
  ADD CONSTRAINT chat_messages_message_length
  CHECK (char_length(btrim(message)) BETWEEN 1 AND 1000)
  NOT VALID;

ALTER TABLE public.customer_feedback
  DROP CONSTRAINT IF EXISTS customer_feedback_message_length;
ALTER TABLE public.customer_feedback
  ADD CONSTRAINT customer_feedback_message_length
  CHECK (char_length(btrim(message)) BETWEEN 1 AND 2000)
  NOT VALID;

COMMIT;
