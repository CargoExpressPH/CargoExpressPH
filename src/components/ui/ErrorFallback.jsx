import { AlertTriangle, RefreshCw } from 'lucide-react';

const ErrorFallback = ({ message = 'This section failed to load.', onRetry }) => (
  <div className="error-section-fallback">
    <AlertTriangle size={20} color="var(--warning)" />
    <span>{message}</span>
    {onRetry && (
      <button
        type="button"
        onClick={onRetry}
        className="btn btn-ghost btn-sm inline-flex items-center gap-4"
      >
        <RefreshCw size={14} /> Retry
      </button>
    )}
  </div>
);

export default ErrorFallback;
