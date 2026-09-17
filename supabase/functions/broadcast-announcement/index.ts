// Supabase Edge Function: broadcast-announcement
//
// Emails an announcement to everyone subscribed to "Email Updates" (trip
// schedules, promos, announcements) — NOT every registered account, and not
// gated by any single contact_inquiries row. Recipients come from
// email_subscriptions, a dedicated preference keyed by email address (one
// row per address, independent of inquiry status or account existence),
// populated by the public contact form, a customer's own Profile toggle,
// admin-confirmed agreement on an inquiry, or the unsubscribe link. See
// 20260916150000_email_updates_subscription.sql.
//
// This function also fires for a newly published trip: src/lib/database.js
// createTrip() calls createAnnouncement({ send_email: true }) when an admin
// publishes a trip with "announce via email", which reaches this same
// function through the same announcement row/send_email flag.
//
// (Formerly: two sources, deduped by email —
//   1. profiles        WHERE role = 'customer' AND wants_announcements = true
//   2. contact_inquiries WHERE wants_announcements = true (public leads)
// — replaced because those columns could disagree for the same address with
// no way to say which one was current.)
//
// Caller must be an authenticated admin (verify_jwt = true in config.toml
// rejects unauthenticated requests at the gateway; this function re-checks
// the caller is specifically an admin, the same pattern send-push uses).
//
// Required Supabase secrets:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY        â€” https://resend.com/api-keys
//   RESEND_FROM_EMAIL     â€” must be on a domain verified in Resend, e.g.
//                           "CargoExpress PH <announcements@yourdomain.com>"
//   UNSUBSCRIBE_SIGNING_SECRET â€” any long random string; signs unsubscribe
//                           links so a recipient can only unsubscribe their
//                           own address, never someone else's

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import { runAnnouncementBroadcast, type BroadcastAdapter, type ClaimedRecipient } from '../_shared/announcement-broadcast-worker.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const PROVIDER_TIMEOUT_MS = 15_000

const providerFetch = (input: string | URL, init: RequestInit = {}) => fetch(input, {
  ...init,
  redirect: 'error',
  signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
})

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

/** Same HMAC-SHA256 shape as paymongo-webhook's signature check â€” signs the
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

const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
const BRAND_HOME_URL = 'https://www.cargo-express-ph.online'
const BRAND_LOGO_URL = `${BRAND_HOME_URL}/images/logo-nav.png`

/**
 * Branded HTML template: an image banner header, the announcement, a
 * divider, a fixed bilingual CTA driving signups, an About Us link, and the
 * unsubscribe footer. No emoji anywhere in the template's own copy â€” only
 * admin-authored announcement content (title/contentHtml) can contain any.
 *
 * Built table-based with every meaningful style inlined â€” the layout most
 * likely to render correctly across Gmail, Apple Mail and Outlook's Word
 * engine, none of which reliably support modern CSS in email. `title` and
 * `contentHtml` must already be HTML-escaped by the caller.
 */
function buildAnnouncementEmailHtml(
  title: string,
  contentHtml: string,
  unsubscribeUrl: string,
  cta: { label: string; url: string } | null = null,
): string {
  // A trip-reschedule public notice (or any future announcement with an
  // explicit cta_label/cta_url, see 20260917100000_public_trip_reschedule_
  // broadcast.sql) gets its own real button instead of the generic
  // "Visit CargoExpress PH" signup pitch, which doesn't make sense for a
  // notice that's already about a specific trip.
  const ctaBlock = cta ? `
          <!-- CTA -->
          <tr>
            <td class="ce-padding" align="center" style="padding:28px 32px 8px;">
              <table role="presentation" cellpadding="0" cellspacing="0" align="center">
                <tr>
                  <td style="border-radius:8px;background:#16A34A;">
                    <a href="${cta.url}" target="_blank" rel="noopener"
                       style="display:inline-block;padding:14px 36px;font-family:${FONT_STACK};font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:8px;">
                      ${cta.label}
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>` : `
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
          </tr>`

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

          <!-- CargoExpress PH brand header -->
          <tr>
            <td align="center" style="padding:28px 32px 24px; border-bottom:1px solid #e2e8f0; background-color:#ffffff;">
              <a href="${BRAND_HOME_URL}" target="_blank" rel="noopener" aria-label="CargoExpress PH">
                <img src="${BRAND_LOGO_URL}" alt="CargoExpress PH" width="64" height="64" style="display:block;width:64px;height:64px;border:0;border-radius:50%;margin:0 auto 14px;" />
              </a>
              <h1 style="margin:0; font-family:${FONT_STACK}; font-size:32px; font-weight:800; letter-spacing:-1px;">
                <span style="color:#10b981;">CARGO</span><span style="color:#0f172a;">EXPRESS PH</span>
              </h1>
              <p style="margin:8px 0 0; font-family:${FONT_STACK}; font-size:14px; color:#64748b; font-weight:500;">
                Manila &#8644; Bohol Cargo Delivery
              </p>
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

          ${ctaBlock}

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
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const resendApiKey = Deno.env.get('RESEND_API_KEY') ?? ''
  const configuredFromEmail = Deno.env.get('RESEND_FROM_EMAIL') ?? ''
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  try {
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
    if (requesterError || requester?.role !== 'admin') return json({ error: 'Admin privileges required' }, 403)
    if (!resendApiKey || !configuredFromEmail) {
      return json({ error: 'Email broadcast is not configured (RESEND_API_KEY / RESEND_FROM_EMAIL).' }, 500)
    }

    const { announcement_id } = await req.json()
    if (typeof announcement_id !== 'string' || !announcement_id) {
      return json({ error: 'announcement_id is required' }, 400)
    }

    const workerToken = crypto.randomUUID()
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const { data, error } = await supabase.rpc(name, args)
      if (error) throw new Error(`${name}: ${error.message}`)
      return data
    }

    const adapter: BroadcastAdapter = {
      claimBroadcast: (token) => rpc('claim_announcement_email_broadcast', {
        p_announcement_id: announcement_id,
        p_from_email: configuredFromEmail,
        p_worker_token: token,
        p_lease_seconds: 600,
      }),
      claimRecipient: (token) => rpc('claim_announcement_email_recipient', {
        p_announcement_id: announcement_id,
        p_worker_token: token,
        p_lease_seconds: 90,
      }),
      isSubscribed: async (email) => {
        const { data, error } = await supabase
          .from('email_subscriptions')
          .select('email')
          .eq('email', email)
          .eq('subscribed', true)
          .maybeSingle()
        if (error) throw error
        return Boolean(data)
      },
      buildPayload: async (recipient: ClaimedRecipient, claim) => {
        const token = await signUnsubscribeToken(recipient.email)
        const unsubscribeUrl =
          `${supabaseUrl}/functions/v1/unsubscribe-announcements?email=${encodeURIComponent(recipient.email)}&token=${token}`
        const subject = String(claim.subject ?? '')
        const content = String(claim.content ?? '')
        return {
          from: String(claim.from_email ?? configuredFromEmail),
          to: recipient.email,
          subject,
          html: buildAnnouncementEmailHtml(
            escapeHtml(subject),
            escapeHtml(content).replace(/\n/g, '<br>'),
            unsubscribeUrl,
            typeof claim.cta_label === 'string' && typeof claim.cta_url === 'string'
              ? { label: claim.cta_label, url: claim.cta_url }
              : null,
          ),
          headers: {
            'List-Unsubscribe': `<${unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        }
      },
      preparePayload: (recipient, token, payload) => rpc('prepare_announcement_email_payload', {
        p_announcement_id: announcement_id,
        p_worker_token: token,
        p_recipient_id: recipient.id,
        p_recipient_token: recipient.recipient_token,
        p_payload: payload,
      }),
      send: async (payload, idempotencyKey) => {
        const response = await providerFetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(payload),
        })
        let body: Record<string, unknown> | null = null
        try { body = await response.json() } catch { /* response status is sufficient */ }
        return { status: response.status, body }
      },
      record: (recipient, token, outcome, details = {}) => rpc('record_announcement_email_outcome', {
        p_announcement_id: announcement_id,
        p_worker_token: token,
        p_recipient_id: recipient.id,
        p_recipient_token: recipient.recipient_token,
        p_outcome: outcome,
        p_provider_message_id: details.providerMessageId ?? null,
        p_error: details.error ?? null,
        p_retry_after_seconds: 60,
      }).then(() => undefined),
      finish: (token) => rpc('finish_announcement_email_broadcast', {
        p_announcement_id: announcement_id,
        p_worker_token: token,
      }),
    }

    const result = await runAnnouncementBroadcast(adapter, workerToken, 25)
    const complete = result.state === 'completed'
    return json({ success: complete, ...result }, complete || result.state === 'busy' ? 200 : 207)
  } catch (err) {
    console.error('[broadcast-announcement] failed:', err)
    return json({ error: 'Broadcast failed. It remains retryable.', detail: err instanceof Error ? err.message : String(err) }, 500)
  }
})
