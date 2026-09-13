import assert from 'node:assert/strict';
import {
  PAYMONGO_PAYMENTS_URL,
  PAYMONGO_REFUNDS_LIST_URL,
  PAYMONGO_REFUNDS_URL,
  listPayMongoRefunds,
  postPayMongoRefund,
  retrievePayMongoPaymentMode,
} from '../supabase/functions/paymongo-refund-recovery/provider.js';

const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

{
  const calls = [];
  const pages = [
    {
      data: [
        { id: 'ref_page_001', attributes: {} },
        { id: 'ref_page_002', attributes: {} },
      ],
    },
    {
      data: [
        { id: 'ref_page_002', attributes: {} },
        { id: 'ref_page_003', attributes: {} },
      ],
    },
    { data: [] },
  ];
  const refunds = await listPayMongoRefunds({
    authorization: 'Basic test-auth',
    paymentId: 'pay_recovery_001',
    pageSize: 2,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return response(200, pages[calls.length - 1]);
    },
    signalFactory: () => undefined,
  });

  assert.deepEqual(refunds.map(item => item.id), [
    'ref_page_001',
    'ref_page_002',
    'ref_page_003',
  ]);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    const url = new URL(call.url);
    assert.equal(`${url.origin}${url.pathname}`, PAYMONGO_REFUNDS_LIST_URL);
    assert.equal(url.searchParams.get('payment_id'), 'pay_recovery_001');
    assert.equal(url.searchParams.get('limit'), '2');
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.headers.Authorization, 'Basic test-auth');
  }
  assert.equal(new URL(calls[0].url).searchParams.has('after'), false);
  assert.equal(new URL(calls[1].url).searchParams.get('after'), 'ref_page_002');
  assert.equal(new URL(calls[2].url).searchParams.get('after'), 'ref_page_003');
}

{
  const mode = await retrievePayMongoPaymentMode({
    authorization: 'Basic test-auth',
    paymentId: 'pay_recovery_mode',
    fetchImpl: async (url, options) => {
      assert.equal(String(url), `${PAYMONGO_PAYMENTS_URL}/pay_recovery_mode`);
      assert.equal(options.headers.Authorization, 'Basic test-auth');
      return response(200, {
        data: {
          id: 'pay_recovery_mode',
          attributes: { livemode: false },
        },
      });
    },
    signalFactory: () => undefined,
  });
  assert.equal(mode, false);
}

{
  const calls = [];
  const result = await postPayMongoRefund({
    authorization: 'Basic test-auth',
    idempotencyKey: '20000000-0000-4000-8000-000000000123',
    paymentId: 'pay_recovery_retry',
    amount: 125.50,
    reason: 'requested_by_customer',
    notes: 'Protected recovery retry',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) throw new Error('simulated timeout');
      return response(200, {
        data: {
          id: 'ref_recovery_retry',
          attributes: {
            amount: 12550,
            payment_id: 'pay_recovery_retry',
            reason: 'requested_by_customer',
            status: 'succeeded',
          },
        },
      });
    },
    sleep: async () => {},
    signalFactory: () => undefined,
  });

  assert.equal(result.outcomeUnknown, false);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, PAYMONGO_REFUNDS_URL);
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers['Idempotency-Key'], '20000000-0000-4000-8000-000000000123');
  }
  assert.equal(calls[0].options.body, calls[1].options.body);
}

{
  await assert.rejects(
    listPayMongoRefunds({
      authorization: 'Basic test-auth',
      paymentId: 'pay_recovery_failure',
      fetchImpl: async () => response(503, { errors: [] }),
      signalFactory: () => undefined,
    }),
    /status 503/,
  );
}

console.log('PayMongo refund recovery provider tests passed.');
