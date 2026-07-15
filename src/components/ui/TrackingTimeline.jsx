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

const TrackingTimeline = ({ currentStatus, compact = false }) => {
  const currentIdx = STATUS_TIMELINE.indexOf(currentStatus);
  const isCancelled = currentStatus === 'Cancelled';

  return (
    <div className={`status-timeline ${compact ? 'status-timeline-compact' : ''}`}>
      <div className="status-timeline-track">
        {STATUS_TIMELINE.map((status, index) => {
          const isCompleted = index < currentIdx;
          const isActive = index === currentIdx;
          const StepIcon = STEP_ICONS[status] || Package;

          const stepClass = [
            'status-timeline-step',
            isCompleted ? 'completed' : '',
            isActive ? 'active' : '',
            isCancelled ? 'cancelled' : '',
          ].filter(Boolean).join(' ');

          return (
            <div key={status} className={stepClass}>
              {index < STATUS_TIMELINE.length - 1 && <div className="status-timeline-line" />}

              <div className="status-timeline-node">
                {isCompleted ? (
                  <Check size={14} strokeWidth={3} />
                ) : (
                  <StepIcon size={isActive ? 16 : 13} strokeWidth={isActive ? 2.5 : 2} />
                )}
              </div>

              <div className="status-timeline-label">
                {status}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default TrackingTimeline;
