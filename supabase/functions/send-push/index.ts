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
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

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
    // Dual shape: top-level fields for iOS Web Push SW parsing, plus
    // notification/data wrappers for FCM-compatible service workers.
    const payloadBytes = new TextEncoder().encode(JSON.stringify({
      title,
      body,
      icon:  '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
      notification: { title, body, icon: '/icons/icon-192.png', badge: '/icons/icon-72.png' },
      data:  { url: clickUrl, title, body },
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
  const supabaseUrl    = Deno.env.get('SUPABASE_URL')              ?? ''
  const anonKey        = Deno.env.get('SUPABASE_ANON_KEY')         ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(supabaseUrl, serviceRoleKey)
  let contactDispatchClaimed = false
  let contactInquiryId = ''
  let contactDispatchClaimId: string | null = null

  const finishContactDispatch = async (delivered: boolean) => {
    if (!contactDispatchClaimed || !contactInquiryId) return

    const { error } = await supabase.rpc(
      delivered ? 'complete_contact_inquiry_push' : 'release_contact_inquiry_push',
      { p_inquiry_id: contactInquiryId, p_claim_id: contactDispatchClaimId },
    )
    if (error) console.error('[send-push] unable to finish contact dispatch lease:', error.message)
    contactDispatchClaimed = false
    contactDispatchClaimId = null
  }

  try {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

    const payload = await req.json()
    const {
      notification_id: requestedNotificationId,
      reference_id: requestedReferenceId,
      notification_type: requestedNotificationType,
      user_id: requestedUserId,
      title: requestedTitle,
      body: requestedBody,
      url: requestedUrl,
      event,
      order_id,
      approved,
      inquiry_id,
    } = payload

    const isContactEvent = event === 'contact_inquiry'

    let notification_id: string | null = typeof requestedNotificationId === 'string' && requestedNotificationId
      ? requestedNotificationId
      : null
    let notification_reference_id: string | null = typeof requestedReferenceId === 'string' && requestedReferenceId
      ? requestedReferenceId
      : null
    let notification_type: string | null = typeof requestedNotificationType === 'string' && requestedNotificationType
      ? requestedNotificationType
      : null
    let user_id: string | null = requestedUserId || null
    let title: string | null = requestedTitle || null
    let body: string | null = requestedBody || null
    let url: string | null = requestedUrl || null
    let isRequesterAdmin = false
    let requesterUserId = ''

    if (isContactEvent) {
      // This is the only anonymous mode. The inquiry ID is generated by the
      // public client, and the payload is always rebuilt from the saved row.
      if (typeof inquiry_id !== 'string' || !inquiry_id) {
        return jsonResp({ error: 'inquiry_id required' }, 400)
      }

      const { data: inquiry, error: inquiryError } = await supabase
        .from('contact_inquiries')
        .select('id, name, message, created_at')
        .eq('id', inquiry_id)
        .maybeSingle()
      if (inquiryError) return jsonResp({ error: inquiryError.message }, 500)
      if (!inquiry) return jsonResp({ error: 'Inquiry not found' }, 404)

      // Claim with a short lease. The marker is completed only after at least
      // one provider accepts the push, so a temporary provider failure can be
      // retried without permanently suppressing the inquiry.
      const { data: claimed, error: claimError } = await supabase.rpc('claim_contact_inquiry_push', {
        p_inquiry_id: inquiry_id,
      })
      if (claimError) return jsonResp({ error: claimError.message }, 500)
      if (!claimed) return jsonResp({ success: true, skipped: true, already_dispatched: true })
      contactDispatchClaimed = true
      contactInquiryId = inquiry_id
      contactDispatchClaimId = claimed

      user_id = 'all_admins'
      title = 'New Contact Inquiry'
      body = `Inquiry from ${String(inquiry.name || 'Visitor').trim() || 'Visitor'}: ${String(inquiry.message || '').trim().slice(0, 80)}`
      url = '/admin'
      notification_reference_id = inquiry_id
      notification_type = 'inquiry'
    } else {
      const authHeader = req.headers.get('Authorization') || ''
      if (!authHeader.startsWith('Bearer ')) return jsonResp({ error: 'Authentication required' }, 401)

      // Verify the caller's JWT for all authenticated notification events.
      const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
      const { data: userData, error: userError } = await userClient.auth.getUser()
      if (userError || !userData.user) return jsonResp({ error: 'Authentication required' }, 401)
      requesterUserId = userData.user.id

      const { data: requester, error: requesterError } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', requesterUserId)
        .single()
      if (requesterError) return jsonResp({ error: 'Unable to verify sender role' }, 500)
      isRequesterAdmin = requester?.role === 'admin'

      if (event === 'cancellation_request') {
        if (typeof order_id !== 'string' || !order_id) return jsonResp({ error: 'order_id required' }, 400)
        const { data: order, error: orderError } = await supabase
          .from('orders')
          .select('id, user_id, tracking_number, status, cancellation_reason')
          .eq('id', order_id)
          .maybeSingle()
        if (orderError) return jsonResp({ error: orderError.message }, 500)
        if (!order || order.user_id !== requesterUserId || order.status !== 'Pending Cancellation') {
          return jsonResp({ error: 'Cancellation request is not valid for this account' }, 403)
        }

        user_id = 'all_admins'
        title = 'Cancellation Requested'
        body = `Order ${order.tracking_number}: the customer asked to cancel. Reason: ${String(order.cancellation_reason || '').trim()}`
        url = '/admin'
        notification_reference_id = order_id
        notification_type = 'order_update'
      } else if (event === 'cancellation_review') {
        if (!isRequesterAdmin) return jsonResp({ error: 'Admin privileges required' }, 403)
        if (typeof order_id !== 'string' || !order_id) return jsonResp({ error: 'order_id required' }, 400)
        const { data: order, error: orderError } = await supabase
          .from('orders')
          .select('id, user_id, tracking_number, status, cancellation_previous_status, cancellation_review_notes, cancellation_requested_at')
          .eq('id', order_id)
          .maybeSingle()
        if (orderError) return jsonResp({ error: orderError.message }, 500)
        if (!order || !order.cancellation_requested_at) {
          return jsonResp({ error: 'Cancellation review is not valid' }, 403)
        }

        const approvedReview = approved === true
        if ((approvedReview && order.status !== 'Cancelled') || (!approvedReview && order.status === 'Pending Cancellation')) {
          return jsonResp({ error: 'Cancellation review state does not match the order' }, 409)
        }

        const restoredStatus = order.cancellation_previous_status || 'Pending'
        user_id = order.user_id
        title = approvedReview ? 'Cancellation Approved' : 'Cancellation Declined'
        body = approvedReview
          ? `Order ${order.tracking_number} has been cancelled as you requested.`
          : `Order ${order.tracking_number} was not cancelled and is back to "${restoredStatus}".`
        if (order.cancellation_review_notes) body += ` Note from our team: ${order.cancellation_review_notes}`
        url = '/customer/notifications'
        notification_reference_id = order_id
        notification_type = 'order_update'
      } else {
        if (!user_id || !title) return jsonResp({ error: 'user_id and title required' }, 400)

        // Authorization: must be admin, sending to self, or sending to an admin.
        const { data: targetUser, error: targetError } = user_id === 'all_customers'
          ? { data: null, error: null }
          : await supabase.from('profiles').select('role').eq('id', user_id).single()
        const isTargetAdmin = targetUser?.role === 'admin'
        if (targetError || (!isRequesterAdmin && requesterUserId !== user_id && !isTargetAdmin)) {
          return jsonResp({ error: 'Access denied' }, 403)
        }
      }
    }

    if (!user_id || !title) return jsonResp({ error: 'Notification target and title required' }, 400)

    // ───────────────────────────────────────────────────────────────────────────
    // SECURITY: the click-through destination is caller-supplied.
    //
    // The rule above deliberately lets a CUSTOMER push a notification to an
    // ADMIN (new chat message, new booking). Combined with an unrestricted url
    // that is a phishing primitive: a customer could send staff a notification
    // carrying the app's own name and icon that opens an attacker-controlled
    // https:// site. getHttpsUrl() accepted any host.
    //
    // Non-admin callers are therefore limited to in-app paths. Admins keep the
    // absolute-URL capability, which the FCM webpush link field needs.
    // ───────────────────────────────────────────────────────────────────────────
    const isSafeInAppPath = (value: unknown): value is string =>
      typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')

    let clickUrl: string
    if (isContactEvent || event === 'cancellation_request' || event === 'cancellation_review') {
      clickUrl = (typeof url === 'string' && url) || DEFAULT_NOTIFICATION_PATH
    } else if (isRequesterAdmin) {
      clickUrl = (typeof url === 'string' && url) || DEFAULT_NOTIFICATION_PATH
    } else if (isSafeInAppPath(url)) {
      clickUrl = url
    } else {
      if (url) {
        console.warn(
          `[send-push] Rejected non-admin click url=${String(url).slice(0, 120)} from user=${requesterUserId}`,
        )
      }
      clickUrl = DEFAULT_NOTIFICATION_PATH
    }
    const webpushLink = getHttpsUrl(clickUrl)

    // Fetch device tokens for the target user(s)
    let devices: { id: string; token: string; user_id: string }[] = []
    let devErr = null

    if (user_id === 'all_customers' || user_id === 'all_admins') {
      const { data, error } = await supabase
        .from('user_device_tokens')
        .select('id, token, user_id, profiles!inner(role)')
        .eq('profiles.role', user_id === 'all_admins' ? 'admin' : 'customer')
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
      if (isContactEvent) await finishContactDispatch(false)
      if (user_id !== 'all_customers' && user_id !== 'all_admins') {
        await supabase.from('notification_delivery_attempts').insert({
          notification_id: notification_id || null,
          user_id, status: 'skipped',
          error_message: devErr?.message || 'No device tokens for user',
        })
      }
      return jsonResp({ error: 'No device tokens for user', skipped: true })
    }

    // Resolve the in-app notification for each recipient when a broadcast is
    // used. A broadcast has one notification row per user, so one shared id
    // would make delivery audits point at the wrong recipient.
    const notificationIdByUser = new Map<string, string>()
    if (notification_reference_id && title) {
      let notificationQuery = supabase
        .from('notifications')
        .select('id, user_id, created_at')
        .eq('reference_id', notification_reference_id)
        .eq('title', title)
        .order('created_at', { ascending: false })
        .limit(1000)
      if (notification_type) notificationQuery = notificationQuery.eq('type', notification_type)

      const { data: relatedNotifications, error: notificationLookupError } = await notificationQuery
      if (notificationLookupError) {
        console.warn('[send-push] notification correlation lookup failed:', notificationLookupError.message)
      } else {
        for (const row of relatedNotifications || []) {
          if (row.user_id && row.id && !notificationIdByUser.has(row.user_id)) {
            notificationIdByUser.set(row.user_id, row.id)
          }
        }
      }
    }

    const directNotificationId = user_id === 'all_customers' || user_id === 'all_admins'
      ? null
      : notification_id
    const notificationIdForDevice = (deviceUserId: string) =>
      directNotificationId || notificationIdByUser.get(deviceUserId) || null

    // A client retry after a provider accepted the message must not show the
    // same push twice. Existing sent attempts are skipped for the same
    // notification/device pair.
    const sentDeliveryKeys = new Set<string>()
    const correlationIds = devices
      .map((device) => notificationIdForDevice(device.user_id))
      .filter(Boolean)
    if (correlationIds.length > 0) {
      const { data: sentAttempts, error: sentAttemptLookupError } = await supabase
        .from('notification_delivery_attempts')
        .select('notification_id, device_token_id')
        .in('notification_id', [...new Set(correlationIds)])
        .in('device_token_id', devices.map((device) => device.id))
        .eq('status', 'sent')
      if (sentAttemptLookupError) {
        console.warn('[send-push] sent-attempt lookup failed:', sentAttemptLookupError.message)
      } else {
        for (const attempt of sentAttempts || []) {
          if (attempt.notification_id && attempt.device_token_id) {
            sentDeliveryKeys.add(`${attempt.notification_id}:${attempt.device_token_id}`)
          }
        }
      }
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

    const logDelivery = async (targetUserId: string, deviceTokenId: string, status: string, providerMessageId?: string, errorMessage?: string, deliveryNotificationId?: string | null) => {
      await supabase.from('notification_delivery_attempts').insert({
        notification_id: deliveryNotificationId || null,
        user_id: targetUserId, device_token_id: deviceTokenId, status,
        provider_message_id: providerMessageId || null,
        error_message:       errorMessage      || null,
      })
    }

    const results = []

    for (const dev of devices) {
      const deliveryNotificationId = notificationIdForDevice(dev.user_id)
      const deliveryKey = deliveryNotificationId ? `${deliveryNotificationId}:${dev.id}` : null
      if (deliveryKey && sentDeliveryKeys.has(deliveryKey)) {
        results.push({ success: true, skipped: true, alreadySent: true, platform: dev.token.startsWith('webpush:') ? 'webpush' : 'fcm' })
        continue
      }
      const isWebPush = dev.token.startsWith('webpush:')

      if (isWebPush) {
        // ── iOS / Safari Web Push path ────────────────────────────────────
        if (!vapidPublicKey || !vapidPrivateKey) {
          await logDelivery(dev.user_id, dev.id, 'skipped', undefined, 'VAPID keys not configured', deliveryNotificationId)
          results.push({ success: false, platform: 'webpush', error: 'VAPID keys not configured' })
          continue
        }
        let subscriptionJson: Record<string, unknown>
        try {
          subscriptionJson = JSON.parse(dev.token.slice('webpush:'.length))
        } catch {
          await logDelivery(dev.user_id, dev.id, 'failed', undefined, 'Invalid subscription JSON', deliveryNotificationId)
          results.push({ success: false, platform: 'webpush', error: 'Invalid subscription JSON' })
          continue
        }
        const res = await sendWebPush(
          subscriptionJson as Record<string, string | Record<string, string>>,
          vapidPublicKey, vapidPrivateKey, vapidSubject,
          title, body || 'You have a new update', clickUrl,
        )
        if (res.stale) await supabase.from('user_device_tokens').delete().eq('id', dev.id)
        await logDelivery(dev.user_id, dev.id, res.ok ? 'sent' : 'failed', res.messageId, res.error, deliveryNotificationId)
        results.push({ success: res.ok, platform: 'webpush', ...(res.error && { error: res.error }), ...(res.stale && { stale: true }) })

      } else {
        // ── FCM path (Android / Chrome / Desktop) ─────────────────────────
        if (!fcmAccessToken) {
          await logDelivery(dev.user_id, dev.id, 'skipped', undefined, 'FIREBASE_SERVICE_ACCOUNT_B64 not configured', deliveryNotificationId)
          results.push({ success: false, platform: 'fcm', error: 'Firebase not configured' })
          continue
        }
        const res = await sendFcm(dev.token, fcmProjectId, fcmAccessToken, title, body || 'You have a new update', clickUrl, webpushLink)
        if (res.stale) await supabase.from('user_device_tokens').delete().eq('id', dev.id)
        await logDelivery(dev.user_id, dev.id, res.ok ? 'sent' : 'failed', res.messageId, res.error, deliveryNotificationId)
        results.push({ success: res.ok, platform: 'fcm', ...(res.messageId && { providerMessageId: res.messageId }), ...(res.error && { error: res.error }), ...(res.stale && { stale: true }) })
      }
    }

    const delivered = results.some((r) => r.success)
    if (isContactEvent) await finishContactDispatch(delivered)

    return jsonResp({ success: delivered, results })
  } catch (err) {
    if (contactDispatchClaimed) await finishContactDispatch(false)
    return jsonResp({ error: err.message }, 500)
  }
})
