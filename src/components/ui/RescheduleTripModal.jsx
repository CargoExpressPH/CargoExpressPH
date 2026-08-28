import { useState } from 'react';
import { createPortal } from 'react-dom';
import { findDuplicateTrip, duplicateTripMessage } from '../../lib/database';
import { phLocalInputToISO, isoToPhLocalInput } from '../../utils/datetime';
import { X, Calendar, Loader } from 'lucide-react';
import FocusTrap from './FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';
import useFieldErrors from '../../hooks/useFieldErrors';
import FieldError from './FieldError';

/**
 * RescheduleTripModal — move a still-'scheduled' trip's departure/ETA.
 *
 * Exists for the case CreateTripPage can't help with: cargo is still coming
 * in and the admin needs to push the departure back, or a route needs to
 * leave earlier than planned. Reuses the exact same duplicate-route guard
 * CreateTripPage runs before booking a NEW trip — a reschedule that lands on
 * a day another trip already owns for this route is exactly as invalid as
 * creating one there would have been, so it gets the same pre-flight check
 * (excluding this trip itself) and the same unique index behind it
 * (trips_unique_route_departure_day, 20260818090000) as the real gate.
 *
 * Pushing departure_date into the future also happens to clear
 * guard_customer_order_insert's "this trip is no longer accepting bookings"
 * check (20260822130000) — that trigger only compares departure_date to
 * now(), so a trip that slipped into the past starts accepting bookings
 * again the moment this saves a later date. Nothing else has to change for
 * that; it's just what the guard already does with an updated timestamp.
 */
const RescheduleTripModal = ({ trip, onClose, onReschedule }) => {
  useScrollLock(true); // mounted only while open

  const [form, setForm] = useState({
    departure_date: isoToPhLocalInput(trip.departure_date),
    arrival_date: isoToPhLocalInput(trip.arrival_date),
  });
  const [saving, setSaving] = useState(false);
  const { errors, validate, clearError, setError, containerRef } = useFieldErrors();

  const u = (k, v) => {
    setForm((p) => ({ ...p, [k]: v }));
    clearError(k);
  };

  const handleSafeClose = () => {
    if (!saving) onClose();
  };

  const handleSave = async () => {
    const ok = validate({
      departure_date: !form.departure_date
        ? 'Departure date is required.'
        : new Date(phLocalInputToISO(form.departure_date)) < new Date()
          ? 'Departure date cannot be in the past.'
          : null,
      arrival_date: (form.arrival_date && form.departure_date
        && new Date(phLocalInputToISO(form.arrival_date)) <= new Date(phLocalInputToISO(form.departure_date)))
        ? 'Estimated arrival date must be after departure date.'
        : null,
    });
    if (!ok) return;

    setSaving(true);
    try {
      const departureISO = phLocalInputToISO(form.departure_date);
      const arrivalISO = form.arrival_date ? phLocalInputToISO(form.arrival_date) : null;

      // Same courtesy pre-check CreateTripPage runs — one departure per route
      // per PH calendar day. excludeTripId keeps this trip from flagging
      // itself when the admin re-saves the same day with a different time.
      const duplicate = await findDuplicateTrip({
        origin: trip.origin,
        destination: trip.destination,
        departure_date: departureISO,
        excludeTripId: trip.id,
      });
      if (duplicate) {
        setError('departure_date', duplicateTripMessage(trip.origin, trip.destination, departureISO));
        return;
      }

      await onReschedule({ departure_date: departureISO, arrival_date: arrivalISO });
    } catch {
      // Save error handled by parent (toast); modal stays open to retry.
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
        aria-labelledby="reschedule-trip-title"
      >
        <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
          <div className="modal-header">
            <h3 id="reschedule-trip-title">
              <Calendar size={18} className="inline mr-8" aria-hidden="true" />
              Reschedule {trip.trip_number}
            </h3>
            <button
              className="btn-icon btn-ghost"
              onClick={handleSafeClose}
              disabled={saving}
              aria-label="Close reschedule modal"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>

          <div className="modal-body" ref={containerRef}>
            <div className="form-group">
              <label className="form-label" htmlFor="reschedule-departure-date">Departure Date &amp; Time</label>
              <input
                id="reschedule-departure-date"
                type="datetime-local"
                className={`form-input ${errors.departure_date ? 'field-invalid' : ''}`}
                value={form.departure_date}
                onChange={(e) => u('departure_date', e.target.value)}
                aria-invalid={errors.departure_date ? 'true' : undefined}
                aria-describedby={errors.departure_date ? 'reschedule-departure-date-error' : undefined}
              />
              <FieldError name="departure_date" errors={errors} id="reschedule-departure-date-error" />
            </div>
            <div className="form-group mb-0">
              <label className="form-label" htmlFor="reschedule-arrival-date">Estimated Arrival Date &amp; Time</label>
              <input
                id="reschedule-arrival-date"
                type="datetime-local"
                className={`form-input ${errors.arrival_date ? 'field-invalid' : ''}`}
                value={form.arrival_date}
                onChange={(e) => u('arrival_date', e.target.value)}
                aria-invalid={errors.arrival_date ? 'true' : undefined}
                aria-describedby={errors.arrival_date ? 'reschedule-arrival-date-error' : undefined}
              />
              <FieldError name="arrival_date" errors={errors} id="reschedule-arrival-date-error" />
            </div>
          </div>

          <div className="modal-footer">
            <button className="btn btn-outline" onClick={handleSafeClose} disabled={saving}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? <Loader size={16} className="animate-spin" /> : null}
              Save Schedule
            </button>
          </div>
        </div>
      </div>
    </FocusTrap>,
    document.body
  );
};

export default RescheduleTripModal;
