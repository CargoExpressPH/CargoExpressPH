import { useState, useEffect, useCallback, useRef } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import ErrorBoundary from '../ui/ErrorBoundary';
import PageTransition from '../ui/PageTransition';
import CommandPalette from '../ui/CommandPalette';
import AdminNotificationCenter from '../ui/AdminNotificationCenter';
import { Menu, Container, Search, Bell } from 'lucide-react';
import ThemeToggle from '../ui/ThemeToggle';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { getUnreadNotificationCount } from '../../lib/database';
import { requestNotificationPermission, refreshFCMTokenIfNeeded } from '../../lib/firebase-messaging';
import { useToast } from '../../hooks/useToast';

const COLLAPSE_KEY = 'sidebar_collapsed';
const DRAWER_QUERY = '(max-width: 1024px)';

const AdminLayout = () => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const bellRef = useRef(null);
  const { user, userProfile } = useAuth();
  const toast = useToast();

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  const toggleCollapse = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* localStorage may be blocked in private mode */ }
      return next;
    });
  }, []);

  // ── Fetch unread count + real-time subscription ────────────────────────────
  useEffect(() => {
    if (!user) return;

    getUnreadNotificationCount(user.id)
      .then(count => setUnreadCount(count))
      .catch(() => {});

    const channel = supabase.channel(`admin_notif_badge_${user.id}`)
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
        if (payload.new.is_read && !payload.old.is_read) {
          setUnreadCount(prev => Math.max(0, prev - 1));
        }
      })
      .on('postgres_changes', {
        event: 'DELETE',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${user.id}`,
      }, () => {
        // Re-fetch on delete to get accurate count
        getUnreadNotificationCount(user.id)
          .then(count => setUnreadCount(count))
          .catch(() => {});
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user]);

  // ── Re-sync count when dropdown closes ─────────────────────────────────────
  useEffect(() => {
    if (!notifOpen && user) {
      getUnreadNotificationCount(user.id)
        .then(count => setUnreadCount(count))
        .catch(() => {});
    }
  }, [notifOpen, user]);

  // ── FCM push notification registration ─────────────────────────────────────
  useEffect(() => {
    if (!user) return;

    if (sessionStorage.getItem('admin_fcm_asked')) {
      refreshFCMTokenIfNeeded(user.id);
      return;
    }

    const timer = setTimeout(() => {
      requestNotificationPermission(user.id).finally(() => {
        sessionStorage.setItem('admin_fcm_asked', '1');
      });
    }, 3000);

    return () => clearTimeout(timer);
  }, [user]);

  // ── Foreground push: show in-app toast ─────────────────────────────────────
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
    const drawerQuery = window.matchMedia(DRAWER_QUERY);
    const handleViewportChange = () => {
      if (!drawerQuery.matches) {
        setSidebarOpen(false);
      }
    };

    handleViewportChange();

    if (drawerQuery.addEventListener) {
      drawerQuery.addEventListener('change', handleViewportChange);
      return () => drawerQuery.removeEventListener('change', handleViewportChange);
    }

    drawerQuery.addListener(handleViewportChange);
    return () => drawerQuery.removeListener(handleViewportChange);
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return undefined;

    const drawerQuery = window.matchMedia(DRAWER_QUERY);
    if (!drawerQuery.matches) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setSidebarOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [sidebarOpen]);

  // Global Ctrl+K / Cmd+K shortcut
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setCmdPaletteOpen(prev => !prev);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className={`app-layout${sidebarCollapsed ? ' sidebar-collapsed' : ''}${sidebarOpen ? ' sidebar-drawer-open' : ''}`}>
      <a href="#admin-main-content" className="skip-link">Skip to main content</a>
      <Sidebar
        isOpen={sidebarOpen}
        onClose={closeSidebar}
        isCollapsed={sidebarCollapsed}
        onToggleCollapse={toggleCollapse}
      />
      <div className="main-content">
        <header className="topbar">
          <div className="flex items-center gap-12">
            <button
              className="btn-icon btn-ghost mobile-menu-toggle"
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open admin navigation"
              aria-controls="admin-sidebar"
              aria-expanded={sidebarOpen}
            >
              <Menu size={20} aria-hidden="true" />
            </button>
            <div className="topbar-title">
              <Container size={22} color="var(--primary)" className="topbar-logo-icon" aria-hidden="true" />
              <span>
                <span className="text-accent">CARGO</span>
                <span className="text-primary">EXPRESS</span>
              </span>
            </div>
          </div>
          <div className="topbar-actions">
            <ThemeToggle />
            {/* Command Palette Trigger */}
            <button
              className="btn-icon btn-ghost gap-6 text-tertiary topbar-command-btn"
              type="button"
              onClick={() => setCmdPaletteOpen(true)}
              title="Search (Ctrl+K)"
              aria-label="Open command palette"
              style={{ fontSize: '0.8125rem' }}
            >
              <Search size={17} aria-hidden="true" />
              <kbd className="topbar-command-kbd">
                Ctrl K
              </kbd>
            </button>

            {/* ── Notification Bell ── */}
            <div className="relative" style={{ position: 'relative' }}>
              <button
                ref={bellRef}
                className={`admin-notif-bell${unreadCount > 0 ? ' has-unread' : ''}${notifOpen ? ' active' : ''}`}
                type="button"
                onClick={() => setNotifOpen(prev => !prev)}
                aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
                title="Notifications"
              >
                <Bell size={20} aria-hidden="true" />
                {unreadCount > 0 && (
                  <span className="admin-notif-badge">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
                {unreadCount > 0 && <span className="admin-notif-ring" />}
              </button>
              <AdminNotificationCenter
                isOpen={notifOpen}
                onClose={() => setNotifOpen(false)}
                anchorRef={bellRef}
              />
            </div>
          </div>
        </header>
        <PageTransition as="main" id="admin-main-content" className="page-content">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </PageTransition>
      </div>

      {/* Command Palette */}
      <CommandPalette isOpen={cmdPaletteOpen} onClose={() => setCmdPaletteOpen(false)} />
    </div>
  );
};

export default AdminLayout;
