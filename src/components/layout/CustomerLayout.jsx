import { useState, useRef, useEffect } from 'react';
import { Outlet, NavLink, useNavigate, Link, useLocation } from 'react-router-dom';
import { Bell, User, Container, LogOut, MessageSquare, Package, MapPin, Plus, Home, ChevronRight, Settings } from 'lucide-react';
import ThemeToggle from '../ui/ThemeToggle';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { getUnreadNotificationCount } from '../../lib/database';
import { requestNotificationPermission, refreshFCMTokenIfNeeded } from '../../lib/firebase-messaging';
import { useToast } from '../../hooks/useToast';
import ErrorBoundary from '../ui/ErrorBoundary';
import ConfirmModal from '../ui/ConfirmModal';
import OnboardingModal from '../ui/OnboardingModal';
import PageTransition from '../ui/PageTransition';

const desktopNavItems = [
  { to: '/customer/book', icon: Plus, label: 'Place Order' },
  { to: '/customer/orders', icon: Package, label: 'Orders' },
  { to: '/customer/trips', icon: MapPin, label: 'Trips' },
  { to: '/customer/support', icon: MessageSquare, label: 'Chat Support' },
];

const bottomNavItems = [
  { to: '/customer', icon: Home, label: 'Home', end: true },
  { to: '/customer/orders', icon: Package, label: 'Orders' },
  { to: '/customer/book', icon: Plus, label: 'Book', isBookTab: true },
  { to: '/customer/trips', icon: MapPin, label: 'Trips' },
  { to: '/customer/profile', icon: User, label: 'Profile' },
];

const getInitials = (name) => {
  if (!name || !name.trim()) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

const getDisplayName = (profile, userEmail) => {
  if (profile?.name && profile.name.trim()) return profile.name;
  if (userEmail) return userEmail.split('@')[0];
  return 'Account';
};

const CustomerLayout = () => {
  const { user, userProfile, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const toast = useToast();

  // ── Fetch unread count + listen for new notifications in real-time ────────
  useEffect(() => {
    if (!user) return;

    // Initial count
    getUnreadNotificationCount(user.id)
      .then(count => setUnreadCount(count))
      .catch(() => {});

    // Real-time listener for new notifications
    const channel = supabase.channel(`notif_badge_${user.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${user.id}`,
      }, () => {
        setUnreadCount(prev => prev + 1);
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${user.id}`,
      }, (payload) => {
        // When a notification is marked as read, decrement
        if (payload.new.is_read && !payload.old.is_read) {
          setUnreadCount(prev => Math.max(0, prev - 1));
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user]);

  // Reset badge when user visits the notifications page
  useEffect(() => {
    if (location.pathname === '/customer/notifications') {
      // Re-fetch actual count (in case some were already read)
      if (user) {
        getUnreadNotificationCount(user.id)
          .then(count => setUnreadCount(count))
          .catch(() => {});
      }
    }
  }, [location.pathname, user]);

  // ── Push Notification: FCM token registration & refresh ──────────────
  useEffect(() => {
    if (!user) return;

    if (sessionStorage.getItem('fcm_asked')) {
      // Already asked this session — just refresh the token if stale
      refreshFCMTokenIfNeeded(user.id);
      return;
    }

    // Delay the browser permission prompt so it doesn't block initial render
    const timer = setTimeout(() => {
      requestNotificationPermission(user.id).finally(() => {
        sessionStorage.setItem('fcm_asked', '1');
      });
    }, 3000);

    return () => clearTimeout(timer);
  }, [user]);

  // ── Foreground push: show in-app toast instead of system notification ─
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const handler = (event) => {
      if (event.data?.type === 'PUSH_NOTIFICATION') {
        toast.info(event.data.body || event.data.title);
      }
    };

    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, [toast]);



  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  const handleLogout = async () => {
    setShowLogoutConfirm(false);
    setDropdownOpen(false);
    await logout();
    navigate('/login');
  };

  return (
    <>
    <OnboardingModal />
    <div className="customer-layout-v2">
      <a href="#customer-main-content" className="skip-link">Skip to main content</a>
      {/* ─── Top Navigation Bar ─── */}
      <header className="customer-navbar">
        <div className="customer-navbar-inner">
          {/* Left: Logo */}
          <Link to="/customer" className="customer-navbar-logo">
            <Container size={24} color="var(--primary)" />
            <span className="customer-navbar-brand">
              <span className="text-accent">CARGO</span>
              <span className="text-primary">EXPRESS</span>
            </span>
          </Link>

          {/* Center: Desktop Nav Links */}
          <nav className="customer-navbar-links">
            {desktopNavItems.map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `customer-nav-link ${isActive ? 'active' : ''}`
                }
              >
                <item.icon size={16} />
                {item.label}
              </NavLink>
            ))}
          </nav>

          {/* Right: Icons + Avatar */}
          <div className="customer-navbar-right">
            <ThemeToggle />
            <Link
              to="/customer/notifications"
              className="customer-nav-icon-btn"
              title="Notifications"
              aria-label="Notifications"
            >
              <Bell size={20} />
              {unreadCount > 0 && (
                <span className="notification-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>
              )}
            </Link>

            {/* Profile Dropdown */}
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setDropdownOpen(!dropdownOpen)}
                className="customer-avatar-btn"
                title="Account"
                aria-label="Open account menu"
                aria-haspopup="menu"
                aria-expanded={dropdownOpen}
              >
                <div className="customer-avatar">
                  <User size={20} />
                </div>
              </button>

              {dropdownOpen && (
                <div className="customer-dropdown">
                  <div className="customer-dropdown-header">
                    <div className="fw-600 text-sm">
                      {getDisplayName(userProfile, user?.email)}
                    </div>
                    <div className="text-xs text-secondary mt-2">
                      {user?.email}
                    </div>
                  </div>
                  <div className="p-8">
                    <Link
                      to="/customer/profile"
                      onClick={() => setDropdownOpen(false)}
                      className="customer-dropdown-item"
                    >
                      <User size={16} /> My Profile
                      <ChevronRight size={14} className="ml-auto" style={{ opacity: 0.4 }} />
                    </Link>
                    <Link
                      to="/customer/personal-info"
                      onClick={() => setDropdownOpen(false)}
                      className="customer-dropdown-item"
                    >
                      <Settings size={16} /> Account Settings
                      <ChevronRight size={14} className="ml-auto" style={{ opacity: 0.4 }} />
                    </Link>
                    <button onClick={() => { setDropdownOpen(false); setShowLogoutConfirm(true); }} className="customer-dropdown-item danger">
                      <LogOut size={16} /> Logout
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ─── Page Content ─── */}
      <PageTransition as="main" id="customer-main-content" className="customer-main" key={location.pathname}>
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </PageTransition>

      {/* ─── Bottom Tab Bar (Mobile Only) ─── */}
      <nav className="customer-bottom-nav" aria-label="Customer navigation">
        <div className="customer-bottom-nav-inner">
          {bottomNavItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `customer-bottom-tab ${isActive ? 'active' : ''} ${item.isBookTab ? 'book-tab' : ''}`
              }
            >
              {item.isBookTab ? (
                <div className="book-tab-icon">
                  <item.icon size={22} />
                </div>
              ) : (
                <>
                  <div className="relative inline-flex">
                    <item.icon size={20} />
                    {item.hasBadge && unreadCount > 0 && (
                      <span className="notification-badge-sm">{unreadCount > 9 ? '9+' : unreadCount}</span>
                    )}
                  </div>
                  <span>{item.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>
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

export default CustomerLayout;
