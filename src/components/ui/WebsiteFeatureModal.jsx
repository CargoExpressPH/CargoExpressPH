import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Star, X, Loader, Globe, MessageSquare, CheckCircle } from 'lucide-react';
import FocusTrap from './FocusTrap';
import CustomSelect from './CustomSelect';
import useScrollLock from '../../hooks/useScrollLock';

/**
 * WebsiteFeatureModal — replaces the inline collapsible "Website Feature"
 * section on the Admin OrderDetailPage.
 *
 * Publishes this booking's pickup/delivery photo alongside its customer
 * feedback on the public About page (the standalone "Featured Shipments"
 * gallery this modal used to also feed was removed — see featured_photo /
 * featured_image_type usage in getPublicFeedback()). Shows:
 *  - A "Customer feedback received" indicator when feedback exists for this
 *    exact booking (matched by order_id, not by customer name).
 *  - The actual rating and comment when feedback is present.
 *  - A preview of the photo that will appear on the website.
 *
 * Privacy rules enforced:
 *  - Addresses, phone numbers and payment details are never shown.
 *  - Submitting feedback does NOT auto-publish it; admin must explicitly click
 *    Publish.
 *  - Opening or closing the modal does not modify any data.
 *  - No duplicate entries: publishing is idempotent (updateOrder overwrites).
 */

const StarRating = ({ rating }) => (
  <span className="flex items-center gap-2" aria-label={`${rating} out of 5 stars`}>
    {[1, 2, 3, 4, 5].map((s) => (
      <Star
        key={s}
        size={14}
        fill={s <= rating ? 'var(--warning)' : 'none'}
        color={s <= rating ? 'var(--warning)' : 'var(--border)'}
      />
    ))}
  </span>
);

const WebsiteFeatureModal = ({
  isOpen,
  onClose,
  order,
  feedback,        // { id, rating, message } | null  — pass null if loading or not found
  feedbackLoading, // bool
  resolvedPickupPhotos,
  resolvedDeliveryPhotos,
  onSave,          // async (dataToSave) => void  — parent handles the API call
  saving,
}) => {
  const [form, setForm] = useState({
    featured_on_website: false,
    featured_image_type: 'pickup',
  });
  const [localError, setLocalError] = useState('');

  // Seed form from order when modal opens
  useEffect(() => {
    if (isOpen && order) {
      setForm({
        featured_on_website: order.featured_on_website ?? false,
        featured_image_type: order.featured_image_type ?? 'pickup',
      });
      setLocalError('');
    }
  }, [isOpen, order?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useScrollLock(isOpen);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, saving, onClose]);

  const handlePublish = useCallback(async () => {
    setLocalError('');
    const featuredPhotos =
      form.featured_image_type === 'delivery' &&
      Array.isArray(order.delivery_photos) &&
      order.delivery_photos.length > 0
        ? order.delivery_photos
        : order.pickup_photos;
    if (form.featured_on_website && (!Array.isArray(featuredPhotos) || featuredPhotos.length === 0)) {
      setLocalError('Upload at least one pickup or delivery photo before featuring this booking.');
      return;
    }
    await onSave({
      featured_on_website: form.featured_on_website,
      featured_image_type: form.featured_image_type,
      featured_at: form.featured_on_website
        ? (order.featured_at || new Date().toISOString())
        : null,
    });
  }, [form, order, onSave]);

  if (!isOpen || !order) return null;

  const hasPickup = resolvedPickupPhotos.length > 0;
  const hasDelivery = resolvedDeliveryPhotos.length > 0;
  const isAlreadyFeatured = order.featured_on_website;
  // Mirrors get_featured_deliveries()/get_public_feedback()'s own CASE logic
  // exactly (delivery photo only when the type is 'delivery' AND one exists,
  // pickup otherwise) — this is the literal photo that would go public, not
  // an approximation, so the admin can actually inspect it (shipping labels,
  // visible addresses, etc.) before publishing.
  const previewPhotoUrl = form.featured_image_type === 'delivery' && hasDelivery
    ? resolvedDeliveryPhotos[0]
    : resolvedPickupPhotos[0] || null;

  const modalContent = (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="website-feature-modal-title"
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
    >
      <FocusTrap active={isOpen}>
        <div
          className="modal modal-website-feature"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="modal-header flex items-center justify-between">
            <h2 id="website-feature-modal-title" className="flex items-center gap-8 m-0" style={{ fontSize: '1rem' }}>
              <Star size={16} className="text-warning" />
              {isAlreadyFeatured ? 'Manage Feedback Photo' : 'Add Photo to Customer Feedback'}
            </h2>
            <button
              type="button"
              className="btn-icon btn-ghost"
              aria-label="Close website feature modal"
              onClick={onClose}
              disabled={saving}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>

          {/* Body */}
          <div className="modal-body" style={{ paddingTop: 16 }}>

            {/* Tracking number context */}
            <p className="text-xs text-tertiary mb-16">
              Booking <strong>{order.tracking_number}</strong> · {order.receiver_city}, {order.receiver_province}
            </p>

            {/* Customer feedback indicator */}
            <div
              className="p-12 mb-16"
              style={{
                background: 'var(--bg-secondary)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border)',
              }}
            >
              <div className="flex items-center gap-8 mb-4">
                <MessageSquare size={14} className="text-secondary" />
                <span className="text-xs font-bold text-secondary text-uppercase">Customer Feedback</span>
                {feedbackLoading && <Loader size={12} className="animate-spin text-tertiary" />}
              </div>

              {!feedbackLoading && feedback ? (
                <>
                  <div className="flex items-center gap-8 mb-6">
                    <CheckCircle size={14} className="text-success" />
                    <span className="text-xs text-success font-semibold">Customer feedback received</span>
                    <StarRating rating={feedback.rating} />
                  </div>
                  <blockquote
                    className="text-sm text-secondary m-0"
                    style={{ borderLeft: '3px solid var(--border)', paddingLeft: 10, fontStyle: 'italic' }}
                  >
                    "{feedback.message}"
                  </blockquote>
                  <p className="text-xs text-tertiary mt-6">
                    Note: Submitting feedback does not automatically publish it. Use the controls below to publish.
                  </p>
                </>
              ) : !feedbackLoading ? (
                <p className="text-xs text-tertiary m-0">No customer feedback submitted for this booking yet.</p>
              ) : null}
            </div>

            {/* Feature toggle */}
            <div className="form-group flex items-center gap-12 mb-16">
              <input
                type="checkbox"
                id="wf-feature-website"
                checked={form.featured_on_website}
                onChange={(e) => setForm((f) => ({ ...f, featured_on_website: e.target.checked }))}
                className="w-18"
                style={{ height: 18 }}
                disabled={saving}
              />
              <label htmlFor="wf-feature-website" className="font-semibold cursor-pointer m-0">
                Show this booking's photo with its customer feedback
              </label>
            </div>

            {form.featured_on_website && (
              <div
                className="grid gap-12 p-12 mb-12"
                style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)' }}
              >
                <div className="form-group">
                  <label className="form-label" htmlFor="wf-featured-image">Featured Image</label>
                  <CustomSelect
                    id="wf-featured-image"
                    className="form-select"
                    value={form.featured_image_type}
                    onChange={(e) => setForm((f) => ({ ...f, featured_image_type: e.target.value }))}
                    disabled={saving}
                  >
                    {hasPickup && <option value="pickup">Use Pickup Proof</option>}
                    {hasDelivery && <option value="delivery">Use Delivery Proof</option>}
                  </CustomSelect>
                </div>

                {/* Preview — the literal photo that would go public, so the
                    admin can check it for a shipping label, a visible
                    address, or anything else personal before publishing. */}
                <div
                  className="p-10"
                  style={{
                    background: 'var(--primary-bg)',
                    border: '1px solid var(--primary-light)',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  <div className="flex items-center gap-6 mb-8">
                    <Globe size={13} className="text-primary flex-shrink-0" />
                    <span className="text-xs font-semibold text-secondary">Feedback photo preview</span>
                  </div>
                  <div className="flex gap-10 items-start">
                    {previewPhotoUrl ? (
                      <img
                        src={previewPhotoUrl}
                        alt=""
                        style={{
                          width: 64, height: 64, objectFit: 'cover', flexShrink: 0,
                          borderRadius: 'var(--radius-xs, 6px)', border: '1px solid var(--border)',
                        }}
                      />
                    ) : (
                      <div
                        className="flex items-center justify-center text-tertiary"
                        style={{ width: 64, height: 64, flexShrink: 0, background: 'var(--bg-secondary)', borderRadius: 'var(--radius-xs, 6px)', border: '1px solid var(--border)' }}
                      >
                        <Star size={16} />
                      </div>
                    )}
                    <span className="text-xs text-secondary">
                      {feedback
                        ? 'This photo will appear on this booking’s customer feedback card.'
                        : 'This photo will appear once the customer leaves feedback for this booking.'}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Unfeature note */}
            {!form.featured_on_website && isAlreadyFeatured && (
              <p className="text-xs text-warning mb-12">
                Saving with this unchecked will remove this photo from the customer feedback card.
              </p>
            )}

            {localError && (
              <p className="text-xs text-error mb-8" role="alert">{localError}</p>
            )}
          </div>

          {/* Footer */}
          <div className="modal-footer flex items-center justify-end gap-8">
            <button
              type="button"
              className="btn btn-outline"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handlePublish}
              disabled={saving}
            >
              {saving ? (
                <><Loader size={14} className="animate-spin" /> Saving…</>
              ) : form.featured_on_website ? (
                isAlreadyFeatured ? 'Update Feature' : 'Publish'
              ) : isAlreadyFeatured ? (
                'Remove from Website'
              ) : (
                'Save'
              )}
            </button>
          </div>
        </div>
      </FocusTrap>
    </div>
  );

  return createPortal(modalContent, document.body);
};

export default WebsiteFeatureModal;
