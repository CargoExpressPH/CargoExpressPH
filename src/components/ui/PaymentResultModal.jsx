import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Loader } from 'lucide-react';
import FocusTrap from './FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';

/**
 * PaymentResultModal — Premium modal for GCash payment outcomes.
 * Reference: shutterstock light card with tinted outer (pink/green), solid
 * red/green icon, transaction details inner card, pill buttons.
 *
 * @param {boolean}   isOpen         - Whether the modal is visible
 * @param {function}  onClose        - Called when the modal is dismissed
 * @param {'success'|'error'|'processing'} variant - Visual mode
 * @param {number}    [amount]       - Payment amount (e.g. 1250)
 * @param {string}    [trackingNumber] - Order tracking number -> Tracking Number
 * @param {string}    [paymentMethod]  - e.g. "GCash"
 * @param {function}  [onRetry]      - If provided, shows a retry/refresh button
 */
const PaymentResultModal = ({
  isOpen,
  onClose,
  variant = 'success',
  amount,
  trackingNumber,
  paymentMethod = 'GCash',
  onRetry,
}) => {
  const titleId = useId();
  const descId = useId();
  const btnRef = useRef(null);

  useScrollLock(isOpen);

  // Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handle = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [isOpen, onClose]);

  // Auto-focus primary button
  useEffect(() => {
    if (isOpen && btnRef.current) btnRef.current.focus();
  }, [isOpen]);

  if (!isOpen) return null;

  const isSuccess = variant === 'success';
  const isError = variant === 'error';
  const isProcessing = variant === 'processing';

  const title = isSuccess ? 'Payment Successful!'
    : isError ? 'Payment Failed!'
    : 'Payment Processing';

  const subtitle = isSuccess ? 'Your payment was processed successfully!'
    : isError ? 'Please choose another payment method.'
    : `Your ${paymentMethod} payment is being confirmed. This usually takes a few seconds.`;

  const formattedAmount = typeof amount === 'number' && amount > 0
    ? `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : null;

  // Reference date format: "23 Jun 2026, 7:47 PM" — PH time
  const now = new Date();
  const formattedDate = `${now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Manila' })}, ${now.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila' })}`;

  const handleRetry = () => {
    if (onRetry) {
      onClose();
      onRetry();
    }
  };

  return createPortal(
    <FocusTrap active={isOpen}>
      <div
        className="modal-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        <div
          className={`payment-result-modal variant-${variant}`}
          onClick={(e) => e.stopPropagation()}
          tabIndex={-1}
        >

          {/* ── Icon ─────────────────────────────────────────────── */}
          <div className={`pr-icon-wrap ${variant}`}>
            {isSuccess && (
              <svg className="pr-icon-svg" viewBox="0 0 52 52" fill="none" aria-hidden="true">
                <circle className="pr-icon-ring" cx="26" cy="26" r="24" stroke="currentColor" strokeWidth="3" />
                <path className="pr-icon-check" d="M15 27l7 7 15-15" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            )}
            {isError && (
              <svg className="pr-icon-svg" viewBox="0 0 52 52" fill="none" aria-hidden="true">
                <circle cx="26" cy="26" r="24" stroke="currentColor" strokeWidth="3" opacity="0.25" />
                <path className="pr-icon-cross" d="M18 18l16 16M34 18l-16 16" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" fill="none" />
              </svg>
            )}
            {isProcessing && (
              <div className="pr-icon-spinner" aria-hidden="true">
                <Loader size={28} className="animate-spin" />
              </div>
            )}
            {isSuccess && <div className="pr-confetti" aria-hidden="true" />}
          </div>

          {/* ── Content ──────────────────────────────────────────── */}
          <h3 id={titleId} className="pr-title">{title}</h3>
          <p id={descId} className="pr-subtitle">{subtitle}</p>

          {isSuccess && (formattedAmount || trackingNumber) && (
            <div className="pr-transaction-card">
              <div className="pr-transaction-header">Transaction Details</div>
              {formattedAmount && (
                <div className="pr-transaction-row">
                  <span className="pr-transaction-label">Amount Paid</span>
                  <span className="pr-transaction-value">{formattedAmount}</span>
                </div>
              )}
              <div className="pr-transaction-row">
                <span className="pr-transaction-label">Date</span>
                <span className="pr-transaction-value pr-transaction-date">{formattedDate}</span>
              </div>
              {trackingNumber && (
                <div className="pr-transaction-row">
                  <span className="pr-transaction-label">Tracking Number</span>
                  <span className="pr-transaction-value pr-transaction-id">#{trackingNumber}</span>
                </div>
              )}
            </div>
          )}

          {isError && (
            <p className="pr-message" style={{ display: 'none' }} aria-hidden="true">
              Your {paymentMethod} payment was not completed. No charges were made.
            </p>
          )}

          {isProcessing && (
            <p className="pr-message" style={{ display: 'none' }} aria-hidden="true">
              {subtitle}
            </p>
          )}

          {/* ── Actions ──────────────────────────────────────────── */}
          <div className="pr-actions">
            {isSuccess && (
              <button
                ref={btnRef}
                type="button"
                className="btn pr-btn-success w-full justify-center"
                onClick={onClose}
              >
                Done
              </button>
            )}

            {isError && onRetry && (
              <button
                ref={btnRef}
                type="button"
                className="btn pr-btn-primary w-full justify-center"
                onClick={handleRetry}
              >
                Try Again
              </button>
            )}

            {isProcessing && onRetry && (
              <button
                ref={btnRef}
                type="button"
                className="btn pr-btn-primary w-full justify-center"
                onClick={handleRetry}
              >
                Refresh Status
              </button>
            )}

            {(isError || isProcessing) && (
              <button
                ref={!onRetry ? btnRef : undefined}
                type="button"
                className={`btn w-full justify-center ${isError ? 'pr-btn-danger' : 'btn-outline pr-btn-outline'}`}
                onClick={onClose}
              >
                {isError ? 'Back' : 'Close'}
              </button>
            )}
          </div>
        </div>
      </div>
    </FocusTrap>,
    document.body
  );
};

export default PaymentResultModal;
