import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Loader, Scale, X } from 'lucide-react';
import AmountInput from './AmountInput';
import FocusTrap from './FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';
import { formatMoney } from '../../utils/currencyInput';
import {
  amendCancellationSettlementDecision,
  recordCancellationSettlementDecision,
} from '../../lib/database';

const newIdempotencyKey = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : ((random & 3) | 8)).toString(16);
  });
};

const CancellationSettlementModal = ({ order, summary, amendment = false, onClose, onSuccess }) => {
  useScrollLock(true);
  const initialType = amendment && summary?.decision_type ? summary.decision_type : 'full_refund';
  const [decisionType, setDecisionType] = useState(initialType);
  const [fee, setFee] = useState(() => (
    amendment && summary?.agreed_cancellation_fee != null
      ? Number(summary.agreed_cancellation_fee).toFixed(2)
      : '0.00'
  ));
  const [agreementConfirmed, setAgreementConfirmed] = useState(Boolean(amendment && summary?.customer_agreement_confirmed));
  const [notes, setNotes] = useState(amendment ? (summary?.internal_notes || '') : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [idempotencyKey] = useState(newIdempotencyKey);

  const maximumFee = useMemo(() => Math.max(0, Math.min(
    Number(summary?.historical_final_charge || 0),
    Number(summary?.gross_collected || 0)
      - Number(summary?.successful_refunds || 0)
      - Number(summary?.refund_in_progress || 0),
  )), [summary]);

  useEffect(() => {
    const closeOnEscape = event => { if (event.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose, saving]);

  const chooseType = nextType => {
    setDecisionType(nextType);
    setError('');
    if (nextType === 'full_refund') {
      setFee('0.00');
      setAgreementConfirmed(false);
    }
  };

  const submit = async event => {
    event.preventDefault();
    const amount = decisionType === 'retained_fee' ? Number(fee) : 0;
    if (decisionType === 'retained_fee' && (!Number.isFinite(amount) || amount <= 0)) {
      setError('Enter a positive agreed cancellation fee.');
      return;
    }
    if (amount > maximumFee + 0.005) {
      setError('The fee cannot exceed ' + formatMoney(maximumFee) + ', the amount available after refunds and the historical final charge.');
      return;
    }
    if (decisionType === 'retained_fee' && !agreementConfirmed) {
      setError('Confirm that the customer agreement was recorded before saving this fee.');
      return;
    }
    if (notes.trim().length > 1000) {
      setError('Internal notes must be 1000 characters or fewer.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const operation = amendment
        ? amendCancellationSettlementDecision
        : recordCancellationSettlementDecision;
      const result = await operation({
        orderId: order.id,
        decisionType,
        agreedRetainedAmount: amount,
        customerAgreementConfirmed: decisionType === 'retained_fee' && agreementConfirmed,
        internalNotes: notes.trim(),
        idempotencyKey,
      });
      await onSuccess(result);
    } catch (err) {
      setError(err?.message || 'The settlement decision could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <FocusTrap active>
      <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="settlement-decision-title" onClick={event => { if (event.target === event.currentTarget && !saving) onClose(); }}>
        <div className="modal" style={{ maxWidth: 540 }} onClick={event => event.stopPropagation()}>
          <div className="modal-header">
            <h3 id="settlement-decision-title" className="flex items-center gap-8">
              <Scale size={19} /> {amendment ? 'Amend Settlement Decision' : 'Record Settlement Decision'}
            </h3>
            <button type="button" className="btn-icon btn-ghost" onClick={onClose} disabled={saving} aria-label="Close settlement decision">
              <X size={20} />
            </button>
          </div>

          <form onSubmit={submit}>
            <div className="modal-body modal-body-scroll">
              <div className="alert-banner alert-banner-info mb-16">
                <AlertTriangle size={16} />
                This records a financial decision only. It does not send money, create a payment, or create a refund.
              </div>

              {amendment && (
                <div className="alert-banner alert-banner-warning mb-16">
                  This is an explicit audited amendment. The previous and new decisions will remain in durable history.
                </div>
              )}

              <div className="form-group">
                <label className="form-label" htmlFor="settlement-decision-type">Decision</label>
                <select
                  id="settlement-decision-type"
                  className="form-control"
                  value={decisionType}
                  onChange={event => chooseType(event.target.value)}
                  disabled={saving}
                >
                  <option value="full_refund">Full Refund</option>
                  <option value="retained_fee">Refund with Agreed Cancellation Fee</option>
                </select>
              </div>

              {decisionType === 'retained_fee' && (
                <>
                  <div className="form-group">
                    <label className="form-label" htmlFor="settlement-fee">Agreed cancellation fee</label>
                    <AmountInput
                      id="settlement-fee"
                      value={fee}
                      onValueChange={setFee}
                      max={maximumFee}
                      disabled={saving}
                    />
                    <div className="form-hint">Maximum currently available: {formatMoney(maximumFee)}</div>
                  </div>
                  <label className="flex items-start gap-8 text-sm mb-16">
                    <input
                      type="checkbox"
                      checked={agreementConfirmed}
                      onChange={event => setAgreementConfirmed(event.target.checked)}
                      disabled={saving}
                    />
                    <span>I confirm that the customer agreed to this cancellation fee and that I am recording that agreement as the admin.</span>
                  </label>
                </>
              )}

              <div className="form-group">
                <label className="form-label" htmlFor="settlement-notes">Internal notes (optional)</label>
                <textarea
                  id="settlement-notes"
                  className="form-control"
                  rows={3}
                  maxLength={1000}
                  value={notes}
                  onChange={event => setNotes(event.target.value)}
                  disabled={saving}
                  placeholder="Internal context only; customers cannot read this field."
                />
              </div>

              {error && <div className="alert-banner alert-banner-error" role="alert"><AlertTriangle size={16} />{error}</div>}
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? <Loader size={16} className="animate-spin" /> : <Scale size={16} />}
                {amendment ? 'Save Audited Amendment' : 'Confirm Decision'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </FocusTrap>,
    document.body,
  );
};

export default CancellationSettlementModal;
