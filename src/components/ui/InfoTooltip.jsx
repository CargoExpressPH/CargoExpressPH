import { useState } from 'react';
import { Info } from 'lucide-react';

/**
 * InfoTooltip — Interactive ⓘ icon button that shows text on mouse hover, focus, or mobile tap/long-press.
 *
 * @param {string} text — Help guidelines text to display inside the tooltip bubble.
 * @param {number} size — Icon size in px (default 14).
 */
const InfoTooltip = ({ text, size = 14 }) => {
  const [open, setOpen] = useState(false);

  return (
    <span
      className="info-tooltip-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="info-tooltip-icon-btn"
        onClick={(e) => {
          e.preventDefault();
          setOpen(prev => !prev);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-label="More information"
        title={text}
      >
        <Info size={size} />
      </button>
      {open && (
        <span className="info-tooltip-bubble" role="tooltip">
          {text}
        </span>
      )}
    </span>
  );
};

export default InfoTooltip;
