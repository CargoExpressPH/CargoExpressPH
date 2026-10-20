import { useMemo, useState, useId } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, MapPin, CheckCircle, AlertTriangle } from 'lucide-react';
import FocusTrap from './FocusTrap';
import { orderPartyName } from '../../lib/orderParties';
import { maskPersonName } from '../../utils/maskName';
import { normalizeTrackingNumber } from '../../utils/scanPayload';

const SHORT_CODE_LENGTH = 6;

const compactTracking = (trackingNumber) => String(trackingNumber || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();

/**
 * Case A of the field fallbacks: the QR is unreadable but the printed tracking
 * number (or its 6-character short code, the last six characters of it) is
 * not. Matches only against the active trip's own manifest, so a typed code
 * can never pull in a box that is not on this van.
 */
export const findManifestMatches = (orders, input) => {
  const value = String(input || '').trim();
  if (!value) return [];
  const tracking = normalizeTrackingNumber(value);
  if (tracking) return orders.filter((o) => o.tracking_number?.toUpperCase() === tracking);
  const code = compactTracking(value);
  if (code.length !== SHORT_CODE_LENGTH) return [];
  return orders.filter((o) => compactTracking(o.tracking_number).endsWith(code));
};

const ManualBoxMatchOverlay = ({
  orders,
  heldKeys,
  busy,
  onConfirm,
  onNotInManifest,
  onClose,
}) => {
  const titleId = useId();
  const inputId = useId();
  const [input, setInput] = useState('');
  const [searched, setSearched] = useState(false);
  const [matches, setMatches] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [box, setBox] = useState(null);

  const selected = useMemo(() => matches.find((o) => o.id === selectedId) || null, [matches, selectedId]);

  const openBoxesFor = (order) => {
    const qty = order.package_quantity || 1;
    const verified = order.verified_boxes || [];
    return Array.from({ length: qty }, (_, i) => i + 1)
      .filter((b) => !verified.includes(b) && !heldKeys.has(`${order.id}:${b}`));
  };

  const select = (order) => {
    setSelectedId(order.id);
    setBox(openBoxesFor(order)[0] || null);
  };

  const handleSearch = (event) => {
    event.preventDefault();
    const value = input.trim();
    if (!value) return;
    const found = findManifestMatches(orders, value);
    setSearched(true);
    setMatches(found);
    if (found.length === 1) select(found[0]);
    else { setSelectedId(null); setBox(null); }
    if (found.length === 0) onNotInManifest?.(value);
  };

  const openBoxes = selected ? openBoxesFor(selected) : [];

  return createPortal(
    <FocusTrap active>
      <div
        className="modal-overlay trip-scanner-sheet-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div className="trip-scanner-sheet" onClick={(e) => e.stopPropagation()}>
          <div className="trip-scanner-sheet-head">
            <h3 id={titleId} className="trip-scanner-sheet-title">Can&apos;t scan the QR?</h3>
            <button type="button" className="btn-icon btn-ghost" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
          <p className="trip-scanner-sheet-hint">
            Type the tracking number printed on the label, or its last 6 characters.
            Then check the details below against the box in your hands.
          </p>

          <form className="trip-scanner-manual-form" onSubmit={handleSearch}>
            <input
              id={inputId}
              type="text"
              className="trip-scanner-manual-input"
              placeholder="CE-20261019-1234 or 191234"
              value={input}
              onChange={(e) => { setInput(e.target.value); setSearched(false); }}
              autoCapitalize="characters"
              autoComplete="off"
              autoFocus
              aria-label="Tracking number or 6-character code"
            />
            <button type="submit" className="btn btn-outline btn-sm trip-scanner-manual-btn" disabled={!input.trim()}>
              <Search size={14} className="inline mr-4" /> Find
            </button>
          </form>

          {searched && matches.length === 0 && (
            <div className="trip-scanner-notice trip-scanner-notice-danger" role="alert">
              <AlertTriangle size={15} className="trip-scanner-notice-icon" aria-hidden="true" />
              <span>Not on this trip&apos;s manifest. Do not load it.</span>
            </div>
          )}

          {matches.length > 1 && (
            <div className="trip-scanner-candidates" role="listbox" aria-label="Matching bookings">
              {matches.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="option"
                  aria-selected={o.id === selectedId}
                  className={`trip-scanner-candidate ${o.id === selectedId ? 'is-selected' : ''}`}
                  onClick={() => select(o)}
                >
                  <strong>{o.tracking_number}</strong>
                  <span>{maskPersonName(orderPartyName(o, 'receiver')) || 'Receiver'}</span>
                </button>
              ))}
            </div>
          )}

          {selected && (
            <div className="trip-scanner-verify-card">
              <div className="trip-scanner-verify-row">
                <span className="trip-scanner-verify-label">Receiver</span>
                <span className="trip-scanner-verify-value">
                  {maskPersonName(orderPartyName(selected, 'receiver')) || 'Receiver'}
                </span>
              </div>
              <div className="trip-scanner-verify-row">
                <span className="trip-scanner-verify-label">Tracking</span>
                <span className="trip-scanner-verify-value">{selected.tracking_number}</span>
              </div>
              <div className="trip-scanner-verify-row">
                <span className="trip-scanner-verify-label">Destination</span>
                <span className="trip-scanner-verify-value">
                  <MapPin size={11} aria-hidden="true" /> {[selected.receiver_city, selected.receiver_province].filter(Boolean).join(', ') || '—'}
                </span>
              </div>
              {selected.actual_weight ? (
                <div className="trip-scanner-verify-row">
                  <span className="trip-scanner-verify-label">Weight</span>
                  <span className="trip-scanner-verify-value">{selected.actual_weight} kg total</span>
                </div>
              ) : null}

              {openBoxes.length === 0 ? (
                <div className="trip-scanner-notice trip-scanner-notice-warning" role="status">
                  <AlertTriangle size={15} className="trip-scanner-notice-icon" aria-hidden="true" />
                  <span>Every box of this booking is already accounted for.</span>
                </div>
              ) : (
                <>
                  <div className="trip-scanner-verify-label mt-8">Which box is in your hands?</div>
                  <div className="trip-scanner-box-chips">
                    {openBoxes.map((b) => (
                      <button
                        key={b}
                        type="button"
                        className={`trip-scanner-box-chip ${b === box ? 'is-selected' : ''}`}
                        aria-pressed={b === box}
                        onClick={() => setBox(b)}
                      >
                        Box {b} of {selected.package_quantity || 1}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary trip-scanner-sheet-confirm"
                    disabled={!box || busy}
                    onClick={() => onConfirm(selected, box)}
                  >
                    <CheckCircle size={15} className="inline mr-4" /> Confirm Match
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </FocusTrap>,
    document.body,
  );
};

export default ManualBoxMatchOverlay;
