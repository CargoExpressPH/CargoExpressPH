/**
 * Validates a manually-entered GCash transfer reference (the reference
 * number of the OUTGOING refund transfer an admin already sent, recorded via
 * ManualRefundModal — see supabase/functions/record-manual-refund and
 * record_manual_refund() in 20260918020000_manual_refund_recording.sql).
 *
 * There is no single universal GCash reference format to enforce exactly.
 * Verified receipt guides describe a numeric reference typically shown as
 * "Ref No." (commonly ~13 digits for a wallet-to-wallet transfer, e.g.
 * "1001 543 610110"), but a bank-linked transfer instead surfaces an
 * "InstaPay Ref No." under interbank (InstaPay/PESONet) numbering, which is
 * not guaranteed to share that same length or shape. Hard-coding one exact
 * length/pattern would reject legitimate references from a different rail,
 * so this checks structure and clearly-wrong values instead of one fixed
 * format — see the sources cited in docs/audits/MANUAL_REFUND_REFERENCE_VALIDATION_FIX_REPORT.md.
 *
 * IMPORTANT: passing this check proves the TEXT is reference-shaped. It does
 * NOT prove a transfer actually happened — that is still only established by
 * the admin's own "I confirm the money has already been returned" checkbox
 * and (for Cash) the acknowledgement note. Format validation and proof of
 * transfer are two different, both still-required things.
 */

const EMAIL_PATTERN = /\S+@\S+\.\S+/;
// A value made ONLY of digits and common phone-number punctuation (spaces,
// dashes, parens, a leading +) — checked FIRST, before any digit-stripping.
// Without this guard, stripping non-digits from an alphanumeric value (e.g.
// a PayMongo id like "pay_9f8a7b6c5d4e3f2a1b0c") can coincidentally leave a
// 10-digit string that starts with 9, which would otherwise be misread as a
// phone number even though the original value plainly wasn't one.
const PHONE_SHAPED_PATTERN = /^[\d\s()+-]+$/;
// A PH mobile number, with or without +63/63/0 prefix and any mix of spaces/
// dashes an admin might have typed — checked against the digits alone (only
// once PHONE_SHAPED_PATTERN already confirmed there's nothing else in the
// string) so formatting doesn't let one slip through.
const PH_MOBILE_DIGITS_PATTERN = /^(?:63|0)?9\d{9}$/;
// PayMongo's own resource-id prefixes (payments, refunds, sources, links,
// customers, etc.) — a reference that is actually one of these means the
// admin pasted an internal system id, not a GCash transfer reference.
const PAYMONGO_ID_PATTERN = /^(?:pay|ref|src|link|paym|pi|re|sub|cus|evt)_[A-Za-z0-9_-]+$/i;
const MIN_DIGITS = 4;

/**
 * @param {string} raw - the field's raw value, as typed/pasted
 * @param {{ originalReference?: string | null }} [context] - the ORIGINAL
 *   payment's own transaction_reference, if known, so a reference the
 *   application auto-copied from the original payment (rather than the
 *   admin entering the NEW outgoing transfer's own reference) is caught.
 * @returns {{ valid: boolean, value: string, error: string | null }}
 */
export const validateGcashReference = (raw, context = {}) => {
  // Trim only. Do not strip any other characters — removing "invalid" ones
  // could turn a rejected email/placeholder into something that passes,
  // which is exactly the failure mode this function exists to prevent.
  const value = String(raw ?? '').trim();

  if (!value) {
    return { valid: false, value, error: 'Enter the reference number from the completed GCash transfer receipt.' };
  }
  if (value.length < MIN_DIGITS) {
    return { valid: false, value, error: 'That reference looks too short. Enter the reference number from the completed GCash transfer receipt.' };
  }
  if (value.length > 255) {
    return { valid: false, value, error: 'That reference is too long.' };
  }
  if (EMAIL_PATTERN.test(value)) {
    return { valid: false, value, error: 'That looks like an email address, not a GCash transfer reference.' };
  }
  const digitsOnly = value.replace(/\D/g, '');
  if (PHONE_SHAPED_PATTERN.test(value) && PH_MOBILE_DIGITS_PATTERN.test(digitsOnly) && digitsOnly.length <= 12) {
    return { valid: false, value, error: 'That looks like a phone number, not a GCash transfer reference.' };
  }
  if (PAYMONGO_ID_PATTERN.test(value)) {
    return { valid: false, value, error: 'That looks like an internal payment system ID, not a GCash transfer reference.' };
  }
  if (context.originalReference && value.toLowerCase() === String(context.originalReference).trim().toLowerCase()) {
    return { valid: false, value, error: "That matches the original payment's own reference. Enter the reference of the NEW outgoing refund transfer you sent." };
  }
  if ((digitsOnly.match(/\d/g) || []).length < MIN_DIGITS) {
    return { valid: false, value, error: 'Enter the reference number from the completed GCash transfer receipt.' };
  }

  return { valid: true, value, error: null };
};
