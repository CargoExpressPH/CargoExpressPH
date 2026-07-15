import { Truck } from 'lucide-react';

const CapacityTracker = ({ currentWeight = 0, maxCapacity = 1000, tripNumber = '', showLabel = true }) => {
  const percent = maxCapacity > 0 ? (currentWeight / maxCapacity) * 100 : 0;
  // Ensure the progress bar doesn't overflow visually, but keep the actual percent for text display
  const barPercent = Math.min(100, percent);
  const remaining = Math.max(0, maxCapacity - currentWeight);

  let status, statusColor, barColor;
  
  if (percent > 100) {
    status = 'OVER CAPACITY';
    statusColor = 'var(--capacity-critical-text)';
    barColor = 'var(--capacity-critical-bar)';
  } else if (percent >= 91) {
    status = 'CRITICAL'; 
    statusColor = 'var(--capacity-critical-text)';
    barColor = 'var(--capacity-critical-bar)';
  } else if (percent >= 76) {
    status = 'HIGH'; 
    statusColor = 'var(--capacity-high-text)';
    barColor = 'var(--capacity-high-bar)';
  } else if (percent >= 51) {
    status = 'MEDIUM'; 
    statusColor = 'var(--capacity-medium-text)';
    barColor = 'var(--capacity-medium-bar)';
  } else {
    status = 'SAFE'; 
    statusColor = 'var(--capacity-safe-text)';
    barColor = 'var(--capacity-safe-bar)';
  }

  return (
    <div className="capacity-tracker">
      {showLabel && (
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-6">
            <Truck size={14} color="var(--text-secondary)" />
            <span className="text-sm fw-700">
              Van Capacity
            </span>
            {tripNumber && (
              <span className="rounded-full text-xs text-tertiary fw-600" style={{
                background: 'var(--bg-secondary)', padding: '2px 8px',
              }}>
                {tripNumber}
              </span>
            )}
          </div>
          <span className="rounded-full text-xs fw-700" style={{
            padding: '3px 10px',
            background: `color-mix(in srgb, ${statusColor} 12%, transparent)`,
            color: statusColor,
            letterSpacing: '0.05em',
          }}>
            {status}
          </span>
        </div>
      )}

      <div
        className="capacity-bar overflow-hidden"
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Van capacity: ${percent.toFixed(1)}% used, status ${status}`}
        style={{ height: 14, borderRadius: 7, background: 'var(--bg-secondary)' }}
      >
        <div
          className={`capacity-fill ${percent > 100 ? 'danger' : ''}`}
          style={{ width: `${barPercent}%`, height: '100%', background: barColor, transition: 'width 0.5s ease-out, background-color 0.5s ease-out' }}
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
