import { Truck } from 'lucide-react';
import { tripCapacityState } from '../../constants/status';

/**
 * `maxCapacity` is the trip's PLANNED capacity — the figure the admin typed
 * when creating it. The bar and the percentage are still measured against it,
 * because that is what they are planning to. The absolute ceiling (planned +
 * 200 kg allowance) is shown alongside as its own figure: two different
 * questions ("how full is the van" / "can this trip still take a booking")
 * deserve two answers, and collapsing them into one number is what would make
 * a trip look 79% full while actually being closed.
 */
const CapacityTracker = ({ currentWeight = 0, maxCapacity = 1000, tripNumber = '', showLabel = true }) => {
  const percent = maxCapacity > 0 ? (currentWeight / maxCapacity) * 100 : 0;
  // Ensure the progress bar doesn't overflow visually, but keep the actual percent for text display
  const barPercent = Math.min(100, percent);
  const remaining = Math.max(0, maxCapacity - currentWeight);
  const cap = tripCapacityState({ capacity: maxCapacity }, currentWeight);

  let status, statusKey;

  // FULL outranks every other label: it is the only one that changes what the
  // admin is allowed to do, not just how worried they should be.
  if (cap.isFull) {
    status = 'FULL';
    statusKey = 'critical';
  } else if (percent > 100) {
    status = 'OVER CAPACITY';
    statusKey = 'critical';
  } else if (percent >= 91) {
    status = 'CRITICAL'; 
    statusKey = 'critical';
  } else if (percent >= 76) {
    status = 'HIGH'; 
    statusKey = 'high';
  } else if (percent >= 51) {
    status = 'MEDIUM'; 
    statusKey = 'medium';
  } else {
    status = 'SAFE'; 
    statusKey = 'safe';
  }

  return (
    <div className="capacity-tracker">
      {showLabel && (
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-6">
            <Truck size={14} color="var(--text-secondary)" />
            <span className="text-sm fw-700">
              Trip Capacity
            </span>
            {tripNumber && (
              <span className="badge badge-sm badge-default rounded-full">
                {tripNumber}
              </span>
            )}
          </div>
          <span className={`capacity-status-badge status-${statusKey}`}>
            {status}
          </span>
        </div>
      )}

      <div
        className="capacity-bar"
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Trip capacity: ${percent.toFixed(1)}% used, status ${status}`}
      >
        <div
          className={`capacity-fill fill-${statusKey} ${percent > 100 ? 'danger' : ''}`}
          style={{ width: `${barPercent}%` }}
        />
      </div>

      <div className="flex justify-between mt-8 text-xs text-secondary">
        <div className="flex flex-col gap-2">
          <span className="fw-600">{currentWeight.toFixed(1)} kg loaded</span>
          <span>{percent.toFixed(1)}% Usage</span>
        </div>
        <div className="flex flex-col gap-2 items-end">
          <span className="fw-600">{maxCapacity} kg planned</span>
          {cap.hasLimit
            ? <span>Max allowance: {cap.max} kg</span>
            : <span>{remaining.toFixed(1)} kg remaining</span>}
        </div>
      </div>
      {cap.hasLimit && (
        <div className="text-xs text-tertiary mt-4">
          Booked: {currentWeight.toFixed(1)} / {cap.base} kg
          {cap.isFull
            ? ' — at the maximum allowance. No further bookings can be accepted.'
            : ` — ${cap.remaining.toFixed(1)} kg left before the ${cap.max} kg maximum.`}
        </div>
      )}
      {cap.isOverPlanned && !cap.isFull && (
        <div className="capacity-note">
          Review assigned cargo. This trip is above planned van capacity and is
          now using the {cap.allowance} kg allowance.
        </div>
      )}
      {cap.isFull && (
        <div className="capacity-note">
          This trip is FULL at its {cap.max} kg maximum ({cap.base} kg planned +
          {' '}{cap.allowance} kg allowance). Assign further bookings to another trip.
        </div>
      )}
    </div>
  );
};

export default CapacityTracker;
