import { useState, useEffect, useRef, useCallback } from 'react';
import { 
  getCompanyInformation, updateCompanyInformation, 
  getCoverageAreas, saveCoverageRegion, deleteCoverageRegion,
  saveCoverageMunicipality, deleteCoverageMunicipality, uploadPublicAsset
} from '../../lib/database';
import { logCompany } from '../../lib/activityLog';
import { 
  Building2, LayoutTemplate, Phone, Clock, Star, Image as ImageIcon, 
  Map, BarChart3, CalendarDays, Loader, Save, ExternalLink, AlertTriangle,
  Upload, X, Trash2, Plus, Edit2, MapPin, PhilippinePeso
} from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import ConfirmModal from '../../components/ui/ConfirmModal';
import CompanyInfoFeaturesTab from './CompanyInfoFeaturesTab';
import CompanyInfoCoverageTab from './CompanyInfoCoverageTab';
import usePageTitle from '../../hooks/usePageTitle';

const TABS = [
  { id: 'basic',    label: 'Basic Info',      icon: Building2 },
  { id: 'contact',  label: 'Contact Info',    icon: Phone },
  { id: 'hours',    label: 'Business Hours',  icon: Clock },
  { id: 'features', label: 'Why Choose Us',   icon: Star },
  { id: 'coverage', label: 'Coverage Areas',  icon: Map },
  { id: 'stats',    label: 'Statistics',      icon: BarChart3 },
  { id: 'pricing',  label: 'Pricing',         icon: PhilippinePeso },
];

const SIMPLE_TABS = ['basic', 'contact', 'hours', 'stats', 'pricing'];
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const getEmptyCompanyInfo = () => ({
  name: '', short_description: '', long_description: '', story: '',
  core_values: '',
  hero_image_url: '', hero_title: '', hero_description: '', hero_button_text: '', hero_button_link: '',
  email: '', facebook: '', messenger: '', website: '', smart_phone: '', globe_phone: '',
  manila_address: '', bohol_address: '',
  stat_years: 0, stat_deliveries: 0, stat_customers: 0, stat_hubs: 0,
  default_price_per_kg: 0,
  always_open: false,
  business_hours: {
    monday:    { open: '08:00', close: '17:00', closed: false },
    tuesday:   { open: '08:00', close: '17:00', closed: false },
    wednesday: { open: '08:00', close: '17:00', closed: false },
    thursday:  { open: '08:00', close: '17:00', closed: false },
    friday:    { open: '08:00', close: '17:00', closed: false },
    saturday:  { open: '08:00', close: '12:00', closed: false },
    sunday:    { open: '', close: '', closed: true },
  }
});

const CompanyInformationPage = () => {
  usePageTitle('Company Information');
  const toast = useToast();
  const [activeTab, setActiveTab] = useState('basic');
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

  const handleSave = async () => {
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
  };

  const handleHoursChange = (day, field, value) => {
    setCompanyInfo(prev => ({
      ...prev,
      business_hours: {
        ...prev.business_hours,
        [day]: { ...prev.business_hours[day], [field]: value }
      }
    }));
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
      <div className="flex items-center justify-center" style={{ minHeight: 300 }}>
        <Loader size={28} className="animate-spin" style={{ color: 'var(--primary)' }} />
      </div>
    );
  }

  // Guard: if companyInfo failed to load, show empty form state instead of crashing
  if (!companyInfo) {
    return (
      <div className="flex items-center justify-center" style={{ minHeight: 300 }}>
        <div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
          <AlertTriangle size={32} style={{ color: 'var(--warning)', marginBottom: 8 }} />
          <p>Failed to load company information. Please refresh the page.</p>
        </div>
      </div>
    );
  }

  const activeTabObj = TABS.find(t => t.id === activeTab);

  return (
    <div className="page-transition">
      {/* Page Header */}
      <div className="admin-page-header" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="admin-page-title">Company Information</h1>
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
          className="flex items-center justify-between gap-12 animate-fade-in"
          style={{
            background: 'var(--warning-bg)',
            border: '1px solid rgba(245,158,11,0.3)',
            borderRadius: 'var(--radius-md)',
            padding: '10px 16px',
            marginBottom: 16,
          }}
        >
          <div className="flex items-center gap-8" style={{ color: 'var(--warning-dark)', fontSize: '0.875rem', fontWeight: 600 }}>
            <AlertTriangle size={16} />
            You have unsaved changes on this tab.
          </div>
          <button className="btn btn-sm" style={{ background: 'var(--warning)', color: '#fff', minHeight: 32 }} onClick={handleSave} disabled={saving}>
            {saving ? <Loader size={13} className="animate-spin" /> : <Save size={13} />} Save Now
          </button>
        </div>
      )}

      {/* Tab Navigation */}
      <div
        className="card"
        style={{
          padding: '4px 8px',
          marginBottom: 20,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          overflowX: 'auto',
          flexWrap: 'nowrap',
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
                    <input id="company-name" className="form-input" value={companyInfo.name || ''} onChange={e => handleInfoChange('name', e.target.value)} placeholder="e.g. CargoExpress PH" />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="company-website">Website URL</label>
                    <input id="company-website" className="form-input" type="url" value={companyInfo.website || ''} onChange={e => handleInfoChange('website', e.target.value)} placeholder="https://..." />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="company-short-description">Short Description <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>(shown in footer and meta tags)</span></label>
                  <input id="company-short-description" className="form-input" value={companyInfo.short_description || ''} onChange={e => handleInfoChange('short_description', e.target.value)} placeholder="One-line company description..." maxLength={160} />
                  <span className="form-helper">{(companyInfo.short_description || '').length}/160 characters</span>
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label" htmlFor="company-long-description">Company Introduction <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>(About Us page — main body text)</span></label>
                  <textarea id="company-long-description" className="form-textarea" rows={5} value={companyInfo.long_description || ''} onChange={e => handleInfoChange('long_description', e.target.value)} placeholder="Tell your company's story..." style={{ minHeight: 120 }} />
                </div>
              </div>
            </div>




            <div className="card">
              <div className="card-header">
                <h3><LayoutTemplate size={16} className="inline mr-8" />Hero Banner Image</h3>
              </div>
              <div className="card-body">
                {/* Image Preview */}
                <div
                  style={{
                    width: '100%',
                    height: 200,
                    borderRadius: 'var(--radius-md)',
                    overflow: 'hidden',
                    marginBottom: 16,
                    background: companyInfo.hero_image_url ? 'none' : 'var(--bg-secondary)',
                    border: '1.5px dashed var(--border)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    position: 'relative',
                  }}
                >
                  {companyInfo.hero_image_url ? (
                    <>
                      <img
                        src={companyInfo.hero_image_url}
                        alt="Hero Banner"
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                      <button
                        onClick={() => handleRemoveImage('hero_image_url')}
                        className="btn btn-sm btn-danger"
                        style={{ position: 'absolute', top: 8, right: 8, minHeight: 32, opacity: 0.9 }}
                      >
                        <Trash2 size={13} /> Remove
                      </button>
                    </>
                  ) : (
                    <div className="text-center" style={{ color: 'var(--text-tertiary)' }}>
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
                  <span className="form-helper" style={{ margin: 0 }}>
                    Recommended: 1920×600px · JPG, PNG, WebP · Max 10MB
                  </span>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <h3>Hero Text & Call-to-Action</h3>
              </div>
              <div className="card-body">
                <div className="form-group">
                  <label className="form-label">Hero Title</label>
                  <input className="form-input" value={companyInfo.hero_title || ''} onChange={e => handleInfoChange('hero_title', e.target.value)} placeholder="e.g. Connecting Bohol and Manila" />
                </div>
                <div className="form-group">
                  <label className="form-label">Hero Description</label>
                  <textarea className="form-textarea" rows={3} value={companyInfo.hero_description || ''} onChange={e => handleInfoChange('hero_description', e.target.value)} placeholder="Subtitle text displayed below the hero title..." />
                </div>
                <div className="grid grid-2" style={{ gap: 16 }}>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Button Text <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>(optional)</span></label>
                    <input className="form-input" value={companyInfo.hero_button_text || ''} onChange={e => handleInfoChange('hero_button_text', e.target.value)} placeholder="e.g. Book a Shipment" />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Button Link <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>(optional)</span></label>
                    <input className="form-input" value={companyInfo.hero_button_link || ''} onChange={e => handleInfoChange('hero_button_link', e.target.value)} placeholder="e.g. /login or /customer/book" />
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
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Smart / TNT Number</label>
                    <input className="form-input" value={companyInfo.smart_phone || ''} onChange={e => handleInfoChange('smart_phone', e.target.value)} placeholder="09XX-XXX-XXXX" />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Globe / TM Number</label>
                    <input className="form-input" value={companyInfo.globe_phone || ''} onChange={e => handleInfoChange('globe_phone', e.target.value)} placeholder="09XX-XXX-XXXX" />
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
                    <label className="form-label">Email Address</label>
                    <input className="form-input" type="email" value={companyInfo.email || ''} onChange={e => handleInfoChange('email', e.target.value)} placeholder="info@cargoexpress.ph" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Facebook Page URL</label>
                    <input className="form-input" type="url" value={companyInfo.facebook || ''} onChange={e => handleInfoChange('facebook', e.target.value)} placeholder="https://facebook.com/..." />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Messenger Link</label>
                    <input className="form-input" type="url" value={companyInfo.messenger || ''} onChange={e => handleInfoChange('messenger', e.target.value)} placeholder="https://m.me/..." />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Website</label>
                    <input className="form-input" type="url" value={companyInfo.website || ''} onChange={e => handleInfoChange('website', e.target.value)} placeholder="https://..." />
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
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Manila Hub Address</label>
                    <textarea className="form-textarea" rows={3} value={companyInfo.manila_address || ''} onChange={e => handleInfoChange('manila_address', e.target.value)} placeholder="Full address of Manila hub..." />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Bohol Hub Address</label>
                    <textarea className="form-textarea" rows={3} value={companyInfo.bohol_address || ''} onChange={e => handleInfoChange('bohol_address', e.target.value)} placeholder="Full address of Bohol hub..." />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ─── BUSINESS HOURS ──────────────────────────────────────── */}
        {activeTab === 'hours' && (
          <div className="card">
            <div className="card-header">
              <h3><Clock size={16} className="inline mr-8" />Business Hours</h3>
            </div>
            <div className="card-body">
              {/* 24/7 Toggle */}
              <div
                className="flex items-center gap-12"
                style={{
                  padding: '14px 16px',
                  borderRadius: 'var(--radius-md)',
                  background: companyInfo.always_open ? 'var(--success-bg)' : 'var(--bg-secondary)',
                  border: `1px solid ${companyInfo.always_open ? 'rgba(16,185,129,0.3)' : 'var(--border-light)'}`,
                  marginBottom: 20,
                  cursor: 'pointer',
                }}
                onClick={() => handleInfoChange('always_open', !companyInfo.always_open)}
              >
                <div
                  style={{
                    width: 44, height: 24, borderRadius: 12, position: 'relative',
                    background: companyInfo.always_open ? 'var(--success)' : 'var(--border)',
                    transition: 'background 0.2s ease', flexShrink: 0, cursor: 'pointer',
                  }}
                >
                  <div style={{
                    position: 'absolute', top: 3, left: companyInfo.always_open ? 23 : 3,
                    width: 18, height: 18, borderRadius: '50%', background: 'white',
                    transition: 'left 0.2s ease', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }} />
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '0.9375rem', color: companyInfo.always_open ? 'var(--success-dark)' : 'var(--text)' }}>
                    Open 24/7
                  </div>
                  <div className="form-helper" style={{ margin: 0 }}>
                    {companyInfo.always_open ? 'Customers can contact us any time.' : 'Toggle on if you are always available.'}
                  </div>
                </div>
              </div>

              {!companyInfo.always_open && (
                <div className="flex flex-col gap-8">
                  {DAYS.map(day => {
                    const hours = companyInfo.business_hours?.[day] || {};
                    return (
                      <div
                        key={day}
                        className="flex items-center gap-16"
                        style={{
                          padding: '12px 16px',
                          borderRadius: 'var(--radius-sm)',
                          background: hours.closed ? 'var(--bg-secondary)' : 'var(--surface)',
                          border: '1px solid var(--border-light)',
                          opacity: hours.closed ? 0.65 : 1,
                          flexWrap: 'wrap',
                        }}
                      >
                        <div style={{ width: 100, textTransform: 'capitalize', fontWeight: 600, fontSize: '0.875rem' }}>
                          {day}
                        </div>
                        <label className="flex items-center gap-6" style={{ cursor: 'pointer', userSelect: 'none', fontSize: '0.8125rem' }}>
                          <input
                            type="checkbox"
                            checked={hours.closed || false}
                            onChange={e => handleHoursChange(day, 'closed', e.target.checked)}
                            style={{ cursor: 'pointer' }}
                          />
                          Closed
                        </label>
                        {!hours.closed && (
                          <div className="flex items-center gap-8" style={{ marginLeft: 'auto' }}>
                            <input
                              type="time"
                              className="form-input"
                              style={{ width: 120, minHeight: 36, padding: '6px 10px' }}
                              value={hours.open || ''}
                              onChange={e => handleHoursChange(day, 'open', e.target.value)}
                            />
                            <span style={{ color: 'var(--text-tertiary)', fontWeight: 600 }}>to</span>
                            <input
                              type="time"
                              className="form-input"
                              style={{ width: 120, minHeight: 36, padding: '6px 10px' }}
                              value={hours.close || ''}
                              onChange={e => handleHoursChange(day, 'close', e.target.value)}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─── STATISTICS ──────────────────────────────────────────── */}
        {activeTab === 'stats' && (
          <div className="flex flex-col gap-16">
            <div
              style={{
                background: 'var(--info-bg)',
                border: '1px solid rgba(59,130,246,0.2)',
                borderRadius: 'var(--radius-md)',
                padding: '12px 16px',
                fontSize: '0.875rem',
                color: 'var(--info-dark)',
              }}
            >
              These numbers appear on the <strong>About Us</strong> page as animated counters (e.g. "10+ Years in Service").
            </div>

            <div className="grid grid-2" style={{ gap: 16 }}>
              {[
                { field: 'stat_years',      label: 'Years in Service',      icon: CalendarDays, color: 'var(--primary)',  suffix: '+ years' },
                { field: 'stat_deliveries', label: 'Deliveries Completed',  icon: BarChart3,    color: 'var(--success)',  suffix: '+ deliveries' },
                { field: 'stat_customers',  label: 'Customers Served',      icon: Building2,    color: 'var(--info)',     suffix: '+ customers' },
                { field: 'stat_hubs',       label: 'Operating Hubs',        icon: MapPin,       color: 'var(--warning)',  suffix: ' hubs' },
              ].map(({ field, label, icon: Icon, color, suffix }) => (
                <div key={field} className="card card-body">
                  <div className="flex items-center gap-12 mb-12">
                    <div style={{ width: 40, height: 40, borderRadius: 'var(--radius-sm)', background: `${color}20`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Icon size={20} style={{ color }} />
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '0.9375rem' }}>{label}</div>
                      <div style={{ fontSize: '0.8125rem', color: 'var(--text-tertiary)' }}>
                        Shows as: <strong style={{ color }}>{companyInfo[field] || 0}{suffix}</strong>
                      </div>
                    </div>
                  </div>
                  <input
                    type="number"
                    className="form-input"
                    min={0}
                    value={companyInfo[field] || 0}
                    onChange={e => handleInfoChange(field, parseInt(e.target.value) || 0)}
                  />
                </div>
              ))}
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
                    className="form-input form-input-icon-left"
                    value={companyInfo.default_price_per_kg || ''}
                    onChange={e => handleInfoChange('default_price_per_kg', parseFloat(e.target.value) || 0)}
                    min="0"
                    step="0.01"
                    placeholder="70.00"
                  />
                </div>
                <p className="form-helper mt-6">
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
