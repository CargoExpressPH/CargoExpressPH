import React, { useState, useEffect, useRef } from 'react';

/**
 * AnimatedCounter — Smooth number counting animation for dashboard stats.
 * Uses requestAnimationFrame with easeOutExpo easing for a premium feel.
 *
 * @param {number} value     - Target numeric value to animate to
 * @param {number} duration  - Animation duration in ms (default 1000)
 * @param {string} prefix    - String prefix, e.g. "₱" for currency
 * @param {string} suffix    - String suffix, e.g. "kg" for weight
 * @param {number} decimals  - Decimal places to display (default 0)
 * @param {string} className - Additional CSS classes
 */
const AnimatedCounter = ({
  value,
  duration = 1000,
  prefix = '',
  suffix = '',
  decimals = 0,
  className = '',
}) => {
  const [display, setDisplay] = useState(0);
  const prevValue = useRef(0);
  const rafId = useRef(null);

  useEffect(() => {
    const start = prevValue.current;
    const end = value;
    const startTime = performance.now();

    // easeOutExpo — fast start, smooth deceleration
    const easeOutExpo = (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

    const animate = (currentTime) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const easedProgress = easeOutExpo(progress);
      const current = start + (end - start) * easedProgress;

      setDisplay(current);

      if (progress < 1) {
        rafId.current = requestAnimationFrame(animate);
      }
    };

    // Cancel any in-flight animation before starting a new one
    if (rafId.current) {
      cancelAnimationFrame(rafId.current);
    }

    rafId.current = requestAnimationFrame(animate);
    prevValue.current = end;

    return () => {
      if (rafId.current) {
        cancelAnimationFrame(rafId.current);
      }
    };
  }, [value, duration]);

  /**
   * Format the display number with locale-aware thousand separators.
   */
  const formattedValue = display.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  return (
    <span className={`animated-counter ${className}`}>
      {prefix}
      {formattedValue}
      {suffix && <span className="animated-counter-suffix">{suffix}</span>}
    </span>
  );
};

export default AnimatedCounter;
