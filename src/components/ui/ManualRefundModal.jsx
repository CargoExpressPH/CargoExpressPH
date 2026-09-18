import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Lock, Loader, RotateCcw, X } from 'lucide-react';
import { recordManualRefund } from '../../lib/manualRefund';
import { formatMoney } from '../../utils/currencyInput';
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
  const [idempotencyKey] = useState(newIdempotencyKey);

  useEffect(() => {
    const onEscape = event => { if (event.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [onClose, saving]);

  const handleClose = () => { if (!saving) onClose(); };

  const handleSubmit = async event => {
    event.preventDefault();
    setError('');
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError('Enter a refund amount greater than zero.');
      return;
    }
    if (parsedAmount > maxRefund + 0.005) {
      setError(`The most that can still be recorded as refunded is ${formatMoney(maxRefund)}.`);
      return;
    }
    if (returnMethod === 'gcash' && returnReference.trim().length < 4) {
      setError('Enter the GCash transfer reference for this return.');
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
        amount: parsedAmount,
        reason,
        notes,
        returnMethod,
        returnReference,
        confirmedReturned,
        password,
        idempotencyKey,
      });
      setPassword('');
      await onSuccess(result, parsedAmount);
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

  const locked = Boolean(lockedUntil) && new Date(lockedUntil).getTime() > Date.now();

  return createPortal(
    <FocusTrap active>
      <div
        className="modal-overlay"
        onClick={event => { if (event.target === event.currentTarget) handleClose(); }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-refund-title"
      >
        <form className="modal" style={{ maxWidth: 520 }} onSubmit={handleSubmit} onClick={event => event.stopPropagation()}>
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
                value={amount}
                onValueChange={value => { setAmount(value); setError(''); }}
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
                onChange={event => { setReturnMethod(event.target.value); setError(''); }}
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
                  type="text"
                  className="form-input"
                  maxLength={255}
                  value={returnReference}
                  onChange={event => { setReturnReference(event.target.value); setError(''); }}
                  placeholder="Reference number from the GCash transfer you sent"
                  disabled={saving}
                />
              </div>
            )}

            <div className="form-group">
              <label className="form-label" htmlFor="manual-refund-notes">
                {returnMethod === 'cash' ? 'Acknowledgement note *' : 'Notes'}
              </label>
              <textarea
                id="manual-refund-notes"
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
                type="password"
                className="form-input"
                autoComplete="current-password"
                value={password}
                onChange={event => { setPassword(event.target.value); setError(''); }}
                placeholder="Confirm it's you"
                disabled={saving || locked}
              />
              <p className="form-hint flex items-center gap-4"><Lock size={12} aria-hidden="true" /> Verified against your account — never stored, never shown to anyone else.</p>
            </div>

            {error && <div className="alert-banner alert-banner-error mt-16" role="alert">{error}</div>}
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={handleClose} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving || locked || !confirmedReturned || maxRefund <= 0}>
              {saving ? <Loader size={16} className="animate-spin" /> : <RotateCcw size={16} />}
              {saving ? 'Recording…' : locked ? 'Locked — try later' : `Record ${formatMoney(Number(amount) || 0)} refund`}
            </button>
          </div>
        </form>
      </div>
    </FocusTrap>,
    document.body,
  );
};

export default ManualRefundModal;
