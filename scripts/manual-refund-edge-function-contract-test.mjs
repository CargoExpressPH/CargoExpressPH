// Static/structural contract test for supabase/functions/record-manual-refund.
//
// This CANNOT prove password verification actually works — that requires a
// real Supabase Auth (GoTrue) server, which does not exist in this sandbox.
// What it proves instead: the source code contains the specific guardrails
// the security requirements demand, so a future edit that quietly removes
// one of them (e.g. "just trust the body's admin id" or "skip the lockout
// check") fails this test immediately. Ledger/RPC-level correctness is
// covered separately and thoroughly by scripts/manual-refund-pgtest — this
// file only concerns the Edge Function's own logic.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync('supabase/functions/record-manual-refund/index.ts', 'utf8');

assert.match(
  source,
  /signInWithPassword/,
  'must verify the password via a real Supabase Auth call (signInWithPassword), never by reading/comparing auth.users directly',
);
assert.doesNotMatch(
  source,
  /\.from\(\s*['"]auth\.users['"]\s*\)|FROM\s+auth\.users/i,
  'must never query the auth.users table directly (that is the "elevated privileges, read the hash" shortcut this feature must avoid) — explanatory comments mentioning it are fine, an actual query is not',
);
assert.doesNotMatch(
  source,
  /pgcrypto|crypt\(/,
  'must not attempt to verify a password by hashing/comparing it itself — verification must go through Supabase Auth',
);

// Identity: only the verified user (from the bearer token, re-confirmed by
// the password check) may be attributed as the admin — never a client body
// field.
assert.match(
  source,
  /signInData\?\.user\?\.id\s*===\s*userData\.user\.id/,
  'must confirm the identity that successfully verified its password is the SAME identity that presented the bearer token',
);
assert.match(
  source,
  /p_admin_id:\s*userData\.user\.id/,
  'the RPC call must pass p_admin_id from the server-verified identity (userData.user.id), not a body field',
);
assert.doesNotMatch(
  source,
  /p_admin_id:\s*body/,
  'must never pass a browser-supplied admin id into the write RPC',
);
assert.doesNotMatch(
  source,
  /body\?\.adminId|body\.adminId|body\?\.admin_id|body\.admin_id/,
  'must not even read an admin-id-shaped field from the request body — there should be nothing to accidentally wire up',
);

// The database write path must be reachable only via the service-role
// client from this function — never the user's own (anon-key + bearer
// token) client, which would only work if the RPC were also grantable to
// `authenticated` (it is not, per the migration's REVOKE/GRANT, but this
// keeps the two designs from silently drifting apart).
assert.match(
  source,
  /const adminSupabase = serviceClient\(\)/,
  'the manual refund write must go through the service-role client, matching the RPC being service_role-only',
);
assert.match(
  source,
  /adminSupabase\.rpc\('record_manual_refund'/,
  'must call record_manual_refund via the service-role client',
);

// Rate limiting: checked before spending a password attempt, and every
// attempt (success or failure) is recorded.
assert.match(
  source,
  /check_manual_refund_reauth_lockout/,
  'must check the re-authentication lockout before attempting password verification',
);
assert.match(
  source,
  /lockoutState\?\.locked\)\s*\{[\s\S]{0,220}429/,
  'a locked-out admin must get a 429 response before any password check is attempted',
);
assert.match(
  source,
  /record_manual_refund_reauth_attempt/,
  'every verification attempt (success or failure) must be recorded for rate limiting',
);
{
  // Look at the actual call sites (`adminSupabase.rpc('check_manual_refund_reauth_lockout'`
  // / `verifyClient.auth.signInWithPassword`), not any mention of these
  // names in the file's own explanatory header comment.
  const checkIndex = source.indexOf("rpc('check_manual_refund_reauth_lockout'");
  const signInIndex = source.indexOf('verifyClient.auth.signInWithPassword');
  const recordAttemptIndex = source.indexOf("rpc('record_manual_refund_reauth_attempt'");
  assert.ok(checkIndex > -1 && signInIndex > -1 && recordAttemptIndex > -1, 'all three lockout-related calls must be present');
  assert.ok(checkIndex < signInIndex, 'the lockout check must run BEFORE the password is verified');
  assert.ok(signInIndex < recordAttemptIndex, 'the attempt must be recorded AFTER the password check, using its real outcome');
}

// Never log or echo the password.
assert.doesNotMatch(
  source,
  /console\.(log|error|warn|info)\([^)]*password/i,
  'must never log the password (or a variable containing it) to the console',
);
{
  // A response error message is allowed to contain the ENGLISH WORD
  // "password" (e.g. "Enter your account password"), and a guard like
  // `if (!password) return json(...)` legitimately mentions the variable
  // just before the call — what must never happen is the `password`
  // VARIABLE reaching INSIDE the json(...) call's own argument list. Strip
  // string-literal contents first, then bracket-match each `json(` call to
  // find exactly its argument list, and check only that substring.
  const withoutStringContents = source.replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, "''");
  const offendingCalls = [];
  const callRegex = /\bjson\(/g;
  let match;
  while ((match = callRegex.exec(withoutStringContents))) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < withoutStringContents.length && depth > 0) {
      if (withoutStringContents[i] === '(') depth += 1;
      else if (withoutStringContents[i] === ')') depth -= 1;
      i += 1;
    }
    const args = withoutStringContents.slice(start, i - 1);
    if (/\bpassword\b/.test(args)) offendingCalls.push(args.trim().slice(0, 80));
  }
  assert.deepEqual(offendingCalls, [], 'must never pass the password variable into a json(...) response');
}

// The admin's own existing browser session must be preserved: verification
// uses a separate, throwaway client instance — never the caller's own
// session-bearing client, and the throwaway one is signed out again after use.
assert.match(
  source,
  /const passwordVerificationClient = \(\) => createClient\(/,
  'password verification must use its own separate client instance, never the caller\'s own session client',
);
assert.match(
  source,
  /verifyClient\.auth\.signOut\(\{ scope: 'local' \}\)/,
  'the throwaway verification session should be signed out again after use, since nothing needs it to persist',
);
assert.doesNotMatch(
  source,
  /userSupabase\.auth\.signInWithPassword/,
  'must not call signInWithPassword on the caller\'s own session-bound client (that would risk disturbing their existing session)',
);

// Confirmation and evidence requirements from the corrected spec.
assert.match(source, /confirmedReturned/, 'must require an explicit confirmation that the money was already returned');
assert.match(source, /gcashReferenceError\(returnReference, null\)/, 'must run the shared GCash reference format validation for a GCash return');
assert.match(source, /EMAIL_PATTERN\.test\(value\)/, 'reference validation must reject email-shaped values');
assert.match(source, /PH_MOBILE_DIGITS_PATTERN\.test\(digitsOnly\)/, 'reference validation must reject phone-number-shaped values');
assert.match(source, /PAYMONGO_ID_PATTERN\.test\(value\)/, 'reference validation must reject PayMongo-id-shaped values');
assert.match(source, /returnMethod === 'cash' && notes\.length < 5/, 'must require an acknowledgement note for a Cash return');

// Method allow-list guards against an arbitrary string reaching the RPC.
assert.match(source, /RETURN_METHODS = new Set\(\['cash', 'gcash'\]\)/, 'return method must be validated against an explicit allow-list');

console.log('Manual refund Edge Function contract tests passed (structural checks only — see file header for what this cannot prove).');
