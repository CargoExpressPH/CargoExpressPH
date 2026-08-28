import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { searchCustomerDirectory } from '../../lib/database';
import { X, UserPlus, Loader, Search, AlertTriangle } from 'lucide-react';
import FocusTrap from './FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';
import useFieldErrors from '../../hooks/useFieldErrors';
import FieldError, { errorId } from './FieldError';

/**
 * AssignCustomerModal — link a guest ("walk-in") booking to a registered
 * customer account.
 *
 * AdminCreateBookingPage inserts a walk-in booking under the ADMIN's own
 * account, on purpose, so a customer who doesn't want to register still gets
 * a trackable order. Once that person registers for real, this is how an
 * admin moves the booking onto their account so it joins their history.
 */
const AssignCustomerModal = ({ order, onClose, onAssign }) => {
  useScrollLock(true); // mounted only while open

  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(null);
  const [saving, setSaving] = useState(false);
  const { errors, validate, clearError, containerRef } = useFieldErrors();

  const handleSafeClose = () => {
    if (!saving) onClose();
  };

  // Debounced directory search, same 300ms rhythm as the Inbox's customer
  // lookup — searchCustomerDirectory already scopes to role = 'customer', so
  // an admin or another guest-only booking can never show up as a target.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      setSearching(false);
      return undefined;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const data = await searchCustomerDirectory(term);
        if (!cancelled) setResults(data);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') handleSafeClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saving, onClose]);

  const handleAssign = async () => {
    if (!validate({
      customer: !selected ? 'Search for and select the customer this booking belongs to.' : null,
    })) return;

    setSaving(true);
    try {
      await onAssign(selected);
    } catch {
      // Assignment error handled by parent
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <FocusTrap active>
      <div
        className="modal-overlay"
        onClick={handleSafeClose}
        role="dialog"
        aria-modal="true"
        aria-labelledby="assign-customer-title"
        aria-describedby="assign-customer-desc"
      >
        <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
          <div className="modal-header">
            <h3 id="assign-customer-title">
              <UserPlus size={18} className="inline mr-8" aria-hidden="true" />
              Assign to Customer
            </h3>
            <button
              className="btn-icon btn-ghost"
              onClick={handleSafeClose}
              disabled={saving}
              aria-label="Close assign customer modal"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>

          <div className="modal-body" ref={containerRef}>
            <div
              id="assign-customer-desc"
              className="text-secondary mb-16 bg-surface br-8"
              style={{ padding: 12, fontSize: '0.8125rem' }}
            >
              <AlertTriangle size={14} className="inline mr-6" aria-hidden="true" />
              <strong>{order.tracking_number}</strong> was booked as a guest. Link it to the
              customer's registered account so it shows up in their order history.
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="assign-customer-search">
                Search registered customers
              </label>
              <div className="form-input-wrapper">
                <Search size={15} className="form-input-icon" aria-hidden="true" />
                <input
                  id="assign-customer-search"
                  className="form-input form-input-icon-left"
                  placeholder="Name or email…"
                  value={query}
                  onChange={e => { setQuery(e.target.value); setSelected(null); clearError('customer'); }}
                  autoComplete="off"
                />
              </div>
            </div>

            {searching && (
              <div className="text-center" style={{ padding: 16 }}>
                <Loader size={18} className="animate-spin mx-auto" aria-hidden="true" />
              </div>
            )}

            {!searching && query.trim().length >= 2 && results.length === 0 && (
              <div className="text-center text-tertiary text-sm" style={{ padding: 16 }}>
                No registered customer matches "{query.trim()}".
              </div>
            )}

            {!searching && results.length > 0 && (
              <div
                className={`flex flex-col gap-8 ${errors.customer ? 'field-group-invalid' : ''}`}
                role="group"
                aria-label="Matching customers"
                aria-invalid={errors.customer ? 'true' : undefined}
                aria-describedby={errors.customer ? errorId('customer') : undefined}
                tabIndex={errors.customer ? -1 : undefined}
              >
                {results.map(cust => {
                  const isSelected = selected?.id === cust.id;
                  return (
                    <button
                      type="button"
                      key={cust.id}
                      onClick={() => { setSelected(cust); clearError('customer'); }}
                      aria-pressed={isSelected}
                      className="block w-full text-left cursor-pointer flex items-center gap-10"
                      style={{
                        padding: 12,
                        borderRadius: 'var(--radius-sm)',
                        border: `2px solid ${isSelected ? 'var(--primary)' : 'var(--border)'}`,
                        background: isSelected ? 'var(--primary-glow)' : 'var(--surface)',
                        color: 'inherit',
                        font: 'inherit',
                      }}
                    >
                      <div className="sidebar-user-avatar w-32 h-32 text-xs flex-shrink-0">
                        {(cust.name || '?')[0].toUpperCase()}
                      </div>
                      <div className="min-width-0">
                        <div className="fw-700 text-sm truncate">{cust.name || 'Unnamed Customer'}</div>
                        <div className="text-xs text-tertiary truncate">
                          {cust.email}{cust.phone ? ` · ${cust.phone}` : ''}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            <FieldError name="customer" errors={errors} />
          </div>

          <div className="modal-footer">
            <button className="btn btn-outline" onClick={handleSafeClose} disabled={saving}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={handleAssign}
              disabled={saving || !selected}
            >
              {saving ? <Loader size={16} className="animate-spin" /> : null}
              Assign to {selected?.name || 'Customer'}
            </button>
          </div>
        </div>
      </div>
    </FocusTrap>,
    document.body
  );
};

export default AssignCustomerModal;
