import { useState, useRef, useEffect, useCallback } from 'react';
import { Info } from 'lucide-react';

/**
 * InfoTooltip — Interactive ⓘ icon button that shows text on mouse hover, focus, or mobile tap/long-press.
 *
 * On mobile (≤640px) the tooltip uses fixed positioning so it never gets cut off by the viewport edge.
 * A transparent backdrop overlay allows the user to tap anywhere to dismiss.
 *
 * Designed to work safely inside <label> elements — clicks are fully isolated
 * so they never trigger the label's native focus-forwarding to associated inputs.
 *
 * @param {string} text — Help guidelines text to display inside the tooltip bubble.
 * @param {number} size — Icon size in px (default 14).
 */
const InfoTooltip = ({ text, size = 14 }) => {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const wrapRef = useRef(null);
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

  // Close tooltip when clicking anywhere outside (desktop fallback)
  useEffect(() => {
    if (!open) return;

    const handleOutsideClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick, true);
    document.addEventListener('touchstart', handleOutsideClick, true);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick, true);
      document.removeEventListener('touchstart', handleOutsideClick, true);
    };
  }, [open]);

  /**
   * Block ALL click/mousedown events from escaping this wrapper.
   * This prevents the parent <label> from receiving the click and
   * forwarding focus to its associated <input>.
   */
  const stopLabelForwarding = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <span
      ref={wrapRef}
      className="info-tooltip-wrap"
      onClick={stopLabelForwarding}
      onMouseDown={stopLabelForwarding}
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
        onMouseDown={(e) => {
          // Prevent label's native mousedown → focus forwarding
          e.stopPropagation();
        }}
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
