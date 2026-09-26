import {
  Bike, Building2, CheckCircle2, ClipboardCheck, Clock, Package, Truck, XCircle,
} from 'lucide-react';
import {
  ORDER_STATUS, STATUS_ICONS, STATUS_TIMELINE, TRACKING_STATUS_TONES, timelineStatus,
} from '../../constants/status';

/**
 * The top of the customer and admin order pages: a panel tinted by the order
 * status, the status itself with its icon, and the route with how far along
 * it the shipment is. Styles: styles/order-detail.css (.od-hero).
 */

const ICONS = {
  clipboardCheck: ClipboardCheck,
  clock: Clock,
  package: Package,
  truck: Truck,
  building: Building2,
  bike: Bike,
  checkCircle: CheckCircle2,
  xCircle: XCircle,
};

/** Status colours as custom properties for the hero panel. */
export const orderToneStyle = (status) => {
  const tone = TRACKING_STATUS_TONES[status];
  if (!tone) return undefined;
  return {
    '--od-tone': tone.text,
    '--od-tone-bg': tone.bg,
    '--od-tone-line': tone.border,
    '--od-tone-icon': tone.iconBg,
  };
};

export const OrderHero = ({ status, className = '', children }) => (
  <section className={`od-hero ${className}`.trim()} style={orderToneStyle(status)}>
    {children}
  </section>
);

/** The status name with its icon. */
export const OrderStatusLine = ({ status }) => {
  const Icon = ICONS[STATUS_ICONS[status]] || Package;
  return (
    <div className="od-status">
      <span className="od-status-icon" aria-hidden="true"><Icon size={22} /></span>
      <strong className="od-status-text">{status}</strong>
    </div>
  );
};

/**
 * Origin and destination with a bar showing how far through the shipment
 * stages the order is. A cancelled order shows the route without progress.
 */
export const OrderRouteProgress = ({ order }) => {
  const cancelled = order.status === ORDER_STATUS.CANCELLED;
  const step = STATUS_TIMELINE.indexOf(timelineStatus(order));
  const progress = cancelled || step < 0 ? 0 : step / (STATUS_TIMELINE.length - 1);
  return (
    <div className={`od-route${cancelled ? ' is-cancelled' : ''}`}>
      <strong className="od-route-end">{order.origin}<span className="sr-only"> to</span></strong>
      <div className="od-route-bar" aria-hidden="true" style={{ '--od-progress': progress }}>
        <span className="od-route-fill" />
        <span className="od-route-dot"><Truck size={13} /></span>
      </div>
      <strong className="od-route-end od-route-end-to">{order.destination}</strong>
    </div>
  );
};
