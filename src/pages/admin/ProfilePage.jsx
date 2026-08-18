import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Mail, LogOut, Shield, ChevronRight, KeyRound, User } from 'lucide-react';
import ConfirmModal from '../../components/ui/ConfirmModal';
import usePageTitle from '../../hooks/usePageTitle';

const AdminProfilePage = () => {
  usePageTitle('Profile');
  const { userProfile, logout } = useAuth();
  const navigate = useNavigate();
  const handleLogout = async () => { setShowLogoutConfirm(false); await logout(); navigate('/login'); };
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

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
