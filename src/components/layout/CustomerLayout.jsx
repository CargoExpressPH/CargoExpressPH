import { useState, useRef, useEffect, useCallback } from 'react';
import { Outlet, NavLink, useNavigate, Link, useLocation } from 'react-router-dom';
import { Bell, User, LogOut, MessageSquare, MessageCircle, Package, MapPin, Plus, Home, ChevronRight } from 'lucide-react';
import BrandLockup from '../ui/BrandLogo';
import ThemeToggle from '../ui/ThemeToggle';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { getUnreadNotificationCount } from '../../lib/database';
import { useToast } from '../../hooks/useToast';
import { usePushNotification } from '../../hooks/usePushNotification';
import ErrorBoundary from '../ui/ErrorBoundary';
import ConfirmModal from '../ui/ConfirmModal';
import OnboardingModal from '../ui/OnboardingModal';
import { motion, AnimatePresence } from 'framer-motion';
import PageTransition from '../ui/PageTransition';

const desktopNavItems = [
  { to: '/customer/book', icon: Plus, label: 'Book Shipment' },
  { to: '/customer/orders', icon: Package, label: 'Bookings' },
  { to: '/customer/trips', icon: MapPin, label: 'Trips' },
  { to: '/customer/support', icon: MessageSquare, MessageCircle, label: 'Chat Support' },
];

const bottomNavItems = [
  { to: '/customer', icon: Home, label: 'Home', end: true },
  { to: '/customer/orders', icon: Package, label: 'Bookings' },
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

  // ── Keyboard visibility listener (Hides bottom nav when typing on mobile) ──
  useEffect(() => {
    const handleViewportChange = () => {
      if (window.visualViewport) {
        const activeElement = document.activeElement;
        const isTextInputActive = activeElement && (
          activeElement.tagName === 'TEXTAREA' ||
          (activeElement.tagName === 'INPUT' && ['text', 'search', 'password', 'email', 'tel', 'number', 'url', 'date', 'time', 'datetime-local'].includes(activeElement.type))
        );
        const isKeyboard = isTextInputActive && (window.visualViewport.height < window.innerHeight - 120);
        document.body.classList.toggle('keyboard-active', isKeyboard);
      }
    };

    const handleFocusIn = (e) => {
      const target = e.target;
      const isTextInput = target && (
        target.tagName === 'TEXTAREA' ||
        (target.tagName === 'INPUT' && ['text', 'search', 'password', 'email', 'tel', 'number', 'url', 'date', 'time', 'datetime-local'].includes(target.type))
      );
      if (isTextInput) {
        document.body.classList.add('keyboard-active');
      } else {
        document.body.classList.remove('keyboard-active');
      }
    };

    const handleFocusOut = () => {
      setTimeout(() => {
        const activeElement = document.activeElement;
        const isTextInputActive = activeElement && (
          activeElement.tagName === 'TEXTAREA' ||
          (activeElement.tagName === 'INPUT' && ['text', 'search', 'password', 'email', 'tel', 'number', 'url', 'date', 'time', 'datetime-local'].includes(activeElement.type))
        );
        if (!isTextInputActive) {
          document.body.classList.remove('keyboard-active');
        }
      }, 100);
    };

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleViewportChange);
    }
    window.addEventListener('focusin', handleFocusIn);
    window.addEventListener('focusout', handleFocusOut);

    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleViewportChange);
      }
      window.removeEventListener('focusin', handleFocusIn);
      window.removeEventListener('focusout', handleFocusOut);
      document.body.classList.remove('keyboard-active');
    };
  }, []);

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

  // ── Push Notifications: unified Android (FCM) + iOS (Web Push) ────────
  const handleForegroundPush = useCallback((msg) => {
    toast.info(msg.body || msg.title);
  }, [toast]);

  const {
    enablePush,
    permissionState,
    isIosDevice,
    isIosInstalled,
    iosPushSupported,
  } = usePushNotification(user?.id, handleForegroundPush);

  // Soft prompt, shown instead of calling Notification.requestPermission() on a
  // timer. Safari only honours a permission request that originates in a user
  // gesture; fired from setTimeout it does not merely fail, on several iOS
  // versions it resolves as "denied" — and iOS gives no in-app way back from
  // denied, so a single silent auto-prompt could permanently kill push for that
  // user. Chrome likewise penalises gestureless prompts with a quieter UI.
  // The Enable button below supplies the gesture.
  const [pushPromptDismissed, setPushPromptDismissed] = useState(
    () => { try { return localStorage.getItem('push_prompt_dismissed') === '1'; } catch { return false; } }
  );
  const [pushPromptBusy, setPushPromptBusy] = useState(false);

  const dismissPushPrompt = useCallback(() => {
    setPushPromptDismissed(true);
    try { localStorage.setItem('push_prompt_dismissed', '1'); } catch { /* private mode */ }
  }, []);

  const handleEnablePush = useCallback(async () => {
    setPushPromptBusy(true);
    try {
      const result = await enablePush();
      if (result?.success) toast.success('Notifications on — we’ll keep you posted.');
      else if (result?.reason === 'denied') toast.error('Permission denied. You can turn it on in your device settings.');
      else toast.error('Could not enable notifications. You can try again from Profile.');
    } finally {
      setPushPromptBusy(false);
      dismissPushPrompt();
    }
  }, [enablePush, toast, dismissPushPrompt]);

  // Only offer it where it can actually succeed: never in an iOS browser tab
  // (Web Push needs the installed PWA) and never below iOS 16.4.
  const canShowPushPrompt =
    !!user &&
    permissionState === 'default' &&
    !pushPromptDismissed &&
    (!isIosDevice || (isIosInstalled && iosPushSupported));

  // Foreground push from SW message bus (sw.js PUSH_NOTIFICATION event)
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
            <BrandLockup size={40} />
          </Link>

          {/* Center: Desktop Nav Links */}
          <nav className="customer-navbar-links" aria-label="Main navigation">
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
                <span className="notification-badge" aria-live="polite" aria-atomic="true">{unreadCount > 9 ? '9+' : unreadCount}</span>
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

              <AnimatePresence>
                {dropdownOpen && (
                  <motion.div
                    className="customer-dropdown"
                    role="menu"
                    initial={{ opacity: 0, scale: 0.95, y: -8 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: -6 }}
                    transition={{ duration: 0.15, ease: 'easeOut' }}
                  >
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
                        role="menuitem"
                      >
                        <User size={16} /> My Profile
                        <ChevronRight size={14} className="ml-auto" style={{ opacity: 0.4 }} />
                      </Link>
                      <button onClick={() => { setDropdownOpen(false); setShowLogoutConfirm(true); }} className="customer-dropdown-item danger" role="menuitem">
                        <LogOut size={16} /> Logout
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </header>

      {/* ─── Push soft prompt ───
          Deliberately a button, not an automatic request: the browser prompt is
          only raised from this click, which is the user gesture Safari requires. */}
      {canShowPushPrompt && (
        <div className="customer-main" style={{ paddingBottom: 0 }}>
          <div className="alert-banner alert-banner-info push-prompt-banner" role="region" aria-label="Notification settings">
            <Bell size={18} aria-hidden="true" />
            <div className="push-prompt-copy">
              <div className="fw-700">Get shipment updates</div>
              <div className="text-sm text-secondary">
                Know the moment your cargo is picked up, in transit, and delivered.
              </div>
            </div>
            <div className="push-prompt-actions flex items-center gap-8">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={dismissPushPrompt}
                disabled={pushPromptBusy}
              >
                Not now
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleEnablePush}
                disabled={pushPromptBusy}
                aria-busy={pushPromptBusy}
              >
                {pushPromptBusy ? 'Enabling…' : 'Enable'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Page Content ─── */}
      <PageTransition as="main" id="customer-main-content" className="customer-main" key={location.pathname} tabIndex={-1}>
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </PageTransition>

      {/* ─── Floating chat support bubble (mobile only) ───
          Not rendered on the support page itself: at bottom 85px it sits
          exactly over the chat composer, so on the one screen where it has
          nothing left to do it would be in the way. Everywhere else it is the
          mobile stand-in for the "Chat Support" link in the desktop navbar,
          which the 900px breakpoint hides.

          Mobile-only is a media query rather than a matchMedia hook on
          purpose. A JS breakpoint re-renders this whole layout — navbar,
          bottom nav and the entire routed page beneath it — on every rotation
          and every resize tick, to decide something the compositor already
          knows. The FAB is one <a>; hiding it in CSS costs nothing at all.

          A plain Link, not a modal: mounting SupportChatPage over the DOM
          means its realtime subscription, its message list and its composer
          all live on top of whatever page the customer is on. The route
          already exists and already has its own transition. */}
      {location.pathname !== '/customer/support' && (
        // The accessible name begins with the visible text on purpose: WCAG
        // 2.5.3 (Label in Name) means a voice-control user saying "Ask
        // CargoMate" — what they can see — must hit this control.
        <Link
          to="/customer/support"
          className="customer-chat-fab"
          aria-label="Ask CargoMate — chat support"
          title="Ask CargoMate — chat support"
        >
          <Bot size={20} aria-hidden="true" />
          <span className="customer-chat-fab-label">Ask CargoMate</span>
        </Link>
      )}

      {/* ─── Bottom Tab Bar (Mobile Only) ─── */}
      <nav className="customer-bottom-nav" aria-label="Customer navigation">
        <div className="customer-bottom-nav-inner">
          {bottomNavItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              aria-label={item.isBookTab ? 'Place order / Book shipment' : undefined}
              className={({ isActive }) =>
                `customer-bottom-tab ${isActive ? 'active' : ''} ${item.isBookTab ? 'book-tab' : ''}`
              }
            >
              {item.isBookTab ? (
                <div className="book-tab-icon" aria-hidden="true">
                  <item.icon size={22} />
                </div>
              ) : (
                <>
                  {/* Wrapper retained: it keeps the icon a non-direct child, which
                      viewport-hardening.css's `.customer-bottom-tab > svg` rule
                      depends on. No bottomNavItems entry ever set hasBadge, so the
                      unread badge that used to be rendered here was unreachable —
                      the count is shown on the navbar bell, which is visible on
                      mobile too. */}
                  <div className="relative inline-flex">
                    <item.icon size={20} />
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
      message="You are about to sign out of your account. You can sign back in at any time to access your active bookings and shipment tracking."
      confirmLabel="Sign Out"
      variant="primary"
    />


    </>
  );

};

export default CustomerLayout;
