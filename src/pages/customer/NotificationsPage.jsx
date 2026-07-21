import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { getNotifications, markNotificationRead, markAllNotificationsRead, deleteNotification, deleteAllNotifications } from '../../lib/database';
import { AlertTriangle, Bell, Package, Truck, Megaphone, CheckCheck, Loader, RefreshCw, Trash2, X } from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import EmptyState from '../../components/ui/EmptyState';
import { SkeletonText } from '../../components/ui/SkeletonLoader';
import FocusTrap from '../../components/ui/FocusTrap';
import usePageTitle from '../../hooks/usePageTitle';

const iconMap = { order_update: Package, trip_update: Truck, announcement: Megaphone, general: Bell };

const groupByDate = (notifications) => {
  const groups = {};
  notifications.forEach(n => {
    const d = new Date(n.created_at);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    let label;
    if (d.toDateString() === today.toDateString()) label = 'Today';
    else if (d.toDateString() === yesterday.toDateString()) label = 'Yesterday';
    else label = d.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' });

    if (!groups[label]) groups[label] = [];
    groups[label].push(n);
  });
  return groups;
};

// ── Swipe-to-delete notification card ──────────────────────────────────────
const SwipeableNotificationCard = ({ notification, onRead, onDelete, onClick, index }) => {
  const Icon = iconMap[notification.type] || Bell;
  const isUnread = !notification.is_read;
  const cardRef = useRef(null);
  const startX = useRef(0);
  const currentX = useRef(0);
  const isDragging = useRef(false);
  const [offset, setOffset] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const [exiting, setExiting] = useState(false);
  const DELETE_THRESHOLD = 80;

  const handleTouchStart = useCallback((e) => {
    startX.current = e.touches[0].clientX;
    currentX.current = startX.current;
    isDragging.current = true;
    setSwiping(true);
  }, []);

  const handleTouchMove = useCallback((e) => {
    if (!isDragging.current) return;
    currentX.current = e.touches[0].clientX;
    const diff = startX.current - currentX.current;
    // Only allow swiping left (positive diff)
    const clampedOffset = Math.max(0, Math.min(diff, 160));
    setOffset(clampedOffset);
  }, []);

  const handleTouchEnd = useCallback(() => {
    isDragging.current = false;
    if (offset >= DELETE_THRESHOLD) {
      // Trigger delete with exit animation
      setExiting(true);
      setTimeout(() => onDelete(notification.id), 300);
    } else {
      setOffset(0);
    }
    setSwiping(false);
  }, [offset, notification.id, onDelete]);

  const handleClick = async () => {
    if (offset > 5) return; // Don't navigate if swiping
    if (isUnread) {
      await onRead(notification.id);
    }
    onClick(notification);
  };

  const handleDeleteClick = (e) => {
    e.stopPropagation();
    setExiting(true);
    setTimeout(() => onDelete(notification.id), 300);
  };

  return (
    <div
      className={`notification-swipe-container stagger-item ${exiting ? 'notification-exit' : ''}`}
      style={{ animationDelay: `${index * 40}ms` }}
    >
      {/* Delete action behind the card */}
      <div
        className="notification-delete-backdrop"
        style={{ opacity: Math.min(offset / DELETE_THRESHOLD, 1) }}
      >
        <Trash2 size={20} />
        <span>Delete</span>
      </div>

      {/* The card itself */}
      <div
        ref={cardRef}
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); } }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className={`notification-card notification-card-action ${isUnread ? 'unread' : ''}`}
        style={{
          transform: `translateX(-${offset}px)`,
          transition: swiping ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
        aria-label={`Notification: ${notification.title}. ${notification.message}`}
      >
        <div className="notification-icon-wrap">
          <Icon size={18} aria-hidden="true" />
        </div>
        <div className="notification-content" style={{ flex: 1 }}>
          <div className="notification-title">
            {notification.title}
            {isUnread && <span className="notification-unread-dot" />}
          </div>
          <div className="notification-body">{notification.message}</div>
          <div className="notification-time">
            {new Date(notification.created_at).toLocaleString('en-PH', {
              hour: 'numeric', minute: '2-digit', hour12: true,
            })}
          </div>
        </div>

        {/* Desktop delete button (visible on hover) */}
        <button
          type="button"
          className="notification-delete-btn"
          onClick={handleDeleteClick}
          aria-label={`Delete notification: ${notification.title}`}
          title="Delete notification"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
};

// ── Confirmation Modal ─────────────────────────────────────────────────────
const ConfirmModal = ({ open, title, message, confirmLabel, onConfirm, onCancel, loading }) => {
  if (!open) return null;
  return (
    <FocusTrap active={open}>
    <div className="notification-modal-overlay" onClick={onCancel} role="dialog" aria-modal="true" aria-labelledby="notif-confirm-title">
      <div className="notification-modal" onClick={e => e.stopPropagation()}>
        <button className="notification-modal-close" type="button" onClick={onCancel} aria-label="Close">
          <X size={18} />
        </button>
        <div className="notification-modal-icon">
          <Trash2 size={28} />
        </div>
        <h3 id="notif-confirm-title" className="notification-modal-title">{title}</h3>
        <p className="notification-modal-message">{message}</p>
        <div className="notification-modal-actions">
          <button className="btn btn-ghost" type="button" onClick={onCancel} disabled={loading}>
            Cancel
          </button>
          <button className="btn btn-danger" type="button" onClick={onConfirm} disabled={loading}>
            {loading ? <Loader size={14} className="animate-spin" /> : <Trash2 size={14} />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
    </FocusTrap>
  );
};

// ── Main Page ──────────────────────────────────────────────────────────────
const NotificationsPage = () => {
  usePageTitle('Notifications');
  const navigate = useNavigate();
  const { user } = useAuth();
  const toast = useToast();
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [markingAll, setMarkingAll] = useState(false);
  const [confirmModal, setConfirmModal] = useState({ open: false, type: null, id: null });
  const [clearingAll, setClearingAll] = useState(false);

  useEffect(() => { if (user) loadData(); }, [user]);

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      setNotifications(await getNotifications(user.id));
    } catch (e) {
      const message = 'Failed to load notifications.';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  // ── Supabase Realtime: listen for new notifications ──────────────────────
  useEffect(() => {
    if (!user) return;
    const channel = supabase.channel(`notifications_${user.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${user.id}`,
      }, (payload) => {
        setNotifications(prev => {
          // Prevent duplicates (same pattern as SupportChatPage)
          if (prev.some(n => n.id === payload.new.id)) return prev;
          setError('');
          return [payload.new, ...prev];
        });
      }).subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user]);

  const handleRead = async (id) => {
    await markNotificationRead(id);
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
  };

  const handleMarkAllRead = async () => {
    setMarkingAll(true);
    try {
      // Single batch DB call instead of N individual calls
      await markAllNotificationsRead(user.id);
      setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
    } catch (e) { /* silently handled */ }
    finally { setMarkingAll(false); }
  };

  // ── Delete handlers ──────────────────────────────────────────────────────
  const handleDeleteSingle = useCallback(async (id) => {
    try {
      await deleteNotification(id);
      setNotifications(prev => prev.filter(n => n.id !== id));
      toast.success('Notification removed');
    } catch (e) {
      toast.error('Failed to delete notification');
    }
  }, [toast]);

  const handleClearAll = async () => {
    setClearingAll(true);
    try {
      await deleteAllNotifications(user.id);
      setNotifications([]);
      toast.success('All notifications cleared');
    } catch (e) {
      toast.error('Failed to clear notifications');
    } finally {
      setClearingAll(false);
      setConfirmModal({ open: false, type: null, id: null });
    }
  };

  const openClearAllModal = () => {
    setConfirmModal({
      open: true,
      type: 'clear_all',
      id: null,
    });
  };

  const handleNotificationClick = (n) => {
    if (n.type === 'order_update' && n.reference_id) {
      navigate(`/customer/orders/${n.reference_id}`);
    } else if (n.type === 'trip_update') {
      navigate('/customer/trips');
    } else if (n.type === 'announcement') {
      navigate('/customer');
    }
  };

  const unreadCount = notifications.filter(n => !n.is_read).length;
  const groups = groupByDate(notifications);

  return (
    <div className="page-transition customer-notifications-page">
      <div className="section-header customer-mobile-heading mb-20">
        <div>
          <h1 className="fw-800 flex items-center gap-8 flex-wrap">
            <span>Notifications</span>
            {unreadCount > 0 && (
              <span className="badge badge-pending text-xs flex-shrink-0" style={{ display: 'inline-flex', alignItems: 'center' }}>
                {unreadCount} new
              </span>
            )}
          </h1>
        </div>
        <div className="notification-header-actions">
          {unreadCount > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleMarkAllRead}
              disabled={markingAll}
            >
              {markingAll ? <Loader size={14} className="animate-spin" /> : <CheckCheck size={14} />}
              Mark all read
            </button>
          )}
          {notifications.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm notification-clear-all-btn"
              onClick={openClearAllModal}
            >
              <Trash2 size={14} />
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* Swipe hint for mobile (shown only if notifications exist) */}
      {!loading && notifications.length > 0 && (
        <div className="notification-swipe-hint">
          <span>← Swipe left to delete</span>
        </div>
      )}

      {loading ? (
        <div className="flex flex-col gap-12">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="card card-body stagger-item flex gap-12" style={{ animationDelay: `${i * 60}ms` }}>
              <div className="skeleton skeleton-avatar w-40 h-40" />
              <div className="flex-1">
                <SkeletonText lines={2} />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="card animate-scale-in text-center" role="alert" style={{ padding: 32 }}>
          <div className="flex items-center justify-center mx-auto mb-16"
            style={{ width: 52, height: 52, borderRadius: '50%', background: 'var(--error-bg)' }}>
            <AlertTriangle size={26} color="var(--error)" aria-hidden="true" />
          </div>
          <h3 className="mb-8" style={{ color: 'var(--error-dark)' }}>Unable to Load Notifications</h3>
          <p className="text-secondary text-sm mb-20">{error}</p>
          <button type="button" className="btn btn-primary flex items-center gap-8 mx-auto" onClick={loadData}>
            <RefreshCw size={16} /> Try Again
          </button>
        </div>
      ) : notifications.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="No Notifications"
          description="You're all caught up! New notifications will appear here."
        />
      ) : (
        Object.entries(groups).map(([dateLabel, items]) => (
          <div key={dateLabel}>
            <div className="notification-date-separator">{dateLabel}</div>
            {items.map((n, index) => (
              <SwipeableNotificationCard
                key={n.id}
                notification={n}
                onRead={handleRead}
                onDelete={handleDeleteSingle}
                onClick={handleNotificationClick}
                index={index}
              />
            ))}
          </div>
        ))
      )}

      {/* Confirmation Modal */}
      <ConfirmModal
        open={confirmModal.open}
        title="Clear All Notifications"
        message="Are you sure you want to remove all notifications? This action cannot be undone."
        confirmLabel="Clear All"
        onConfirm={handleClearAll}
        onCancel={() => setConfirmModal({ open: false, type: null, id: null })}
        loading={clearingAll}
      />
    </div>
  );
};

export default NotificationsPage;
