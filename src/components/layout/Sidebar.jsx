import { useEffect, useState, useRef, useCallback } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { getAdminInboxUnreadCount, getNewInquiryCount } from '../../lib/database';
import {
  LayoutDashboard, Package, Truck, Users, BarChart3,
  Megaphone, MessageSquare, LogOut, Mail,
  ChevronsLeft, ArrowLeft, ClipboardList, Building, ChevronUp, User, PackagePlus
} from 'lucide-react';
import ConfirmModal from '../ui/ConfirmModal';
import { BrandLogo, BrandWordmark } from '../ui/BrandLogo';

const mainNav = [
  { to: '/admin', icon: LayoutDashboard, label: 'Dashboard', end: true },
  { to: '/admin/orders', icon: Package, label: 'Bookings' },
  { to: '/admin/trips', icon: Truck, label: 'Trips' },
  { to: '/admin/customers', icon: Users, label: 'Customers' },
];

const toolsNav = [
  { to: '/admin/sales', icon: BarChart3, label: 'Sales & Reports', matchPaths: ['/admin/sales', '/admin/reports'] },
  { to: '/admin/announcements', icon: Megaphone, label: 'Announcements' },
  { to: '/admin/inbox', icon: MessageSquare, label: 'Inbox', badgeKey: 'inbox' },
  { to: '/admin/contact-inquiries', icon: Mail, label: 'Inquiries', badgeKey: 'inquiries' },
  { to: '/admin/feedback', icon: MessageSquare, label: 'Customer Feedback' },
  { to: '/admin/activity-logs', icon: ClipboardList, label: 'Activity Logs' },
];

const systemNav = [
  { to: '/admin/company-info', icon: Building, label: 'Company Information' },
];

const Sidebar = ({ isOpen, onClose, isCollapsed, onToggleCollapse }) => {
  const { logout, userProfile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [badges, setBadges] = useState({ inbox: 0, inquiries: 0 });
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef(null);

  useEffect(() => {
    if (userProfile?.role !== 'admin') return;

    let isMounted = true;

    const loadBadges = async () => {
      const [inboxResult, inquiriesResult] = await Promise.allSettled([
        // Only threads in 'waiting' — a customer message the BOT answered is
        // not work owed to an admin, and counting it made this badge report
        // total chat volume instead of the queue depth.
        getAdminInboxUnreadCount(),
        getNewInquiryCount(),
      ]);

      if (!isMounted) return;

      setBadges({
        inbox: inboxResult.status === 'fulfilled' ? inboxResult.value || 0 : 0,
        inquiries: inquiriesResult.status === 'fulfilled' ? inquiriesResult.value || 0 : 0,
      });
    };

    loadBadges();

    let timeoutId;
    const debouncedLoadBadges = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        if (isMounted) loadBadges();
      }, 2000);
    };

    const channel = supabase.channel('admin_sidebar_badges')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'chat_messages',
        filter: 'sender_role=eq.customer',
      }, debouncedLoadBadges)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'contact_inquiries',
        filter: 'status=eq.new',
      }, debouncedLoadBadges)
      // The inbox count now depends on conversation.status, so a thread
      // escalating out of 'bot_active' has to refresh it too. Without this the
      // badge only moved when a message row changed, and an escalation whose
      // messages were all already written would not appear until a reload.
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'conversations',
      }, debouncedLoadBadges)
      .subscribe();

    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
      supabase.removeChannel(channel);
    };
  }, [userProfile?.role]);

  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  const handleLogout = async () => {
    setShowLogoutConfirm(false);
    setProfileMenuOpen(false);
    // The 'Admin Logged Out' entry is written by AuthContext.logout(), which
    // both exits funnel through — logging it here as well double-counted it.
    await new Promise(resolve => setTimeout(resolve, 300));
    await logout();
    navigate('/login');
  };

  // Close profile menu when clicking outside
  const handleProfileMenuClickOutside = useCallback((e) => {
    if (profileMenuRef.current && !profileMenuRef.current.contains(e.target)) {
      setProfileMenuOpen(false);
    }
  }, []);

  useEffect(() => {
    if (profileMenuOpen) {
      document.addEventListener('mousedown', handleProfileMenuClickOutside);
    } else {
      document.removeEventListener('mousedown', handleProfileMenuClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleProfileMenuClickOutside);
  }, [profileMenuOpen, handleProfileMenuClickOutside]);

  const formatBadge = (count) => count > 99 ? '99+' : String(count);

  const renderLinks = (items) =>
    items.map(item => {
      const badgeCount = item.badgeKey ? badges[item.badgeKey] || 0 : 0;
      return (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.end}
        className={({ isActive }) => {
          const isCustomActive = item.matchPaths ? item.matchPaths.includes(location.pathname) : isActive;
          return `sidebar-link ${isCustomActive ? 'active' : ''}`;
        }}
        onClick={onClose}
        data-tooltip={item.label}
        aria-label={`${item.label}${badgeCount > 0 ? `, ${badgeCount} unread items` : ''}`}
      >
        <item.icon size={18} aria-hidden="true" />
        <span className="sidebar-link-label">{item.label}</span>
        {badgeCount > 0 && (
          <span className="sidebar-count-badge" aria-label={`${badgeCount} unread`}>
            {formatBadge(badgeCount)}
          </span>
        )}
      </NavLink>
      );
    });

  return (
    <>
      {isOpen && <div className="sidebar-backdrop" onClick={onClose} aria-hidden="true" />}
      <aside
        id="admin-sidebar"
        className={`sidebar ${isOpen ? 'open' : ''} ${isCollapsed ? 'collapsed' : ''}`}
        aria-label="Admin navigation"
      >
        {/* Collapse toggle (desktop only) */}
        <button
          className="sidebar-collapse-btn"
          type="button"
          onClick={onToggleCollapse}
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <ChevronsLeft size={16} aria-hidden="true" />
        </button>

        <div className="sidebar-brand">
          {/* The mark sits OUTSIDE the wordmark on purpose: `.sidebar.collapsed
              .sidebar-brand .sidebar-brand-wordmark` collapses the heading to
              zero width, and that is exactly what should happen to the words —
              but not to the badge, which is the only brand cue left when the
              rail is collapsed. */}
          <BrandLogo size={36} decorative />
          <p className="sidebar-brand-wordmark"><BrandWordmark /></p>
          <button
            className="sidebar-drawer-close-btn"
            type="button"
            onClick={onClose}
            aria-label="Close admin navigation"
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="Admin navigation">
          <div className="sidebar-section-label">Main</div>
          {renderLinks(mainNav)}

          <div className="sidebar-section-label">Management</div>
          {renderLinks(toolsNav)}

          <div className="sidebar-section-label">System</div>
          {renderLinks(systemNav)}
        </nav>

        <div className="sidebar-footer">
          {/* Profile dropdown trigger */}
          <div className="sidebar-profile-menu" ref={profileMenuRef}>
            <button
              type="button"
              className={`sidebar-profile-btn${profileMenuOpen ? ' active' : ''}`}
              onClick={() => setProfileMenuOpen(prev => !prev)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && profileMenuOpen) {
                  e.preventDefault();
                  setProfileMenuOpen(false);
                } else if ((e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && !profileMenuOpen) {
                  e.preventDefault();
                  setProfileMenuOpen(true);
                }
              }}
              data-tooltip="Account"
              aria-label="Open account menu"
              aria-haspopup="menu"
              aria-expanded={profileMenuOpen}
            >
              <div className="sidebar-user-avatar">
                {(userProfile?.name || 'A')[0].toUpperCase()}
              </div>
              <div className="sidebar-profile-info">
                <div className="sidebar-user-name">{userProfile?.name || 'Admin'}</div>
                <div className="sidebar-user-role">Administrator</div>
              </div>
              <ChevronUp
                size={14}
                className={`sidebar-profile-chevron${profileMenuOpen ? ' rotated' : ''}`}
                aria-hidden="true"
              />
            </button>

            {/* Floating dropdown panel */}
            {profileMenuOpen && (
              <div
                className="sidebar-profile-dropdown"
                role="menu"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setProfileMenuOpen(false);
                  }
                }}
              >
                <div className="sidebar-profile-dropdown-header">
                  <div className="sidebar-profile-dropdown-avatar">
                    {(userProfile?.name || 'A')[0].toUpperCase()}
                  </div>
                  <div>
                    <div className="sidebar-profile-dropdown-name">{userProfile?.name || 'Admin'}</div>
                    <div className="sidebar-profile-dropdown-role">Administrator</div>
                  </div>
                </div>
                <div className="sidebar-profile-dropdown-divider" />
                <button
                  type="button"
                  className="sidebar-profile-dropdown-item"
                  role="menuitem"
                  onClick={() => { setProfileMenuOpen(false); onClose(); navigate('/admin/profile'); }}
                >
                  <User size={15} aria-hidden="true" />
                  Profile
                </button>
                <div className="sidebar-profile-dropdown-divider" />
                <button
                  type="button"
                  className="sidebar-profile-dropdown-item danger"
                  role="menuitem"
                  onClick={() => { setProfileMenuOpen(false); setShowLogoutConfirm(true); }}
                >
                  <LogOut size={15} aria-hidden="true" />
                  Sign Out
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>
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

export default Sidebar;
