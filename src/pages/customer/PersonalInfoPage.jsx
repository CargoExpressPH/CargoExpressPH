import { useState, useCallback } from 'react';
import { useNavigate, useBlocker } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { buildProfileAddress, normalizeProfileAddressFields } from '../../lib/address';
import { supabase } from '../../lib/supabase';
import { PH_LOCATIONS, VALID_PROVINCES } from '../../constants/phLocations';
import {
  ArrowLeft, Loader, Save, AlertTriangle,
  User, Phone, MapPin, Home, Hash, MessageSquare, Map, Building, Navigation,
} from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import CustomSelect from '../../components/ui/CustomSelect';
import usePageTitle from '../../hooks/usePageTitle';
import { toTitleCase } from '../../utils/string';

const validatePhone = (phone) => {
  const val = (phone || '').trim();
  if (!val) return 'Mobile number is required.';
  if (!/^\d+$/.test(val)) return 'Mobile number must contain numbers only.';
  if (!val.startsWith('09')) return 'Mobile number must start with 09.';
  if (val.length !== 11) return `Mobile number must be exactly 11 digits (${val.length}/11).`;
  return null;
};

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

  const setField = (key, value) => setForm(prev => ({ ...prev, [key]: value }));

  const handleTitleCase = (key) => (e) => {
    setField(key, toTitleCase(e.target.value));
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
      const combinedAddress = buildProfileAddress(normalizedAddress);

      const { error: updateError } = await supabase
        .from('profiles')
        .update({
          name:              form.name.trim(),
          facebook_name:     form.facebook_name.trim(),
          phone:             form.phone || null,
          address:           combinedAddress || null,
          address_province:  normalizedAddress.address_province || null,
          address_city:      normalizedAddress.address_city || null,
          address_barangay:  normalizedAddress.address_barangay || null,
          address_street:    normalizedAddress.address_street || null,
          address_lot_block: normalizedAddress.address_lot_block || null,
          address_landmark:  normalizedAddress.address_landmark || null,
          updated_at:        new Date().toISOString(),
        })
        .eq('id', user.id);

      if (updateError) throw updateError;
      await refreshProfile();
      toast.success('Profile updated successfully!');
      setTimeout(() => navigate(-1), 1200);
    } catch (err) {
      let msg = 'Failed to save changes. Please try again.';
      if (err?.code === 'PGRST301' || err?.message?.includes('JWT')) msg = 'Session expired. Please sign in again.';
      else if (err?.message?.includes('violates')) msg = 'Invalid data. Check your inputs and try again.';
      else if (err?.message) msg = err.message;
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="animate-slide-up customer-personal-info-page">
      {/* C-4 fix: Unsaved changes guard modal */}
      {blocker.state === 'blocked' && (
        <div className="modal-overlay" style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}>
          <div className="card" style={{ maxWidth: 400, width: '90%', padding: 24, textAlign: 'center' }}>
            <AlertTriangle size={32} color="var(--warning)" style={{ marginBottom: 12 }} />
            <h3 className="fw-700 mb-8">Discard unsaved changes?</h3>
            <p className="text-sm text-secondary mb-20">You have unsaved changes to your personal information. If you leave now, your changes will be lost.</p>
            <div className="flex gap-12 justify-center">
              <button type="button" className="btn btn-outline" onClick={() => blocker.reset()}>Stay</button>
              <button type="button" className="btn btn-primary" style={{ background: 'var(--error)' }} onClick={() => blocker.proceed()}>Discard</button>
            </div>
          </div>
        </div>
      )}

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
                className={`form-input form-input-icon-left ${fieldErrors.name ? 'error' : ''}`}
                placeholder="Juan Dela Cruz"
                value={form.name}
                onChange={handleTitleCase('name')}
              />
            </div>
            {fieldErrors.name && <p className="form-error">{fieldErrors.name}</p>}
          </div>

          {/* Facebook Name */}
          <div className="form-group">
            <label className="form-label" htmlFor="profile-facebook-name">Facebook Name</label>
            <div className="form-input-wrapper">
              <MessageSquare size={15} className="form-input-icon" />
              <input
                id="profile-facebook-name"
                className={`form-input form-input-icon-left ${fieldErrors.facebook_name ? 'error' : ''}`}
                placeholder="Juan Dela Cruz on FB"
                value={form.facebook_name}
                onChange={e => setField('facebook_name', e.target.value)}
              />
            </div>
            {fieldErrors.facebook_name && <p className="form-error">{fieldErrors.facebook_name}</p>}
          </div>

          {/* Mobile Number */}
          <div className="form-group">
            <label className="form-label" htmlFor="profile-phone">Mobile Number</label>
            <div className="form-input-wrapper">
              <Phone size={15} className="form-input-icon" />
              <input
                id="profile-phone"
                className={`form-input form-input-icon-left ${fieldErrors.phone ? 'error' : ''}`}
                placeholder="09xxxxxxxxx"
                value={form.phone}
                onChange={handlePhone}
                inputMode="numeric"
                maxLength={11}
              />
            </div>
            {fieldErrors.phone
              ? <p className="form-error">{fieldErrors.phone}</p>
              : <p className="form-helper">Must start with 09 and be exactly 11 digits</p>
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
                onChange={e => { setField('address_province', e.target.value); setField('address_city', ''); }}
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
                onChange={e => setField('address_city', e.target.value)}
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
              <input
                id="profile-barangay"
                className="form-input form-input-icon-left"
                placeholder="Barangay name"
                value={form.address_barangay}
                onChange={handleTitleCase('address_barangay')}
              />
            </div>
          </div>

          {/* Street */}
          <div className="form-group">
            <label className="form-label" htmlFor="profile-street">Street</label>
            <div className="form-input-wrapper">
              <Home size={15} className="form-input-icon" />
              <input
                id="profile-street"
                className="form-input form-input-icon-left"
                placeholder="Street name"
                value={form.address_street}
                onChange={handleTitleCase('address_street')}
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
                className={`form-input form-input-icon-left ${fieldErrors.address_lot_block ? 'error' : ''}`}
                placeholder="e.g. Lot 12, Block 5"
                value={form.address_lot_block}
                onChange={handleTitleCase('address_lot_block')}
              />
            </div>
            {fieldErrors.address_lot_block && <p className="form-error">{fieldErrors.address_lot_block}</p>}
          </div>

          {/* Landmark */}
          <div className="form-group">
            <label className="form-label" htmlFor="profile-landmark">Landmark</label>
            <div className="form-input-wrapper">
              <Navigation size={15} className="form-input-icon" />
              <input
                id="profile-landmark"
                className={`form-input form-input-icon-left ${fieldErrors.address_landmark ? 'error' : ''}`}
                placeholder="e.g. Near Sari-sari Store"
                value={form.address_landmark}
                onChange={handleTitleCase('address_landmark')}
              />
            </div>
            {fieldErrors.address_landmark && <p className="form-error">{fieldErrors.address_landmark}</p>}
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
