import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { getTrips } from '../../lib/database';
import { X, Truck, Loader, MapPin, AlertTriangle } from 'lucide-react';
import FocusTrap from './FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';
import useFieldErrors from '../../hooks/useFieldErrors';
import FieldError, { errorId } from './FieldError';
import { tripCapacityState } from '../../constants/status';

/**
 * TripAssignModal — Assign an order to an available trip
 * Only shows trips that match the order's route (origin → destination)
 */
const TripAssignModal = ({ order, onClose, onAssign }) => {
  useScrollLock(true); // mounted only while open

  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTrip, setSelectedTrip] = useState(null);
  const [saving, setSaving] = useState(false);
  const { errors, validate, clearError, containerRef } = useFieldErrors();

  const handleSafeClose = () => {
    if (!saving) {
      onClose();
    }
  };

  useEffect(() => {
    loadTrips();
  }, []);

  const loadTrips = async () => {
    try {
      const data = await getTrips('active');
      // Filter trips matching this order's route
      const matching = (data || []).filter(t =>
        t.origin === order.origin && t.destination === order.destination
      );
      setTrips(matching);
    } catch (err) {
      // Trip loading failed silently — empty list shown
    } finally {
      setLoading(false);
    }
  };

  const orderWeight = parseFloat(order.actual_weight || 0) || 0;

  /** The capacity verdict for one trip, given this order's weight. */
  const capacityFor = (trip) =>
    tripCapacityState(trip, trip.current_weight || 0, orderWeight);

  const handleAssign = async () => {
    // The confirm button used to be disabled until a trip was picked, which
    // silently refused the click without ever saying a trip was what was
    // missing. It is enabled now and rejects out loud, like every other form.
    const cap = selectedTrip ? capacityFor(selectedTrip) : null;
    if (!validate({
      trip: !selectedTrip
        ? 'Please select a trip to assign this order to.'
        // Belt and braces with the disabled option below: a full trip cannot be
        // selected, so this only fires if one filled up between the modal
        // opening and the click. The data layer refuses it as well.
        : cap.wouldExceed
          ? `Cannot accept booking: exceeds maximum van capacity of ${cap.max} kg `
            + `(${cap.base} kg planned + ${cap.allowance} kg allowance).`
          : null,
    })) return;

    setSaving(true);
    try {
      await onAssign(selectedTrip.id);
    } catch (err) {
      // Assignment error handled by parent
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        handleSafeClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saving, onClose]);

  return createPortal(
    <FocusTrap active>
    <div className="modal-overlay" onClick={handleSafeClose} role="dialog" aria-modal="true" aria-labelledby="trip-assign-title" aria-describedby="trip-assign-desc">
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <h3 id="trip-assign-title"><Truck size={18} className="inline mr-8" aria-hidden="true" />Assign to Trip</h3>
          <button className="btn-icon btn-ghost" onClick={handleSafeClose} disabled={saving} aria-label="Close trip assignment modal"><X size={20} aria-hidden="true" /></button>
        </div>

        <div className="modal-body" ref={containerRef}>
          <div id="trip-assign-desc" className="text-secondary mb-16 bg-surface br-8" style={{padding: 12,
            fontSize: '0.8125rem'
          }}>
            <MapPin size={14} className="inline mr-6" />
            Route: <strong>{order.origin} → {order.destination}</strong>
          </div>

          {loading ? (
            <div className="text-center" style={{ padding: 30 }}>
              <Loader size={24} className="animate-spin mx-auto" />
            </div>
          ) : trips.length === 0 ? (
            <div className="text-center text-tertiary" style={{ padding: 30 }}>
              <Truck size={40} style={{ opacity: 0.3, margin: '0 auto 12px' }} />
              <p>No active trips for this route</p>
              <p className="text-xs mt-4">Create a trip with matching origin/destination first</p>
            </div>
          ) : (
            <div
              className={`flex flex-col gap-8 ${errors.trip ? 'field-group-invalid' : ''}`}
              role="group"
              aria-label="Available trips"
              aria-invalid={errors.trip ? 'true' : undefined}
              aria-describedby={errors.trip ? errorId('trip') : undefined}
              tabIndex={errors.trip ? -1 : undefined}
            >
              {trips.map(trip => {
                const isSelected = selectedTrip?.id === trip.id;
                const capPct = trip.capacity > 0 ? (trip.current_weight / trip.capacity) * 100 : 0;
                const cap = capacityFor(trip);
                // Two different refusals: the trip is already at its ceiling,
                // or it has room but not enough for THIS parcel. Both block.
                const blocked = cap.wouldExceed || cap.isFull;
                // Still worth flagging the softer state — past the planned
                // capacity but inside the 200 kg allowance — because that is
                // an overbook the admin is choosing, not one being refused.
                const usingAllowance = !blocked && cap.isOverPlanned;

                return (
                  <button
                    type="button"
                    key={trip.id}
                    onClick={() => { if (blocked) return; setSelectedTrip(trip); clearError('trip'); }}
                    disabled={blocked}
                    aria-pressed={isSelected}
                    aria-label={
                      `Select trip ${trip.trip_number}, ${trip.status}, `
                      + `${(trip.current_weight || 0).toFixed(1)} of ${trip.capacity} kilograms used`
                      + (blocked ? `. Unavailable: at or over the ${cap.max} kilogram maximum.` : '')
                    }
                    className={`block w-full text-left ${blocked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                    style={{padding: 14, borderRadius: 'var(--radius-sm)', border: `2px solid ${isSelected ? 'var(--primary)' : 'var(--border)'}`,
                      background: isSelected ? 'var(--primary-glow)' : 'var(--surface)',
                      color: 'inherit',
                      font: 'inherit',
                      opacity: blocked ? 0.55 : 1,
                      transition: 'all 0.2s ease',
                    }}
                  >
                    <div className="flex justify-between items-center mb-6">
                      <span className="fw-700 text-accent">{trip.trip_number}</span>
                      <span style={{
                        fontSize: '0.6875rem', fontWeight: 600, padding: '2px 8px',
                        borderRadius: 'var(--radius-xs)',
                        background: cap.isFull ? 'var(--error-bg)' : trip.status === 'scheduled' ? 'var(--info-bg)' : 'var(--primary-bg)',
                        color: cap.isFull ? 'var(--error-text)' : trip.status === 'scheduled' ? 'var(--info)' : 'var(--primary)',
                      }}>
                        {cap.isFull ? 'FULL' : trip.status}
                      </span>
                    </div>
                    <div className="text-secondary mb-6" style={{ fontSize: '0.8125rem' }}>
                      {trip.origin} → {trip.destination}
                    </div>
                    <div className="capacity-bar" style={{ height: 6, borderRadius: 'var(--radius-full)' }}>
                      <div
                        className={`capacity-fill ${capPct > 80 ? 'warning' : ''}`}
                        style={{ width: `${Math.min(100, capPct)}%` }}
                      />
                    </div>
                    <div className="text-tertiary mt-4" style={{ fontSize: '0.6875rem' }}>
                      Booked: {(trip.current_weight || 0).toFixed(1)} / {trip.capacity} kg
                      {cap.hasLimit && <> (Max allowance: {cap.max} kg)</>}
                    </div>
                    {blocked && (
                      <div className="flex items-center gap-4 mt-6" style={{ fontSize: '0.6875rem', color: 'var(--error-text)' }}>
                        <AlertTriangle size={12} aria-hidden="true" />
                        {cap.isFull
                          ? `Full — at the ${cap.max} kg maximum. No further bookings.`
                          : `Would exceed the ${cap.max} kg maximum by ${cap.overBy.toFixed(1)} kg.`}
                      </div>
                    )}
                    {usingAllowance && (
                      <div className="flex items-center gap-4 mt-6 text-warning" style={{ fontSize: '0.6875rem' }}>
                        <AlertTriangle size={12} aria-hidden="true" />
                        Over planned capacity — using the {cap.allowance} kg allowance
                        ({cap.remaining.toFixed(1)} kg left).
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <FieldError name="trip" errors={errors} />
        </div>

        <div className="modal-footer">
          <button className="btn btn-outline" onClick={handleSafeClose} disabled={saving}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleAssign}
            disabled={saving || trips.length === 0 || (selectedTrip && capacityFor(selectedTrip).wouldExceed)}
          >
            {saving ? <Loader size={16} className="animate-spin" /> : null}
            Assign to {selectedTrip?.trip_number || 'Trip'}
          </button>
        </div>
      </div>
    </div>
    </FocusTrap>,
    document.body
  );
};

export default TripAssignModal;
