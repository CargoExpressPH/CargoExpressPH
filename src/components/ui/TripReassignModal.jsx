import { useState, useEffect } from 'react';
import { getTrips } from '../../lib/database';
import { X, Truck, Loader, MapPin, Edit3, AlertTriangle } from 'lucide-react';
import FocusTrap from './FocusTrap';

/**
 * TripReassignModal — Reassign an order to a different trip, requiring a reason
 */
const TripReassignModal = ({ order, onClose, onReassign }) => {
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTrip, setSelectedTrip] = useState(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(() => {
    loadTrips();
  }, []);

  const loadTrips = async () => {
    try {
      const data = await getTrips('active');
      // Filter trips matching this order's route, excluding the current trip
      const matching = (data || []).filter(t =>
        t.origin === order.origin && 
        t.destination === order.destination &&
        t.id !== order.trip_id
      );
      setTrips(matching);
    } catch (err) {
      // Trip loading failed silently
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmPrompt = () => {
    if (!selectedTrip || !reason.trim()) return;
    setShowConfirm(true);
  };

  const handleAssign = async () => {
    if (!selectedTrip || !reason.trim()) return;
    setSaving(true);
    try {
      await onReassign(selectedTrip.id, reason.trim());
    } catch (err) {
      // Error handled by parent
      setShowConfirm(false);
    } finally {
      setSaving(false);
    }
  };

  if (showConfirm) {
    return (
      <FocusTrap active>
        <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="confirm-reassign-title">
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <div className="modal-header">
              <h3 id="confirm-reassign-title"><AlertTriangle size={18} className="inline mr-8 text-warning" /> Confirm Reassignment</h3>
              <button className="btn-icon btn-ghost" onClick={() => setShowConfirm(false)} disabled={saving}><X size={20} /></button>
            </div>
            <div className="modal-body text-center">
              <p className="mb-16">Are you sure you want to change the trip assignment?</p>
              <div className="text-sm text-secondary bg-surface p-12 br-8 mb-20 text-left">
                <strong>New Trip:</strong> {selectedTrip?.trip_number}<br />
                <strong>Reason:</strong> {reason.trim()}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setShowConfirm(false)} disabled={saving}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAssign} disabled={saving}>
                {saving ? <Loader size={16} className="animate-spin" /> : 'Confirm & Reassign'}
              </button>
            </div>
          </div>
        </div>
      </FocusTrap>
    );
  }

  return (
    <FocusTrap active>
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="trip-reassign-title">
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h3 id="trip-reassign-title"><Edit3 size={18} className="inline mr-8" />Change Assigned Trip</h3>
          <button className="btn-icon btn-ghost" onClick={onClose} aria-label="Close modal"><X size={20} /></button>
        </div>

        <div className="modal-body">
          <div className="text-secondary mb-16" style={{
            background: 'var(--bg)', borderRadius: 8, padding: 12,
            fontSize: '0.8125rem',
          }}>
            <MapPin size={14} className="inline mr-6" />
            Route: <strong>{order.origin} → {order.destination}</strong><br />
            <div className="mt-4">
              Current Trip: <strong>{order.trips?.trip_number || 'None'}</strong>
            </div>
          </div>

          <div className="form-group mb-16">
            <label className="form-label required">Reason for Change</label>
            <textarea 
              className="form-control" 
              placeholder="e.g., Customer requested later departure, Capacity adjustment"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              required
            />
          </div>

          <label className="form-label required">Select New Trip</label>
          {loading ? (
            <div className="text-center" style={{ padding: 30 }}>
              <Loader size={24} className="animate-spin mx-auto" />
            </div>
          ) : trips.length === 0 ? (
            <div className="text-center text-tertiary" style={{ padding: 30 }}>
              <Truck size={40} style={{ opacity: 0.3, margin: '0 auto 12px' }} />
              <p>No other active trips for this route</p>
            </div>
          ) : (
            <div className="flex flex-col gap-8" style={{ maxHeight: '300px', overflowY: 'auto' }}>
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
                    aria-label={`Select trip ${trip.trip_number}`}
                    style={{
                      display: 'block',
                      width: '100%',
                      padding: 14, borderRadius: 10, cursor: 'pointer',
                      border: `2px solid ${isSelected ? 'var(--primary)' : 'var(--border)'}`,
                      background: isSelected ? 'var(--primary-glow)' : 'var(--surface)',
                      color: 'inherit',
                      font: 'inherit',
                      textAlign: 'left',
                      transition: 'all 0.2s',
                      opacity: exceedsCapacity ? 0.6 : 1
                    }}
                  >
                    <div className="flex items-center justify-between mb-4">
                      <strong className="text-sm">{trip.trip_number}</strong>
                      <span className="text-xs font-bold" style={{
                        color: trip.status === 'scheduled' ? 'var(--primary)' : 'var(--warning)',
                        textTransform: 'uppercase', letterSpacing: '0.05em'
                      }}>
                        {trip.status.replace('_', ' ')}
                      </span>
                    </div>
                    
                    <div className="flex items-center justify-between text-xs text-secondary mt-8">
                      <span>{new Date(trip.departure_date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                      <div className="flex items-center gap-6">
                        <span style={{ color: exceedsCapacity ? 'var(--danger)' : 'inherit' }}>
                          {(trip.current_weight || 0).toFixed(1)} / {trip.capacity || '∞'} kg
                        </span>
                        <div style={{ width: 40, height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ 
                            height: '100%', 
                            background: exceedsCapacity ? 'var(--danger)' : capPct > 80 ? 'var(--warning)' : 'var(--success)',
                            width: `${Math.min(100, capPct)}%`
                          }} />
                        </div>
                      </div>
                    </div>

                    {exceedsCapacity && (
                      <div className="text-xs mt-6 flex items-center gap-4" style={{ color: 'var(--danger)' }}>
                        <AlertTriangle size={12} />
                        Overloads trip by {overloadWeight.toFixed(1)} kg
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
            onClick={handleConfirmPrompt} 
            disabled={!selectedTrip || !reason.trim() || saving}
          >
            {saving ? <Loader size={16} className="animate-spin" /> : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
    </FocusTrap>
  );
};

export default TripReassignModal;
