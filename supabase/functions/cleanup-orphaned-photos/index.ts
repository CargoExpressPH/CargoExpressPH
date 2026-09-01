// Supabase Edge Function: cleanup-orphaned-photos
//
// "Scan and Clean Orphaned Photos" — admin-triggered. Deletes shipment
// evidence objects under cargo-photos/{pickup-proofs,delivery-proofs,receipts}
// whose tracking-number folder no longer matches any row in public.orders
// (e.g. a cancelled booking that was deleted outright, or leftover test data).
//
// The set of paths to delete is never taken from the request body — it is
// computed exclusively by the admin-gated public.list_orphaned_evidence_photos()
// SQL function (see 20260901020000_photo_storage_cleanup_archiving_and_alerts.sql),
// called with the CALLER's own JWT so its internal is_admin() check is real.
// This function only turns that list into actual Storage API deletes and
// records what happened — it cannot be aimed at arbitrary paths.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const BUCKET = 'cargo-photos'
const REMOVE_BATCH_SIZE = 100

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
})

const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const requireAdmin = async (authHeader: string) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const serviceClient = createClient(supabaseUrl, serviceRoleKey)

  const { data, error } = await userClient.auth.getUser()
  if (error || !data.user) throw new Response('Authentication required', { status: 401 })

  const { data: profile } = await serviceClient
    .from('profiles').select('role').eq('id', data.user.id).single()
  if (profile?.role !== 'admin') throw new Response('Admin access required', { status: 403 })

  return { user: data.user, userClient, serviceClient }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)
    const { user, userClient, serviceClient } = await requireAdmin(authHeader)

    // The caller's own JWT — list_orphaned_evidence_photos() re-checks
    // is_admin() itself, so this is not "trust the client is an admin twice",
    // it is the SQL function's own authorization running for real.
    const { data: orphans, error: listError } = await userClient.rpc('list_orphaned_evidence_photos')
    if (listError) return json({ error: listError.message || 'Could not scan for orphaned photos' }, 500)

    const rows = (orphans || []) as Array<{ name: string; folder: string; tracking_number: string; size_bytes: number | null }>
    if (rows.length === 0) {
      return json({ deleted_count: 0, failed_count: 0, freed_bytes: 0, folders: [] })
    }

    // Batched by path rather than correlated against the response body: the
    // Storage API's remove() echoes back the objects it deleted, but whether
    // the `name` it reports is the full path or just relative to the request
    // is not reliably documented across client versions. A batch with no
    // error is trusted as fully removed instead — every path in it was
    // confirmed to exist in storage.objects moments earlier by the SQL scan,
    // so "the call succeeded" is already strong evidence the batch is gone.
    const rowsByPath = new Map(rows.map((row) => [row.name, row]))
    let deletedCount = 0
    let freedBytes = 0
    const failedPaths: string[] = []

    for (const batch of chunk(rows.map((row) => row.name), REMOVE_BATCH_SIZE)) {
      const { error: removeError } = await userClient.storage.from(BUCKET).remove(batch)
      if (removeError) {
        failedPaths.push(...batch)
        continue
      }
      deletedCount += batch.length
      for (const path of batch) freedBytes += Number(rowsByPath.get(path)?.size_bytes || 0)
    }

    const foldersTouched = Array.from(new Set(rows
      .filter((row) => !failedPaths.includes(row.name))
      .map((row) => `${row.folder}/${row.tracking_number}`)))

    await serviceClient.from('photo_storage_events').insert({
      event_type: 'cleanup',
      provider: 'system',
      outcome: failedPaths.length > 0 && deletedCount === 0 ? 'failure' : 'success',
      message: `Orphaned photo cleanup removed ${deletedCount} file(s)${failedPaths.length > 0 ? `, ${failedPaths.length} could not be removed` : ''}.`,
      metadata: {
        cleanup_kind: 'orphan_scan',
        deleted_count: deletedCount,
        failed_count: failedPaths.length,
        freed_bytes: freedBytes,
        folders: foldersTouched.slice(0, 50),
      },
      created_by: user.id,
    })

    return json({
      deleted_count: deletedCount,
      failed_count: failedPaths.length,
      freed_bytes: freedBytes,
      folders: foldersTouched,
    })
  } catch (error) {
    if (error instanceof Response) return json({ error: await error.text() }, error.status)
    return json({ error: 'Orphaned photo cleanup failed' }, 500)
  }
})
