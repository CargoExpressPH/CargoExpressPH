export const PAYMONGO_REFUNDS_URL = 'https://api.paymongo.com/v1/refunds'
export const PAYMONGO_REFUNDS_LIST_URL = 'https://api.paymongo.com/refunds'
export const PAYMONGO_PAYMENTS_URL = 'https://api.paymongo.com/v1/payments'

const firstProviderError = payload => (
  Array.isArray(payload?.errors) ? payload.errors[0] : null
)

export const sanitizeDiagnosticText = (value, fallback = 'No provider detail was returned') => {
  const sanitized = String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\bsk_(?:test|live)_[A-Za-z0-9_-]+\b/gi, '[redacted-key]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, '[redacted-authorization]')
    .replace(/\s+/g, ' ')
    .trim()
  return (sanitized || fallback).slice(0, 500)
}

const safeProviderMessage = (code, detail) => {
  const combined = `${code || ''} ${detail || ''}`.toLowerCase()
  if (/source.?type|legacy.?source/.test(combined)) return 'This older GCash payment cannot be refunded automatically. CargoExpress support can complete it through PayMongo.'
  if (/not.?refundable|refund.*not.*allow/.test(combined)) return 'PayMongo says this payment is not eligible for a refund.'
  if (/amount|exceed|balance/.test(combined)) return 'PayMongo did not accept the refund amount for this payment.'
  if (/not.?found|resource_missing/.test(combined)) return 'PayMongo could not find the original payment for this refund.'
  if (/already.*refund|duplicate/.test(combined)) return 'PayMongo reports that this payment has already been refunded or has no refundable amount remaining.'
  return 'PayMongo could not complete the refund. No refund amount was deducted from the order’s collected total.'
}

export const providerError = payload => {
  const item = firstProviderError(payload)
  const code = typeof item?.code === 'string'
    ? item.code.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80)
    : null
  const detail = sanitizeDiagnosticText(item?.detail, 'PayMongo returned no error detail')
  return {
    code,
    detail,
    publicMessage: safeProviderMessage(code, detail),
  }
}

export const isRetryableProviderResponse = (response, payload) => {
  if (response.status >= 500) return true
  if (response.status !== 409) return false

  const error = providerError(payload)
  return error.code === 'idempotency_in_progress'
    || /idempotenc(?:y|e).*(?:progress|concurrent)/i.test(error.detail)
}

const refundBody = ({ amount, paymentId, reason, notes }) => JSON.stringify({
  data: {
    attributes: {
      amount: Math.round(amount * 100),
      payment_id: paymentId,
      reason,
      ...(notes ? { notes } : {}),
    },
  },
})

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

// Re-drive only an existing logical request. The caller supplies the UUID
// already stored in payment_refunds, and this exact body/key pair is reused
// across every provider retry.
export const postPayMongoRefund = async ({
  authorization,
  idempotencyKey,
  paymentId,
  amount,
  reason,
  notes,
  fetchImpl = globalThis.fetch,
  sleep = wait,
  timeoutMs = 12_000,
  maxAttempts = 2,
  signalFactory = milliseconds => AbortSignal.timeout(milliseconds),
}) => {
  const body = refundBody({ amount, paymentId, reason, notes })
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': authorization,
    'Idempotency-Key': idempotencyKey,
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response
    try {
      response = await fetchImpl(PAYMONGO_REFUNDS_URL, {
        method: 'POST',
        redirect: 'error',
        signal: signalFactory(timeoutMs),
        headers,
        body,
      })
    } catch {
      if (attempt < maxAttempts) {
        await sleep(750 * attempt)
        continue
      }
      return { response: null, providerBody: null, outcomeUnknown: true }
    }

    let providerBody = null
    try { providerBody = await response.json() } catch { providerBody = null }

    if (response.ok) return { response, providerBody, outcomeUnknown: false }

    if (isRetryableProviderResponse(response, providerBody)) {
      if (attempt < maxAttempts) {
        await sleep(750 * attempt)
        continue
      }
      return { response, providerBody, outcomeUnknown: true }
    }

    return { response, providerBody, outcomeUnknown: false }
  }

  return { response: null, providerBody: null, outcomeUnknown: true }
}

const getJson = async ({ url, authorization, fetchImpl, timeoutMs, signalFactory }) => {
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: signalFactory(timeoutMs),
      headers: { 'Authorization': authorization },
    })
  } catch {
    throw new Error('PayMongo recovery request timed out')
  }

  let body = null
  try { body = await response.json() } catch { body = null }
  if (!response.ok) {
    const failure = providerError(body)
    throw new Error(`PayMongo recovery request failed with status ${response.status}${failure.code ? ` (${failure.code})` : ''}: ${failure.detail}`)
  }
  return body
}

// A payment's mode is verified before an unclassified queue row is assigned
// to the currently configured test/live key. This prevents a future live-key
// switch from silently adopting historical test payments.
export const retrievePayMongoPaymentMode = async ({
  authorization,
  paymentId,
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000,
  signalFactory = milliseconds => AbortSignal.timeout(milliseconds),
}) => {
  const body = await getJson({
    url: `${PAYMONGO_PAYMENTS_URL}/${encodeURIComponent(paymentId)}`,
    authorization,
    fetchImpl,
    timeoutMs,
    signalFactory,
  })
  if (body?.data?.id !== paymentId || typeof body?.data?.attributes?.livemode !== 'boolean') {
    throw new Error('PayMongo payment response could not establish test/live mode')
  }
  return body.data.attributes.livemode
}

// Poll every refund attached to one Payment resource. Cursor pagination is
// bounded and rejects repeated cursors, so an upstream pagination bug cannot
// trap an Edge invocation in an infinite loop or silently truncate results.
export const listPayMongoRefunds = async ({
  authorization,
  paymentId,
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000,
  pageSize = 100,
  maxPages = 20,
  signalFactory = milliseconds => AbortSignal.timeout(milliseconds),
}) => {
  const refunds = []
  const seenRefundIds = new Set()
  const seenCursors = new Set()
  let after = null

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(PAYMONGO_REFUNDS_LIST_URL)
    // PayMongo's API reference renders these as data.attributes.* fields, but
    // the live endpoint accepts the actual flat query parameters below and
    // rejects the rendered names with parameter_invalid.
    url.searchParams.set('payment_id', paymentId)
    url.searchParams.set('limit', String(pageSize))
    if (after) url.searchParams.set('after', after)

    const body = await getJson({
      url,
      authorization,
      fetchImpl,
      timeoutMs,
      signalFactory,
    })
    if (!Array.isArray(body?.data)) {
      throw new Error('PayMongo refund list response was invalid')
    }

    for (const resource of body.data) {
      if (typeof resource?.id !== 'string' || !resource.id) {
        throw new Error('PayMongo refund list contained an invalid resource')
      }
      if (!seenRefundIds.has(resource.id)) {
        seenRefundIds.add(resource.id)
        refunds.push(resource)
      }
    }

    if (body.data.length < pageSize) return refunds
    const cursor = body.data.at(-1)?.id
    if (!cursor || seenCursors.has(cursor)) {
      throw new Error('PayMongo refund pagination did not advance')
    }
    seenCursors.add(cursor)
    after = cursor
  }

  throw new Error('PayMongo refund pagination exceeded the safe page limit')
}
