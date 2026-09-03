// Supabase Edge Function: process-daily-reminders
//
// Emails a payment reminder for every order that still owes money past (or
// on) its promised_payment_date, once per calendar day per order. Triggered
// exclusively by the `daily_payment_reminders` pg_cron job (see the
// 20260831060000_daily_payment_reminders.sql migration) at 8:00 AM
// Philippine Time — never called from the app itself.
//
// Caller must present the project's service role key as the bearer token.
// This is deliberately NOT "any authenticated user" (the broadcast-
// announcement / send-push pattern): this endpoint mass-emails every
// overdue order's owner and mutates last_reminder_sent_at on all of them,
// neither of which any single logged-in customer or admin session should be
// able to trigger on demand by just calling the URL.
//
// Required Supabase secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY        — https://resend.com/api-keys
//   RESEND_FROM_EMAIL     — must be on a domain verified in Resend, e.g.
//                           "CargoExpress PH <billing@yourdomain.com>"
//
// The email body comes from template.html, deployed alongside this file.
// Drop your own HTML in there — the only contract is the placeholders it
// contains: {{customer_name}}, {{tracking_number}}, {{origin}},
// {{destination}}, {{remaining_balance}}, {{promised_date}}.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import { emailTemplate } from './template.ts'

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

function formatMoney(amount: number): string {
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(amount)
}

// `date` is a plain 'YYYY-MM-DD' DATE column value — parse it as a calendar
// date, not a UTC instant, so it can't roll back a day for anyone west of UTC.
function formatDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
    .toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
}

/**
 * Fill an admin-authored HTML template's {{placeholders}} with per-order
 * values. Every value is HTML-escaped before substitution — the template
 * itself is trusted (authored by the team, deployed with the function), but
 * customer names and other per-order strings are not.
 */
function renderTemplate(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (html, [key, value]) => html.replaceAll(`{{${key}}}`, escapeHtml(value)),
    template,
  )
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const resendApiKey = Deno.env.get('RESEND_API_KEY') ?? ''
  const fromEmail = Deno.env.get('RESEND_FROM_EMAIL') ?? ''

  try {
    // ── Only the cron job, authenticated with the service role key, may
    // call this. See the file header for why this can't be "any signed-in
    // user" the way most of this project's other functions work. ──
    const authHeader = req.headers.get('Authorization') || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!serviceRoleKey || token !== serviceRoleKey) {
      return json({ error: 'Forbidden' }, 403)
    }

    if (!resendApiKey || !fromEmail) {
      return json({ error: 'Email sending is not configured (RESEND_API_KEY / RESEND_FROM_EMAIL).' }, 500)
    }

    const template = emailTemplate;

    const supabase = createClient(supabaseUrl, serviceRoleKey)

    // Both cron and this function's own clock run in UTC, and the job is
    // scheduled for exactly 00:00 UTC (= 8:00 AM PHT) — so "today" in UTC is
    // also "today" in Manila at the moment this ever runs. Computed once so
    // every comparison below (and the stamp written at the end) agrees on
    // the same instant.
    const now = new Date()
    const todayIso = now.toISOString().slice(0, 10)

    // ── Every order still owing money, due today or already past due, that
    // hasn't already been reminded today. ──
    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('id, tracking_number, origin, destination, remaining_balance, promised_payment_date, user_id')
      .gt('remaining_balance', 0)
      .lte('promised_payment_date', todayIso)
      .or(`last_reminder_sent_at.is.null,last_reminder_sent_at.lt.${todayIso}`)

    if (ordersError) return json({ error: ordersError.message }, 500)
    if (!orders || orders.length === 0) {
      return json({ success: true, sent: 0, failed: 0, note: 'No overdue orders due for a reminder today.' })
    }

    // ── One query for every owner's name/email ──
    const userIds = Array.from(new Set(orders.map((o) => o.user_id).filter(Boolean)))
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, name, email')
      .in('id', userIds)
    if (profilesError) return json({ error: profilesError.message }, 500)

    const profileById = new Map((profiles || []).map((p) => [p.id, p]))

    // Only orders whose owner actually has an email on file can be emailed.
    // Everything else is reported back, not silently dropped.
    const emailable: Array<{ order: (typeof orders)[number]; email: string; name: string }> = []
    for (const order of orders) {
      const profile = profileById.get(order.user_id)
      if (profile?.email) emailable.push({ order, email: profile.email, name: profile.name || 'Customer' })
    }

    let sent = 0
    let failed = 0
    const remindedOrderIds: string[] = []

    for (const batch of chunk(emailable, BATCH_SIZE)) {
      const emails = batch.map(({ order, email, name }) => ({
        from: fromEmail,
        to: email,
        subject: `Payment Reminder — Order ${order.tracking_number}`,
        html: renderTemplate(template, {
          customer_name: name,
          tracking_number: order.tracking_number,
          origin: order.origin,
          destination: order.destination,
          remaining_balance: formatMoney(Number(order.remaining_balance)),
          promised_date: formatDate(order.promised_payment_date),
        }),
      }))

      let batchOk = false
      let batchErrorMessage: string | null = null

      try {
        const res = await fetch('https://api.resend.com/emails/batch', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(emails),
        })
        if (res.ok) {
          batchOk = true
          sent += batch.length
          remindedOrderIds.push(...batch.map((b) => b.order.id))
        } else {
          failed += batch.length
          batchErrorMessage = `Resend batch failed (HTTP ${res.status})`
          console.error('[process-daily-reminders] Resend batch failed:', res.status, await res.text())
        }
      } catch (err) {
        failed += batch.length
        batchErrorMessage = err instanceof Error ? err.message : 'Resend batch threw an error'
        console.error('[process-daily-reminders] Resend batch threw:', err)
      }

      // One row per recipient — email_usage_logs only tracks the batch's
      // summed sent/failed counts, this is what powers the admin "Recent
      // Email Activity" table. Best effort: never fail an already-sent batch.
      const activityRows = batch.map(({ order, email, name }) => ({
        source: 'daily_reminders',
        recipient_email: email,
        recipient_name: name,
        subject: `Payment Reminder — Order ${order.tracking_number}`,
        status: batchOk ? 'sent' : 'failed',
        order_id: order.id,
        error_message: batchOk ? null : batchErrorMessage,
      }))
      const { error: activityLogError } = await supabase.from('email_activity_log').insert(activityRows)
      if (activityLogError) {
        console.error('[process-daily-reminders] Failed to log email activity:', activityLogError)
      }

      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS))
    }

    // Stamp only the orders that actually went out — a failed batch must
    // stay eligible for tomorrow's run (or a manual re-invocation today),
    // not get silently marked as reminded.
    if (remindedOrderIds.length > 0) {
      const { error: updateError } = await supabase
        .from('orders')
        .update({ last_reminder_sent_at: now.toISOString() })
        .in('id', remindedOrderIds)
      if (updateError) {
        console.error('[process-daily-reminders] Failed to stamp last_reminder_sent_at:', updateError)
      }
    }

    // Record how many emails actually reached Resend, for the admin Email
    // Usage Monitoring widget (Resend Free Plan: 100/day, 3,000/month). Best
    // effort — a logging failure must never fail a reminder run that already
    // succeeded.
    if (sent > 0) {
      const { error: usageLogError } = await supabase
        .from('email_usage_logs')
        .insert({ source: 'daily_reminders', sent_count: sent, failed_count: failed })
      if (usageLogError) {
        console.error('[process-daily-reminders] Failed to log email usage:', usageLogError)
      }
    }

    return json({
      success: true,
      sent,
      failed,
      total_overdue: orders.length,
      skipped_no_email: orders.length - emailable.length,
    })
  } catch (err) {
    console.error('[process-daily-reminders] failed:', err)
    return json({ error: 'Reminder processing failed.' }, 500)
  }
})
