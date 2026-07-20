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
 *                     Currently only the admin order detail page passes this,
 *                     since activity_logs (the data source) is admin-only (RLS).
 *
 * Accessibility:
 *   Rendered as an ordered list (<ol>/<li>) with aria-current="step" on the
 *   active node so screen readers announce the progression.
 */
const TrackingTimeline = ({ currentStatus, compact = false, stepTimestamps = null }) => {
  const currentIdx = STATUS_TIMELINE.indexOf(currentStatus);
  const isCancelled = currentStatus === 'Cancelled';

  // Format an ISO string into a compact "Jul 19 · 2:30 PM" label.
  // Returns null for missing/invalid input so the caller can skip rendering.
  const formatStepTime = (iso) => {
    if (!iso) return null;
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return null;
    const d = new Date(ts);
    const date = d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
    return `${date} · ${time}`;
  };

  return (
    <ol
      className={`status-timeline ${compact ? 'status-timeline-compact' : ''}`}
      aria-label="Shipment status timeline"
    >
      <div className="status-timeline-track">
        {STATUS_TIMELINE.map((status, index) => {
          // Bug fix: previously `cancelled` was applied to EVERY step when the
          // order was cancelled, recoloring already-completed steps red.
          // Correct semantics: only mark steps that had genuinely been reached
          // (index < currentIdx) as completed; cancelled state only recolors
          // when there is no progress (currentIdx === -1).
          const isCompleted = !isCancelled && index < currentIdx;
          const isActive = !isCancelled && index === currentIdx;
          const StepIcon = STEP_ICONS[status] || Package;

          const stepClass = [
            'status-timeline-step',
            isCompleted ? 'completed' : '',
            isActive ? 'active' : '',
          ].filter(Boolean).join(' ');

          const tsLabel = stepTimestamps ? formatStepTime(stepTimestamps[status]) : null;

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
                  <time className="status-timeline-time" dateTime={stepTimestamps[status]}>
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
