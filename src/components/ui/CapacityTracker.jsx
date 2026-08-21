import { Truck } from 'lucide-react';

const CapacityTracker = ({ currentWeight = 0, maxCapacity = 1000, tripNumber = '', showLabel = true }) => {
  const percent = maxCapacity > 0 ? (currentWeight / maxCapacity) * 100 : 0;
  // Ensure the progress bar doesn't overflow visually, but keep the actual percent for text display
  const barPercent = Math.min(100, percent);
  const remaining = Math.max(0, maxCapacity - currentWeight);

  let status, statusKey;
  
  if (percent > 100) {
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
          <span className="fw-600">{maxCapacity} kg max</span>
          <span>{remaining.toFixed(1)} kg remaining</span>
        </div>
      </div>
      {percent > 100 && (
        <div className="capacity-note">
          Review assigned cargo. This trip is above planned van capacity.
        </div>
      )}
    </div>
  );
};

export default CapacityTracker;
