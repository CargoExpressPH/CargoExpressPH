/**
 * Payment Display Utilities
 * 
 * Shared helpers for formatting payment transaction data consistently
 * across customer and admin views. Ensures internal/technical details
 * (PayMongo IDs, webhook labels) are humanised for display.
 */

/**
 * Returns a clean, human-friendly payment type label.
 * @param {string} type - Raw payment_type from the database.
 * @param {'customer'|'admin'} [audience='customer']
 * @returns {string}
 */
export const formatPaymentType = (type, audience = 'customer') => {
  if (!type) return 'Payment';
  const map = {
    'Initial Payment': audience === 'customer' ? 'Initial' : 'Initial Payment',
    'Additional Payment': audience === 'customer' ? 'Additional' : 'Additional Payment',
    'Balance Settlement': audience === 'customer' ? 'Settlement' : 'Balance Settlement',
    'Refund': 'Refund',
    'Payment Attempt': audience === 'customer' ? 'Failed payment' : 'Payment Attempt',
  };
  return map[type] || type;
};

/**
 * Humanise the admin_name / recorded-by field.
 * "System Webhook" -> customer-friendly system attribution; real names pass through.
 * @param {string} adminName
 * @param {'customer'|'admin'} [audience='customer']
 * @returns {string}
 */
export const formatRecordedBy = (adminName, audience = 'customer') => {
  if (!adminName) return audience === 'customer' ? 'System' : 'Unknown';
  if (adminName === 'System Webhook' || adminName === 'System') {
    return audience === 'customer' ? 'Payment System (GCash verified)' : 'Auto (GCash)';
  }
  return adminName;
};

/**
 * Truncate a long PayMongo transaction reference for display.
 * `pay_csfXv6s32C2Vnw2gdkNu3F7A` -> `pay_csf...3F7A`
 * @param {string} ref
 * @param {number} [maxLen=16]
 * @returns {string}
 */
export const truncateRef = (ref, maxLen = 16) => {
  if (!ref) return '';
  if (ref.length <= maxLen) return ref;
  const prefix = ref.slice(0, 8);
  const suffix = ref.slice(-4);
  return `${prefix}\u2026${suffix}`;
};

/**
 * Return a customer-visible reference string, or null if the reference is
 * an internal PayMongo ID that means nothing to the customer.
 *
 * PayMongo IDs start with `pay_`, `src_`, `link_`, `paym_`, `pi_` etc.
 * Manual GCash refs entered by admin are plain numbers/text the customer
 * can cross-check with their GCash receipt.
 *
 * @param {string|null} ref
 * @returns {string|null}
 */
export const getCustomerVisibleRef = (ref) => {
  if (!ref || !ref.trim()) return null;
  // PayMongo internal ID prefixes
  if (/^(pay_|ref_|src_|link_|paym_|pi_|re_|sub_|cus_|evt_)/i.test(ref)) return null;
  return ref;
};

/**
 * Check whether a payment transaction was system-generated (webhook).
 * @param {{ admin_name?: string, notes?: string }} tx
 * @returns {boolean}
 */
export const isSystemGenerated = (tx) => {
  if (!tx) return false;
  const name = (tx.admin_name || '').toLowerCase();
  return name === 'system webhook' || name === 'system';
};

/**
 * Filter notes for the customer audience.
 * Internal/technical notes are suppressed; genuine admin notes pass through.
 * @param {string} notes
 * @param {string} adminName
 * @returns {string|null}
 */
export const getCustomerFriendlyNotes = (notes, adminName) => {
  if (!notes || !notes.trim()) return null;
  // Suppress internal webhook notes
  const internalPatterns = [
    /captured via paymongo/i,
    /e2e test/i,
    /system webhook/i,
    /reconcil/i,
  ];
  if (internalPatterns.some(p => p.test(notes))) return null;
  return notes;
};

/**
 * Get a clean customer-facing payment status label and tone.
 * @param {string} status - Raw payment_status from DB
 * @returns {{ label: string, tone: string }}
 */
export const getPaymentStatusDisplay = (status) => {
  const s = (status || '').toLowerCase();
  if (s === 'paid') return { label: 'Paid', tone: 'success' };
  if (s === 'partial') return { label: 'Partial', tone: 'warning' };
  if (s === 'failed') return { label: 'Failed', tone: 'error' };
  if (s === 'refunded') return { label: 'Refunded', tone: 'info' };
  if (s === 'pending') return { label: 'Pending', tone: 'warning' };
  if (s === 'processing') return { label: 'Processing', tone: 'warning' };
  if (s === 'creating') return { label: 'Starting', tone: 'warning' };
  return { label: status || 'Unknown', tone: 'default' };
};

/**
 * Refund-specific status copy. A provider request and money returned to a
 * wallet are not the same event, so these labels never use completed/success
 * language before PayMongo's terminal `succeeded` state is recorded.
 *
 * @param {string} status - Raw payment_refunds.status
 * @returns {{ label: string, tone: string, description: string }}
 */
export const getRefundStatusDisplay = (status) => {
  const s = (status || '').toLowerCase();
  if (s === 'creating') {
    return {
      label: 'Refund Preparing',
      tone: 'warning',
      description: 'The refund request is being prepared. No refund has been confirmed yet.',
    };
  }
  if (s === 'pending') {
    return {
      label: 'Refund Pending',
      tone: 'warning',
      description: 'PayMongo received the refund request. It is pending and has not completed yet.',
    };
  }
  if (s === 'processing') {
    return {
      label: 'Refund Processing',
      tone: 'warning',
      description: 'PayMongo is processing the refund. It has not completed yet.',
    };
  }
  if (s === 'succeeded' || s === 'refunded') {
    return {
      label: 'Refund Completed',
      tone: 'success',
      description: 'PayMongo confirmed the refund as succeeded. The amount was deducted from this order’s collected total; posting to the original GCash account may take additional time.',
    };
  }
  if (s === 'failed') {
    return {
      label: 'Refund Failed',
      tone: 'error',
      description: 'PayMongo did not complete the refund. No refund amount was deducted from this order’s collected total.',
    };
  }
  return {
    label: 'Refund Status Unavailable',
    tone: 'default',
    description: 'The refund status is unavailable. CargoExpress does not treat it as completed.',
  };
};

/** Use the exact refund lifecycle for refund rows and ordinary payment status otherwise. */
export const getPaymentActivityStatusDisplay = (transaction) => (
  transaction?.is_refund
    ? getRefundStatusDisplay(transaction.refund_status || transaction.payment_status)
    : getPaymentStatusDisplay(transaction?.payment_status)
);

/**
 * Format payment method for clean display.
 * @param {string} method
 * @returns {string}
 */
export const formatPaymentMethod = (method) => {
  if (!method) return '\u2014';
  const map = {
    gcash: 'GCash',
    cash: 'Cash',
    paylater: 'Pay Later',
    bank_transfer: 'Bank Transfer',
  };
  return map[method.toLowerCase()] || method;
};
