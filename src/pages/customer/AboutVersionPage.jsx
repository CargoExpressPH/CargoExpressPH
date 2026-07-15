import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Bell, Building2, ExternalLink, FileText, Globe,
  Info, Mail, MapPin, MessageCircle, Phone, ShieldCheck, Wifi,
} from 'lucide-react';
import { getCompanyInformation } from '../../lib/database';
import usePageTitle from '../../hooks/usePageTitle';

const APP_VERSION = '1.0.0';

const releaseItems = [
  'Customer booking, tracking, notifications, and support chat.',
  'Order payment history and balance visibility.',
  'Mobile-first customer navigation with protected account access.',
];

const AboutVersionPage = () => {
  usePageTitle('About & Version');
  const navigate = useNavigate();
  const [companyInfo, setCompanyInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isOnline, setIsOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [serviceWorkerReady, setServiceWorkerReady] = useState(false);

  useEffect(() => {
    let isMounted = true;

    getCompanyInformation()
      .then(info => { if (isMounted) setCompanyInfo(info); })
      .catch(() => { if (isMounted) setCompanyInfo(null); })
      .finally(() => { if (isMounted) setLoading(false); });

    const updateOnlineState = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', updateOnlineState);
    window.addEventListener('offline', updateOnlineState);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration()
        .then(registration => setServiceWorkerReady(Boolean(registration?.active || navigator.serviceWorker.controller)))
        .catch(() => setServiceWorkerReady(false));
    }

    return () => {
      isMounted = false;
      window.removeEventListener('online', updateOnlineState);
      window.removeEventListener('offline', updateOnlineState);
    };
  }, []);

  const notificationStatus = useMemo(() => {
    if (typeof Notification === 'undefined') return 'Not supported';
    if (Notification.permission === 'granted') return 'Enabled';
    if (Notification.permission === 'denied') return 'Blocked';
    return 'Not enabled';
  }, []);

  const contacts = [
    { label: 'Smart', value: companyInfo?.smart_phone, icon: Phone, href: companyInfo?.smart_phone ? `tel:${companyInfo.smart_phone}` : '' },
    { label: 'Globe', value: companyInfo?.globe_phone, icon: Phone, href: companyInfo?.globe_phone ? `tel:${companyInfo.globe_phone}` : '' },
    { label: 'Email', value: companyInfo?.email, icon: Mail, href: companyInfo?.email ? `mailto:${companyInfo.email}` : '' },
    { label: 'Facebook', value: companyInfo?.facebook, icon: Globe, href: companyInfo?.facebook || '' },
  ].filter(item => item.value);

  return (
    <div className="page-transition customer-about-version-page">
      <button type="button" onClick={() => navigate(-1)} className="btn btn-ghost customer-back-action mb-16">
        <ArrowLeft size={18} /> Back
      </button>

      <div className="customer-page-heading mb-20">
        <div>
          <h1 className="fw-800 flex items-center gap-8">
            <FileText size={24} aria-hidden="true" /> About & Version
          </h1>
          <p className="text-sm text-secondary mt-4">
            App details, company contact information, and current browser service status.
          </p>
        </div>
      </div>

      <div className="card card-body mb-16">
        <div className="flex items-center gap-12" style={{ flexWrap: 'wrap' }}>
          <div className="profile-menu-icon-wrap success">
            <Info size={18} />
          </div>
          <div className="flex-1">
            <div className="text-xs text-tertiary">CargoExpress PH Customer Portal</div>
            <div className="text-xl fw-800">Version {APP_VERSION}</div>
          </div>
          <span className="badge badge-success">Active</span>
        </div>
      </div>

      <div className="grid grid-3 gap-12 mb-16">
        <div className="card card-body">
          <Wifi size={18} className={isOnline ? 'text-success' : 'text-error'} />
          <div className="text-xs text-tertiary mt-8">Network</div>
          <div className="fw-800">{isOnline ? 'Online' : 'Offline'}</div>
        </div>
        <div className="card card-body">
          <ShieldCheck size={18} className={serviceWorkerReady ? 'text-success' : 'text-tertiary'} />
          <div className="text-xs text-tertiary mt-8">PWA Cache</div>
          <div className="fw-800">{serviceWorkerReady ? 'Ready' : 'Not active'}</div>
        </div>
        <div className="card card-body">
          <Bell size={18} className="text-primary" />
          <div className="text-xs text-tertiary mt-8">Notifications</div>
          <div className="fw-800">{notificationStatus}</div>
        </div>
      </div>

      <h3 className="profile-section-title">Company</h3>
      <div className="card card-body mb-16">
        <div className="flex items-center gap-8 mb-12">
          <Building2 size={18} className="text-primary" />
          <div className="fw-800">{companyInfo?.name || 'CargoExpress PH'}</div>
        </div>
        <p className="text-sm text-secondary m-0">
          {loading
            ? 'Loading company information...'
            : companyInfo?.short_description || companyInfo?.long_description || 'CargoExpress PH connects customers with cargo delivery service between supported routes.'}
        </p>
      </div>

      {(companyInfo?.manila_address || companyInfo?.bohol_address) && (
        <>
          <h3 className="profile-section-title">Hubs</h3>
          <div className="grid grid-2 gap-12 mb-16">
            {companyInfo?.manila_address && (
              <div className="card card-body">
                <div className="fw-800 flex items-center gap-8 mb-8"><MapPin size={16} /> Manila Hub</div>
                <p className="text-sm text-secondary m-0">{companyInfo.manila_address}</p>
              </div>
            )}
            {companyInfo?.bohol_address && (
              <div className="card card-body">
                <div className="fw-800 flex items-center gap-8 mb-8"><MapPin size={16} /> Bohol Hub</div>
                <p className="text-sm text-secondary m-0">{companyInfo.bohol_address}</p>
              </div>
            )}
          </div>
        </>
      )}

      {contacts.length > 0 && (
        <>
          <h3 className="profile-section-title">Contact Channels</h3>
          <div className="card mb-16 profile-menu-card">
            {contacts.map(item => (
              <a
                key={item.label}
                className="profile-menu-item text-no-underline"
                href={item.href}
                target={item.href.startsWith('http') ? '_blank' : undefined}
                rel={item.href.startsWith('http') ? 'noreferrer' : undefined}
              >
                <div className="profile-menu-icon-wrap info">
                  <item.icon size={18} />
                </div>
                <div className="flex-1 text-left">
                  <div className="text-sm font-bold">{item.label}</div>
                  <div className="text-xs text-secondary">{item.value}</div>
                </div>
                <ExternalLink size={16} color="var(--text-tertiary)" />
              </a>
            ))}
          </div>
        </>
      )}

      <h3 className="profile-section-title">Release Notes</h3>
      <div className="card card-body mb-16">
        <div className="flex flex-col gap-8">
          {releaseItems.map(item => (
            <div className="flex gap-8 text-sm text-secondary" key={item}>
              <ShieldCheck size={15} className="text-success" style={{ flexShrink: 0, marginTop: 2 }} />
              <span>{item}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-2 gap-12">
        <button type="button" className="btn btn-primary justify-center" onClick={() => navigate('/customer/support')}>
          <MessageCircle size={16} /> Contact Support
        </button>
        <button type="button" className="btn btn-outline justify-center" onClick={() => navigate('/customer/notifications')}>
          <Bell size={16} /> Notification Center
        </button>
      </div>
    </div>
  );
};

export default AboutVersionPage;
