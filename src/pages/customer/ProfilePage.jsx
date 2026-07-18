import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getOrders } from '../../lib/database';
import { useToast } from '../../hooks/useToast';
import { useTheme } from '../../contexts/ThemeContext';
import { requestNotificationPermission, disableNotificationsForDevice } from '../../lib/firebase-messaging';
import { supabase } from '../../lib/supabase';
import {
  User, LogOut, ChevronRight, Package, Truck, Bell, MessageCircle,
  CreditCard, HelpCircle, FileText, CheckCircle2,
  Sun, Moon, Lock
} from 'lucide-react';
import ConfirmModal from '../../components/ui/ConfirmModal';
import usePageTitle from '../../hooks/usePageTitle';

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

const ProfilePage = () => {
  usePageTitle('Profile');
  const { user, userProfile, logout, refreshProfile } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const toast = useToast();
  const navigate = useNavigate();
  const [orderStats, setOrderStats] = useState({ total: 0, active: 0, delivered: 0 });
  const [loading, setLoading] = useState(true);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [pushToggleKey, setPushToggleKey] = useState(0);

  useEffect(() => {
    if (user) {
      setLoading(true);
      getOrders(user.id, false)
        .then(orders => {
          const data = orders || [];
          setOrderStats({
            total: data.length,
            active: data.filter(o => !['Delivered', 'Cancelled'].includes(o.status)).length,
            delivered: data.filter(o => o.status === 'Delivered').length,
          });
        })
        .catch(() => {
          toast.error('Failed to load profile stats.');
        })
        .finally(() => setLoading(false));
    }
  }, [user]);

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
                  style={isProfileComplete ? undefined : { background: 'var(--warning-bg)', color: 'var(--warning-dark)' }}
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

        {/* Quick Stats */}
        <div className="profile-quick-stats stagger-item" style={{ animationDelay: '60ms' }}>
          <div className="profile-stat-item">
            <div className="flex items-center justify-center mb-8" style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--info-bg)' }}>
              <Package size={18} color="var(--info)" />
            </div>
            <div className="text-xl fw-800 text-accent">{loading ? '—' : orderStats.total}</div>
            <div className="text-xs text-tertiary">Total Orders</div>
          </div>
          <div className="profile-stat-item">
            <div className="flex items-center justify-center mb-8" style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--primary-bg)' }}>
              <Truck size={18} color="var(--primary)" />
            </div>
            <div className="text-xl fw-800 text-accent">{loading ? '—' : orderStats.active}</div>
            <div className="text-xs text-tertiary">Active</div>
          </div>
          <div className="profile-stat-item">
            <div className="flex items-center justify-center mb-8" style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--success-bg)' }}>
              <CheckCircle2 size={18} color="var(--success)" />
            </div>
            <div className="text-xl fw-800 text-accent">{loading ? '—' : orderStats.delivered}</div>
            <div className="text-xs text-tertiary">Delivered</div>
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
          <button type="button" onClick={() => navigate('/reset-password')} className="profile-menu-item">
            <div className="profile-menu-icon-wrap warning">
              <Lock size={18} />
            </div>
            <div className="flex-1 text-left">
              <div className="text-sm font-bold">Change Password</div>
              <div className="text-xs text-secondary">Update and secure your account credentials</div>
            </div>
            <ChevronRight size={16} color="var(--text-tertiary)" />
          </button>
          <button type="button" onClick={() => navigate('/customer/payment-methods')} className="profile-menu-item">
            <div className="profile-menu-icon-wrap success">
              <CreditCard size={18} />
            </div>
            <div className="flex-1 text-left">
              <div className="text-sm font-bold">Payment Methods</div>
              <div className="text-xs text-secondary">Review payment options, balances, and history</div>
            </div>
            <ChevronRight size={16} color="var(--text-tertiary)" />
          </button>
        </div>

        {/* Section 2: Shipping Preferences */}
        <h3 className="profile-section-title">Shipping & Activity</h3>
        <div className="card mb-16 profile-menu-card stagger-item" style={{ animationDelay: '180ms' }}>
          <button type="button" onClick={() => navigate('/customer/orders')} className="profile-menu-item">
            <div className="profile-menu-icon-wrap info">
              <Package size={18} />
            </div>
            <div className="flex-1 text-left">
              <div className="text-sm font-bold">My Bookings</div>
              <div className="text-xs text-secondary">View bookings, tracking, and payment records</div>
            </div>
            <ChevronRight size={16} color="var(--text-tertiary)" />
          </button>
          <button type="button" onClick={() => navigate('/customer/trips')} className="profile-menu-item">
            <div className="profile-menu-icon-wrap warning">
              <Truck size={18} />
            </div>
            <div className="flex-1 text-left">
              <div className="text-sm font-bold">Scheduled Trips</div>
              <div className="text-xs text-secondary">Check upcoming sea trip schedules</div>
            </div>
            <ChevronRight size={16} color="var(--text-tertiary)" />
          </button>
        </div>

        {/* Section 3: App Settings */}
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
          <div className="profile-menu-item no-hover" key={pushToggleKey}>
            <div className="profile-menu-icon-wrap accent">
              <Bell size={18} />
            </div>
            <div className="flex-1 text-left">
              <div className="text-sm font-bold">Push Notifications</div>
              <div className="text-xs text-secondary">
                {typeof window !== 'undefined' && 'Notification' in window
                  ? Notification.permission === 'denied'
                    ? 'Blocked (Enable in device settings)'
                    : Notification.permission === 'granted' && localStorage.getItem('fcm_enabled') === 'true'
                      ? 'Enabled on this device'
                      : 'Disabled (Click to enable)'
                  : 'Not supported on this browser'}
              </div>
            </div>
            {typeof window !== 'undefined' && 'Notification' in window && Notification.permission !== 'denied' ? (
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={Notification.permission === 'granted' && localStorage.getItem('fcm_enabled') === 'true'}
                  onChange={async (e) => {
                    if (e.target.checked) {
                      const token = await requestNotificationPermission(user.id);
                      if (token) {
                        toast.success('Push notifications enabled!');
                      } else {
                        toast.error('Permission denied or FCM failed.');
                      }
                    } else {
                      // Disable: clear the current device token
                      const success = await disableNotificationsForDevice(user.id);
                      if (success) {
                        localStorage.setItem('fcm_enabled', 'false');
                        setPushToggleKey(k => k + 1);
                        toast.success('Push notifications disabled.');
                      } else {
                        toast.error('Failed to disable notifications.');
                      }
                    }
                    await refreshProfile();
                  }}
                  aria-label="Toggle Push Notifications"
                />
                <span className="toggle-slider" />
              </label>
            ) : (
              <label className="toggle-switch disabled opacity-50">
                <input type="checkbox" checked={false} disabled aria-label="Toggle Push Notifications" />
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

        {/* Section 4: Help & Support */}
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
              <div className="text-xs text-secondary">CargoExpress PH v1.0.0</div>
            </div>
            <ChevronRight size={16} color="var(--text-tertiary)" />
          </button>
        </div>

        {/* Sign Out */}
        <button
          type="button"
          className="btn btn-outline w-full stagger-item justify-center profile-signout"
          onClick={() => setShowLogoutConfirm(true)}
          style={{ color: 'var(--error)', borderColor: 'var(--error-glow)', animationDelay: '360ms' }}
        >
          <LogOut size={18} /> Sign Out
        </button>
      </div>

      <ConfirmModal
        isOpen={showLogoutConfirm}
        onClose={() => setShowLogoutConfirm(false)}
        onConfirm={handleLogout}
        title="Sign Out"
        message="Are you sure you want to sign out?"
        confirmLabel="Sign Out"
        variant="warning"
      />
    </>
  );
};

export default ProfilePage;
