/**
 * Philippine mobile number validation — single source of truth.
 *
 * Four call sites (RegisterPage, BookShipmentPage, PersonalInfoPage,
 * AdminCreateBookingPage) each carried their own copy of "11 digits starting
 * with 09," with wording that had already drifted: some said "Phone number,"
 * others "Mobile number," and only one reported the live digit count. None of
 * that divergence was intentional — every one of those screens labels the
 * field "Mobile Number" — so a rule this small is centralised here rather
 * than fixed four times and left free to drift again.
 */

/** Exactly 11 digits, starting with 09. */
export const PH_MOBILE_REGEX = /^09\d{9}$/;

/** True when `phone` is a complete, correctly-formatted PH mobile number. */
export const isPhoneValid = (phone) => PH_MOBILE_REGEX.test(phone || '');

/**
 * Full validation with a field-specific error message, for forms that show
 * an inline error rather than just a boolean/success state.
 *
 * @param {string} phone
 * @param {Object} [options]
 * @param {string}  [options.label='Mobile number'] — subject of the message.
 *   Override only when a field's on-screen label genuinely differs (e.g. a
 *   generic "Phone").
 * @param {boolean} [options.showDigitCount=false] — append "(n/11)" to the
 *   length error, for a field that validates on every keystroke.
 * @returns {string|null} an error message, or null when valid.
 */
export const validatePhone = (phone, { label = 'Mobile number', showDigitCount = false } = {}) => {
  const val = (phone || '').trim();
  if (!val) return `${label} is required.`;
  if (!/^\d+$/.test(val)) return `${label} must contain numbers only.`;
  if (!val.startsWith('09')) return `${label} must start with 09.`;
  if (val.length !== 11) {
    return showDigitCount
      ? `${label} must be exactly 11 digits (${val.length}/11).`
      : `${label} must be exactly 11 digits.`;
  }
  return null;
};
