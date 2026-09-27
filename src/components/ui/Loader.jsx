import React from 'react';
import { Loader } from 'lucide-react';

/**
 * CenteredSpinner — A single centered spinning circle used for all loading /
 * fetching states across the app, replacing the old skeleton placeholders.
 * @param {number} size - Icon size in pixels (default 32)
 * @param {string|number} [minHeight] - Room to hold for the content that will
 *   replace the spinner, so its arrival does not push the page down.
 */
export const CenteredSpinner = ({ size = 32, minHeight }) => (
  <div
    className="flex-center"
    role="status"
    aria-busy="true"
    aria-label="Loading"
    style={{ padding: '40px 20px', minHeight }}
  >
    <Loader size={size} className="text-primary animate-spin" />
  </div>
);

export default CenteredSpinner;
