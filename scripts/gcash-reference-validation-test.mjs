// Unit tests for src/utils/gcashReference.js, the shared browser-side
// validator used by ManualRefundModal. Mirrors the equivalent checks in
// record_manual_refund() (20260919000000_manual_refund_reference_validation.sql)
// and the record-manual-refund Edge Function — see that migration's header
// comment for the sources behind these rules. Server-side coverage of the
// same rules lives in scripts/manual-refund-pgtest/run.mjs; this file only
// covers the browser copy of the logic.
import assert from 'node:assert/strict';
import { validateGcashReference } from '../src/utils/gcashReference.js';

let passed = 0;
let failed = 0;
const check = (description, condition) => {
  if (condition) { passed += 1; return; }
  failed += 1;
  console.error(`FAIL: ${description}`);
};

// Required, rejects blank.
check('empty string is invalid', validateGcashReference('').valid === false);
check('whitespace-only is invalid', validateGcashReference('   ').valid === false);

// Rejects email addresses — the actual reported bug (admin's saved email
// autofilling into this field).
check('an email address is rejected', validateGcashReference('admin@cargoexpressph.com').valid === false);
check('email rejection message is specific', /email address/.test(validateGcashReference('admin@cargoexpressph.com').error));

// Rejects phone numbers, without misclassifying an alphanumeric id that
// happens to reduce to phone-shaped digits once stripped.
check('a PH mobile number (09xx) is rejected', validateGcashReference('09171234567').valid === false);
check('a PH mobile number (+639xx) is rejected', validateGcashReference('+639171234567').valid === false);
check('a PH mobile number with dashes is rejected', validateGcashReference('0917-123-4567').valid === false);
check(
  'a PayMongo-id-shaped value is NOT misclassified as a phone number just because its digits happen to reduce to a 9-leading 10-digit string',
  validateGcashReference('pay_9f8a7b6c5d4e3f2a1b0c').error !== 'That looks like a phone number, not a GCash transfer reference.',
);

// Rejects PayMongo/internal resource ids.
for (const id of ['pay_9f8a7b6c5d4e3f2a1b0c', 'ref_abc123XYZ789', 'src_1a2b3c4d5e6f7g8h']) {
  check(`PayMongo-shaped id "${id}" is rejected`, validateGcashReference(id).valid === false);
}

// Rejects a reference identical to the ORIGINAL payment's own reference.
check(
  'a reference matching the original payment reference is rejected',
  validateGcashReference('1001 543 610277', { originalReference: '1001 543 610277' }).valid === false,
);
check(
  'the same check is case-insensitive',
  validateGcashReference('ABC123456789', { originalReference: 'abc123456789' }).valid === false,
);
check(
  'a DIFFERENT reference is not rejected merely for existing alongside an original reference',
  validateGcashReference('1001 543 610299', { originalReference: '1001 543 610277' }).valid === true,
);

// Rejects a value with no real digit content.
check('a value with fewer than 4 digits is rejected', validateGcashReference('abc-def-gh').valid === false);

// Accepts a plausible reference, preserves it exactly (leading zeros, exact
// internal spacing) — trims only the surrounding whitespace.
{
  const result = validateGcashReference('0091 234 567890');
  check('a reference with leading zeros is accepted', result.valid === true);
  check('leading zeros are preserved exactly, not stripped or coerced to a number', result.value === '0091 234 567890');
}
{
  const result = validateGcashReference('  1234 567 890123  ');
  check('surrounding whitespace does not invalidate an otherwise-good reference', result.valid === true);
  check('surrounding whitespace is trimmed', result.value === '1234 567 890123');
  check('internal spacing is preserved exactly, not collapsed', result.value.includes(' '));
}

// A realistic 13-digit GCash "Ref No." shaped value passes.
check('a realistic 13-digit GCash reference is accepted', validateGcashReference('1001543610110').valid === true);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log('GCash reference validation tests passed.');
