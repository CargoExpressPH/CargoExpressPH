import { useCallback, useRef, useState } from 'react';

/**
 * useFieldErrors — the submit-time validation half of the FieldError standard.
 *
 * Holds a `{ fieldName: message }` map and gives a form three things it
 * otherwise hand-rolls differently every time:
 *
 *   validate(rules)  evaluate a rule map, store the failures, focus the first
 *                    one, and return whether the form may proceed
 *   clearError(name) drop one field's message — call it from onChange, so a
 *                    field stops being red the moment the user fixes it rather
 *                    than at the next submit
 *   errors           the map to feed FieldError / invalidClass / fieldAttrs
 *
 * Rules are evaluated by the caller, not by a schema here: this app's real
 * validation lives in PostgreSQL triggers, and a second declarative schema in
 * the client would be a competing source of truth that drifts. What the client
 * owes the user is a fast, specific message before the round trip — nothing
 * more.
 *
 *   const { errors, validate, clearError } = useFieldErrors();
 *
 *   const ok = validate({
 *     actual_weight: !form.actual_weight ? 'Enter the weight from the scale' : null,
 *     payer_type:    !form.payer_type    ? 'Please select an option' : null,
 *   });
 *   if (!ok) return;
 */
const useFieldErrors = (initial = {}) => {
  const [errors, setErrors] = useState(initial);
  const containerRef = useRef(null);

  /** Drop one field's error. Cheap to call on every keystroke — no-ops when clean. */
  const clearError = useCallback((name) => {
    setErrors((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }, []);

  const clearAll = useCallback(() => setErrors({}), []);

  /**
   * Move focus to the first invalid control.
   *
   * Queried from the DOM rather than from the rule map because the map's key
   * order is however the author typed it, while the user reads the form top to
   * bottom — jumping them to the third field because it happened to be listed
   * first is disorienting. Runs after paint so the just-set `aria-invalid`
   * attributes exist to be found.
   */
  const focusFirstInvalid = useCallback(() => {
    requestAnimationFrame(() => {
      const root = containerRef.current || document;
      const target = root.querySelector('[aria-invalid="true"], .field-invalid');
      if (!target) return;

      // Some invalid "fields" are groups (a photo picker, a segmented control)
      // with nothing focusable at the marked node; scrolling still orients the
      // user, so it is done unconditionally and focus is best-effort.
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (typeof target.focus === 'function') {
        target.focus({ preventScroll: true });
      }
    });
  }, []);

  /**
   * Evaluate a rule map. Values are the message for a failing field, or any
   * falsy value when the field is fine. Returns true when the form is valid.
   */
  const validate = useCallback((rules) => {
    const found = {};
    for (const [name, message] of Object.entries(rules || {})) {
      if (message) found[name] = message;
    }

    setErrors(found);

    const valid = Object.keys(found).length === 0;
    if (!valid) focusFirstInvalid();
    return valid;
  }, [focusFirstInvalid]);

  /** Mark a single field invalid without disturbing the others. */
  const setError = useCallback((name, message) => {
    setErrors((prev) => ({ ...prev, [name]: message }));
  }, []);

  return { errors, setErrors, setError, clearError, clearAll, validate, containerRef };
};

export default useFieldErrors;
