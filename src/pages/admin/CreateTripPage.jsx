import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { createTrip, findDuplicateTrip, duplicateTripMessage, getCompanyInformation } from '../../lib/database';
import { ROUTES } from '../../constants/phLocations';
import { ArrowLeft, Calendar, Loader, Truck, Package, FileText, Lightbulb, Plus, Megaphone, AlertTriangle } from 'lucide-react';
import { formatCommaNumber } from "../../utils/numberFormatters";
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';
import { logTrip } from '../../lib/activityLog';
import { phLocalInputToISO, phDateKey } from '../../utils/datetime';
import useFieldErrors from '../../hooks/useFieldErrors';
import FieldError, { errorId } from '../../components/ui/FieldError';
import { CenteredSpinner } from '../../components/ui/Loader';

const CreateTripPage = () => {
  usePageTitle('Create Trip');
  const navigate = useNavigate();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const { errors: fieldErrors, validate, clearError } = useFieldErrors();
  const [form, setForm] = useState({
    origin: '', destination: '',
    departure_date: '', arrival_date: '',
    notes: '',
    announce_via_email: false,
  });

  // Capacity & pricing are no longer typed per trip — every new trip is
  // created with the global defaults from Company Information → Capacity &
  // Pricing (company_information.default_capacity / default_price_per_kg),
  // the same row global_price_per_kilo() already reads for unpriced orders.
  // Fetched once on mount rather than re-derived per submit so a slow
  // network doesn't add latency to the actual "Create Trip" click.
  const [defaults, setDefaults] = useState(null); // { capacity, price_per_kg } | null while loading/failed
  const [loadingDefaults, setLoadingDefaults] = useState(true);

  useEffect(() => {
    let mounted = true;
    getCompanyInformation()
      .then(info => {
        if (!mounted) return;
        setDefaults({
          capacity: Number(info?.default_capacity) || 0,
          price_per_kg: Number(info?.default_price_per_kg) || 0,
        });
      })
      .catch(() => { if (mounted) setDefaults(null); })
      .finally(() => { if (mounted) setLoadingDefaults(false); });
    return () => { mounted = false; };
  }, []);

  // Both must be a real, positive value — a 0 capacity would silently skip
  // the trip's own van-capacity enforcement trigger (guard_order_update()
  // only checks the limit when "trip_row.capacity > 0"), and a 0 price
  // would cost every booking on the trip at ₱0/kg.
  const defaultsReady = Boolean(defaults) && defaults.capacity > 0 && defaults.price_per_kg > 0;

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
    // PH calendar day, not an instant comparison: trip scheduling is
    // date-only, so "today" must stay valid to pick no matter what time it
    // currently is — see guard_customer_order_insert() in
    // 20260829160000_trip_date_only_scheduling.sql.
    departure_date: !form.departure_date
      ? 'Departure date is required.'
      : phDateKey(form.departure_date) < phDateKey(new Date().toISOString())
        ? 'Departure date cannot be in the past.'
        : null,
    // Arrival must be STRICTLY after departure — same-day is rejected too.
    // This is stricter than the date-only scheduling rule this codebase
    // otherwise runs on (20260829160000_trip_date_only_scheduling.sql, which
    // deliberately allowed arrival_date === departure_date); the DB-level
    // CHECK constraint (20260910010000_strict_arrival_after_departure.sql)
    // enforces the same rule server-side, so keep both in sync.
    arrival_date: (form.arrival_date && form.departure_date
      && new Date(phLocalInputToISO(form.arrival_date)) <= new Date(phLocalInputToISO(form.departure_date)))
      ? 'Arrival date must be at least one day after departure.'
      : null,
    // capacity/price_per_kg are no longer form fields — they come from
    // Company Information's defaults (see defaultsReady below), injected
    // right before the createTrip() call rather than validated here.
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    // No toast: every one of these rules names a field, and the field says so
    // itself. A toast on top would be the same news delivered twice.
    if (!validate(buildRules())) return;

    // Unlike the rules above, this doesn't name an on-page field — there is
    // no capacity/price input here to red-outline — so a toast is the right
    // way to say it, matching how findDuplicateTrip's non-field failures
    // are reported below.
    if (!defaultsReady) {
      toast.error('Set a default capacity and price per kilogram in Company Information → Capacity & Pricing before creating a trip.');
      return;
    }

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
        setLoading(false);
        return;
      }

      const result = await createTrip({
        ...form,
        // Anchor to PH midnight before the insert. The date inputs are naive
        // ("2026-08-29"), and TIMESTAMPTZ would otherwise resolve them in the
        // database server's zone (UTC) — the 8-hour shift that pushed a
        // midnight-Manila date onto the wrong calendar day. See
        // phLocalInputToISO in src/utils/datetime.js.
        departure_date: phLocalInputToISO(form.departure_date),
        arrival_date: form.arrival_date ? phLocalInputToISO(form.arrival_date) : null,
        capacity:     defaults.capacity,
        price_per_kg: defaults.price_per_kg,
      });
      if (result.autoAssignmentWarning) {
        toast.warning(result.autoAssignmentWarning, 7000);
      } else {
        toast.success('Trip created successfully!');
      }
      logTrip('Trip Created', result.id, result.trip_number || result.id, { newValue: { origin: form.origin, destination: form.destination, departure_date: form.departure_date, capacity: defaults.capacity, price_per_kg: defaults.price_per_kg }, details: `New trip created: ${form.origin} → ${form.destination} (capacity ${defaults.capacity} kg, ₱${defaults.price_per_kg}/kg from Company Info defaults)` });
      navigate(`/admin/trips/${result.id}`);
      // Not clearing `loading` here: navigate() doesn't unmount this page
      // synchronously, so clearing it would risk a frame of the un-loading
      // form before the route change actually takes the admin away.
    } catch (err) {
      toast.error(err.message || 'Failed to create trip.');
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
          <p className="admin-page-subtitle">Define the route and schedule for a cargo run. Capacity and pricing come from your Company Information defaults.</p>
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
                  <div className="fw-700" style={{ fontSize: 'var(--text-16)' }}>{r.label}</div>
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
                <label className="form-label" htmlFor="trip-departure-date">Departure Date</label>
                <input id="trip-departure-date" type="date" className={`form-input ${fieldErrors.departure_date ? 'field-invalid' : ''}`} value={form.departure_date} onChange={e => u('departure_date', e.target.value)} required aria-invalid={fieldErrors.departure_date ? 'true' : undefined} aria-describedby={fieldErrors.departure_date ? 'trip-departure-date-error' : undefined} />
                <FieldError name="departure_date" errors={fieldErrors} id="trip-departure-date-error" />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="trip-arrival-date">Estimated Shipment Delivery Date</label>
                <input id="trip-arrival-date" type="date" className={`form-input ${fieldErrors.arrival_date ? 'field-invalid' : ''}`} value={form.arrival_date} onChange={e => u('arrival_date', e.target.value)} aria-invalid={fieldErrors.arrival_date ? 'true' : undefined} aria-describedby={fieldErrors.arrival_date ? 'trip-arrival-date-error' : undefined} />
                <FieldError name="arrival_date" errors={fieldErrors} id="trip-arrival-date-error" />
              </div>
            </div>
          </div>
        </div>

        {/* ── Capacity & Pricing ────────────────────────── */}
        {/* No inputs here anymore — capacity and price per kilo are no
            longer asked per trip. Every new trip is created with the global
            defaults set in Company Information → Capacity & Pricing; this
            card only shows what those currently resolve to. */}
        <div className="card stagger-item mb-16" style={{ animationDelay: '120ms' }}>
          <div className="card-body">
            <h3 className="fw-700 mb-16 flex items-center gap-8">
              <Package size={18} color="var(--primary)" aria-hidden="true" /> Capacity & Pricing
            </h3>

            {loadingDefaults ? (
              <CenteredSpinner size={22} />
            ) : defaultsReady ? (
              <>
                <div className="grid grid-2 gap-16">
                  <div>
                    <div className="text-xs text-tertiary mb-4">Capacity</div>
                    <div className="text-sm fw-700">{formatCommaNumber(defaults.capacity)} kg</div>
                  </div>
                  <div>
                    <div className="text-xs text-tertiary mb-4">Amount per Kilo</div>
                    <div className="text-sm fw-700">₱{formatCommaNumber(defaults.price_per_kg)}</div>
                  </div>
                </div>

                {/* Informational preview — not a feedback notification */}
                <div className="alert-banner mt-16" style={{ background: 'var(--primary-bg)', border: '1.5px solid var(--primary-light)', color: 'var(--text)' }}>
                  <Lightbulb size={16} /> At ₱{defaults.price_per_kg.toFixed(2)}/kg, a full trip of {defaults.capacity.toLocaleString()} kg
                  = <strong>₱{(defaults.capacity * defaults.price_per_kg).toLocaleString()} max revenue</strong>
                </div>

                <p className="text-xs text-tertiary mt-12 mb-0">
                  Applied automatically from Company Information defaults. <Link to="/admin/company-info">Manage defaults</Link>
                </p>
              </>
            ) : (
              <div className="alert-banner alert-banner-error" role="alert">
                <AlertTriangle size={18} />
                <span>
                  No default capacity/price is set yet, so a trip cannot be created.{' '}
                  <Link to="/admin/company-info">Set them in Company Information → Capacity & Pricing</Link>.
                </span>
              </div>
            )}
          </div>
        </div>

        {/* ── Notes ───────────────────────────────────── */}
        <div className="card stagger-item mb-24" style={{ animationDelay: '180ms' }}>
          <div className="card-body">
            <h3 className="fw-700 mb-12 flex items-center gap-8">
              <FileText size={18} color="var(--text-tertiary)" /> Notes <span className="fw-400 text-tertiary" style={{ fontSize: 'var(--text-13)' }}>(Optional)</span>
            </h3>
            <label className="sr-only" htmlFor="trip-notes">Trip notes</label>
            <textarea id="trip-notes" className="form-textarea" value={form.notes} onChange={e => u('notes', e.target.value)} placeholder="Any special instructions, remarks, or conditions for this trip..." rows={3} />
          </div>
        </div>

        {/* ── Email Announcement ─────────────────────────── */}
        <div className="card stagger-item mb-24" style={{ animationDelay: '220ms' }}>
          <div className="card-body">
            <label className="flex items-center gap-8" htmlFor="trip-announce-email" style={{ cursor: 'pointer' }}>
              <input
                id="trip-announce-email"
                type="checkbox"
                checked={form.announce_via_email}
                onChange={e => u('announce_via_email', e.target.checked)}
              />
              <span className="fw-700 flex items-center gap-8">
                <Megaphone size={16} color="var(--primary)" aria-hidden="true" />
                Also email subscribed customers
              </span>
            </label>
            <p className="text-xs text-secondary mt-8">
              All customers receive an in-app notification automatically, and eligible devices receive push notifications. Select this only to also email people subscribed to Email Updates.
            </p>
          </div>
        </div>

        <div className="admin-form-actions">
          <button type="submit" className="btn btn-primary btn-lg admin-form-submit" disabled={loading || loadingDefaults || !defaultsReady} style={{ minWidth: 180 }}>
            {loading ? <><Loader size={18} className="animate-spin" /> Creating...</> : <><Truck size={18} /> Create Trip</>}
          </button>
        </div>
      </form>
    </div>
  );
};

export default CreateTripPage;
