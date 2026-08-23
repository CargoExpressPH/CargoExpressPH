/**
 * Peso amount input helpers.
 *
 * Money fields are typed as text, not `type="number"`, so they can carry
 * thousands separators while the admin types. That means the browser no longer
 * enforces `min="0"` for us, so sign is enforced here instead: the minus sign
 * is not a character an amount field accepts at all. Nothing downstream ever
 * sees a negative, whether it was typed, pasted, or autofilled.
 *
 * Two representations, deliberately kept apart:
 *   - stored  — a plain numeric string ("10000.5"), what form state holds and
 *               what `parseFloat` is called on at save time. No commas ever
 *               reach the database or the price math.
 *   - display — the same value grouped ("10,000.5"), what the input shows.
 */

/** Strips everything that is not a digit or a single decimal point. */
export const sanitizeAmount = (raw) => {
  if (raw === null || raw === undefined) return '';
  // Minus signs and letters are dropped rather than rejected — there is no
  // valid amount they could be part of.
  let cleaned = String(raw).replace(/[^\d.]/g, '');

  // Collapse repeated decimal points: keep the first, drop the rest.
  const firstDot = cleaned.indexOf('.');
  if (firstDot !== -1) {
    cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
  }

  // Centavos only — two decimal places is as fine as the currency goes.
  // Leading zeros are dropped here rather than only at display time, so the
  // stored string and the grouped display always hold the same characters and
  // the caret arithmetic in AmountInput stays exact.
  const [rawWhole, fraction] = cleaned.split('.');
  const whole = rawWhole.replace(/^0+(?=\d)/, '');
  if (fraction === undefined) return whole;
  return `${whole}.${fraction.slice(0, 2)}`;
};

/** "10000.5" → "10,000.5". Groups the whole part only; keeps a trailing dot. */
export const formatAmount = (stored) => {
  const clean = sanitizeAmount(stored);
  if (clean === '') return '';
  const [whole, fraction] = clean.split('.');
  const grouped = whole === '' ? '' : Number(whole).toLocaleString('en-US');
  if (fraction === undefined) return clean.endsWith('.') ? `${grouped}.` : grouped;
  return `${grouped}.${fraction}`;
};

/**
 * Numeric value of a stored amount. Returns NaN for blank/unparseable input so
 * callers can tell "nothing entered" from "zero" — the two mean different
 * things at pickup, where a blank Amount Received means "charge the estimate".
 */
export const parseAmount = (stored) => {
  const clean = sanitizeAmount(stored);
  if (clean === '' || clean === '.') return NaN;
  return parseFloat(clean);
};

/** True when the value is present and is a usable, non-negative amount. */
export const isValidAmount = (stored) => {
  const value = parseAmount(stored);
  return Number.isFinite(value) && value >= 0;
};

/**
 * "10000.5" → "₱10,000.50" — THE peso renderer.
 *
 * Grouped, always ₱, always two decimals, zone-independent. Exists because the
 * app previously had two money dialects: 28 bare `toFixed(2)` renders
 * ("₱1200.00") beside `toLocaleString('en-PH')` groupers ("₱1,200.00") for the
 * same order on different screens. Every peso a user reads goes through here.
 */
export const formatMoney = (value) =>
  `₱${(Number(value) || 0).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
