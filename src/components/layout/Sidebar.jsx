import { useEffect, useState, useRef, useCallback } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import {
  LayoutDashboard, Package, Truck, Users, BarChart3,
  Megaphone, MessageSquare, LogOut, Container, FileText, Mail,
  ChevronsLeft, ArrowLeft, ClipboardList, Building, ChevronUp
} from 'lucide-react';
import ConfirmModal from '../ui/ConfirmModal';
import { logAuth } from '../../lib/activityLog';

const mainNav = [
  { to: '/admin', icon: LayoutDashboard, label: 'Dashboard', end: true },
  { to: '/admin/orders', icon: Package, label: 'Bookings' },
  { to: '/admin/trips', icon: Truck, label: 'Trips' },
  { to: '/admin/customers', icon: Users, label: 'Customers' },
];

const toolsNav = [
  { to: '/admin/sales', icon: BarChart3, label: 'Sales' },
  { to: '/admin/reports', icon: FileText, label: 'Reports' },
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
  const [badges, setBadges] = useState({ inbox: 0, inquiries: 0 });
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef(null);

  useEffect(() => {
    if (userProfile?.role !== 'admin') return;

    let isMounted = true;

    const loadBadges = async () => {
      const [inboxResult, inquiriesResult] = await Promise.allSettled([
        supabase
          .from('chat_messages')
          .select('id', { count: 'exact', head: true })
          .eq('sender_role', 'customer')
          .eq('is_read', false),
        supabase
          .from('contact_inquiries')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'new'),
      ]);

      if (!isMounted) return;

      setBadges({
        inbox: inboxResult.status === 'fulfilled' ? inboxResult.value.count || 0 : 0,
        inquiries: inquiriesResult.status === 'fulfilled' ? inquiriesResult.value.count || 0 : 0,
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
    logAuth('Admin Logged Out', { details: 'Admin session ended' });
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
        className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
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
          <Container size={28} color="var(--primary)" aria-hidden="true" />
          <h1>CARGO<span>EXPRESS</span></h1>
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
              data-tooltip="Account"
              aria-label="Open account menu"
              aria-haspopup="true"
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
              <div className="sidebar-profile-dropdown" role="menu">
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
