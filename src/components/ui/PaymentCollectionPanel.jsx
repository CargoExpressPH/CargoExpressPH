import { useState, useRef, useEffect } from 'react';
import {
  CreditCard, Calendar, AlertTriangle, CheckCircle, XCircle,
  Loader, RefreshCw, FileText, Trash2, ExternalLink,
} from 'lucide-react';
import QRCode from 'react-qr-code';
import AmountInput from './AmountInput';
import FieldError, { errorId, fieldAttrs, invalidClass } from './FieldError';
import { sanitizeAmount, parseAmount, formatAmount } from '../../utils/currencyInput';
import { createGCashSource, registerSource, pollPaymentStatus } from '../../lib/paymongo';
import { getPaymentAttemptBySource, getOrderPaymentSnapshot } from '../../lib/database';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../hooks/useToast';

/**
 * PaymentCollectionPanel — the one place money is taken from a customer.
 *
 * Pickup collects from the sender against the freight total; delivery collects
 * from the receiver against the remaining balance. Those are the same act
 * against a different number, so they are the same component: Payment Type,
 * amount, method, the GCash/PayMongo flow, the manual-reference fallback, the
 * receipt, and the Promise Date all live here and nowhere else.
 *
 * The panel is CONTROLLED. The parent holds one state object and passes
 * `value` + `setValue` (a `useState` setter — the panel uses updater form).
 * Everything the parent needs at submit time is in that object; everything
 * purely visual is in it too, so there is no second copy to drift.
 *
 * Validation and payload assembly are exported as pure functions next to the
 * UI, so a parent cannot render this panel and then invent its own rules for
 * what the fields mean.
 *
 * What stays with the parent, because it is not about payment:
 *   - PickupModal: weight, payer_type (Freight Collect skips the panel), proofs
 *   - DeliveryModal: proofs
 */

/** Today, as the date inputs want it. */
const today = () => new Date().toISOString().split('T')[0];

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
    value.payment_method === 'gcash' && !value.confirmed && !hasManualReference;

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

  const exceedsExpected = Boolean(config?.capAtExpected) && collected > expected + 0.01;

  return {
    expected, isPayLater, collected, outstandingAfter, amountError,
    hasManualReference, settledByPayMongo, gcashUnresolved,
    fullPaymentShortfall, needsPromiseDate, requiresMethod, exceedsExpected,
  };
};

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

  if (d.exceedsExpected) {
    return {
      error: `Amount collected cannot exceed the ₱${formatAmount(d.expected.toFixed(2))} ${noun}.`,
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
    // Nothing collected and nothing pending → no method happened. Leaving it
    // absent is honest; naming one would record an intention as a fact.
    payment_method: d.requiresMethod ? value.payment_method : null,
    payment_reference: isGCash ? (value.payment_reference || null) : null,
    promised_payment_date: d.needsPromiseDate ? (value.promised_payment_date || null) : null,
    payment: null,
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

const PaymentCollectionPanel = ({
  order,
  value,
  setValue,
  config,
  disabled = false,
  // Field-error map owned by the parent modal, keyed by PAYMENT_FIELDS. The
  // panel only reads it — the parent runs validatePaymentCollection at submit
  // and decides what to do with the result.
  errors = {},
  clearError = () => {},
}) => {
  const toast = useToast();
  // Purely visual and only meaningful while the request is in flight, so it
  // stays local rather than joining the state the parent submits.
  const [checkingPayment, setCheckingPayment] = useState(false);
  const receiptInputRef = useRef(null);
  const pollRef = useRef(null);
  const paymentCheckInFlightRef = useRef(false);
  const paymentConfirmedRef = useRef(false);
  // amount_paid when the QR was generated — anything above it is new money
  const baselinePaidRef = useRef(parseFloat(order?.amount_paid || 0));

  const d = derivePaymentCollection(value, config);
  const expectedText = formatAmount(d.expected.toFixed(2));
  const noun = config?.expectedNoun || 'total';
  const patch = (fields) => setValue(prev => ({ ...prev, ...fields }));

  // ── PayMongo ─────────────────────────────────────────────────────────────

  const handleProceedToGCash = async () => {
    try {
      patch({ paymentStep: 'generating', notice: '' });
      // Charge what is being collected, not always the full figure: under Pay
      // Later those differ, and billing the full amount for a part-payment
      // takes money the customer did not agree to hand over.
      const amount = d.isPayLater ? d.collected : d.expected;
      if (amount <= 0) {
        config.onError?.('Payment amount must be greater than 0.');
        patch({ paymentStep: 'setup' });
        return;
      }
      const source = await createGCashSource(
        amount,
        `CargoExpress PH - ${order.tracking_number} ${config.purpose}`,
        config.billing,
        true,
        order.id,
      );
      await registerSource(source.sourceId, amount, {
        orderId: order.id,
        ...(config.sourceMetadata || {}),
      });
      baselinePaidRef.current = parseFloat(order?.amount_paid || 0);
      paymentConfirmedRef.current = false;
      patch({
        confirmed: null,
        sourceId: source.sourceId,
        checkoutUrl: source.checkoutUrl,
        paymentStep: 'waiting',
      });
    } catch (err) {
      config.onError?.(err.message);
      patch({ paymentStep: 'setup' });
    }
  };

  const resetFlow = (notice = '') => {
    paymentConfirmedRef.current = false;
    patch({ paymentStep: 'setup', sourceId: null, checkoutUrl: null, confirmed: null, notice });
  };

  /**
   * Abandon a pending checkout — the "cancelled" half of the gate.
   *
   * The PayMongo source is deliberately NOT voided: if the customer pays that
   * link ten minutes from now, the webhook still reconciles it against this
   * order and the ledger stays honest. Cancelling only says "we are not going
   * to stand here waiting", and re-opens cash / manual reference.
   */
  const handleCancelGCash = () => resetFlow(
    'GCash checkout cancelled. Collect in cash, or enter the GCash reference number manually. '
    + 'If the customer completes that payment link later, it is still recorded against this order.'
  );

  /** Records a confirmed payment from a fresh `orders` row. */
  const applyConfirmedOrder = (row) => {
    if (paymentConfirmedRef.current) return true;
    const paid = parseFloat(row?.amount_paid || 0);
    if (!(paid > baselinePaidRef.current)) return false;
    paymentConfirmedRef.current = true;
    setValue(prev => ({
      ...prev,
      confirmed: {
        received: paid - baselinePaidRef.current,
        amountPaid: paid,
        remaining: parseFloat(row.remaining_balance || 0),
        status: row.payment_status,
        reference: row.payment_reference || null,
      },
    }));
    return true;
  };

  /**
   * Ask the server to re-query PayMongo and reconcile if the source is paid,
   * then read the authoritative totals back from the order row — the ledger
   * trigger owns them, so that is the truth regardless of what poll returned.
   */
  const checkPaymentNow = async (silent = false) => {
    if (!value.sourceId || !order?.id || paymentCheckInFlightRef.current) return;
    paymentCheckInFlightRef.current = true;
    if (!silent) { setCheckingPayment(true); patch({ notice: '' }); }
    try {
      const pollResult = await pollPaymentStatus(value.sourceId, order.id).catch(() => null);
      const attempt = await getPaymentAttemptBySource(value.sourceId);
      const fresh = await getOrderPaymentSnapshot(order.id);
      const sourceReconciled = pollResult?.orderReconciled
        || pollResult?.status === 'paid'
        || attempt?.status === 'reconciled'
        || attempt?.payment_status === 'paid';
      const found = sourceReconciled && applyConfirmedOrder(fresh);
      if (!found && !silent) {
        config.onError?.('No payment received yet. Ask the customer to complete the GCash payment, then check again.');
      }
    } catch (err) {
      if (!silent) config.onError?.(err.message || 'Could not check payment status.');
    } finally {
      if (!silent) setCheckingPayment(false);
      paymentCheckInFlightRef.current = false;
    }
  };

  /**
   * Live confirmation. `orders` is in the supabase_realtime publication, so the
   * admin's screen updates the moment the webhook reconciles — even though the
   * customer paid on a different device. A 15 s poll backs it up.
   */
  useEffect(() => {
    if (value.paymentStep !== 'waiting' || !order?.id || value.confirmed) return;

    const channel = supabase
      .channel(`payment_panel_${order.id}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'orders',
        filter: `id=eq.${order.id}`,
      }, () => { void checkPaymentNow(true); })
      .subscribe();

    pollRef.current = setInterval(() => checkPaymentNow(true), 15000);

    return () => {
      supabase.removeChannel(channel);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [value.paymentStep, order?.id, value.sourceId, value.confirmed]);

  // Switching away from GCash abandons any flow in progress.
  useEffect(() => {
    if (value.payment_method !== 'gcash'
      && (value.paymentStep !== 'setup' || value.sourceId || value.checkoutUrl)) {
      resetFlow();
    }
  }, [value.payment_method]);

  // ── Receipt ──────────────────────────────────────────────────────────────

  const handleReceiptAdd = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      config.onError?.('Only JPG, PNG, and WebP images allowed for receipts');
      return;
    }
    const reader = new FileReader();
    reader.onload = (evt) => patch({ receiptFile: file, receiptPreview: evt.target.result });
    reader.readAsDataURL(file);
  };

  // ── UI ───────────────────────────────────────────────────────────────────

  const amountLabel = d.isPayLater
    ? (config.amountLabels?.paylater || 'Downpayment (₱) (Optional)')
    : (config.amountLabels?.full || 'Amount Received (₱) *');

  const F = PAYMENT_FIELDS;
  // `shortfallBlocked` predates the shared error map and is still what a
  // blocked submit sets, so both routes to a red amount field are honoured.
  const amountInvalid = Boolean(d.amountError || value.shortfallBlocked || errors[F.amount]);

  return (
    <>
      {value.notice && (
        <div className="br-8" style={{
          background: 'var(--info-bg)', color: 'var(--info-dark)', padding: '10px 14px',
          fontSize: '0.8125rem', marginBottom: 16, border: '1px solid var(--info)',
        }} role="status">
          {value.notice}
        </div>
      )}

      {/* Payment Type */}
      <div className="form-group">
        <label className="form-label">
          <CreditCard size={14} className="inline mr-6" />
          Payment Type *
        </label>
        <div className="pickup-segment-row flex gap-8">
          {['full', 'paylater'].map(t => (
            <button
              key={t} type="button" disabled={disabled}
              className={`btn ${value.payment_type === t ? 'btn-primary' : 'btn-outline'} btn-sm flex-1 justify-center text-capitalize`}
              onClick={() => patch({
                payment_type: t,
                shortfallBlocked: false,
                // Full Payment means the whole figure, so the field says so
                // rather than leaving a part-amount under a label that
                // contradicts it.
                amount: t === 'full' && d.expected > 0 ? sanitizeAmount(d.expected) : value.amount,
              })}
            >
              {t === 'full' ? 'Full Payment' : 'Pay Later'}
            </button>
          ))}
        </div>
      </div>

      {/* Amount */}
      <div className="form-group">
        <label className="form-label" htmlFor="pcp-amount">{amountLabel}</label>
        <div>
          <AmountInput
            id="pcp-amount"
            className={`form-input flex-1 w-full ${amountInvalid ? 'field-invalid' : ''}`}
            placeholder={d.isPayLater ? '0.00' : expectedText}
            value={value.amount}
            disabled={disabled}
            onValueChange={v => {
              patch({ amount: v, shortfallBlocked: false });
              clearError(F.amount);
            }}
            aria-invalid={amountInvalid ? 'true' : undefined}
            aria-describedby={amountInvalid ? errorId(F.amount) : undefined}
          />
        </div>
        <FieldError
          name={F.amount}
          message={amountInvalid
            ? (errors[F.amount] || d.amountError || `Short of the ₱${expectedText} ${noun}.`)
            : null}
        />
        {d.expected > 0 && (
          <div className="text-xs mt-4" style={{ color: d.outstandingAfter > 0 ? 'var(--warning-text)' : 'var(--success-text)' }}>
            {d.outstandingAfter > 0
              ? `₱${formatAmount(d.outstandingAfter.toFixed(2))} will still be owing after this.`
              : 'This settles the order in full.'}
          </div>
        )}
      </div>

      {/* Payment Method — a segmented control, so the red boundary goes round
          the group; there is no single input to outline. */}
      <div className="form-group">
        <label className="form-label" id="pcp-method-label">
          Payment Method {d.requiresMethod ? '*' : '(Optional)'}
        </label>
        <div
          className={`pickup-segment-row flex gap-8 ${errors[F.method] ? 'field-group-invalid' : ''}`}
          role="group"
          aria-labelledby="pcp-method-label"
          aria-invalid={errors[F.method] ? 'true' : undefined}
          aria-describedby={errors[F.method] ? errorId(F.method) : undefined}
          tabIndex={errors[F.method] ? -1 : undefined}
        >
          {['cash', 'gcash'].map(m => (
            <button
              key={m} type="button" disabled={disabled}
              className={`btn ${value.payment_method === m ? 'btn-secondary' : 'btn-outline'} btn-sm flex-1 justify-center text-capitalize`}
              onClick={() => { patch({ payment_method: m }); clearError(F.method); }}
            >
              {m === 'gcash' ? 'GCash' : 'Cash'}
            </button>
          ))}
        </div>
        <FieldError name={F.method} errors={errors} />
      </div>

      {/* GCash */}
      {value.payment_method === 'gcash' && (
        <div className="mb-16 br-8" style={{ background: 'var(--bg-secondary)', padding: 14, border: '1px solid var(--border)'}}>
          <div className="mb-8 font-semibold" style={{ fontSize: '0.8125rem' }}>GCash Payment</div>

          {value.paymentStep === 'setup' && (
            <div className="mb-12">
              <button
                type="button"
                className="btn btn-primary btn-sm w-full justify-center"
                onClick={handleProceedToGCash}
                disabled={disabled || d.collected <= 0}
              >
                <CreditCard size={14} className="mr-6" /> Process via PayMongo
              </button>
              <div className="text-xs text-tertiary mt-4 text-center">
                Opens GCash checkout for the customer to pay
              </div>
            </div>
          )}

          {value.paymentStep === 'generating' && (
            <div className="flex items-center gap-8 mb-12" style={{ padding: '10px 0' }}>
              <Loader size={16} className="animate-spin" style={{ color: 'var(--primary-text)' }} />
              <span className="text-sm">Generating GCash checkout link…</span>
            </div>
          )}

          {/* Confirmed — the ledger has the money */}
          {value.paymentStep === 'waiting' && value.confirmed && (
            <div className="mb-12 br-8" style={{ background: 'var(--success-bg)', padding: 14, border: '1px solid var(--success)'}}>
              <div className="flex items-center gap-8 mb-12">
                <CheckCircle size={20} style={{ color: 'var(--success-text)' }} aria-hidden="true" />
                <span className="text-sm fw-700" style={{ color: 'var(--success-text)' }}>
                  Payment received — ₱{formatAmount(value.confirmed.received.toFixed(2))}
                </span>
              </div>
              <div className="text-xs" style={{ color: 'var(--success-text)', lineHeight: 1.8 }}>
                <div className="flex justify-between">
                  <span>Amount paid</span><strong>₱{formatAmount(value.confirmed.received.toFixed(2))}</strong>
                </div>
                {value.confirmed.amountPaid > value.confirmed.received && (
                  <div className="flex justify-between">
                    <span>Total paid to date</span><strong>₱{formatAmount(value.confirmed.amountPaid.toFixed(2))}</strong>
                  </div>
                )}
                <div className="flex justify-between">
                  <span>Remaining balance</span><strong>₱{formatAmount(value.confirmed.remaining.toFixed(2))}</strong>
                </div>
                <div className="flex justify-between">
                  <span>Payment status</span><strong className="text-capitalize">{value.confirmed.status}</strong>
                </div>
                {value.confirmed.reference && (
                  <div className="flex justify-between">
                    <span>Reference</span>
                    <strong style={{ fontSize: '0.6875rem', wordBreak: 'break-all' }}>{value.confirmed.reference}</strong>
                  </div>
                )}
              </div>
              <div className="text-xs text-tertiary mt-12 text-center">
                Recorded automatically. You can now {config.confirmVerb}.
              </div>
            </div>
          )}

          {/* Waiting for the customer */}
          {value.paymentStep === 'waiting' && !value.confirmed && value.checkoutUrl && (
            <div className="mb-12 paymongo-waiting-card">
              <div className="flex items-center justify-between flex-wrap gap-8 mb-16">
                <span
                  className="text-white"
                  style={{
                    background: '#007DFE', borderRadius: 'var(--radius-xs)',
                    padding: '3px 10px', fontWeight: 700, fontSize: '0.8125rem',
                    letterSpacing: 0.5,
                  }}
                >
                  GCash
                </span>
                <span className="text-sm fw-700" style={{ color: 'var(--info-dark)' }}>
                  ₱{formatAmount((value.payment_type === 'paylater' ? d.collected : d.expected).toFixed(2))} via GCash
                </span>
              </div>

              <div className="flex flex-col items-center gap-8 mb-16">
                <div className="paymongo-qr-wrap">
                  <QRCode value={value.checkoutUrl} size={256} style={{ height: 'auto', maxWidth: '100%', width: '100%' }} viewBox="0 0 256 256" />
                </div>
              </div>

              <ol className="m-0 text-secondary" style={{ paddingLeft: 18, fontSize: '0.8125rem', lineHeight: 1.9 }}>
                <li>Scan the QR, or tap <strong>Open GCash</strong> for the checkout page</li>
                <li>Approve the payment in the GCash app</li>
                <li>Done — this panel updates by itself the moment the payment lands</li>
              </ol>

              <div className="flex items-center justify-center gap-8 mt-12 mb-12 paymongo-waiting-status" role="status" aria-live="polite">
                <Loader size={14} className="animate-spin" style={{ color: 'var(--info-dark)' }} aria-hidden="true" />
                <span className="text-xs" style={{ color: 'var(--info-dark)' }}>
                  Waiting for the customer to complete payment…
                </span>
              </div>

              <div className="paymongo-actions paymongo-actions-3 mb-12">
                <button
                  type="button"
                  className="btn btn-primary btn-sm justify-center"
                  onClick={() => { window.location.href = value.checkoutUrl; }}
                >
                  <ExternalLink size={14} className="mr-6" aria-hidden="true" /> Open GCash
                </button>
                <button
                  type="button"
                  className="btn btn-outline btn-sm justify-center"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(value.checkoutUrl);
                      toast.success('Payment link copied to clipboard');
                    } catch {
                      config.onError?.('Failed to copy link. Please copy manually.');
                    }
                  }}
                >
                  Copy Payment Link
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm justify-center"
                  onClick={() => checkPaymentNow(false)}
                  disabled={disabled || checkingPayment}
                >
                  {checkingPayment
                    ? <><Loader size={14} className="animate-spin mr-6" aria-hidden="true" /> Checking…</>
                    : <><RefreshCw size={14} className="mr-6" aria-hidden="true" /> Check payment</>}
                </button>
              </div>

              {/* The escape hatch that makes locking the confirm button safe:
                  without it, a customer who walks away strands the admin in a
                  modal they cannot submit. */}
              <button
                type="button"
                className="btn btn-outline btn-sm w-full justify-center paymongo-cancel-btn"
                onClick={handleCancelGCash}
                disabled={disabled || checkingPayment}
              >
                <XCircle size={14} className="mr-6" aria-hidden="true" /> Cancel payment — pay another way
              </button>

              <div className="text-xs text-tertiary mt-12 text-center">
                <strong>{config.confirmLabel} is locked</strong> until this payment is confirmed or cancelled.
              </div>
            </div>
          )}

          {/* Manual reference fallback */}
          {value.paymentStep !== 'waiting' && (
            <>
              <div className="text-xs text-tertiary mb-8 text-center border-t" style={{ paddingTop: 10 }}>
                Or enter payment details manually
              </div>
              <div className="form-group mb-12">
                <label className="form-label" htmlFor="pcp-payment-reference">Reference Number</label>
                <input
                  id="pcp-payment-reference"
                  type="text"
                  className="form-input"
                  placeholder="Enter GCash Ref No."
                  value={value.payment_reference}
                  disabled={disabled}
                  onChange={e => patch({ payment_reference: e.target.value })}
                />
              </div>
            </>
          )}

          <div className="form-group mb-12">
            <label className="form-label" htmlFor="pcp-payment-date">Payment Date *</label>
            <input
              id="pcp-payment-date"
              type="date"
              className={`form-input ${invalidClass(F.date, errors)}`}
              value={value.payment_date}
              disabled={disabled}
              onChange={e => { patch({ payment_date: e.target.value }); clearError(F.date); }}
              max={today()}
              {...fieldAttrs(F.date, errors)}
            />
            <FieldError name={F.date} errors={errors} />
          </div>

          <div className="form-group mb-0">
            <label className="form-label">Receipt Screenshot (Optional)</label>
            <p className="text-xs text-tertiary mb-8">
              Receipt screenshot is optional and should only be uploaded if requested by the
              administrator or if additional proof is needed.
            </p>
            {value.receiptPreview ? (
              <div className="relative overflow-hidden mb-8 br-8" style={{ width: 90, height: 90, border: '2px solid var(--border)'}}>
                <img src={value.receiptPreview} alt="Receipt" className="w-full h-full object-cover" />
                <button
                  type="button"
                  onClick={() => patch({ receiptFile: null, receiptPreview: null })}
                  className="pickup-photo-remove-btn"
                  aria-label="Remove receipt"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => receiptInputRef.current?.click()}
                disabled={disabled}
                className="br-8 cursor-pointer"
                style={{
                  padding: '8px 16px', border: '1px dashed var(--border)',
                  background: 'transparent', fontSize: '0.8125rem',
                }}
              >
                <FileText size={14} className="inline mr-6" /> Upload Receipt
              </button>
            )}
            <input
              ref={receiptInputRef} type="file" accept="image/jpeg,image/png,image/webp"
              onChange={handleReceiptAdd} style={{ display: 'none' }}
            />
          </div>
        </div>
      )}

      {/* Promise Date — shown as soon as Pay Later is chosen so the consequence
          of the choice is visible before the amount is edited; required once an
          amount is actually left owing. */}
      {d.isPayLater && (
        <div className="mb-16 br-8" style={{ background: 'var(--warning-bg)', padding: 14, border: '1px solid var(--warning)'}}>
          <div className="mb-8 font-semibold" style={{ fontSize: '0.8125rem', color: 'var(--warning-text)' }}>
            <AlertTriangle size={14} className="inline mr-6" /> Promise to Pay
          </div>
          <div className="form-group mb-0">
            <label className="form-label" htmlFor="pcp-promised-date">
              <Calendar size={14} className="inline mr-6" />
              Promised Payment Date {d.needsPromiseDate ? '*' : '(Optional)'}
            </label>
            <input
              id="pcp-promised-date"
              type="date"
              className={`form-input ${invalidClass(F.promise, errors)}`}
              value={value.promised_payment_date}
              disabled={disabled}
              onChange={e => { patch({ promised_payment_date: e.target.value }); clearError(F.promise); }}
              min={today()}
              {...fieldAttrs(F.promise, errors)}
            />
            <FieldError name={F.promise} errors={errors} />
          </div>
          <div className="text-xs mt-8" style={{ color: 'var(--warning-text)' }}>
            {d.needsPromiseDate
              ? `The cargo may be released, but ₱${formatAmount(d.outstandingAfter.toFixed(2))} remains owing. `
                + 'This order stays unsettled and its trip cannot be completed until it is paid.'
              : 'The amount entered covers the full balance, so nothing will be left owing.'}
          </div>
        </div>
      )}
    </>
  );
};

export default PaymentCollectionPanel;
