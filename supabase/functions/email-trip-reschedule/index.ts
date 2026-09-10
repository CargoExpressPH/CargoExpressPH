// Supabase Edge Function: email-trip-reschedule
//
// Emails every customer with an active (non-cancelled) booking on a trip
// whose departure_date or arrival_date just changed, PROVIDED they opted in
// (profiles.wants_announcements = true). Triggered exclusively by the
// trips_notify_reschedule_email trigger (see the
// 20260910020000_trip_reschedule_email_trigger.sql migration) the instant a
// trip's schedule is updated — never called from the app itself.
//
// Same auth shape as process-daily-reminders: caller must present the
// project's service role key as the bearer token. This mass-emails
// everyone booked on a trip, which no single logged-in session should be
// able to trigger on demand by just calling the URL.
//
// Required Supabase secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY        — https://resend.com/api-keys
//   RESEND_FROM_EMAIL     — must be on a domain verified in Resend, e.g.
//                           "CargoExpress PH <updates@yourdomain.com>"

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

const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// departure_date/arrival_date are TIMESTAMPTZ stamped at PH midnight
// (20260829160000_trip_date_only_scheduling.sql) — render as a PH calendar
// date, not whatever the server's local timezone happens to be.
function formatPhDate(iso: string | null): string {
  if (!iso) return 'TBA'
  return new Date(iso).toLocaleDateString('en-PH', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Manila',
  })
}

interface ReschedulePayload {
  trip_id: string
  old_departure_date: string | null
  old_arrival_date: string | null
  new_departure_date: string | null
  new_arrival_date: string | null
}

function buildRescheduleEmailHtml(opts: {
  customerName: string
  trackingNumbers: string[]
  origin: string
  destination: string
  oldDeparture: string
  oldArrival: string
  newDeparture: string
  newArrival: string
}): string {
  const safeName = escapeHtml(opts.customerName)
  const orderList = opts.trackingNumbers.map((tn) => escapeHtml(tn)).join(', ')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trip Schedule Update</title>
<style>
  body,table,td,a{ -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table,td{ mso-table-lspace:0pt; mso-table-rspace:0pt; }
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

          <tr>
            <td align="center" style="padding:40px 32px 24px; border-bottom:1px solid #e2e8f0; background-color:#ffffff;">
              <h1 style="margin:0; font-family:${FONT_STACK}; font-size:36px; font-weight:800; letter-spacing:-1px;">
                <span style="color:#10b981;">CARGO</span><span style="color:#0f172a;">EXPRESS</span>
              </h1>
              <p style="margin:8px 0 0; font-family:${FONT_STACK}; font-size:14px; color:#64748b; font-weight:500;">
                Manila ⇄ Bohol Cargo Delivery
              </p>
            </td>
          </tr>

          <tr>
            <td class="ce-padding" style="padding:36px 32px 4px;">
              <h1 style="margin:0 0 16px;font-family:${FONT_STACK};font-size:22px;font-weight:800;color:#1B2320;line-height:1.3;">Trip Schedule Update</h1>
              <p style="margin:0 0 16px;font-family:${FONT_STACK};font-size:15px;line-height:1.7;color:#333333;">
                Hi ${safeName}, the trip carrying your booking(s) <strong>${orderList}</strong>
                (${escapeHtml(opts.origin)} → ${escapeHtml(opts.destination)}) has a new schedule.
              </p>
            </td>
          </tr>

          <tr>
            <td class="ce-padding" style="padding:8px 32px 8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E8E3;border-radius:8px;overflow:hidden;">
                <tr>
                  <td style="padding:14px 18px;background:#F8FAF8;font-family:${FONT_STACK};font-size:13px;color:#57635D;width:50%;">Previous Departure</td>
                  <td style="padding:14px 18px;font-family:${FONT_STACK};font-size:13px;color:#1B2320;text-align:right;text-decoration:line-through;">${escapeHtml(opts.oldDeparture)}</td>
                </tr>
                <tr>
                  <td style="padding:14px 18px;background:#F8FAF8;font-family:${FONT_STACK};font-size:13px;font-weight:700;color:#16A34A;">New Departure</td>
                  <td style="padding:14px 18px;font-family:${FONT_STACK};font-size:13px;font-weight:700;color:#16A34A;text-align:right;">${escapeHtml(opts.newDeparture)}</td>
                </tr>
                <tr>
                  <td style="padding:14px 18px;background:#F8FAF8;font-family:${FONT_STACK};font-size:13px;color:#57635D;border-top:1px solid #E5E8E3;">Previous Estimated Arrival</td>
                  <td style="padding:14px 18px;font-family:${FONT_STACK};font-size:13px;color:#1B2320;text-align:right;text-decoration:line-through;border-top:1px solid #E5E8E3;">${escapeHtml(opts.oldArrival)}</td>
                </tr>
                <tr>
                  <td style="padding:14px 18px;background:#F8FAF8;font-family:${FONT_STACK};font-size:13px;font-weight:700;color:#16A34A;">New Estimated Arrival</td>
                  <td style="padding:14px 18px;font-family:${FONT_STACK};font-size:13px;font-weight:700;color:#16A34A;text-align:right;">${escapeHtml(opts.newArrival)}</td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td class="ce-padding" align="center" style="padding:28px 32px 8px;">
              <p style="margin:0 0 20px;font-family:${FONT_STACK};font-size:14px;line-height:1.7;color:#57635D;">
                You can track your booking's live status anytime from your account.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0" align="center">
                <tr>
                  <td style="border-radius:8px;background:#16A34A;">
                    <a href="https://cargoexpress-ph.online" target="_blank" rel="noopener"
                       style="display:inline-block;padding:14px 36px;font-family:${FONT_STACK};font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:8px;">
                      Track My Booking
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td class="ce-padding" style="padding:20px 32px 28px;background:#F8FAF8;border-top:1px solid #E5E8E3;">
              <p style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:1.6;color:#8A968F;">
                You're receiving this because you have an active booking on this trip and opted in to CargoExpress PH updates.
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
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const resendApiKey = Deno.env.get('RESEND_API_KEY') ?? ''
  const fromEmail = Deno.env.get('RESEND_FROM_EMAIL') ?? ''

  try {
    // ── Only the DB trigger, authenticated with the service role key, may
    // call this. Same reasoning as process-daily-reminders: this mass-emails
    // everyone booked on a trip, so it can't be "any signed-in user". ──
    const authHeader = req.headers.get('Authorization') || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!serviceRoleKey || token !== serviceRoleKey) {
      return json({ error: 'Forbidden' }, 403)
    }

    if (!resendApiKey || !fromEmail) {
      return json({ error: 'Email sending is not configured (RESEND_API_KEY / RESEND_FROM_EMAIL).' }, 500)
    }

    const payload = (await req.json()) as Partial<ReschedulePayload>
    if (typeof payload.trip_id !== 'string' || !payload.trip_id) {
      return json({ error: 'trip_id is required' }, 400)
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey)

    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .select('id, trip_number, origin, destination, status')
      .eq('id', payload.trip_id)
      .maybeSingle()
    if (tripError) return json({ error: tripError.message }, 500)
    if (!trip) return json({ error: 'Trip not found' }, 404)

    // ── Active (non-cancelled) bookings on this trip, grouped by customer ──
    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('id, tracking_number, user_id')
      .eq('trip_id', payload.trip_id)
      .neq('status', 'Cancelled')
      .not('user_id', 'is', null)
    if (ordersError) return json({ error: ordersError.message }, 500)
    if (!orders || orders.length === 0) {
      return json({ success: true, sent: 0, failed: 0, note: 'No active bookings on this trip.' })
    }

    const trackingByUser = new Map<string, string[]>()
    for (const o of orders) {
      const list = trackingByUser.get(o.user_id as string) || []
      list.push(o.tracking_number)
      trackingByUser.set(o.user_id as string, list)
    }

    // ── Only customers who opted in to announcement/update emails ──
    const userIds = Array.from(trackingByUser.keys())
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, name, email, role, wants_announcements')
      .in('id', userIds)
      .eq('role', 'customer')
      .eq('wants_announcements', true)
      .not('email', 'is', null)
    if (profilesError) return json({ error: profilesError.message }, 500)

    if (!profiles || profiles.length === 0) {
      return json({ success: true, sent: 0, failed: 0, note: 'No opted-in customers on this trip.' })
    }

    const oldDeparture = formatPhDate(payload.old_departure_date ?? null)
    const oldArrival = formatPhDate(payload.old_arrival_date ?? null)
    const newDeparture = formatPhDate(payload.new_departure_date ?? null)
    const newArrival = formatPhDate(payload.new_arrival_date ?? null)

    let sent = 0
    let failed = 0

    for (const batch of chunk(profiles, BATCH_SIZE)) {
      const emails = batch.map((profile) => ({
        from: fromEmail,
        to: profile.email as string,
        subject: `Schedule Update — Trip ${trip.trip_number}`,
        html: buildRescheduleEmailHtml({
          customerName: profile.name || 'Customer',
          trackingNumbers: trackingByUser.get(profile.id as string) || [],
          origin: trip.origin,
          destination: trip.destination,
          oldDeparture,
          oldArrival,
          newDeparture,
          newArrival,
        }),
      }))

      try {
        const res = await fetch('https://api.resend.com/emails/batch', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(emails),
        })
        if (res.ok) {
          sent += batch.length
          console.log(`[email-trip-reschedule] Resend batch sent: ${batch.length} recipient(s)`)
        } else {
          failed += batch.length
          console.error('[email-trip-reschedule] Resend batch failed:', res.status, await res.text())
        }
      } catch (err) {
        failed += batch.length
        console.error('[email-trip-reschedule] Resend batch threw:', err)
      }

      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS))
    }

    return json({ success: true, sent, failed, total_opted_in: profiles.length, total_bookings: orders.length })
  } catch (err) {
    console.error('[email-trip-reschedule] failed:', err)
    return json({ error: 'Trip reschedule email failed.' }, 500)
  }
})
