import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Star, X, Loader, Globe } from 'lucide-react';
import FocusTrap from './FocusTrap';
import CustomSelect from './CustomSelect';
import ConfirmModal from './ConfirmModal';
import useScrollLock from '../../hooks/useScrollLock';

/**
 * FeatureShipmentModal — opened from the "Feature Delivery on Website" /
 * "Manage Featured Shipment" button inside Shipment Evidence on the Admin
 * OrderDetailPage.
 *
 * Publishes an admin-selected pickup/delivery photo to the public "Featured
 * Shipments" gallery (get_featured_deliveries()). This is deliberately
 * independent of customer feedback — a booking does not need a review to be
 * featured, and featuring it never attaches its photo to that booking's
 * feedback card (see getPublicFeedback(), which carries no photo field at
 * all — 20260915140000_separate_featured_shipments_from_feedback.sql).
 *
 * The form is always visible — there is no separate "enable" toggle. Whether
 * a booking is currently published is `order.featured_on_website`, read on
 * open to pick the modal's title/primary-action copy and to seed the form;
 * it is never re-derived from anything the admin types. Saving always
 * publishes (or keeps published) what's on screen; unpublishing is its own
 * explicit "Remove from Website" action below, confirmed before it runs, so
 * it can never be triggered by accidentally leaving a field blank.
 *
 * Privacy rules enforced:
 *  - Addresses, phone numbers and payment details are never shown.
 *  - Publishing/removing requires an explicit admin action; opening or
 *    closing the modal never modifies any data — edits stay local (`form`
 *    state) until Publish/Save Changes/Remove from Website succeeds.
 *  - No duplicate entries: publishing is idempotent — it's a plain UPDATE on
 *    the one order row, not an insert into a separate table.
 *  - The exact photo that would go public is previewed before publishing, so
 *    the admin can check it for a shipping label, a visible address, or
 *    anything else personal. There is no automatic detection of that —
 *    this is a manual review step, not a scan.
 */

const FeatureShipmentModal = ({
  isOpen,
  onClose,
  order,
  resolvedPickupPhotos,
  resolvedDeliveryPhotos,
  onSave,          // async (dataToSave) => void  — parent handles the API call
  saving,
}) => {
  const [form, setForm] = useState({
    featured_title: '',
    featured_caption: '',
    featured_image_type: 'pickup',
  });
  const [localError, setLocalError] = useState('');
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);

  // Seed form from the order's last-SAVED values whenever the modal opens.
  // Nothing here reads or writes `form` after that until Publish/Save.
  useEffect(() => {
    if (isOpen && order) {
      setForm({
        featured_title: order.featured_title ?? '',
        featured_caption: order.featured_caption ?? '',
        featured_image_type: order.featured_image_type ?? 'pickup',
      });
      setLocalError('');
      setShowRemoveConfirm(false);
    }
  }, [isOpen, order?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useScrollLock(isOpen);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !saving && !showRemoveConfirm) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, saving, showRemoveConfirm, onClose]);

  const isAlreadyFeatured = Boolean(order?.featured_on_website);

  const handleSave = useCallback(async () => {
    setLocalError('');
    if (!form.featured_title.trim()) {
      setLocalError('A title is required to feature this shipment.');
      return;
    }
    const featuredPhotos =
      form.featured_image_type === 'delivery' &&
      Array.isArray(order.delivery_photos) &&
      order.delivery_photos.length > 0
        ? order.delivery_photos
        : order.pickup_photos;
    if (!Array.isArray(featuredPhotos) || featuredPhotos.length === 0) {
      setLocalError('Upload at least one pickup or delivery photo before featuring this booking.');
      return;
    }
    await onSave({
      featured_on_website: true,
      featured_title: form.featured_title.trim(),
      featured_caption: form.featured_caption.trim() || null,
      featured_image_type: form.featured_image_type,
      featured_at: order.featured_at || new Date().toISOString(),
    });
  }, [form, order, onSave]);

  // Unpublishes using the order's own last-saved values, never whatever is
  // currently (possibly mid-edit) in `form` — Remove from Website is a
  // distinct action, not a side effect of an in-progress edit.
  const handleRemove = useCallback(async () => {
    await onSave({
      featured_on_website: false,
      featured_title: order.featured_title ?? null,
      featured_caption: order.featured_caption ?? null,
      featured_image_type: order.featured_image_type ?? 'pickup',
      featured_at: null,
    });
    setShowRemoveConfirm(false);
  }, [order, onSave]);

  if (!isOpen || !order) return null;

  const hasPickup = resolvedPickupPhotos.length > 0;
  const hasDelivery = resolvedDeliveryPhotos.length > 0;
  // Mirrors get_featured_deliveries()'s own CASE logic exactly (delivery
  // photo only when the type is 'delivery' AND one exists, pickup
  // otherwise) — this is the literal photo that would go public, not an
  // approximation.
  const previewPhotoUrl = form.featured_image_type === 'delivery' && hasDelivery
    ? resolvedDeliveryPhotos[0]
    : resolvedPickupPhotos[0] || null;

  const modalContent = (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="feature-shipment-modal-title"
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
    >
      <FocusTrap active={isOpen}>
        <div
          className="modal modal-lg"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="modal-header flex items-center justify-between">
            <h2 id="feature-shipment-modal-title" className="flex items-center gap-8 m-0" style={{ fontSize: 'var(--text-16)' }}>
              <Star size={16} className="text-warning" />
              {isAlreadyFeatured ? 'Manage Featured Shipment' : 'Feature Delivery on Website'}
            </h2>
            <button
              type="button"
              className="btn-icon btn-ghost"
              aria-label="Close feature shipment modal"
              onClick={onClose}
              disabled={saving}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>

          {/* Body */}
          <div className="modal-body">

            {/* Tracking number context */}
            <p className="text-xs text-tertiary mb-16">
              Booking <strong>{order.tracking_number}</strong> · {order.receiver_city}, {order.receiver_province}
            </p>

            <div className="fs-modal-grid">
              <div>
                <div className="form-group">
                  <label className="form-label" htmlFor="fs-featured-title">
                    Title <span className="text-error">*</span>
                  </label>
                  <input
                    id="fs-featured-title"
                    type="text"
                    className="form-input"
                    placeholder="e.g. Bound for Jagna"
                    value={form.featured_title}
                    onChange={(e) => setForm((f) => ({ ...f, featured_title: e.target.value }))}
                    disabled={saving}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="fs-featured-caption">Caption</label>
                  <textarea
                    id="fs-featured-caption"
                    className="form-textarea"
                    rows={2}
                    placeholder="Thank you for trusting CargoExpress PH…"
                    value={form.featured_caption}
                    onChange={(e) => setForm((f) => ({ ...f, featured_caption: e.target.value }))}
                    disabled={saving}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="fs-featured-image">Featured Photo</label>
                  <CustomSelect
                    id="fs-featured-image"
                    className="form-select"
                    value={form.featured_image_type}
                    onChange={(e) => setForm((f) => ({ ...f, featured_image_type: e.target.value }))}
                    disabled={saving}
                  >
                    {hasPickup && <option value="pickup">Use Pickup Proof</option>}
                    {hasDelivery && <option value="delivery">Use Delivery Proof</option>}
                  </CustomSelect>
                </div>
              </div>

              {/* Preview — the literal card that would go public, so the
                  admin can check the photo for a shipping label, a visible
                  address, or anything else personal before publishing.
                  This is a manual look, not an automatic scan. */}
              <div
                className="fs-modal-preview p-10"
                style={{
                  background: 'var(--primary-bg)',
                  border: '1px solid var(--primary-light)',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <div className="flex items-center gap-6 mb-8">
                  <Globe size={13} className="text-primary flex-shrink-0" />
                  <span className="text-xs font-semibold text-secondary">Public shipment card preview</span>
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
                    <strong>{form.featured_title || '(title required)'}</strong>
                    {form.featured_caption && (
                      <><br />{form.featured_caption.slice(0, 90)}{form.featured_caption.length > 90 ? '…' : ''}</>
                    )}
                    <br />
                    {order.receiver_city}{order.receiver_province ? `, ${order.receiver_province}` : ''}
                  </span>
                </div>
              </div>
            </div>

            {localError && (
              <p className="text-xs text-error mt-12" role="alert">{localError}</p>
            )}
          </div>

          {/* Footer */}
          <div className="modal-footer fs-modal-footer">
            {isAlreadyFeatured && (
              <button
                type="button"
                className="btn btn-ghost text-error fs-remove-btn"
                onClick={() => setShowRemoveConfirm(true)}
                disabled={saving}
              >
                Remove from Website
              </button>
            )}
            <div className="fs-modal-footer-actions">
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
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? (
                  <><Loader size={14} className="animate-spin" /> Saving…</>
                ) : isAlreadyFeatured ? 'Save Changes' : 'Publish'}
              </button>
            </div>
          </div>
        </div>
      </FocusTrap>

      <ConfirmModal
        isOpen={showRemoveConfirm}
        onClose={() => setShowRemoveConfirm(false)}
        onConfirm={handleRemove}
        title="Remove from Website?"
        message="This unpublishes the shipment from the public Featured Shipments gallery. The delivery photo and booking are kept — nothing is deleted."
        confirmLabel="Remove from Website"
        variant="danger"
        loading={saving}
      />
    </div>
  );

  return createPortal(modalContent, document.body);
};

export default FeatureShipmentModal;
