import { useNavigate } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';

/**
 * "Message this customer" — opens the admin inbox on their support thread,
 * creating it if this is the first contact.
 *
 * The destination is a QUERY PARAM (`/admin/inbox?customerId=…`), not router
 * state. State is invisible in the URL, so a deep link could not be reloaded,
 * shared, or reached with the back button — a reload landed the admin on a
 * plain inbox with no indication of what they had been doing. InboxPage
 * consumes the param and strips it, so it fires once and does not re-open a
 * thread the admin has since navigated away from.
 *
 * Rendered as one component in three places (order detail, unsettled
 * deliveries, trip detail) so the route, the accessible name and the icon
 * cannot drift apart between them.
 *
 * @param {string}  customerId    profiles.id — this is `orders.user_id`,
 *                                NOT a `customer_id` column; orders has none.
 * @param {string}  [customerName] names the button for screen readers
 * @param {boolean} [showLabel]   render the visible "Message" text too
 * @param {string}  [className]   extra classes for the caller's layout
 */
const MessageCustomerButton = ({
  customerId,
  customerName,
  showLabel = false,
  className = '',
}) => {
  const navigate = useNavigate();

  // Nothing to message. Rendering a dead control is worse than rendering none:
  // an order whose customer row was deleted would give a button that opens an
  // empty inbox.
  if (!customerId) return null;

  const who = customerName || 'this customer';

  return (
    <button
      type="button"
      className={`btn btn-ghost btn-sm message-customer-btn ${className}`.trim()}
      onClick={() => navigate(`/admin/inbox?customerId=${encodeURIComponent(customerId)}`)}
      aria-label={`Message ${who}`}
      title={`Message ${who}`}
    >
      <MessageSquare size={14} aria-hidden="true" />
      {showLabel && <span>Message</span>}
    </button>
  );
};

export default MessageCustomerButton;
