import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../hooks/useToast';
import { useTheme } from '../../contexts/ThemeContext';
import { usePushNotification } from '../../hooks/usePushNotification';
import {
  User, LogOut, ChevronRight, Bell, MessageCircle,
  CreditCard, HelpCircle, FileText, CheckCircle2,
  Sun, Moon, Lock, Mail
} from 'lucide-react';
import ConfirmModal from '../../components/ui/ConfirmModal';
import usePageTitle from '../../hooks/usePageTitle';
import { useCustomerChatUnread } from '../../hooks/useCustomerChatUnread';

const PROFILE_COMPLETION_FIELDS = [
  'name',
  'facebook_name',
  'phone',
  'address_province',
  'address_city',
  'address_barangay',
  'address_street',
  'address_lot_block',
  'address_landmark',
];

function getPushStatusLabel({
  pushSupported,
  permissionState,
  isSubscribed,
  isIosDevice,
  isIosInstalled,
  iosPushSupported,
}) {
  // iOS is checked FIRST, before the generic capability test. Safari does not
  // expose window.Notification at all in a browser tab — the API appears only
  // once the PWA is installed to the Home Screen. So `pushSupported` is false
  // on every iPhone in Safari, and testing it first told the user their browser
  // could not do this, when in fact one action away it can. The dead end was
  // being shown to precisely the users who had the shortest path to success.
  if (isIosDevice && !isIosInstalled) {
    return iosPushSupported
      ? 'Add to Home Screen to enable push'
      : 'Requires iOS 16.4 or later, then Add to Home Screen';
  }
  if (!pushSupported) return 'Not supported on this browser';
  if (permissionState === 'denied') return 'Blocked (Enable in device settings)';
  if (isSubscribed) return 'Enabled on this device';
  return 'Disabled (Click to enable)';
}

const ProfilePage = () => {
  usePageTitle('Profile');
  const { user, userProfile, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const toast = useToast();
  const navigate = useNavigate();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const chatUnread = useCustomerChatUnread(user?.id);

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
    !(isIosDevice && !isIosInstalled);
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
      if (checked) {
        const result = await enablePush();
        if (result.success) {
          toast.success('Push notifications enabled!');
          return;
        }
        if (result.reason === 'denied') {
          toast.error('Permission denied. Enable notifications in device settings.');
        } else if (result.reason === 'ios_not_installed') {
          toast.error('Add Cargo Express to your Home Screen first to enable push.');
        } else if (result.reason === 'ios_version') {
          toast.error('Push requires iOS 16.4 or later.');
        } else {
          toast.error('Could not enable push notifications. Please try again.');
        }
        return;
      }

      const result = await disablePush();
      if (result?.success) {
        toast.success('Push notifications disabled.');
      } else {
        toast.error('Failed to disable notifications.');
      }
    } finally {
      setPushBusy(false);
    }
  };

  const handleLogout = async () => {
    setShowLogoutConfirm(false);
    await logout();
    navigate('/login');
  };

  const completedProfileFields = PROFILE_COMPLETION_FIELDS.filter(
    field => String(userProfile?.[field] || '').trim()
  ).length;
  const completionScore = Math.round(
    (completedProfileFields / PROFILE_COMPLETION_FIELDS.length) * 100
  );
  const isProfileComplete = completedProfileFields === PROFILE_COMPLETION_FIELDS.length;
  return (
    <>
      <div className="page-transition profile-page">
        <h1 className="sr-only">My Profile</h1>
        {/* Profile Card */}
        <div className="profile-card-premium animate-slide-up">
          <div className="profile-card-banner" />
          <div className="profile-card-body-content">
            <div className="profile-avatar-container">
              <div className="profile-card-avatar-circle">
                {(userProfile?.name || 'U')[0].toUpperCase()}
              </div>
            </div>

            <div className="profile-card-info-header">
              <div className="flex items-center gap-8" style={{ flexWrap: 'wrap' }}>
                <h2 className="profile-user-name">{userProfile?.name || 'User'}</h2>
                <span
                  className={`profile-tier-badge${isProfileComplete ? '' : ' incomplete'}`}
                  style={isProfileComplete ? undefined : { background: 'var(--warning-bg)', color: 'var(--warning-text)' }}
                >
                  <CheckCircle2 size={11} style={{ marginRight: 2 }} /> {isProfileComplete ? 'Profile complete' : 'Action needed'}
                </span>
              </div>
              <p className="profile-user-email">{userProfile?.email || user?.email}</p>
            </div>

            {/* Profile Completion Meter */}
            <div className="profile-completion-container">
              <div className="profile-completion-header">
                <span>Profile Completion</span>
                <strong>{completionScore}%</strong>
              </div>
              <div className="profile-completion-bar">
                <div className="profile-completion-fill" style={{ width: `${completionScore}%` }} />
              </div>
              {!isProfileComplete ? (
                <button
                  type="button"
                  onClick={() => navigate('/customer/personal-info')}
                  className="profile-completion-action"
                >
                  Complete your personal information for faster booking
                </button>
              ) : (
                <span className="text-xs font-semibold text-primary" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <CheckCircle2 size={12} /> Your details are ready for faster booking.
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Section 1: Account Settings */}
        <h3 className="profile-section-title">Account & Security</h3>
        <div className="card mb-16 profile-menu-card stagger-item" style={{ animationDelay: '120ms' }}>
          <button type="button" onClick={() => navigate('/customer/personal-info')} className="profile-menu-item">
            <div className="profile-menu-icon-wrap primary">
              <User size={18} />
            </div>
            <div className="flex-1 text-left">
              <div className="text-sm font-bold">Personal Info & Addresses</div>
              <div className="text-xs text-secondary">Edit your name, contact details, and default address</div>
            </div>
            <ChevronRight size={16} color="var(--text-tertiary)" />
          </button>
          <button type="button" onClick={() => navigate('/customer/change-password')} className="profile-menu-item">
            <div className="profile-menu-icon-wrap warning">
              <Lock size={18} />
            </div>
            <div className="flex-1 text-left">
              <div className="text-sm font-bold">Change Password</div>
              <div className="text-xs text-secondary">Update and secure your account credentials</div>
            </div>
            <ChevronRight size={16} color="var(--text-tertiary)" />
          </button>
          <button type="button" onClick={() => navigate('/customer/change-email')} className="profile-menu-item">
            <div className="profile-menu-icon-wrap info">
              <Mail size={18} />
            </div>
            <div className="flex-1 text-left">
              <div className="text-sm font-bold">Change Email</div>
              <div className="text-xs text-secondary">Update the email address you sign in with</div>
            </div>
            <ChevronRight size={16} color="var(--text-tertiary)" />
          </button>
          <button type="button" onClick={() => navigate('/customer/payments')} className="profile-menu-item">
            <div className="profile-menu-icon-wrap success">
              <CreditCard size={18} />
            </div>
            <div className="flex-1 text-left">
              <div className="text-sm font-bold">Payment History</div>
              <div className="text-xs text-secondary">Your payments, open balances, and receipts</div>
            </div>
            <ChevronRight size={16} color="var(--text-tertiary)" />
          </button>
        </div>

        {/* Section 2: App Settings */}
        <h3 className="profile-section-title">Preferences</h3>
        <div className="card mb-16 profile-menu-card stagger-item" style={{ animationDelay: '240ms' }}>
          <div className="profile-menu-item no-hover">
            <div className="profile-menu-icon-wrap primary">
              {theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />}
            </div>
            <div className="flex-1 text-left">
              <div className="text-sm font-bold">Dark Mode</div>
              <div className="text-xs text-secondary">Toggle dark and light themes</div>
            </div>
            <label className="toggle-switch">
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
            {canTogglePush ? (
              <label className={`toggle-switch${pushBusy ? ' opacity-50' : ''}`}>
                <input
                  type="checkbox"
                  checked={isSubscribed}
                  disabled={pushBusy}
                  onChange={(e) => handlePushToggle(e.target.checked)}
                  aria-label="Toggle Push Notifications"
                />
                <span className="toggle-slider" />
              </label>
            ) : (
              <label className="toggle-switch disabled opacity-50">
                <input
                  type="checkbox"
                  checked={false}
                  disabled
                  aria-label="Toggle Push Notifications"
                />
                <span className="toggle-slider" />
              </label>
            )}
          </div>
          <button type="button" onClick={() => navigate('/customer/notifications')} className="profile-menu-item">
            <div className="profile-menu-icon-wrap info">
              <Bell size={18} />
            </div>
            <div className="flex-1 text-left">
              <div className="text-sm font-bold">In-App Notification History</div>
              <div className="text-xs text-secondary">Read order alerts and service updates</div>
            </div>
            <ChevronRight size={16} color="var(--text-tertiary)" />
          </button>
        </div>

        {/* Section 3: Help & Support */}
        <h3 className="profile-section-title">Help & Support</h3>
        <div className="card mb-16 profile-menu-card stagger-item" style={{ animationDelay: '300ms' }}>
          <button type="button" onClick={() => navigate('/customer/support')} className="profile-menu-item">
            <div className="profile-menu-icon-wrap info">
              <MessageCircle size={18} />
            </div>
            <div className="flex-1 text-left">
              <div className="text-sm font-bold">Live Support Chat</div>
              <div className="text-xs text-secondary">Chat directly with cargo handlers</div>
            </div>
            {chatUnread > 0 && (
              <span className="profile-unread-badge" aria-label={`${chatUnread} unread messages`}>
                {chatUnread > 99 ? '99+' : chatUnread}
              </span>
            )}
            <ChevronRight size={16} color="var(--text-tertiary)" />
          </button>
          <button type="button" onClick={() => navigate('/customer/help-guidelines')} className="profile-menu-item">
            <div className="profile-menu-icon-wrap warning">
              <HelpCircle size={18} />
            </div>
            <div className="flex-1 text-left">
              <div className="text-sm font-bold">Help & Guidelines</div>
              <div className="text-xs text-secondary">Read shipping rules and cargo guidelines</div>
            </div>
            <ChevronRight size={16} color="var(--text-tertiary)" />
          </button>
          <button type="button" onClick={() => navigate('/customer/about-version')} className="profile-menu-item">
            <div className="profile-menu-icon-wrap success">
              <FileText size={18} />
            </div>
            <div className="flex-1 text-left">
              <div className="text-sm font-bold">About & Version</div>
              <div className="text-xs text-secondary">Cargo Express PH v1.0.0</div>
            </div>
            <ChevronRight size={16} color="var(--text-tertiary)" />
          </button>
        </div>

        {/* Sign Out */}
        <button
          type="button"
          className="btn btn-outline w-full stagger-item justify-center profile-signout"
          onClick={() => setShowLogoutConfirm(true)}
          style={{ color: 'var(--error-text)', borderColor: 'var(--error-glow)', animationDelay: '360ms' }}
        >
          <LogOut size={18} /> Sign Out
        </button>
      </div>

      <ConfirmModal
        isOpen={showLogoutConfirm}
        onClose={() => setShowLogoutConfirm(false)}
        onConfirm={handleLogout}
        title="Sign Out"
        message="You are about to sign out of your account. You can sign back in at any time to access your active bookings and shipment tracking."
        confirmLabel="Sign Out"
        variant="primary"
      />
    </>
  );
};

export default ProfilePage;
