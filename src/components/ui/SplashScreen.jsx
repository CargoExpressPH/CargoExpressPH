import { useEffect, useState } from 'react';
import { BrandLogo, BrandWordmark } from './BrandLogo';

const DEFAULT_SLOW_MESSAGE = 'This is taking longer than expected. You can safely retry.';
const OFFLINE_MESSAGE = 'You appear to be offline. Reconnect to continue.';

/**
 * Branded full-screen state for true application-level waits only: initial
 * session restoration and payment-return verification. Lazy route chunks use
 * PageLoader so the surrounding application chrome remains visible.
 */
const SplashScreen = ({
  message = 'Getting CargoExpress PH ready…',
  slowMessage = DEFAULT_SLOW_MESSAGE,
  slowAfterMs = 8000,
  showProgress = true,
  allowRetry = true,
  title,
}) => {
  const [isSlow, setIsSlow] = useState(false);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine !== false);

  useEffect(() => {
    if (!showProgress || slowAfterMs <= 0) return undefined;
    setIsSlow(false);
    const timeoutId = window.setTimeout(() => setIsSlow(true), slowAfterMs);
    return () => window.clearTimeout(timeoutId);
  }, [message, showProgress, slowAfterMs]);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const needsHelp = showProgress && (isSlow || !isOnline);
  const statusMessage = !isOnline ? OFFLINE_MESSAGE : isSlow ? slowMessage : message;

  return (
    <main className="loading-screen" aria-busy={showProgress ? 'true' : 'false'}>
      <div className="loading-screen__content">
        <div className="loading-screen__mark" aria-hidden="true">
          <BrandLogo size={56} decorative />
        </div>

        <div className="loading-brand" aria-hidden="true">
          <BrandWordmark tone="on-dark" />
        </div>

        {title && <h1 className="loading-screen__title">{title}</h1>}

        {showProgress && (
          <div className="loading-screen__progress" aria-hidden="true">
            <span />
          </div>
        )}

        <p className="loading-screen__status" role="status" aria-live="polite" aria-atomic="true">
          {statusMessage}
        </p>

        {needsHelp && allowRetry && (
          <button
            type="button"
            className="loading-screen__retry"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        )}
      </div>
    </main>
  );
};

export default SplashScreen;
