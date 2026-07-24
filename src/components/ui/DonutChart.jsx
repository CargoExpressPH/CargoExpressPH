import { useState, useEffect, useRef } from 'react';

/**
 * DonutChart — Animated SVG donut/ring chart
 *
 * @param {Array}  segments   – [{ label, value, color }]
 * @param {number} size       – Outer diameter in px (default 180)
 * @param {number} thickness  – Ring thickness in px (default 28)
 * @param {string} centerLabel – Text inside the ring (e.g. total)
 * @param {string} centerSub   – Small sub-label below center
 * @param {boolean} showLegend – Show legend below chart (default true)
 * @param {boolean} animate    – Animate on mount (default true)
 */
const DonutChart = ({
  segments = [],
  size = 180,
  thickness = 28,
  centerLabel,
  centerSub,
  title,
  showLegend = true,
  animate = true,
}) => {
  const [mounted, setMounted] = useState(!animate);
  const [hoveredIdx, setHoveredIdx] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (animate) {
      timerRef.current = setTimeout(() => setMounted(true), 60);
      return () => clearTimeout(timerRef.current);
    }
  }, [animate]);

  const total = segments.reduce((sum, s) => sum + (s.value || 0), 0);
  if (total === 0) {
    return (
      <div className="donut-chart-empty" style={{ width: size, height: size }}>
        <span>No data</span>
      </div>
    );
  }

  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  let accumulated = 0;
  const arcs = segments
    .filter(s => s.value > 0)
    .map((seg, i) => {
      const pct = seg.value / total;
      const dashLength = pct * circumference;
      const dashOffset = mounted ? -(accumulated * circumference) : circumference;
      accumulated += pct;
      return { ...seg, pct, dashLength, dashOffset, index: i };
    });

  const chartSummary = title || `Donut chart displaying ${segments.length} segments with total value of ${total.toLocaleString()}`;

  const toggleSegment = (i) => {
    setHoveredIdx(prev => (prev === i ? null : i));
  };

  const onSegmentKeyDown = (e, i) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleSegment(i);
    }
  };

  return (
    <div className="donut-chart-wrap">
      <div className="donut-chart-svg-wrap" style={{ width: size, height: size }}>
        {/*
          role="group" (not "img") so nested focusable arcs are valid.
          Do NOT set aria-hidden on this SVG — focusable descendants would be
          hidden from AT while still tabbable (WCAG failure).
        */}
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="donut-chart-svg"
          role="group"
          aria-label={chartSummary}
        >
          {/* Background ring */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="var(--border)"
            strokeWidth={thickness}
            opacity={0.5}
            aria-hidden="true"
          />
          {/* Data arcs — keyboard + pointer highlight */}
          {arcs.map((arc, i) => (
            <circle
              key={i}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={arc.color}
              strokeWidth={hoveredIdx === i ? thickness + 4 : thickness}
              strokeDasharray={`${arc.dashLength} ${circumference - arc.dashLength}`}
              strokeDashoffset={mounted ? arc.dashOffset : circumference}
              strokeLinecap="butt"
              className={`donut-chart-arc${hoveredIdx === i ? ' is-active' : ''}`}
              style={{
                transform: 'rotate(-90deg)',
                transformOrigin: '50% 50%',
                transition: mounted
                  ? `stroke-dashoffset 0.8s cubic-bezier(0.4, 0, 0.2, 1) ${i * 0.1}s, stroke-width 0.2s ease`
                  : 'none',
              }}
              tabIndex={0}
              role="button"
              aria-label={`${arc.label}: ${arc.value.toLocaleString()}`}
              aria-pressed={hoveredIdx === i}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              onFocus={() => setHoveredIdx(i)}
              onBlur={() => setHoveredIdx(null)}
              onKeyDown={(e) => onSegmentKeyDown(e, i)}
            />
          ))}
        </svg>
        {/* Center text is visual-only; labels live on arcs/legend. */}
        {(centerLabel || centerSub) && (
          <div className="donut-chart-center" aria-hidden="true">
            {hoveredIdx !== null ? (
              <>
                <span className="donut-chart-center-value">{arcs[hoveredIdx]?.value?.toLocaleString()}</span>
                <span className="donut-chart-center-sub">{arcs[hoveredIdx]?.label}</span>
              </>
            ) : (
              <>
                {centerLabel && <span className="donut-chart-center-value">{centerLabel}</span>}
                {centerSub && <span className="donut-chart-center-sub">{centerSub}</span>}
              </>
            )}
          </div>
        )}
      </div>

      {/* Legend — native buttons (Enter/Space → click; no extra key handler) */}
      {showLegend && (
        <div className="donut-chart-legend">
          {arcs.map((arc, i) => (
            <button
              key={i}
              type="button"
              aria-pressed={hoveredIdx === i}
              aria-label={`${arc.label}: ${arc.value.toLocaleString()} (${(arc.pct * 100).toFixed(0)}%)`}
              className={`donut-chart-legend-item${hoveredIdx === i ? ' active' : ''}`}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              onFocus={() => setHoveredIdx(i)}
              onBlur={() => setHoveredIdx(null)}
              onClick={() => toggleSegment(i)}
            >
              <span className="donut-chart-legend-dot" style={{ background: arc.color }} aria-hidden="true" />
              <span className="donut-chart-legend-label">{arc.label}</span>
              <span className="donut-chart-legend-value">
                {arc.value.toLocaleString()}
                <span className="donut-chart-legend-pct">({(arc.pct * 100).toFixed(0)}%)</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default DonutChart;
