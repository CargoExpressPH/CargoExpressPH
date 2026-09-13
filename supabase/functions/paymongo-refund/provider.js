export const PAYMONGO_REFUNDS_URL = 'https://api.paymongo.com/v1/refunds'

const firstProviderError = (payload) => (
  Array.isArray(payload?.errors) ? payload.errors[0] : null
)

export const sanitizeDiagnosticText = (value, fallback = 'No provider detail was returned') => {
  const sanitized = String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\bsk_(?:test|live)_[A-Za-z0-9_-]+\b/gi, '[redacted-key]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, '[redacted-authorization]')
    .replace(/\s+/g, ' ')
    .trim();
  return (sanitized || fallback).slice(0, 500);
};

const safeProviderMessage = (code, detail) => {
  const combined = `${code || ''} ${detail || ''}`.toLowerCase();
  if (/source.?type|legacy.?source/.test(combined)) {
    return 'This older GCash payment cannot be refunded automatically. Create the refund in the PayMongo Dashboard; CargoExpress will reconcile it automatically.';
  }
  if (/not.?refundable|refund.*not.*allow/.test(combined)) {
    return 'PayMongo says this payment is not eligible for a refund.';
  }
  if (/amount|exceed|balance/.test(combined)) {
    return 'PayMongo did not accept this refund amount. Check the payment’s refundable balance and try again.';
  }
  if (/not.?found|resource_missing/.test(combined)) {
    return 'PayMongo could not find the original payment for this refund.';
  }
  if (/already.*refund|duplicate/.test(combined)) {
    return 'PayMongo reports that this payment has already been refunded or has no refundable amount remaining.';
  }
  return 'PayMongo could not complete the refund. No refund amount was deducted from the order’s collected total.';
};

export const providerError = (payload) => {
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
