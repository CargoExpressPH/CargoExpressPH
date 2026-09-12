import assert from 'node:assert/strict';
import {
  PAYMONGO_REFUNDS_URL,
  postPayMongoRefund,
} from '../supabase/functions/paymongo-refund/provider.js';

const successBody = {
  data: {
    id: 'ref_safe_retry_test',
    attributes: {
      amount: 12550,
      payment_id: 'pay_safe_retry_test',
      reason: 'requested_by_customer',
      notes: 'Same logical refund',
      status: 'succeeded',
    },
  },
};

const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const invoke = async fetchImpl => postPayMongoRefund({
  authorization: 'Basic test-auth',
  idempotencyKey: '20000000-0000-4000-8000-000000000099',
  paymentId: 'pay_safe_retry_test',
  amount: 125.50,
  reason: 'requested_by_customer',
  notes: 'Same logical refund',
  fetchImpl,
  sleep: async () => {},
  signalFactory: () => undefined,
});

const assertStableRequests = calls => {
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, PAYMONGO_REFUNDS_URL);
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers['Idempotency-Key'], '20000000-0000-4000-8000-000000000099');
    assert.equal(call.options.headers.Authorization, 'Basic test-auth');
  }
  assert.equal(calls[0].options.body, calls[1].options.body);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    data: {
      attributes: {
        amount: 12550,
        payment_id: 'pay_safe_retry_test',
        reason: 'requested_by_customer',
        notes: 'Same logical refund',
      },
    },
  });
};

{
  const calls = [];
  const result = await invoke(async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) throw new Error('simulated timeout');
    return response(200, successBody);
  });
  assertStableRequests(calls);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(result.providerBody.data.id, 'ref_safe_retry_test');
}

for (const firstFailure of [
  response(503, { errors: [{ code: 'service_unavailable', detail: 'Try again' }] }),
  response(409, { errors: [{ code: 'idempotency_in_progress', detail: 'Request is in progress' }] }),
]) {
  const calls = [];
  const result = await invoke(async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? firstFailure : response(200, successBody);
  });
  assertStableRequests(calls);
  assert.equal(result.outcomeUnknown, false);
}

{
  const calls = [];
  const result = await invoke(async (url, options) => {
    calls.push({ url, options });
    return response(422, { errors: [{ code: 'payment_not_refundable', detail: 'Payment is not refundable' }] });
  });
  assert.equal(calls.length, 1);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(result.response.status, 422);
}

{
  const calls = [];
  const result = await invoke(async (url, options) => {
    calls.push({ url, options });
    throw new Error('simulated repeated timeout');
  });
  assertStableRequests(calls);
  assert.equal(result.outcomeUnknown, true);
  assert.equal(result.response, null);
}

console.log('PayMongo refund request idempotency tests passed.');
