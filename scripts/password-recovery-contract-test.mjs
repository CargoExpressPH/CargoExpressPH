import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  INVALID_RECOVERY_LINK_MESSAGE,
  PASSWORD_RECOVERY_PENDING_KEY,
  USED_PASSWORD_RECOVERY_LINKS_KEY,
  clearPasswordRecoveryPending,
  hasPendingPasswordRecovery,
  hasUsedPasswordRecoveryLink,
  isUsableRecoverySession,
  markPasswordRecoveryPending,
  parsePasswordRecoveryUrl,
  rememberUsedPasswordRecoveryLink,
  stripPasswordRecoveryParams,
} from '../src/lib/passwordRecovery.js';

const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const values = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  },
});

assert.equal(hasPendingPasswordRecovery(), false, 'A fresh browser must not have a pending recovery marker.');
assert.equal(markPasswordRecoveryPending(), true, 'Recovery start must persist a marker.');
assert.equal(values.get(PASSWORD_RECOVERY_PENDING_KEY), '1');
assert.equal(hasPendingPasswordRecovery(), true, 'The pending recovery marker must survive app restarts.');
assert.equal(clearPasswordRecoveryPending(), true, 'Recovery cleanup must remove the marker.');
assert.equal(hasPendingPasswordRecovery(), false, 'A completed or abandoned recovery must not remain marked.');
assert.equal(await hasUsedPasswordRecoveryLink('one-time-token'), false);
assert.equal(await rememberUsedPasswordRecoveryLink('one-time-token'), true);
assert.equal(await hasUsedPasswordRecoveryLink('one-time-token'), true);
assert.equal(await hasUsedPasswordRecoveryLink('another-token'), false);
assert.doesNotMatch(values.get(USED_PASSWORD_RECOVERY_LINKS_KEY), /one-time-token/);
const usedLinks = JSON.parse(values.get(USED_PASSWORD_RECOVERY_LINKS_KEY));
usedLinks[0].expiresAt = Date.now() - 1;
values.set(USED_PASSWORD_RECOVERY_LINKS_KEY, JSON.stringify(usedLinks));
assert.equal(await hasUsedPasswordRecoveryLink('one-time-token'), false, 'Old local markers must expire.');

if (previousLocalStorage) {
  Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
} else {
  delete globalThis.localStorage;
}

assert.deepEqual(
  parsePasswordRecoveryUrl('#access_token=token&type=recovery'),
  { hasRecoveryIntent: true, accessToken: 'token', tokenHash: '', errorMessage: '' },
  'A recovery URL must be recognized without exposing its token.',
);
assert.deepEqual(
  parsePasswordRecoveryUrl('', '?token_hash=hash&type=recovery'),
  { hasRecoveryIntent: true, accessToken: '', tokenHash: 'hash', errorMessage: '' },
  'A token-hash email URL must remain available until the customer confirms it.',
);
assert.equal(stripPasswordRecoveryParams('?token_hash=secret&type=recovery&campaign=email'), '?campaign=email');

for (const hash of [
  '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid',
  '#error_code=otp_expired',
  '#error_description=Token+has+expired',
]) {
  assert.equal(
    parsePasswordRecoveryUrl(hash).errorMessage,
    INVALID_RECOVERY_LINK_MESSAGE,
    'Provider errors must be converted to one safe, actionable message.',
  );
}

assert.equal(
  isUsableRecoverySession({ session: { user: { id: 'user-1' }, access_token: 'link-token' }, expectedAccessToken: 'link-token' }),
  true,
  'Only the session created by this recovery link may unlock the form.',
);
assert.equal(
  isUsableRecoverySession({ session: { user: { id: 'user-1' }, access_token: 'other-token' }, expectedAccessToken: 'link-token' }),
  false,
  'An unrelated signed-in session must not unlock the public recovery form.',
);
assert.equal(
  isUsableRecoverySession({ session: null, expectedAccessToken: 'link-token' }),
  false,
  'Recovery intent without a session must never unlock the form.',
);

const resetPage = readFileSync('src/pages/auth/ResetPasswordPage.jsx', 'utf8');
const forgotPage = readFileSync('src/pages/auth/ForgotPasswordPage.jsx', 'utf8');
const authContext = readFileSync('src/contexts/AuthContext.jsx', 'utf8');
const serviceWorker = readFileSync('public/sw.js', 'utf8');
const recoveryTemplate = readFileSync('supabase/templates/recovery.html', 'utf8');

assert.doesNotMatch(
  resetPage,
  /!authLoading\s*&&\s*!user[\s\S]{0,300}navigate\('\/login'\)/,
  'Missing normal app user state must not eject a valid recovery session.',
);
assert.match(resetPage, /expectedAccessToken: initialUrlState\.accessToken/);
assert.match(resetPage, /initialAuthRedirectHash/);
assert.match(resetPage, /verifyOtp\(\{[\s\S]*token_hash: tokenHash,[\s\S]*type: 'recovery'/);
assert.ok(resetPage.indexOf('verifyOtp({') < resetPage.indexOf('const result = await changePassword(password)'));
assert.match(resetPage, /hasUsedPasswordRecoveryLink\(initialUrlState\.tokenHash\)/);
assert.match(resetPage, /onClick=\{confirmRecoveryLink\}/);
assert.match(resetPage, /window\.history\.replaceState/);
assert.match(
  resetPage,
  /const leaveRecovery[\s\S]*await endSession\(\)[\s\S]*navigate\(destination/,
  'Every recovery-page exit must destroy the temporary session before navigating.',
);
assert.match(resetPage, /leaveRecovery\(completePasswordRecovery, '\/login'/);
assert.match(resetPage, /recoverySessionEstablishedRef\.current\s*\? discardPasswordRecovery\(\)/);
assert.match(resetPage, /leaveRecovery\(discardEstablishedRecovery, '\/login'/);
assert.match(resetPage, /leaveRecovery\(discardEstablishedRecovery, '\/forgot-password'/);
assert.match(resetPage, /onClick=\{requestNewLink\}/);
assert.equal(
  (resetPage.match(/onClick=\{cancelRecovery\}/g) || []).length,
  3,
  'Confirmation, valid, and invalid recovery states must clean up before returning to login.',
);
assert.doesNotMatch(
  resetPage,
  /<Link to="\/(?:login|forgot-password)"[^>]*>[\s\S]{0,200}(?:Back to Sign In|Request New Link)/,
  'Recovery exits must not bypass session cleanup with a plain route link.',
);
assert.match(forgotPage, /const handleResend[\s\S]*setError\(''\)/);
assert.match(authContext, /window\.location\.hash \|\| initialAuthRedirectHash/);
assert.match(
  authContext,
  /const discardPasswordRecovery[\s\S]*signOut\(\{ scope: 'local' \}\)/,
  'Abandoning recovery must clear only the browser recovery session, not other device sessions.',
);
assert.match(authContext, /const completePasswordRecovery[\s\S]*await supabase\.auth\.signOut\(\)/);
assert.match(
  authContext,
  /pendingRecoveryCleanup[\s\S]*clearPersistedRecoverySession/,
  'A browser restart during recovery must discard the temporary session before normal initialization.',
);
assert.match(
  authContext,
  /markPasswordRecoveryPending\(\)/,
  'Opening or receiving a recovery session must persist its temporary-session marker.',
);
assert.match(
  resetPage,
  /markPasswordRecoveryPending\(\)/,
  'The reset page must preserve the recovery marker even if the SDK consumed the URL hash first.',
);
assert.match(serviceWorker, /isRecoveryNavigation[\s\S]*!isRecoveryNavigation[\s\S]*isRecoveryNavigation \? null : await caches\.match\(request\)/);
assert.match(recoveryTemplate, /\{\{ \.RedirectTo \}\}\?token_hash=\{\{ \.TokenHash \}\}&amp;type=recovery/);
assert.match(recoveryTemplate, /Continue to Reset Password/);
assert.doesNotMatch(recoveryTemplate, /\.ConfirmationURL/);

console.log('Password recovery contract tests passed.');
