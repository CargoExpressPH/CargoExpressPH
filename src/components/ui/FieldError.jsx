import { AlertTriangle } from 'lucide-react';

/**
 * FieldError — the one inline validation message in the app.
 *
 * Every form renders its field-level errors through this component so the red
 * text below an input is identical everywhere: same icon, same size, same
 * weight, same spacing. Before this existed there were two markup structures —
 * `.form-error` with a CSS `::before` glyph, and a hand-rolled
 * `.field-error-inline` with a lucide icon — rendering at different sizes and
 * weights, plus a long tail of forms that reported a missing field only in a
 * toast, or not at all.
 *
 * Pair it with `invalidClass()` on the control itself. The red border and the
 * red message are two halves of one signal: the border says which field, the
 * message says what is wrong with it, and neither answers the other's question.
 *
 *   <input
 *     id="trip-capacity"
 *     className={`form-input ${invalidClass('capacity', errors)}`}
 *     {...fieldAttrs('capacity', errors)}
 *   />
 *   <FieldError name="capacity" errors={errors} />
 */

/** The DOM id of a field's error node. Single source for both halves of the aria wiring. */
export const errorId = (name) => `${name}-error`;

/**
 * Accessibility attributes for the control a message belongs to.
 *
 * `describedBy` carries through any helper-text id the field already had. A
 * helper and an error are both descriptions, so overwriting rather than
 * appending would silently drop the helper from screen readers at exactly the
 * moment the user most needs it.
 */
export const fieldAttrs = (name, errors, describedBy) => {
  const invalid = Boolean(errors?.[name]);
  const ids = [invalid ? errorId(name) : null, describedBy || null].filter(Boolean);
  return {
    'aria-invalid': invalid ? 'true' : undefined,
    'aria-describedby': ids.length ? ids.join(' ') : undefined,
  };
};

/** Red-border class for an invalid control. Append to the control's existing className. */
export const invalidClass = (name, errors) => (errors?.[name] ? 'field-invalid' : '');

const FieldError = ({ name, errors, message, id }) => {
  const text = message ?? (name ? errors?.[name] : null);
  if (!text) return null;

  return (
    <p className="field-error-inline" id={id || (name ? errorId(name) : undefined)} role="alert">
      <AlertTriangle size={12} aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
};

export default FieldError;
