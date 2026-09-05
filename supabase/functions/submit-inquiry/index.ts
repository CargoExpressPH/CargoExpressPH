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
 * Resolve the real client IP behind Supabase Edge (Cloudflare + AWS Global Accelerator).
 *
 * Deployment sits behind Cloudflare (cdn-loop: cloudflare, cf-ray) so
 * `cf-connecting-ip` is set by Cloudflare and cannot be spoofed - spoofed
 * values are stripped at the edge (verified 2026-08-29 via debug-ip).
 * `x-forwarded-for` is \"client, client, lb\" - the last hop is the LB
 * (99.82.x.x / 99.83.x.x), not the client, so reading pop() broke per-IP
 * limiting (all users shared LB IP).
 *
 * Trust order: cf-connecting-ip (Cloudflare) -> first public XFF hop
 * (Supabase strips spoofed XFF, verified) -> x-real-ip -> unknown.
 * This preserves spoof protection (ip is server-owned column, direct anon
 * inserts must leave ip NULL) while correctly bucketing per client.
 */
function isValidIp(v: string): boolean {
  // IPv4
  if (/^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)$/.test(v)) return true
  // IPv6 (simplified)
  if (/^[0-9a-fA-F:]+$/.test(v) && v.includes(':')) return true
  return false
}
function isPrivateIp(v: string): boolean {
  if (v.startsWith('10.')) return true
  if (v.startsWith('192.168.')) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(v)) return true
  if (v.startsWith('127.')) return true
  if (v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:')) return true
  return false
}
function isTrustedProxy(v: string): boolean {
  // AWS Global Accelerator Anycast used by Supabase Edge (observed 99.82/99.83)
  return v.startsWith('99.82.') || v.startsWith('99.83.') || v.startsWith('75.2.')
}
function getClientIp(req: Request): string {
  const cf = req.headers.get('cf-connecting-ip')?.trim()
  if (cf && isValidIp(cf) && !isPrivateIp(cf)) return cf
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const hops = xff.split(',').map(part => part.trim()).filter(Boolean)
    for (const hop of hops) {
      if (isValidIp(hop) && !isPrivateIp(hop) && !isTrustedProxy(hop)) return hop
    }
    if (hops.length > 0 && isValidIp(hops[0])) return hops[0]
  }
  const realIp = req.headers.get('x-real-ip')?.trim()
  if (realIp && isValidIp(realIp)) return realIp
  return 'unknown'
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { name, message, contact_phone, contact_email, phone, wants_announcements } = await req.json()

    const trimmedName = (name || '').trim()
    const trimmedMessage = (message || '').trim()
    const trimmedEmail = (contact_email || '').trim()
    // AboutPage sends contact_phone OR contact_email, plus legacy phone
    const phoneVal = (phone || contact_phone || contact_email || '').trim()
    // Only a real `true` opts in — anything else (missing, string "false",
    // truthy-but-not-boolean) is treated as not consenting.
    const wantsAnnouncements = wants_announcements === true

    if (trimmedName.length < 2 || trimmedName.length > 100) {
      return json({ error: 'Name must be 2-100 characters.' }, 400)
    }
    if (trimmedMessage.length < 10 || trimmedMessage.length > 2000) {
      return json({ error: 'Message must be 10-2000 characters.' }, 400)
    }
    if (phoneVal.length < 6 || phoneVal.length > 100) {
      return json({ error: 'Contact must be 6-100 characters.' }, 400)
    }
    // The email-marketing opt-in is meaningless without an address to send
    // to, and requiring both phone and email on the form (per the frontend
    // change) means this should never trip in practice — it's a server-side
    // backstop against a client that skips the form's own validation.
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (wantsAnnouncements && !EMAIL_RE.test(trimmedEmail)) {
      return json({ error: 'A valid email address is required to receive announcements.' }, 400)
    }

    const ip = getClientIp(req)

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    // Use anon key with no auth for anon insert, but service_role bypasses RLS anyway
    const adminClient = createClient(supabaseUrl, serviceRoleKey)

    const inquiryId = crypto.randomUUID()
    // Dual-write legacy phone for rollback; cap to 100 to satisfy CHECK 7-100.
    // Normalized columns contact_phone/email hold the full values.
    const rawLegacy = [contact_phone || null, contact_email || null].filter(Boolean).join(' | ') || phoneVal || null
    const legacyPhone = rawLegacy && rawLegacy.length > 100 ? rawLegacy.slice(0, 100) : rawLegacy

    const { error } = await adminClient.from('contact_inquiries').insert({
      id: inquiryId,
      name: trimmedName,
      phone: legacyPhone || phoneVal,
      message: trimmedMessage,
      contact_phone: contact_phone || null,
      contact_email: contact_email || null,
      wants_announcements: wantsAnnouncements,
      ip,
    })

    if (error) {
      // Map DB rate limit exception (42501) to 429 Too Many Requests
      if (error.code === '42501' && error.message?.includes('Too many inquiries')) {
        return json({ error: error.message }, 429)
      }
      // Map CHECK constraint violation
      if (error.code === '23514') {
        return json({ error: 'Please check name (2-100), contact (6-100), message (10-2000).' }, 400)
      }
      // Anything else is an internal fault. The raw driver message names
      // tables, columns and constraints — free schema reconnaissance for an
      // anonymous caller, and useless to the person filling in the form.
      console.error('submit-inquiry insert failed', error)
      return json({ error: 'Could not send your message right now. Please try again.' }, 400)
    }

    // The database trigger creates each admin notification in this transaction.
    // Its notification trigger then creates durable per-device delivery jobs;
    // pg_cron processes them independently of this request lifecycle.

    return json({ success: true, id: inquiryId })
  } catch (err) {
    console.error('submit-inquiry failed', err)
    return json({ error: 'Could not send your message right now. Please try again.' }, 500)
  }
})
