import { useState, useEffect, useRef } from 'react';

/**
 * MiniBarChart — Animated vertical bar chart
 *
 * @param {Array}  bars       – [{ label, value, color? }]
 * @param {number} height     – Chart height in px (default 160)
 * @param {string} valuePrefix – Prefix for tooltip values (e.g. '₱')
 * @param {string} color      – Default bar color (default primary)
 * @param {boolean} animate   – Animate on mount (default true)
 * @param {boolean} showValues – Show values above bars (default false)
 */
const MiniBarChart = ({
  bars = [],
  height = 160,
  valuePrefix = '',
  color = 'var(--primary)',
  animate = true,
  showValues = false,
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

  const maxVal = Math.max(...bars.map(b => b.value || 0), 1);

  if (bars.length === 0) {
    return (
      <div className="bar-chart-empty" style={{ height }}>
        <span>No data</span>
      </div>
    );
  }

  const barWidth = Math.min(40, Math.max(14, Math.floor(280 / bars.length)));
  const gap = Math.min(12, Math.max(4, Math.floor(120 / bars.length)));

  return (
    <div className="bar-chart-wrap">
      <div className="bar-chart-container" style={{ height }}>
        {/* Horizontal grid lines */}
        <div className="bar-chart-grid" aria-hidden="true">
          {[0.25, 0.5, 0.75, 1].map((pct) => (
            <div
              key={pct}
              className="bar-chart-grid-line"
              style={{ bottom: `${pct * 100}%` }}
            />
          ))}
        </div>

        {/* Bars */}
        <div className="bar-chart-bars" style={{ gap }} role="img" aria-label="Bar chart">
          {bars.map((bar, i) => {
            const pct = (bar.value / maxVal) * 100;
            const isHovered = hoveredIdx === i;
            return (
              <div
                key={i}
                className={`bar-chart-col ${isHovered ? 'hovered' : ''}`}
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(null)}
              >
                {/* Tooltip */}
                {isHovered && (
                  <div className="bar-chart-tooltip">
                    <span className="bar-chart-tooltip-value">
                      {valuePrefix}{(bar.value || 0).toLocaleString()}
                    </span>
                    <span className="bar-chart-tooltip-label">{bar.label}</span>
                  </div>
                )}

                {/* Value above bar */}
                {showValues && !isHovered && (
                  <div className="bar-chart-value-label">
                    {valuePrefix}{bar.value >= 1000
                      ? `${(bar.value / 1000).toFixed(bar.value >= 10000 ? 0 : 1)}k`
                      : bar.value.toLocaleString()}
                  </div>
                )}

                {/* Bar */}
                <div
                  className="bar-chart-bar"
                  style={{
                    width: barWidth,
                    height: mounted ? `${Math.max(2, pct)}%` : '0%',
                    background: bar.color || color,
                    transitionDelay: mounted ? `${i * 0.05}s` : '0s',
                  }}
                  role="presentation"
                />

                {/* Label */}
                <span className="bar-chart-label" title={bar.label}>
                  {bar.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default MiniBarChart;
