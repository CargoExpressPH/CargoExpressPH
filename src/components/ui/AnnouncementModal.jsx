import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Clock, Loader, X } from 'lucide-react';
import FocusTrap from './FocusTrap';
import AnnouncementComments from './AnnouncementComments';
import { announcementDisplayTitle, getAnnouncementCategoryInfo } from '../../lib/announcements';

/**
 * One announcement in full: category, title, date, body and its comment
 * thread. Opened from a notification (NotificationsPage) and from the
 * compact announcement list on Home, so both read and comment the same way.
 *
 * A notification only carries the announcement's TITLE — the fan-out in
 * createAnnouncement writes `message: announcement.title` — so that caller
 * passes it as `fallbackTitle` / `fallbackDate` while the row is fetched by
 * `reference_id`. The modal opens with content rather than a spinner in an
 * empty frame.
 *
 * `reference_id` carries no foreign key to announcements, so the row can be
 * gone while the notification survives. That is a real state, not an error:
 * the modal falls back to the title it was given and tells the customer the
 * rest is no longer available, rather than showing an empty body.
 */
const AnnouncementModal = ({
  open,
  announcement,
  fallbackTitle = '',
  fallbackDate = null,
  loading = false,
  failed = false,
  onClose,
  onCommentsChange,
}) => {
  useEffect(() => {
    if (!open) return undefined;
    const onEscape = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [open, onClose]);

  if (!open) return null;

  // The announcement is the better source for both; the fallback is what the
  // caller already had in hand.
  const title = announcement?.title || fallbackTitle;
  const postedAt = announcement?.created_at || fallbackDate;
  const category = getAnnouncementCategoryInfo(announcement || { title, content: '' });
  const CategoryIcon = category.icon;

  return createPortal(
    <FocusTrap active={open}>
      <div
        className="notification-modal-overlay"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-labelledby="announcement-modal-title"
      >
        <div className="notification-modal announcement-modal" onClick={e => e.stopPropagation()}>
          <button className="notification-modal-close" type="button" onClick={onClose} aria-label="Close announcement">
            <X size={18} />
          </button>

          <span
            className="announcement-modal-category"
            style={{ background: category.badgeBg, color: category.badgeColor }}
          >
            <CategoryIcon size={13} aria-hidden="true" />
            {category.label}
          </span>

          <h3 id="announcement-modal-title" className="announcement-modal-title">{announcementDisplayTitle(title)}</h3>

          {postedAt && (
            <div className="announcement-modal-meta">
              <Clock size={13} aria-hidden="true" />
              {new Date(postedAt).toLocaleDateString('en-PH', {
                month: 'long', day: 'numeric', year: 'numeric',
              })}
            </div>
          )}

          <div className="announcement-modal-body">
            {loading && (
              <p className="announcement-modal-loading">
                <Loader size={15} className="animate-spin" aria-hidden="true" /> Loading the full announcement…
              </p>
            )}
            {!loading && announcement?.content && (
              <p className="announcement-modal-content">{announcement.content}</p>
            )}
            {!loading && !announcement?.content && (
              <p className="announcement-modal-missing">
                The full text of this announcement is no longer available.
                {failed ? ' Please check your connection and try again.' : ''}
              </p>
            )}

            {/* Only once the row itself is in hand: without an announcement id
                there is nothing to comment on, and a composer over a
                notification whose announcement is gone would fail on submit. */}
            {!loading && announcement?.id && (
              <AnnouncementComments
                announcementId={announcement.id}
                comments={announcement.comments}
                onCommentsChange={onCommentsChange}
              />
            )}
          </div>
        </div>
      </div>
    </FocusTrap>,
    document.body
  );
};

export default AnnouncementModal;
