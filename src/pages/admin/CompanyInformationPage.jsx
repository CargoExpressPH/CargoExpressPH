import { useState, useEffect, useRef, useCallback } from 'react';
import { 
  getCompanyInformation, updateCompanyInformation, 
  getCoverageAreas, saveCoverageRegion, deleteCoverageRegion,
  saveCoverageMunicipality, deleteCoverageMunicipality, uploadPublicAsset
} from '../../lib/database';
import { logCompany } from '../../lib/activityLog';
import { 
  Building2, LayoutTemplate, Phone, Star, Image as ImageIcon, 
  Map, Loader, Save, ExternalLink, AlertTriangle,
  Upload, X, Trash2, Plus, Edit2, MapPin, PhilippinePeso, Building
} from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import ConfirmModal from '../../components/ui/ConfirmModal';
import { SkeletonText } from '../../components/ui/SkeletonLoader';
import CompanyInfoFeaturesTab from './CompanyInfoFeaturesTab';
import CompanyInfoCoverageTab from './CompanyInfoCoverageTab';
import usePageTitle from '../../hooks/usePageTitle';
import useFieldErrors from '../../hooks/useFieldErrors';
import FieldError, { fieldAttrs, invalidClass } from '../../components/ui/FieldError';

const TABS = [
  { id: 'basic',    label: 'Basic Info',      icon: Building2 },
  { id: 'contact',  label: 'Contact Info',    icon: Phone },
  { id: 'features', label: 'Why Choose Us',   icon: Star },
  { id: 'coverage', label: 'Coverage Areas',  icon: Map },
  { id: 'pricing',  label: 'Pricing',         icon: PhilippinePeso },
];

const SIMPLE_TABS = ['basic', 'contact', 'pricing'];

/**
 * Which tab each validated field lives under. Save is a single button for the
 * whole record, so a rejected save has to be able to reveal the field it is
 * complaining about — otherwise the message names a control that is not on
 * screen.
 */
const FIELD_TAB = {
  name: 'basic',
  website: 'contact',
  email: 'contact',
  facebook: 'contact',
  messenger: 'contact',
  default_price_per_kg: 'pricing',
};

const getEmptyCompanyInfo = () => ({
  name: '', short_description: '', long_description: '', story: '',
  core_values: '',
  hero_image_url: '', hero_title: '', hero_description: '', hero_button_text: '', hero_button_link: '',
  email: '', facebook: '', messenger: '', website: '', smart_phone: '', globe_phone: '',
  manila_address: '', bohol_address: '',
  default_price_per_kg: 0,
});

const CompanyInformationPage = () => {
  usePageTitle('Company Information');
  const toast = useToast();
  const [activeTab, setActiveTab] = useState('basic');
  const { errors, validate, clearError } = useFieldErrors();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingField, setUploadingField] = useState(null); // which field is uploading

  const [companyInfo, setCompanyInfo] = useState(null);
  const [savedInfo, setSavedInfo] = useState(null); // last-saved snapshot for dirty detection
  const [features, setFeatures] = useState([]);
  const [coverageAreas, setCoverageAreas] = useState([]);

  // Delete confirm modal state (for image removal)
  const [confirmModal, setConfirmModal] = useState({ open: false, title: '', message: '', onConfirm: null });

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [info, coverage] = await Promise.all([
        getCompanyInformation(),
        getCoverageAreas()
      ]);
      const resolvedInfo = info || getEmptyCompanyInfo();
      setCompanyInfo(resolvedInfo);
      setSavedInfo(JSON.stringify(resolvedInfo)); // snapshot
      setFeatures(resolvedInfo.features || []);
      setCoverageAreas(coverage || []);
    } catch (err) {
      toast.error('Failed to load company information');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const isDirty = SIMPLE_TABS.includes(activeTab) && companyInfo && savedInfo !== JSON.stringify(companyInfo);

  /**
   * What this page must not save.
   *
   * These are the fields that reach a customer or a price. The company name and
   * the per-kilo rate are load-bearing — the rate feeds `global_price_per_kilo()`
   * and therefore every unpriced order — while the contact fields are the ones
   * a customer is asked to act on, so a malformed one is worse than a blank one.
   * Everything else on this page is descriptive copy and stays optional.
   *
   * The database remains the authority; this exists to name the field before
   * the round trip rather than to replace the check.
   */
  const validateCompanyInfo = () => {
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const urlish = (v) => /^https?:\/\/.+/i.test(v.trim());
    const price = Number(companyInfo?.default_price_per_kg);

    const optionalUrl = (field, label) => {
      const v = companyInfo?.[field];
      return v && !urlish(v) ? `${label} must start with http:// or https://` : null;
    };

    return {
      name: !companyInfo?.name?.trim() ? 'Company name is required.' : null,
      email: !companyInfo?.email?.trim()
        ? 'A contact email is required — customers are told to write to it.'
        : !emailRe.test(companyInfo.email.trim())
          ? 'Please enter a valid email address.'
          : null,
      default_price_per_kg: !(price > 0)
        ? 'Enter a price per kilogram greater than ₱0. Every unpriced order is costed from it.'
        : null,
      website: optionalUrl('website', 'Website'),
      facebook: optionalUrl('facebook', 'Facebook link'),
      messenger: optionalUrl('messenger', 'Messenger link'),
    };
  };

  const handleSave = async () => {
    const failures = validateCompanyInfo();

    // The offending field may be under a tab that is not open — a red border on
    // a control nobody can see is not a report. Switch to the first tab that
    // has a problem before showing anything.
    const firstBad = Object.keys(failures).find(k => failures[k]);
    if (firstBad) {
      const tabOf = FIELD_TAB[firstBad];
      if (tabOf && tabOf !== activeTab) setActiveTab(tabOf);
    }
    if (!validate(failures)) return;

    try {
      setSaving(true);
      await updateCompanyInformation(companyInfo);
      setSavedInfo(JSON.stringify(companyInfo));
      logCompany('Company Information Updated', { details: 'Admin updated global company settings.' });
      toast.success('Changes saved successfully!');
    } catch (err) {
      toast.error(err.message || 'Failed to save changes');
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleInfoChange = (field, value) => {
    setCompanyInfo(prev => ({ ...prev, [field]: value }));
    clearError(field);
  };

  const handleImageUpload = async (e, fieldName) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setUploadingField(fieldName);
      const fileLabel = fieldName.replace(/_url$/, '').replace(/_/g, '-');
      const path = `hero/${fileLabel}.jpg`;
      const url = await uploadPublicAsset(file, path);
      handleInfoChange(fieldName, url);
      logCompany('Image Uploaded', { details: `Uploaded new image for ${fieldName}` });
      toast.success('Image uploaded successfully');
    } catch (err) {
      toast.error(err.message || 'Failed to upload image');
      console.error(err);
    } finally {
      setUploadingField(null);
      // Reset the file input
      e.target.value = '';
    }
  };

  const handleRemoveImage = (fieldName) => {
    setConfirmModal({
      open: true,
      title: 'Remove Image',
      message: 'Are you sure you want to remove this image? Save your changes afterwards to apply.',
      onConfirm: () => {
        handleInfoChange(fieldName, '');
        logCompany('Image Removed', { details: `Removed image for ${fieldName}` });
        setConfirmModal({ open: false });
      }
    });
  };

  if (loading) {
    return (
      <div className="page-transition">
        <div className="card p-24 mb-16">
          <div className="skeleton skeleton-text w-80 mb-16" style={{ height: 28 }} />
          <SkeletonText lines={4} />
        </div>
        <div className="card p-24">
          <SkeletonText lines={6} />
        </div>
      </div>
    );
  }

  // Guard: if companyInfo failed to load, show empty form state instead of crashing
  if (!companyInfo) {
    return (
      <div className="flex items-center justify-center" style={{ minHeight: 300 }}>
        <div className="text-center text-secondary">
          <AlertTriangle size={32} style={{ color: 'var(--warning-text)', marginBottom: 8 }} />
          <p>Failed to load company information. Please refresh the page.</p>
        </div>
      </div>
    );
  }

  const activeTabObj = TABS.find(t => t.id === activeTab);

  return (
    <div className="page-transition">
      {/* Page Header */}
      <div className="admin-page-header flex-wrap" style={{ gap: 12 }}>
        <div>
          <h1 className="admin-page-title"><Building size={24} color="var(--primary)" aria-hidden="true" />Company Information</h1>
          <p className="admin-page-subtitle">Manage all public website content shown to customers.</p>
        </div>
        <div className="flex items-center gap-8">
          <a
            href="/about"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-outline btn-sm"
          >
            <ExternalLink size={14} /> Preview Website
          </a>
          {SIMPLE_TABS.includes(activeTab) && (
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={saving || !isDirty}
            >
              {saving ? <Loader size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          )}
        </div>
      </div>

      {/* Unsaved Changes Banner */}
      {isDirty && (
        <div
          className="flex items-center justify-between gap-12 animate-fade-in rounded-md"
          style={{
            background: 'var(--warning-bg)',
            border: '1px solid rgba(245,158,11,0.3)',
            padding: '10px 16px',
            marginBottom: 16
          }}
        >
          <div className="flex items-center gap-8 text-sm font-semibold" style={{ color: 'var(--warning-text)' }}>
            <AlertTriangle size={16} />
            You have unsaved changes on this tab. Click "Save Changes" to apply them.
          </div>
        </div>
      )}

      {/* Tab Navigation */}
      <div
        className="card company-tab-bar flex items-center"
        style={{
          padding: '4px 8px',
          marginBottom: 20,
          gap: 4,
          overflowX: 'auto',
          flexWrap: 'nowrap'
        }}
      >
        {TABS.map(tab => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`btn btn-sm flex items-center gap-6${isActive ? '' : ' btn-ghost'}`}
              style={{
                flexShrink: 0,
                background: isActive ? 'var(--primary)' : 'transparent',
                color: isActive ? '#fff' : 'var(--text-secondary)',
                borderRadius: 'var(--radius-sm)',
                fontWeight: isActive ? 700 : 500,
                padding: '8px 14px',
                minHeight: 36,
                border: 'none',
              }}
            >
              <tab.icon size={14} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="animate-fade-in">

        {/* ─── BASIC INFO ────────────────────────────────────────────── */}
        {activeTab === 'basic' && (
          <div className="flex flex-col gap-16">
            <div className="card">
              <div className="card-header">
                <h3><Building2 size={16} className="inline mr-8" />Company Identity</h3>
              </div>
              <div className="card-body">
                <div className="grid grid-2" style={{ gap: 16 }}>
                  <div className="form-group">
                    <label className="form-label" htmlFor="company-name">Company Name</label>
                    <input id="company-name" className={`form-input ${invalidClass('name', errors)}`} value={companyInfo.name || ''} onChange={e => handleInfoChange('name', e.target.value)} placeholder="e.g. Cargo Express PH" {...fieldAttrs('name', errors)} />
                    <FieldError name="name" errors={errors} />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="company-website">Website URL</label>
                    {/* Same underlying field as the Contact tab's Website box,
                        so it carries its own error-node id — one id per DOM. */}
                    <input id="company-website" className={`form-input ${invalidClass('website', errors)}`} type="url" value={companyInfo.website || ''} onChange={e => handleInfoChange('website', e.target.value)} placeholder="https://..." aria-invalid={errors.website ? 'true' : undefined} aria-describedby={errors.website ? 'company-website-basic-error' : undefined} />
                    <FieldError name="website" errors={errors} id="company-website-basic-error" />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="company-short-description">Short Description <span className="text-tertiary" style={{fontWeight: 400}}>(shown in footer and search results)</span></label>
                  <input id="company-short-description" className="form-input" value={companyInfo.short_description || ''} onChange={e => handleInfoChange('short_description', e.target.value)} placeholder="One-line company description..." maxLength={160} />
                  <span className="form-helper">{(companyInfo.short_description || '').length}/160 characters</span>
                </div>
                <div className="form-group mb-0">
                  <label className="form-label" htmlFor="company-long-description">Company Introduction <span className="text-tertiary" style={{fontWeight: 400}}>(main text on the About Us page)</span></label>
                  <textarea id="company-long-description" className="form-textarea" rows={5} value={companyInfo.long_description || ''} onChange={e => handleInfoChange('long_description', e.target.value)} placeholder="Tell your company's story..." style={{ minHeight: 120 }} />
                </div>
              </div>
            </div>




            <div className="card">
              <div className="card-header">
                <h3><LayoutTemplate size={16} className="inline mr-8" />Homepage Banner Image</h3>
              </div>
              <div className="card-body">
                {/* Image Preview */}
                <div
                  className="w-full rounded-md flex items-center justify-center relative"
                  style={{height: 200,
                    overflow: 'hidden',
                    marginBottom: 16,
                    background: companyInfo.hero_image_url ? 'none' : 'var(--bg-secondary)',
                    border: '1.5px dashed var(--border)',
                  }}
                >
                  {companyInfo.hero_image_url ? (
                    <>
                      <img
                        src={companyInfo.hero_image_url}
                        alt="Hero Banner"
                        className="w-full h-full object-cover"
                      />
                      <button
                        onClick={() => handleRemoveImage('hero_image_url')}
                        className="btn btn-sm btn-danger absolute"
                        style={{top: 8, right: 8, minHeight: 32, opacity: 0.9}}
                      >
                        <Trash2 size={13} /> Remove
                      </button>
                    </>
                  ) : (
                    <div className="text-center text-tertiary">
                      <ImageIcon size={32} style={{ marginBottom: 8, opacity: 0.4 }} />
                      <div style={{ fontSize: '0.875rem' }}>No image uploaded</div>
                    </div>
                  )}
                </div>

                {/* Upload Button */}
                <div className="flex items-center gap-12">
                  <label
                    className="btn btn-outline btn-sm"
                    style={{ cursor: uploadingField === 'hero_image_url' ? 'not-allowed' : 'pointer' }}
                  >
                    {uploadingField === 'hero_image_url' ? (
                      <><Loader size={13} className="animate-spin" /> Uploading...</>
                    ) : (
                      <><Upload size={13} /> {companyInfo.hero_image_url ? 'Replace Image' : 'Upload Image'}</>
                    )}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      style={{ display: 'none' }}
                      disabled={!!uploadingField}
                      onChange={e => handleImageUpload(e, 'hero_image_url')}
                    />
                  </label>
                  <span className="form-helper m-0">
                    Recommended: 1920×600px · JPG, PNG, WebP · Max 10MB
                  </span>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <h3>Banner Text & Call-to-Action</h3>
              </div>
              <div className="card-body">
                <div className="form-group">
                  <label className="form-label" htmlFor="company-hero-title">Headline</label>
                  <input id="company-hero-title" className="form-input" value={companyInfo.hero_title || ''} onChange={e => handleInfoChange('hero_title', e.target.value)} placeholder="e.g. Connecting Bohol and Manila" />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="company-hero-description">Subheadline</label>
                  <textarea id="company-hero-description" className="form-textarea" rows={3} value={companyInfo.hero_description || ''} onChange={e => handleInfoChange('hero_description', e.target.value)} placeholder="Subtitle text displayed below the headline..." />
                </div>
                <div className="grid grid-2" style={{ gap: 16 }}>
                  <div className="form-group mb-0">
                    <label className="form-label" htmlFor="company-hero-button-text">Button Label <span className="text-tertiary" style={{fontWeight: 400}}>(optional)</span></label>
                    <input id="company-hero-button-text" className="form-input" value={companyInfo.hero_button_text || ''} onChange={e => handleInfoChange('hero_button_text', e.target.value)} placeholder="e.g. Book a Shipment" />
                  </div>
                  <div className="form-group mb-0">
                    <label className="form-label" htmlFor="company-hero-button-link">Button Link <span className="text-tertiary" style={{fontWeight: 400}}>(optional)</span></label>
                    <input id="company-hero-button-link" className="form-input" value={companyInfo.hero_button_link || ''} onChange={e => handleInfoChange('hero_button_link', e.target.value)} placeholder="e.g. /login or /customer/book" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ─── CONTACT INFO ─────────────────────────────────────────── */}
        {activeTab === 'contact' && (
          <div className="flex flex-col gap-16">
            <div className="card">
              <div className="card-header">
                <h3><Phone size={16} className="inline mr-8" />Phone Numbers</h3>
              </div>
              <div className="card-body">
                <div className="grid grid-2" style={{ gap: 16 }}>
                  <div className="form-group mb-0">
                    <label className="form-label" htmlFor="company-smart-phone">Smart / TNT Number</label>
                    <input id="company-smart-phone" className="form-input" value={companyInfo.smart_phone || ''} onChange={e => handleInfoChange('smart_phone', e.target.value)} placeholder="09XX-XXX-XXXX" />
                  </div>
                  <div className="form-group mb-0">
                    <label className="form-label" htmlFor="company-globe-phone">Globe / TM Number</label>
                    <input id="company-globe-phone" className="form-input" value={companyInfo.globe_phone || ''} onChange={e => handleInfoChange('globe_phone', e.target.value)} placeholder="09XX-XXX-XXXX" />
                  </div>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <h3>Online Presence</h3>
              </div>
              <div className="card-body">
                <div className="grid grid-2" style={{ gap: 16 }}>
                  <div className="form-group">
                    <label className="form-label" htmlFor="company-email">Email Address</label>
                    <input id="company-email" className={`form-input ${invalidClass('email', errors)}`} type="email" value={companyInfo.email || ''} onChange={e => handleInfoChange('email', e.target.value)} placeholder="info@cargoexpress.ph" {...fieldAttrs('email', errors)} />
                    <FieldError name="email" errors={errors} />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="company-facebook">Facebook Page URL</label>
                    <input id="company-facebook" className={`form-input ${invalidClass('facebook', errors)}`} type="url" value={companyInfo.facebook || ''} onChange={e => handleInfoChange('facebook', e.target.value)} placeholder="https://facebook.com/..." {...fieldAttrs('facebook', errors)} />
                    <FieldError name="facebook" errors={errors} />
                  </div>
                  <div className="form-group mb-0">
                    <label className="form-label" htmlFor="company-messenger">Messenger Link</label>
                    <input id="company-messenger" className={`form-input ${invalidClass('messenger', errors)}`} type="url" value={companyInfo.messenger || ''} onChange={e => handleInfoChange('messenger', e.target.value)} placeholder="https://m.me/..." {...fieldAttrs('messenger', errors)} />
                    <FieldError name="messenger" errors={errors} />
                  </div>
                  <div className="form-group mb-0">
                    {/* NOTE: this edits the same companyInfo.website field as the
                        "Website URL" input in the Business Details card above.
                        Distinct id so the labels stay unambiguous. */}
                    <label className="form-label" htmlFor="company-website-online">Website</label>
                    <input id="company-website-online" className={`form-input ${invalidClass('website', errors)}`} type="url" value={companyInfo.website || ''} onChange={e => handleInfoChange('website', e.target.value)} placeholder="https://..." {...fieldAttrs('website', errors)} />
                    <FieldError name="website" errors={errors} />
                  </div>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <h3><MapPin size={16} className="inline mr-8" />Hub Addresses</h3>
              </div>
              <div className="card-body">
                <div className="grid grid-2" style={{ gap: 16 }}>
                  <div className="form-group mb-0">
                    <label className="form-label" htmlFor="company-manila-address">Manila Hub Address</label>
                    <textarea id="company-manila-address" className="form-textarea" rows={3} value={companyInfo.manila_address || ''} onChange={e => handleInfoChange('manila_address', e.target.value)} placeholder="Full address of Manila hub..." />
                  </div>
                  <div className="form-group mb-0">
                    <label className="form-label" htmlFor="company-bohol-address">Bohol Hub Address</label>
                    <textarea id="company-bohol-address" className="form-textarea" rows={3} value={companyInfo.bohol_address || ''} onChange={e => handleInfoChange('bohol_address', e.target.value)} placeholder="Full address of Bohol hub..." />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ─── PRICING ────────────────────────────────────────────── */}
        {activeTab === 'pricing' && (
          <div className="card">
            <div className="card-header">
              <h3><PhilippinePeso size={16} className="inline mr-8" />Pricing Settings</h3>
            </div>
            <div className="card-body">
              <div className="form-group">
                <label className="form-label" htmlFor="settings-price-per-kilo">Default Price per Kilogram (₱)</label>
                <div className="form-input-wrapper" style={{ maxWidth: 220 }}>
                  <PhilippinePeso size={15} className="form-input-icon" />
                  <input
                    id="settings-price-per-kilo"
                    type="number"
                    className={`form-input form-input-icon-left ${invalidClass('default_price_per_kg', errors)}`}
                    value={companyInfo.default_price_per_kg || ''}
                    onChange={e => handleInfoChange('default_price_per_kg', parseFloat(e.target.value) || 0)}
                    min="0"
                    step="0.01"
                    placeholder="70.00"
                    {...fieldAttrs('default_price_per_kg', errors, 'settings-price-helper')}
                  />
                </div>
                <FieldError name="default_price_per_kg" errors={errors} />
                <p className="form-helper mt-6" id="settings-price-helper">
                  Used to calculate shipping costs for all orders by default.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ─── DELEGATED TABS ──────────────────────────────────────── */}
        {activeTab === 'features' && (
          <CompanyInfoFeaturesTab features={features} setFeatures={setFeatures} />
        )}
        {activeTab === 'coverage' && (
          <CompanyInfoCoverageTab coverageAreas={coverageAreas} setCoverageAreas={setCoverageAreas} />
        )}
      </div>

      {/* Confirm Modal for image removal */}
      <ConfirmModal
        isOpen={confirmModal.open}
        title={confirmModal.title}
        message={confirmModal.message}
        onClose={() => setConfirmModal({ open: false })}
        onConfirm={confirmModal.onConfirm}
        confirmText="Remove"
        variant="danger"
      />
    </div>
  );
};

export default CompanyInformationPage;
