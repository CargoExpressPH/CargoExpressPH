import assert from 'node:assert/strict';
import { createServer } from 'vite';

// Vite resolves the extensionless imports used by the browser build. This
// keeps the contract test provider-free while exercising the same module that
// the application loads.
const vite = await createServer({ logLevel: 'silent', server: { middlewareMode: true } });
const {
  createConversationContext,
  getBotReplyForAction,
  getMainMenuActions,
  getBotReply,
  getSupportKnowledgeCatalog,
  SUPPORT_ACTIONS,
  summarizePaymentActivity,
} = await vite.ssrLoadModule('/src/lib/supportChatEngine.js');
const { supabase } = await vite.ssrLoadModule('/src/lib/supabase.js');

const userId = '00000000-0000-0000-0000-000000000042';

const reply = async (message, context) => getBotReply(message, userId, context);

const context = createConversationContext(userId, '00000000-0000-0000-0000-000000000099');

let result = await reply('help', context);
assert.equal(result.escalate, false);
assert.equal(result.askResolved, false);
assert.match(result.text, /1\. Booking/);
assert.equal(context.pendingClarification.type, 'topic_selection');

result = await reply('2', context);
assert.equal(result.escalate, false);
assert.match(result.text, /Ways to pay/);
assert.equal(context.currentTopic, 'payment');

result = await reply('back', context);
assert.equal(result.escalate, false);
assert.match(result.text, /1\. Booking/);

result = await reply('what is the refund policy?', context);
assert.equal(result.escalate, false, 'policy questions must not be treated as case escalation');
assert.match(result.text, /does not automatically mean that money is returned/i);
assert.equal(result.askResolved, true);

result = await reply('what are the refund rules for my booking?', context);
assert.equal(result.escalate, false);
assert.match(result.text, /does not automatically mean/i);

result = await reply('yes', context);
assert.equal(result.escalate, false);
assert.match(result.text, /another question/i);

result = await reply('my GCash payment is not reflected', context);
assert.equal(result.escalate, true);

result = await reply('is bubble wrap needed for a fragile item?', context);
assert.equal(result.escalate, false, 'packaging advice must remain an FAQ');
assert.match(result.text, /packed securely|bubble-wrapped|measured during pickup/i);

result = await reply('my package arrived damaged', context);
assert.equal(result.escalate, true);

result = await reply('are you a human?', context);
assert.equal(result.escalate, false);
assert.match(result.text, /CargoMate PH/i);

result = await reply('not damaged, I only need packing advice', context);
assert.equal(result.escalate, false, 'negated complaints must not force a handoff');
assert.match(result.text, /packed securely|bubble-wrapped/i);

result = await reply('how to book a shipment', context);
assert.equal(result.escalate, false);
assert.match(result.text, /Book Shipment page/);

result = await reply('zzzzzz', context);
assert.equal(result.askResolved, false);
result = await reply('still zzzzz', context);
assert.match(result.text, /Talk to an Admin/);

const summary = summarizePaymentActivity(
  [{ payment_status: 'paid' }, { payment_status: 'partial' }, { payment_status: 'failed' }],
  [
    { status: 'succeeded', amount: 100 },
    { status: 'processing', amount: 50 },
    { status: 'failed', amount: 20 },
  ],
);
assert.deepEqual(summary, {
  paymentCount: 2,
  refundCount: 1,
  successfulRefundAmount: 100,
  pendingRefundCount: 1,
  pendingRefundAmount: 50,
  failedRefundCount: 1,
});

const catalog = getSupportKnowledgeCatalog();
assert.ok(catalog.some(entry => entry.id === 'payment_info' && entry.source.includes('settlement')));
assert.ok(catalog.some(entry => entry.id === 'human_handoff'));
assert.ok(catalog.every(entry => entry.examples.length > 0 && entry.source));

// Provider-free account-flow fixture: it exercises the same explicit
// user-scoped query shapes without reading or writing real data.
const fakeOrders = [
  { id: 'order-one', user_id: userId, tracking_number: 'CE-20260920-0001', status: 'Delivered', origin: 'Bohol', destination: 'Manila', shipping_cost: 2000, discount_amount: 100, amount_paid: 1000, remaining_balance: 900, payment_status: 'partial', payment_method: 'gcash', payer_type: 'sender', actual_weight: 20, created_at: '2026-09-20T10:00:00Z', trips: null },
  { id: 'order-two', user_id: userId, tracking_number: 'CE-20260919-0002', status: 'Cancelled', origin: 'Manila', destination: 'Bohol', shipping_cost: 1500, discount_amount: 0, amount_paid: 500, remaining_balance: 1000, payment_status: 'partial', payment_method: 'cash', payer_type: 'sender', actual_weight: 15, created_at: '2026-09-19T10:00:00Z', trips: null },
];
let orderQueryError = null;

const makeOrderQuery = () => {
  const filters = {};
  const query = {
    select: () => query,
    eq: (field, value) => { filters[field] = value; return query; },
    neq: (field, value) => { filters[`not:${field}`] = value; return query; },
    order: () => query,
    limit: () => query,
    range: (from, to) => { query._range = [from, to]; return query; },
    then: (resolve, reject) => {
      try {
        let rows = fakeOrders.filter(row => Object.entries(filters).every(([field, value]) =>
          field.startsWith('not:') ? row[field.slice(4)] !== value : row[field] === value
        ));
        if (query._range) rows = rows.slice(query._range[0], query._range[1] + 1);
        resolve({ data: rows, error: orderQueryError, count: rows.length });
      } catch (error) { reject(error); }
    },
    maybeSingle: async () => {
      const row = fakeOrders.find(candidate =>
        candidate.user_id === filters.user_id &&
        (candidate.id === filters.id || candidate.tracking_number === filters.tracking_number)
      );
      return { data: row || null, error: null };
    },
  };
  return query;
};

const originalFrom = supabase.from;
const originalRpc = supabase.rpc;
supabase.from = table => table === 'orders' ? makeOrderQuery() : originalFrom.call(supabase, table);
supabase.rpc = name => Promise.resolve({
  data: name === 'get_payment_transaction_history' ? [{ payment_status: 'paid', amount: 1000 }] : [],
  error: null,
});

try {
  const accountContext = createConversationContext(userId, 'conversation-account-fixture');
  result = await reply('check my bookings', accountContext);
  assert.match(result.text, /I found 2 bookings/);
  assert.match(result.text, /Cancelled bookings are shown as cancelled/);
  assert.equal(accountContext.pendingClarification.type, 'booking_selection');

  result = await reply('second', accountContext);
  assert.match(result.text, /CE-20260919-0002/);
  assert.equal(accountContext.selectedBookingId, 'order-two');

  result = await reply('what is my balance?', accountContext);
  assert.equal(result.escalate, false);
  assert.match(result.text, /not an active balance to collect/i);
  assert.doesNotMatch(result.text, /fully paid/i);

  const trackingPaymentContext = createConversationContext(userId, 'conversation-tracking-payment');
  result = await reply('show payment for CE-20260920-0001', trackingPaymentContext);
  assert.equal(result.escalate, false);
  assert.match(result.text, /Final shipping fee/);
  assert.match(result.text, /Balance/);

  const menuContext = createConversationContext(userId, 'conversation-menu-fixture');
  result = await getBotReplyForAction(SUPPORT_ACTIONS.MAIN_MENU, userId, menuContext);
  assert.deepEqual(result.actions.map(action => action.id), getMainMenuActions().map(action => action.id));
  assert.match(result.text, /Choose a topic below/);

  result = await getBotReplyForAction(SUPPORT_ACTIONS.MY_BOOKINGS, userId, menuContext);
  assert.match(result.text, /Choose a booking/);
  assert.ok(result.actions.some(action => action.id === `${SUPPORT_ACTIONS.SELECT_BOOKING}:order-one`));
  assert.equal(menuContext.pendingClarification.type, 'booking_picker');

  result = await getBotReplyForAction(`${SUPPORT_ACTIONS.SELECT_BOOKING}:order-one`, userId, menuContext);
  assert.equal(menuContext.selectedBookingId, 'order-one');
  assert.ok(result.actions.some(action => action.id === SUPPORT_ACTIONS.OPEN_BOOKING));

  result = await getBotReplyForAction(SUPPORT_ACTIONS.BOOKING_STATUS, userId, menuContext);
  assert.match(result.text, /CE-20260920-0001/);
  assert.match(result.text, /Delivered/);

  result = await getBotReplyForAction(SUPPORT_ACTIONS.PAYMENT_DETAILS, userId, menuContext);
  assert.match(result.text, /Final shipping fee/);
  assert.ok(result.actions.some(action => action.id === SUPPORT_ACTIONS.CHOOSE_ANOTHER_BOOKING));

  result = await getBotReplyForAction(SUPPORT_ACTIONS.OPEN_BOOKING, userId, menuContext);
  assert.equal(result.navigateTo, '/customer/orders/order-one');

  result = await getBotReplyForAction(SUPPORT_ACTIONS.BACK, userId, menuContext);
  assert.match(result.text, /Choose a topic below/);
  assert.equal(menuContext.selectedBookingId, null);

  result = await getBotReplyForAction(SUPPORT_ACTIONS.TALK_TO_ADMIN, userId, menuContext);
  assert.equal(result.escalate, true);

  const savedOrders = fakeOrders.splice(0, fakeOrders.length);
  const emptyContext = createConversationContext(userId, 'conversation-empty-fixture');
  result = await getBotReplyForAction(SUPPORT_ACTIONS.MY_BOOKINGS, userId, emptyContext);
  assert.match(result.text, /don't have any bookings/i);
  assert.ok(result.actions.some(action => action.id === SUPPORT_ACTIONS.BOOK_NEW));
  fakeOrders.push(...savedOrders);

  orderQueryError = new Error('fixture query failure');
  const failedContext = createConversationContext(userId, 'conversation-failed-fixture');
  result = await getBotReplyForAction(SUPPORT_ACTIONS.MY_BOOKINGS, userId, failedContext);
  assert.equal(result.unavailable, true);
  assert.match(result.text, /couldn’t load this information/i);
  assert.equal(result.actions[0].id, SUPPORT_ACTIONS.RETRY);
  orderQueryError = null;
} finally {
  supabase.from = originalFrom;
  supabase.rpc = originalRpc;
}

console.log('support chat engine contract tests passed');
await vite.close();
