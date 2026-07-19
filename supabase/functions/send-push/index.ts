// Supabase Edge Function: send-push
// Sends push notifications via:
//   • Firebase Cloud Messaging v1 API  → Android / Chrome / Desktop
//   • Web Push Protocol (RFC 8030/8291/8292) → iOS 16.4+ PWA
//
// Environment secrets required:
//   FIREBASE_SERVICE_ACCOUNT_B64  - base64-encoded Firebase service account JSON
//   VAPID_PUBLIC_KEY              - P-256 public key (65 bytes, uncompressed, base64url)
//   VAPID_PRIVATE_KEY             - P-256 private key (32 bytes, base64url)
//   VAPID_SUBJECT                 - mailto: or https: URI for VAPID identification
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const DEFAULT_NOTIFICATION_PATH = '/customer/notifications'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

function getHttpsUrl(value?: string): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FCM v1 helpers (Android / Chrome)
// ─────────────────────────────────────────────────────────────────────────────

async function getFcmAccessToken(serviceAccount: Record<string, string>): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header  = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iss:   serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  }

  const encodeB64 = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  const unsignedToken = `${encodeB64(header)}.${encodeB64(payload)}`

  const pemContents = serviceAccount.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '')

  const binaryKey = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0))
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', binaryKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  )
  const signature   = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsignedToken))
  const signedToken = `${unsignedToken}.${btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedToken}`,
  })
  const tokenData = await tokenResp.json()
  return tokenData.access_token
}

async function sendFcm(
  fcmToken: string,
  projectId: string,
  accessToken: string,
  title: string,
  body: string,
  clickUrl: string,
  webpushLink: string | null,
): Promise<{ ok: boolean; messageId?: string; error?: string; stale?: boolean }> {
  const resp = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token:        fcmToken,
          notification: { title, body },
          data:         { url: clickUrl },
          ...(webpushLink ? { webpush: { fcm_options: { link: webpushLink } } } : {}),
        },
      }),
    },
  )
  const result = await resp.json()
  const err    = result?.error
  if (err) {
    const code  = err.details?.[0]?.errorCode || ''
    const stale = code === 'UNREGISTERED' || err.status === 'NOT_FOUND' || code === 'INVALID_ARGUMENT'
    return { ok: false, error: err.message, stale }
  }
  return { ok: true, messageId: result?.name }
}

// ─────────────────────────────────────────────────────────────────────────────
// Web Push helpers (iOS 16.4+ PWA) — RFC 8030 / RFC 8291 / RFC 8292
// ─────────────────────────────────────────────────────────────────────────────

function b64uToBytes(b64: string): Uint8Array {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4)
  return Uint8Array.from(atob((b64 + padding).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
}

function bytesToB64u(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Build VAPID JWT signed with ES256 (ECDSA P-256 + SHA-256).
 * vapidPublicKeyB64  — uncompressed P-256 point (65 bytes, base64url)
 * vapidPrivateKeyB64 — raw P-256 scalar (32 bytes, base64url)
 */
async function buildVapidJwt(
  audience: string,
  subject: string,
  vapidPublicKeyB64: string,
  vapidPrivateKeyB64: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const hdr = bytesToB64u(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const pay = bytesToB64u(new TextEncoder().encode(JSON.stringify({ aud: audience, exp: now + 43200, sub: subject })))
  const sigInput = `${hdr}.${pay}`

  // Import private key as JWK (the only format WebCrypto accepts for raw EC scalars)
  const pubBytes = b64uToBytes(vapidPublicKeyB64)  // 0x04 || x(32) || y(32)
  const jwk: JsonWebKey = {
    kty: 'EC', crv: 'P-256',
    d:   vapidPrivateKeyB64,
    x:   bytesToB64u(pubBytes.slice(1, 33)),
    y:   bytesToB64u(pubBytes.slice(33, 65)),
    key_ops: ['sign'], ext: true,
  }
  const sigKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const sig    = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, sigKey, new TextEncoder().encode(sigInput))
  return `${sigInput}.${bytesToB64u(new Uint8Array(sig))}`
}

/**
 * Encrypt payload per RFC 8291 (aesgcm → aes128gcm) and POST to the push endpoint.
 */
async function sendWebPush(
  subscriptionJson: Record<string, string | Record<string, string>>,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidSubject: string,
  title: string,
  body: string,
  clickUrl: string,
): Promise<{ ok: boolean; messageId?: string; error?: string; stale?: boolean }> {
  try {
    const endpoint = subscriptionJson.endpoint as string
    const p256dh   = (subscriptionJson.keys as Record<string, string>).p256dh
    const auth     = (subscriptionJson.keys as Record<string, string>).auth
    if (!endpoint || !p256dh || !auth) return { ok: false, error: 'Subscription missing endpoint or keys' }

    // ── VAPID JWT ─────────────────────────────────────────────────────────
    const audience = new URL(endpoint).origin
    const jwt = await buildVapidJwt(audience, vapidSubject, vapidPublicKey, vapidPrivateKey)

    // ── Plaintext payload ─────────────────────────────────────────────────
    const payloadBytes = new TextEncoder().encode(JSON.stringify({
      title, body,
      icon:  '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
      data:  { url: clickUrl },
    }))

    // ── RFC 8291: ECDH + HKDF-SHA-256 + AES-128-GCM ──────────────────────
    const salt       = crypto.getRandomValues(new Uint8Array(16))
    const authBytes  = b64uToBytes(auth)

    // Sender ephemeral ECDH key pair
    const senderKP     = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const senderPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', senderKP.publicKey)) // 65 bytes

    // Import receiver public key
    const receiverPub = await crypto.subtle.importKey(
      'raw', b64uToBytes(p256dh), { name: 'ECDH', namedCurve: 'P-256' }, false, [],
    )

    // ECDH shared secret (256 bits)
    const sharedBits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'ECDH', public: receiverPub }, senderKP.privateKey, 256,
    ))

    // RFC 8291 §3.3 — PRK via HKDF-Extract(salt=auth, IKM=sharedBits, info=keyInfo)
    const receiverPubRaw = b64uToBytes(p256dh)
    const keyInfo = new Uint8Array([
      ...new TextEncoder().encode('WebPush: info\x00'),
      ...receiverPubRaw,
      ...senderPubRaw,
    ])
    const ikmKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits'])
    const prk    = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: authBytes, info: keyInfo }, ikmKey, 256,
    ))

    // CEK (128-bit) and Nonce (96-bit) via HKDF-Expand(PRK, salt, info)
    const prkKey = await crypto.subtle.importKey('raw', prk, 'HKDF', false, ['deriveBits'])
    const cek    = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('Content-Encoding: aes128gcm\x00') }, prkKey, 128,
    ))
    const nonce  = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('Content-Encoding: nonce\x00') }, prkKey, 96,
    ))

    // AES-128-GCM encrypt (payload + padding delimiter byte 0x02)
    const aesKey     = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce }, aesKey, new Uint8Array([...payloadBytes, 2]),
    ))

    // RFC 8188 content-coding header: salt(16) + rs(4, big-endian=4096) + keyid_len(1) + senderPub(65) + ciphertext
    const rs      = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096)
    const content = new Uint8Array(16 + 4 + 1 + senderPubRaw.length + ciphertext.length)
    let o = 0
    content.set(salt,         o); o += 16
    content.set(rs,           o); o += 4
    content[o++] = senderPubRaw.length
    content.set(senderPubRaw, o); o += senderPubRaw.length
    content.set(ciphertext,   o)

    // ── POST to push service ──────────────────────────────────────────────
    const pushResp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization':    `vapid t=${jwt}, k=${vapidPublicKey}`,
        'Content-Type':     'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'TTL':              '86400',
        'Urgency':          'normal',
      },
      body: content,
    })

    if (pushResp.status === 201 || pushResp.status === 200) return { ok: true, messageId: `webpush-${Date.now()}` }
    if (pushResp.status === 410 || pushResp.status === 404) return { ok: false, stale: true, error: `Subscription expired (${pushResp.status})` }
    return { ok: false, error: `Push service error ${pushResp.status}: ${await pushResp.text().catch(() => '')}` }
  } catch (e) {
    return { ok: false, error: `Web Push error: ${e.message}` }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main request handler
// ─────────────────────────────────────────────────────────────────────────────

serve(async (req) => {
  try {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

    const { notification_id, user_id, title, body, url } = await req.json()
    const clickUrl    = url || DEFAULT_NOTIFICATION_PATH
    const webpushLink = getHttpsUrl(clickUrl)

    if (!user_id || !title) return jsonResp({ error: 'user_id and title required' }, 400)

    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return jsonResp({ error: 'Authentication required' }, 401)

    const supabaseUrl    = Deno.env.get('SUPABASE_URL')              ?? ''
    const anonKey        = Deno.env.get('SUPABASE_ANON_KEY')         ?? ''
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    // Verify caller's JWT
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
    const { data: userData, error: userError } = await userClient.auth.getUser()
    if (userError || !userData.user) return jsonResp({ error: 'Authentication required' }, 401)

    const supabase = createClient(supabaseUrl, serviceRoleKey)

    // Authorization: must be admin, sending to self, or sending to an admin
    const [{ data: requester, error: reqErr }, { data: targetUser }] = await Promise.all([
      supabase.from('profiles').select('role').eq('id', userData.user.id).single(),
      user_id === 'all_customers'
        ? Promise.resolve({ data: null, error: null })
        : supabase.from('profiles').select('role').eq('id', user_id).single(),
    ])
    const isTargetAdmin = targetUser?.role === 'admin'
    if (reqErr || (requester?.role !== 'admin' && userData.user.id !== user_id && !isTargetAdmin)) {
      return jsonResp({ error: 'Access denied' }, 403)
    }

    // Fetch device tokens for the target user(s)
    let devices: { id: string; token: string; user_id: string }[] = []
    let devErr = null

    if (user_id === 'all_customers') {
      const { data, error } = await supabase
        .from('user_device_tokens')
        .select('id, token, user_id, profiles!inner(role)')
        .eq('profiles.role', 'customer')
      devices = data as any || []
      devErr = error
    } else {
      const { data, error } = await supabase
        .from('user_device_tokens')
        .select('id, token, user_id')
        .eq('user_id', user_id)
      devices = data || []
      devErr = error
    }

    if (devErr || !devices || devices.length === 0) {
      if (user_id !== 'all_customers') {
        await supabase.from('notification_delivery_attempts').insert({
          notification_id: notification_id || null,
          user_id, status: 'skipped',
          error_message: devErr?.message || 'No device tokens for user',
        })
      }
      return jsonResp({ error: 'No device tokens for user', skipped: true })
    }

    // Load FCM service account (for Android / Chrome tokens)
    const serviceAccountB64 = Deno.env.get('FIREBASE_SERVICE_ACCOUNT_B64')
    let serviceAccount: Record<string, string> | null = null
    let fcmAccessToken = ''
    let fcmProjectId   = ''
    if (serviceAccountB64) {
      serviceAccount = JSON.parse(atob(serviceAccountB64))
      fcmProjectId   = serviceAccount!.project_id
      fcmAccessToken = await getFcmAccessToken(serviceAccount!)
    }

    // Load VAPID keys (for iOS Web Push tokens)
    const vapidPublicKey  = Deno.env.get('VAPID_PUBLIC_KEY')  ?? ''
    const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY') ?? ''
    const vapidSubject    = Deno.env.get('VAPID_SUBJECT')     ?? 'mailto:admin@cargoexpress.ph'

    const logDelivery = async (targetUserId: string, deviceTokenId: string, status: string, providerMessageId?: string, errorMessage?: string) => {
      await supabase.from('notification_delivery_attempts').insert({
        notification_id: notification_id || null,
        user_id: targetUserId, device_token_id: deviceTokenId, status,
        provider_message_id: providerMessageId || null,
        error_message:       errorMessage      || null,
      })
    }

    const results = []

    for (const dev of devices) {
      const isWebPush = dev.token.startsWith('webpush:')

      if (isWebPush) {
        // ── iOS / Safari Web Push path ────────────────────────────────────
        if (!vapidPublicKey || !vapidPrivateKey) {
          await logDelivery(dev.user_id, dev.id, 'skipped', undefined, 'VAPID keys not configured')
          results.push({ success: false, platform: 'webpush', error: 'VAPID keys not configured' })
          continue
        }
        let subscriptionJson: Record<string, unknown>
        try {
          subscriptionJson = JSON.parse(dev.token.slice('webpush:'.length))
        } catch {
          await logDelivery(dev.user_id, dev.id, 'failed', undefined, 'Invalid subscription JSON')
          results.push({ success: false, platform: 'webpush', error: 'Invalid subscription JSON' })
          continue
        }
        const res = await sendWebPush(
          subscriptionJson as Record<string, string | Record<string, string>>,
          vapidPublicKey, vapidPrivateKey, vapidSubject,
          title, body || 'You have a new update', clickUrl,
        )
        if (res.stale) await supabase.from('user_device_tokens').delete().eq('token', dev.token)
        await logDelivery(dev.user_id, dev.id, res.ok ? 'sent' : 'failed', res.messageId, res.error)
        results.push({ success: res.ok, platform: 'webpush', ...(res.error && { error: res.error }), ...(res.stale && { stale: true }) })

      } else {
        // ── FCM path (Android / Chrome / Desktop) ─────────────────────────
        if (!fcmAccessToken) {
          await logDelivery(dev.user_id, dev.id, 'skipped', undefined, 'FIREBASE_SERVICE_ACCOUNT_B64 not configured')
          results.push({ success: false, platform: 'fcm', error: 'Firebase not configured' })
          continue
        }
        const res = await sendFcm(dev.token, fcmProjectId, fcmAccessToken, title, body || 'You have a new update', clickUrl, webpushLink)
        if (res.stale) await supabase.from('user_device_tokens').delete().eq('token', dev.token)
        await logDelivery(dev.user_id, dev.id, res.ok ? 'sent' : 'failed', res.messageId, res.error)
        results.push({ success: res.ok, platform: 'fcm', ...(res.messageId && { providerMessageId: res.messageId }), ...(res.error && { error: res.error }), ...(res.stale && { stale: true }) })
      }
    }

    return jsonResp({ success: results.some((r) => r.success), results })
  } catch (err) {
    return jsonResp({ error: err.message }, 500)
  }
})
