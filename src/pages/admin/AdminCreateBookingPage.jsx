import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { createOrder } from '../../lib/database';
import { useAuth } from '../../contexts/AuthContext';
import { ROUTES, PH_LOCATIONS, VALID_PROVINCES, detectPickupLocation, validateRouteProvinces } from '../../constants/phLocations';
import { buildFullAddress } from '../../lib/address';
import { normalizeName, toTitleCase } from '../../utils/string';
import { validatePhone } from '../../utils/phone';
import CustomSelect from '../../components/ui/CustomSelect';
import BarangaySelect from '../../components/ui/BarangaySelect';
import {
  ArrowLeft, Loader, Truck, User, MapPin, Package,
  CreditCard, FileText, Plus, Copy, Check, CheckCircle2, RotateCcw,
} from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';
import { logOrder } from '../../lib/activityLog';
import useFieldErrors from '../../hooks/useFieldErrors';
import FieldError, { invalidClass, fieldAttrs } from '../../components/ui/FieldError';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Clipboard fallback for browsers without navigator.clipboard (e.g. HTTP). */
function fallbackCopy(text) {
  const el = document.createElement('textarea');
  el.value = text;
  el.setAttribute('readonly', '');
  el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;padding:0;border:none;outline:none;box-shadow:none;background:transparent;opacity:0';
  document.body.appendChild(el);
  el.focus();
  el.select();
  el.setSelectionRange(0, text.length);
  try { document.execCommand('copy'); } catch { /* silent */ }
  document.body.removeChild(el);
}

// ── Initial form state ───────────────────────────────────────────────────────

const INITIAL_FORM = {
  // Route
  origin: '',
  destination: '',
  // Sender
  sender_name: '',
  sender_phone: '',
  sender_facebook: '',
  sender_province: '',
  sender_city: '',
  sender_barangay: '',
  sender_street: '',
  sender_lot_block: '',
  sender_landmark: '',
  // Receiver
  receiver_name: '',
  receiver_phone: '',
  receiver_facebook: '',
  receiver_province: '',
  receiver_city: '',
  receiver_barangay: '',
  receiver_street: '',
  receiver_lot_block: '',
  receiver_landmark: '',
  // Package
  package_description: '',
  notes: '',
  // Payment
  payment_preference: 'unspecified',
};

// ── Province helpers (route-aware, matching customer booking flow) ────────────

const getSenderProvinces = (origin) => {
  if (!origin) return VALID_PROVINCES;
  if (origin === 'Bohol') return ['Bohol'];
  return ['Metro Manila', 'Cavite', 'Batangas', 'Laguna', 'Bulacan'];
};

const getReceiverProvinces = (destination) => {
  if (!destination) return VALID_PROVINCES;
  if (destination === 'Bohol') return ['Bohol'];
  return ['Metro Manila', 'Cavite', 'Batangas', 'Laguna', 'Bulacan'];
};

// ─────────────────────────────────────────────────────────────────────────────

const AdminCreateBookingPage = () => {
  usePageTitle('Create Booking');
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [form, setForm] = useState(INITIAL_FORM);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(null);
  const [copied, setCopied] = useState(false);
  const { errors: fieldErrors, validate, clearError } = useFieldErrors();
  const submittingRef = useRef(false);

  /** Shorthand for updating a single field + clearing its error. */
  const u = (k, v) => {
    setForm(p => ({ ...p, [k]: v }));
    clearError(k);
  };

  /** Auto-capitalizes fields as they are typed. */
  const handleTextChange = (key) => (e) => u(key, toTitleCase(e.target.value));

  // ── Derived data ───────────────────────────────────────────────────────────

  const senderProvinces = getSenderProvinces(form.origin);
  const receiverProvinces = getReceiverProvinces(form.destination);
  const senderCities = form.sender_province ? PH_LOCATIONS[form.sender_province] || [] : [];
  const receiverCities = form.receiver_province ? PH_LOCATIONS[form.receiver_province] || [] : [];

  // ── Route selection ────────────────────────────────────────────────────────

  const handleRouteSelect = (route) => {
    const prevOrigin = form.origin;
    const prevDestination = form.destination;
    u('origin', route.origin);
    u('destination', route.destination);
    clearError('route');

    // Clear province/city if they no longer match the new route
    if (prevOrigin !== route.origin) {
      const senderSide = detectPickupLocation(form.sender_province);
      const expectedSender = route.origin === 'Bohol' ? 'bohol' : 'manila';
      if (form.sender_province && senderSide !== expectedSender) {
        u('sender_province', ''); u('sender_city', ''); u('sender_barangay', '');
      }
    }
    if (prevDestination !== route.destination) {
      const receiverSide = detectPickupLocation(form.receiver_province);
      const expectedReceiver = route.destination === 'Bohol' ? 'bohol' : 'manila';
      if (form.receiver_province && receiverSide !== expectedReceiver) {
        u('receiver_province', ''); u('receiver_city', ''); u('receiver_barangay', '');
      }
    }
  };

  // ── Province change handlers (reset dependent fields) ──────────────────────

  const handleSenderProvinceChange = (value) => {
    u('sender_province', value);
    u('sender_city', '');
    u('sender_barangay', '');
  };

  const handleReceiverProvinceChange = (value) => {
    u('receiver_province', value);
    u('receiver_city', '');
    u('receiver_barangay', '');
  };

  const handleSenderCityChange = (value) => {
    u('sender_city', value);
    u('sender_barangay', '');
  };

  const handleReceiverCityChange = (value) => {
    u('receiver_city', value);
    u('receiver_barangay', '');
  };

  // ── Validation ─────────────────────────────────────────────────────────────

  const buildRules = () => ({
    route: (!form.origin || !form.destination)
      ? 'Please select a route.'
      : null,
    // Sender
    sender_name: !form.sender_name.trim()
      ? 'Sender name is required.'
      : null,
    sender_phone: validatePhone(form.sender_phone),
    sender_facebook: !form.sender_facebook.trim()
      ? 'Sender Facebook name is required.'
      : null,
    sender_province: !form.sender_province
      ? 'Province is required.'
      : null,
    sender_city: !form.sender_city
      ? 'City is required.'
      : null,
    sender_barangay: !form.sender_barangay.trim()
      ? 'Barangay is required.'
      : null,
    sender_street: !form.sender_street.trim()
      ? 'Street is required.'
      : null,
    sender_lot_block: !form.sender_lot_block.trim()
      ? 'Lot / Block / Purok is required.'
      : null,
    sender_landmark: !form.sender_landmark.trim()
      ? 'Landmark is required.'
      : null,
    // Receiver
    receiver_name: !form.receiver_name.trim()
      ? 'Receiver name is required.'
      : null,
    receiver_phone: validatePhone(form.receiver_phone),
    receiver_facebook: !form.receiver_facebook.trim()
      ? 'Receiver Facebook name is required.'
      : null,
    receiver_province: !form.receiver_province
      ? 'Province is required.'
      : null,
    receiver_city: !form.receiver_city
      ? 'City is required.'
      : null,
    receiver_barangay: !form.receiver_barangay.trim()
      ? 'Barangay is required.'
      : null,
    receiver_street: !form.receiver_street.trim()
      ? 'Street is required.'
      : null,
    receiver_lot_block: !form.receiver_lot_block.trim()
      ? 'Lot / Block / Purok is required.'
      : null,
    receiver_landmark: !form.receiver_landmark.trim()
      ? 'Landmark is required.'
      : null,
    // Package
    package_description: !form.package_description.trim()
      ? 'Package description is required.'
      : null,
  });

  // ── Submit ─────────────────────────────────────────────────────────────────

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate(buildRules())) return;

    // Route-province cross-validation (same logic as customer flow)
    const routeValidation = validateRouteProvinces(
      form.sender_province,
      form.receiver_province,
      { origin: form.origin, destination: form.destination },
    );
    if (!routeValidation.valid) {
      toast.error(routeValidation.error);
      return;
    }

    if (submittingRef.current) return;
    submittingRef.current = true;

    setLoading(true);
    try {
      // Build full addresses from structured fields (matching customer booking)
      const fullSenderAddress = buildFullAddress({
        lotBlock: form.sender_lot_block,
        street: form.sender_street,
        barangay: form.sender_barangay,
        city: form.sender_city,
        province: form.sender_province,
        landmark: form.sender_landmark,
      });
      const fullReceiverAddress = buildFullAddress({
        lotBlock: form.receiver_lot_block,
        street: form.receiver_street,
        barangay: form.receiver_barangay,
        city: form.receiver_city,
        province: form.receiver_province,
        landmark: form.receiver_landmark,
      });

      const payload = {
        user_id: user.id,
        origin: form.origin,
        destination: form.destination,
        // Sender
        sender_name: normalizeName(form.sender_name),
        sender_phone: form.sender_phone.trim(),
        sender_address: fullSenderAddress,
        sender_facebook: normalizeName(form.sender_facebook),
        sender_province: form.sender_province,
        sender_city: form.sender_city,
        // Receiver
        receiver_name: normalizeName(form.receiver_name),
        receiver_phone: form.receiver_phone.trim(),
        receiver_address: fullReceiverAddress,
        receiver_facebook: normalizeName(form.receiver_facebook),
        receiver_province: form.receiver_province,
        receiver_city: form.receiver_city,
        // Package
        package_description: form.package_description.trim(),
        notes: form.notes.trim() || null,
        // Payment
        payment_preference: form.payment_preference,
        payer_type: 'sender',
      };

      const result = await createOrder(payload);

      logOrder('Admin Booking Created', result.id, result.tracking_number, {
        newValue: {
          sender_name: payload.sender_name,
          receiver_name: payload.receiver_name,
          origin: payload.origin,
          destination: payload.destination,
        },
        details: `Admin created booking on behalf of customer: ${payload.sender_name} → ${payload.receiver_name}`,
      });

      setSuccess({
        tracking_number: result.tracking_number,
        id: result.id,
        sender_name: payload.sender_name,
        receiver_name: payload.receiver_name,
        origin: payload.origin,
        destination: payload.destination,
      });
      toast.success('Booking created successfully!');
      // Not clearing `loading` here: `success` now takes over rendering via
      // the early-return below, and this page never reads `loading` again —
      // clearing it would risk a frame of the un-loading form before that
      // switch. submittingRef is reset regardless since a fresh submit is
      // never possible from the success view anyway.
    } catch (err) {
      toast.error(err.message || 'Failed to create booking. Please try again.');
      setLoading(false);
    } finally {
      submittingRef.current = false;
    }
  };

  // ── Clipboard ──────────────────────────────────────────────────────────────

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(success.tracking_number);
      } else {
        fallbackCopy(success.tracking_number);
      }
      setCopied(true);
      toast.success('Tracking number copied to clipboard!');
      setTimeout(() => setCopied(false), 2500);
    } catch {
      fallbackCopy(success.tracking_number);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  // ── Reset ──────────────────────────────────────────────────────────────────

  const handleReset = () => {
    // handleSubmit deliberately leaves `loading` true on success (see the
    // comment there) so the success screen replaces the form without a flash
    // of the un-loading form first. "Create Another Booking" re-mounts that
    // same form, so `loading` has to be cleared explicitly or the submitting
    // overlay covers it immediately.
    setLoading(false);
    setForm(INITIAL_FORM);
    setSuccess(null);
    setCopied(false);
  };

  // ── Success Screen ─────────────────────────────────────────────────────────

  if (success) {
    return (
      <div className="page-transition">
        <div className="card stagger-item" style={{ maxWidth: 540, margin: '0 auto', animationDelay: '0ms' }}>
          <div className="card-body" style={{ textAlign: 'center', padding: '40px 24px' }}>
            <div
              style={{
                width: 64, height: 64, borderRadius: '50%',
                background: 'var(--primary-bg)', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 20px',
              }}
            >
              <CheckCircle2 size={32} color="var(--primary)" />
            </div>

            <h2 className="fw-700" style={{ fontSize: '1.375rem', marginBottom: 8 }}>
              Booking Created Successfully!
            </h2>
            <p className="text-tertiary" style={{ fontSize: '0.875rem', marginBottom: 28 }}>
              The tracking number below has been generated. Copy it and send it to the customer.
            </p>

            {/* Tracking Number Display */}
            <div
              style={{
                background: 'var(--surface-raised, var(--surface))',
                border: '2px dashed var(--primary)',
                borderRadius: 'var(--radius-lg, 12px)',
                padding: '20px 16px',
                marginBottom: 16,
              }}
            >
              <p className="text-tertiary" style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Tracking Number
              </p>
              <p className="fw-700" style={{ fontSize: '1.5rem', color: 'var(--primary)', letterSpacing: '0.04em', margin: 0, wordBreak: 'break-all' }}>
                {success.tracking_number}
              </p>
            </div>

            {/* Copy Button */}
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={handleCopy}
              style={{ width: '100%', marginBottom: 24, gap: 8 }}
            >
              {copied ? <><Check size={18} /> Copied!</> : <><Copy size={18} /> Copy Tracking Number</>}
            </button>

            {/* Booking Summary */}
            <div
              style={{
                background: 'var(--surface-raised, var(--surface))',
                borderRadius: 'var(--radius-md, 8px)',
                padding: '16px',
                textAlign: 'left',
                marginBottom: 24,
                border: '1px solid var(--border)',
              }}
            >
              <p className="fw-600 mb-8" style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                Booking Summary
              </p>
              <div style={{ display: 'grid', gap: 6, fontSize: '0.8125rem' }}>
                <div className="flex items-center gap-8">
                  <span className="text-tertiary" style={{ minWidth: 70 }}>Route:</span>
                  <span className="fw-600">{success.origin} → {success.destination}</span>
                </div>
                <div className="flex items-center gap-8">
                  <span className="text-tertiary" style={{ minWidth: 70 }}>Sender:</span>
                  <span>{success.sender_name}</span>
                </div>
                <div className="flex items-center gap-8">
                  <span className="text-tertiary" style={{ minWidth: 70 }}>Receiver:</span>
                  <span>{success.receiver_name}</span>
                </div>
                <div className="flex items-center gap-8">
                  <span className="text-tertiary" style={{ minWidth: 70 }}>Status:</span>
                  <span className="fw-600" style={{ color: 'var(--primary)' }}>Pending</span>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-12" style={{ flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-primary flex-1"
                onClick={handleReset}
                style={{ gap: 8 }}
              >
                <RotateCcw size={16} /> Create Another Booking
              </button>
              <button
                type="button"
                className="btn btn-ghost flex-1"
                onClick={() => navigate(`/admin/orders/${success.id}`)}
                style={{ gap: 8 }}
              >
                <Package size={16} /> View Order
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Form ───────────────────────────────────────────────────────────────────

  return (
    <div className="page-transition">
      <button type="button" onClick={() => navigate(-1)} className="btn btn-ghost mb-16">
        <ArrowLeft size={18} aria-hidden="true" /> Back
      </button>

      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title">
            <Plus size={24} color="var(--primary)" aria-hidden="true" />Create Booking
          </h1>
          <p className="admin-page-subtitle">
            Create a booking on behalf of a customer (e.g. via Facebook Messenger).
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} noValidate>

        {/* ── Route ─────────────────────────────────────────── */}
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
              aria-describedby={fieldErrors.route ? 'route-error' : undefined}
              tabIndex={fieldErrors.route ? -1 : undefined}
            >
              {ROUTES.map(r => (
                <button
                  type="button"
                  key={r.label}
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
            <FieldError name="route" errors={fieldErrors} id="route-error" />
          </div>
        </div>

        {/* ── Sender Details ─────────────────────────────────── */}
        <div className="card stagger-item mb-16" style={{ animationDelay: '60ms' }}>
          <div className="card-body">
            <h3 className="fw-700 mb-16 flex items-center gap-8">
              <User size={18} color="var(--primary)" aria-hidden="true" /> Sender Details
            </h3>
            <div className="grid grid-2 gap-16">
              {/* Full Name — full width */}
              <div className="form-group col-full">
                <label className="form-label" htmlFor="ab-sender-name">Full Name</label>
                <input
                  id="ab-sender-name"
                  type="text"
                  className={`form-input ${invalidClass('sender_name', fieldErrors)}`}
                  value={form.sender_name}
                  onChange={handleTextChange('sender_name')}
                  placeholder="e.g. Juan Dela Cruz"
                  autoCapitalize="words"
                  required
                  {...fieldAttrs('sender_name', fieldErrors)}
                />
                <FieldError name="sender_name" errors={fieldErrors} />
              </div>

              {/* Phone */}
              <div className="form-group">
                <label className="form-label" htmlFor="ab-sender-phone">Mobile Number</label>
                <input
                  id="ab-sender-phone"
                  type="tel"
                  className={`form-input ${invalidClass('sender_phone', fieldErrors)}`}
                  value={form.sender_phone}
                  onChange={e => u('sender_phone', e.target.value.replace(/\D/g, '').slice(0, 11))}
                  placeholder="09XXXXXXXXX"
                  inputMode="numeric"
                  maxLength={11}
                  required
                  {...fieldAttrs('sender_phone', fieldErrors)}
                />
                <FieldError name="sender_phone" errors={fieldErrors} />
              </div>

              {/* Facebook */}
              <div className="form-group">
                <label className="form-label" htmlFor="ab-sender-facebook">Facebook Name</label>
                <input
                  id="ab-sender-facebook"
                  type="text"
                  className={`form-input ${invalidClass('sender_facebook', fieldErrors)}`}
                  value={form.sender_facebook}
                  onChange={handleTextChange('sender_facebook')}
                  placeholder="Name on Facebook"
                  autoCapitalize="words"
                  required
                  {...fieldAttrs('sender_facebook', fieldErrors)}
                />
                <FieldError name="sender_facebook" errors={fieldErrors} />
              </div>

              {/* Province */}
              <div className="form-group">
                <label className="form-label" htmlFor="ab-sender-province">Province</label>
                <CustomSelect
                  id="ab-sender-province"
                  className={`form-select ${invalidClass('sender_province', fieldErrors)}`}
                  value={form.sender_province}
                  onChange={e => handleSenderProvinceChange(e.target.value)}
                  {...fieldAttrs('sender_province', fieldErrors)}
                >
                  <option value="">Select Province</option>
                  {senderProvinces.map(p => <option key={p} value={p}>{p}</option>)}
                </CustomSelect>
                <FieldError name="sender_province" errors={fieldErrors} />
              </div>

              {/* City */}
              <div className="form-group">
                <label className="form-label" htmlFor="ab-sender-city">City / Municipality</label>
                <CustomSelect
                  id="ab-sender-city"
                  className={`form-select ${invalidClass('sender_city', fieldErrors)}`}
                  value={form.sender_city}
                  onChange={e => handleSenderCityChange(e.target.value)}
                  disabled={!form.sender_province}
                  {...fieldAttrs('sender_city', fieldErrors)}
                >
                  <option value="">Select City</option>
                  {senderCities.map(c => <option key={c} value={c}>{c}</option>)}
                </CustomSelect>
                <FieldError name="sender_city" errors={fieldErrors} />
              </div>

              {/* Barangay */}
              <div className="form-group">
                <label className="form-label" htmlFor="ab-sender-barangay">Barangay</label>
                <BarangaySelect
                  id="ab-sender-barangay"
                  className={invalidClass('sender_barangay', fieldErrors)}
                  province={form.sender_province}
                  city={form.sender_city}
                  value={form.sender_barangay}
                  onChange={e => u('sender_barangay', e.target.value)}
                  {...fieldAttrs('sender_barangay', fieldErrors)}
                />
                <FieldError name="sender_barangay" errors={fieldErrors} />
              </div>

              {/* Street */}
              <div className="form-group">
                <label className="form-label" htmlFor="ab-sender-street">Street</label>
                <input
                  id="ab-sender-street"
                  type="text"
                  className={`form-input ${invalidClass('sender_street', fieldErrors)}`}
                  value={form.sender_street}
                  onChange={handleTextChange('sender_street')}
                  autoCapitalize="words"
                  required
                  {...fieldAttrs('sender_street', fieldErrors)}
                />
                <FieldError name="sender_street" errors={fieldErrors} />
              </div>

              {/* Lot / Block / Purok */}
              <div className="form-group">
                <label className="form-label" htmlFor="ab-sender-lot-block">Lot / Block / Purok</label>
                <input
                  id="ab-sender-lot-block"
                  type="text"
                  className={`form-input ${invalidClass('sender_lot_block', fieldErrors)}`}
                  value={form.sender_lot_block}
                  onChange={handleTextChange('sender_lot_block')}
                  autoCapitalize="words"
                  required
                  {...fieldAttrs('sender_lot_block', fieldErrors)}
                />
                <FieldError name="sender_lot_block" errors={fieldErrors} />
              </div>

              {/* Landmark */}
              <div className="form-group">
                <label className="form-label" htmlFor="ab-sender-landmark">Landmark</label>
                <input
                  id="ab-sender-landmark"
                  type="text"
                  className={`form-input ${invalidClass('sender_landmark', fieldErrors)}`}
                  value={form.sender_landmark}
                  onChange={handleTextChange('sender_landmark')}
                  placeholder="Near what building/place?"
                  autoCapitalize="words"
                  required
                  {...fieldAttrs('sender_landmark', fieldErrors)}
                />
                <FieldError name="sender_landmark" errors={fieldErrors} />
              </div>
            </div>
          </div>
        </div>

        {/* ── Receiver Details ───────────────────────────────── */}
        <div className="card stagger-item mb-16" style={{ animationDelay: '120ms' }}>
          <div className="card-body">
            <h3 className="fw-700 mb-16 flex items-center gap-8">
              <MapPin size={18} color="var(--primary)" aria-hidden="true" /> Receiver Details
            </h3>
            <div className="grid grid-2 gap-16">
              {/* Full Name — full width */}
              <div className="form-group col-full">
                <label className="form-label" htmlFor="ab-receiver-name">Full Name</label>
                <input
                  id="ab-receiver-name"
                  type="text"
                  className={`form-input ${invalidClass('receiver_name', fieldErrors)}`}
                  value={form.receiver_name}
                  onChange={handleTextChange('receiver_name')}
                  placeholder="e.g. Maria Santos"
                  autoCapitalize="words"
                  required
                  {...fieldAttrs('receiver_name', fieldErrors)}
                />
                <FieldError name="receiver_name" errors={fieldErrors} />
              </div>

              {/* Phone */}
              <div className="form-group">
                <label className="form-label" htmlFor="ab-receiver-phone">Mobile Number</label>
                <input
                  id="ab-receiver-phone"
                  type="tel"
                  className={`form-input ${invalidClass('receiver_phone', fieldErrors)}`}
                  value={form.receiver_phone}
                  onChange={e => u('receiver_phone', e.target.value.replace(/\D/g, '').slice(0, 11))}
                  placeholder="09XXXXXXXXX"
                  inputMode="numeric"
                  maxLength={11}
                  required
                  {...fieldAttrs('receiver_phone', fieldErrors)}
                />
                <FieldError name="receiver_phone" errors={fieldErrors} />
              </div>

              {/* Facebook */}
              <div className="form-group">
                <label className="form-label" htmlFor="ab-receiver-facebook">Facebook Name</label>
                <input
                  id="ab-receiver-facebook"
                  type="text"
                  className={`form-input ${invalidClass('receiver_facebook', fieldErrors)}`}
                  value={form.receiver_facebook}
                  onChange={handleTextChange('receiver_facebook')}
                  placeholder="Name on Facebook"
                  autoCapitalize="words"
                  required
                  {...fieldAttrs('receiver_facebook', fieldErrors)}
                />
                <FieldError name="receiver_facebook" errors={fieldErrors} />
              </div>

              {/* Province */}
              <div className="form-group">
                <label className="form-label" htmlFor="ab-receiver-province">Province</label>
                <CustomSelect
                  id="ab-receiver-province"
                  className={`form-select ${invalidClass('receiver_province', fieldErrors)}`}
                  value={form.receiver_province}
                  onChange={e => handleReceiverProvinceChange(e.target.value)}
                  {...fieldAttrs('receiver_province', fieldErrors)}
                >
                  <option value="">Select Province</option>
                  {receiverProvinces.map(p => <option key={p} value={p}>{p}</option>)}
                </CustomSelect>
                <FieldError name="receiver_province" errors={fieldErrors} />
              </div>

              {/* City */}
              <div className="form-group">
                <label className="form-label" htmlFor="ab-receiver-city">City / Municipality</label>
                <CustomSelect
                  id="ab-receiver-city"
                  className={`form-select ${invalidClass('receiver_city', fieldErrors)}`}
                  value={form.receiver_city}
                  onChange={e => handleReceiverCityChange(e.target.value)}
                  disabled={!form.receiver_province}
                  {...fieldAttrs('receiver_city', fieldErrors)}
                >
                  <option value="">Select City</option>
                  {receiverCities.map(c => <option key={c} value={c}>{c}</option>)}
                </CustomSelect>
                <FieldError name="receiver_city" errors={fieldErrors} />
              </div>

              {/* Barangay */}
              <div className="form-group">
                <label className="form-label" htmlFor="ab-receiver-barangay">Barangay</label>
                <BarangaySelect
                  id="ab-receiver-barangay"
                  className={invalidClass('receiver_barangay', fieldErrors)}
                  province={form.receiver_province}
                  city={form.receiver_city}
                  value={form.receiver_barangay}
                  onChange={e => u('receiver_barangay', e.target.value)}
                  {...fieldAttrs('receiver_barangay', fieldErrors)}
                />
                <FieldError name="receiver_barangay" errors={fieldErrors} />
              </div>

              {/* Street */}
              <div className="form-group">
                <label className="form-label" htmlFor="ab-receiver-street">Street</label>
                <input
                  id="ab-receiver-street"
                  type="text"
                  className={`form-input ${invalidClass('receiver_street', fieldErrors)}`}
                  value={form.receiver_street}
                  onChange={handleTextChange('receiver_street')}
                  autoCapitalize="words"
                  required
                  {...fieldAttrs('receiver_street', fieldErrors)}
                />
                <FieldError name="receiver_street" errors={fieldErrors} />
              </div>

              {/* Lot / Block / Purok */}
              <div className="form-group">
                <label className="form-label" htmlFor="ab-receiver-lot-block">Lot / Block / Purok</label>
                <input
                  id="ab-receiver-lot-block"
                  type="text"
                  className={`form-input ${invalidClass('receiver_lot_block', fieldErrors)}`}
                  value={form.receiver_lot_block}
                  onChange={handleTextChange('receiver_lot_block')}
                  autoCapitalize="words"
                  required
                  {...fieldAttrs('receiver_lot_block', fieldErrors)}
                />
                <FieldError name="receiver_lot_block" errors={fieldErrors} />
              </div>

              {/* Landmark */}
              <div className="form-group">
                <label className="form-label" htmlFor="ab-receiver-landmark">Landmark</label>
                <input
                  id="ab-receiver-landmark"
                  type="text"
                  className={`form-input ${invalidClass('receiver_landmark', fieldErrors)}`}
                  value={form.receiver_landmark}
                  onChange={handleTextChange('receiver_landmark')}
                  placeholder="Near what building/place?"
                  autoCapitalize="words"
                  required
                  {...fieldAttrs('receiver_landmark', fieldErrors)}
                />
                <FieldError name="receiver_landmark" errors={fieldErrors} />
              </div>
            </div>
          </div>
        </div>

        {/* ── Package Details ────────────────────────────────── */}
        <div className="card stagger-item mb-16" style={{ animationDelay: '180ms' }}>
          <div className="card-body">
            <h3 className="fw-700 mb-16 flex items-center gap-8">
              <Package size={18} color="var(--primary)" aria-hidden="true" /> Package Details
            </h3>
            <div className="form-group">
              <label className="form-label" htmlFor="ab-description">Description</label>
              <textarea
                id="ab-description"
                className={`form-textarea ${invalidClass('package_description', fieldErrors)}`}
                value={form.package_description}
                onChange={e => u('package_description', e.target.value)}
                placeholder="e.g. 2 boxes of dried fish, 1 bag of pasalubong"
                rows={3}
                required
                {...fieldAttrs('package_description', fieldErrors)}
              />
              <FieldError name="package_description" errors={fieldErrors} />
            </div>
            <div className="form-group mt-16">
              <label className="form-label" htmlFor="ab-notes">
                Notes <span className="fw-400 text-tertiary" style={{ fontSize: '0.8125rem' }}>(Optional)</span>
              </label>
              <textarea
                id="ab-notes"
                className="form-textarea"
                value={form.notes}
                onChange={e => u('notes', e.target.value)}
                placeholder='e.g. "Customer estimates ~5kg", "Handle with care — fragile items"'
                rows={2}
              />
            </div>
          </div>
        </div>

        {/* ── Payment Preference ─────────────────────────────── */}
        <div className="card stagger-item mb-24" style={{ animationDelay: '240ms' }}>
          <div className="card-body">
            <h3 className="fw-700 mb-16 flex items-center gap-8">
              <CreditCard size={18} color="var(--primary)" aria-hidden="true" /> Payment Preference
            </h3>
            <div className="form-group">
              <label className="form-label" htmlFor="ab-payment">Payment Method</label>
              <select
                id="ab-payment"
                className="form-input"
                value={form.payment_preference}
                onChange={e => u('payment_preference', e.target.value)}
              >
                <option value="unspecified">Not specified yet</option>
                <option value="cash">Cash</option>
                <option value="gcash">GCash</option>
              </select>
              <p className="text-xs text-tertiary mt-4">
                The customer's preferred payment method. This can be updated later when the package is weighed and priced.
              </p>
            </div>
          </div>
        </div>

        {/* ── Submit ─────────────────────────────────────────── */}
        <div className="admin-form-actions">
          <button
            type="submit"
            className="btn btn-primary btn-lg admin-form-submit"
            disabled={loading}
            style={{ minWidth: 200 }}
          >
            {loading
              ? <><Loader size={18} className="animate-spin" /> Creating Booking...</>
              : <><Package size={18} /> Create Booking</>
            }
          </button>
        </div>
      </form>
    </div>
  );
};

export default AdminCreateBookingPage;
