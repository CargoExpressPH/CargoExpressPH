import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Loader } from 'lucide-react';
import FocusTrap from './FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';

/**
 * PaymentResultModal — Premium modal for GCash payment outcomes.
 *
 * @param {boolean}   isOpen         - Whether the modal is visible
 * @param {function}  onClose        - Called when the modal is dismissed
 * @param {'success'|'error'|'processing'} variant - Visual mode
 * @param {number}    [amount]       - Payment amount (e.g. 1250)
 * @param {string}    [trackingNumber] - Order tracking number
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

  const title = isSuccess ? 'Payment Confirmed!'
    : isError ? 'Payment Not Completed'
    : 'Payment Processing';

  const formattedAmount = typeof amount === 'number' && amount > 0
    ? `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : null;

  const handleOverlay = (e) => {
    // Don't dismiss on overlay click while processing
    if (e.target === e.currentTarget && !isProcessing) onClose();
  };

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
        onClick={handleOverlay}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        <div
          className="payment-result-modal"
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
                <circle cx="26" cy="26" r="24" stroke="currentColor" strokeWidth="3" opacity="0.3" />
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

          {isSuccess && (
            <div id={descId} className="pr-body">
              {formattedAmount && (
                <div className="pr-amount">{formattedAmount}</div>
              )}
              {trackingNumber && (
                <div className="pr-tracking">{trackingNumber}</div>
              )}
              {paymentMethod && (
                <span className="pr-method-badge">{paymentMethod}</span>
              )}
            </div>
          )}

          {isError && (
            <p id={descId} className="pr-message">
              Your {paymentMethod} payment was not completed. No charges were made to your account.
            </p>
          )}

          {isProcessing && (
            <p id={descId} className="pr-message">
              Your {paymentMethod} payment is being confirmed. This usually takes a few seconds.
            </p>
          )}

          {/* ── Actions ──────────────────────────────────────────── */}
          <div className="pr-actions">
            {isSuccess && (
              <button
                ref={btnRef}
                type="button"
                className="btn btn-success w-full justify-center"
                onClick={onClose}
              >
                Done
              </button>
            )}

            {isError && onRetry && (
              <button
                ref={btnRef}
                type="button"
                className="btn btn-primary w-full justify-center"
                onClick={handleRetry}
              >
                Try Again
              </button>
            )}

            {isProcessing && onRetry && (
              <button
                ref={btnRef}
                type="button"
                className="btn btn-primary w-full justify-center"
                onClick={handleRetry}
              >
                Refresh Status
              </button>
            )}

            {(isError || isProcessing) && (
              <button
                ref={!onRetry ? btnRef : undefined}
                type="button"
                className="btn btn-outline w-full justify-center"
                onClick={onClose}
              >
                Close
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
