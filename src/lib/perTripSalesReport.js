import {
  ORDER_STATUS,
  finalShippingFee,
  isOrderPriced,
  outstandingBalance,
} from '../constants/status';

const REFUND_PENDING_STATUSES = new Set(['creating', 'pending', 'processing']);

const toCents = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
};

const fromCents = (value) => value / 100;

const addCents = (left, right) => left + right;

const amountFromActivity = (activity) => {
  if (activity?.amount !== undefined && activity?.amount !== null) {
    return Math.abs(toCents(activity.amount));
  }
  return Math.abs(toCents(activity?.financial_amount));
};

/**
 * The database helper returns the canonical merged payment activity rows:
 * successful payments have positive financial_amount, successful refunds have
 * negative financial_amount, and failed/pending attempts have zero financial
 * impact. Keeping this reduction here makes the report immune to duplicate
 * joins and keeps pending/failed refunds out of money-returned totals.
 */
export const summarizeTripPaymentActivity = (activity = []) => {
  let paymentsReceived = 0;
  let moneyReturned = 0;
  let refundPending = 0;
  let refundFailed = 0;
  let refundUncertain = 0;

  for (const row of activity || []) {
    const financial = toCents(row?.financial_amount);
    if (row?.is_refund) {
      const status = row.refund_status || row.payment_status;
      const amount = amountFromActivity(row);

      if (status === 'succeeded' || status === 'refunded' || financial < 0) {
        moneyReturned = addCents(moneyReturned, amount);
      } else if (status === 'uncertain' || row?.outcome_uncertain) {
        refundUncertain = addCents(refundUncertain, amount);
      } else if (REFUND_PENDING_STATUSES.has(status)) {
        refundPending = addCents(refundPending, amount);
      } else if (status === 'failed') {
        refundFailed = addCents(refundFailed, amount);
      }
      continue;
    }

    if (!row?.is_payment_attempt && financial > 0) {
      paymentsReceived = addCents(paymentsReceived, financial);
    }
  }

  return {
    paymentsReceived: fromCents(paymentsReceived),
    moneyReturned: fromCents(moneyReturned),
    paymentsAfterRefunds: fromCents(paymentsReceived - moneyReturned),
    refundPending: fromCents(refundPending),
    refundFailed: fromCents(refundFailed),
    refundUncertain: fromCents(refundUncertain),
  };
};

const cancellationLabel = (summary) => {
  if (!summary || summary.invariants_valid === false) return 'Needs review';
  switch (summary.settlement_status) {
    case 'refund_due':
      return 'Refund due';
    case 'refund_pending':
      return 'Refund processing';
    case 'refund_settled':
      return 'Settled';
    default:
      return 'Needs review';
  }
};

const cancellationDecision = (order, summary, financials) => {
  const confirmed = Boolean(summary?.has_confirmed_decision);
  const settlementStatus = cancellationLabel(summary);
  const invalid = summary?.invariants_valid === false;
  const retainedFee = confirmed && !invalid && summary.agreed_cancellation_fee !== null
    && summary.agreed_cancellation_fee !== undefined
    ? Number(summary.agreed_cancellation_fee)
    : null;
  const amountStillToRefund = confirmed && !invalid
    && summary.refund_still_due !== null
    && summary.refund_still_due !== undefined
    ? Number(summary.refund_still_due)
    : null;
  const netRetained = Number.isFinite(Number(summary?.net_retained))
    ? Number(summary.net_retained)
    : financials.paymentsAfterRefunds;

  return {
    order,
    settlementStatus,
    confirmedCancellation: confirmed,
    retainedFee,
    amountStillToRefund,
    netRetained,
    refundPending: financials.refundPending,
    refundFailed: financials.refundFailed,
    refundUncertain: financials.refundUncertain,
    needsReview: settlementStatus === 'Needs review',
    dataInconsistent: invalid,
  };
};

const activePaymentStatus = (order, financials, amountStillToPay, priced) => {
  if (!priced) return 'Not priced yet';
  if (amountStillToPay <= 0) return 'Paid in full';
  if (financials.paymentsReceived > 0 || Number(order?.amount_paid || 0) > 0) {
    return 'Partly paid';
  }
  return 'Unpaid';
};

const buildRow = (order, activity, settlementSummary) => {
  const financials = summarizeTripPaymentActivity(activity);
  const cancelled = order.status === ORDER_STATUS.CANCELLED;
  const priced = isOrderPriced(order);

  if (cancelled) {
    return {
      id: order.id,
      order,
      trackingNumber: order.tracking_number,
      customerName: order.profiles?.name || order.sender_name || 'Customer not named',
      status: order.status,
      ...financials,
      cancellation: cancellationDecision(order, settlementSummary, financials),
      isPriced: priced,
    };
  }

  const shippingFee = priced ? finalShippingFee(order) : null;
  const amountStillToPay = priced ? outstandingBalance(order) : null;
  return {
    id: order.id,
    order,
    trackingNumber: order.tracking_number,
    customerName: order.profiles?.name || order.sender_name || 'Customer not named',
    status: order.status,
    ...financials,
    shippingFee,
    amountStillToPay,
    paymentStatus: activePaymentStatus(order, financials, amountStillToPay || 0, priced),
    isPriced: priced,
    isCompleted: order.status === ORDER_STATUS.DELIVERED,
  };
};

const sumRows = (rows, field) => rows.reduce((total, row) => addCents(total, toCents(row[field])), 0);

/**
 * Pure report calculation used by both the UI and the fixture contract test.
 * `orders` are the rows assigned to the selected trip; no calendar-date filter
 * belongs here because the report basis is the booking's trip assignment.
 */
export const buildPerTripSalesReport = ({
  trip,
  orders = [],
  activityByOrder = {},
  settlementsByOrder = {},
}) => {
  const rows = orders.map(order => buildRow(
    order,
    activityByOrder[order.id] || [],
    settlementsByOrder[order.id],
  ));
  const activeRows = rows.filter(row => row.status !== ORDER_STATUS.CANCELLED);
  const cancelledRows = rows.filter(row => row.status === ORDER_STATUS.CANCELLED);
  const reviewRows = cancelledRows.filter(row => row.cancellation.needsReview);
  const dataInconsistent = rows.some(row => row.cancellation?.dataInconsistent);

  const paymentsReceivedCents = sumRows(rows, 'paymentsReceived');
  const moneyReturnedCents = sumRows(rows, 'moneyReturned');
  const cancelledAwaitingDecisionCents = reviewRows.reduce((total, row) => {
    const amount = toCents(row.cancellation.netRetained);
    return amount > 0 ? addCents(total, amount) : total;
  }, 0);

  const shippingFeesCents = activeRows.reduce((total, row) => (
    row.shippingFee === null ? total : addCents(total, toCents(row.shippingFee))
  ), 0);
  const amountStillToCollectCents = activeRows.reduce((total, row) => (
    row.amountStillToPay === null ? total : addCents(total, toCents(row.amountStillToPay))
  ), 0);

  return {
    trip,
    rows,
    activeRows,
    cancelledRows,
    summary: {
      shippingFees: fromCents(shippingFeesCents),
      paymentsReceived: fromCents(paymentsReceivedCents),
      moneyReturned: fromCents(moneyReturnedCents),
      paymentsAfterRefunds: fromCents(paymentsReceivedCents - moneyReturnedCents),
      amountStillToCollect: fromCents(amountStillToCollectCents),
      activeBookingCount: activeRows.length,
      completedBookingCount: activeRows.filter(row => row.isCompleted).length,
      cancelledBookingCount: cancelledRows.length,
      unpricedActiveCount: activeRows.filter(row => !row.isPriced).length,
      cancelledMoneyAwaitingDecision: fromCents(cancelledAwaitingDecisionCents),
      cancelledReviewCount: reviewRows.length,
      pendingRefundAmount: fromCents(sumRows(rows, 'refundPending')),
      failedRefundAmount: fromCents(sumRows(rows, 'refundFailed')),
      uncertainRefundAmount: fromCents(sumRows(rows, 'refundUncertain')),
      dataInconsistent,
    },
    basis: 'Shows recorded payments and refunds for bookings assigned to this trip, regardless of payment date.',
    assignmentNote: 'This report uses each booking’s current trip assignment. Reassigned bookings appear only under their current trip. A cancelled booking with no current assignment cannot be placed here reliably.',
  };
};

export default buildPerTripSalesReport;
