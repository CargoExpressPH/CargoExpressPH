import { Clock } from 'lucide-react';

/**
 * The status mark shared by the result screens: the GCash payment return page
 * and the booking confirmations (customer Book, admin Create Booking).
 * A solid circle whose check or cross draws itself once, a clock for "still
 * checking", or a ring spinner while the result loads. Decorative: every
 * screen that uses it states the result in its heading.
 *
 * @param {'success'|'error'|'pending'|'loading'} tone
 */
export default function ResultIcon({ tone = 'success', className = '' }) {
  return (
    <span className={`result-icon result-icon--${tone}${className ? ` ${className}` : ''}`} aria-hidden="true">
      {tone === 'success' && (
        <svg viewBox="0 0 52 52" fill="none">
          <path className="result-icon-check" d="M15 27l7 7 15-15" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {tone === 'error' && (
        <svg viewBox="0 0 52 52" fill="none">
          <path className="result-icon-cross" d="M18 18l16 16M34 18l-16 16" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        </svg>
      )}
      {tone === 'pending' && <Clock size={32} strokeWidth={2.2} />}
      {tone === 'loading' && <span className="result-icon-spinner" />}
    </span>
  );
}
