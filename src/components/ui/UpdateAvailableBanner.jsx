import { useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import useServiceWorkerUpdate from '../../hooks/useServiceWorkerUpdate';

/**
 * UpdateAvailableBanner
 *
 * Tells the customer/admin a new deploy is already installed and in control
 * (see useServiceWorkerUpdate), and lets THEM choose when to actually load
 * it, instead of window.location.reload() firing on its own the instant the
 * new worker takes over. A silent reload mid-booking-form or mid-payment is
 * exactly the interruption this exists to avoid.
 *
 * Deliberately not a modal and not a toast:
 *   - No backdrop, nothing dimmed, nothing blocks the page underneath — this
 *     is a notice, not a decision the customer is forced to make right now.
 *   - No auto-dismiss timer. A toast that vanishes after a few seconds would
 *     recreate the exact problem this feature exists to solve: someone deep
 *     in a form who doesn't notice it in time loses the easy way to refresh.
 *     It stays until they act on it or close it.
 *
 * Rendered once, at the app root (see RootLayout in App.jsx), so it appears
 * on every route — a customer on /track or an admin on any page needs the
 * exact same notice.
 */
const UpdateAvailableBanner = () => {
  const { updateAvailable, reload } = useServiceWorkerUpdate();
  const [dismissed, setDismissed] = useState(false);

  if (!updateAvailable || dismissed) return null;

  return (
    <>
      <div className="sw-update-banner" role="status" aria-live="polite">
        <div className="sw-update-banner-card">
          <span className="sw-update-banner-text">
            <RefreshCw size={16} aria-hidden="true" />
            A new version of CargoExpress PH is available.
          </span>
          <div className="sw-update-banner-actions">
            <button type="button" className="sw-update-banner-refresh" onClick={reload}>
              Update Now
            </button>
            <button
              type="button"
              className="sw-update-banner-dismiss"
              onClick={() => setDismissed(true)}
              aria-label="Dismiss update notice"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      </div>

      <style>{`
        .sw-update-banner {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          z-index: 10000;
          display: flex;
          justify-content: center;
          padding: max(10px, env(safe-area-inset-top, 0px)) 12px 0;
          pointer-events: none;
          animation: swUpdateSlideDown 0.3s ease;
        }
        .sw-update-banner-card {
          pointer-events: auto;
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 12px;
          width: 100%;
          max-width: 640px;
          padding: 10px 10px 10px 16px;
          border-radius: var(--radius-md, 12px);
          background: var(--info-bg, #EFF6FF);
          color: var(--info-dark, #1E3A8A);
          border: 1px solid rgba(var(--info-rgb, 59, 130, 246), 0.35);
          box-shadow: var(--shadow-lg, 0 16px 36px rgba(15, 23, 42, 0.18));
          font-size: 0.8125rem;
          font-weight: 500;
        }
        .sw-update-banner-text {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 1;
          min-width: 200px;
        }
        .sw-update-banner-actions {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-left: auto;
        }
        .sw-update-banner-refresh {
          white-space: nowrap;
          padding: 8px 14px;
          min-height: 36px;
          border: none;
          border-radius: var(--radius-sm, 8px);
          background: var(--primary-fill, #16A34A);
          color: #fff;
          font-size: 0.8125rem;
          font-weight: 700;
          cursor: pointer;
        }
        .sw-update-banner-refresh:hover { filter: brightness(1.05); }
        .sw-update-banner-dismiss {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
          border: none;
          border-radius: var(--radius-sm, 8px);
          background: transparent;
          color: inherit;
          opacity: 0.7;
          cursor: pointer;
        }
        .sw-update-banner-dismiss:hover { opacity: 1; background: rgba(0,0,0,0.06); }

        @keyframes swUpdateSlideDown {
          from { transform: translateY(-100%); opacity: 0; }
          to   { transform: translateY(0);      opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .sw-update-banner { animation: none; }
        }
        @media (max-width: 480px) {
          .sw-update-banner-card {
            flex-direction: column;
            align-items: stretch;
            text-align: center;
            padding: 12px;
          }
          .sw-update-banner-actions {
            margin-left: 0;
            justify-content: center;
          }
          .sw-update-banner-refresh {
            flex: 1;
          }
        }
      `}</style>
    </>
  );
};

export default UpdateAvailableBanner;
