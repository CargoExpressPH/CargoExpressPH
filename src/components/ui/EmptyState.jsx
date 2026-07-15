import React from 'react';
import { Package } from 'lucide-react';

/**
 * EmptyState — Premium empty state placeholder with icon, messaging, and optional action.
 *
 * @param {Component} icon         - Lucide icon component (default Package)
 * @param {string}    title        - Primary heading text
 * @param {string}    description  - Supporting description text
 * @param {string}    actionLabel  - Label for the CTA button
 * @param {function}  onAction     - Handler for the CTA button
 * @param {string}    className    - Additional CSS classes
 */
const EmptyState = ({
  icon: Icon = Package,
  title,
  description,
  actionLabel,
  onAction,
  className,
}) => (
  <div className={`empty-state-premium ${className || ''}`}>
    <div className="empty-state-icon-wrap">
      <Icon size={48} strokeWidth={1.5} aria-hidden="true" />
    </div>

    <h3 className="empty-state-title">{title}</h3>

    {description && (
      <p className="empty-state-description">{description}</p>
    )}

    {actionLabel && onAction && (
      <button className="btn btn-primary" onClick={onAction} type="button">
        {actionLabel}
      </button>
    )}
  </div>
);

export default EmptyState;
