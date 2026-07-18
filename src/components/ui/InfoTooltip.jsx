import { useState, useRef, useEffect, useCallback } from 'react';
import { Info } from 'lucide-react';

/**
 * InfoTooltip — Interactive ⓘ icon button that shows text on mouse hover, focus, or mobile tap/long-press.
 *
 * On mobile (≤640px) the tooltip uses fixed positioning so it never gets cut off by the viewport edge.
 * A transparent backdrop overlay allows the user to tap anywhere to dismiss.
 *
 * @param {string} text — Help guidelines text to display inside the tooltip bubble.
 * @param {number} size — Icon size in px (default 14).
 */
const InfoTooltip = ({ text, size = 14 }) => {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const [bubbleTop, setBubbleTop] = useState(null);

  const updatePosition = useCallback(() => {
    if (btnRef.current && window.innerWidth <= 640) {
      const rect = btnRef.current.getBoundingClientRect();
      setBubbleTop(rect.bottom + 8);
    } else {
      setBubbleTop(null);
    }
  }, []);

  useEffect(() => {
    if (open) {
      updatePosition();
    }
  }, [open, updatePosition]);

  return (
    <span
      className="info-tooltip-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={btnRef}
        type="button"
        className="info-tooltip-icon-btn"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(prev => !prev);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-label="More information"
      >
        <Info size={size} />
      </button>
      {open && (
        <>
          {/* Transparent backdrop for mobile tap-to-dismiss */}
          <span
            className="info-tooltip-backdrop"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }}
            aria-hidden="true"
          />
          <span
            className="info-tooltip-bubble"
            role="tooltip"
            style={bubbleTop != null ? { top: `${bubbleTop}px` } : undefined}
          >
            {text}
          </span>
        </>
      )}
    </span>
  );
};

export default InfoTooltip;
