import React, { useEffect, useRef } from 'react';
import { AlertTriangle, Info, CheckCircle, Loader } from 'lucide-react';
import FocusTrap from './FocusTrap';

/**
 * Resolves the default icon based on variant.
 */
const variantIcons = {
  danger: AlertTriangle,
  warning: AlertTriangle,
  info: Info,
  success: CheckCircle,
};

/**
 * ConfirmModal — Premium confirmation modal replacing native confirm() dialogs.
 *
 * @param {boolean}   isOpen        - Whether the modal is visible
 * @param {function}  onClose       - Called when the modal is dismissed
 * @param {function}  onConfirm     - Called when the confirm action is triggered
 * @param {string}    title         - Modal title
 * @param {string}    message       - Modal body message
 * @param {string}    confirmLabel  - Label for the confirm button (default "Confirm")
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
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  loading = false,
  icon,
}) => {
  const modalRef = useRef(null);

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

  // Auto-focus the modal for screen readers
  useEffect(() => {
    if (isOpen && modalRef.current) {
      modalRef.current.focus();
    }
  }, [isOpen]);

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

  return (
    <FocusTrap active={isOpen}>
      <div
        className="modal-overlay"
        onClick={handleOverlayClick}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby="confirm-modal-message"
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

          <h3 id="confirm-modal-title" className="confirm-modal-title">
            {title}
          </h3>

          <p id="confirm-modal-message" className="confirm-modal-message">
            {message}
          </p>

          <div className="confirm-modal-actions">
            <button
              className="btn btn-outline"
              onClick={onClose}
              disabled={loading}
              type="button"
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
    </FocusTrap>
  );
};

export default ConfirmModal;
