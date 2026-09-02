import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useLocation, useBlocker } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { createOrder, getTrips, getSettings } from '../../lib/database';
import { logOrder } from '../../lib/activityLog';
import { buildFullAddress } from '../../lib/address';
import { ROUTES, PH_LOCATIONS, VALID_PROVINCES, detectPickupLocation, validateRouteProvinces } from '../../constants/phLocations';
import { isTripBookable } from '../../constants/status';
import { ArrowLeft, Loader, CheckCircle, Copy, Check, Package, MapPin, User, Truck, AlertTriangle, Info } from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import CustomSelect from '../../components/ui/CustomSelect';
import BarangaySelect from '../../components/ui/BarangaySelect';
import ConfirmModal from '../../components/ui/ConfirmModal';
import { motion, useReducedMotion } from 'framer-motion';
import usePageTitle from '../../hooks/usePageTitle';
import { formatMoney } from '../../utils/currencyInput';
import { toTitleCase, toAddressCase, normalizeName } from '../../utils/string';
import { formatPhDate } from '../../utils/datetime';
import { validatePhone } from '../../utils/phone';
import { hasMeaningfulBookingData } from '../../lib/bookingDraft';

const luxeEase = [0.22, 1, 0.36, 1];

function fallbackCopy(text) {
  const el = document.createElement('textarea');
  el.value = text;
  el.setAttribute('readonly', '');
  el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;padding:0;border:none;outline:none;box-shadow:none;background:transparent;opacity:0';
  document.body.appendChild(el);
  el.focus();
  el.select();
  el.setSelectionRange(0, text.length);
  try { document.execCommand('copy'); } catch { /* fallback copy command failure silent */ }
  document.body.removeChild(el);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Trip dates render in Asia/Manila regardless of the device zone — see
// src/utils/datetime.js for why the naive-timestamp path shifted the day.
const formatBookingTripDate = (value) => {
  if (!value) return 'Date not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date not set';
  return formatPhDate(date, { month: 'short', day: 'numeric', year: 'numeric' });
};

const formatBookingTripOption = (trip) => {
  const date = trip.departure_date ? new Date(trip.departure_date) : null;
  const dateLabel = date && !Number.isNaN(date.getTime())
    ? formatPhDate(date, { month: 'short', day: 'numeric', year: undefined })
    : 'Date TBD';
  return `${trip.trip_number} - ${dateLabel}`;
};

const formatKg = (value) => {
  const n = Number(value || 0);
  return `${Number.isInteger(n) ? n.toFixed(0) : n.toFixed(1)} kg`;
};

const BookShipmentPage = () => {
  usePageTitle('Book Shipment');
  const { user, userProfile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const preRoute  = location.state?.preselectedRoute  || '';
  const preTripId = location.state?.preselectedTripId || '';

  const [step, setStep] = useState(() => {
    try {
      const savedStep = sessionStorage.getItem('booking_step');
      return savedStep ? parseInt(savedStep, 10) : 1;
    } catch {
      return 1;
    }
  });
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [success, setSuccess] = useState(null);
  const [trips, setTrips] = useState([]);
  const [pricePerKilo, setPricePerKilo] = useState(70);

  const [form, setForm] = useState(() => {
    const defaultForm = {
      route: preRoute, trip_id: preTripId,
      sender_name: '', sender_phone: '', sender_facebook: '',
      sender_lot_block: '', sender_street: '', sender_barangay: '',
      sender_city: '', sender_province: '', sender_landmark: '',
      receiver_name: '', receiver_phone: '', receiver_facebook: '',
      receiver_lot_block: '', receiver_street: '', receiver_barangay: '',
      receiver_city: '', receiver_province: '', receiver_landmark: '',
      package_description: '',
      payer_type: 'sender', payment_preference: 'unspecified', notes: '', sender_other_province: '',
    };
    try {
      const savedForm = sessionStorage.getItem('booking_form');
      const parsed = savedForm ? JSON.parse(savedForm) : null;
      return parsed ? { ...defaultForm, ...parsed, ...(preRoute ? { route: preRoute } : {}), ...(preTripId ? { trip_id: preTripId } : {}) } : defaultForm;
    } catch {
      return defaultForm;
    }
  });

  // Guards against a double POST; see handleSubmit.
  const submittingRef = useRef(false);

  const [useRegisteredSender, setUseRegisteredSender] = useState(false);
  const [useRegisteredReceiver, setUseRegisteredReceiver] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});

  // Block navigation only after the customer has entered meaningful booking
  // data. Route/trip selection is lightweight setup and safe to repeat; treating
  // it as a dirty draft produced a discard warning before any data was entered.
  const isFormDirty = useCallback(() => {
    if (success) return false; // Don't block after successful submission
    return hasMeaningfulBookingData(form);
  }, [success, form]);

  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    return isFormDirty() && currentLocation.pathname !== nextLocation.pathname;
  });

  const u = (k, v) => {
    setForm(p => ({ ...p, [k]: v }));
    // Clear field error on edit
    if (fieldErrors[k]) setFieldErrors(p => { const n = { ...p }; delete n[k]; return n; });
    if (k.startsWith('sender_')) setUseRegisteredSender(false);
    if (k.startsWith('receiver_')) setUseRegisteredReceiver(false);
  };
  const handleTextChange = (key) => (e) => u(key, toTitleCase(e.target.value));
  // Street/Lot-Block/Landmark: capitalize each word's first letter only —
  // never lowercase the rest, so deliberate acronyms ("STI School") survive.
  const handleAddressChange = (key) => (e) => u(key, toAddressCase(e.target.value));
  const handlePhoneChange = (key) => (e) => u(key, e.target.value.replace(/\D/g, '').slice(0, 11));

  useEffect(() => {
    setInitialLoading(true);
    Promise.all([
      getTrips('active').then(setTrips).catch(() => {}),
      getSettings().then(s => { if (s.price_per_kilo) setPricePerKilo(parseFloat(s.price_per_kilo)); }).catch(() => {}),
    ]).finally(() => setInitialLoading(false));
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem('booking_step', step.toString());
    } catch { /* sessionStorage may be blocked in private mode */ }
  }, [step]);

  useEffect(() => {
    try {
      sessionStorage.setItem('booking_form', JSON.stringify(form));
    } catch { /* sessionStorage may be blocked in private mode */ }
  }, [form]);

  const selectedRoute = ROUTES.find(r => r.label === form.route);
  // Route match AND departure not yet past — a trip an admin forgot to close
  // must not remain bookable. See isTripBookable() in constants/status.js.
  const filteredTrips = trips.filter(t =>
    selectedRoute &&
    t.origin === selectedRoute.origin &&
    t.destination === selectedRoute.destination &&
    isTripBookable(t)
  );
  const selectedTrip = filteredTrips.find(t => t.id === form.trip_id);
  const effectivePricePerKilo = parseFloat(selectedTrip?.price_per_kg || 0) > 0 ? parseFloat(selectedTrip.price_per_kg) : pricePerKilo;
  // No cost preview: weight is the only price input and the customer no
  // longer declares one. The parcel is priced when it is weighed at pickup.
  const selectedTripCapacity = Number(selectedTrip?.capacity || 0);
  const selectedTripCurrentWeight = Number(selectedTrip?.current_weight || 0);
  const selectedTripRemainingCapacity = selectedTrip && selectedTripCapacity > 0
    ? Math.max(0, selectedTripCapacity - selectedTripCurrentWeight)
    : null;

  const getSenderProvinces = () => {
    if (!selectedRoute) return VALID_PROVINCES;
    // "Other Area" pickups are only accepted when delivering to Bohol.
    if (selectedRoute.origin === 'Bohol') return ['Bohol'];
    return ['Metro Manila', 'Cavite', 'Batangas', 'Laguna', 'Bulacan', 'Other Area'];
  };
  const getReceiverProvinces = () => {
    if (!selectedRoute) return VALID_PROVINCES;
    if (selectedRoute.destination === 'Bohol') return ['Bohol'];
    return ['Metro Manila', 'Cavite', 'Batangas', 'Laguna', 'Bulacan'];
  };

  const senderCities = form.sender_province ? PH_LOCATIONS[form.sender_province] || [] : [];
  const receiverCities = form.receiver_province ? PH_LOCATIONS[form.receiver_province] || [] : [];

  const handleRouteChange = (label) => {
    u('route', label);
    if (label !== form.route) u('trip_id', '');
    const route = ROUTES.find(r => r.label === label);
    if (route) {
      const senderSide = detectPickupLocation(form.sender_province);
      const expectedSender = route.origin === 'Bohol' ? 'bohol' : 'manila';
      if (form.sender_province && senderSide !== expectedSender) { u('sender_province', ''); u('sender_city', ''); }
      u('receiver_province', ''); u('receiver_city', '');
      setUseRegisteredSender(false); setUseRegisteredReceiver(false);
    }
  };

  const userProfileLocation = userProfile?.address_province ? detectPickupLocation(userProfile.address_province) : null;
  const showSenderCheckbox = selectedRoute && userProfileLocation === (selectedRoute.origin === 'Bohol' ? 'bohol' : 'manila');
  const showReceiverCheckbox = selectedRoute && userProfileLocation === (selectedRoute.destination === 'Bohol' ? 'bohol' : 'manila');

  const clearPrefixFieldErrors = (prefix) => {
    setFieldErrors(p => {
      const next = { ...p };
      Object.keys(next).forEach(key => {
        if (key.startsWith(`${prefix}_`)) delete next[key];
      });
      return next;
    });
  };

  const handleUseRegisteredSenderChange = (checked) => {
    setUseRegisteredSender(checked);
    // Bulk fill/clear bypasses `u()`, so clear sender field errors so red borders
    // and inline messages don't stick after autofill from registered address.
    clearPrefixFieldErrors('sender');
    if (checked && userProfile) {
      setForm(p => ({
        ...p,
        sender_name: userProfile.name || '', sender_phone: userProfile.phone || '', sender_facebook: userProfile.facebook_name || '',
        sender_lot_block: userProfile.address_lot_block || '', sender_street: userProfile.address_street || '',
        sender_barangay: userProfile.address_barangay || '', sender_city: userProfile.address_city || '',
        sender_province: userProfile.address_province || '', sender_landmark: userProfile.address_landmark || '',
      }));
    } else {
      setForm(p => ({
        ...p,
        sender_name: '', sender_phone: '', sender_facebook: '',
        sender_lot_block: '', sender_street: '', sender_barangay: '',
        sender_city: '', sender_province: '', sender_landmark: '',
      }));
    }
  };

  const handleUseRegisteredReceiverChange = (checked) => {
    setUseRegisteredReceiver(checked);
    // Same as sender: registered-address autofill must clear leftover validation UI.
    clearPrefixFieldErrors('receiver');
    if (checked && userProfile) {
      setForm(p => ({
        ...p,
        receiver_name: userProfile.name || '', receiver_phone: userProfile.phone || '', receiver_facebook: userProfile.facebook_name || '',
        receiver_lot_block: userProfile.address_lot_block || '', receiver_street: userProfile.address_street || '',
        receiver_barangay: userProfile.address_barangay || '', receiver_city: userProfile.address_city || '',
        receiver_province: userProfile.address_province || '', receiver_landmark: userProfile.address_landmark || '',
      }));
    } else {
      setForm(p => ({
        ...p,
        receiver_name: '', receiver_phone: '', receiver_facebook: '',
        receiver_lot_block: '', receiver_street: '', receiver_barangay: '',
        receiver_city: '', receiver_province: '', receiver_landmark: '',
      }));
    }
  };

  const validateSender = () => {
    const errs = {};
    if (!form.sender_name) errs.sender_name = 'Full Name is required.';
    if (!form.sender_facebook) errs.sender_facebook = 'Facebook Name is required.';
    if (!form.sender_province) errs.sender_province = 'Province is required.';
    else if (form.sender_province === 'Other Area' && selectedRoute?.destination !== 'Bohol') {
      errs.sender_province = 'Out-of-coverage pickup is only available when delivering to Bohol. Please select a listed province.';
    }
    if (form.sender_province === 'Other Area' && !form.sender_other_province) errs.sender_other_province = 'Exact province is required.';
    if (!form.sender_city) errs.sender_city = 'City is required.';
    if (!form.sender_barangay) errs.sender_barangay = 'Barangay is required.';
    if (!form.sender_street) errs.sender_street = 'Street is required.';
    if (!form.sender_lot_block) errs.sender_lot_block = 'Lot / Block / Purok is required.';
    if (!form.sender_landmark) errs.sender_landmark = 'Landmark is required.';
    const phoneErr = validatePhone(form.sender_phone);
    if (phoneErr) errs.sender_phone = phoneErr;
    return errs;
  };

  const validateReceiver = () => {
    const errs = {};
    if (!form.receiver_name) errs.receiver_name = 'Full Name is required.';
    if (!form.receiver_facebook) errs.receiver_facebook = 'Facebook Name is required.';
    if (!form.receiver_province) errs.receiver_province = 'Province is required.';
    if (!form.receiver_city) errs.receiver_city = 'City is required.';
    if (!form.receiver_barangay) errs.receiver_barangay = 'Barangay is required.';
    if (!form.receiver_street) errs.receiver_street = 'Street is required.';
    if (!form.receiver_lot_block) errs.receiver_lot_block = 'Lot / Block / Purok is required.';
    if (!form.receiver_landmark) errs.receiver_landmark = 'Landmark is required.';
    const phoneErr = validatePhone(form.receiver_phone);
    if (phoneErr) errs.receiver_phone = phoneErr;
    return errs;
  };

  // After a failed validation, move focus to the first field flagged invalid.
  // Queried from the DOM rather than mapped from error keys — the key/id naming
  // is not 1:1 (e.g. `lot_block` -> `lot-block`), and a mapping would break
  // silently the moment a field is renamed.
  const focusFirstInvalid = () => {
    requestAnimationFrame(() => {
      const el = document.querySelector('.booking-page [aria-invalid="true"]');
      if (el && typeof el.focus === 'function') el.focus();
    });
  };

  const handleSubmit = async () => {
    // Synchronous re-entry guard. `loading` disables the button, but state
    // updates are async — two clicks inside the same React batch both pass the
    // disabled check and fire two createOrder() calls. createOrder is a POST:
    // a second one is a second booking, not a retry. A ref closes that window
    // because it is set before any await.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setLoading(true);
    // When validation sends the user back to a step, we focus the offending
    // field — and focusing already scrolls it into view. The catch block's
    // scroll-to-top would fight that, yanking the page away from the field the
    // user was just sent to fix, so it is skipped on that path only.
    let focusingInvalidField = false;
    try {
      if (!selectedRoute) throw new Error('Please select a route.');
      // C-2 fix: Navigate to the step containing the error before throwing
      const sErrs = validateSender(); if (Object.keys(sErrs).length) { setFieldErrors(sErrs); setStep(2); focusingInvalidField = true; focusFirstInvalid(); throw new Error('Please fix sender details.'); }
      const rErrs = validateReceiver(); if (Object.keys(rErrs).length) { setFieldErrors(rErrs); setStep(3); focusingInvalidField = true; focusFirstInvalid(); throw new Error('Please fix receiver details.'); }
      const validation = validateRouteProvinces(form.sender_province, form.receiver_province, selectedRoute);
      if (!validation.valid) throw new Error(validation.error);
      
      if (form.sender_province === 'Other Area' && selectedRoute.destination !== 'Bohol') {
        throw new Error('CargoExpress PH currently delivers to Bohol destinations only.');
      }
      
      const fullSenderAddress = buildFullAddress({ lotBlock: form.sender_lot_block, street: form.sender_street, barangay: form.sender_barangay, city: form.sender_city, province: form.sender_province === 'Other Area' ? form.sender_other_province : form.sender_province, landmark: form.sender_landmark });
      const fullReceiverAddress = buildFullAddress({ lotBlock: form.receiver_lot_block, street: form.receiver_street, barangay: form.receiver_barangay, city: form.receiver_city, province: form.receiver_province, landmark: form.receiver_landmark });

      const payload = {
        user_id: user.id,
        origin: selectedRoute.origin, destination: selectedRoute.destination, trip_id: selectedTrip ? form.trip_id : null,
        sender_name: normalizeName(form.sender_name), sender_phone: form.sender_phone, sender_address: fullSenderAddress,
        sender_facebook: normalizeName(form.sender_facebook), sender_city: form.sender_city, sender_province: form.sender_province === 'Other Area' ? form.sender_other_province : form.sender_province,
        receiver_name: normalizeName(form.receiver_name), receiver_phone: form.receiver_phone, receiver_address: fullReceiverAddress,
        receiver_facebook: normalizeName(form.receiver_facebook), receiver_city: form.receiver_city, receiver_province: form.receiver_province,
        package_description: form.package_description,
        payer_type: form.payer_type, payment_preference: form.payment_preference, notes: form.notes,
      };
      
      if (form.sender_province === 'Other Area') {
        payload.service_area_status = 'for_review';
        payload.status = 'Pending Review';
      }
      
      const data = await createOrder(payload);
      
      if (payload.service_area_status === 'for_review') {
        await logOrder('Out-of-Coverage Booking Submitted', data.id, data.tracking_number, { details: `Special pickup request submitted for ${data.sender_address}` });
      } else {
        await logOrder('Booking Created', data.id, data.tracking_number, { details: 'Standard booking created via Customer Portal.' });
      }
      
      setSuccess(data);
      // Not clearing `loading` here: `success` now takes over rendering via
      // the early-return below, and this page never reads `loading` again —
      // clearing it would risk a frame of the un-loading form before that
      // switch.
      try {
        sessionStorage.removeItem('booking_form');
        sessionStorage.removeItem('booking_step');
      } catch { /* sessionStorage unavailable in private mode */ }
    } catch (err) {
      toast.error(err.message || 'An unexpected error occurred while saving the booking.');
      if (!focusingInvalidField) window.scrollTo({ top: 0, behavior: 'smooth' });
      setLoading(false);
    } finally {
      submittingRef.current = false;
    }
  };

  const renderAddressFields = (prefix) => {
    const isSender = prefix === 'sender';
    const cities = isSender ? senderCities : receiverCities;
    const getProvinces = isSender ? getSenderProvinces : getReceiverProvinces;
    const id = (field) => `${prefix}-${field}`;
    const errId = (key) => `${prefix}-${key}-error`;
    const fe = (key) => fieldErrors[`${prefix}_${key}`];
    const fc = (key) => fe(key) ? 'field-invalid' : '';
    // Programmatic error association. Without aria-invalid + aria-describedby a
    // screen reader announces the label and reads nothing about the error — the
    // red border and inline text are visual-only.
    const a11y = (key) => ({
      'aria-invalid': fe(key) ? 'true' : undefined,
      'aria-describedby': fe(key) ? errId(key) : undefined,
    });
    const errEl = (key) => fe(key)
      ? <div className="field-error-inline" id={errId(key)} role="alert"><AlertTriangle size={12} aria-hidden="true" />{fe(key)}</div>
      : null;
    return (
      <div className="grid grid-2 gap-16">
        <div className="form-group col-full"><label className="form-label" htmlFor={id('name')}>Full Name <span className="required">*</span></label><input id={id('name')} className={`form-input ${fc('name')}`} value={form[`${prefix}_name`]} onChange={handleTextChange(`${prefix}_name`)} autoComplete={isSender ? 'name' : 'shipping name'} autoCapitalize="words" required {...a11y('name')} />{errEl('name')}</div>
        <div className="form-group"><label className="form-label" htmlFor={id('phone')}>Mobile Number <span className="required">*</span></label><input id={id('phone')} className={`form-input ${fc('phone')}`} value={form[`${prefix}_phone`]} onChange={handlePhoneChange(`${prefix}_phone`)} inputMode="numeric" maxLength={11} placeholder="09xxxxxxxxx" autoComplete="tel" required {...a11y('phone')} />{errEl('phone')}</div>
        <div className="form-group"><label className="form-label" htmlFor={id('facebook')}>Facebook Name <span className="required">*</span></label><input id={id('facebook')} className={`form-input ${fc('facebook')}`} value={form[`${prefix}_facebook`]} onChange={handleTextChange(`${prefix}_facebook`)} placeholder="Your name on Facebook" autoCapitalize="words" required {...a11y('facebook')} />{errEl('facebook')}</div>
        <div className="form-group"><label className="form-label" htmlFor={id('province')}>Province <span className="required">*</span></label>
          <CustomSelect id={id('province')} className={`form-select ${fc('province')}`} value={form[`${prefix}_province`]} onChange={e => { u(`${prefix}_province`, e.target.value); u(`${prefix}_city`, ''); u(`${prefix}_barangay`, ''); }} {...a11y('province')}>
            <option value="">Select Province</option>
            {getProvinces().map(p => <option key={p} value={p}>{p}</option>)}
          </CustomSelect>{errEl('province')}
        </div>
        {isSender && form[`${prefix}_province`] === 'Other Area' && (
          <div className="form-group"><label className="form-label" htmlFor={id('other_province')}>Exact Province <span className="required">*</span></label><input id={id('other_province')} className={`form-input ${fc('other_province')}`} value={form[`${prefix}_other_province`] || ''} onChange={handleTextChange(`${prefix}_other_province`)} autoCapitalize="words" required {...a11y('other_province')} />{errEl('other_province')}</div>
        )}
        <div className="form-group"><label className="form-label" htmlFor={id('city')}>City / Municipality <span className="required">*</span></label>
          {isSender && form[`${prefix}_province`] === 'Other Area' ? (
            <input id={id('city')} className={`form-input ${fc('city')}`} value={form[`${prefix}_city`] || ''} onChange={e => { handleTextChange(`${prefix}_city`)(e); u(`${prefix}_barangay`, ''); }} autoCapitalize="words" required {...a11y('city')} />
          ) : (
            <CustomSelect id={id('city')} className={`form-select ${fc('city')}`} value={form[`${prefix}_city`]} onChange={e => { u(`${prefix}_city`, e.target.value); u(`${prefix}_barangay`, ''); }} disabled={!form[`${prefix}_province`]} {...a11y('city')}>
              <option value="">Select City</option>
              {cities.map(c => <option key={c} value={c}>{c}</option>)}
            </CustomSelect>
          )}
          {errEl('city')}
        </div>
        <div className="form-group"><label className="form-label" htmlFor={id('barangay')}>Barangay <span className="required">*</span></label>
          {/* An "Other Area" sender types their own city, so no barangay list
              exists for it — BarangaySelect degrades to a text input there
              rather than to an empty dropdown that cannot be satisfied. */}
          <BarangaySelect
            id={id('barangay')}
            className={fc('barangay')}
            province={isSender && form[`${prefix}_province`] === 'Other Area' ? '' : form[`${prefix}_province`]}
            city={form[`${prefix}_city`]}
            value={form[`${prefix}_barangay`]}
            onChange={e => u(`${prefix}_barangay`, e.target.value)}
            {...a11y('barangay')}
          />
          {errEl('barangay')}
        </div>
        <div className="form-group"><label className="form-label" htmlFor={id('street')}>Street and Subdivision (put NA if not applicable) <span className="required">*</span></label><input id={id('street')} className={`form-input ${fc('street')}`} value={form[`${prefix}_street`]} onChange={handleAddressChange(`${prefix}_street`)} placeholder="Street and Subdivision (put NA if not applicable)" autoComplete="address-line1" autoCapitalize="words" required {...a11y('street')} />{errEl('street')}</div>
        <div className="form-group"><label className="form-label" htmlFor={id('lot-block')}>Lot / Block / Purok <span className="required">*</span></label><input id={id('lot-block')} className={`form-input ${fc('lot_block')}`} value={form[`${prefix}_lot_block`]} onChange={handleAddressChange(`${prefix}_lot_block`)} autoComplete="address-line2" autoCapitalize="words" required {...a11y('lot_block')} />{errEl('lot_block')}</div>
        <div className="form-group"><label className="form-label" htmlFor={id('landmark')}>Landmark <span className="required">*</span></label><input id={id('landmark')} className={`form-input ${fc('landmark')}`} value={form[`${prefix}_landmark`]} onChange={handleAddressChange(`${prefix}_landmark`)} placeholder="Near what building/place?" autoCapitalize="words" required {...a11y('landmark')} />{errEl('landmark')}</div>
        {isSender && form[`${prefix}_province`] === 'Other Area' && (
          <div className="alert alert-warning mt-md col-full">
            <AlertTriangle size={16} className="inline" style={{marginRight: '8px', verticalAlign: 'middle'}}/>
            Your pickup location is outside our standard service coverage area. CargoExpress PH may still accommodate your request depending on operational availability. Our team will review your booking and contact you if additional arrangements are required.
          </div>
        )}
      </div>
    );
  };

  const [trackingCopied, setTrackingCopied] = useState(false);
  const reduceMotion = useReducedMotion();
  const particles = useMemo(
    () => Array.from({ length: 24 }, (_, i) => ({
      id: i,
      angle: (i / 24) * Math.PI * 2,
      distance: 100 + Math.random() * 80,
      size: 3 + Math.random() * 5,
      delay: 0.6 + Math.random() * 0.3,
    })),
    []
  );

  if (success) {
    const orderPath = success.id ? `/customer/orders/${success.id}` : '/customer/orders';
    const routeLabel = `${success.origin} → ${success.destination}`;
    const statusLabel = success.status || 'Pending';
    const isAssigned = statusLabel === 'Assigned';

    return (
      <div className="booking-success-page" aria-labelledby="booking-success-title">
        <div className="booking-success-content" role="status" aria-live="polite">
          {/* Checkmark with rings */}
          <div className="booking-success-visual">
            {/* Solid circle */}
            <motion.div
              className="booking-success-check-circle"
              initial={{ scale: 0, rotate: -45 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: 'spring', stiffness: 180, damping: 14, delay: 0.2 }}
            />

            {/* Particle burst */}
            {!reduceMotion && particles.map((p) => (
              <motion.span
                key={p.id}
                className="booking-success-particle"
                style={{ width: p.size, height: p.size, marginLeft: -p.size / 2, marginTop: -p.size / 2 }}
                initial={{ x: 0, y: 0, opacity: 0, scale: 0 }}
                animate={{
                  x: Math.cos(p.angle) * p.distance,
                  y: Math.sin(p.angle) * p.distance,
                  opacity: [0, 1, 0],
                  scale: [0, 1, 0.3],
                }}
                transition={{ duration: 1.2, delay: p.delay, ease: luxeEase }}
              />
            ))}

            {/* SVG checkmark drawn in */}
            <svg viewBox="0 0 100 100" className="booking-success-checkmark-svg">
              <motion.path
                d="M28 52 L44 68 L74 36"
                fill="none"
                stroke="#fff"
                strokeWidth="7"
                strokeLinecap="round"
                strokeLinejoin="round"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.7, delay: 0.55, ease: luxeEase }}
              />
            </svg>
          </div>

          {/* Eyebrow */}
          <motion.div
            className="booking-success-eyebrow"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.9, ease: luxeEase }}
          >
            {isAssigned ? 'Assigned' : 'Booked'}
          </motion.div>

          {/* Heading */}
          <motion.h1
            id="booking-success-title"
            className="booking-success-heading"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, delay: 1.0, ease: luxeEase }}
          >
            Shipment booked!
          </motion.h1>

          {/* Subtitle */}
          <motion.p
            className="booking-success-subtitle"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, delay: 1.15, ease: luxeEase }}
          >
            Your package is on its way. Track it anytime from your bookings.
          </motion.p>

          {/* Sets the pricing expectation the rest of the app states — the
              ticket itself carries no amount because the parcel isn't weighed yet. */}
          <motion.p
            className="text-xs text-tertiary"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 1.4 }}
          >
            Final cost is confirmed when we weigh your parcel at pickup.
          </motion.p>

          {/* Booking Details Card — Clean, high-precision receipt layout */}
          <motion.div
            className="pr-transaction-card booking-success-card"
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, delay: 1.3, ease: luxeEase }}
          >
            <div className="pr-transaction-header">Booking Details</div>

            <div className="pr-transaction-row">
              <span className="pr-transaction-label">Tracking Number</span>
              <div className="flex items-center gap-8">
                <span className="pr-transaction-value pr-transaction-id">#{success.tracking_number}</span>
                <button
                  type="button"
                  className={`booking-success-copy-btn${trackingCopied ? ' is-copied' : ''}`}
                  onClick={() => {
                    fallbackCopy(success.tracking_number);
                    setTrackingCopied(true);
                    setTimeout(() => setTrackingCopied(false), 2000);
                  }}
                  aria-label="Copy tracking number"
                  title="Copy tracking number"
                >
                  {trackingCopied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                </button>
              </div>
            </div>

            <div className="pr-transaction-row">
              <span className="pr-transaction-label">Route</span>
              <span className="pr-transaction-value">{routeLabel}</span>
            </div>

            <div className="pr-transaction-row">
              <span className="pr-transaction-label">Sender</span>
              <span className="pr-transaction-value">{success.sender_name}</span>
            </div>

            <div className="pr-transaction-row">
              <span className="pr-transaction-label">Receiver</span>
              <span className="pr-transaction-value">{success.receiver_name}</span>
            </div>

            {success.package_description && (
              <div className="pr-transaction-row">
                <span className="pr-transaction-label">Package Items</span>
                <span className="pr-transaction-value" style={{ maxWidth: '60%', textAlign: 'right' }}>
                  {success.package_description}
                </span>
              </div>
            )}

            <div className="pr-transaction-row">
              <span className="pr-transaction-label">Status</span>
              <span className={`booking-success-status-pill ${isAssigned ? 'is-assigned' : 'is-pending'}`}>
                {statusLabel}
              </span>
            </div>
          </motion.div>

          {/* Action buttons */}
          <motion.div
            className="booking-success-actions"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 1.5, ease: luxeEase }}
          >
            <button type="button" className="btn booking-success-btn-primary" onClick={() => navigate(orderPath)}>
              View Booking
            </button>
            <button
              type="button"
              className="btn booking-success-btn-outline"
              onClick={() => {
                try {
                  sessionStorage.removeItem('booking_form');
                  sessionStorage.removeItem('booking_step');
                } catch { /* sessionStorage unavailable in private mode */ }
                // handleSubmit deliberately leaves `loading` true on success
                // (see the comment there) so the success screen replaces the
                // form without a flash of the un-loading form first. Coming
                // back here via "Book Another" re-mounts that same form, so
                // `loading` has to be cleared explicitly or the submitting
                // overlay covers it immediately.
                setLoading(false);
                setSuccess(null);
                setStep(1);
                setFieldErrors({});
                setForm(prev => ({
                  ...prev,
                  route: '', trip_id: '',
                  sender_name: '', sender_phone: '', sender_facebook: '',
                  sender_lot_block: '', sender_street: '', sender_barangay: '',
                  sender_city: '', sender_province: '', sender_landmark: '',
                  receiver_name: '', receiver_phone: '', receiver_facebook: '',
                  receiver_lot_block: '', receiver_street: '', receiver_barangay: '',
                  receiver_city: '', receiver_province: '', receiver_landmark: '',
                  package_description: '',
                  payer_type: 'sender', payment_preference: 'unspecified', notes: '', sender_other_province: '',
                }));
              }}
            >
              Book Another
            </button>
          </motion.div>
        </div>
      </div>
    );
  }

  const steps = ['Route', 'Sender', 'Receiver', 'Package', 'Review'];

  return (
    <div className="page-transition booking-page">
      {/* Submitting overlay. The disabled button alone was not enough feedback:
          createOrder() can take many seconds, and if the review step is
          scrolled the spinner sits off-screen, leaving what looks like a dead
          page — and an invitation to click again. This covers the viewport, so
          the wait is visible from anywhere on the page and nothing underneath
          is clickable while the POST is in flight. */}
      {loading && (
        <div className="booking-submitting-overlay" role="alert" aria-live="assertive">
          <div className="booking-submitting-card">
            <Loader size={32} className="animate-spin" aria-hidden="true" />
            <div className="fw-700 mt-12">Submitting your booking…</div>
            <div className="text-sm text-secondary mt-4">
              This can take a few moments. Please don’t close or refresh this page.
            </div>
          </div>
        </div>
      )}

      {/* C-1 fix: Navigation blocker modal */}
      <ConfirmModal
        isOpen={blocker.state === 'blocked'}
        onClose={() => blocker.reset()}
        onConfirm={() => { sessionStorage.removeItem('booking_form'); sessionStorage.removeItem('booking_step'); blocker.proceed(); }}
        title="Discard unsaved booking?"
        message="You have unsaved changes in your booking form. If you leave now, all entered data will be lost."
        confirmLabel="Discard"
        cancelLabel="Stay"
        variant="danger"
      />

      <button type="button" onClick={() => step > 1 ? setStep(step - 1) : navigate(-1)} className="btn btn-ghost customer-back-action mb-16">
        <ArrowLeft size={18} /> {step > 1 ? 'Back' : 'Cancel'}
      </button>
      <h1 className="sr-only">Book Shipment</h1>
      <h2 className="fw-800 mb-8">Book Shipment</h2>

      {/* Step Progress */}
      <div className="step-progress" role="list" aria-label="Booking progress">
        {steps.map((s, i) => {
          const completed = step > i + 1;
          const stepClass = `step ${completed ? 'completed clickable' : step === i + 1 ? 'active' : ''}`;
          const stepChildren = (
            <>
              <div className="step-number" aria-current={step === i + 1 ? 'step' : undefined}>
                {completed ? <Check size={14} aria-hidden="true" /> : i + 1}
              </div>
              <span className="step-label">{s}</span>
            </>
          );

          return (
            <div key={s} role="listitem" className="flex items-center flex-1">
              {completed ? (
                <button
                  type="button"
                  className={stepClass}
                  onClick={() => setStep(i + 1)}
                  aria-label={`Go back to step ${i + 1}: ${s}`}
                >
                  {stepChildren}
                </button>
              ) : <div className={stepClass}>{stepChildren}</div>}
              {i < steps.length - 1 && <div className="step-connector" style={{ background: completed ? 'var(--success)' : 'var(--border)' }} />}
            </div>
          );
        })}
      </div>
      <div className="booking-current-step" aria-live="polite">Step {step} of {steps.length}: {steps[step - 1]}</div>

      {/* C-6 fix: Show loading indicator while initial data loads */}
      {initialLoading ? (
        <div className="card animate-fade-in"><div className="card-body flex items-center justify-center gap-8" style={{ minHeight: '200px' }} role="status" aria-live="polite">
          <Loader size={20} className="animate-spin" /> Loading booking form...
        </div></div>
      ) : <>

      {/* Step 1: Route */}
      {step === 1 && (
        <div className="card animate-fade-in"><div className="card-body">
          <h3 className="fw-700 mb-16 flex items-center gap-8"><MapPin size={18} aria-hidden="true" />Select Route</h3>
          <div className="alert-banner alert-banner-info mb-16" style={{ fontSize: '0.8125rem' }}>
            <Info size={14} aria-hidden="true" />
            <span><strong>Coverage Area:</strong> CargoExpress PH currently operates routes to and from <strong>Bohol only</strong>. Select a route below to view specific province rules.</span>
          </div>
          {preTripId && (
            <div className="alert-banner alert-banner-success mb-16">
              <CheckCircle size={16} /> Route & trip pre-selected from home page. You may change below if needed.
            </div>
          )}
          <div className="customer-route-options">
            {ROUTES.map(r => (
              <button key={r.label} type="button" className="customer-route-option card card-interactive" onClick={() => handleRouteChange(r.label)}
                aria-pressed={form.route === r.label}
                style={{ border: form.route === r.label ? '2px solid var(--primary)' : '1.5px solid var(--border)', background: form.route === r.label ? 'var(--primary-bg)' : 'var(--surface)' }}>
                <Truck size={24} color={form.route === r.label ? 'var(--primary)' : 'var(--text-tertiary)'} style={{ margin: '0 auto 8px' }} />
                <div className="customer-route-option-label">{r.label}</div>
              </button>
            ))}
          </div>
          {form.route && (
            <div className="alert-banner alert-banner-warning mt-16" style={{ fontSize: '0.8125rem' }}>
              <AlertTriangle size={14} />
              {selectedRoute?.origin === 'Bohol'
                ? 'Sender must be from Bohol. Receiver must be from Metro Manila, Cavite, Batangas, Laguna, or Bulacan.'
                : 'Sender must be from Metro Manila, Cavite, Batangas, Laguna, or Bulacan. Receiver must be from Bohol.'}
            </div>
          )}
          {form.route && filteredTrips.length > 0 && (
            <div className="mt-16">
              <label className="form-label" htmlFor="booking-trip">Select Trip (Optional)</label>
              <CustomSelect id="booking-trip" className="form-select booking-trip-select" value={form.trip_id} onChange={e => u('trip_id', e.target.value)}>
                <option value="">No specific trip</option>
                {filteredTrips.map(t => <option key={t.id} value={t.id}>{formatBookingTripOption(t)}</option>)}
              </CustomSelect>
              {selectedTrip && (
                <div className="booking-trip-preview">
                  <div>
                    <span>Selected trip</span>
                    <strong>{selectedTrip.trip_number}</strong>
                  </div>
                  <div>
                    <span>Departure</span>
                    <strong>{formatBookingTripDate(selectedTrip.departure_date)}</strong>
                  </div>
                  <div>
                    <span>Rate</span>
                    <strong>{formatMoney(parseFloat(selectedTrip.price_per_kg || pricePerKilo))}/kg</strong>
                  </div>
                  {selectedTripRemainingCapacity !== null && (
                    <div>
                      <span>Available</span>
                      <strong>{formatKg(selectedTripRemainingCapacity)}</strong>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <button type="button" className="btn btn-primary btn-lg w-full mt-lg justify-center" disabled={!form.route} onClick={() => setStep(2)}>Continue</button>
        </div></div>
      )}

      {/* Step 2: Sender */}
      {step === 2 && (
        <div className="card animate-fade-in"><div className="card-body">
          <h3 className="fw-700 mb-16 flex items-center gap-8"><User size={18} aria-hidden="true" />Sender Details</h3>
          {showSenderCheckbox && (
            <div className="mb-20 p-12 flex items-center gap-10 rounded-sm" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
              <input type="checkbox" id="useRegSender" checked={useRegisteredSender} onChange={e => handleUseRegisteredSenderChange(e.target.checked)} className="w-18" style={{ height: 18 }} />
              <label htmlFor="useRegSender" className="text-sm fw-600 cursor-pointer" style={{ color: 'var(--text)' }}>Use my registered address for sender details</label>
            </div>
          )}
          {renderAddressFields('sender')}
          <button type="button" className="btn btn-primary btn-lg w-full mt-20 justify-center" onClick={() => {
            const errs = validateSender();
            if (Object.keys(errs).length) { setFieldErrors(errs); toast.error('Please fill in all required sender fields.'); focusFirstInvalid(); return; }
            setFieldErrors({});
            setStep(3);
          }}>Continue</button>
        </div></div>
      )}

      {/* Step 3: Receiver */}
      {step === 3 && (
        <div className="card animate-fade-in"><div className="card-body">
          <h3 className="fw-700 mb-16 flex items-center gap-8"><User size={18} aria-hidden="true" />Receiver Details</h3>
          {showReceiverCheckbox && (
            <div className="mb-20 p-12 flex items-center gap-10 rounded-sm" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
              <input type="checkbox" id="useRegReceiver" checked={useRegisteredReceiver} onChange={e => handleUseRegisteredReceiverChange(e.target.checked)} className="w-18" style={{ height: 18 }} />
              <label htmlFor="useRegReceiver" className="text-sm fw-600 cursor-pointer" style={{ color: 'var(--text)' }}>Use my registered address for receiver details</label>
            </div>
          )}
          {renderAddressFields('receiver')}
          <button type="button" className="btn btn-primary btn-lg w-full mt-20 justify-center" onClick={() => {
            const errs = validateReceiver();
            if (Object.keys(errs).length) { setFieldErrors(errs); toast.error('Please fill in all required receiver fields.'); focusFirstInvalid(); return; }
            const v = validateRouteProvinces(form.sender_province, form.receiver_province, selectedRoute);
            if (!v.valid) { toast.error(v.error); return; }
            setFieldErrors({});
            setStep(4);
          }}>Continue</button>
        </div></div>
      )}

      {/* Step 4: Package */}
      {step === 4 && (
        <div className="card animate-fade-in"><div className="card-body">
          <h3 className="fw-700 mb-16 flex items-center gap-8"><Package size={18} aria-hidden="true" />Package Details</h3>
          <div className="form-group">
            <label className="form-label" htmlFor="package-description">What are you sending? <span className="text-danger">*</span></label>
            <input id="package-description" className={`form-input ${fieldErrors.package_description ? 'field-invalid' : ''}`} value={form.package_description} onChange={e => { u('package_description', e.target.value); setFieldErrors(prev => ({...prev, package_description: false})); }} placeholder="e.g. Documents, 2 boxes of clothes, small appliance" aria-invalid={fieldErrors.package_description ? 'true' : undefined} aria-describedby={fieldErrors.package_description ? 'package-description-error package-description-helper' : 'package-description-helper'} />
            {fieldErrors.package_description && <div className="field-error-inline" id="package-description-error" role="alert"><AlertTriangle size={12} aria-hidden="true" />Package description is required.</div>}
            <p id="package-description-helper" className="text-xs text-secondary mt-4">Describe your items. We weigh the parcel at pickup and the exact cost is confirmed then.</p>
          </div>
          <div className="form-group"><label className="form-label" htmlFor="payer-type">Who Pays?</label>
            <CustomSelect id="payer-type" className="form-select" value={form.payer_type} onChange={e => u('payer_type', e.target.value)}>
              <option value="sender">Sender</option><option value="receiver">Receiver</option>
            </CustomSelect>
          </div>
          <div className="form-group"><label className="form-label" htmlFor="payment-preference">Payment Preference (Optional)</label>
            <CustomSelect id="payment-preference" className="form-select" value={form.payment_preference} onChange={e => u('payment_preference', e.target.value)}>
              <option value="unspecified">I'll decide later</option>
              <option value="cash">Cash</option>
              <option value="gcash">GCash</option>
            </CustomSelect>
            <p className="text-xs text-secondary mt-4">Letting us know how you plan to pay helps our team prepare for pickup or delivery.</p>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="package-notes">Special Instructions / Notes (Optional)</label>
            <textarea
              id="package-notes"
              className="form-input"
              value={form.notes}
              onChange={e => u('notes', e.target.value)}
              placeholder="e.g. Fragile item, deliver after 5 PM, etc."
              rows={3}
              style={{ resize: 'vertical' }}
            />
          </div>
          <div className="booking-cost-card mb-16 text-center">
            <div className="text-sm text-secondary">Shipping Rate</div>
            <div className="text-2xl fw-800 text-primary">₱{effectivePricePerKilo}/kg</div>
            <div className="text-xs text-tertiary">Your total is calculated when we weigh your parcel at pickup.</div>
          </div>

          <button type="button" className="btn btn-primary btn-lg w-full justify-center" onClick={() => {
            if (!form.package_description || !form.package_description.trim()) {
              setFieldErrors({ package_description: true });
              toast.error('Please describe what you are sending.');
              focusFirstInvalid();
              return;
            }
            setFieldErrors({});
            setStep(5);
          }}>Review Booking</button>
        </div></div>
      )}

      {/* Step 5: Review */}
      {step === 5 && (
        <div className="card animate-fade-in"><div className="card-body">
          <h3 className="fw-700 mb-16">Review & Confirm</h3>
          <div className="booking-summary-card mb-16">
            <div className="booking-summary-label">Route</div>
            <div className="booking-summary-value">{form.route}</div>
          </div>
          <div className="grid grid-2 gap-12 mb-16">
            <div className="booking-summary-card">
              <div className="booking-summary-label">Sender</div>
              <div className="text-sm font-bold">{form.sender_name}</div>
              <div className="text-xs text-secondary">{form.sender_phone}</div>
              <div className="text-xs text-secondary mt-4">{form.sender_street}, {form.sender_barangay}, {form.sender_city}, {form.sender_province}</div>
            </div>
            <div className="booking-summary-card">
              <div className="booking-summary-label">Receiver</div>
              <div className="text-sm font-bold">{form.receiver_name}</div>
              <div className="text-xs text-secondary">{form.receiver_phone}</div>
              <div className="text-xs text-secondary mt-4">{form.receiver_street}, {form.receiver_barangay}, {form.receiver_city}, {form.receiver_province}</div>
            </div>
          </div>
          <div className="booking-cost-card text-center mb-16">
            <div className="text-sm text-secondary">Shipping Rate</div>
            <div className="fw-800 text-primary" style={{ fontSize: '2rem' }}>₱{effectivePricePerKilo}/kg</div>
            <div className="text-xs text-tertiary mt-4">Weighed at pickup — you pay for the actual weight, nothing estimated.</div>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-lg w-full justify-center"
            onClick={handleSubmit}
            disabled={loading}
            aria-busy={loading}
          >
            {loading
              ? <><Loader size={18} className="animate-spin" aria-hidden="true" /> Submitting booking…</>
              : 'Confirm Booking'}
          </button>
        </div></div>
      )}

      </> /* end initialLoading ternary */}
    </div>
  );
};

export default BookShipmentPage;
