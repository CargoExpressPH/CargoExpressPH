import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Info, CheckCircle, Loader, LogOut } from 'lucide-react';
import FocusTrap from './FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';

/**
 * Resolves the default icon based on variant.
 */
const variantIcons = {
  danger: AlertTriangle,
  warning: AlertTriangle,
  info: Info,
  success: CheckCircle,
  secondary: LogOut,
  primary: LogOut,
};

/**
 * ConfirmModal — Premium confirmation modal replacing native confirm() dialogs.
 *
 * @param {boolean}   isOpen        - Whether the modal is visible
 * @param {function}  onClose       - Called when the modal is dismissed
 * @param {function}  onConfirm     - Called when the confirm action is triggered
 * @param {string}    title         - Modal title
 * @param {string}    message       - Modal body message
 * @param {string}    confirmLabel  - Label for the confirm button (default "Confirm"). Alias: confirmText
 * @param {string}    confirmText   - Alias for confirmLabel; used when either prop is provided
 * @param {string}    cancelLabel   - Label for the cancel button (default "Cancel")
 * @param {string}    variant       - Visual variant: "danger" | "warning" | "info" | "success"
 * @param {boolean}   loading       - Disables confirm button and shows spinner
 * @param {Component} icon          - Optional lucide icon override
 */
const ConfirmModal = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel: confirmLabelProp,
  confirmText,
  cancelLabel = 'Cancel',
  variant = 'danger',
  loading = false,
  icon,
}) => {
  // Support both confirmLabel and confirmText props (callers use either)
  const confirmLabel = confirmLabelProp || confirmText || 'Confirm';
  const modalRef = useRef(null);
  const cancelRef = useRef(null);
  const titleId = useId();
  const messageId = useId();

  // Escape key handler — uses document-level listener so it works
  // regardless of focus state (the onKeyDown on div was unreliable)
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e) => {
      if (e.key === 'Escape' && !loading) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, loading, onClose]);

  // Auto-focus the Cancel button for screen readers (least-destructive action per WAI-ARIA APG)
  useEffect(() => {
    if (isOpen && cancelRef.current) {
      cancelRef.current.focus();
    }
  }, [isOpen]);

  useScrollLock(isOpen);

  if (!isOpen) return null;

  const Icon = icon || variantIcons[variant] || Info;

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handleConfirm = () => {
    if (!loading && onConfirm) {
      onConfirm();
    }
  };

  // Rendered into <body>, NOT in place. `position: fixed` is only relative to
  // the viewport while no ancestor is transformed — and every page here sits
  // inside <PageTransition>, a framer-motion element whose variants animate `y`.
  // That transform makes it a stacking context, so an in-place overlay is
  // confined to it and paints *below* `.customer-bottom-nav`, a later sibling
  // at z-index 200. No z-index on the overlay can escape that: on mobile the
  // tab bar covered the modal's own Stay/Discard buttons. Portalling to body
  // puts the overlay back in the root stacking context, where its z-index means
  // what it says. Events still bubble through the React tree, so onClose,
  // FocusTrap and the scroll lock are unaffected.
  return createPortal(
    <FocusTrap active={isOpen}>
      <div
        className="modal-overlay"
        onClick={handleOverlayClick}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
      >
        <div
          className="confirm-modal"
          onClick={(e) => e.stopPropagation()}
          ref={modalRef}
          tabIndex={-1}
        >
          <div className={`confirm-modal-icon ${variant}`}>
            <Icon size={28} strokeWidth={2} />
          </div>

          <h3 id={titleId} className="confirm-modal-title">
            {title}
          </h3>

          <p id={messageId} className="confirm-modal-message">
            {message}
          </p>

          <div className="confirm-modal-actions">
            <button
              className="btn btn-outline"
              onClick={onClose}
              disabled={loading}
              type="button"
              ref={cancelRef}
            >
              {cancelLabel}
            </button>
            <button
              className={`btn btn-${variant}`}
              onClick={handleConfirm}
              disabled={loading}
              type="button"
            >
              {loading && <Loader className="animate-spin" size={16} />}
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </FocusTrap>,
    document.body
  );
};

export default ConfirmModal;
