import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../hooks/useToast';
import { usePushNotification } from '../../hooks/usePushNotification';
import { Bell, Mail, LogOut, Shield, ChevronRight, KeyRound, User } from 'lucide-react';
import ConfirmModal from '../../components/ui/ConfirmModal';
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

const AdminProfilePage = () => {
  usePageTitle('Profile');
  const { user, userProfile, logout } = useAuth();
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

  return (
    <>
    <div className="page-transition" style={{ maxWidth: 520 }}>
      <h1 className="admin-page-title mb-24"><User size={24} color="var(--primary)" aria-hidden="true" />Profile</h1>

      {/* Profile Card */}
      <div className="profile-card-premium mb-20">
        <div className="profile-card-banner" />
        <div className="profile-card-avatar">
          {(userProfile?.name || 'A')[0].toUpperCase()}
        </div>
        <div className="profile-card-info">
          <div className="profile-card-name">{userProfile?.name || 'Admin'}</div>
          <div className="profile-card-email">{userProfile?.email}</div>
          <span className="profile-card-badge">
            <Shield size={12} /> Administrator
          </span>
        </div>
      </div>

      {/* Menu Items */}
      <div className="card mb-20">
        <button type="button" onClick={() => navigate('/admin/change-email')} className="profile-menu-item">
          <Mail size={18} />
          <div className="flex-1 text-left">
            <div className="font-semibold text-sm">Account Email</div>
            <div className="text-xs text-tertiary">{userProfile?.email || 'No email available'}</div>
          </div>
          <ChevronRight size={16} color="var(--text-tertiary)" />
        </button>
        <button type="button" onClick={() => navigate('/admin/change-password')} className="profile-menu-item">
          <KeyRound size={18} />
          <div className="flex-1 text-left">
            <div className="font-semibold text-sm">Change Password</div>
            <div className="text-xs text-tertiary">Update your account password</div>
          </div>
          <ChevronRight size={16} color="var(--text-tertiary)" />
        </button>
        <div className="profile-menu-item no-hover">
          <Bell size={18} />
          <div className="flex-1 text-left">
            <div className="font-semibold text-sm">Push Notifications</div>
            <div className="text-xs text-tertiary">{pushStatusLabel}</div>
          </div>
          <label className={`toggle-switch${!canTogglePush || pushBusy ? ' opacity-50' : ''}`}>
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

      {/* Sign Out */}
      <button className="btn btn-outline btn-block btn-lg justify-center" onClick={() => setShowLogoutConfirm(true)} style={{ color: 'var(--error-text)', borderColor: 'var(--error-glow)' }}>
        <LogOut size={18} /> Sign Out
      </button>
    </div>

    <ConfirmModal
      isOpen={showLogoutConfirm}
      onClose={() => setShowLogoutConfirm(false)}
      onConfirm={handleLogout}
      title="Sign Out"
      message="You are about to sign out of the administrator portal. You will need to sign back in to manage bookings, track trips, and update company settings."
      confirmLabel="Sign Out"
      variant="primary"
    />
    </>
  );
};

export default AdminProfilePage;
