/**
 * A provider-level "paid" status can arrive before the payment attempt and
 * order ledger have been updated. UI success is safe only after the backend
 * explicitly confirms reconciliation.
 */
export const isPaymentPollReconciled = (result) => result?.orderReconciled === true;
