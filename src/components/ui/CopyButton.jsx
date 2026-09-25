import { useEffect, useRef, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { useToast } from '../../hooks/useToast';

// Clipboard API needs a secure context; older browsers and plain-http LAN
// testing fall back to a hidden textarea + execCommand.
const fallbackCopy = (text) => {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  document.body.removeChild(area);
  return copied;
};

/**
 * Small icon button that copies `value` to the clipboard, e.g. beside a
 * tracking number. The icon turns into a green check for two seconds and the
 * app's toast confirms it in words (toasts are a live region, so screen
 * readers hear it too). Feedback never changes the button's size, so the
 * heading beside it does not reflow on a narrow phone.
 */
const CopyButton = ({ value, label = 'Copy', copiedMessage = 'Copied', className = '' }) => {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = String(value ?? '');
    if (!text) return;
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        ok = fallbackCopy(text);
      }
    } catch {
      ok = fallbackCopy(text);
    }
    if (ok) {
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
      toast.success(copiedMessage, 2500);
    } else {
      toast.error('Could not copy. Press and hold the text to copy it instead.');
    }
  };

  return (
    <button
      type="button"
      className={`copy-btn${copied ? ' is-copied' : ''} ${className}`.trim()}
      onClick={handleCopy}
      aria-label={label}
      title={copied ? copiedMessage : label}
    >
      {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
    </button>
  );
};

export default CopyButton;
