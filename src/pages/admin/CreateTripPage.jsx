import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createTrip } from '../../lib/database';
import { ROUTES } from '../../constants/phLocations';
import { ArrowLeft, Calendar, Loader, Truck, DollarSign, Package, FileText, Lightbulb } from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';
import { logTrip } from '../../lib/activityLog';

const CreateTripPage = () => {
  usePageTitle('Create Trip');
  const navigate = useNavigate();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    origin: '', destination: '',
    departure_date: '', arrival_date: '',
    capacity:     1000,
    price_per_kg: 70,
    notes: '',
  });

  const u = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const handleRouteSelect = (route) => {
    u('origin', route.origin);
    u('destination', route.destination);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.origin || !form.destination) { toast.error('Please select a route.'); return; }
    if (!form.departure_date) { toast.error('Departure date is required.'); return; }
    
    // Validate departure date is in the future
    if (new Date(form.departure_date) < new Date()) {
      toast.error('Departure date cannot be in the past.');
      return;
    }
    
    // Validate arrival date is after departure date
    if (form.arrival_date && new Date(form.arrival_date) <= new Date(form.departure_date)) {
      toast.error('Estimated arrival date must be after departure date.');
      return;
    }

    if (!form.capacity || isNaN(Number(form.capacity)) || Number(form.capacity) <= 0) {
      toast.error('Capacity must be a positive number.'); return;
    }
    if (!form.price_per_kg || isNaN(Number(form.price_per_kg)) || Number(form.price_per_kg) <= 0) {
      toast.error('Amount per kilo must be a positive number.'); return;
    }
    setLoading(true);
    try {
      const result = await createTrip({
        ...form,
        arrival_date: form.arrival_date ? form.arrival_date : null,
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
          <h1 className="admin-page-title">Create New Trip</h1>
          <p className="admin-page-subtitle">Define route, schedule, capacity, and pricing for a cargo run.</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>

        {/* ── Route ─────────────────────────────────────── */}
        <div className="card stagger-item mb-16" style={{ animationDelay: '0ms' }}>
          <div className="card-body">
            <h3 className="fw-700 mb-16 flex items-center gap-8">
              <Truck size={18} color="var(--primary)" aria-hidden="true" /> Route *
            </h3>
            <div className="admin-route-options">
              {ROUTES.map(r => (
                <button
                  type="button" key={r.label}
                  onClick={() => handleRouteSelect(r)}
                  aria-pressed={form.origin === r.origin}
                  className="card-interactive admin-route-option flex-1 p-20 cursor-pointer text-center"
                  style={{
                    borderRadius: 12,
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
          </div>
        </div>

        {/* ── Schedule ──────────────────────────────────── */}
        <div className="card stagger-item mb-16" style={{ animationDelay: '60ms' }}>
          <div className="card-body">
            <h3 className="fw-700 mb-16 flex items-center gap-8">
              <Calendar size={18} color="var(--primary)" aria-hidden="true" /> Schedule *
            </h3>
            <div className="grid grid-2 gap-16">
              <div className="form-group">
                <label className="form-label" htmlFor="trip-departure-date">Departure Date & Time *</label>
                <input id="trip-departure-date" type="datetime-local" className="form-input" value={form.departure_date} onChange={e => u('departure_date', e.target.value)} required />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="trip-arrival-date">Estimated Arrival Date & Time</label>
                <input id="trip-arrival-date" type="datetime-local" className="form-input" value={form.arrival_date} onChange={e => u('arrival_date', e.target.value)} />
              </div>
            </div>
          </div>
        </div>

        {/* ── Capacity & Pricing ────────────────────────── */}
        <div className="card stagger-item mb-16" style={{ animationDelay: '120ms' }}>
          <div className="card-body">
            <h3 className="fw-700 mb-16 flex items-center gap-8">
              <Package size={18} color="var(--primary)" aria-hidden="true" /> Capacity & Pricing *
            </h3>
            <div className="grid grid-2 gap-16">
              <div className="form-group">
                <label className="form-label" htmlFor="trip-capacity">Capacity (kg) *</label>
                <input id="trip-capacity" type="number" className="form-input" value={form.capacity} onChange={e => u('capacity', e.target.value)} placeholder="e.g. 1000" min="1" step="1" required aria-describedby="trip-capacity-helper" />
                <p id="trip-capacity-helper" className="text-xs text-tertiary mt-4">Maximum total cargo weight for this trip.</p>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="trip-price-per-kg">Amount per Kilo (₱) *</label>
                <div className="relative">
                  <DollarSign size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', pointerEvents: 'none' }} />
                  <input id="trip-price-per-kg" type="number" className="form-input" value={form.price_per_kg} onChange={e => u('price_per_kg', e.target.value)} placeholder="e.g. 70" min="0.01" step="0.01" style={{ paddingLeft: 34 }} required aria-describedby="trip-price-helper" />
                </div>
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
              <FileText size={18} color="var(--text-tertiary)" /> Notes <span className="fw-400" style={{ color: 'var(--text-tertiary)', fontSize: '0.8125rem' }}>(Optional)</span>
            </h3>
            <label className="sr-only" htmlFor="trip-notes">Trip notes</label>
            <textarea id="trip-notes" className="form-textarea" value={form.notes} onChange={e => u('notes', e.target.value)} placeholder="Any special instructions, remarks, or conditions for this trip..." rows={3} />
          </div>
        </div>

        <div className="admin-form-actions">
          <button type="submit" className="btn btn-primary btn-lg admin-form-submit" disabled={loading || !routeSelected} style={{ minWidth: 180 }}>
            {loading ? <><Loader size={18} className="animate-spin" /> Creating...</> : <><Truck size={18} /> Create Trip</>}
          </button>
        </div>
      </form>
    </div>
  );
};

export default CreateTripPage;
