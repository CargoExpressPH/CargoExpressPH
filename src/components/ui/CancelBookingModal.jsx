import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Loader, X } from 'lucide-react';
import FocusTrap from './FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';

/**
 * CancelBookingModal — the customer states WHY before anything is cancelled.
 *
 * Replaces the plain ConfirmModal that used to sit here. Two changes, both of
 * them the point of the screen:
 *
 *   • A reason is required. It is the single fact about a cancellation worth
 *     keeping, and the old dialog had nowhere to put it.
 *   • The copy no longer promises the booking is gone. It is not: the request
 *     goes to an admin, and the shipment slot is held until they rule on it.
 *     The previous wording ("this action cannot be undone and your shipment
 *     slot will be released") is now false in both halves.
 *
 * The 5-character minimum matches request_order_cancellation() server-side, so
 * the field cannot be satisfied with "x" and then rejected by the database.
 */

const MIN_REASON = 5;

const PRESETS = [
  'Booked by mistake',
  'Changed my mind',
  'Sending on a different date',
  'Found another courier',
  'Wrong receiver details',
];

const CancelBookingModal = ({ isOpen, onClose, onConfirm, loading = false, trackingNumber }) => {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setReason('');
      setTouched(false);
    }
  }, [isOpen]);

  useScrollLock(isOpen);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !loading) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, loading, onClose]);

  if (!isOpen) return null;

  const trimmed = reason.trim();
  const isValid = trimmed.length >= MIN_REASON;
  const showError = touched && !isValid;

  const handleSubmit = (e) => {
    e.preventDefault();
    setTouched(true);
    if (!isValid || loading) return;
    onConfirm(trimmed);
  };

  return createPortal(
    <FocusTrap active>
      <div
        className="modal-overlay"
        onClick={(e) => { if (e.target === e.currentTarget && !loading) onClose(); }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-booking-title"
      >
        <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
          <div className="modal-header">
            <h3 id="cancel-booking-title" className="flex items-center gap-8">
              <AlertTriangle size={20} aria-hidden="true" /> Request Cancellation
            </h3>
            <button
              type="button"
              className="btn-icon btn-ghost"
              onClick={onClose}
              disabled={loading}
              aria-label="Close cancellation request"
            >
              <X size={20} />
            </button>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="modal-body">
              <p className="text-sm text-secondary mb-16">
                {trackingNumber ? <>Booking <strong>{trackingNumber}</strong> is not cancelled yet. </> : null}
                Our team reviews every cancellation request. Your shipment slot is held until
                they decide, and you will be notified either way.
              </p>

              <div className="form-group">
                <label className="form-label" htmlFor="cancel-reason">
                  Reason for Cancellation *
                </label>
                <textarea
                  id="cancel-reason"
                  className={`form-textarea${showError ? ' field-invalid' : ''}`}
                  rows={4}
                  placeholder="e.g. I booked the wrong pickup date and need to rebook for next week."
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  onBlur={() => setTouched(true)}
                  aria-describedby="cancel-reason-help"
                  aria-invalid={showError}
                  maxLength={500}
                  required
                />
                <p id="cancel-reason-help" className="text-xs mt-4" style={{ color: showError ? 'var(--error-text)' : 'var(--text-tertiary)' }}>
                  {showError
                    ? `Please give at least ${MIN_REASON} characters so our team knows what happened.`
                    : `${trimmed.length}/500 — this is shown to the admin reviewing your request.`}
                </p>
              </div>

              <div className="flex flex-wrap gap-8">
                {PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => { setReason(preset); setTouched(true); }}
                    disabled={loading}
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-outline" onClick={onClose} disabled={loading}>
                Keep Booking
              </button>
              <button type="submit" className="btn btn-danger" disabled={loading || !isValid}>
                {loading && <Loader size={16} className="animate-spin" />}
                Submit Request
              </button>
            </div>
          </form>
        </div>
      </div>
    </FocusTrap>,
    document.body
  );
};

export default CancelBookingModal;
