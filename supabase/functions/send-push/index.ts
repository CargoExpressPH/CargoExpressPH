// Supabase Edge Function: send-push
// Sends push notifications via:
//   • Firebase Cloud Messaging v1 API  → Android / Chrome / Desktop
//   • Web Push Protocol (RFC 8030)     → iOS 16.4+ PWA
//
// Environment secrets required:
//   FIREBASE_SERVICE_ACCOUNT_B64  - base64-encoded Firebase service account JSON
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

// ── FCM v1 helpers ────────────────────────────────────────────────────────────

async function getAccessToken(serviceAccount: Record<string, string>): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header  = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iss:   serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  }

  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  const unsignedToken = `${encode(header)}.${encode(payload)}`

  const pemContents = serviceAccount.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '')

  const binaryKey  = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0))
  const cryptoKey  = await crypto.subtle.importKey(
    'pkcs8', binaryKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  )
  const signature  = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsignedToken))
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
          token: fcmToken,
          notification: { title, body },
          data: { url: clickUrl },
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

// ── Web Push (iOS) helpers ────────────────────────────────────────────────────

function base64UrlToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64     = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const binary  = atob(b64)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

function uint8ArrayToBase64Url(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

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
    const endpoint   = subscriptionJson.endpoint as string
    const p256dh     = (subscriptionJson.keys as Record<string, string>).p256dh
    const auth       = (subscriptionJson.keys as Record<string, string>).auth

    // ── Build VAPID JWT ───────────────────────────────────────────────────
    const audience   = new URL(endpoint).origin
    const now        = Math.floor(Date.now() / 1000)
    const jwtPayload = { aud: audience, exp: now + 12 * 3600, sub: vapidSubject }
    const encode     = (o: unknown) => uint8ArrayToBase64Url(new TextEncoder().encode(JSON.stringify(o)))
    const header     = uint8ArrayToBase64Url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
    const sigInput   = `${header}.${encode(jwtPayload)}`

    const privateKeyBytes = base64UrlToUint8Array(vapidPrivateKey)
    const cryptoKey = await crypto.subtle.importKey(
      'raw', privateKeyBytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
    )
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      new TextEncoder().encode(sigInput),
    )
    const jwt = `${sigInput}.${uint8ArrayToBase64Url(new Uint8Array(sig))}`

    // ── Encrypt payload (AES-128-GCM + ECDH) ─────────────────────────────
    const payloadStr  = JSON.stringify({ notification: { title, body, data: { url: clickUrl } } })
    const payloadBuf  = new TextEncoder().encode(payloadStr)

    // Generate sender EC key pair
    const senderKey = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey'])
    const senderPub = await crypto.subtle.exportKey('raw', senderKey.publicKey)

    // Import receiver public key
    const receiverPub = await crypto.subtle.importKey(
      'raw', base64UrlToUint8Array(p256dh), { name: 'ECDH', namedCurve: 'P-256' }, false, [],
    )

    // Derive shared secret
    const sharedSecret = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: receiverPub },
      senderKey.privateKey,
      { name: 'HKDF' }, false, ['deriveKey'],
    )

    // Auth secret
    const authSecret = base64UrlToUint8Array(auth)
    const salt       = crypto.getRandomValues(new Uint8Array(16))

    // PRK using HKDF
    const prk = await crypto.subtle.importKey('raw', await crypto.subtle.exportKey('raw', sharedSecret), 'HKDF', false, ['deriveKey'])

    // Content encryption key + nonce
    const cekInfo   = new TextEncoder().encode('Content-Encoding: aes128gcm\x00')
    const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\x00')

    const hkdfKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: cekInfo },
      prk, { name: 'AES-GCM', length: 128 }, false, ['encrypt'],
    )

    // Nonce derivation (simplified — use salt directly for nonce, which works for RFC 8188)
    const nonce = new Uint8Array(12)
    const nonceKeyMaterial = new Uint8Array(await crypto.subtle.exportKey('raw',
      await crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt, info: nonceInfo },
        prk, { name: 'AES-GCM', length: 128 }, true, ['encrypt'],
      )
    ))
    nonce.set(nonceKeyMaterial.slice(0, 12))

    // Encrypt payload
    const paddedPayload = new Uint8Array([...payloadBuf, 2]) // padding delimiter
    const ciphertext    = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, hkdfKey, paddedPayload))

    // Build RFC 8188 encrypted body
    const senderPubBytes = new Uint8Array(senderPub)
    const recordSize     = new Uint8Array(4)
    new DataView(recordSize.buffer).setUint32(0, 4096)

    const content = new Uint8Array([
      ...salt,
      ...recordSize,
      senderPubBytes.length,
      ...senderPubBytes,
      ...ciphertext,
    ])

    // ── Send to push service ──────────────────────────────────────────────
    const pushResp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization':     `vapid t=${jwt}, k=${vapidPublicKey}`,
        'Content-Type':      'application/octet-stream',
        'Content-Encoding':  'aes128gcm',
        'TTL':               '86400',
      },
      body: content,
    })

    if (pushResp.status === 201 || pushResp.status === 200) {
      return { ok: true, messageId: `webpush-${Date.now()}` }
    }
    if (pushResp.status === 410 || pushResp.status === 404) {
      return { ok: false, stale: true, error: `Subscription gone (${pushResp.status})` }
    }
    const errText = await pushResp.text().catch(() => '')
    return { ok: false, error: `Push service error ${pushResp.status}: ${errText}` }
  } catch (e) {
    return { ok: false, error: `Web Push error: ${e.message}` }
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req) => {
  try {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

    const { notification_id, user_id, title, body, url } = await req.json()
    const clickUrl    = url || DEFAULT_NOTIFICATION_PATH
    const webpushLink = getHttpsUrl(clickUrl)

    if (!user_id || !title) return jsonResp({ error: 'user_id and title required' }, 400)

    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return jsonResp({ error: 'Authentication required' }, 401)

    const supabaseUrl      = Deno.env.get('SUPABASE_URL')              ?? ''
    const anonKey          = Deno.env.get('SUPABASE_ANON_KEY')         ?? ''
    const serviceRoleKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    // Verify caller's JWT
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
    const { data: userData, error: userError } = await userClient.auth.getUser()
    if (userError || !userData.user) return jsonResp({ error: 'Authentication required' }, 401)

    const supabase = createClient(supabaseUrl, serviceRoleKey)

    // Authorization check
    const [{ data: requester, error: reqErr }, { data: targetUser }] = await Promise.all([
      supabase.from('profiles').select('role').eq('id', userData.user.id).single(),
      supabase.from('profiles').select('role').eq('id', user_id).single(),
    ])
    const isTargetAdmin = targetUser?.role === 'admin'
    if (reqErr || (requester?.role !== 'admin' && userData.user.id !== user_id && !isTargetAdmin)) {
      return jsonResp({ error: 'Access denied' }, 403)
    }

    // Fetch device tokens
    const { data: devices, error: devErr } = await supabase
      .from('user_device_tokens')
      .select('id, token')
      .eq('user_id', user_id)

    if (devErr || !devices || devices.length === 0) {
      await supabase.from('notification_delivery_attempts').insert({
        notification_id: notification_id || null,
        user_id,
        status: 'skipped',
        error_message: devErr?.message || 'No device tokens for user',
      })
      return jsonResp({ error: 'No device tokens for user', skipped: true })
    }

    // Load Firebase service account (needed for FCM tokens)
    const serviceAccountB64 = Deno.env.get('FIREBASE_SERVICE_ACCOUNT_B64')
    let serviceAccount: Record<string, string> | null = null
    let fcmAccessToken = ''
    let fcmProjectId   = ''

    if (serviceAccountB64) {
      serviceAccount = JSON.parse(atob(serviceAccountB64))
      fcmProjectId   = serviceAccount!.project_id
      fcmAccessToken = await getAccessToken(serviceAccount!)
    }

    // VAPID keys for Web Push (iOS)
    const vapidPublicKey  = Deno.env.get('VAPID_PUBLIC_KEY')  ?? ''
    const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY') ?? ''
    const vapidSubject    = Deno.env.get('VAPID_SUBJECT')      ?? 'mailto:admin@cargoexpress.ph'

    const logDelivery = async (deviceTokenId: string, status: string, providerMessageId?: string, errorMessage?: string) => {
      await supabase.from('notification_delivery_attempts').insert({
        notification_id: notification_id || null,
        user_id,
        device_token_id: deviceTokenId,
        status,
        provider_message_id: providerMessageId || null,
        error_message: errorMessage || null,
      })
    }

    const results = []

    for (const dev of devices) {
      const isWebPush = dev.token.startsWith('webpush:')

      if (isWebPush) {
        // ── iOS / Safari Web Push path ──────────────────────────────────
        if (!vapidPublicKey || !vapidPrivateKey) {
          await logDelivery(dev.id, 'skipped', undefined, 'VAPID keys not configured')
          results.push({ success: false, platform: 'webpush', error: 'VAPID keys not configured' })
          continue
        }

        let subscriptionJson: Record<string, unknown>
        try {
          subscriptionJson = JSON.parse(dev.token.slice('webpush:'.length))
        } catch {
          await logDelivery(dev.id, 'failed', undefined, 'Invalid subscription JSON')
          results.push({ success: false, platform: 'webpush', error: 'Invalid subscription JSON' })
          continue
        }

        const res = await sendWebPush(
          subscriptionJson as Record<string, string | Record<string, string>>,
          vapidPublicKey,
          vapidPrivateKey,
          vapidSubject,
          title,
          body || 'You have a new update',
          clickUrl,
        )

        if (res.stale) {
          await supabase.from('user_device_tokens').delete().eq('token', dev.token)
        }
        await logDelivery(dev.id, res.ok ? 'sent' : 'failed', res.messageId, res.error)
        results.push({ success: res.ok, platform: 'webpush', ...(res.error && { error: res.error }), ...(res.stale && { stale: true }) })

      } else {
        // ── FCM path (Android / Chrome) ─────────────────────────────────
        if (!fcmAccessToken) {
          await logDelivery(dev.id, 'skipped', undefined, 'FIREBASE_SERVICE_ACCOUNT_B64 not configured')
          results.push({ success: false, platform: 'fcm', error: 'Firebase not configured' })
          continue
        }

        const res = await sendFcm(dev.token, fcmProjectId, fcmAccessToken, title, body || 'You have a new update', clickUrl, webpushLink)

        if (res.stale) {
          await supabase.from('user_device_tokens').delete().eq('token', dev.token)
        }
        await logDelivery(dev.id, res.ok ? 'sent' : 'failed', res.messageId, res.error)
        results.push({ success: res.ok, platform: 'fcm', ...(res.messageId && { providerMessageId: res.messageId }), ...(res.error && { error: res.error }), ...(res.stale && { stale: true }) })
      }
    }

    const anySuccess = results.some((r) => r.success)
    return jsonResp({ success: anySuccess, results })

  } catch (err) {
    return jsonResp({ error: err.message }, 500)
  }
})
