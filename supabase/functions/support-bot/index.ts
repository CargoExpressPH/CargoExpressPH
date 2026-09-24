// Authenticated support assistant. The browser never supplies a bot message:
// this endpoint computes it with the same rules as the app and persists it
// using a server-only credential after verifying conversation ownership.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import { createSupportChatEngine } from '../../../src/lib/supportChatEngineFactory.js'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json' },
})
const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

// The same request must produce the same bot row if the HTTP response was lost.
async function stableId(key: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))
  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = [...hash.slice(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const ESCALATING = 'Please wait while I connect you with one of our support administrators. 🔄'
const THANK_YOU = `Thank you for contacting CargoExpress PH! 😊

Have a great day! If you have another concern in the future, feel free to message us anytime.`

serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const token = req.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!url || !anonKey || !serviceKey) return json({ error: 'Assistant unavailable' }, 503)
  if (!token) return json({ error: 'Sign in required' }, 401)

  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: { user }, error: authError } = await caller.auth.getUser(token)
  if (authError || !user) return json({ error: 'Sign in required' }, 401)

  let input: Record<string, unknown>
  try {
    if (Number(req.headers.get('Content-Length') || 0) > 12_000) return json({ error: 'Invalid request' }, 400)
    const raw = await req.text()
    if (raw.length > 12_000) return json({ error: 'Invalid request' }, 400)
    input = JSON.parse(raw)
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid body')
  } catch {
    return json({ error: 'Invalid request' }, 400)
  }
  if (!isUuid(input.conversationId) || !['greet', 'respond', 'close'].includes(String(input.operation))) {
    return json({ error: 'Invalid conversation or action' }, 400)
  }

  const { data: profile, error: profileError } = await caller.from('profiles')
    .select('role').eq('id', user.id).single()
  if (profileError || profile?.role !== 'customer') return json({ error: 'Customer access required' }, 403)
  const { data: conv, error: convError } = await caller.from('conversations')
    .select('id, status, resolved_at').eq('id', input.conversationId).eq('customer_id', user.id).single()
  if (convError || !conv) return json({ error: 'Conversation not found' }, 404)

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { createConversationContext, getBotReplyForAction, BOT_GREETING, BOT_WELCOME_BACK, SUPPORT_ACTIONS } = createSupportChatEngine(caller)
  const insertBot = async (text: string, id: string) => {
    if (input.operation === 'respond') {
      const { data: current, error: currentError } = await caller.from('conversations')
        .select('status').eq('id', conv.id).single()
      if (currentError || current?.status !== 'bot_active') throw new Error('Human handoff already owns this chat')
    }
    const { data, error } = await admin.from('chat_messages').insert({
      id, conversation_id: conv.id, sender_id: user.id, sender_role: 'bot', message: text,
    }).select('*').single()
    if (!error) return data
    if (error.code === '23505') {
      const existing = await admin.from('chat_messages').select('*').eq('id', id)
        .eq('conversation_id', conv.id).eq('sender_role', 'bot').single()
      if (!existing.error && existing.data) return existing.data
    }
    throw error
  }
  const escalate = async () => {
    const { data, error } = await caller.from('conversations')
      .update({ status: 'waiting', escalated: true }).eq('id', conv.id)
      .select('status').single()
    if (error || data?.status !== 'waiting') throw error || new Error('Escalation failed')
  }

  try {
    if (input.operation === 'greet') {
      const staleResolved = conv.status === 'resolved' && !!conv.resolved_at &&
        Date.now() - new Date(conv.resolved_at).getTime() > 12 * 60 * 60 * 1000
      if (conv.status !== 'bot_active' && !staleResolved) return json({ error: 'A support administrator owns this chat' }, 409)
      const { data: last, error } = await caller.from('chat_messages').select('id, message, sender_role')
        .eq('conversation_id', conv.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (error) throw error
      if (last?.sender_role === 'bot' && [BOT_GREETING, BOT_WELCOME_BACK].includes(last.message)) {
        return json({ message: last })
      }
      const greeting = last ? BOT_WELCOME_BACK : BOT_GREETING
      const message = await insertBot(greeting, await stableId(`greeting:${conv.id}:${last?.id || 'empty'}`))
      return json({ message })
    }

    if (conv.status !== 'bot_active') return json({ error: 'A support administrator owns this chat' }, 409)
    if (input.operation === 'close') {
      const message = await insertBot(THANK_YOU, await stableId(`close:${conv.id}:${String(input.messageId || '')}`))
      return json({ message })
    }

    if (!isUuid(input.customerMessageId) || typeof input.actionId !== 'string' || input.actionId.length > 120) {
      return json({ error: 'Invalid reply request' }, 400)
    }
    const { data: customerMessage, error: messageError } = await caller.from('chat_messages')
      .select('id, sender_id, sender_role').eq('id', input.customerMessageId)
      .eq('conversation_id', conv.id).single()
    if (messageError || customerMessage?.sender_id !== user.id || customerMessage?.sender_role !== 'customer') {
      return json({ error: 'Customer message not found' }, 404)
    }

    const replyId = await stableId(`reply:${conv.id}:${customerMessage.id}`)
    const { data: existing } = await caller.from('chat_messages').select('*').eq('id', replyId)
      .eq('conversation_id', conv.id).eq('sender_role', 'bot').maybeSingle()
    const context = input.context && typeof input.context === 'object' && !Array.isArray(input.context)
      ? input.context : createConversationContext(user.id, conv.id)
    // The server generates every word and verifies all account lookups with
    // the caller's JWT. Never accept client-supplied bot text or sender role.
    const reply = await getBotReplyForAction(input.actionId || SUPPORT_ACTIONS.MAIN_MENU, user.id, context)
    if (reply.unavailable) {
      await escalate()
      return json({ escalated: true, error: 'Assistant information is unavailable; an admin has been notified.' })
    }
    if (reply.escalate) {
      const message = existing || await insertBot(ESCALATING, replyId)
      await escalate()
      return json({ escalated: true, message, context })
    }
    const message = reply.text ? (existing || await insertBot(reply.text, replyId)) : null
    return json({ message, actions: reply.actions || null, navigateTo: reply.navigateTo || null,
      askResolved: !!reply.askResolved, context })
  } catch (error) {
    console.error('[support-bot] Assistant failed:', error)
    // An accepted customer request must not sit unseen in bot_active.
    if (input.operation === 'respond') {
      try {
        const { data: latest } = await caller.from('conversations')
          .select('status').eq('id', conv.id).single()
        if (latest?.status && latest.status !== 'bot_active') {
          return json({ humanHandling: true, status: latest.status })
        }
        await escalate()
        return json({ escalated: true, error: 'The assistant could not answer. An admin has been notified.' })
      } catch (escalationError) {
        console.error('[support-bot] Escalation failed:', escalationError)
      }
    }
    return json({ error: 'The assistant is temporarily unavailable. Please try again.' }, 503)
  }
})
