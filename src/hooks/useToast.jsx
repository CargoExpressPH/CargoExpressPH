import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { Check, XCircle, AlertTriangle, Info, X } from 'lucide-react';

/* ── Context ─────────────────────────────────────────────────────────── */
const ToastContext = createContext(null);

export const useToast = () => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
};

/* ── Provider ────────────────────────────────────────────────────────── */
export const ToastProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type = 'info', duration = 4000) => {
    const id = Date.now() + Math.random();
    setToasts(prev => {
      const next = [...prev, { id, message, type, duration }];
      return next.length > 4 ? next.slice(-4) : next;
    });
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const success = useCallback((msg, dur)  => addToast(msg, 'success', dur), [addToast]);
  const error   = useCallback((msg, dur)  => addToast(msg, 'error',   dur ?? 5000), [addToast]);
  const warning = useCallback((msg, dur)  => addToast(msg, 'warning', dur), [addToast]);
  const info    = useCallback((msg, dur)  => addToast(msg, 'info',    dur), [addToast]);

  return (
    <ToastContext.Provider value={{ success, error, warning, info, addToast }}>
      {children}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </ToastContext.Provider>
  );
};

/* ── Icons ───────────────────────────────────────────────────────────── */
const ICONS = {
  success: Check,
  error:   XCircle,
  warning: AlertTriangle,
  info:    Info,
};

const LABELS = {
  success: 'Success',
  error:   'Error',
  warning: 'Warning',
  info:    'Info',
};

/* ── Toast Item ──────────────────────────────────────────────────────── */
const ToastItem = ({ toast, onRemove }) => {
  const { id, message, type, duration = 4000 } = toast;
  const timerRef = useRef(null);
  const startTimeRef = useRef(null);
  const remainingTimeRef = useRef(duration);
  const [isHovered, setIsHovered] = useState(false);

  const startTimer = useCallback(() => {
    startTimeRef.current = Date.now();
    timerRef.current = setTimeout(() => {
      onRemove(id);
    }, remainingTimeRef.current);
  }, [id, onRemove]);

  const pauseTimer = useCallback(() => {
    clearTimeout(timerRef.current);
    remainingTimeRef.current -= Date.now() - startTimeRef.current;
  }, []);

  useEffect(() => {
    startTimer();
    return () => clearTimeout(timerRef.current);
  }, [startTimer]);

  const handleMouseEnter = () => {
    setIsHovered(true);
    pauseTimer();
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
    if (remainingTimeRef.current > 0) {
      startTimer();
    } else {
      onRemove(id);
    }
  };

  const Icon = ICONS[type] || Info;

  return (
    <div
      className={`toast toast-${type} ${isHovered ? 'toast-hovered' : ''}`}
      role="alert"
      aria-atomic="true"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{ '--toast-duration': `${duration}ms` }}
    >
      <div className="toast-icon-wrap">
        <Icon size={16} />
      </div>
      <div className="toast-body">
        <span className="toast-type-label">{LABELS[type]}</span>
        <span className="toast-message">{message}</span>
      </div>
      <button
        onClick={() => onRemove(id)}
        className="toast-close"
        aria-label="Dismiss notification"
      >
        <X size={14} />
      </button>
    </div>
  );
};

/* ── Toast Container ─────────────────────────────────────────────────── */
const ToastContainer = ({ toasts, onRemove }) => {
  if (!toasts.length) return null;
  return (
    <div className="toast-container" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} onRemove={onRemove} />
      ))}
    </div>
  );
};
