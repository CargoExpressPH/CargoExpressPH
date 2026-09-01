import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate, useBlocker } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { normalizeProfileAddressFields } from '../../lib/address';
import { updateOwnProfile } from '../../lib/database';
import { PH_LOCATIONS, VALID_PROVINCES } from '../../constants/phLocations';
import {
  ArrowLeft, Loader, Save,
  User, Phone, MapPin, Home, Hash, MessageSquare, Map, Building, Navigation,
} from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import CustomSelect from '../../components/ui/CustomSelect';
import BarangaySelect from '../../components/ui/BarangaySelect';
import ConfirmModal from '../../components/ui/ConfirmModal';
import usePageTitle from '../../hooks/usePageTitle';
import { toTitleCase, toAddressCase, normalizeName } from '../../utils/string';
import FieldError from '../../components/ui/FieldError';
import { validatePhone as validatePhoneShared } from '../../utils/phone';

const validatePhone = (phone) => validatePhoneShared(phone, { showDigitCount: true });

const PersonalInfoPage = () => {
  usePageTitle('Personal Info');
  const { user, userProfile, refreshProfile } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [form, setForm] = useState({
    name:              userProfile?.name              || '',
    facebook_name:     userProfile?.facebook_name     || '',
    phone:             userProfile?.phone             || '',
    address_province:  userProfile?.address_province  || '',
    address_city:      userProfile?.address_city      || '',
    address_barangay:  userProfile?.address_barangay  || '',
    address_street:    userProfile?.address_street    || '',
    address_lot_block: userProfile?.address_lot_block || '',
    address_landmark:  userProfile?.address_landmark  || '',
  });

  const [loading,     setLoading]     = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});

  // True once the customer has actually typed/selected something. Gates the
  // sync effect below so it can only ever fill the form in, never clobber an
  // edit already in progress.
  const hasEditedRef = useRef(false);

  // `userProfile` was only read once, via the useState initializer above —
  // if it arrives or changes after this page has already mounted (a slow
  // fetchProfile still in flight, a background refreshProfile() from
  // useNetworkRecovery elsewhere in the app), the open form kept showing
  // whatever it started with. This brings it back in sync for as long as the
  // customer hasn't started editing.
  useEffect(() => {
    if (hasEditedRef.current) return;
    setForm({
      name:              userProfile?.name              || '',
      facebook_name:     userProfile?.facebook_name     || '',
      phone:             userProfile?.phone             || '',
      address_province:  userProfile?.address_province  || '',
      address_city:      userProfile?.address_city      || '',
      address_barangay:  userProfile?.address_barangay  || '',
      address_street:    userProfile?.address_street    || '',
      address_lot_block: userProfile?.address_lot_block || '',
      address_landmark:  userProfile?.address_landmark  || '',
    });
  }, [userProfile]);

  // C-4 fix: Track dirty state and block navigation when form has unsaved changes
  const isFormDirty = useCallback(() => {
    if (!userProfile) return false;
    return (
      form.name !== (userProfile.name || '') ||
      form.facebook_name !== (userProfile.facebook_name || '') ||
      form.phone !== (userProfile.phone || '') ||
      form.address_province !== (userProfile.address_province || '') ||
      form.address_city !== (userProfile.address_city || '') ||
      form.address_barangay !== (userProfile.address_barangay || '') ||
      form.address_street !== (userProfile.address_street || '') ||
      form.address_lot_block !== (userProfile.address_lot_block || '') ||
      form.address_landmark !== (userProfile.address_landmark || '')
    );
  }, [form, userProfile]);

  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    return isFormDirty() && currentLocation.pathname !== nextLocation.pathname;
  });

  const cities = form.address_province ? PH_LOCATIONS[form.address_province] || [] : [];

  const setField = (key, value) => {
    hasEditedRef.current = true;
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const handleTitleCase = (key) => (e) => {
    setField(key, toTitleCase(e.target.value));
    if (fieldErrors[key]) setFieldErrors(prev => ({ ...prev, [key]: null }));
  };

  // Street/Lot-Block/Landmark: capitalizes each word's first letter only —
  // never lowercases the rest, so deliberate acronyms ("STI School") survive.
  const handleAddressCase = (key) => (e) => {
    setField(key, toAddressCase(e.target.value));
    if (fieldErrors[key]) setFieldErrors(prev => ({ ...prev, [key]: null }));
  };

  const handlePhone = (e) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 11);
    setField('phone', digits);
    setFieldErrors(prev => ({ ...prev, phone: validatePhone(digits) }));
  };

  const validate = () => {
    const errors = {};
    if (!form.name.trim()) errors.name = 'Full name is required.';
    if (!form.facebook_name?.trim()) errors.facebook_name = 'Facebook name is required.';
    const phoneErr = validatePhone(form.phone);
    if (phoneErr) errors.phone = phoneErr;
    if (!form.address_lot_block?.trim()) errors.address_lot_block = 'Lot / Block / Purok is required.';
    if (!form.address_landmark?.trim()) errors.address_landmark = 'Landmark is required.';
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    if (!user?.id) { toast.error('You are not logged in.'); return; }
    setLoading(true);
    try {
      const normalizedAddress = normalizeProfileAddressFields(form);

      await updateOwnProfile(user.id, {
        // Same reason as RegisterPage: trim() alone leaves "bea  sarong"
        // double-spaced and lower-cased in the database.
        name:              normalizeName(form.name),
        facebook_name:     normalizeName(form.facebook_name),
        phone:             form.phone || null,

        address_province:  normalizedAddress.address_province || null,
        address_city:      normalizedAddress.address_city || null,
        address_barangay:  normalizedAddress.address_barangay || null,
        address_street:    normalizedAddress.address_street || null,
        address_lot_block: normalizedAddress.address_lot_block || null,
        address_landmark:  normalizedAddress.address_landmark || null,
        updated_at:        new Date().toISOString(),
      });
      await refreshProfile();
      toast.success('Profile updated successfully!');
      setTimeout(() => navigate(-1), 1200);
      // Not clearing `loading` here: the navigation is still 1200ms away, and
      // resetting it now would re-enable the Save button (and un-disable the
      // form) for that whole window before the page actually leaves.
    } catch (err) {
      let msg = 'Failed to save changes. Please try again.';
      if (err?.code === 'PGRST301' || err?.message?.includes('JWT')) msg = 'Session expired. Please sign in again.';
      else if (err?.message?.includes('violates')) msg = 'Invalid data. Check your inputs and try again.';
      else if (err?.message) msg = err.message;
      toast.error(msg);
      setLoading(false);
    }
  };

  return (
    <div className="animate-slide-up customer-personal-info-page">
      {/* Unsaved-changes guard. Uses the shared ConfirmModal rather than a
          hand-rolled overlay: the local copy rendered in place, so it was
          trapped inside <PageTransition>'s stacking context and the bottom tab
          bar painted over its buttons on mobile. It had also drifted visually —
          a warning-orange icon and a btn-primary with an inline red background,
          against ConfirmModal's danger styling on the identical prompt in
          ChangePasswordPage. */}
      <ConfirmModal
        isOpen={blocker.state === 'blocked'}
        onClose={() => blocker.reset()}
        onConfirm={() => blocker.proceed()}
        title="Discard unsaved changes?"
        message="You have unsaved changes to your personal information. If you leave now, your changes will be lost."
        confirmLabel="Discard"
        cancelLabel="Stay"
        variant="danger"
      />

      <button type="button" onClick={() => navigate(-1)} className="btn btn-ghost customer-back-action mb-16">
        <ArrowLeft size={18} /> Back
      </button>
      <h1 className="fw-800 mb-20">Personal Information</h1>

      <div className="card">
        <div className="card-body">

          {/* Full Name */}
          <div className="form-group">
            <label className="form-label" htmlFor="profile-name">Full Name</label>
            <div className="form-input-wrapper">
              <User size={15} className="form-input-icon" />
              <input
                id="profile-name"
                className={`form-input form-input-icon-left ${fieldErrors.name ? 'field-invalid' : ''}`}
                placeholder="Juan Dela Cruz"
                value={form.name}
                onChange={handleTitleCase('name')}
                autoCapitalize="words"
                autoComplete="name"
                required
                aria-required="true"
                aria-invalid={fieldErrors.name ? 'true' : undefined}
                aria-describedby={fieldErrors.name ? 'profile-name-error' : undefined}
              />
            </div>
            {fieldErrors.name && <FieldError id="profile-name-error" message={fieldErrors.name} />}
          </div>

          {/* Facebook Name */}
          <div className="form-group">
            <label className="form-label" htmlFor="profile-facebook-name">Facebook Name</label>
            <div className="form-input-wrapper">
              <MessageSquare size={15} className="form-input-icon" />
              <input
                id="profile-facebook-name"
                className={`form-input form-input-icon-left ${fieldErrors.facebook_name ? 'field-invalid' : ''}`}
                placeholder="Juan Dela Cruz on FB"
                value={form.facebook_name}
                onChange={handleTitleCase('facebook_name')}
                autoCapitalize="words"
                required
                aria-required="true"
                aria-invalid={fieldErrors.facebook_name ? 'true' : undefined}
                aria-describedby={fieldErrors.facebook_name ? 'profile-facebook-name-error' : undefined}
              />
            </div>
            {fieldErrors.facebook_name && <FieldError id="profile-facebook-name-error" message={fieldErrors.facebook_name} />}
          </div>

          {/* Mobile Number */}
          <div className="form-group">
            <label className="form-label" htmlFor="profile-phone">Mobile Number</label>
            <div className="form-input-wrapper">
              <Phone size={15} className="form-input-icon" />
              <input
                id="profile-phone"
                className={`form-input form-input-icon-left ${fieldErrors.phone ? 'field-invalid' : ''}`}
                placeholder="09xxxxxxxxx"
                value={form.phone}
                onChange={handlePhone}
                inputMode="numeric"
                maxLength={11}
                aria-invalid={fieldErrors.phone ? 'true' : undefined}
                aria-describedby={fieldErrors.phone ? 'profile-phone-error' : 'profile-phone-helper'}
              />
            </div>
            {fieldErrors.phone
              ? <FieldError id="profile-phone-error" message={fieldErrors.phone} />
              : <p className="form-helper" id="profile-phone-helper">Must start with 09 and be exactly 11 digits</p>
            }
          </div>

          {/* Province */}
          <div className="form-group">
            <label className="form-label" htmlFor="profile-province">Province</label>
            <div className="form-input-wrapper">
              <Map size={15} className="form-input-icon" />
              <CustomSelect
                id="profile-province"
                className="form-select form-input-icon-left"
                value={form.address_province}
                onChange={e => {
                  // Barangay belongs to a city and city belongs to a province,
                  // so both have to go: a barangay left behind from the old
                  // province would be saved against a city it is not in.
                  setField('address_province', e.target.value);
                  setField('address_city', '');
                  setField('address_barangay', '');
                }}
              >
                <option value="">Select Province</option>
                {VALID_PROVINCES.map(p => <option key={p} value={p}>{p}</option>)}
              </CustomSelect>
            </div>
          </div>

          {/* City / Municipality */}
          <div className="form-group">
            <label className="form-label" htmlFor="profile-city">City / Municipality</label>
            <div className="form-input-wrapper">
              <Building size={15} className="form-input-icon" />
              <CustomSelect
                id="profile-city"
                className="form-select form-input-icon-left"
                value={form.address_city}
                onChange={e => { setField('address_city', e.target.value); setField('address_barangay', ''); }}
              >
                <option value="">Select City</option>
                {cities.map(c => <option key={c} value={c}>{c}</option>)}
              </CustomSelect>
            </div>
          </div>

          {/* Barangay */}
          <div className="form-group">
            <label className="form-label" htmlFor="profile-barangay">Barangay</label>
            <div className="form-input-wrapper">
              <MapPin size={15} className="form-input-icon" />
              <BarangaySelect
                id="profile-barangay"
                className="form-input-icon-left"
                province={form.address_province}
                city={form.address_city}
                value={form.address_barangay}
                onChange={e => setField('address_barangay', e.target.value)}
              />
            </div>
          </div>

          {/* Street */}
          <div className="form-group">
            <label className="form-label" htmlFor="profile-street">Street and Subdivision (put NA if not applicable)</label>
            <div className="form-input-wrapper">
              <Home size={15} className="form-input-icon" />
              <input
                id="profile-street"
                className="form-input form-input-icon-left"
                placeholder="Street and Subdivision (put NA if not applicable)"
                value={form.address_street}
                onChange={handleAddressCase('address_street')}
              />
            </div>
          </div>

          {/* Lot / Block / Purok */}
          <div className="form-group">
            <label className="form-label" htmlFor="profile-lot-block">Lot / Block / Purok</label>
            <div className="form-input-wrapper">
              <Hash size={15} className="form-input-icon" />
              <input
                id="profile-lot-block"
                className={`form-input form-input-icon-left ${fieldErrors.address_lot_block ? 'field-invalid' : ''}`}
                placeholder="e.g. Lot 12, Block 5"
                value={form.address_lot_block}
                onChange={handleAddressCase('address_lot_block')}
                aria-invalid={fieldErrors.address_lot_block ? 'true' : undefined}
                aria-describedby={fieldErrors.address_lot_block ? 'profile-lot-block-error' : undefined}
              />
            </div>
            {fieldErrors.address_lot_block && <FieldError id="profile-lot-block-error" message={fieldErrors.address_lot_block} />}
          </div>

          {/* Landmark */}
          <div className="form-group">
            <label className="form-label" htmlFor="profile-landmark">Landmark</label>
            <div className="form-input-wrapper">
              <Navigation size={15} className="form-input-icon" />
              <input
                id="profile-landmark"
                className={`form-input form-input-icon-left ${fieldErrors.address_landmark ? 'field-invalid' : ''}`}
                placeholder="e.g. Near Sari-sari Store"
                value={form.address_landmark}
                onChange={handleAddressCase('address_landmark')}
                aria-invalid={fieldErrors.address_landmark ? 'true' : undefined}
                aria-describedby={fieldErrors.address_landmark ? 'profile-landmark-error' : undefined}
              />
            </div>
            {fieldErrors.address_landmark && <FieldError id="profile-landmark-error" message={fieldErrors.address_landmark} />}
          </div>

          {/* Save */}
          <button
            type="button"
            className="btn btn-primary btn-lg w-full justify-center mt-8"
            onClick={handleSave}
            disabled={loading}
          >
            {loading
              ? <><Loader size={18} className="animate-spin" /> Saving...</>
              : <><Save size={18} /> Save Changes</>
            }
          </button>

        </div>
      </div>
    </div>
  );
};

export default PersonalInfoPage;
