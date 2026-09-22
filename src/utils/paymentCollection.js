/**
 * Payment-collection rules — the pure half of PaymentCollectionPanel.
 *
 * Extracted from the .jsx so it can be imported and EXECUTED by the Node
 * contract tests (scripts/*.mjs cannot import a .jsx file). The component
 * re-exports every name from here, so existing imports from
 * './PaymentCollectionPanel' keep working unchanged.
 *
 * Nothing here touches React, Supabase or the DOM: given a panel state and a
 * config it answers what is being collected, whether it may be submitted,
 * and what to send to the record_*_payment RPCs.
 */
import { parseAmount, formatAmount } from './currencyInput.js';

/**
 * Today, as the date inputs want it.
 *
 * EXPORTED, not module-private: PaymentCollectionPanel's payment-date and
 * promise-date inputs bound their `max`/`min` to it, and when these pure
 * rules were split out of that component the helper came with them, leaving
 * the JSX calling an identifier that no longer existed in its module. A bare
 * undefined identifier is not a build error — Rollup treats it as a global —
 * so it only surfaced as a ReferenceError when one of those inputs actually
 * rendered. One definition, imported by both.
 */
export const today = () => new Date().toISOString().split('T')[0];

/**
 * Create the idempotency UUID before a collection flow opens. Older embedded
 * browsers may expose Web Crypto but not randomUUID(); use getRandomValues to
 * keep the key cryptographically random there too. Never substitute
 * Math.random for a payment idempotency key.
 */
export const createPaymentIdempotencyKey = (cryptoApi = globalThis.crypto) => {
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('Secure payment IDs are not supported by this browser. Update the browser and try again.');
  }

  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * Initial panel state. `amount` is a stored numeric string (no separators) —
 * see utils/currencyInput.
 */
export const createPaymentCollectionState = (overrides = {}) => ({
  payment_type: 'full',          // 'full' | 'paylater'
  amount: '',
  payment_method: '',            // '' | 'cash' | 'gcash'
  payment_reference: '',
  payment_date: today(),
  promised_payment_date: '',
  receiptFile: null,
  receiptPreview: null,
  // Required before a manually-entered ("direct transfer") GCash reference
  // may be submitted — a reference string alone is never proof the transfer
  // was received.
  verified_receipt: false,
  // Generated once, when the parent modal first creates this state (parents
  // call this inside a useState lazy initializer), and resent unchanged on
  // every retry of the SAME collection attempt (double-click, a dropped
  // response after the database already committed). A genuinely new
  // collection gets a new one because it comes from a freshly mounted modal.
  idempotency_key: createPaymentIdempotencyKey(),
  // PayMongo runtime — owned here, read by the parent at submit
  paymentStep: 'setup',          // 'setup' | 'generating' | 'waiting'
  sourceId: null,
  checkoutUrl: null,
  confirmed: null,               // populated once the ledger records the money
  notice: '',
  // Set by a blocked submit so the amount field can be flagged in place
  shortfallBlocked: false,
  ...overrides,
});

/**
 * Everything derived from the panel state plus the amount being billed.
 *
 * `config.expectedAmount` is the full figure this collection is measured
 * against — the freight total at pickup, the remaining balance at delivery.
 */
export const derivePaymentCollection = (value, config) => {
  const expected = Number(config?.expectedAmount) || 0;
  const isPayLater = value.payment_type === 'paylater';

  // A blank amount under Full Payment means "the whole thing" — the placeholder
  // says so. Under Pay Later it means nothing was put down.
  const typed = parseAmount(value.amount);
  const collected = value.amount === ''
    ? (isPayLater ? 0 : expected)
    : (Number.isFinite(typed) ? typed : 0);

  const outstandingAfter = Math.max(0, Math.round((expected - collected) * 100) / 100);

  // The field itself refuses a minus sign, so this only fires on paste or
  // autofill — but it is what blocks submission, so it is checked, not assumed.
  const amountError = value.amount !== '' && !(parseAmount(value.amount) >= 0)
    ? 'Enter a valid amount of ₱0 or more.'
    : null;

  const hasManualReference = Boolean(value.payment_reference && value.payment_reference.trim());
  // PayMongo already wrote the ledger row: the amount field is not what was
  // charged, and must not be validated or re-sent as if it were.
  const settledByPayMongo = value.payment_method === 'gcash' && Boolean(value.confirmed);

  // A live checkout is an OPEN question — the customer may still be paying, may
  // abandon, or may already have paid without us having heard. Releasing cargo
  // inside that window is the race this closes.
  const gcashUnresolved =
    value.payment_method === 'gcash' && collected > 0 && !value.confirmed && !hasManualReference;

  // "Full Payment" is a claim about the money, not a label. Checked at submit
  // rather than per keystroke: every prefix of a full amount ("8", "86", "860"
  // against ₱8,600) is a shortfall, so a live check would hold the field red
  // through the entire entry it exists to accept.
  const fullPaymentShortfall =
    !isPayLater && !settledByPayMongo && expected > 0 && collected + 0.01 < expected;

  // Cargo may move with money owing, but only against a recorded date. Full
  // Payment cannot leave a balance (the shortfall block rejects it), so this is
  // the other half of the same invariant: there is no path to an outstanding
  // amount without a promise attached.
  const needsPromiseDate = isPayLater && outstandingAfter > 0;

  // Nothing is being taken, so there is no method to name.
  const requiresMethod = collected > 0 || settledByPayMongo;

  // More money than the figure this collection is measured against. Always
  // computed, because the admin is always told — what differs by flow is
  // whether the panel can also REFUSE it:
  //
  //   delivery (capAtExpected: true)  — `expected` is remaining_balance,
  //     read from the database after the order was weighed and discounted.
  //     It is authoritative, so an excess is blocked here as well as in
  //     record_delivery_payment().
  //
  //   pickup (capAtExpected: false)   — `expected` is weight x a
  //     price-per-kilo PREVIEW. The real fee is computed by
  //     guard_order_update() from the trip's own effective rate when the
  //     weight lands, so this number can legitimately be a little low.
  //     Blocking on it would reject valid collections, so the panel only
  //     WARNS; record_pickup_payment() (20260922150000) does the refusing,
  //     against the post-weighing, post-discount, refund-aware amount that
  //     only the database can know.
  const exceedsExpected = expected > 0 && collected > expected + 0.01;
  const excessAmount = exceedsExpected
    ? Math.round((collected - expected) * 100) / 100
    : 0;
  // Only the authoritative flow may turn the warning into a rejection.
  const blocksOnExcess = Boolean(config?.capAtExpected) && exceedsExpected;

  return {
    expected, isPayLater, collected, outstandingAfter, amountError,
    hasManualReference, settledByPayMongo, gcashUnresolved,
    fullPaymentShortfall, needsPromiseDate, requiresMethod,
    exceedsExpected, excessAmount, blocksOnExcess,
  };
};

/**
 * The one wording for "you have entered more than is owed", used by the live
 * warning and by the blocking error so they cannot drift apart.
 *
 * It says plainly that the excess is NOT a tip, because this system has no
 * tip or excess-collection model: every row in payment_transactions is
 * shipping money, counted as shipping revenue in the sales reports and
 * refundable as shipping money. Money accepted here as an "extra" would
 * therefore be recorded as something it is not.
 */
export const overpaymentMessage = (excess, { authoritative = true } = {}) =>
  `The entered amount exceeds the amount still payable by ₱${formatAmount(Number(excess).toFixed(2))}. `
  + 'Please check the amount. Extra money is not automatically recorded as a tip.'
  + (authoritative
    ? ''
    : ' This booking has not been weighed yet, so this figure is an estimate — the final amount is'
      + ' computed when the weight is saved, and a collection above it will be refused then.');

/**
 * Field names this panel owns. Parents merge the failing one into their own
 * field-error map and pass the map back down as `errors`, so a rejected
 * collection marks the control that caused it rather than only printing a
 * sentence at the top of the modal.
 */
export const PAYMENT_FIELDS = {
  amount: 'payment_amount',
  method: 'payment_method',
  date: 'payment_date',
  promise: 'promised_payment_date',
};

/**
 * The single set of rules for whether a collection may be submitted.
 * Returns `{ error, field, flagShortfall }` — null error means it may.
 *
 * `field` names the control at fault. It is part of the contract rather than
 * something the parent infers from the message text, because the message is
 * prose that gets reworded and a substring match against prose is a bug
 * waiting for a copy edit.
 */
export const validatePaymentCollection = (value, config) => {
  const d = derivePaymentCollection(value, config);
  const noun = config?.expectedNoun || 'total';
  const F = PAYMENT_FIELDS;

  if (d.amountError) return { error: d.amountError, field: F.amount, flagShortfall: false };

  // Blocks only where `expected` is the database's own figure (delivery).
  // Pickup shows the same sentence as a live warning instead — see
  // derivePaymentCollection's note — and is stopped server-side.
  if (d.blocksOnExcess) {
    return {
      error: overpaymentMessage(d.excessAmount),
      field: F.amount,
      flagShortfall: false,
    };
  }

  if (d.requiresMethod && !value.payment_method) {
    return { error: 'Please select a payment method', field: F.method, flagShortfall: false };
  }

  if (value.payment_method === 'gcash' && d.requiresMethod) {
    if (value.paymentStep === 'generating') {
      return {
        error: 'Wait for the GCash checkout link to finish generating.',
        field: F.method,
        flagShortfall: false,
      };
    }
    // Same gate as the disabled confirm button, restated because a disabled
    // button is a hint, not an enforcement point.
    if (d.gcashUnresolved) {
      return {
        error: value.paymentStep === 'waiting'
          ? 'This GCash payment has not been confirmed yet. Wait for it to go through, or cancel the checkout and record the payment another way.'
          : 'Please generate a GCash QR or enter a manual reference number.',
        field: F.method,
        flagShortfall: false,
      };
    }
    if (d.hasManualReference && !value.payment_date) {
      return {
        error: 'Please set the payment date for manual reference',
        field: F.date,
        flagShortfall: false,
      };
    }
    if (d.hasManualReference && !value.verified_receipt) {
      return {
        error: 'Confirm that you have verified receipt of this GCash transfer before recording it.',
        field: F.method,
        flagShortfall: false,
      };
    }
  }

  if (d.fullPaymentShortfall) {
    return {
      error: `Amount entered is less than the ₱${formatAmount(d.expected.toFixed(2))} ${noun}. `
        + 'Enter the exact full amount, or switch Payment Type to Pay Later to record a part-payment.',
      field: F.amount,
      flagShortfall: true,
    };
  }

  if (d.needsPromiseDate && !value.promised_payment_date) {
    return {
      error: `₱${formatAmount(d.outstandingAfter.toFixed(2))} will still be owing. `
        + 'Record a Promise Date before releasing the cargo.',
      field: F.promise,
      flagShortfall: false,
    };
  }

  return { error: null, field: null, flagShortfall: false };
};

/**
 * Turns panel state into the order fields the record_*_payment RPCs accept.
 *
 * `amount_paid`, `remaining_balance` and `payment_status` are absent on
 * purpose — the payment_transactions ledger owns them and the trigger derives
 * them. Never write them from here.
 */
export const buildPaymentSubmission = (value, config, receiptUrl = null) => {
  const d = derivePaymentCollection(value, config);
  const isGCash = value.payment_method === 'gcash';

  const submission = {
    // Even if nothing is collected now, record the chosen method as their intent for later
    payment_method: value.payment_method || null,
    payment_reference: isGCash ? (value.payment_reference || null) : null,
    promised_payment_date: d.needsPromiseDate ? (value.promised_payment_date || null) : null,
    payment: null,
    idempotency_key: value.idempotency_key || null,
    admin_verified_receipt: isGCash ? Boolean(value.verified_receipt) : false,
  };

  // PayMongo settled it: the webhook already inserted the ledger row via the
  // reconcile RPC. Sending a payment here would double-count it — as it once
  // did, overwriting a payment the customer completed while the QR was up.
  if (d.settledByPayMongo) return submission;

  // A QR is live but unconfirmed. The parent's gate should have stopped this,
  // but if a manual reference carried it through, still send no payment row —
  // the webhook owns that money.
  if (isGCash && value.paymentStep === 'waiting' && !d.hasManualReference) return submission;

  if (d.collected > 0) {
    submission.payment = {
      amount: d.collected,
      payment_date: isGCash ? (value.payment_date || null) : null,
      receipt_url: isGCash ? receiptUrl : null,
    };
  }
  return submission;
};
