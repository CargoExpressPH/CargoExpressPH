export type RecipientOutcome = 'accepted' | 'skipped' | 'retryable' | 'permanent_failed' | 'needs_review'

export interface ClaimedRecipient {
  id: string
  email: string
  idempotency_key: string
  recipient_token: string
  delivery_payload: Record<string, unknown> | null
}

export interface ProviderResult {
  status: number
  body?: Record<string, unknown> | null
}

export interface BroadcastAdapter {
  claimBroadcast(workerToken: string): Promise<Record<string, unknown>>
  claimRecipient(workerToken: string): Promise<ClaimedRecipient | null>
  isSubscribed(email: string): Promise<boolean>
  buildPayload(recipient: ClaimedRecipient, claim: Record<string, unknown>): Promise<Record<string, unknown>>
  preparePayload(recipient: ClaimedRecipient, workerToken: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>
  send(payload: Record<string, unknown>, idempotencyKey: string): Promise<ProviderResult>
  record(recipient: ClaimedRecipient, workerToken: string, outcome: RecipientOutcome, details?: {
    providerMessageId?: string | null
    error?: string | null
  }): Promise<void>
  finish(workerToken: string): Promise<Record<string, unknown>>
}

const providerErrorType = (body?: Record<string, unknown> | null) =>
  typeof body?.name === 'string' ? body.name : typeof body?.type === 'string' ? body.type : ''

export function classifyProviderResult(result: ProviderResult): {
  outcome: RecipientOutcome
  providerMessageId?: string | null
  error?: string
} {
  if (result.status >= 200 && result.status < 300) {
    return {
      outcome: 'accepted',
      providerMessageId: typeof result.body?.id === 'string' ? result.body.id : null,
    }
  }

  const errorType = providerErrorType(result.body)
  if (result.status === 409 && errorType === 'concurrent_idempotent_requests') {
    return { outcome: 'retryable', error: 'Provider is processing the same idempotency key' }
  }
  if (result.status === 409) {
    return { outcome: 'needs_review', error: `Provider rejected idempotent retry (${errorType || 'conflict'})` }
  }
  if (result.status === 408 || result.status === 429 || result.status >= 500) {
    return { outcome: 'retryable', error: `Temporary provider failure (${result.status})` }
  }
  return { outcome: 'permanent_failed', error: `Provider rejected email (${result.status})` }
}

/**
 * Runs the durable worker after caller authentication. The adapter owns all
 * database transactions. Provider exceptions are uncertain outcomes, so the
 * recipient remains retryable with the exact same persisted payload and key.
 */
export async function runAnnouncementBroadcast(
  adapter: BroadcastAdapter,
  workerToken: string,
  maxRecipients = 50,
): Promise<Record<string, unknown>> {
  const claim = await adapter.claimBroadcast(workerToken)
  if (claim.state !== 'claimed') return claim

  let processed = 0
  while (processed < maxRecipients) {
    const recipient = await adapter.claimRecipient(workerToken)
    if (!recipient) break
    processed += 1

    let subscribed: boolean
    try {
      subscribed = await adapter.isSubscribed(recipient.email)
    } catch (error) {
      await adapter.record(recipient, workerToken, 'retryable', {
        error: `Consent recheck failed: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }

    if (!subscribed) {
      await adapter.record(recipient, workerToken, 'skipped')
      continue
    }

    let payload: Record<string, unknown>
    try {
      const proposed = recipient.delivery_payload ?? await adapter.buildPayload(recipient, claim)
      payload = await adapter.preparePayload(recipient, workerToken, proposed)
    } catch (error) {
      await adapter.record(recipient, workerToken, 'retryable', {
        error: `Payload persistence failed: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }

    try {
      const providerResult = await adapter.send(payload, recipient.idempotency_key)
      const classified = classifyProviderResult(providerResult)
      await adapter.record(recipient, workerToken, classified.outcome, classified)
    } catch (error) {
      await adapter.record(recipient, workerToken, 'retryable', {
        error: `Provider acceptance uncertain: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return { ...(await adapter.finish(workerToken)), processed }
}
