import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Bell, ChevronRight, Globe, MessageCircle } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import { useAuth } from '../../contexts/AuthContext';
import { getCurrentPushStatus } from '../../lib/push-notifications';
import { BrandLogo, BrandWordmark } from '../../components/ui/BrandLogo';

const APP_VERSION = '1.0.0';

/**
 * AboutVersionPage — the customer's "About this app" screen.
 *
 * Deliberately a settings screen, not a dashboard: a centred app identity
 * block over one list of things a customer can actually do. Everything here
 * is either the app's identity or a destination.
 *
 * What it does NOT carry, and why:
 *
 *   Hubs, phone numbers, email, Facebook — all of it lives on the public
 *   About page, which is one row away and is the page that is actually
 *   maintained. Two copies of the company's contact details is one copy that
 *   silently goes stale, and this was the copy nobody would remember to
 *   update.
 *
 *   Network online/offline — a browser status readout, not a customer fact.
 *   An offline customer cannot load this page to read that they are offline,
 *   and a customer who is online learns nothing.
 *
 *   Release notes — a hardcoded array with no version behind it. It described
 *   the whole product rather than a release, and it could only ever be as
 *   current as the last person who remembered to edit the constant.
 *
 * Removing the company fetch also removes this page's only network round
 * trip: it now renders instantly from the bundle, with the notification row
 * the single thing that resolves asynchronously.
 */

/**
 * The notification row's right-hand value.
 *
 * Reported as measured, including the states we cannot fix from here: an iOS
 * customer browsing in Safari genuinely cannot receive push until the app is
 * on their Home Screen, and saying "Not enabled" would describe that as a
 * setting they could go and flip.
 */
const NOTIFICATION_HINTS = {
  'Enabled': 'Shipment updates are on',
  'Not enabled': 'Turn on shipment alerts',
  'Blocked': 'Allow in browser settings',
  'Add to Home Screen': 'Install to get alerts',
  'Not supported': 'Unavailable in this browser',
  'Checking...': 'Checking…',
};

const AboutVersionPage = () => {
  usePageTitle('About & Version');
  const navigate = useNavigate();
  const { user } = useAuth();
  const [notificationStatus, setNotificationStatus] = useState('Checking...');

  useEffect(() => {
    let active = true;

    const refreshNotificationStatus = async () => {
      try {
        const status = await getCurrentPushStatus(user?.id);
        if (!active) return;

        if (status.isIosDevice && !status.isIosInstalled) {
          setNotificationStatus(status.iosPushSupported ? 'Add to Home Screen' : 'Not supported');
          return;
        }
        if (!status.supported) {
          setNotificationStatus('Not supported');
          return;
        }
        if (status.permission === 'denied') {
          setNotificationStatus('Blocked');
          return;
        }
        setNotificationStatus(status.subscribed ? 'Enabled' : 'Not enabled');
      } catch {
        if (active) setNotificationStatus('Not enabled');
      }
    };

    // Permission can change in browser settings while this tab sits open, so
    // the status is re-read on every return to the page rather than once.
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshNotificationStatus();
    };

    refreshNotificationStatus();
    window.addEventListener('focus', refreshNotificationStatus);
    window.addEventListener('pageshow', refreshNotificationStatus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      active = false;
      window.removeEventListener('focus', refreshNotificationStatus);
      window.removeEventListener('pageshow', refreshNotificationStatus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [user?.id]);

  return (
    <div className="page-transition customer-about-version-page">
      <button type="button" onClick={() => navigate(-1)} className="btn btn-ghost customer-back-action mb-16">
        <ArrowLeft size={18} /> Back
      </button>

      {/* ── App identity ──────────────────────────────────────────── */}
      <div className="about-app-identity">
        <BrandLogo size={84} decorative className="about-app-mark" />
        <BrandWordmark />
        <p className="about-app-tagline">Customer Portal</p>
        <p className="about-app-version">Version {APP_VERSION}</p>
      </div>

      {/* ── Settings cells ────────────────────────────────────────── */}
      <div className="card profile-menu-card">
        <button type="button" onClick={() => navigate('/about')} className="profile-menu-item">
          <div className="profile-menu-icon-wrap info">
            <Globe size={18} />
          </div>
          <div className="flex-1 text-left">
            <div className="text-sm font-bold">About CargoExpress PH</div>
            <div className="text-xs text-secondary">Our hubs, coverage, and contact details</div>
          </div>
          <ChevronRight size={16} color="var(--text-tertiary)" />
        </button>

        <button type="button" onClick={() => navigate('/customer/support')} className="profile-menu-item">
          <div className="profile-menu-icon-wrap primary">
            <MessageCircle size={18} />
          </div>
          <div className="flex-1 text-left">
            <div className="text-sm font-bold">Contact Support</div>
            <div className="text-xs text-secondary">Chat with our team about a shipment</div>
          </div>
          <ChevronRight size={16} color="var(--text-tertiary)" />
        </button>

        <button type="button" onClick={() => navigate('/customer/notifications')} className="profile-menu-item">
          <div className="profile-menu-icon-wrap warning">
            <Bell size={18} />
          </div>
          <div className="flex-1 text-left">
            <div className="text-sm font-bold">Notifications</div>
            <div className="text-xs text-secondary">{NOTIFICATION_HINTS[notificationStatus] || 'Shipment alerts'}</div>
          </div>
          <span className="about-app-cell-value">{notificationStatus}</span>
          <ChevronRight size={16} color="var(--text-tertiary)" />
        </button>
      </div>

      <p className="about-app-footnote">
        © {new Date().getFullYear()} CargoExpress PH
      </p>
    </div>
  );
};

export default AboutVersionPage;
