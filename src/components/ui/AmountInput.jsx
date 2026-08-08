import { useRef, useLayoutEffect } from 'react';
import { sanitizeAmount, formatAmount } from '../../utils/currencyInput';

/**
 * AmountInput — a peso field that reads like money.
 *
 * Shows the value grouped ("10,000.50") while storing a plain numeric string
 * ("10000.50"), so `onValueChange` hands callers something `parseFloat` accepts
 * directly and no caller has to strip separators before saving.
 *
 * `type="text"` is required for the commas, which is also why the sign is
 * filtered rather than delegated to `min="0"`: with a text input the browser
 * enforces nothing, so a typed or pasted "-10000" is stripped to "10000" here
 * and never becomes a negative amount. `inputMode="decimal"` keeps the numeric
 * keypad on mobile — the drivers processing pickups are on phones.
 *
 * Props mirror a normal input, except `value` is the stored numeric string and
 * `onValueChange(stored)` replaces `onChange`. `id` is named rather than spread
 * so every call site is forced to pass one — each of these fields has a visible
 * `<label htmlFor>` and that is where the accessible name comes from.
 */
const AmountInput = ({ id, value, onValueChange, className = 'form-input', ...rest }) => {
  const inputRef = useRef(null);
  // Caret position to restore after React rewrites the value, or null when the
  // change did not come from typing (a parent setting the field, say).
  const caretRef = useRef(null);

  const display = formatAmount(value);

  // Reformatting mid-string ("1000" → "10,000" when a digit is inserted) shifts
  // every character after the caret, so the caret has to be put back by digit
  // count rather than by index — otherwise typing into the middle of an amount
  // throws the cursor to the end on every keystroke.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || caretRef.current === null) return;
    const digitsBefore = caretRef.current;
    let seen = 0;
    let pos = display.length;
    for (let i = 0; i < display.length; i += 1) {
      if (seen === digitsBefore) { pos = i; break; }
      if (/[\d.]/.test(display[i])) seen += 1;
    }
    if (seen < digitsBefore) pos = display.length;
    el.setSelectionRange(pos, pos);
    caretRef.current = null;
  }, [display]);

  const handleChange = (e) => {
    const raw = e.target.value;
    const caret = e.target.selectionStart ?? raw.length;
    // Count the value-bearing characters left of the caret; separators move,
    // digits do not.
    caretRef.current = raw.slice(0, caret).replace(/[^\d.]/g, '').length;
    onValueChange(sanitizeAmount(raw));
  };

  return (
    <input
      id={id}
      ref={inputRef}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className={className}
      value={display}
      onChange={handleChange}
      {...rest}
    />
  );
};

export default AmountInput;
