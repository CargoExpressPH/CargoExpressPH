import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { clearCustomerPageCache } from '../../lib/customerPageCache';
import { Link, useNavigate, useLocation, useBlocker } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { createOrder, getTrips, getSettings, getRecentContacts } from '../../lib/database';
import { logOrder } from '../../lib/activityLog';
import { buildFullAddress } from '../../lib/address';
import { ROUTES, PH_LOCATIONS, VALID_PROVINCES, detectPickupLocation, validateRouteProvinces } from '../../constants/phLocations';
import { isTripBookable } from '../../constants/status';
import { ArrowLeft, ArrowRight, Loader, CheckCircle, Copy, Check, Package, MapPin, User, Truck, AlertTriangle, Info, Clock, Headset } from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import CustomSelect from '../../components/ui/CustomSelect';
import BarangaySelect from '../../components/ui/BarangaySelect';
import ConfirmModal from '../../components/ui/ConfirmModal';
import BrandLockup from '../../components/ui/BrandLogo';
import ResultIcon from '../../components/ui/ResultIcon';
import { useReducedMotion } from 'framer-motion';
import usePageTitle from '../../hooks/usePageTitle';
import { formatMoney } from '../../utils/currencyInput';
import { toTitleCase, toAddressCase, normalizeName, splitFullName } from '../../utils/string';
import { formatPhDate } from '../../utils/datetime';
import { validatePhone } from '../../utils/phone';
import { validateName, validateAddressLine, validateFacebookName } from '../../utils/validation';
import {
  clearBookingDraftStorage,
  changeBookingRoute,
  hasMeaningfulBookingData,
  persistBookingDraft,
  readBookingDraft,
} from '../../lib/bookingDraft';
import { orderPartyName, orderPartyAddress } from '../../lib/orderParties';
import { describeBookingSaveError } from '../../utils/bookingSaveError';

function fallbackCopy(text) {
  const el = document.createElement('textarea');
  el.value = text;
  el.setAttribute('readonly', '');
  el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;padding:0;border:none;outline:none;box-shadow:none;background:transparent;opacity:0';
  document.body.appendChild(el);
  el.focus();
  el.select();
  el.setSelectionRange(0, text.length);
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { /* Clipboard may be blocked. */ }
  el.remove();
  return copied;
}

async function copyTrackingNumber(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* Try the legacy copy API when clipboard permission is denied. */ }
  return fallbackCopy(text);
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

const emptyBookingForm = ({ route = '', tripId = '' } = {}) => ({
  route, trip_id: tripId,
  sender_first_name: '', sender_last_name: '', sender_phone: '', sender_facebook: '',
  sender_lot_block: '', sender_street: '', sender_barangay: '',
  sender_city: '', sender_province: '', sender_landmark: '',
  receiver_first_name: '', receiver_last_name: '', receiver_phone: '', receiver_facebook: '',
  receiver_lot_block: '', receiver_street: '', receiver_barangay: '',
  receiver_city: '', receiver_province: '', receiver_landmark: '',
  package_description: '', payer_type: 'sender',
  payment_preference: 'unspecified', notes: '', sender_other_province: '',
});

const bookingScrollTarget = () => {
  const main = document.querySelector('.customer-main--booking');
  return main && getComputedStyle(main).overflowY === 'auto' ? main : window;
};

const BookShipmentPage = () => {
  usePageTitle('Book Shipment');
  const [progressDock, setProgressDock] = useState(null);
  useLayoutEffect(() => {
    setProgressDock(document.querySelector('.booking-progress-dock'));
  }, []);
  useLayoutEffect(() => {
    const root = document.documentElement;
    let blurFrame = 0;
    const updateFocusedField = () => {
      blurFrame = 0;
      const field = document.activeElement;
      const focused = Boolean(
        field?.closest?.('.booking-page') && (
          field.tagName === 'TEXTAREA' ||
          (field.tagName === 'INPUT' && ['text', 'search', 'password', 'email', 'tel', 'number', 'url', 'date', 'time', 'datetime-local'].includes(field.type))
        )
      );
      const wasFocused = root.classList.contains('booking-field-focused');
      if (focused === wasFocused) return;
      const scroller = document.querySelector('.customer-main--booking');
      const useInnerScroll = window.matchMedia('(max-width: 899.98px)').matches && scroller;
      // The focused form uses an inner scroller so Safari cannot pan its
      // header away. Carry the same scroll offset between the two surfaces.
      const previousScroll = useInnerScroll ? (focused ? window.scrollY : scroller.scrollTop) : 0;
      root.classList.toggle('booking-field-focused', focused);
      if (useInnerScroll) {
        if (focused) scroller.scrollTop = previousScroll;
        else window.scrollTo(0, previousScroll);
      }
    };
    const onFocusOut = () => {
      if (blurFrame) cancelAnimationFrame(blurFrame);
      blurFrame = requestAnimationFrame(updateFocusedField);
    };
    root.classList.add('booking-route-active');
    document.addEventListener('focusin', updateFocusedField);
    document.addEventListener('focusout', onFocusOut);
    updateFocusedField();
    return () => {
      document.removeEventListener('focusin', updateFocusedField);
      document.removeEventListener('focusout', onFocusOut);
      if (blurFrame) cancelAnimationFrame(blurFrame);
      root.classList.remove('booking-route-active', 'booking-field-focused');
    };
  }, []);
  const { user, userProfile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const preRoute  = location.state?.preselectedRoute  || '';
  const preTripId = location.state?.preselectedTripId || '';

  // Start clean. The account-scoped restore effect below runs only after an
  // authenticated user id exists, so no personal draft is read during auth boot.
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [success, setSuccess] = useState(null);
  // Set only when saving the booking itself failed (not for a validation
  // stop); shown at the top of Review so the customer knows what to do next.
  const [submitError, setSubmitError] = useState(null);
  useEffect(() => { if (step !== 5) setSubmitError(null); }, [step]);
  const [trips, setTrips] = useState([]);
  const [pricePerKilo, setPricePerKilo] = useState(70);

  const [form, setForm] = useState(() => emptyBookingForm({ route: preRoute, tripId: preTripId }));
  const [draftReadyUserId, setDraftReadyUserId] = useState(null);
  const activeDraftUserRef = useRef(null);
  const autosaveTimerRef = useRef(null);
  const initialPreselectionRef = useRef({ route: preRoute, tripId: preTripId });

  // Guards against a double POST; see handleSubmit.
  const submittingRef = useRef(false);

  const [useRegisteredSender, setUseRegisteredSender] = useState(false);
  const [useRegisteredReceiver, setUseRegisteredReceiver] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});

  // Recent Addresses / Address Book — independent of the "use registered
  // address" checkboxes above; see handleSelectRecentContact.
  const [recentContacts, setRecentContacts] = useState({ senders: [], receivers: [] });
  const [openContactDropdown, setOpenContactDropdown] = useState(null); // 'sender' | 'receiver' | null
  const contactWrapRefs = useRef({});
  // Set when a step change should leave the scroll to a field focus instead.
  const skipStepScrollRef = useRef(false);

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

  // Home can open this screen with a suggested route/trip. Consume that state
  // once: leaving and returning through browser history must start a fresh form,
  // not recreate an already-abandoned suggestion from the history entry.
  useEffect(() => {
    if (!preRoute && !preTripId) return;
    const nextLocationState = { ...(location.state || {}) };
    delete nextLocationState.preselectedRoute;
    delete nextLocationState.preselectedTripId;
    navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      {
        replace: true,
        state: Object.keys(nextLocationState).length > 0 ? nextLocationState : null,
      },
    );
  }, [location.hash, location.pathname, location.search, location.state, navigate, preRoute, preTripId]);

  // A mounted route can observe account switching through Supabase auth. Reset
  // first, then restore only the new account's namespaced draft.
  useEffect(() => {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    activeDraftUserRef.current = null;
    setDraftReadyUserId(null);
    setSuccess(null);
    setStep(1);
    const preselection = initialPreselectionRef.current;
    setForm(emptyBookingForm(preselection));

    const userId = user?.id;
    if (!userId) return;
    const draft = readBookingDraft(userId);
    if (draft) {
      setForm({
        ...emptyBookingForm(preselection),
        ...draft.form,
        ...(preselection.route ? { route: preselection.route } : {}),
        ...(preselection.tripId ? { trip_id: preselection.tripId } : {}),
      });
      setStep(draft.step);
    }
    // Route state is a one-time suggestion. Do not carry it to another account
    // if auth changes while this page remains mounted.
    initialPreselectionRef.current = { route: '', tripId: '' };
    activeDraftUserRef.current = userId;
    setDraftReadyUserId(userId);

    return () => {
      activeDraftUserRef.current = null;
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [user?.id]);

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

  // Recent Addresses: best-effort, never blocks the booking flow — a failed
  // fetch just means the dropdown has nothing to show.
  //
  // Pulled out as its own function (not just inline in the mount effect)
  // because this page never unmounts between bookings — "Book Another"
  // resets `form`/`step` in place, it doesn't remount the component — so a
  // mount-only fetch would keep showing the pre-edit version of a contact
  // the user just tweaked and submitted. Call this again wherever the
  // history could have just changed: right after a successful submit, and
  // again when "Book Another" is clicked.
  const refreshRecentContacts = useCallback(() => {
    if (!user?.id) return;
    getRecentContacts(user.id).then(setRecentContacts).catch(() => {});
  }, [user?.id]);

  useEffect(() => {
    refreshRecentContacts();
  }, [refreshRecentContacts]);

  // Close the open Recent Addresses dropdown on an outside click/tap or Escape.
  // Mirrors the capture-phase mousedown+touchstart pattern InfoTooltip.jsx uses.
  useEffect(() => {
    if (!openContactDropdown) return undefined;
    const handleOutsideClick = (e) => {
      const wrap = contactWrapRefs.current[openContactDropdown];
      if (wrap && !wrap.contains(e.target)) setOpenContactDropdown(null);
    };
    const handleEscape = (e) => {
      if (e.key === 'Escape') setOpenContactDropdown(null);
    };
    document.addEventListener('mousedown', handleOutsideClick, true);
    document.addEventListener('touchstart', handleOutsideClick, true);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick, true);
      document.removeEventListener('touchstart', handleOutsideClick, true);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [openContactDropdown]);

  // A route/trip-only selection is deliberately ephemeral: navigating away or
  // refreshing returns to a clean Step 1. Once real booking details exist, save
  // the form and current step together so a genuine draft can be recovered.
  useEffect(() => {
    const userId = user?.id;
    if (!userId || draftReadyUserId !== userId) return undefined;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    if (success) return undefined;
    autosaveTimerRef.current = setTimeout(() => {
      // A stale timeout from account A must never write after logout/switch.
      if (activeDraftUserRef.current === userId) {
        persistBookingDraft(userId, form, step);
      }
    }, 150);
    return () => clearTimeout(autosaveTimerRef.current);
  }, [draftReadyUserId, form, step, success, user?.id]);

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
  const shippingRateLabel = selectedTrip ? 'Shipping Rate' : 'Estimated Shipping Rate';
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
    if (label === form.route) return;
    const route = ROUTES.find(r => r.label === label);
    if (route) {
      setForm(prev => changeBookingRoute(prev, label, route));
      setFieldErrors({});
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
      // profiles.name is still a single combined field (out of scope for this
      // task) — split it the same way the DB backfill does so a registered
      // account name and a Recent Contact split identically either way.
      const { firstName, lastName } = splitFullName(userProfile.name);
      setForm(p => ({
        ...p,
        sender_first_name: firstName, sender_last_name: lastName, sender_phone: userProfile.phone || '', sender_facebook: userProfile.facebook_name || '',
        sender_lot_block: userProfile.address_lot_block || '', sender_street: userProfile.address_street || '',
        sender_barangay: userProfile.address_barangay || '', sender_city: userProfile.address_city || '',
        sender_province: userProfile.address_province || '', sender_other_province: '', sender_landmark: userProfile.address_landmark || '',
      }));
    } else {
      setForm(p => ({
        ...p,
        sender_first_name: '', sender_last_name: '', sender_phone: '', sender_facebook: '',
        sender_lot_block: '', sender_street: '', sender_barangay: '',
        sender_city: '', sender_province: '', sender_other_province: '', sender_landmark: '',
      }));
    }
  };

  const handleUseRegisteredReceiverChange = (checked) => {
    setUseRegisteredReceiver(checked);
    // Same as sender: registered-address autofill must clear leftover validation UI.
    clearPrefixFieldErrors('receiver');
    if (checked && userProfile) {
      const { firstName, lastName } = splitFullName(userProfile.name);
      setForm(p => ({
        ...p,
        receiver_first_name: firstName, receiver_last_name: lastName, receiver_phone: userProfile.phone || '', receiver_facebook: userProfile.facebook_name || '',
        receiver_lot_block: userProfile.address_lot_block || '', receiver_street: userProfile.address_street || '',
        receiver_barangay: userProfile.address_barangay || '', receiver_city: userProfile.address_city || '',
        receiver_province: userProfile.address_province || '', receiver_landmark: userProfile.address_landmark || '',
      }));
    } else {
      setForm(p => ({
        ...p,
        receiver_first_name: '', receiver_last_name: '', receiver_phone: '', receiver_facebook: '',
        receiver_lot_block: '', receiver_street: '', receiver_barangay: '',
        receiver_city: '', receiver_province: '', receiver_landmark: '',
      }));
    }
  };

  // Fills a Sender/Receiver step from a past order's contact — independent of
  // the "use registered address" checkboxes (handleUseRegisteredSenderChange/
  // handleUseRegisteredReceiverChange above), which this never calls into. It
  // only mirrors their courtesy of clearing stale field errors, and unchecks
  // that side's checkbox state if it happened to be on, same as typing into
  // any of these fields already does via `u()`.
  const handleSelectRecentContact = (prefix, contact) => {
    const otherSenderProvince = prefix === 'sender' && selectedRoute?.destination === 'Bohol'
      && contact.province !== 'Bohol' && !PH_LOCATIONS[contact.province];
    setForm(p => ({
      ...p,
      [`${prefix}_first_name`]: contact.first_name,
      [`${prefix}_last_name`]: contact.last_name,
      [`${prefix}_phone`]: contact.phone,
      [`${prefix}_facebook`]: contact.facebook,
      [`${prefix}_province`]: otherSenderProvince ? 'Other Area' : contact.province,
      ...(prefix === 'sender' ? { sender_other_province: otherSenderProvince ? contact.province : '' } : {}),
      [`${prefix}_city`]: contact.city,
      [`${prefix}_barangay`]: contact.barangay,
      [`${prefix}_street`]: contact.street,
      [`${prefix}_lot_block`]: contact.lot_block,
      [`${prefix}_landmark`]: contact.landmark,
    }));
    clearPrefixFieldErrors(prefix);
    if (prefix === 'sender') setUseRegisteredSender(false);
    else setUseRegisteredReceiver(false);
    setOpenContactDropdown(null);
  };

  const validateSender = () => {
    const errs = {};
    const firstNameErr = validateName(form.sender_first_name);
    if (firstNameErr) errs.sender_first_name = firstNameErr;
    const lastNameErr = validateName(form.sender_last_name);
    if (lastNameErr) errs.sender_last_name = lastNameErr;

    const fbErr = validateFacebookName(form.sender_facebook);
    if (fbErr) errs.sender_facebook = fbErr;
    
    if (!form.sender_province) errs.sender_province = 'Province is required.';
    else if (!getSenderProvinces().includes(form.sender_province)) {
      errs.sender_province = 'Select a pickup province supported by this route.';
    } else if (form.sender_province === 'Other Area' && selectedRoute?.destination !== 'Bohol') {
      errs.sender_province = 'Out-of-coverage pickup is only available when delivering to Bohol. Please select a listed province.';
    }
    if (form.sender_province === 'Other Area' && !form.sender_other_province?.trim()) errs.sender_other_province = 'Exact province is required.';
    if (!form.sender_city?.trim()) errs.sender_city = 'City is required.';
    if (!form.sender_barangay?.trim()) errs.sender_barangay = 'Barangay is required.';
    
    const streetErr = validateAddressLine(form.sender_street);
    if (streetErr) errs.sender_street = streetErr;
    
    const lotErr = validateAddressLine(form.sender_lot_block);
    if (lotErr) errs.sender_lot_block = lotErr;
    
    const landmarkErr = validateAddressLine(form.sender_landmark);
    if (landmarkErr) errs.sender_landmark = landmarkErr;
    
    const phoneErr = validatePhone(form.sender_phone);
    if (phoneErr) errs.sender_phone = phoneErr;
    
    return errs;
  };

  const validateReceiver = () => {
    const errs = {};
    const firstNameErr = validateName(form.receiver_first_name);
    if (firstNameErr) errs.receiver_first_name = firstNameErr;
    const lastNameErr = validateName(form.receiver_last_name);
    if (lastNameErr) errs.receiver_last_name = lastNameErr;

    const fbErr = validateFacebookName(form.receiver_facebook);
    if (fbErr) errs.receiver_facebook = fbErr;
    
    if (!form.receiver_province) errs.receiver_province = 'Province is required.';
    else if (!getReceiverProvinces().includes(form.receiver_province)) {
      errs.receiver_province = 'Select a delivery province supported by this route.';
    }
    if (!form.receiver_city?.trim()) errs.receiver_city = 'City is required.';
    if (!form.receiver_barangay?.trim()) errs.receiver_barangay = 'Barangay is required.';
    
    const streetErr = validateAddressLine(form.receiver_street);
    if (streetErr) errs.receiver_street = streetErr;
    
    const lotErr = validateAddressLine(form.receiver_lot_block);
    if (lotErr) errs.receiver_lot_block = lotErr;
    
    const landmarkErr = validateAddressLine(form.receiver_landmark);
    if (landmarkErr) errs.receiver_landmark = landmarkErr;
    
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
      if (el && typeof el.focus === 'function') {
        el.focus({ preventScroll: true });
        // An explicit error should sit below the progress bar even when the
        // keyboard has not opened yet. Avoid the page-wide smooth scroll here.
        const progressSelector = document.documentElement.classList.contains('booking-field-focused')
          ? '.booking-progress-dock .step-progress'
          : '.booking-page > .step-progress';
        const progressBottom = document.querySelector(progressSelector)?.getBoundingClientRect().bottom || 0;
        const rect = el.getBoundingClientRect();
        const scrollTarget = bookingScrollTarget();
        const viewport = window.visualViewport;
        const visibleBottom = scrollTarget === window
          ? (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight)
          : scrollTarget.getBoundingClientRect().bottom;
        if (rect.top < progressBottom + 12) {
          scrollTarget.scrollBy({ top: Math.floor(rect.top - progressBottom - 12), behavior: 'instant' });
        } else if (rect.bottom > visibleBottom - 16) {
          scrollTarget.scrollBy({ top: Math.ceil(rect.bottom - visibleBottom + 16), behavior: 'instant' });
        }
      }
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
    setSubmitError(null);
    // True once the booking is actually sent, so the catch below can tell a
    // failed save apart from a validation stop.
    let sendingBooking = false;
    // When validation sends the user back to a step, we focus the offending
    // field — and focusing already scrolls it into view. The catch block's
    // scroll-to-top would fight that, yanking the page away from the field the
    // user was just sent to fix, so it is skipped on that path only.
    let focusingInvalidField = false;
    try {
      if (!selectedRoute) { setStep(1); throw new Error('Please select a route.'); }
      if (form.trip_id && !selectedTrip) {
        setForm(prev => ({ ...prev, trip_id: '' }));
        setStep(1);
        throw new Error('Selected trip is no longer available. Please choose another trip or book without selecting one.');
      }
      // C-2 fix: Navigate to the step containing the error before throwing
      const sErrs = validateSender(); if (Object.keys(sErrs).length) { setFieldErrors(sErrs); skipStepScrollRef.current = true; setStep(2); focusingInvalidField = true; focusFirstInvalid(); throw new Error('Please fix sender details.'); }
      const rErrs = validateReceiver(); if (Object.keys(rErrs).length) { setFieldErrors(rErrs); skipStepScrollRef.current = true; setStep(3); focusingInvalidField = true; focusFirstInvalid(); throw new Error('Please fix receiver details.'); }
      const validation = validateRouteProvinces(form.sender_province, form.receiver_province, selectedRoute);
      if (!validation.valid) throw new Error(validation.error);

      if (!form.package_description?.trim()) {
        setFieldErrors({ package_description: true });
        skipStepScrollRef.current = true;
        setStep(4);
        focusingInvalidField = true;
        focusFirstInvalid();
        throw new Error('Please describe what you are sending.');
      }
      
      if (form.sender_province === 'Other Area' && selectedRoute.destination !== 'Bohol') {
        throw new Error('CargoExpress PH currently delivers to Bohol destinations only.');
      }
      

      const payload = {
        user_id: user.id,
        origin: selectedRoute.origin, destination: selectedRoute.destination, trip_id: form.trip_id || null,
        sender_first_name: normalizeName(form.sender_first_name), sender_last_name: normalizeName(form.sender_last_name), sender_phone: form.sender_phone,
        sender_facebook: normalizeName(form.sender_facebook), sender_city: form.sender_city, sender_province: form.sender_province === 'Other Area' ? form.sender_other_province : form.sender_province,
        sender_barangay: form.sender_barangay, sender_street: form.sender_street, sender_lot_block: form.sender_lot_block, sender_landmark: form.sender_landmark,
        receiver_first_name: normalizeName(form.receiver_first_name), receiver_last_name: normalizeName(form.receiver_last_name), receiver_phone: form.receiver_phone,
        receiver_facebook: normalizeName(form.receiver_facebook), receiver_city: form.receiver_city, receiver_province: form.receiver_province,
        receiver_barangay: form.receiver_barangay, receiver_street: form.receiver_street, receiver_lot_block: form.receiver_lot_block, receiver_landmark: form.receiver_landmark,
        package_description: form.package_description,
        payer_type: form.payer_type, payment_preference: form.payment_preference, notes: form.notes,
      };
      
      if (form.sender_province === 'Other Area') {
        payload.service_area_status = 'for_review';
        payload.status = 'Pending Review';
      }
      
      sendingBooking = true;
      const data = await createOrder(payload);
      clearCustomerPageCache();
      
      // The order insert is the point of success. Activity logging is queued
      // separately; its failure must never present a saved order as failed and
      // invite a second Confirm click that creates a duplicate booking.
      void (payload.service_area_status === 'for_review'
        ? logOrder('Out-of-Coverage Booking Submitted', data.id, data.tracking_number, { details: `Special pickup request submitted for ${orderPartyAddress(data, 'sender')}` })
        : logOrder('Booking Created', data.id, data.tracking_number, { details: 'Standard booking created via Customer Portal.' })
      ).catch(() => {});

      setSuccess(data);
      // Not clearing `loading` here: `success` now takes over rendering via
      // the early-return below, and this page never reads `loading` again —
      // clearing it would risk a frame of the un-loading form before that
      // switch.
      clearBookingDraftStorage(user.id);
      // This booking (possibly with a just-edited sender/receiver contact) is
      // now in `orders` — refresh Recent Addresses so a subsequent "Book
      // Another" dropdown reflects it instead of the stale pre-edit version.
      refreshRecentContacts();
    } catch (err) {
      // A failed save gets the notice at the top of Review instead of a toast:
      // the toast repeated it with raw text such as "HTTP Error 500".
      if (sendingBooking) setSubmitError(describeBookingSaveError(err));
      else toast.error(err.message || 'An unexpected error occurred while saving the booking.');
      if (!focusingInvalidField) bookingScrollTarget().scrollTo({ top: 0, behavior: 'smooth' });
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
    // Route-scoped: a sender/receiver from history is only worth surfacing if
    // it's on the correct side of the currently selected route (matches the
    // sender/receiver Bohol-vs-Manila origin/destination split enforced
    // elsewhere for this route, e.g. getSenderProvinces/getReceiverProvinces).
    const routeSide = isSender ? selectedRoute?.origin : selectedRoute?.destination;
    const allContacts = recentContacts[`${prefix}s`] || [];
    const contacts = routeSide
      ? allContacts.filter(c => (routeSide === 'Bohol'
        ? c.province === 'Bohol'
        : c.province && (isSender || ['Metro Manila', 'Cavite', 'Batangas', 'Laguna', 'Bulacan'].includes(c.province)) && c.province !== 'Bohol'))
      : allContacts;
    const dropdownOpen = openContactDropdown === prefix;
    return (
      <div className="grid grid-2 gap-16">
        <div className="form-group col-full" ref={el => { contactWrapRefs.current[prefix] = el; }}>
          <div className="flex items-center justify-between">
            <span className="form-label mb-0">Full Name <span className="required">*</span></span>
            {contacts.length > 0 && (
              <button
                type="button"
                className="recent-contacts-trigger"
                aria-haspopup="listbox"
                aria-expanded={dropdownOpen}
                onClick={() => setOpenContactDropdown(prev => (prev === prefix ? null : prefix))}
              >
                <Clock size={12} aria-hidden="true" /> Recent Contacts
              </button>
            )}
          </div>
          <div className="recent-contacts-wrap">
            <div className="grid grid-2 gap-12 mt-4">
              <div>
                <label className="form-label sr-only" htmlFor={id('first_name')}>First Name</label>
                <input
                  id={id('first_name')}
                  className={`form-input ${fc('first_name')}`}
                  value={form[`${prefix}_first_name`]}
                  onChange={handleTextChange(`${prefix}_first_name`)}
                  placeholder="First Name"
                  autoComplete={isSender ? 'given-name' : 'shipping given-name'}
                  autoCapitalize="words"
                  required
                  {...a11y('first_name')}
                />
                {errEl('first_name')}
              </div>
              <div>
                <label className="form-label sr-only" htmlFor={id('last_name')}>Last Name</label>
                <input
                  id={id('last_name')}
                  className={`form-input ${fc('last_name')}`}
                  value={form[`${prefix}_last_name`]}
                  onChange={handleTextChange(`${prefix}_last_name`)}
                  placeholder="Last Name"
                  autoComplete={isSender ? 'family-name' : 'shipping family-name'}
                  autoCapitalize="words"
                  required
                  {...a11y('last_name')}
                />
                {errEl('last_name')}
              </div>
            </div>
            {dropdownOpen && contacts.length > 0 && (
              <div className="custom-select-menu recent-contacts-menu" role="listbox" aria-label={`Recent ${prefix} contacts`}>
                {contacts.map((contact, i) => (
                  <button
                    type="button"
                    key={`${contact.first_name}-${contact.last_name}-${contact.phone}-${i}`}
                    role="option"
                    aria-selected="false"
                    className="custom-select-option recent-contact-option"
                    onClick={() => handleSelectRecentContact(prefix, contact)}
                  >
                    <span className="recent-contact-address">
                      {buildFullAddress({ lotBlock: contact.lot_block, street: contact.street, barangay: contact.barangay, city: contact.city, province: contact.province, landmark: contact.landmark })}
                    </span>
                    <span className="recent-contact-meta">{contact.first_name} {contact.last_name} | {contact.phone}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="form-group"><label className="form-label" htmlFor={id('phone')}>Mobile Number <span className="required">*</span></label><input id={id('phone')} className={`form-input ${fc('phone')}`} value={form[`${prefix}_phone`]} onChange={handlePhoneChange(`${prefix}_phone`)} inputMode="numeric" maxLength={11} placeholder="09xxxxxxxxx" autoComplete="tel" required {...a11y('phone')} />{errEl('phone')}</div>
        <div className="form-group"><label className="form-label" htmlFor={id('facebook')}>Facebook Name <span className="required">*</span></label><input id={id('facebook')} className={`form-input ${fc('facebook')}`} value={form[`${prefix}_facebook`]} onChange={handleTextChange(`${prefix}_facebook`)} placeholder="Your name on Facebook" autoCapitalize="words" required {...a11y('facebook')} />{errEl('facebook')}</div>
        {/* Contact fields above, the address below: a visible break in a long form. */}
        <p className="col-full booking-field-group">{prefix === 'sender' ? 'Pickup address' : 'Delivery address'}</p>
        <div className="form-group"><label className="form-label" htmlFor={id('province')}>Province <span className="required">*</span></label>
          <CustomSelect searchable id={id('province')} className={`form-select ${fc('province')}`} value={form[`${prefix}_province`]} onChange={e => { u(`${prefix}_province`, e.target.value); if (isSender && e.target.value !== 'Other Area') u('sender_other_province', ''); u(`${prefix}_city`, ''); u(`${prefix}_barangay`, ''); }} {...a11y('province')}>
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
            <CustomSelect searchable id={id('city')} className={`form-select ${fc('city')}`} value={form[`${prefix}_city`]} onChange={e => { u(`${prefix}_city`, e.target.value); u(`${prefix}_barangay`, ''); }} disabled={!form[`${prefix}_province`]} {...a11y('city')}>
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
        <div className="form-group"><label className="form-label" htmlFor={id('street')}>Street and Subdivision (put NA if not applicable) <span className="required">*</span></label><input id={id('street')} className={`form-input ${fc('street')}`} value={form[`${prefix}_street`]} onChange={handleAddressChange(`${prefix}_street`)} placeholder="e.g. Mabini St., Villa Verde Subd." autoComplete="address-line1" autoCapitalize="words" required {...a11y('street')} />{errEl('street')}</div>
        <div className="form-group"><label className="form-label" htmlFor={id('lot-block')}>Lot / Block / Purok <span className="required">*</span></label><input id={id('lot-block')} className={`form-input ${fc('lot_block')}`} value={form[`${prefix}_lot_block`]} onChange={handleAddressChange(`${prefix}_lot_block`)} placeholder="e.g. Blk 4 Lot 12, or Purok 3" autoComplete="address-line2" autoCapitalize="words" required {...a11y('lot_block')} />{errEl('lot_block')}</div>
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
  const [successActionsPinned, setSuccessActionsPinned] = useState(false);
  const successTitleRef = useRef(null);
  const successEndRef = useRef(null);
  const reduceMotion = useReducedMotion();

  // Each step starts at its own top. Continue sits at the bottom of a long
  // form, so without this the next step opened mid-way down, below its heading
  // and the "use my registered address" shortcut.
  const previousStepRef = useRef(step);
  useEffect(() => {
    if (previousStepRef.current === step) return;
    previousStepRef.current = step;
    setOpenContactDropdown(null);
    if (skipStepScrollRef.current) {
      skipStepScrollRef.current = false;
      return;
    }
    bookingScrollTarget().scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [step, reduceMotion]);

  // On phones the booking route has its own scrollable shell. Keep that shell
  // aligned to the visible viewport when iOS pans it for the keyboard; scrolling
  // the form then cannot carry the header or progress bar away. Older installed
  // Safari reports viewport offsets late, sometimes without another event.
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    const scroller = document.querySelector('.customer-main--booking');
    if (!viewport || !scroller) return undefined;

    let frame = 0;
    let appliedTop = -1;
    let appliedHeight = -1;
    let settleTimers = [];
    const update = () => {
      frame = 0;
      const focusedField = document.activeElement?.closest?.('.booking-page')
        && document.activeElement.matches?.('input, textarea, [contenteditable="true"]');
      const bodyShift = focusedField && window.innerHeight - viewport.height > 100
        ? -document.body.getBoundingClientRect().top - window.scrollY
        : 0;
      const visibleTop = Math.max(
        0,
        viewport.offsetTop || 0,
        (viewport.pageTop || 0) - window.scrollY,
        bodyShift,
      );
      const nextTop = Math.round(visibleTop);
      const nextHeight = Math.round(viewport.height > 100 ? viewport.height : window.innerHeight);
      if (nextTop !== appliedTop) {
        root.style.setProperty('--booking-visible-top', `${nextTop}px`);
        appliedTop = nextTop;
      }
      if (nextHeight !== appliedHeight) {
        root.style.setProperty('--booking-visible-height', `${nextHeight}px`);
        appliedHeight = nextHeight;
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const scheduleAfterSettle = () => {
      schedule();
      settleTimers.forEach(clearTimeout);
      settleTimers = [50, 200, 400].map(delay => setTimeout(schedule, delay));
    };
    const onTouchEnd = () => {
      if (document.activeElement?.closest?.('.booking-page')) scheduleAfterSettle();
    };
    viewport.addEventListener('scroll', schedule);
    viewport.addEventListener('resize', scheduleAfterSettle);
    window.addEventListener('scroll', schedule, { passive: true });
    scroller.addEventListener('scroll', schedule, { passive: true });
    document.addEventListener('focusin', scheduleAfterSettle);
    document.addEventListener('focusout', scheduleAfterSettle);
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    // Measure before first paint so the form follows the keyboard immediately
    // when focus moves to a field on older Safari.
    update();
    scheduleAfterSettle();

    return () => {
      viewport.removeEventListener('scroll', schedule);
      viewport.removeEventListener('resize', scheduleAfterSettle);
      window.removeEventListener('scroll', schedule);
      scroller.removeEventListener('scroll', schedule);
      document.removeEventListener('focusin', scheduleAfterSettle);
      document.removeEventListener('focusout', scheduleAfterSettle);
      document.removeEventListener('touchend', onTouchEnd);
      if (frame) cancelAnimationFrame(frame);
      settleTimers.forEach(clearTimeout);
      root.style.removeProperty('--booking-visible-top');
      root.style.removeProperty('--booking-visible-height');
    };
  }, [success]);

  // The confirmation replaces the form: move focus to its heading so keyboard
  // and screen-reader users start there, and arrow keys scroll the receipt.
  useEffect(() => {
    if (success) successTitleRef.current?.focus({ preventScroll: true });
  }, [success]);

  // On phones the receipt is taller than the screen, so its buttons stay
  // pinned to the bottom edge (result-screens.css). The bar gets its top edge
  // only while more of the receipt is below it: while the marker at the
  // receipt's end is out of view. Without IntersectionObserver the bar still
  // pins, just without the edge.
  useEffect(() => {
    const end = successEndRef.current;
    if (!success || !end || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => setSuccessActionsPinned(!entry.isIntersecting),
      { root: end.closest('.booking-success-page') },
    );
    observer.observe(end);
    return () => {
      observer.disconnect();
      setSuccessActionsPinned(false);
    };
  }, [success]);

  if (success) {
    const orderPath = success.id ? `/customer/orders/${success.id}` : '/customer/orders';
    const statusLabel = success.status || 'Pending';
    const isAssigned = statusLabel === 'Assigned';
    const isReview = statusLabel === 'Pending Review';

    return createPortal(
      <div className="booking-success-page" aria-labelledby="booking-success-title">
        <div className="booking-success-content">
          <BrandLockup size={30} className="booking-success-brand" />
          <div className="booking-success-intro" role="status" aria-live="polite">
            <ResultIcon tone="success" className="booking-success-mark" />
            <h1 id="booking-success-title" className="booking-success-heading" ref={successTitleRef} tabIndex={-1}>Booking received</h1>
            <p className="booking-success-subtitle">
              {isReview
                ? 'We’ll review your pickup area and update this booking soon.'
                : 'Your booking is saved. Follow its status anytime from Bookings.'}
            </p>
          </div>

          <section className="booking-success-card" aria-label="Booking details">
            <div className="booking-success-card-header">
              <span>Booking details</span>
              <span className={`booking-success-status-pill ${isAssigned ? 'is-assigned' : 'is-pending'}`}>
                {statusLabel}
              </span>
            </div>

            <div className="booking-success-tracking">
              <div className="booking-success-tracking-text">
                <span className="booking-success-label">Tracking number</span>
                <strong className="booking-success-tracking-number">{success.tracking_number}</strong>
              </div>
              <button
                type="button"
                className={`booking-success-copy-btn${trackingCopied ? ' is-copied' : ''}`}
                onClick={async () => {
                  if (await copyTrackingNumber(success.tracking_number)) {
                    setTrackingCopied(true);
                    setTimeout(() => setTrackingCopied(false), 2000);
                  } else {
                    toast.error('Could not copy the tracking number. Please select and copy it manually.');
                  }
                }}
                aria-label={trackingCopied ? 'Tracking number copied' : 'Copy tracking number'}
              >
                {trackingCopied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                <span>{trackingCopied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>

            <div className="booking-success-route">
              <span className="booking-success-label">Route</span>
              <div className="booking-success-route-path">
                <span>{success.origin}</span>
                <ArrowRight size={18} aria-hidden="true" />
                <span>{success.destination}</span>
              </div>
            </div>

            <dl className="booking-success-details">
              <div><dt>Sender</dt><dd>{orderPartyName(success, 'sender')}</dd></div>
              <div><dt>Receiver</dt><dd>{orderPartyName(success, 'receiver')}</dd></div>
              {success.package_description && (
                <div className="booking-success-package"><dt>Package</dt><dd>{success.package_description}</dd></div>
              )}
            </dl>
          </section>

          <p className="booking-success-note">Final shipping cost is confirmed after your parcel is weighed at pickup.</p>

          {/* Action buttons */}
          <div className={`booking-success-actions${successActionsPinned ? ' is-pinned' : ''}`}>
            <button type="button" className="btn booking-success-btn-primary" onClick={() => navigate(orderPath)}>
              View Booking <ArrowRight size={17} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn booking-success-btn-outline"
              onClick={() => {
                clearBookingDraftStorage(user.id);
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
                // Belt-and-suspenders alongside the post-submit refresh above:
                // guarantees the dropdown is current even if that earlier
                // fetch failed or the order changed again since then.
                refreshRecentContacts();
                setForm(prev => ({
                  ...prev,
                  route: '', trip_id: '',
                  sender_first_name: '', sender_last_name: '', sender_phone: '', sender_facebook: '',
                  sender_lot_block: '', sender_street: '', sender_barangay: '',
                  sender_city: '', sender_province: '', sender_landmark: '',
                  receiver_first_name: '', receiver_last_name: '', receiver_phone: '', receiver_facebook: '',
                  receiver_lot_block: '', receiver_street: '', receiver_barangay: '',
                  receiver_city: '', receiver_province: '', receiver_landmark: '',
                  package_description: '',
                  payer_type: 'sender', payment_preference: 'unspecified', notes: '', sender_other_province: '',
                }));
              }}
            >
              Book Another
            </button>
          </div>
          {/* The page's bottom spacing, kept inside the receipt so the pinned
              bar can reach the screen edge; also the marker observed above. */}
          <div className="booking-success-end" ref={successEndRef} aria-hidden="true" />
        </div>
      </div>,
      document.body
    );
  }

  const steps = ['Route', 'Sender', 'Receiver', 'Package', 'Review'];
  const renderStepProgress = () => (
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
  );

  return (
    <div className="page-transition booking-page">
      {progressDock && createPortal(renderStepProgress(), progressDock)}
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
        onConfirm={() => { clearBookingDraftStorage(user.id); blocker.proceed(); }}
        title="Discard unsaved booking?"
        message="You have unsaved changes in your booking form. If you leave now, all entered data will be lost."
        confirmLabel="Discard"
        cancelLabel="Stay"
        variant="danger"
      />

      <div className="customer-top-actions">
        <button type="button" onClick={() => step > 1 ? setStep(step - 1) : navigate(-1)} className="btn btn-ghost customer-back-action">
          <ArrowLeft size={18} /> {step > 1 ? 'Back' : 'Cancel'}
        </button>
        <Link to="/customer/support" className="customer-inline-support-link">
          <Headset size={16} aria-hidden="true" /> Chat support
        </Link>
      </div>
      <h1 className="sr-only">Book Shipment</h1>
      <h2 className="fw-700 mb-8">Book Shipment</h2>

      {/* Step Progress */}
      {renderStepProgress()}
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
          <div className="alert-banner alert-banner-info mb-16" style={{ fontSize: 'var(--text-13)' }}>
            <Info size={14} aria-hidden="true" />
            <span><strong>Coverage Area:</strong> CargoExpress PH currently operates routes to and from <strong>Bohol only</strong>. Select a route below to view specific province rules.</span>
          </div>
          {preTripId && selectedTrip && (
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
            <div className="alert-banner alert-banner-warning mt-16" style={{ fontSize: 'var(--text-13)' }}>
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
            <label htmlFor="useRegSender" className={`booking-use-registered${useRegisteredSender ? ' is-checked' : ''}`}>
              <input type="checkbox" id="useRegSender" checked={useRegisteredSender} onChange={e => handleUseRegisteredSenderChange(e.target.checked)} />
              <span className="booking-use-registered-text">
                <strong>Use my registered address</strong>
                <span>Fill in the sender details from your profile.</span>
              </span>
            </label>
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
            <label htmlFor="useRegReceiver" className={`booking-use-registered${useRegisteredReceiver ? ' is-checked' : ''}`}>
              <input type="checkbox" id="useRegReceiver" checked={useRegisteredReceiver} onChange={e => handleUseRegisteredReceiverChange(e.target.checked)} />
              <span className="booking-use-registered-text">
                <strong>Use my registered address</strong>
                <span>Fill in the receiver details from your profile.</span>
              </span>
            </label>
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
            <label className="form-label" htmlFor="package-description">What are you sending? <span className="required">*</span></label>
            <input id="package-description" className={`form-input ${fieldErrors.package_description ? 'field-invalid' : ''}`} value={form.package_description} onChange={e => { u('package_description', e.target.value); setFieldErrors(prev => ({...prev, package_description: false})); }} placeholder="e.g. Documents, 2 boxes of clothes, small appliance" aria-invalid={fieldErrors.package_description ? 'true' : undefined} aria-describedby={fieldErrors.package_description ? 'package-description-error package-description-helper' : 'package-description-helper'} />
            {fieldErrors.package_description && <div className="field-error-inline" id="package-description-error" role="alert"><AlertTriangle size={12} aria-hidden="true" />Package description is required.</div>}
            <p id="package-description-helper" className="text-xs text-secondary mt-4">Describe your items. We weigh the parcel at pickup and the exact cost is confirmed then.</p>
          </div>
          {/* Side by side on wide screens, stacked on phones (.grid-2). */}
          <div className="grid grid-2 gap-16 booking-pay-row">
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
            <div className="text-sm text-secondary">{shippingRateLabel}</div>
            <div className="text-2xl fw-700 text-primary">₱{effectivePricePerKilo}/kg</div>
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
          {submitError && (
            <div className="booking-submit-failure" role="alert">
              <AlertTriangle size={18} className="booking-submit-failure-icon" aria-hidden="true" />
              <div className="booking-submit-failure-body">
                <p className="booking-submit-failure-title">We couldn’t confirm your booking</p>
                <p>{submitError}</p>
                <p>
                  Your details are still here. Tap Confirm Booking to try again, but
                  check Bookings first in case it was already saved.
                </p>
              </div>
            </div>
          )}
          <p className="booking-review-intro">Check everything once more. Tap <strong>Edit</strong> on any section to change it.</p>
          <div className="booking-summary-card mb-16">
            <div className="booking-summary-head">
              <div className="booking-summary-label">Route</div>
              <button type="button" className="booking-summary-edit" onClick={() => setStep(1)} aria-label="Edit route">Edit</button>
            </div>
            <div className="booking-summary-value">{form.route}</div>
            {form.trip_id && (
              <div className="text-xs text-secondary mt-4">
                {selectedTrip
                  ? `Trip ${selectedTrip.trip_number} · ${formatBookingTripDate(selectedTrip.departure_date)}`
                  : 'Selected trip is no longer available. Edit your route before confirming.'}
              </div>
            )}
          </div>
          <div className="grid grid-2 gap-12 mb-16">
            {[['sender', 'Sender', 2], ['receiver', 'Receiver', 3]].map(([p, title, editStep]) => {
              // Same wording as the order page: every part the customer typed,
              // lot/block and landmark included.
              const province = form[`${p}_province`] === 'Other Area' && form[`${p}_other_province`]
                ? form[`${p}_other_province`]
                : form[`${p}_province`];
              return (
                <div key={p} className="booking-summary-card">
                  <div className="booking-summary-head">
                    <div className="booking-summary-label">{title}</div>
                    <button type="button" className="booking-summary-edit" onClick={() => setStep(editStep)} aria-label={`Edit ${title.toLowerCase()} details`}>Edit</button>
                  </div>
                  <div className="text-sm font-bold">{form[`${p}_first_name`]} {form[`${p}_last_name`]}</div>
                  <div className="text-xs text-secondary">{form[`${p}_phone`]}</div>
                  <div className="text-xs text-secondary mt-4">
                    {buildFullAddress({
                      lotBlock: form[`${p}_lot_block`], street: form[`${p}_street`], barangay: form[`${p}_barangay`],
                      city: form[`${p}_city`], province, landmark: form[`${p}_landmark`],
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="booking-summary-card mb-16">
            <div className="booking-summary-head">
              <div className="booking-summary-label">Package</div>
              <button type="button" className="booking-summary-edit" onClick={() => setStep(4)} aria-label="Edit package details">Edit</button>
            </div>
            <div className="text-sm font-bold">{form.package_description}</div>
            <dl className="booking-summary-facts">
              <div><dt>Who pays</dt><dd>{form.payer_type === 'receiver' ? 'Receiver' : 'Sender'}</dd></div>
              <div><dt>Payment</dt><dd>{{ cash: 'Cash', gcash: 'GCash' }[form.payment_preference] || 'Decide later'}</dd></div>
            </dl>
            {form.notes?.trim() && <div className="text-xs text-secondary mt-4">Notes: {form.notes}</div>}
          </div>
          <div className="booking-cost-card text-center mb-16">
            <div className="text-sm text-secondary">{shippingRateLabel}</div>
            <div className="fw-700 text-primary" style={{ fontSize: 'var(--text-32)' }}>₱{effectivePricePerKilo}/kg</div>
            <div className="text-xs text-tertiary mt-4">Your total is calculated when we weigh your parcel at pickup.</div>
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
