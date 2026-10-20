import { useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle, Loader, ShieldCheck } from 'lucide-react';
import FocusTrap from './FocusTrap';

export const SHORTFALL_REASONS = [
  { value: 'missing_from_staging', label: 'Missing from staging area' },
  { value: 'damaged_at_hub', label: 'Damaged at hub' },
  { value: 'held_by_customs', label: 'Held by customs' },
  { value: 'other', label: 'Other' },
];

/**
 * Replaces the dead end when a driver finishes loading with boxes unscanned.
 * Lists exactly which boxes are missing, takes one reason, and releases the
 * trip with a code that belongs to a different admin (checked server-side).
 * `onSubmit({ reason, supervisorCode })` must throw to keep the dialog open.
 */
const ShortfallModal = ({ tripNumber, missing, onSubmit, onClose }) => {
  const titleId = useId();
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const canSubmit = Boolean(reason && code.trim()) && !saving;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    try {
      await onSubmit({ reason, supervisorCode: code.trim() });
    } catch (err) {
      setError(err?.message || 'Could not report the shortfall. Try again.');
      setSaving(false);
    }
  };

  return createPortal(
    <FocusTrap active>
      <div
        className="modal-overlay trip-scanner-sheet-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
      >
        <form className="trip-scanner-sheet" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
          <div className="trip-scanner-sheet-head">
            <h3 id={titleId} className="trip-scanner-sheet-title">Report Shortfall</h3>
            <button type="button" className="btn-icon btn-ghost" onClick={onClose} disabled={saving} aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div className="trip-scanner-notice trip-scanner-notice-warning" role="status">
            <AlertTriangle size={15} className="trip-scanner-notice-icon" aria-hidden="true" />
            <span>
              {missing.length} box{missing.length === 1 ? '' : 'es'} not loaded on trip {tripNumber}.
              A supervisor must approve leaving without {missing.length === 1 ? 'it' : 'them'}.
            </span>
          </div>

          <ul className="trip-scanner-shortfall-list">
            {missing.map((m) => (
              <li key={`${m.order.id}:${m.box}`}>
                <strong>{m.order.tracking_number}</strong> — Box {m.box} of {m.order.package_quantity || 1}
              </li>
            ))}
          </ul>

          <label className="trip-scanner-verify-label" htmlFor={`${titleId}-reason`}>Reason</label>
          <select
            id={`${titleId}-reason`}
            className="form-select"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={saving}
          >
            <option value="">Select a reason…</option>
            {SHORTFALL_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>

          <label className="trip-scanner-verify-label mt-8" htmlFor={`${titleId}-code`}>Supervisor approval code</label>
          <input
            id={`${titleId}-code`}
            type="password"
            className="form-input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
            placeholder="Code of a different admin"
            disabled={saving}
          />

          {error && (
            <div className="trip-scanner-notice trip-scanner-notice-danger mt-8" role="alert">
              <AlertTriangle size={15} className="trip-scanner-notice-icon" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" className="btn btn-primary trip-scanner-sheet-confirm" disabled={!canSubmit}>
            {saving
              ? <><Loader size={15} className="animate-spin inline mr-4" /> Releasing…</>
              : <><ShieldCheck size={15} className="inline mr-4" /> Approve &amp; Release Trip</>}
          </button>
        </form>
      </div>
    </FocusTrap>,
    document.body,
  );
};

export default ShortfallModal;
