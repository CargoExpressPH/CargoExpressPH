import { useEffect, useRef, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const pad2 = (n) => String(n).padStart(2, '0');

// Dates round-trip as plain 'YYYY-MM-DD' strings — the same shape the native
// <input type="date"> this replaces used, and what getReportData() expects.
// Parsed/formatted against LOCAL calendar fields (not Date.toISOString/UTC
// parsing) so the day shown here always matches the day picked, regardless
// of the viewer's timezone offset.
const parseLocalDate = (str) => {
  if (!str) return null;
  const [y, m, d] = str.split('-').map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? null : date;
};

const toLocalDateStr = (date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const isSameDay = (a, b) =>
  !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// Always 6 rows so the panel height never jumps as the user pages between
// short and long months.
const buildMonthGrid = (viewDate) => {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const startOffset = new Date(year, month, 1).getDay();
  const gridStart = new Date(year, month, 1 - startOffset);

  return Array.from({ length: 42 }, (_, i) => {
    const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    return { date, inMonth: date.getMonth() === month, key: toLocalDateStr(date) };
  });
};

/**
 * Modern popover date picker matching the app's CustomSelect conventions
 * (button trigger, click-outside/Escape to close, viewport-aware placement).
 * Drop-in replacement for `<input type="date">` — reads/writes the same
 * 'YYYY-MM-DD' string via `value` / `onChange(nextValue)`.
 */
const DatePicker = ({
  id,
  value = '',
  onChange,
  min,
  max,
  placeholder = 'Select date',
  disabled = false,
  'aria-label': ariaLabel,
}) => {
  const selected = parseLocalDate(value);
  const minDate = parseLocalDate(min);
  const maxDate = parseLocalDate(max);
  const today = new Date();

  const [open, setOpen] = useState(false);
  const [viewDate, setViewDate] = useState(selected || today);
  const [menuPlacement, setMenuPlacement] = useState('bottom');
  const rootRef = useRef(null);

  const openPanel = () => {
    setViewDate(selected || today);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return undefined;

    const updatePlacement = () => {
      if (!rootRef.current) return;
      const rect = rootRef.current.getBoundingClientRect();
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      const spaceBelow = viewportHeight - rect.bottom - 8;
      const spaceAbove = rect.top - 8;
      const panelHeight = 340;
      setMenuPlacement(spaceBelow < panelHeight && spaceAbove > spaceBelow ? 'top' : 'bottom');
    };
    updatePlacement();

    const closeOnOutsidePointer = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', updatePlacement);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', updatePlacement);
    };
  }, [open]);

  const isDisabledDate = (date) => (minDate && date < minDate) || (maxDate && date > maxDate);

  const selectDate = (date) => {
    if (isDisabledDate(date)) return;
    onChange?.(toLocalDateStr(date));
    setOpen(false);
  };

  const shiftMonth = (delta) => {
    setViewDate(prev => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
  };

  const cells = buildMonthGrid(viewDate);

  return (
    <div className="date-picker-root" ref={rootRef}>
      <button
        id={id}
        type="button"
        className="date-picker-trigger form-input"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openPanel())}
      >
        <span className={`date-picker-value ${selected ? '' : 'placeholder'}`.trim()}>
          {selected
            ? selected.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
            : placeholder}
        </span>
        <Calendar size={16} aria-hidden="true" className="date-picker-icon" />
      </button>

      {open && !disabled && (
        <div
          className={`date-picker-panel ${menuPlacement === 'top' ? 'open-up' : ''}`.trim()}
          role="dialog"
          aria-label={ariaLabel || 'Choose date'}
        >
          <div className="date-picker-nav">
            <button type="button" className="date-picker-nav-btn" onClick={() => shiftMonth(-1)} aria-label="Previous month">
              <ChevronLeft size={16} />
            </button>
            <span className="date-picker-month-label">
              {viewDate.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })}
            </span>
            <button type="button" className="date-picker-nav-btn" onClick={() => shiftMonth(1)} aria-label="Next month">
              <ChevronRight size={16} />
            </button>
          </div>

          <div className="date-picker-weekdays" aria-hidden="true">
            {WEEKDAYS.map(w => <span key={w}>{w}</span>)}
          </div>

          <div className="date-picker-grid">
            {cells.map(({ date, inMonth, key }) => {
              const dateDisabled = isDisabledDate(date);
              const classes = [
                'date-picker-day',
                !inMonth ? 'outside' : '',
                isSameDay(date, selected) ? 'selected' : '',
                isSameDay(date, today) ? 'today' : '',
              ].filter(Boolean).join(' ');

              return (
                <button
                  key={key}
                  type="button"
                  className={classes}
                  disabled={dateDisabled}
                  aria-current={isSameDay(date, today) ? 'date' : undefined}
                  aria-selected={isSameDay(date, selected)}
                  onClick={() => selectDate(date)}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>

          <div className="date-picker-footer">
            <button
              type="button"
              className="date-picker-today-btn"
              disabled={isDisabledDate(today)}
              onClick={() => selectDate(today)}
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default DatePicker;
