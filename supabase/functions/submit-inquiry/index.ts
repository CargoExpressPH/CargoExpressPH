// Supabase Edge Function: submit-inquiry
// World-class IP-based rate limiting for public contact inquiries (no captcha)
// - Validates input length server-side
// - Enforces IP rate limit (5 per 15 min, 15 global per min) via guard_contact_inquiry_rate_limit trigger
// - Populates `ip` column for accurate DB trigger enforcement
// - Keeps RLS `Anyone can submit` but adds real network-level protection

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, x-client-info, apikey',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })

/**
 * The caller's IP, taken from the header the PLATFORM wrote — not the one the
 * caller sent.
 *
 * `x-forwarded-for` is a chain: each proxy APPENDS the address it saw, so the
 * left-hand entries are whatever the client claimed and the right-hand entry
 * is the one our edge added. Reading `split(',')[0]` — the previous
 * implementation — reads the attacker-supplied end of the chain, so anyone
 * could send `X-Forwarded-For: 1.2.3.4` and get a fresh rate-limit bucket per
 * request. `cf-connecting-ip` is likewise just a header unless the deployment
 * actually sits behind Cloudflare, so it is no longer trusted at all.
 *
 * This is defence in depth rather than the whole defence: `ip` is now a
 * server-owned column (migration 20260825140000), so a client that skips this
 * function entirely cannot write one.
 */
function getClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const hops = xff.split(',').map(part => part.trim()).filter(Boolean)
    if (hops.length > 0) return hops[hops.length - 1]
  }
  const realIp = req.headers.get('x-real-ip')
  if (realIp) return realIp.trim()
  return 'unknown'
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { name, message, contact_phone, contact_email, phone } = await req.json()

    const trimmedName = (name || '').trim()
    const trimmedMessage = (message || '').trim()
    // AboutPage sends contact_phone OR contact_email, plus legacy phone
    const phoneVal = (phone || contact_phone || contact_email || '').trim()

    if (trimmedName.length < 2 || trimmedName.length > 100) {
      return json({ error: 'Name must be 2-100 characters.' }, 400)
    }
    if (trimmedMessage.length < 10 || trimmedMessage.length > 2000) {
      return json({ error: 'Message must be 10-2000 characters.' }, 400)
    }
    if (phoneVal.length < 7 || phoneVal.length > 100) {
      return json({ error: 'Contact must be 7-100 characters.' }, 400)
    }

    const ip = getClientIp(req)

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    // Use anon key with no auth for anon insert, but service_role bypasses RLS anyway
    const adminClient = createClient(supabaseUrl, serviceRoleKey)

    const inquiryId = crypto.randomUUID()
    const legacyPhone = [contact_phone || null, contact_email || null].filter(Boolean).join(' | ') || phoneVal || null

    const { error } = await adminClient.from('contact_inquiries').insert({
      id: inquiryId,
      name: trimmedName,
      phone: legacyPhone || phoneVal,
      message: trimmedMessage,
      contact_phone: contact_phone || null,
      contact_email: contact_email || null,
      ip,
    })

    if (error) {
      // Map DB rate limit exception (42501) to 429 Too Many Requests
      if (error.code === '42501' && error.message?.includes('Too many inquiries')) {
        return json({ error: error.message }, 429)
      }
      // Map CHECK constraint violation
      if (error.code === '23514') {
        return json({ error: 'Please check name (2-100), contact (7-20), message (10-2000).' }, 400)
      }
      // Anything else is an internal fault. The raw driver message names
      // tables, columns and constraints — free schema reconnaissance for an
      // anonymous caller, and useless to the person filling in the form.
      console.error('submit-inquiry insert failed', error)
      return json({ error: 'Could not send your message right now. Please try again.' }, 400)
    }

    // Non-blocking: trigger staff push via send-push (fire and forget, don't await)
    // The send-push function derives payload from the saved row, so no trust on client data
    const pushUrl = `${supabaseUrl}/functions/v1/send-push`
    fetch(pushUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify({ event: 'contact_inquiry', inquiry_id: inquiryId }),
    }).catch(() => {})

    return json({ success: true, id: inquiryId })
  } catch (err) {
    console.error('submit-inquiry failed', err)
    return json({ error: 'Could not send your message right now. Please try again.' }, 500)
  }
})
