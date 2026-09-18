import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Lock, Loader, RotateCcw, X } from 'lucide-react';
import { recordManualRefund } from '../../lib/manualRefund';
import { formatMoney } from '../../utils/currencyInput';
import { validateGcashReference } from '../../utils/gcashReference';
import AmountInput from './AmountInput';
import CustomSelect from './CustomSelect';
import FocusTrap from './FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';
import { useToast } from '../../hooks/useToast';

const newIdempotencyKey = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : ((random & 3) | 8)).toString(16);
  });
};

const formatLockCountdown = (lockedUntil) => {
  if (!lockedUntil) return '';
  const ms = new Date(lockedUntil).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const minutes = Math.ceil(ms / 60000);
  return ` Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
};

/**
 * Records that a Cash or manual-GCash payment was already physically
 * returned to the customer. This does NOT initiate any transfer — the admin
 * confirms the return already happened, and this only updates
 * CargoExpress's own records so reports stop overstating collected revenue.
 * See supabase/functions/record-manual-refund for the password
 * verification this performs server-side.
 *
 * AUTOFILL — root cause and fix (see MANUAL_REFUND_REFERENCE_VALIDATION_FIX_REPORT.md
 * for the full writeup):
 *
 * This modal used to render as a native <form> containing a plain, bare
 * text input (the GCash reference) with no name/autocomplete attributes,
 * followed later by a password-type input. Chrome's saved-credential
 * heuristic scans a <form> for a password field, then looks BACKWARD for the
 * nearest preceding text-shaped input to treat as that login's "username" —
 * it found the reference field (the only other bare text input between the
 * amount field and the password field; the reason/return-method controls are
 * CustomSelect, which renders as a <button>, not a text input) and
 * autofilled the admin's saved site credentials into both. This matches the
 * reported symptom exactly: the reference field filled with the admin's
 * email, and the password field filled alongside it, only once a password
 * field existed later in the same <form>.
 *
 * The fix has two layers, since neither alone is reliable (Chrome is known
 * to override a declared `autocomplete="off"` on fields it believes are
 * login-related, which is exactly why the task's own brief says not to rely
 * on it alone):
 *   1. This is no longer a <form>. Removing the <form> element removes
 *      Chrome's primary structural signal for "this is a login/credential
 *      form" — its autofill-pairing and save-password-prompt heuristics are
 *      bound to <form> elements. Submission is wired manually (the button's
 *      onClick, plus an Enter-key handler on the three relevant inputs) so
 *      keyboard submission still works.
 *   2. Every field still gets a distinct, non-credential-shaped `name` and
 *      an appropriate `autocomplete` value as a second, independent layer —
 *      not the sole defense, but still correct to have.
 */
const ManualRefundModal = ({ transaction, order, onClose, onSuccess }) => {
  useScrollLock(true);
  const toast = useToast();
  const maxRefund = Number(transaction?.refundable_amount || 0);
  const [amount, setAmount] = useState(() => maxRefund.toFixed(2));
  const [reason, setReason] = useState('requested_by_customer');
  const [returnMethod, setReturnMethod] = useState(transaction?.payment_method === 'gcash' ? 'gcash' : 'cash');
  const [returnReference, setReturnReference] = useState('');
  const [notes, setNotes] = useState('');
  const [confirmedReturned, setConfirmedReturned] = useState(false);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [lockedUntil, setLockedUntil] = useState(null);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  // Every sensitive / method-specific field starts empty for a fresh
  // transaction. The modal is normally a full unmount+remount per open (see
  // OrderDetailPage.jsx: it only exists in the tree while its `transaction`
  // prop is set, and closing clears that before a new one can open), so
  // useState's initializers already cover that case — this effect is a
  // second, explicit guarantee against exactly the kind of leak this task
  // is about, in case that assumption ever stops holding (e.g. a future
  // caller keeps the component mounted and swaps `transaction` directly).
  useEffect(() => {
    setAmount(Number(transaction?.refundable_amount || 0).toFixed(2));
    setReason('requested_by_customer');
    setReturnMethod(transaction?.payment_method === 'gcash' ? 'gcash' : 'cash');
    setReturnReference('');
    setNotes('');
    setConfirmedReturned(false);
    setPassword('');
    setError('');
    setLockedUntil(null);
    setIdempotencyKey(newIdempotencyKey());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transaction?.id]);

  useEffect(() => {
    const onEscape = event => { if (event.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [onClose, saving]);

  const handleClose = () => {
    if (saving) return;
    setPassword('');
    onClose();
  };

  // Switching between Cash and GCash changes what counts as "evidence" —
  // the GCash reference and the Cash acknowledgement note are each specific
  // to one method, so the other method's leftover value must not silently
  // ride along into a submission it was never actually entered for. The
  // password and confirmation are reset too: they attest to a specific
  // return the admin just described, and that description just changed.
  // The refund amount is untouched — it is not method-specific.
  const handleReturnMethodChange = (event) => {
    setReturnMethod(event.target.value);
    setReturnReference('');
    setNotes('');
    setPassword('');
    setConfirmedReturned(false);
    setError('');
  };

  const locked = Boolean(lockedUntil) && new Date(lockedUntil).getTime() > Date.now();
  const referenceCheck = returnMethod === 'gcash'
    ? validateGcashReference(returnReference, { originalReference: transaction?.payment_method === 'gcash' ? transaction?.transaction_reference : null })
    : { valid: true, value: '', error: null };
  const amountValue = Number(amount);
  const amountValid = Number.isFinite(amountValue) && amountValue > 0 && amountValue <= maxRefund + 0.005;
  const evidenceValid = returnMethod === 'gcash' ? referenceCheck.valid : notes.trim().length >= 5;
  const canSubmit = !saving && !locked && amountValid && evidenceValid && confirmedReturned && password.length > 0 && maxRefund > 0;

  const handleSubmit = async event => {
    event?.preventDefault?.();
    setError('');
    if (!Number.isFinite(amountValue) || amountValue <= 0) {
      setError('Enter a refund amount greater than zero.');
      return;
    }
    if (amountValue > maxRefund + 0.005) {
      setError(`The most that can still be recorded as refunded is ${formatMoney(maxRefund)}.`);
      return;
    }
    if (returnMethod === 'gcash' && !referenceCheck.valid) {
      setError(referenceCheck.error || 'Enter a valid GCash transfer reference.');
      return;
    }
    if (returnMethod === 'cash' && notes.trim().length < 5) {
      setError('Enter a short acknowledgement note for this cash return (who received it, when).');
      return;
    }
    if (!confirmedReturned) {
      setError('Confirm that the money has already been returned to the customer.');
      return;
    }
    if (!password) {
      setError('Enter your account password to confirm this action.');
      return;
    }

    setSaving(true);
    try {
      const result = await recordManualRefund({
        paymentTransactionId: transaction.id,
        amount: amountValue,
        reason,
        notes,
        returnMethod,
        returnReference: returnMethod === 'gcash' ? referenceCheck.value : '',
        confirmedReturned,
        password,
        idempotencyKey,
      });
      setPassword('');
      await onSuccess(result, amountValue);
    } catch (err) {
      setPassword('');
      if (err?.isLocked) {
        setLockedUntil(err.lockedUntil);
        setError((err.message || 'Too many incorrect password attempts.') + formatLockCountdown(err.lockedUntil));
      } else if (err?.isPasswordError) {
        if (err.lockedUntil) setLockedUntil(err.lockedUntil);
        setError(err.message || 'Incorrect password.');
      } else {
        const message = err?.message || 'This manual refund could not be recorded.';
        setError(message);
        toast.error(message);
      }
    } finally {
      setSaving(false);
    }
  };

  // Enter submits from the single-line fields, matching the convenience a
  // native <form> gave for free — scoped to just these inputs (not the
  // textarea, where Enter must keep inserting a newline, and not attached
  // globally, which would fight CustomSelect's own Enter handling for
  // opening/choosing an option).
  const handleEnterSubmit = (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    handleSubmit(event);
  };

  return createPortal(
    <FocusTrap active>
      <div
        className="modal-overlay"
        onClick={event => { if (event.target === event.currentTarget) handleClose(); }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-refund-title"
      >
        <div className="modal" style={{ maxWidth: 520 }} onClick={event => event.stopPropagation()}>
          <div className="modal-header">
            <h3 id="manual-refund-title" className="flex items-center gap-8">
              <RotateCcw size={19} aria-hidden="true" /> Record Manual Refund
            </h3>
            <button type="button" className="btn-icon btn-ghost" onClick={handleClose} disabled={saving} aria-label="Close manual refund modal">
              <X size={20} />
            </button>
          </div>

          <div className="modal-body modal-body-scroll">
            <div className="alert-banner alert-banner-warning mb-16">
              <AlertTriangle size={16} aria-hidden="true" />
              This only records a refund in CargoExpress's system for accounting purposes — it does
              not transfer any money. Use this only after you have already physically handed the
              cash back, or already sent the GCash transfer yourself.
            </div>

            <dl className="payment-detail-grid mb-16">
              <div className="payment-detail-row"><dt>Order</dt><dd>{order?.tracking_number}</dd></div>
              <div className="payment-detail-row"><dt>Original payment</dt><dd>{formatMoney(transaction.amount)} ({transaction.payment_method === 'gcash' ? 'GCash, recorded manually' : 'Cash'})</dd></div>
              <div className="payment-detail-row"><dt>Already refunded</dt><dd>{formatMoney(transaction.refunded_amount || 0)}</dd></div>
              <div className="payment-detail-row"><dt>Available to record</dt><dd>{formatMoney(maxRefund)}</dd></div>
            </dl>

            <div className="form-group">
              <label className="form-label" htmlFor="manual-refund-amount">Refund amount *</label>
              <AmountInput
                id="manual-refund-amount"
                name="manual-refund-amount"
                value={amount}
                onValueChange={value => { setAmount(value); setError(''); }}
                onKeyDown={handleEnterSubmit}
                disabled={saving}
                aria-describedby="manual-refund-amount-help"
                autoFocus
              />
              <p id="manual-refund-amount-help" className="form-hint">Cannot exceed the original payment amount, minus anything already refunded.</p>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="manual-refund-reason">Reason *</label>
              <CustomSelect id="manual-refund-reason" className="form-select" value={reason} onChange={event => setReason(event.target.value)} disabled={saving}>
                <option value="requested_by_customer">Requested by customer</option>
                <option value="duplicate">Duplicate payment</option>
                <option value="fraudulent">Fraudulent payment</option>
                <option value="others">Other</option>
              </CustomSelect>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="manual-refund-return-method">How was the money actually returned? *</label>
              <CustomSelect
                id="manual-refund-return-method"
                className="form-select"
                value={returnMethod}
                onChange={handleReturnMethodChange}
                disabled={saving}
              >
                <option value="cash">Cash — handed back in person</option>
                <option value="gcash">GCash — sent as a manual transfer</option>
              </CustomSelect>
              <p className="form-hint">This can differ from how it was originally paid (e.g. paid Cash, returned via GCash).</p>
            </div>

            {returnMethod === 'gcash' && (
              <div className="form-group">
                <label className="form-label" htmlFor="manual-refund-reference">GCash transfer reference *</label>
                <input
                  id="manual-refund-reference"
                  name="cargoexpress-gcash-refund-transfer-reference"
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck="false"
                  className="form-input"
                  maxLength={255}
                  value={returnReference}
                  onChange={event => { setReturnReference(event.target.value); setError(''); }}
                  onKeyDown={handleEnterSubmit}
                  placeholder="e.g. 1001 543 610110"
                  aria-describedby="manual-refund-reference-help"
                  disabled={saving}
                />
                <p id="manual-refund-reference-help" className="form-hint">
                  Enter the reference number from the completed GCash transfer receipt — the
                  reference of the refund transfer you just sent, not the customer's original
                  payment, an email/phone number, or an internal payment ID. This confirms the
                  reference is formatted like a real one; it does not by itself prove the transfer
                  happened — that's what the confirmation checkbox below is for.
                </p>
                {returnReference && !referenceCheck.valid && (
                  <p className="form-hint" style={{ color: 'var(--error-text)' }}>{referenceCheck.error}</p>
                )}
              </div>
            )}

            <div className="form-group">
              <label className="form-label" htmlFor="manual-refund-notes">
                {returnMethod === 'cash' ? 'Acknowledgement note *' : 'Notes'}
              </label>
              <textarea
                id="manual-refund-notes"
                name="manual-refund-notes"
                className="form-textarea"
                rows={3}
                maxLength={255}
                value={notes}
                onChange={event => { setNotes(event.target.value); setError(''); }}
                placeholder={returnMethod === 'cash'
                  ? 'e.g. Handed ₱600 cash to the customer at the hub, 3pm, acknowledged by customer.'
                  : 'Optional explanation for the history'}
                disabled={saving}
              />
              <p className="form-hint text-right">{notes.length}/255</p>
            </div>

            <label className="flex items-start gap-10 text-sm cursor-pointer mb-16">
              <input
                type="checkbox"
                name="manual-refund-confirmed-returned"
                checked={confirmedReturned}
                onChange={event => { setConfirmedReturned(event.target.checked); setError(''); }}
                disabled={saving}
              />
              <span>I confirm the money has already been returned to the customer. This records that completed return — it does not send any money.</span>
            </label>

            <div className="form-group">
              <label className="form-label" htmlFor="manual-refund-password">Admin password *</label>
              <input
                id="manual-refund-password"
                name="cargoexpress-manual-refund-admin-password"
                type="password"
                className="form-input"
                autoComplete="current-password"
                value={password}
                onChange={event => { setPassword(event.target.value); setError(''); }}
                onKeyDown={handleEnterSubmit}
                placeholder="Confirm it's you"
                disabled={saving || locked}
              />
              <p className="form-hint flex items-center gap-4"><Lock size={12} aria-hidden="true" /> Verified against your account — never stored, never shown to anyone else.</p>
            </div>

            {error && <div className="alert-banner alert-banner-error mt-16" role="alert">{error}</div>}
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={handleClose} disabled={saving}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={!canSubmit}>
              {saving ? <Loader size={16} className="animate-spin" /> : <RotateCcw size={16} />}
              {saving ? 'Recording…' : locked ? 'Locked — try later' : `Record ${formatMoney(amountValue || 0)} refund`}
            </button>
          </div>
        </div>
      </div>
    </FocusTrap>,
    document.body,
  );
};

export default ManualRefundModal;
