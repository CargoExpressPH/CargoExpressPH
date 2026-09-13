export const PAYMONGO_REFUNDS_URL = 'https://api.paymongo.com/v1/refunds'
export const PAYMONGO_REFUNDS_LIST_URL = 'https://api.paymongo.com/refunds'
export const PAYMONGO_PAYMENTS_URL = 'https://api.paymongo.com/v1/payments'

const firstProviderError = payload => (
  Array.isArray(payload?.errors) ? payload.errors[0] : null
)

export const providerError = payload => {
  const item = firstProviderError(payload)
  return {
    code: typeof item?.code === 'string' ? item.code : null,
    detail: typeof item?.detail === 'string' ? item.detail : 'PayMongo could not process the refund request.',
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
    const detail = failure.detail === 'PayMongo could not process the refund request.'
      ? ''
      : `: ${failure.detail}`
    throw new Error(`PayMongo recovery request failed with status ${response.status}${failure.code ? ` (${failure.code})` : ''}${detail}`)
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
