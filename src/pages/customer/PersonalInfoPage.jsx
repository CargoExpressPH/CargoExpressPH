import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate, useBlocker } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { normalizeProfileAddressFields } from '../../lib/address';
import { updateOwnProfile } from '../../lib/database';
import { PH_LOCATIONS, VALID_PROVINCES } from '../../constants/phLocations';
import {
  Loader, Save,
  User, Phone, MapPin, Home, Hash, MessageSquare, Map, Building, Navigation,
} from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import CustomSelect from '../../components/ui/CustomSelect';
import BarangaySelect from '../../components/ui/BarangaySelect';
import ConfirmModal from '../../components/ui/ConfirmModal';
import CustomerAccountHeader from '../../components/ui/CustomerAccountHeader';
import usePageTitle from '../../hooks/usePageTitle';
import { toTitleCase, toAddressCase, normalizeName } from '../../utils/string';
import FieldError, { invalidClass } from '../../components/ui/FieldError';
import { validatePhone as validatePhoneShared } from '../../utils/phone';
import { validateName, validateAddressLine, validateFacebookName } from '../../utils/validation';

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
  const savedRef = useRef(false);

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
    if (!userProfile || savedRef.current) return false;
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
    savedRef.current = false;
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const clearFieldErrors = (...keys) => {
    setFieldErrors((prev) => {
      if (!keys.some((key) => prev[key])) return prev;
      const next = { ...prev };
      keys.forEach((key) => { delete next[key]; });
      return next;
    });
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
    const nameErr = validateName(form.name);
    if (nameErr) errors.name = nameErr;

    const fbErr = validateFacebookName(form.facebook_name);
    if (fbErr) errors.facebook_name = fbErr;

    const phoneErr = validatePhone(form.phone);
    if (phoneErr) errors.phone = phoneErr;

    const streetErr = validateAddressLine(form.address_street);
    if (streetErr) errors.address_street = streetErr;

    const lotErr = validateAddressLine(form.address_lot_block);
    if (lotErr) errors.address_lot_block = lotErr;

    const landmarkErr = validateAddressLine(form.address_landmark);
    if (landmarkErr) errors.address_landmark = landmarkErr;

    if (!form.address_province) errors.address_province = 'Province is required.';
    if (!form.address_city) errors.address_city = 'City/Municipality is required.';
    if (!form.address_barangay) errors.address_barangay = 'Barangay is required.';

    setFieldErrors(errors);
    if (Object.keys(errors).length) {
      const fieldIds = {
        name: 'profile-name', facebook_name: 'profile-facebook-name', phone: 'profile-phone',
        address_province: 'profile-province', address_city: 'profile-city',
        address_barangay: 'profile-barangay', address_street: 'profile-street',
        address_lot_block: 'profile-lot-block', address_landmark: 'profile-landmark',
      };
      // The save button is below a long form; take the customer to the first
      // field needing attention instead of leaving them at the bottom.
      document.getElementById(fieldIds[Object.keys(errors)[0]])?.focus();
    }
    return Object.keys(errors).length === 0;
  };

  const handleSave = async (event) => {
    event.preventDefault();
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
      savedRef.current = true;
      toast.success('Profile updated successfully!');
      navigate(-1);
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
    <div className="animate-slide-up customer-personal-info-page customer-account-page customer-account-page--details">
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

      <CustomerAccountHeader
        title="Personal Information"
        description="Keep your contact details and default address up to date for your next shipment."
        icon={User}
      />

      <form className="personal-info-form account-details-form" onSubmit={handleSave} noValidate>
        <p className="account-required-note">Fields marked <span className="required">*</span> are required.</p>
        <section className="card account-settings-card" aria-labelledby="contact-details-title">
          <div className="account-settings-body">
            <div className="account-section-heading">
              <span className="account-section-icon"><User size={19} aria-hidden="true" /></span>
              <div>
                <h2 id="contact-details-title">Contact details</h2>
                <p>How we reach you about your shipment.</p>
              </div>
            </div>
            <div className="account-fields-grid">

          {/* Full Name */}
          <div className="form-group account-field-full">
            <label className="form-label" htmlFor="profile-name">Full Name <span className="required">*</span></label>
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
            <label className="form-label" htmlFor="profile-facebook-name">Facebook Name <span className="required">*</span></label>
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
            <label className="form-label" htmlFor="profile-phone">Mobile Number <span className="required">*</span></label>
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
                required
                aria-required="true"
                aria-invalid={fieldErrors.phone ? 'true' : undefined}
                aria-describedby={fieldErrors.phone ? 'profile-phone-error' : 'profile-phone-helper'}
              />
            </div>
            {fieldErrors.phone
              ? <FieldError id="profile-phone-error" message={fieldErrors.phone} />
              : <p className="form-helper" id="profile-phone-helper">Must start with 09 and be exactly 11 digits</p>
            }
          </div>

            </div>
          </div>
        </section>

        <section className="card account-settings-card" aria-labelledby="default-address-title">
          <div className="account-settings-body">
            <div className="account-section-heading">
              <span className="account-section-icon"><MapPin size={19} aria-hidden="true" /></span>
              <div>
                <h2 id="default-address-title">Default address</h2>
                <p>Pre-filled as your sender address when you book.</p>
              </div>
            </div>
            <div className="account-fields-grid">

          {/* Province */}
          <div className="form-group">
            <label className="form-label" htmlFor="profile-province">Province <span className="required">*</span></label>
            <div className="form-input-wrapper">
              <Map size={15} className="form-input-icon" />
              <CustomSelect
                searchable
                id="profile-province"
                className={`form-select form-input-icon-left ${invalidClass('address_province', fieldErrors)}`}
                value={form.address_province}
                onChange={e => {
                  // Barangay belongs to a city and city belongs to a province,
                  // so both have to go: a barangay left behind from the old
                  // province would be saved against a city it is not in.
                  setField('address_province', e.target.value);
                  setField('address_city', '');
                  setField('address_barangay', '');
                  clearFieldErrors('address_province', 'address_city', 'address_barangay');
                }}
                autoComplete="address-level1"
                aria-required="true"
                aria-invalid={Boolean(fieldErrors.address_province)}
                aria-describedby={fieldErrors.address_province ? 'profile-province-error' : undefined}
              >
                <option value="">Select Province</option>
                {VALID_PROVINCES.map(p => <option key={p} value={p}>{p}</option>)}
              </CustomSelect>
            </div>
            {fieldErrors.address_province && (
              <FieldError id="profile-province-error" message={fieldErrors.address_province} />
            )}
          </div>

          {/* City / Municipality */}
          <div className="form-group">
            <label className="form-label" htmlFor="profile-city">City / Municipality <span className="required">*</span></label>
            <div className="form-input-wrapper">
              <Building size={15} className="form-input-icon" />
              <CustomSelect
                searchable
                id="profile-city"
                className={`form-select form-input-icon-left ${invalidClass('address_city', fieldErrors)}`}
                value={form.address_city}
                onChange={e => {
                  setField('address_city', e.target.value);
                  setField('address_barangay', '');
                  clearFieldErrors('address_city', 'address_barangay');
                }}
                autoComplete="address-level2"
                disabled={!form.address_province}
                aria-required="true"
                aria-invalid={Boolean(fieldErrors.address_city)}
                aria-describedby={fieldErrors.address_city ? 'profile-city-error' : undefined}
              >
                <option value="">Select City</option>
                {cities.map(c => <option key={c} value={c}>{c}</option>)}
              </CustomSelect>
            </div>
            {fieldErrors.address_city && (
              <FieldError id="profile-city-error" message={fieldErrors.address_city} />
            )}
          </div>

          {/* Barangay */}
          <div className="form-group">
            <label className="form-label" htmlFor="profile-barangay">Barangay <span className="required">*</span></label>
            <div className="form-input-wrapper">
              <MapPin size={15} className="form-input-icon" />
              <BarangaySelect
                id="profile-barangay"
                className={`form-input-icon-left ${invalidClass('address_barangay', fieldErrors)}`}
                province={form.address_province}
                city={form.address_city}
                value={form.address_barangay}
                onChange={e => {
                  setField('address_barangay', e.target.value);
                  clearFieldErrors('address_barangay');
                }}
                autoComplete="address-level3"
                aria-required="true"
                aria-invalid={Boolean(fieldErrors.address_barangay)}
                aria-describedby={fieldErrors.address_barangay ? 'profile-barangay-error' : undefined}
              />
            </div>
            {fieldErrors.address_barangay && (
              <FieldError id="profile-barangay-error" message={fieldErrors.address_barangay} />
            )}
          </div>

          {/* Street */}
          <div className="form-group">
            <label className="form-label" htmlFor="profile-street">Street / Subdivision <span className="required">*</span></label>
            <div className="form-input-wrapper">
              <Home size={15} className="form-input-icon" />
              <input
                id="profile-street"
                className={`form-input form-input-icon-left ${invalidClass('address_street', fieldErrors)}`}
                placeholder="e.g. Rizal Street, Green Village"
                value={form.address_street}
                onChange={handleAddressCase('address_street')}
                required
                autoComplete="street-address"
                autoCapitalize="words"
                spellCheck="false"
                aria-required="true"
                aria-invalid={Boolean(fieldErrors.address_street)}
                aria-describedby={fieldErrors.address_street ? 'profile-street-error' : 'profile-street-helper'}
              />
            </div>
            {fieldErrors.address_street && (
              <FieldError id="profile-street-error" message={fieldErrors.address_street} />
            )}
            {!fieldErrors.address_street && <p className="form-helper" id="profile-street-helper">Enter NA if not applicable.</p>}
          </div>

          {/* Lot / Block / Purok */}
          <div className="form-group">
            <label className="form-label" htmlFor="profile-lot-block">Lot / Block / Purok <span className="required">*</span></label>
            <div className="form-input-wrapper">
              <Hash size={15} className="form-input-icon" />
              <input
                id="profile-lot-block"
                className={`form-input form-input-icon-left ${fieldErrors.address_lot_block ? 'field-invalid' : ''}`}
                placeholder="e.g. Lot 12, Block 5"
                value={form.address_lot_block}
                onChange={handleAddressCase('address_lot_block')}
                required
                autoComplete="address-line2"
                aria-required="true"
                aria-invalid={fieldErrors.address_lot_block ? 'true' : undefined}
                aria-describedby={fieldErrors.address_lot_block ? 'profile-lot-block-error' : undefined}
              />
            </div>
            {fieldErrors.address_lot_block && <FieldError id="profile-lot-block-error" message={fieldErrors.address_lot_block} />}
          </div>

          {/* Landmark */}
          <div className="form-group">
            <label className="form-label" htmlFor="profile-landmark">Landmark <span className="required">*</span></label>
            <div className="form-input-wrapper">
              <Navigation size={15} className="form-input-icon" />
              <input
                id="profile-landmark"
                className={`form-input form-input-icon-left ${fieldErrors.address_landmark ? 'field-invalid' : ''}`}
                placeholder="e.g. Near Sari-sari Store"
                value={form.address_landmark}
                onChange={handleAddressCase('address_landmark')}
                required
                aria-required="true"
                aria-invalid={fieldErrors.address_landmark ? 'true' : undefined}
                aria-describedby={fieldErrors.address_landmark ? 'profile-landmark-error' : undefined}
              />
            </div>
            {fieldErrors.address_landmark && <FieldError id="profile-landmark-error" message={fieldErrors.address_landmark} />}
          </div>

            </div>
          </div>
        </section>

        <div className="account-form-actions">
          <p>Your updated details will be used for future bookings.</p>
          <button
            type="submit"
            className="btn btn-primary btn-lg account-submit"
            disabled={loading}
          >
            {loading
              ? <><Loader size={18} className="animate-spin" /> Saving...</>
              : <><Save size={18} /> Save Changes</>
            }
          </button>
        </div>
      </form>
    </div>
  );
};

export default PersonalInfoPage;
