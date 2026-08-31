import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

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

const firestoreString = (doc: any, key: string) => doc?.fields?.[key]?.stringValue || ''

const descriptorPath = (value: unknown): string => {
  if (!value) return ''
  if (typeof value === 'object' && !Array.isArray(value)) {
    return typeof (value as Record<string, unknown>).firestore_path === 'string'
      ? (value as Record<string, string>).firestore_path
      : ''
  }
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.startsWith('photoFallbacks/')) return trimmed
  if (!trimmed.startsWith('{')) return ''
  try {
    return descriptorPath(JSON.parse(trimmed))
  } catch {
    return ''
  }
}

const firstPhoto = (photos: unknown) => Array.isArray(photos) && photos.length > 0 ? photos[0] : null

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { firestore_path } = await req.json()
    if (typeof firestore_path !== 'string' || !/^photoFallbacks\/[a-zA-Z0-9._-]+$/.test(firestore_path)) {
      return json({ error: 'Invalid Firestore photo path' }, 400)
    }

    const [, docId] = firestore_path.split('/')
    const orderId = docId.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})[_-]/i)?.[1]
    if (!orderId) return json({ error: 'Invalid Firestore photo path' }, 400)

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const serviceClient = createClient(supabaseUrl, serviceRoleKey)

    const authHeader = req.headers.get('Authorization') || ''
    let user: { id: string } | null = null
    if (authHeader.startsWith('Bearer ')) {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      })
      const { data } = await userClient.auth.getUser()
      user = data.user
    }

    const { data: order } = await serviceClient
      .from('orders')
      .select('user_id, featured_on_website, featured_image_type, pickup_photos, delivery_photos')
      .eq('id', orderId)
      .single()
    if (!order) return json({ error: 'Order not found' }, 404)

    const selectedPhoto = order.featured_image_type === 'delivery' && firstPhoto(order.delivery_photos)
      ? firstPhoto(order.delivery_photos)
      : firstPhoto(order.pickup_photos)
    const isExactPublicFeature = order.featured_on_website === true
      && descriptorPath(selectedPhoto) === firestore_path

    let isAdmin = false
    if (user) {
      const { data: profile } = await serviceClient
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single()
      isAdmin = profile?.role === 'admin'
    }

    const isOwner = Boolean(user && order.user_id === user.id)
    if (!user && !isExactPublicFeature) return json({ error: 'Authentication required' }, 401)
    if (user && !isAdmin && !isOwner && !isExactPublicFeature) return json({ error: 'Access denied' }, 403)

    const serviceAccount = loadFirebaseServiceAccount()
    const accessToken = await getAccessToken(serviceAccount)
    const projectId = serviceAccount.project_id
    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/photoFallbacks/${docId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    const doc = await response.json()
    if (!response.ok) {
      return json({ error: doc.error?.message || 'Fallback photo not found' }, response.status)
    }
    if (firestoreString(doc, 'order_id') !== orderId) {
      return json({ error: 'Fallback photo ownership mismatch' }, 403)
    }

    return json({
      data_url: firestoreString(doc, 'data_url'),
      content_type: firestoreString(doc, 'content_type') || 'image/jpeg',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected fallback read error'
    return json({ error: message }, 500)
  }
})
