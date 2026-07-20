import { STATUS_TIMELINE } from '../../constants/status';
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

  // Format an ISO string into a compact "Jul 19 · 2:30 PM" label.
  // Returns null for missing/invalid input or locale formatting errors.
  const formatStepTime = (iso) => {
    if (!iso || (typeof iso !== 'string' && typeof iso !== 'number')) return null;
    try {
      const ts = Date.parse(iso);
      if (Number.isNaN(ts)) return null;
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return null;

      const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
      return `${date} · ${time}`;
    } catch {
      try {
        const d = new Date(iso);
        return d.toLocaleString();
      } catch {
        return null;
      }
    }
  };

  return (
    <ol
      className={`status-timeline ${compact ? 'status-timeline-compact' : ''}`}
      aria-label="Shipment status timeline"
    >
      <div className="status-timeline-track">
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
                    {tsLabel}
                  </time>
                )}
              </div>
            </li>
          );
        })}
      </div>
    </ol>
  );
};

export default TrackingTimeline;
