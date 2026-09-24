// Browser adapter for the shared support engine. The Edge Function supplies
// its own authenticated, RLS-scoped client to the same rules.
import { supabase } from './supabase';
import { createSupportChatEngine } from './supportChatEngineFactory';

export const {
  createConversationContext, resetConversationContext, getSupportKnowledgeCatalog,
  SUPPORT_ACTIONS, getMainMenuActions, summarizePaymentActivity,
  getBotReplyForAction, getBotReply, BOT_GREETING, BOT_WELCOME_BACK,
} = createSupportChatEngine(supabase);
