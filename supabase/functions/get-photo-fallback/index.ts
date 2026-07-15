import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const serviceClient = createClient(supabaseUrl, serviceRoleKey)

    const { data: userData, error: userError } = await userClient.auth.getUser()
    if (userError || !userData.user) return json({ error: 'Authentication required' }, 401)

    const { firestore_path } = await req.json()
    if (typeof firestore_path !== 'string' || !/^photoFallbacks\/[a-zA-Z0-9_-]+$/.test(firestore_path)) {
      return json({ error: 'Invalid Firestore photo path' }, 400)
    }

    const serviceAccount = loadFirebaseServiceAccount()
    const accessToken = await getAccessToken(serviceAccount)
    const projectId = serviceAccount.project_id
    const [, docId] = firestore_path.split('/')

    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/photoFallbacks/${docId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    const doc = await response.json()
    if (!response.ok) {
      return json({ error: doc.error?.message || 'Fallback photo not found' }, response.status)
    }

    const orderId = firestoreString(doc, 'order_id')
    const { data: profile } = await serviceClient
      .from('profiles')
      .select('role')
      .eq('id', userData.user.id)
      .single()

    const { data: order } = await serviceClient
      .from('orders')
      .select('user_id')
      .eq('id', orderId)
      .single()

    const isAdmin = profile?.role === 'admin'
    const isOwner = order?.user_id === userData.user.id
    if (!isAdmin && !isOwner) return json({ error: 'Access denied' }, 403)

    return json({
      data_url: firestoreString(doc, 'data_url'),
      content_type: firestoreString(doc, 'content_type') || 'image/jpeg',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected fallback read error'
    return json({ error: message }, 500)
  }
})
