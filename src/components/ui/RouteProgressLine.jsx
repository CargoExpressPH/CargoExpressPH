import { ORDER_STATUS, routeProgressPercent } from '../../constants/status';

/**
 * Origin → destination line on customer booking cards. The filled part and
 * the dot show how far the cargo has actually travelled; before pickup the
 * dot sits at the origin, and a cancelled booking shows an empty line.
 * Decorative only — the status badge beside it carries the meaning.
 */
const RouteProgressLine = ({ status }) => {
  const cancelled = status === ORDER_STATUS.CANCELLED;
  const progress = cancelled ? 0 : routeProgressPercent(status);

  return (
    <div className="customer-route-line-wrap" aria-hidden="true">
      <div
        className={`customer-route-line${cancelled ? ' is-cancelled' : ''}`}
        style={{ '--route-progress': `${progress}%` }}
      >
        <div className="customer-route-fill" />
        <div className="customer-route-arrow" />
      </div>
    </div>
  );
};

export default RouteProgressLine;
