import assert from 'node:assert/strict';
import { createServer } from 'vite';

const vite = await createServer({ logLevel: 'silent', server: { middlewareMode: true } });
const { buildPerTripSalesReport } = await vite.ssrLoadModule('/src/lib/perTripSalesReport.js');

const trip = { id: 'trip-a', trip_number: 'TRIP-TEST-A', origin: 'Manila', destination: 'Cebu' };
const order = (id, status, shippingCost, amountPaid, actualWeight = 1) => ({
  id,
  tracking_number: `TEST-${id}`,
  sender_name: `Customer ${id}`,
  status,
  actual_weight: actualWeight,
  shipping_cost: shippingCost,
  discount_amount: 0,
  amount_paid: amountPaid,
  profiles: { name: `Customer ${id}` },
});

const payment = (id, amount) => ({
  id: `payment-${id}-${amount}`,
  amount,
  financial_amount: amount,
  is_refund: false,
});

const refund = (id, amount, status = 'succeeded') => ({
  id: `refund-${id}-${amount}-${status}`,
  amount,
  financial_amount: status === 'succeeded' ? -amount : 0,
  is_refund: true,
  refund_status: status,
});

const activePartial = order('A', 'Delivered', 65000, 20000);
const activePaid = order('B', 'Delivered', 10000, 10000);
const cancelledReview = order('C', 'Cancelled', 30000, 30000);
const cancelledSettled = order('D', 'Cancelled', 30000, 30000);

const baseActivity = {
  A: [payment('A', 20000)],
  B: [payment('B', 10000)],
  C: [payment('C', 30000), refund('C', 20000)],
  D: [payment('D', 30000), refund('D', 20000)],
};

const baseSettlements = {
  C: {
    settlement_status: 'for_review',
    has_confirmed_decision: false,
    net_retained: 10000,
    invariants_valid: true,
  },
  D: {
    settlement_status: 'refund_settled',
    has_confirmed_decision: true,
    agreed_cancellation_fee: 10000,
    refund_still_due: 0,
    net_retained: 10000,
    invariants_valid: true,
  },
};

const combined = buildPerTripSalesReport({
  trip,
  orders: [activePartial, cancelledReview],
  activityByOrder: { A: baseActivity.A, C: baseActivity.C },
  settlementsByOrder: { C: baseSettlements.C },
});

assert.deepEqual(combined.summary, {
  shippingFees: 65000,
  paymentsReceived: 50000,
  moneyReturned: 20000,
  paymentsAfterRefunds: 30000,
  amountStillToCollect: 45000,
  activeBookingCount: 1,
  completedBookingCount: 1,
  cancelledBookingCount: 1,
  unpricedActiveCount: 0,
  cancelledMoneyAwaitingDecision: 10000,
  cancelledReviewCount: 1,
  pendingRefundAmount: 0,
  failedRefundAmount: 0,
  uncertainRefundAmount: 0,
  dataInconsistent: false,
});
assert.equal(combined.cancelledRows[0].cancellation.settlementStatus, 'Needs review');
assert.equal(combined.cancelledRows[0].cancellation.retainedFee, null);
assert.equal(combined.cancelledRows[0].cancellation.amountStillToRefund, null);

const settled = buildPerTripSalesReport({
  trip,
  orders: [activePaid, cancelledSettled],
  activityByOrder: { B: baseActivity.B, D: baseActivity.D },
  settlementsByOrder: { D: baseSettlements.D },
});
assert.equal(settled.summary.shippingFees, 10000, 'cancelled fees must not inflate active shipping fees');
assert.equal(settled.summary.amountStillToCollect, 0);
assert.equal(settled.cancelledRows[0].cancellation.retainedFee, 10000);
assert.equal(settled.cancelledRows[0].cancellation.amountStillToRefund, 0);
assert.equal(settled.cancelledRows[0].cancellation.settlementStatus, 'Settled');

const unpriced = order('U', 'Pending', 0, 0, 0);
const refundStates = buildPerTripSalesReport({
  trip,
  orders: [unpriced],
  activityByOrder: {
    U: [payment('U', 500), refund('U', 200, 'processing'), refund('U', 100, 'failed'), refund('U', 50, 'uncertain')],
  },
});
assert.equal(refundStates.activeRows[0].shippingFee, null);
assert.equal(refundStates.activeRows[0].amountStillToPay, null);
assert.equal(refundStates.summary.unpricedActiveCount, 1);
assert.equal(refundStates.summary.paymentsReceived, 500);
assert.equal(refundStates.summary.moneyReturned, 0);
assert.equal(refundStates.summary.pendingRefundAmount, 200);
assert.equal(refundStates.summary.failedRefundAmount, 100);
assert.equal(refundStates.summary.uncertainRefundAmount, 50);

const reassigned = buildPerTripSalesReport({
  trip,
  orders: [activePartial],
  activityByOrder: { A: [payment('A-1', 10000), payment('A-2', 10000)] },
});
assert.equal(reassigned.summary.paymentsReceived, 20000, 'multiple payments must be summed once each');
assert.equal(reassigned.rows.length, 1, 'a booking supplied by its current assignment appears once');

await vite.close();
console.log('Per Trip sales report contract tests passed.');
