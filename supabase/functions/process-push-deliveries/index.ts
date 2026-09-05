// Durable push outbox worker. Invoked by pg_cron through pg_net with the
// project service-role JWT; never callable by a browser user token.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const REQUEST_TIMEOUT_MS = 20_000
const MAX_BATCH_SIZE = 100
const CONCURRENCY = 5

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const fetchWithTimeout = (url: string, init: RequestInit) => fetch(url, {
  ...init,
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  redirect: 'error',
})

serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const authHeader = req.headers.get('Authorization') ?? ''

  if (!supabaseUrl || !serviceRoleKey || authHeader !== `Bearer ${serviceRoleKey}`) {
    return json({ error: 'Service authentication required' }, 401)
  }

  try {
    const input = await req.json().catch(() => ({}))
    const requestedLimit = Number(input?.limit ?? 25)
    const limit = Math.min(
      MAX_BATCH_SIZE,
      Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 25),
    )

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: jobs, error: claimError } = await supabase.rpc(
      'claim_notification_delivery_jobs',
      { p_limit: limit },
    )
    if (claimError) throw new Error(`Unable to claim push jobs: ${claimError.message}`)
    if (!jobs?.length) return json({ success: true, claimed: 0, sent: 0, skipped: 0, retried: 0 })

    const counts = { sent: 0, skipped: 0, retried: 0 }

    const retryClaim = async (job: Record<string, unknown>, message: string) => {
      await supabase.rpc('complete_notification_delivery_job', {
        p_job_id: job.job_id,
        p_claim_id: job.job_claim_id,
        p_outcome: 'retry',
        p_error: message,
      })
      counts.retried += 1
    }

    const processJob = async (job: Record<string, unknown>) => {
      try {
        const response = await fetchWithTimeout(`${supabaseUrl}/functions/v1/send-push`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${serviceRoleKey}`,
          },
          body: JSON.stringify({
            job_id: job.job_id,
            job_claim_id: job.job_claim_id,
            notification_id: job.notification_id,
            device_token_id: job.device_token_id,
          }),
        })

        const result = await response.json().catch(() => ({}))
        if (!response.ok) {
          await retryClaim(job, `send-push returned HTTP ${response.status}`)
          return
        }

        // send-push owns the claim and finalizes it after recording the exact
        // provider outcome. The worker counts the response but deliberately
        // does not try to complete the same claim twice.
        if (result?.success) counts.sent += 1
        else if (result?.retry_scheduled) counts.retried += 1
        else if (result?.skipped || result?.results?.every?.((item: Record<string, unknown>) => item.skipped || item.stale)) {
          counts.skipped += 1
        } else {
          await retryClaim(job, 'Provider did not accept the push')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Push worker request failed'
        await retryClaim(job, message)
      }
    }

    for (let offset = 0; offset < jobs.length; offset += CONCURRENCY) {
      await Promise.all(jobs.slice(offset, offset + CONCURRENCY).map(processJob))
    }

    return json({ success: true, claimed: jobs.length, ...counts })
  } catch (error) {
    console.error('[process-push-deliveries] failed:', error)
    return json({ error: 'Push delivery worker failed' }, 500)
  }
})
