import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Mail, LogOut, Shield } from 'lucide-react';
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
      <h1 className="fw-800 text-2xl mb-24">Profile</h1>

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
        <div className="profile-menu-item">
          <Mail size={18} />
          <div className="flex-1">
            <div className="font-semibold text-sm">Account Email</div>
            <div className="text-xs text-tertiary">{userProfile?.email || 'No email available'}</div>
          </div>
        </div>
      </div>

      {/* Sign Out */}
      <button className="btn btn-outline btn-block btn-lg justify-center" onClick={() => setShowLogoutConfirm(true)} style={{ color: 'var(--error)', borderColor: 'var(--error-glow)' }}>
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

export default AdminProfilePage;
