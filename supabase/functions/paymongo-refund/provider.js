export const PAYMONGO_REFUNDS_URL = 'https://api.paymongo.com/v1/refunds'

const firstProviderError = (payload) => (
  Array.isArray(payload?.errors) ? payload.errors[0] : null
)

export const providerError = (payload) => {
  const item = firstProviderError(payload)
  return {
    code: typeof item?.code === 'string' ? item.code : null,
    detail: typeof item?.detail === 'string' ? item.detail : 'PayMongo could not create the refund.',
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

const wait = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds))

// The request body and idempotency key are built once and reused byte-for-byte
// across every retry. PayMongo can therefore replay its original result rather
// than creating a second refund after an uncertain network outcome.
export const postPayMongoRefund = async ({
  authorization,
  idempotencyKey,
  paymentId,
  amount,
  reason,
  notes,
  fetchImpl = globalThis.fetch,
  sleep = wait,
  timeoutMs = 15_000,
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
