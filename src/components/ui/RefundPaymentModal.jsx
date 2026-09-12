import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Loader, RotateCcw, X } from 'lucide-react';
import { createPayMongoRefund } from '../../lib/paymongo';
import { formatMoney } from '../../utils/currencyInput';
import AmountInput from './AmountInput';
import CustomSelect from './CustomSelect';
import FocusTrap from './FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';

const newIdempotencyKey = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : ((random & 3) | 8)).toString(16);
  });
};

const RefundPaymentModal = ({ transaction, order, onClose, onSuccess }) => {
  useScrollLock(true);
  const maxRefund = Number(transaction?.refundable_amount || 0);
  const [amount, setAmount] = useState(() => maxRefund.toFixed(2));
  const [reason, setReason] = useState('requested_by_customer');
  const [notes, setNotes] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
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
      setError(`The most that can still be refunded is ${formatMoney(maxRefund)}.`);
      return;
    }
    if (!confirmed) {
      setError('Confirm that you reviewed the amount and original payment.');
      return;
    }

    setSaving(true);
    try {
      const result = await createPayMongoRefund({
        paymentTransactionId: transaction.id,
        amount: parsedAmount,
        reason,
        notes,
        idempotencyKey,
      });
      await onSuccess(result, parsedAmount);
    } catch (err) {
      setError(err?.message || 'Refund could not be submitted.');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <FocusTrap active>
      <div
        className="modal-overlay"
        onClick={event => { if (event.target === event.currentTarget) handleClose(); }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="refund-payment-title"
      >
        <form className="modal" style={{ maxWidth: 500 }} onSubmit={handleSubmit} onClick={event => event.stopPropagation()}>
          <div className="modal-header">
            <h3 id="refund-payment-title" className="flex items-center gap-8">
              <RotateCcw size={19} aria-hidden="true" /> Refund GCash Payment
            </h3>
            <button type="button" className="btn-icon btn-ghost" onClick={handleClose} disabled={saving} aria-label="Close refund modal">
              <X size={20} />
            </button>
          </div>

          <div className="modal-body modal-body-scroll">
            <div className="alert-banner alert-banner-warning mb-16">
              <AlertTriangle size={16} aria-hidden="true" />
              This sends money back through PayMongo. It does not cancel or change the shipment status.
            </div>

            <dl className="payment-detail-grid mb-16">
              <div className="payment-detail-row"><dt>Order</dt><dd>{order?.tracking_number}</dd></div>
              <div className="payment-detail-row"><dt>Original payment</dt><dd>{formatMoney(transaction.amount)}</dd></div>
              <div className="payment-detail-row"><dt>Already refunded</dt><dd>{formatMoney(transaction.refunded_amount || 0)}</dd></div>
              <div className="payment-detail-row"><dt>Available to refund</dt><dd>{formatMoney(maxRefund)}</dd></div>
            </dl>

            <div className="form-group">
              <label className="form-label" htmlFor="refund-amount">Refund amount *</label>
              <AmountInput
                id="refund-amount"
                value={amount}
                onValueChange={value => { setAmount(value); setError(''); }}
                disabled={saving}
                aria-describedby="refund-amount-help"
                autoFocus
              />
              <p id="refund-amount-help" className="form-hint">Use the full available amount or enter a smaller partial refund.</p>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="refund-reason">Reason *</label>
              <CustomSelect id="refund-reason" className="form-select" value={reason} onChange={event => setReason(event.target.value)} disabled={saving}>
                <option value="requested_by_customer">Requested by customer</option>
                <option value="duplicate">Duplicate payment</option>
                <option value="fraudulent">Fraudulent payment</option>
                <option value="others">Other</option>
              </CustomSelect>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="refund-notes">Notes</label>
              <textarea
                id="refund-notes"
                className="form-textarea"
                rows={3}
                maxLength={255}
                value={notes}
                onChange={event => setNotes(event.target.value)}
                placeholder="Optional explanation for the history"
                disabled={saving}
              />
              <p className="form-hint text-right">{notes.length}/255</p>
            </div>

            <label className="flex items-start gap-10 text-sm cursor-pointer">
              <input type="checkbox" checked={confirmed} onChange={event => { setConfirmed(event.target.checked); setError(''); }} disabled={saving} />
              <span>I reviewed the order, original GCash payment, and refund amount.</span>
            </label>

            {error && <div className="alert-banner alert-banner-error mt-16" role="alert">{error}</div>}
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={handleClose} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving || !confirmed || maxRefund <= 0}>
              {saving ? <Loader size={16} className="animate-spin" /> : <RotateCcw size={16} />}
              {saving ? 'Submitting…' : `Refund ${formatMoney(Number(amount) || 0)}`}
            </button>
          </div>
        </form>
      </div>
    </FocusTrap>,
    document.body,
  );
};

export default RefundPaymentModal;
