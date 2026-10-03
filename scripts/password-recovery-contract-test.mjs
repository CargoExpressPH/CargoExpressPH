import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  INVALID_RECOVERY_LINK_MESSAGE,
  PASSWORD_RECOVERY_PENDING_KEY,
  clearPasswordRecoveryPending,
  hasPendingPasswordRecovery,
  isUsableRecoverySession,
  markPasswordRecoveryPending,
  parsePasswordRecoveryUrl,
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

if (previousLocalStorage) {
  Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
} else {
  delete globalThis.localStorage;
}

assert.deepEqual(
  parsePasswordRecoveryUrl('#access_token=token&type=recovery'),
  { hasRecoveryIntent: true, errorMessage: '' },
  'A recovery URL must be recognized without exposing its token.',
);

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
  isUsableRecoverySession({ event: 'PASSWORD_RECOVERY', session: { user: { id: 'user-1' } } }),
  true,
  'PASSWORD_RECOVERY with a session must unlock the reset form.',
);
assert.equal(
  isUsableRecoverySession({ event: 'SIGNED_IN', session: { user: { id: 'user-1' } } }),
  false,
  'An ordinary signed-in session must not unlock the public recovery form.',
);
assert.equal(
  isUsableRecoverySession({ session: { user: { id: 'user-1' } }, initialRecoveryIntent: true }),
  true,
  'A session parsed from the initial recovery URL must survive an early event race.',
);
assert.equal(
  isUsableRecoverySession({ session: null, initialRecoveryIntent: true }),
  false,
  'Recovery intent without a session must never unlock the form.',
);

const resetPage = readFileSync('src/pages/auth/ResetPasswordPage.jsx', 'utf8');
const forgotPage = readFileSync('src/pages/auth/ForgotPasswordPage.jsx', 'utf8');
const authContext = readFileSync('src/contexts/AuthContext.jsx', 'utf8');

assert.doesNotMatch(
  resetPage,
  /!authLoading\s*&&\s*!user[\s\S]{0,300}navigate\('\/login'\)/,
  'Missing normal app user state must not eject a valid recovery session.',
);
assert.match(resetPage, /event, session[\s\S]*isUsableRecoverySession/);
assert.match(resetPage, /window\.history\.replaceState/);
assert.match(
  resetPage,
  /const leaveRecovery[\s\S]*await endSession\(\)[\s\S]*navigate\(destination/,
  'Every recovery-page exit must destroy the temporary session before navigating.',
);
assert.match(resetPage, /leaveRecovery\(logout, '\/login'/);
assert.match(resetPage, /leaveRecovery\(discardPasswordRecovery, '\/login'/);
assert.match(resetPage, /leaveRecovery\(discardPasswordRecovery, '\/forgot-password'/);
assert.match(resetPage, /onClick=\{requestNewLink\}/);
assert.equal(
  (resetPage.match(/onClick=\{cancelRecovery\}/g) || []).length,
  2,
  'Both valid and invalid recovery states must sign out before returning to login.',
);
assert.doesNotMatch(
  resetPage,
  /<Link to="\/(?:login|forgot-password)"[^>]*>[\s\S]{0,200}(?:Back to Sign In|Request New Link)/,
  'Recovery exits must not bypass session cleanup with a plain route link.',
);
assert.match(forgotPage, /const handleResend[\s\S]*setError\(''\)/);
assert.match(authContext, /recoveryLinkDetected\.current && window\.location\.pathname !== '\/reset-password'/);
assert.match(
  authContext,
  /const discardPasswordRecovery[\s\S]*signOut\(\{ scope: 'local' \}\)/,
  'Abandoning recovery must clear only the browser recovery session, not other device sessions.',
);
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

console.log('Password recovery contract tests passed.');
