import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The one filter control for every list (admin Bookings, Trips, Customers,
 * Inquiries; customer Bookings): a single row of pill chips. It used to be
 * chips on desktop and a dropdown on phones, with each page styling its chips
 * differently. Now it is the same chips everywhere; when they do not fit, the
 * row scrolls sideways and fades at whichever edge has more chips behind it,
 * so off-screen options stay discoverable.
 */
const ResponsiveFilterControls = ({
  options,
  value,
  onChange,
  ariaLabel,
  className = '',
}) => {
  const rowRef = useRef(null);
  const [fade, setFade] = useState('none');

  const updateFade = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const maxScroll = row.scrollWidth - row.clientWidth;
    if (maxScroll <= 1) {
      setFade('none');
      return;
    }
    const atStart = row.scrollLeft <= 1;
    const atEnd = row.scrollLeft >= maxScroll - 1;
    setFade(atStart ? 'end' : atEnd ? 'start' : 'both');
  }, []);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    row.addEventListener('scroll', updateFade, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateFade);
    observer?.observe(row);
    return () => {
      row.removeEventListener('scroll', updateFade);
      observer?.disconnect();
    };
  }, [updateFade]);

  // Counts arriving can widen the chips without resizing the row itself.
  useEffect(() => {
    updateFade();
  }, [options, updateFade]);

  // Keep the selected chip in view — a list opened already filtered on a
  // phone would otherwise hide its own selection off-screen. Scrolls the row
  // only, never the page.
  useEffect(() => {
    const row = rowRef.current;
    const active = row?.querySelector('[aria-pressed="true"]');
    if (!row || !active) return;
    const rowBox = row.getBoundingClientRect();
    const chipBox = active.getBoundingClientRect();
    if (chipBox.left < rowBox.left) row.scrollLeft -= rowBox.left - chipBox.left + 16;
    else if (chipBox.right > rowBox.right) row.scrollLeft += chipBox.right - rowBox.right + 16;
  }, [value]);

  return (
    <div
      ref={rowRef}
      className={`filter-chips ${className}`.trim()}
      data-fade={fade}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map(option => {
        const active = value === option.value;
        const Icon = option.icon;

        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            className={`filter-chip${active ? ' active' : ''}`}
            onClick={() => onChange(option.value)}
          >
            {Icon && <Icon size={option.iconSize || 14} aria-hidden="true" />}
            <span>{option.label}</span>
            {option.count != null && (
              <span className={`filter-chip-count ${option.countClassName || ''}`.trim()}>{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
};

export default ResponsiveFilterControls;
