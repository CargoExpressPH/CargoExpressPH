// Supabase Edge Function: broadcast-announcement
//
// Emails an announcement to everyone who has actually opted in to receive
// announcement emails — NOT every registered account. Two sources, deduped
// by email address:
//   1. profiles        WHERE role = 'customer' AND wants_announcements = true
//   2. contact_inquiries WHERE wants_announcements = true (public leads)
//
// Caller must be an authenticated admin (verify_jwt = true in config.toml
// rejects unauthenticated requests at the gateway; this function re-checks
// the caller is specifically an admin, the same pattern send-push uses).
//
// Required Supabase secrets:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY        — https://resend.com/api-keys
//   RESEND_FROM_EMAIL     — must be on a domain verified in Resend, e.g.
//                           "CargoExpress PH <announcements@yourdomain.com>"
//   UNSUBSCRIBE_SIGNING_SECRET — any long random string; signs unsubscribe
//                           links so a recipient can only unsubscribe their
//                           own address, never someone else's

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Resend's batch endpoint limit changes over time — verify against current
// Resend docs before relying on this in production. Kept conservative and
// configurable in one place rather than assumed correct forever.
const BATCH_SIZE = 50
const BATCH_DELAY_MS = 600

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('')

/** Same HMAC-SHA256 shape as paymongo-webhook's signature check — signs the
 *  lowercased email so the unsubscribe link only ever works for that address. */
async function signUnsubscribeToken(email: string): Promise<string> {
  const secret = Deno.env.get('UNSUBSCRIBE_SIGNING_SECRET')
  if (!secret) throw new Error('UNSUBSCRIBE_SIGNING_SECRET is not configured')
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(email.toLowerCase().trim()))
  return hex(sig).slice(0, 32)
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

/**
 * Branded HTML template: an image banner header, the announcement, a
 * divider, a fixed bilingual CTA driving signups, an About Us link, and the
 * unsubscribe footer. No emoji anywhere in the template's own copy — only
 * admin-authored announcement content (title/contentHtml) can contain any.
 *
 * Built table-based with every meaningful style inlined — the layout most
 * likely to render correctly across Gmail, Apple Mail and Outlook's Word
 * engine, none of which reliably support modern CSS in email. `title` and
 * `contentHtml` must already be HTML-escaped by the caller.
 */
function buildAnnouncementEmailHtml(title: string, contentHtml: string, unsubscribeUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body,table,td,a{ -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table,td{ mso-table-lspace:0pt; mso-table-rspace:0pt; }
  img{ -ms-interpolation-mode:bicubic; border:0; height:auto; line-height:100%; outline:none; text-decoration:none; }
  body{ margin:0; padding:0; width:100% !important; background:#F1F3F0; }
  @media screen and (max-width:600px){
    .ce-container{ width:100% !important; }
    .ce-padding{ padding-left:20px !important; padding-right:20px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#F1F3F0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F3F0;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" class="ce-container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#FFFFFF;border-radius:12px;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td align="center" style="padding:0;line-height:0;font-size:0;">
              <img
                src="https://cargoexpress-ph.online/images/email%20banner.png"
                alt="CargoExpress PH"
                width="600"
                style="width:100%;max-width:600px;display:block;border:0;outline:none;text-decoration:none;height:auto;">
            </td>
          </tr>

          <!-- Announcement -->
          <tr>
            <td class="ce-padding" style="padding:36px 32px 4px;">
              <h1 style="margin:0 0 16px;font-family:${FONT_STACK};font-size:22px;font-weight:800;color:#1B2320;line-height:1.3;">${title}</h1>
              <p style="margin:0;font-family:${FONT_STACK};font-size:15px;line-height:1.7;color:#333333;">${contentHtml}</p>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td class="ce-padding" style="padding:28px 32px 0;">
              <div style="border-top:1px solid #E5E8E3;line-height:0;font-size:0;">&nbsp;</div>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td class="ce-padding" align="center" style="padding:28px 32px 8px;">
              <p style="margin:0 0 20px;font-family:${FONT_STACK};font-size:14px;line-height:1.7;color:#57635D;">
                Gusto mo bang mas mapadali ang padala mo? Para makapag-book nang mabilis, ma-track ang status ng iyong cargo nang real-time, at makatanggap ng exclusive updates, gumawa na ng libreng account sa amin!
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0" align="center">
                <tr>
                  <td style="border-radius:8px;background:#16A34A;">
                    <a href="https://cargoexpress-ph.online" target="_blank" rel="noopener"
                       style="display:inline-block;padding:14px 36px;font-family:${FONT_STACK};font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:8px;">
                      Visit CargoExpress PH
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- About Us -->
          <tr>
            <td class="ce-padding" align="center" style="padding:16px 32px 32px;">
              <p style="margin:0;font-family:${FONT_STACK};font-size:13px;line-height:1.6;color:#57635D;">
                Gusto mo bang makilala kung sino ang CargoExpress PH?
                <a href="https://cargoexpress-ph.online/about" target="_blank" rel="noopener" style="color:#16A34A;font-weight:700;text-decoration:none;">Alamin ang aming kwento rito</a>
              </p>
            </td>
          </tr>

          <!-- Footer / unsubscribe -->
          <tr>
            <td class="ce-padding" style="padding:20px 32px 28px;background:#F8FAF8;border-top:1px solid #E5E8E3;">
              <p style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:1.6;color:#8A968F;">
                You're receiving this because you opted in to CargoExpress PH announcement emails.
                <a href="${unsubscribeUrl}" style="color:#8A968F;text-decoration:underline;">Unsubscribe</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const resendApiKey = Deno.env.get('RESEND_API_KEY') ?? ''
  const fromEmail = Deno.env.get('RESEND_FROM_EMAIL') ?? ''
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  try {
    // ── Verify the caller is an admin. verify_jwt=true already guarantees a
    // valid JWT reached us; this step is the actual authorization check. ──
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
    const { data: userData, error: userError } = await userClient.auth.getUser()
    if (userError || !userData.user) return json({ error: 'Authentication required' }, 401)

    const { data: requester, error: requesterError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', userData.user.id)
      .single()
    if (requesterError || requester?.role !== 'admin') {
      return json({ error: 'Admin privileges required' }, 403)
    }

    if (!resendApiKey || !fromEmail) {
      return json({ error: 'Email broadcast is not configured (RESEND_API_KEY / RESEND_FROM_EMAIL).' }, 500)
    }

    const { announcement_id } = await req.json()
    if (typeof announcement_id !== 'string' || !announcement_id) {
      return json({ error: 'announcement_id is required' }, 400)
    }

    const { data: announcement, error: announcementError } = await supabase
      .from('announcements')
      .select('id, title, content, send_email, emailed_at')
      .eq('id', announcement_id)
      .maybeSingle()
    if (announcementError) return json({ error: announcementError.message }, 500)
    if (!announcement) return json({ error: 'Announcement not found' }, 404)
    if (!announcement.send_email) return json({ error: 'This announcement was not marked for email broadcast' }, 400)
    // Idempotent: a retry (e.g. the client re-invoking after a timeout) must
    // never re-email everyone a second time.
    if (announcement.emailed_at) return json({ success: true, already_sent: true })

    // ── Build the recipient list, deduped by lowercased email ──
    const recipients = new Map<string, { email: string; name: string | null }>()

    const { data: subscribedProfiles, error: profilesError } = await supabase
      .from('profiles')
      .select('email, name')
      .eq('role', 'customer')
      .eq('wants_announcements', true)
    if (profilesError) return json({ error: profilesError.message }, 500)
    for (const p of subscribedProfiles || []) {
      if (p.email) recipients.set(p.email.toLowerCase().trim(), { email: p.email, name: p.name || null })
    }

    const { data: subscribedInquiries, error: inquiriesError } = await supabase
      .from('contact_inquiries')
      .select('contact_email, name')
      .eq('wants_announcements', true)
      .not('contact_email', 'is', null)
    if (inquiriesError) return json({ error: inquiriesError.message }, 500)
    for (const c of subscribedInquiries || []) {
      const key = (c.contact_email || '').toLowerCase().trim()
      if (key && !recipients.has(key)) recipients.set(key, { email: c.contact_email, name: c.name || null })
    }

    const list = Array.from(recipients.values())
    if (list.length === 0) {
      await supabase.from('announcements').update({ emailed_at: new Date().toISOString() }).eq('id', announcement_id)
      return json({ success: true, sent: 0, failed: 0, note: 'No subscribers opted in yet.' })
    }

    const safeTitle = escapeHtml(announcement.title)
    // Content is admin-authored, not user-authored, but it's still rendered
    // as HTML in a real inbox — escape it the same as any other untrusted
    // string reaching an HTML sink, and preserve line breaks explicitly
    // rather than relying on the (escaped) source having real <br> tags.
    const safeContentHtml = escapeHtml(announcement.content).replace(/\n/g, '<br>')

    let sent = 0
    let failed = 0

    for (const batch of chunk(list, BATCH_SIZE)) {
      const emails = await Promise.all(batch.map(async (recipient) => {
        const token = await signUnsubscribeToken(recipient.email)
        const unsubscribeUrl =
          `${supabaseUrl}/functions/v1/unsubscribe-announcements?email=${encodeURIComponent(recipient.email)}&token=${token}`
        return {
          from: fromEmail,
          to: recipient.email,
          subject: announcement.title,
          html: buildAnnouncementEmailHtml(safeTitle, safeContentHtml, unsubscribeUrl),
          // List-Unsubscribe headers let mailbox providers offer a one-click
          // unsubscribe in their own UI — required by Gmail/Yahoo's 2024
          // bulk-sender rules for any sender pushing real volume.
          headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        }
      }))

      try {
        const res = await fetch('https://api.resend.com/emails/batch', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(emails),
        })
        if (res.ok) {
          sent += batch.length
        } else {
          failed += batch.length
          console.error('[broadcast-announcement] Resend batch failed:', res.status, await res.text())
        }
      } catch (err) {
        failed += batch.length
        console.error('[broadcast-announcement] Resend batch threw:', err)
      }

      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS))
    }

    await supabase.from('announcements').update({ emailed_at: new Date().toISOString() }).eq('id', announcement_id)

    return json({ success: true, sent, failed, total: list.length })
  } catch (err) {
    console.error('[broadcast-announcement] failed:', err)
    return json({ error: 'Broadcast failed. Please try again.' }, 500)
  }
})
