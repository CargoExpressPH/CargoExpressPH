import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import { useToast } from '../../hooks/useToast';
import { usePushNotification } from '../../hooks/usePushNotification';
import { Bell, Mail, LogOut, Shield, ChevronRight, Lock, Sun, Moon } from 'lucide-react';
import ConfirmModal from '../../components/ui/ConfirmModal';
import BreakableEmail from '../../components/ui/BreakableEmail';
import usePageTitle from '../../hooks/usePageTitle';

const getPushStatusLabel = ({
  pushSupported,
  permissionState,
  isSubscribed,
  isIosDevice,
  isIosInstalled,
  iosPushSupported,
}) => {
  if (isIosDevice && !isIosInstalled) {
    return iosPushSupported
      ? 'Add to Home Screen to enable push'
      : 'Requires iOS 16.4 or later, then Add to Home Screen';
  }
  if (!pushSupported) return 'Not supported on this browser';
  if (permissionState === 'denied') return 'Blocked in browser or device settings';
  if (isSubscribed) return 'Enabled on this device';
  return 'Disabled on this device';
};

/**
 * Laid out like the customer Profile (customer-profile.css): identity card
 * beside grouped settings from 960px, one column below. The email is shown
 * once, in the identity card — the Change Email row describes the action
 * instead of repeating the address, which also kept a long address from
 * pushing the row's chevron off a 320px screen.
 */
const AdminProfilePage = () => {
  usePageTitle('Profile');
  const { user, userProfile, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const toast = useToast();
  const handleLogout = async () => { setShowLogoutConfirm(false); await logout(); navigate('/login'); };
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  const {
    permissionState,
    isSubscribed,
    isIosDevice,
    isIosInstalled,
    iosPushSupported,
    enablePush,
    disablePush,
  } = usePushNotification(user?.id);

  const pushSupported = typeof window !== 'undefined' && 'Notification' in window;
  const canTogglePush =
    pushSupported &&
    permissionState !== 'denied' &&
    (!isIosDevice || (isIosInstalled && iosPushSupported));
  const pushStatusLabel = getPushStatusLabel({
    pushSupported,
    permissionState,
    isSubscribed,
    isIosDevice,
    isIosInstalled,
    iosPushSupported,
  });

  const handlePushToggle = async (checked) => {
    if (!user || pushBusy) return;
    setPushBusy(true);
    try {
      const result = checked ? await enablePush() : await disablePush();
      if (result?.success) {
        toast.success(checked ? 'Push notifications enabled.' : 'Push notifications disabled.');
        return;
      }

      if (result?.reason === 'denied') {
        toast.error('Notification permission is blocked in this browser.');
      } else if (result?.reason === 'ios_not_installed') {
        toast.error('Add CargoExpress to your Home Screen first to enable push.');
      } else if (result?.reason === 'ios_version') {
        toast.error('Push notifications require iOS 16.4 or later.');
      } else {
        toast.error(`Could not ${checked ? 'enable' : 'disable'} push notifications. Please try again.`);
      }
    } finally {
      setPushBusy(false);
    }
  };

  const name = userProfile?.name || 'Admin';
  const email = userProfile?.email || user?.email;

  return (
    <>
    <div className="page-transition profile-page customer-profile-page admin-profile-page">
      <header className="profile-page-heading">
        <p>Account settings</p>
        <h1>Profile</h1>
        <span>Manage your sign-in details, notifications, and session.</span>
      </header>

      <div className="profile-settings-layout">
        <section className="profile-summary" aria-labelledby="admin-profile-name">
          <div className="profile-summary-identity">
            <div className="profile-summary-avatar" aria-hidden="true">
              {name[0].toUpperCase()}
            </div>
            <div className="profile-summary-details">
              <h2 id="admin-profile-name">{name}</h2>
              <p>{email ? <BreakableEmail value={email} /> : 'No email available'}</p>
            </div>
          </div>
          <span className="profile-ready-badge">
            <Shield size={14} aria-hidden="true" /> Administrator
          </span>
        </section>

        <div className="profile-settings-content">
          <section aria-labelledby="admin-profile-account-heading">
            <h2 className="profile-section-title" id="admin-profile-account-heading">Account & Security</h2>
            <div className="card profile-menu-card">
              <button type="button" onClick={() => navigate('/admin/change-email')} className="profile-menu-item">
                <div className="profile-menu-icon-wrap info">
                  <Mail size={18} />
                </div>
                <div className="flex-1 text-left">
                  <div className="text-sm font-bold">Change Email</div>
                  <div className="text-xs text-secondary">The email you use to sign in</div>
                </div>
                <ChevronRight size={16} color="var(--text-tertiary)" />
              </button>
              <button type="button" onClick={() => navigate('/admin/change-password')} className="profile-menu-item">
                <div className="profile-menu-icon-wrap warning">
                  <Lock size={18} />
                </div>
                <div className="flex-1 text-left">
                  <div className="text-sm font-bold">Change Password</div>
                  <div className="text-xs text-secondary">Keep your account secure</div>
                </div>
                <ChevronRight size={16} color="var(--text-tertiary)" />
              </button>
            </div>
          </section>

          <section aria-labelledby="admin-profile-preferences-heading">
            <h2 className="profile-section-title" id="admin-profile-preferences-heading">Preferences</h2>
            <div className="card profile-menu-card">
              <div className="profile-menu-item no-hover">
                <div className="profile-menu-icon-wrap primary">
                  {theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />}
                </div>
                <div className="flex-1 text-left">
                  <div className="text-sm font-bold">Dark Mode</div>
                  <div className="text-xs text-secondary">Toggle dark and light themes</div>
                </div>
                <label className="profile-setting-switch">
                  <input type="checkbox" checked={theme === 'dark'} onChange={toggleTheme} aria-label="Toggle Dark Mode" />
                  <span className="toggle-slider" />
                </label>
              </div>
              <div className="profile-menu-item no-hover">
                <div className="profile-menu-icon-wrap accent">
                  <Bell size={18} />
                </div>
                <div className="flex-1 text-left">
                  <div className="text-sm font-bold">Push Notifications</div>
                  <div className="text-xs text-secondary">{pushStatusLabel}</div>
                </div>
                <label className={`profile-setting-switch${!canTogglePush || pushBusy ? ' opacity-50' : ''}`}>
                  <input
                    type="checkbox"
                    checked={isSubscribed}
                    disabled={!canTogglePush || pushBusy}
                    onChange={(event) => handlePushToggle(event.target.checked)}
                    aria-label="Toggle administrator push notifications"
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>
          </section>

          <div className="profile-session-actions">
            <button
              type="button"
              className="btn btn-outline profile-signout"
              onClick={() => setShowLogoutConfirm(true)}
            >
              <LogOut size={18} aria-hidden="true" /> Sign Out
            </button>
          </div>
        </div>
      </div>
    </div>

    <ConfirmModal
      isOpen={showLogoutConfirm}
      onClose={() => setShowLogoutConfirm(false)}
      onConfirm={handleLogout}
      title="Sign Out"
      message="You are about to sign out of the administrator portal. You will need to sign back in to manage bookings, track trips, and update company settings."
      confirmLabel="Sign Out"
      variant="danger"
      icon={LogOut}
    />
    </>
  );
};

export default AdminProfilePage;
