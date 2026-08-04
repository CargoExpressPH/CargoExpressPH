-- ============================================================
-- 20260805110000_normalize_empty_waiting.sql
--
-- Data repair: a conversation with NO messages cannot be 'waiting'.
--
-- 'waiting' means "the customer spoke last and needs a reply". With zero
-- messages nobody has spoken, so the state is a factual impossibility — it
-- shows an amber badge, bolds the row, and adds to the "needs a reply" count
-- for a thread that contains nothing.
--
-- CAUSE (already fixed in code, 0566617): opening a conversation from the
-- admin sidebar used to call reopenConversation(), which set 'waiting'. So
-- merely clicking a customer's name to consider messaging them marked that
-- customer as waiting on us. The handler no longer touches status at all, so
-- no new rows can land in this state — this migration only cleans up the ones
-- created while the bug was live.
--
-- Empty conversations move to 'bot_active', the state a fresh conversation is
-- born in: nothing has happened yet, and if the customer opens the app the
-- bot greets them.
--
-- Deliberately NOT touched: empty conversations sitting in 'resolved'. Those
-- were resolved by an admin clicking Resolve, so they record a real decision,
-- and they are hidden from the list by default. Rewriting them would be
-- inventing history rather than repairing it.
-- ============================================================

UPDATE public.conversations c
   SET status = 'bot_active'
 WHERE c.status = 'waiting'
   AND NOT EXISTS (
     SELECT 1 FROM public.chat_messages m WHERE m.conversation_id = c.id
   );


-- ============================================================
-- VERIFY (must return 0):
--   SELECT COUNT(*) FROM conversations c
--    WHERE c.status = 'waiting'
--      AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id = c.id);
-- ============================================================
