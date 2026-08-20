import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createTrip, findDuplicateTrip, duplicateTripMessage } from '../../lib/database';
import { ROUTES } from '../../constants/phLocations';
import { ArrowLeft, Calendar, Loader, Truck, Package, FileText, Lightbulb, Plus } from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';
import { logTrip } from '../../lib/activityLog';
import { phLocalInputToISO } from '../../utils/datetime';
import useFieldErrors from '../../hooks/useFieldErrors';
import FieldError, { errorId, fieldAttrs, invalidClass } from '../../components/ui/FieldError';

const CreateTripPage = () => {
  usePageTitle('Create Trip');
  const navigate = useNavigate();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const { errors: fieldErrors, validate, clearError } = useFieldErrors();
  const [form, setForm] = useState({
    origin: '', destination: '',
    departure_date: '', arrival_date: '',
    capacity:     1000,
    price_per_kg: 70,
    notes: '',
  });

  const u = (k, v) => {
    setForm(p => ({ ...p, [k]: v }));
    clearError(k);
  };

  const handleRouteSelect = (route) => {
    u('origin', route.origin);
    u('destination', route.destination);
    clearError('route');
    // A "already scheduled" message names this route; switching route retires it.
    clearError('departure_date');
  };

  const buildRules = () => ({
    route: (!form.origin || !form.destination) ? 'Please select a route.' : null,
    departure_date: !form.departure_date
      ? 'Departure date is required.'
      : new Date(form.departure_date) < new Date()
        ? 'Departure date cannot be in the past.'
        : null,
    arrival_date: (form.arrival_date && form.departure_date
      && new Date(form.arrival_date) <= new Date(form.departure_date))
      ? 'Estimated arrival date must be after departure date.'
      : null,
    capacity: !form.capacity
      ? 'Capacity is required.'
      : (isNaN(Number(form.capacity)) || Number(form.capacity) <= 0)
        ? 'Capacity must be a positive number.'
        : null,
    price_per_kg: !form.price_per_kg
      ? 'Amount per kilo is required.'
      : (isNaN(Number(form.price_per_kg)) || Number(form.price_per_kg) <= 0)
        ? 'Amount per kilo must be a positive number.'
        : null,
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    // No toast: every one of these rules names a field, and the field says so
    // itself. A toast on top would be the same news delivered twice.
    if (!validate(buildRules())) return;

    setLoading(true);
    try {
      // One departure per route per day. Checked here so the admin is told
      // before the trip number is burned and the auto-assignment runs; the
      // unique index in 20260818090000 is what actually enforces it.
      const departureISO = phLocalInputToISO(form.departure_date);
      const duplicate = await findDuplicateTrip({
        origin: form.origin,
        destination: form.destination,
        departure_date: departureISO,
      });
      if (duplicate) {
        // validate() rather than setError(): it also scrolls the date field
        // into view, which is the field the admin has to change.
        validate({
          departure_date: duplicateTripMessage(form.origin, form.destination, departureISO),
        });
        return;
      }

      const result = await createTrip({
        ...form,
        // Stamp +08:00 before the insert. The datetime-local inputs are naive,
        // and TIMESTAMPTZ would otherwise resolve them in the database server's
        // zone (UTC) — the 8-hour shift that pushed a 6:00 PM ETA onto the next
        // calendar day for customers. See src/utils/datetime.js.
        departure_date: phLocalInputToISO(form.departure_date),
        arrival_date: form.arrival_date ? phLocalInputToISO(form.arrival_date) : null,
        capacity:     Number(form.capacity),
        price_per_kg: Number(form.price_per_kg),
      });
      toast.success('Trip created successfully!');
      logTrip('Trip Created', result.id, result.trip_number || result.id, { newValue: { origin: form.origin, destination: form.destination, departure_date: form.departure_date, capacity: form.capacity, price_per_kg: form.price_per_kg }, details: `New trip created: ${form.origin} → ${form.destination}` });
      navigate(`/admin/trips/${result.id}`);
    } catch (err) {
      toast.error(err.message || 'Failed to create trip.');
    } finally {
      setLoading(false);
    }
  };

  const routeSelected = form.origin && form.destination;

  return (
    <div className="page-transition">
      <button type="button" onClick={() => navigate(-1)} className="btn btn-ghost mb-16">
        <ArrowLeft size={18} aria-hidden="true" /> Back
      </button>
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title"><Plus size={24} color="var(--primary)" aria-hidden="true" />Create New Trip</h1>
          <p className="admin-page-subtitle">Define route, schedule, capacity, and pricing for a cargo run.</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} noValidate>

        {/* ── Route ─────────────────────────────────────── */}
        <div className="card stagger-item mb-16" style={{ animationDelay: '0ms' }}>
          <div className="card-body">
            <h3 className="fw-700 mb-16 flex items-center gap-8">
              <Truck size={18} color="var(--primary)" aria-hidden="true" /> Route
            </h3>
            <div
              className={`admin-route-options ${fieldErrors.route ? 'field-group-invalid' : ''}`}
              role="group"
              aria-label="Route"
              aria-invalid={fieldErrors.route ? 'true' : undefined}
              aria-describedby={fieldErrors.route ? errorId('route') : undefined}
              tabIndex={fieldErrors.route ? -1 : undefined}
            >
              {ROUTES.map(r => (
                <button
                  type="button" key={r.label}
                  onClick={() => handleRouteSelect(r)}
                  aria-pressed={form.origin === r.origin}
                  className="card-interactive admin-route-option flex-1 p-20 cursor-pointer text-center"
                  style={{
                    borderRadius: 'var(--radius-md)',
                    border: form.origin === r.origin ? '2px solid var(--primary)' : '1.5px solid var(--border)',
                    background: form.origin === r.origin ? 'var(--primary-bg)' : 'var(--surface)',
                  }}
                >
                  <Truck size={22} color={form.origin === r.origin ? 'var(--primary)' : 'var(--text-tertiary)'} className="mx-auto mb-8" />
                  <div className="fw-700" style={{ fontSize: '0.9375rem' }}>{r.label}</div>
                  <div className="text-xs text-tertiary mt-4">
                    {r.origin} → {r.destination}
                  </div>
                </button>
              ))}
            </div>
            <FieldError name="route" errors={fieldErrors} />
          </div>
        </div>

        {/* ── Schedule ──────────────────────────────────── */}
        <div className="card stagger-item mb-16" style={{ animationDelay: '60ms' }}>
          <div className="card-body">
            <h3 className="fw-700 mb-16 flex items-center gap-8">
              <Calendar size={18} color="var(--primary)" aria-hidden="true" /> Schedule
            </h3>
            <div className="grid grid-2 gap-16">
              <div className="form-group">
                <label className="form-label" htmlFor="trip-departure-date">Departure Date & Time</label>
                <input id="trip-departure-date" type="datetime-local" className={`form-input ${fieldErrors.departure_date ? 'field-invalid' : ''}`} value={form.departure_date} onChange={e => u('departure_date', e.target.value)} required aria-invalid={fieldErrors.departure_date ? 'true' : undefined} aria-describedby={fieldErrors.departure_date ? 'trip-departure-date-error' : undefined} />
                <FieldError name="departure_date" errors={fieldErrors} id="trip-departure-date-error" />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="trip-arrival-date">Estimated Arrival Date & Time</label>
                <input id="trip-arrival-date" type="datetime-local" className={`form-input ${fieldErrors.arrival_date ? 'field-invalid' : ''}`} value={form.arrival_date} onChange={e => u('arrival_date', e.target.value)} aria-invalid={fieldErrors.arrival_date ? 'true' : undefined} aria-describedby={fieldErrors.arrival_date ? 'trip-arrival-date-error' : undefined} />
                <FieldError name="arrival_date" errors={fieldErrors} id="trip-arrival-date-error" />
              </div>
            </div>
          </div>
        </div>

        {/* ── Capacity & Pricing ────────────────────────── */}
        <div className="card stagger-item mb-16" style={{ animationDelay: '120ms' }}>
          <div className="card-body">
            <h3 className="fw-700 mb-16 flex items-center gap-8">
              <Package size={18} color="var(--primary)" aria-hidden="true" /> Capacity & Pricing
            </h3>
            <div className="grid grid-2 gap-16">
              <div className="form-group">
                <label className="form-label" htmlFor="trip-capacity">Capacity (kg)</label>
                <input id="trip-capacity" type="number" className={`form-input ${fieldErrors.capacity ? 'field-invalid' : ''}`} value={form.capacity} onChange={e => u('capacity', e.target.value)} placeholder="e.g. 1000" min="1" step="1" required aria-invalid={fieldErrors.capacity ? 'true' : undefined} aria-describedby={fieldErrors.capacity ? 'trip-capacity-error trip-capacity-helper' : 'trip-capacity-helper'} />
                <FieldError name="capacity" errors={fieldErrors} id="trip-capacity-error" />
                <p id="trip-capacity-helper" className="text-xs text-tertiary mt-4">Maximum total cargo weight for this trip.</p>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="trip-price-per-kg">Amount per Kilo (₱)</label>
                <div className="relative">
                  <span aria-hidden="true" className="absolute text-tertiary pointer-events-none" style={{left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 15, lineHeight: 1}}>₱</span>
                  <input id="trip-price-per-kg" type="number" className={`form-input ${fieldErrors.price_per_kg ? 'field-invalid' : ''}`} value={form.price_per_kg} onChange={e => u('price_per_kg', e.target.value)} placeholder="e.g. 70" min="0.01" step="0.01" style={{ paddingLeft: 34 }} required aria-invalid={fieldErrors.price_per_kg ? 'true' : undefined} aria-describedby={fieldErrors.price_per_kg ? 'trip-price-error trip-price-helper' : 'trip-price-helper'} />
                </div>
                <FieldError name="price_per_kg" errors={fieldErrors} id="trip-price-error" />
                <p id="trip-price-helper" className="text-xs text-tertiary mt-4">Cost per kilogram for bookings on this trip.</p>
              </div>
            </div>

            {/* Live preview — informational display, not a feedback notification */}
            {form.capacity && form.price_per_kg && (
              <div className="alert-banner mt-8" style={{ background: 'var(--primary-bg)', border: '1.5px solid var(--primary-light)', color: 'var(--text)' }}>
                <Lightbulb size={16} /> At ₱{parseFloat(form.price_per_kg).toFixed(2)}/kg, a full trip of {Number(form.capacity).toLocaleString()} kg
                = <strong>₱{(Number(form.capacity) * Number(form.price_per_kg)).toLocaleString()} max revenue</strong>
              </div>
            )}
          </div>
        </div>

        {/* ── Notes ───────────────────────────────────── */}
        <div className="card stagger-item mb-24" style={{ animationDelay: '180ms' }}>
          <div className="card-body">
            <h3 className="fw-700 mb-12 flex items-center gap-8">
              <FileText size={18} color="var(--text-tertiary)" /> Notes <span className="fw-400 text-tertiary" style={{ fontSize: '0.8125rem' }}>(Optional)</span>
            </h3>
            <label className="sr-only" htmlFor="trip-notes">Trip notes</label>
            <textarea id="trip-notes" className="form-textarea" value={form.notes} onChange={e => u('notes', e.target.value)} placeholder="Any special instructions, remarks, or conditions for this trip..." rows={3} />
          </div>
        </div>

        <div className="admin-form-actions">
          <button type="submit" className="btn btn-primary btn-lg admin-form-submit" disabled={loading} style={{ minWidth: 180 }}>
            {loading ? <><Loader size={18} className="animate-spin" /> Creating...</> : <><Truck size={18} /> Create Trip</>}
          </button>
        </div>
      </form>
    </div>
  );
};

export default CreateTripPage;
