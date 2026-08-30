import React from 'react';
import { Loader } from 'lucide-react';

/**
 * CenteredSpinner — A single centered spinning circle used for all loading /
 * fetching states across the app, replacing the old skeleton placeholders.
 * @param {number} size - Icon size in pixels (default 32)
 */
export const CenteredSpinner = ({ size = 32 }) => (
  <div
    className="flex-center"
    role="status"
    aria-busy="true"
    aria-label="Loading"
    style={{ padding: '40px 20px' }}
  >
    <Loader size={size} className="text-primary animate-spin" />
  </div>
);

export default CenteredSpinner;
