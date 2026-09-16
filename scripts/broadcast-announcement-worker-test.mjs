import assert from 'node:assert/strict';
import {
  classifyProviderResult,
  runAnnouncementBroadcast,
} from '../supabase/functions/_shared/announcement-broadcast-worker.ts';

class FakeAdapter {
  constructor(emails, send) {
    this.rows = emails.map((email, index) => ({
      id: String(index + 1), email, idempotency_key: `stable-${index + 1}`,
      recipient_token: '', delivery_payload: null, status: 'pending', eligibleRun: 1,
    }));
    this.sendImpl = send;
    this.locked = false;
    this.sent = [];
    this.consentFailures = new Set();
    this.unsubscribed = new Set();
    this.failFinishOnce = false;
    this.run = 0;
  }
  async claimBroadcast() {
    if (this.locked) return { state: 'busy' };
    this.locked = true;
    this.run += 1;
    return { state: 'claimed', subject: 'Notice', content: 'Body', from_email: 'from@example.com' };
  }
  async claimRecipient() {
    const row = this.rows.find(item => ['pending', 'retryable'].includes(item.status) && item.eligibleRun <= this.run);
    if (!row) return null;
    row.status = 'sending'; row.recipient_token = `claim-${row.id}`;
    return { ...row };
  }
  async isSubscribed(email) {
    if (this.consentFailures.delete(email)) throw new Error('database unavailable');
    return !this.unsubscribed.has(email);
  }
  async buildPayload(recipient, claim) {
    return { to: recipient.email, subject: claim.subject, html: claim.content };
  }
  async preparePayload(recipient, _worker, payload) {
    const row = this.rows.find(item => item.id === recipient.id);
    row.delivery_payload ??= structuredClone(payload);
    return structuredClone(row.delivery_payload);
  }
  async send(payload, key) {
    this.sent.push({ payload: structuredClone(payload), key });
    return this.sendImpl(payload, key, this.sent.length);
  }
  async record(recipient, _worker, outcome) {
    const row = this.rows.find(item => item.id === recipient.id);
    row.status = outcome;
    if (outcome === 'retryable') row.eligibleRun = this.run + 1;
  }
  async finish() {
    if (this.failFinishOnce) { this.failFinishOnce = false; throw new Error('completion write failed'); }
    this.locked = false;
    const complete = this.rows.every(row => ['accepted', 'skipped'].includes(row.status));
    return { state: complete ? 'completed' : 'partial' };
  }
}

// Atomic claim: one of two concurrent invocations owns the broadcast.
const concurrent = new FakeAdapter(['one@example.com'], async () => ({ status: 200, body: { id: 'm1' } }));
const concurrentResults = await Promise.all([
  runAnnouncementBroadcast(concurrent, 'worker-a'),
  runAnnouncementBroadcast(concurrent, 'worker-b'),
]);
assert.deepEqual(concurrentResults.map(result => result.state).sort(), ['busy', 'completed']);
assert.equal(concurrent.sent.length, 1);

// A partial failure retries only the unfinished recipient with the same key.
const partial = new FakeAdapter(['ok@example.com', 'retry@example.com'], async (payload, _key, call) =>
  payload.to === 'retry@example.com' && call === 2
    ? { status: 503, body: { name: 'provider_down' } }
    : { status: 200, body: { id: `m${call}` } });
assert.equal((await runAnnouncementBroadcast(partial, 'worker-a')).state, 'partial');
assert.deepEqual(partial.rows.map(row => row.status), ['accepted', 'retryable']);
const firstRetryKey = partial.sent.find(send => send.payload.to === 'retry@example.com').key;
assert.equal((await runAnnouncementBroadcast(partial, 'worker-b')).state, 'completed');
assert.equal(partial.sent.filter(send => send.payload.to === 'ok@example.com').length, 1);
assert.equal(partial.sent.at(-1).key, firstRetryKey);

// A timeout is uncertain: retry the persisted payload with the stable key.
let timeoutCalls = 0;
const timeout = new FakeAdapter(['timeout@example.com'], async () => {
  if (timeoutCalls++ === 0) throw new Error('timeout');
  return { status: 200, body: { id: 'deduplicated-provider-result' } };
});
await runAnnouncementBroadcast(timeout, 'worker-a');
await runAnnouncementBroadcast(timeout, 'worker-b');
assert.equal(timeout.sent[0].key, timeout.sent[1].key);
assert.deepEqual(timeout.sent[0].payload, timeout.sent[1].payload);

// A failed consent check defers safely and never calls the provider.
const consent = new FakeAdapter(['consent@example.com'], async () => ({ status: 200, body: { id: 'm' } }));
consent.consentFailures.add('consent@example.com');
assert.equal((await runAnnouncementBroadcast(consent, 'worker-a')).state, 'partial');
assert.equal(consent.sent.length, 0);
await runAnnouncementBroadcast(consent, 'worker-b');
assert.equal(consent.sent.length, 1);

// Provider acceptance followed by a completion-write error does not resend.
const completion = new FakeAdapter(['done@example.com'], async () => ({ status: 200, body: { id: 'm' } }));
completion.failFinishOnce = true;
await assert.rejects(() => runAnnouncementBroadcast(completion, 'worker-a'), /completion write failed/);
completion.locked = false; // models an expired/released database job lease
await runAnnouncementBroadcast(completion, 'worker-b');
assert.equal(completion.sent.length, 1);

assert.equal(classifyProviderResult({ status: 409, body: { name: 'concurrent_idempotent_requests' } }).outcome, 'retryable');
assert.equal(classifyProviderResult({ status: 409, body: { name: 'invalid_idempotent_request' } }).outcome, 'needs_review');
assert.equal(classifyProviderResult({ status: 400 }).outcome, 'permanent_failed');

console.log('Announcement broadcast mocked-worker tests passed (concurrency, partial retry, uncertainty, consent, completion failure).');
