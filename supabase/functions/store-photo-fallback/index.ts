import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const MAX_DATA_URL_BYTES = 700 * 1024
const PROVIDER_TIMEOUT_MS = 15_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const JPEG_DATA_URL_PREFIX = 'data:image/jpeg;base64,'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })

const encodeBase64Url = (obj: unknown) =>
  btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function getAccessToken(serviceAccount: Record<string, string>) {
  const now = Math.floor(Date.now() / 1000)
  const unsignedToken = `${encodeBase64Url({ alg: 'RS256', typ: 'JWT' })}.${encodeBase64Url({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`

  const pemContents = serviceAccount.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '')
  const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0))
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsignedToken),
  )
  const signedToken = `${unsignedToken}.${btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedToken}`,
    redirect: 'error',
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  })
  const tokenData = await tokenResponse.json()
  if (!tokenResponse.ok || !tokenData.access_token) {
    throw new Error(tokenData.error_description || 'Failed to authenticate with Firebase')
  }
  return tokenData.access_token
}

const loadFirebaseServiceAccount = () => {
  const b64 = Deno.env.get('FIREBASE_SERVICE_ACCOUNT_B64')
  const raw = b64 ? atob(b64) : Deno.env.get('FIREBASE_SERVICE_ACCOUNT')
  if (!raw) throw new Error('Firebase service account secret is not configured')
  return JSON.parse(raw)
}

const requireAdmin = async (authHeader: string) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const serviceClient = createClient(supabaseUrl, serviceRoleKey)

  const { data: userData, error: userError } = await userClient.auth.getUser()
  if (userError || !userData.user) throw new Response('Authentication required', { status: 401 })

  const { data: profile, error: profileError } = await serviceClient
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .single()

  if (profileError || profile?.role !== 'admin') {
    throw new Response('Admin access required', { status: 403 })
  }

  return { user: userData.user, serviceClient }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)

    const { user, serviceClient } = await requireAdmin(authHeader)
    const { order_id, folder, file_name, content_type, size_bytes, data_url } = await req.json()

    if (typeof order_id !== 'string' || !UUID_RE.test(order_id)) return json({ error: 'A valid order_id is required' }, 400)
    if (!['pickup', 'delivery', 'receipt'].includes(folder)) return json({ error: 'Invalid photo folder' }, 400)
    if (typeof file_name !== 'string' || file_name.length < 1 || file_name.length > 255) {
      return json({ error: 'A valid file_name is required' }, 400)
    }
    if (content_type !== 'image/jpeg') return json({ error: 'Only JPEG fallback photos are accepted' }, 400)
    if (!Number.isSafeInteger(size_bytes) || size_bytes <= 0 || size_bytes > MAX_DATA_URL_BYTES) {
      return json({ error: 'Invalid fallback photo size' }, 400)
    }
    if (typeof data_url !== 'string' || !data_url.startsWith(JPEG_DATA_URL_PREFIX)) {
      return json({ error: 'JPEG data_url is required' }, 400)
    }
    if (new TextEncoder().encode(data_url).length > MAX_DATA_URL_BYTES) {
      return json({ error: 'Fallback photo is too large for Firestore' }, 413)
    }
    const encodedPhoto = data_url.slice(JPEG_DATA_URL_PREFIX.length)
    if (!encodedPhoto || encodedPhoto.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encodedPhoto)) {
      return json({ error: 'JPEG data_url is malformed' }, 400)
    }
    let decodedPhoto: string
    try {
      decodedPhoto = atob(encodedPhoto)
    } catch {
      return json({ error: 'JPEG data_url is malformed' }, 400)
    }
    if (
      decodedPhoto.length !== size_bytes
      || decodedPhoto.length < 3
      || decodedPhoto.charCodeAt(0) !== 0xff
      || decodedPhoto.charCodeAt(1) !== 0xd8
      || decodedPhoto.charCodeAt(2) !== 0xff
    ) {
      return json({ error: 'Fallback photo content does not match a JPEG file' }, 400)
    }

    const { data: order, error: orderError } = await serviceClient
      .from('orders')
      .select('id')
      .eq('id', order_id)
      .single()
    if (orderError || !order) return json({ error: 'Order not found' }, 404)

    const serviceAccount = loadFirebaseServiceAccount()
    const accessToken = await getAccessToken(serviceAccount)
    const projectId = serviceAccount.project_id
    const createdAt = new Date().toISOString()
    const safeFileName = String(file_name || 'photo.jpg')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 120)
    // A retry of the same order/folder/file overwrites the same document instead
    // of leaking another unreachable fallback document.
    const docId = `${order_id}_${folder}_${safeFileName || 'photo'}`

    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/photoFallbacks/${docId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fields: {
            order_id: { stringValue: order_id },
            folder: { stringValue: folder },
            file_name: { stringValue: file_name },
            content_type: { stringValue: content_type },
            size_bytes: { integerValue: String(size_bytes) },
            data_url: { stringValue: data_url },
            created_by: { stringValue: user.id },
            created_at: { timestampValue: createdAt },
          },
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      },
    )

    if (!response.ok) {
      console.error('store-photo-fallback provider request failed with status:', response.status)
      return json({ error: 'Could not store the fallback photo right now.' }, 502)
    }

    return json({
      firestore_path: `photoFallbacks/${docId}`,
      created_at: createdAt,
    })
  } catch (err) {
    if (err instanceof Response) {
      return json({ error: await err.text() }, err.status)
    }
    console.error('store-photo-fallback failed')
    return json({ error: 'Could not store the fallback photo right now.' }, 500)
  }
})
