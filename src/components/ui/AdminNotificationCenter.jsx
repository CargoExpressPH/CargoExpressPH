import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import {
  getNotifications, markNotificationRead, markAllNotificationsRead,
  deleteNotification, deleteAllNotifications
} from '../../lib/database';
import {
  Bell, Package, Truck, Megaphone, CheckCheck, Loader,
  Trash2, X, MessageSquare, Mail, Star, Clock, ChevronRight, BellOff, AlertTriangle
} from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import ConfirmModal from './ConfirmModal';

// ── Icon map per notification type ─────────────────────────────────────────────
const iconMap = {
  order_update: { icon: Package, color: 'var(--primary)', bg: 'var(--primary-bg)' },
  trip_update:  { icon: Truck, color: 'var(--warning)', bg: 'var(--warning-bg)' },
  announcement: { icon: Megaphone, color: 'var(--accent)', bg: 'var(--bg-secondary)' },
  inquiry:      { icon: Mail, color: 'var(--info)', bg: 'var(--info-bg)' },
  chat_message: { icon: MessageSquare, color: 'var(--success)', bg: 'var(--success-bg)' },
  feedback:     { icon: Star, color: 'var(--warning)', bg: 'var(--warning-bg)' },
  system_alert: { icon: AlertTriangle, color: 'var(--error)', bg: 'var(--error-bg)' },
  general:      { icon: Bell, color: 'var(--text-secondary)', bg: 'var(--bg-secondary)' },
};

// ── Time formatting ─────────────────────────────────────────────────────────────
const timeAgo = (dateStr) => {
  const now = new Date();
  const d = new Date(dateStr);
  const diffMs = now - d;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
};

const groupByDate = (notifications) => {
  const groups = {};
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  notifications.forEach(n => {
    const d = new Date(n.created_at);
    let label;
    if (d.toDateString() === today.toDateString()) label = 'Today';
    else if (d.toDateString() === yesterday.toDateString()) label = 'Yesterday';
    else label = 'Earlier';
    if (!groups[label]) groups[label] = [];
    groups[label].push(n);
  });
  return groups;
};

// ── Navigation helper ───────────────────────────────────────────────────────────
const getNotifRoute = (notification) => {
  switch (notification.type) {
    case 'order_update':
      return notification.reference_id ? `/admin/orders/${notification.reference_id}` : '/admin/orders';
    case 'trip_update':
      return notification.reference_id ? `/admin/trips/${notification.reference_id}` : '/admin/trips';
    case 'inquiry':
      return '/admin/contact-inquiries';
    case 'chat_message':
      return '/admin/inbox';
    case 'feedback':
      return '/admin/feedback';
    case 'announcement':
      return '/admin/announcements';
    case 'system_alert':
      return '/admin/storage-monitoring';
    default:
      return '/admin';
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// AdminNotificationCenter — Enterprise notification dropdown
// ═══════════════════════════════════════════════════════════════════════════════
const AdminNotificationCenter = ({ isOpen, onClose, anchorRef }) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const panelRef = useRef(null);

  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // ── Fetch notifications ───────────────────────────────────────────────────
  const fetchNotifications = useCallback(async () => {
    if (!user) return;
    try {
      setLoading(true);
      const data = await getNotifications(user.id);
      setNotifications(data || []);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (isOpen) fetchNotifications();
  }, [isOpen, fetchNotifications]);

  // ── Real-time: auto-append new notifications ──────────────────────────────
  useEffect(() => {
    if (!user || !isOpen) return;

    const channel = supabase.channel(`admin_notif_panel_${user.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${user.id}`,
      }, (payload) => {
        setNotifications(prev => [payload.new, ...prev]);
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user, isOpen]);

  // ── Click outside / Escape ────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e) => {
      // The clear-all ConfirmModal is portaled to <body>, so its own mousedowns
      // land outside panelRef — dismissing the panel here would unmount the
      // confirm before its buttons could be clicked.
      if (e.target?.closest?.('.confirm-modal')) return;
      if (
        panelRef.current && !panelRef.current.contains(e.target) &&
        anchorRef?.current && !anchorRef.current.contains(e.target)
      ) {
        onClose();
      }
    };
    const handleEsc = (e) => { if (e.key === 'Escape') onClose(); };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [isOpen, onClose, anchorRef]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const handleMarkAllRead = async () => {
    if (!user || actionLoading) return;
    setActionLoading(true);
    try {
      await markAllNotificationsRead(user.id);
      setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
      toast.success('All marked as read');
    } catch { toast.error('Failed to mark as read'); }
    finally { setActionLoading(false); }
  };

  const handleClearAll = async () => {
    if (!user || actionLoading) return;
    setActionLoading(true);
    try {
      await deleteAllNotifications(user.id);
      setNotifications([]);
      toast.success('All notifications cleared');
    } catch { toast.error('Failed to clear'); }
    finally { setActionLoading(false); }
  };

  const handleNotifClick = async (notif) => {
    // Mark as read
    if (!notif.is_read) {
      try {
        await markNotificationRead(notif.id);
        setNotifications(prev => prev.map(n => n.id === notif.id ? { ...n, is_read: true } : n));
      } catch { /* ignore notification read state failure silently */ }
    }
    onClose();
    navigate(getNotifRoute(notif));
  };

  const handleDeleteOne = async (e, id) => {
    e.stopPropagation();
    try {
      await deleteNotification(id);
      setNotifications(prev => prev.filter(n => n.id !== id));
    } catch { /* ignore notification deletion failure silently */ }
  };

  if (!isOpen) return null;

  const unreadCount = notifications.filter(n => !n.is_read).length;
  const grouped = groupByDate(notifications);
  const groupOrder = ['Today', 'Yesterday', 'Earlier'];

  return (
    <div className="admin-notif-dropdown" ref={panelRef} role="dialog" aria-label="Notifications">
      {/* ── Header ── */}
      <div className="admin-notif-header">
        <div className="admin-notif-header-left">
          <h3>Notifications</h3>
          {unreadCount > 0 && (
            <span className="admin-notif-unread-pill">{unreadCount} new</span>
          )}
        </div>
        <div className="admin-notif-header-actions">
          {unreadCount > 0 && (
            <button
              className="admin-notif-action-btn"
              onClick={handleMarkAllRead}
              disabled={actionLoading}
              title="Mark all as read"
            >
              <CheckCheck size={14} />
            </button>
          )}
          {notifications.length > 0 && (
            <button
              className="admin-notif-action-btn danger"
              onClick={() => setShowClearConfirm(true)}
              disabled={actionLoading}
              title="Clear all"
            >
              <Trash2 size={14} />
            </button>
          )}
          <button className="admin-notif-action-btn" onClick={onClose} title="Close" aria-label="Close notifications panel">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="admin-notif-body">
        {loading ? (
          <div className="admin-notif-loading">
            <Loader size={20} className="animate-spin" />
            <span>Loading notifications…</span>
          </div>
        ) : notifications.length === 0 ? (
          <div className="admin-notif-empty">
            <div className="admin-notif-empty-icon">
              <BellOff size={32} />
            </div>
            <p className="admin-notif-empty-title">All caught up!</p>
            <p className="admin-notif-empty-sub">No notifications yet</p>
          </div>
        ) : (
          groupOrder.map(group => {
            const items = grouped[group];
            if (!items || items.length === 0) return null;
            return (
              <div key={group} className="admin-notif-group">
                <div className="admin-notif-group-label">{group}</div>
                {items.map((notif, idx) => {
                  const mapping = iconMap[notif.type] || iconMap.general;
                  const Icon = mapping.icon;
                  return (
                    <div
                      key={notif.id}
                      className={`admin-notif-item ${!notif.is_read ? 'unread' : ''}`}
                      style={{ animationDelay: `${idx * 30}ms` }}
                    >
                      <div className="admin-notif-item-icon" style={{ background: mapping.bg, color: mapping.color }}>
                        <Icon size={16} />
                      </div>
                      <div
                        className="admin-notif-item-content"
                        role="button"
                        tabIndex={0}
                        aria-label={`Open notification: ${notif.title}`}
                        onClick={() => handleNotifClick(notif)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleNotifClick(notif); } }}
                      >
                        <div className="admin-notif-item-title">{notif.title}</div>
                        <div className="admin-notif-item-msg">{notif.message}</div>
                        <div className="admin-notif-item-time">
                          <Clock size={10} />
                          {timeAgo(notif.created_at)}
                        </div>
                      </div>
                      <div className="admin-notif-item-actions">
                        {!notif.is_read && <span className="admin-notif-dot" />}
                        <button
                          className="admin-notif-delete-btn"
                          onClick={(e) => handleDeleteOne(e, notif.id)}
                          onKeyDown={(e) => { e.stopPropagation(); }}
                          title="Delete"
                          aria-label="Delete notification"
                        >
                          <X size={12} />
                        </button>
                        <ChevronRight size={12} className="admin-notif-chevron" />
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>

      <ConfirmModal
        isOpen={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        onConfirm={async () => {
          setShowClearConfirm(false);
          await handleClearAll();
        }}
        title="Clear All Notifications"
        message="Are you sure you want to permanently clear all notifications? This action cannot be undone."
        confirmLabel="Clear All"
        variant="danger"
      />
    </div>
  );
};

export default AdminNotificationCenter;
