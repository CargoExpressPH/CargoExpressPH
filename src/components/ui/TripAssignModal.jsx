import { useState, useEffect } from 'react';
import { getTrips } from '../../lib/database';
import { X, Truck, Loader, MapPin, AlertTriangle } from 'lucide-react';
import FocusTrap from './FocusTrap';

/**
 * TripAssignModal — Assign an order to an available trip
 * Only shows trips that match the order's route (origin → destination)
 */
const TripAssignModal = ({ order, onClose, onAssign }) => {
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTrip, setSelectedTrip] = useState(null);
  const [saving, setSaving] = useState(false);

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

  const handleAssign = async () => {
    if (!selectedTrip) return;
    setSaving(true);
    try {
      await onAssign(selectedTrip.id);
    } catch (err) {
      // Assignment error handled by parent
    } finally {
      setSaving(false);
    }
  };

  return (
    <FocusTrap active>
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="trip-assign-title">
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <h3 id="trip-assign-title"><Truck size={18} className="inline mr-8" />Assign to Trip</h3>
          <button className="btn-icon btn-ghost" onClick={onClose} aria-label="Close trip assignment"><X size={20} /></button>
        </div>

        <div className="modal-body">
          <div className="text-secondary mb-16" style={{
            background: 'var(--bg)', borderRadius: 8, padding: 12,
            fontSize: '0.8125rem',
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
            <div className="flex flex-col gap-8">
              {trips.map(trip => {
                const isSelected = selectedTrip?.id === trip.id;
                const capPct = trip.capacity > 0 ? (trip.current_weight / trip.capacity) * 100 : 0;
                const orderWeight = parseFloat(order.actual_weight || order.package_weight || 0);
                const availableWeight = trip.capacity > 0 ? Number(trip.capacity) - Number(trip.current_weight || 0) : Infinity;
                const exceedsCapacity = trip.capacity > 0 && orderWeight > availableWeight;
                const overloadWeight = Math.max(0, orderWeight - availableWeight);

                return (
                  <button
                    type="button"
                    key={trip.id}
                    onClick={() => setSelectedTrip(trip)}
                    aria-pressed={isSelected}
                    aria-label={`Select trip ${trip.trip_number}, ${trip.status}, ${(trip.current_weight || 0).toFixed(1)} of ${trip.capacity} kilograms used`}
                    style={{
                      display: 'block',
                      width: '100%',
                      padding: 14, borderRadius: 10, cursor: 'pointer',
                      border: `2px solid ${isSelected ? 'var(--primary)' : 'var(--border)'}`,
                      background: isSelected ? 'var(--primary-glow)' : 'var(--surface)',
                      color: 'inherit',
                      font: 'inherit',
                      textAlign: 'left',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    <div className="flex justify-between items-center mb-6">
                      <span className="fw-700 text-accent">{trip.trip_number}</span>
                      <span style={{
                        fontSize: '0.6875rem', fontWeight: 600, padding: '2px 8px',
                        borderRadius: 4,
                        background: trip.status === 'scheduled' ? 'var(--info-bg)' : 'var(--primary-bg)',
                        color: trip.status === 'scheduled' ? 'var(--info)' : 'var(--primary)',
                      }}>
                        {trip.status}
                      </span>
                    </div>
                    <div className="text-secondary mb-6" style={{ fontSize: '0.8125rem' }}>
                      {trip.origin} → {trip.destination}
                    </div>
                    <div className="capacity-bar" style={{ height: 6, borderRadius: 3 }}>
                      <div
                        className={`capacity-fill ${capPct > 80 ? 'warning' : ''}`}
                        style={{ width: `${Math.min(100, capPct)}%` }}
                      />
                    </div>
                    <div className="text-tertiary mt-4" style={{ fontSize: '0.6875rem' }}>
                      {(trip.current_weight || 0).toFixed(1)} / {trip.capacity} kg
                    </div>
                    {exceedsCapacity && (
                      <div className="flex items-center gap-4 mt-6 text-warning" style={{ fontSize: '0.6875rem' }}>
                        <AlertTriangle size={12} />
                        Exceeds capacity by {overloadWeight.toFixed(1)} kg. Admin override allowed.
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleAssign}
            disabled={!selectedTrip || saving}
          >
            {saving ? <Loader size={16} className="animate-spin" /> : null}
            Assign to {selectedTrip?.trip_number || 'Trip'}
          </button>
        </div>
      </div>
    </div>
    </FocusTrap>
  );
};

export default TripAssignModal;
