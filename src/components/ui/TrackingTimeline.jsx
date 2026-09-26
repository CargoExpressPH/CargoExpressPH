import { STATUS_TIMELINE } from '../../constants/status';
import { formatPhDate, formatPhDateTime } from '../../utils/datetime';
import { Check, Package, ClipboardCheck, Truck, Building2, Bike, CheckCircle } from 'lucide-react';

const STEP_ICONS = {
  'Pending Review': ClipboardCheck,
  'Pending': ClipboardCheck,
  'Assigned': Package,
  'Picked Up': Package,
  'In Transit': Truck,
  'Arrived at Hub': Building2,
  'Out for Delivery': Bike,
  'Delivered': CheckCircle,
};

/**
 * TrackingTimeline
 *
 * Renders the linear shipment status flow.
 *
 * Props:
 *   currentStatus   — one of STATUS_TIMELINE values (or 'Cancelled')
 *   compact         — (legacy) renders in a tighter layout
 *   stepTimestamps  — OPTIONAL { [status]: ISO-string } map. When provided,
 *                     each step shows the date/time it was reached. When
 *                     omitted (public/customer pages), no timestamps render.
 */
const TrackingTimeline = ({ currentStatus, compact = false, stepTimestamps = null }) => {
  const currentIdx = STATUS_TIMELINE.indexOf(currentStatus);
  const isCancelled = currentStatus === 'Cancelled';

  // { date: "Jul 19", time: "2:30 PM" } in Manila time, whatever zone the
  // viewer's device is set to. Date and time render on separate lines so
  // neighbouring steps in the horizontal layout never run into each other.
  // Returns null for missing/invalid input.
  const formatStepTime = (iso) => {
    if (!iso || (typeof iso !== 'string' && typeof iso !== 'number')) return null;
    if (Number.isNaN(Date.parse(iso))) return null;
    try {
      return {
        date: formatPhDate(iso, { year: undefined }),
        time: formatPhDateTime(iso, { year: undefined, month: undefined, day: undefined, hour: 'numeric' }),
      };
    } catch {
      return null;
    }
  };

  return (
    <ol
      className={`status-timeline status-timeline-track ${compact ? 'status-timeline-compact' : ''}`}
      aria-label="Shipment status timeline"
    >
      {STATUS_TIMELINE.map((status, index) => {
          const isCompleted = !isCancelled && index < currentIdx;
          const isActive = !isCancelled && index === currentIdx;
          const StepIcon = STEP_ICONS[status] || Package;

          const stepClass = [
            'status-timeline-step',
            isCompleted ? 'completed' : '',
            isActive ? 'active' : '',
          ].filter(Boolean).join(' ');

          const rawTs = stepTimestamps && typeof stepTimestamps === 'object' ? stepTimestamps[status] : null;
          const tsLabel = rawTs ? formatStepTime(rawTs) : null;

          return (
            <li
              key={status}
              className={stepClass}
              aria-current={isActive ? 'step' : undefined}
            >
              {index < STATUS_TIMELINE.length - 1 && <div className="status-timeline-line" aria-hidden="true" />}

              <div className="status-timeline-node">
                {isCompleted ? (
                  <Check size={14} strokeWidth={3} />
                ) : (
                  <StepIcon size={isActive ? 16 : 13} strokeWidth={isActive ? 2.5 : 2} />
                )}
              </div>

              <div className="status-timeline-text">
                <div className="status-timeline-label">
                  {status}
                </div>
                {tsLabel && (
                  <time className="status-timeline-time" dateTime={typeof rawTs === 'string' ? rawTs : undefined}>
                    <span>{tsLabel.date}</span>
                    <span>{tsLabel.time}</span>
                  </time>
                )}
              </div>
            </li>
          );
        })}
    </ol>
  );
};

export default TrackingTimeline;
