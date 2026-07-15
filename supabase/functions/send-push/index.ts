// Supabase Edge Function: send-push
// Sends a push notification via Firebase Cloud Messaging (HTTP v1 API)
// Called when a notification is created in the database
//
// Environment secrets needed:
//   FIREBASE_SERVICE_ACCOUNT_B64 - base64 encoded Firebase service account JSON
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const DEFAULT_NOTIFICATION_PATH = '/customer/notifications'

function getHttpsUrl(value) {
  if (!value) return null

  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

// Google OAuth2 token generation for FCM v1
async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }

  // Encode header and payload
  const encode = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const unsignedToken = `${encode(header)}.${encode(payload)}`

  // Sign with RSA private key
  const keyData = serviceAccount.private_key
  const pemContents = keyData.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '')
  const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0))

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', binaryKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  )

  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsignedToken))
  const signedToken = `${unsignedToken}.${btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`

  // Exchange JWT for access token
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedToken}`,
  })

  const tokenData = await tokenResponse.json()
  return tokenData.access_token
}

serve(async (req) => {
  try {
    // CORS headers
    if (req.method === 'OPTIONS') {
      return new Response('ok', {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        },
      })
    }

    const { notification_id, user_id, title, body, url } = await req.json()
    const clickUrl = url || DEFAULT_NOTIFICATION_PATH
    const webpushLink = getHttpsUrl(clickUrl)

    if (!user_id || !title) {
      return new Response(JSON.stringify({ error: 'user_id and title required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      })
    }

    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Authentication required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    const userClient = createClient(
      supabaseUrl,
      anonKey,
      { global: { headers: { Authorization: authHeader } } },
    )

    const { data: userData, error: userError } = await userClient.auth.getUser()
    if (userError || !userData.user) {
      return new Response(JSON.stringify({ error: 'Authentication required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      })
    }

    // Service-role client is used only after the requester has been authenticated.
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      serviceRoleKey,
    )

    // Fetch both requester and target roles to check authorization.
    // Allow if requester is admin, or target is self, or target is an admin (e.g., customers notifying admins).
    const [{ data: requester, error: requesterError }, { data: targetUser }] = await Promise.all([
      supabase
        .from('profiles')
        .select('role')
        .eq('id', userData.user.id)
        .single(),
      supabase
        .from('profiles')
        .select('role')
        .eq('id', user_id)
        .single()
    ]);

    const isTargetAdmin = targetUser?.role === 'admin';

    if (requesterError || (requester?.role !== 'admin' && userData.user.id !== user_id && !isTargetAdmin)) {
      return new Response(JSON.stringify({ error: 'Access denied' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      })
    }

    const { data: devices, error: devicesError } = await supabase
      .from('user_device_tokens')
      .select('id, token')
      .eq('user_id', user_id);

    if (devicesError || !devices || devices.length === 0) {
      // Keep an auditable result even when the user has not opted in on a device.
      await supabase.from('notification_delivery_attempts').insert({
        notification_id: notification_id || null,
        user_id,
        status: 'skipped',
        error_message: devicesError?.message || 'No device tokens for user',
      });
      return new Response(JSON.stringify({ error: 'No device tokens for user', skipped: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Get Firebase service account (stored as base64 to avoid env parsing issues)
    const serviceAccountB64 = Deno.env.get('FIREBASE_SERVICE_ACCOUNT_B64')
    if (!serviceAccountB64) {
      return new Response(JSON.stringify({ error: 'FIREBASE_SERVICE_ACCOUNT_B64 not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      })
    }

    const serviceAccount = JSON.parse(atob(serviceAccountB64))
    const projectId = serviceAccount.project_id
    const accessToken = await getAccessToken(serviceAccount)
    if (!accessToken) throw new Error('Unable to obtain Firebase access token')

    const results = [];

    // This audit is intentionally server-side and never stores FCM token values.
    const logDelivery = async (deviceTokenId, status, providerMessageId = null, errorMessage = null) => {
      const { error: logError } = await supabase
        .from('notification_delivery_attempts')
        .insert({
          notification_id: notification_id || null,
          user_id,
          device_token_id: deviceTokenId,
          status,
          provider_message_id: providerMessageId,
          error_message: errorMessage,
        });
      if (logError) console.error('Unable to log push delivery:', logError.message);
    };

    for (const dev of devices) {
      // Send push via FCM v1 API
      const fcmResponse = await fetch(
        `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token: dev.token,
              notification: {
                title: title,
                body: body || 'You have a new update',
              },
              data: {
                url: clickUrl,
              },
              ...(webpushLink ? {
                webpush: {
                  fcm_options: {
                    link: webpushLink,
                  },
                },
              } : {}),
            },
          }),
        }
      )

      const fcmResult = await fcmResponse.json()
      const fcmError = fcmResult?.error

      if (fcmError) {
        const errorCode = fcmError.details?.[0]?.errorCode || ''
        const isStaleToken =
          errorCode === 'UNREGISTERED' ||
          fcmError.status === 'NOT_FOUND' ||
          errorCode === 'INVALID_ARGUMENT'

        if (isStaleToken) {
          // Clear the dead token so we stop sending to it.
          await supabase
            .from('user_device_tokens')
            .delete()
            .eq('token', dev.token)
          await logDelivery(dev.id, 'failed', null, fcmError.message)
          results.push({ success: false, stale: true, error: fcmError.message })
        } else {
          await logDelivery(dev.id, 'failed', null, fcmError.message)
          results.push({ success: false, stale: false, error: fcmError.message })
        }
      } else {
        const providerMessageId = fcmResult?.name || null
        await logDelivery(dev.id, 'sent', providerMessageId)
        results.push({ success: true, providerMessageId })
      }
    }

    const anySuccess = results.some(r => r.success);
    return new Response(JSON.stringify({ success: anySuccess, results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  }
})
