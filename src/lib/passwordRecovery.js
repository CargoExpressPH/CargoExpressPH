export const INVALID_RECOVERY_LINK_MESSAGE =
  'This password reset link is invalid, expired, or has already been used. Please request a new link.';

// Supabase creates a real, persisted auth session when a recovery link is
// opened. Keep a small, non-sensitive marker beside that session so the app
// can distinguish an unfinished recovery session from a normal login after a
// browser/PWA restart. Never store the access token or any URL fragment here.
export const PASSWORD_RECOVERY_PENDING_KEY = 'cargoexpress:password-recovery-pending';

const getStorage = () => {
  try {
    return typeof globalThis !== 'undefined' && globalThis.localStorage
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
};

export const markPasswordRecoveryPending = () => {
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.setItem(PASSWORD_RECOVERY_PENDING_KEY, '1');
    return true;
  } catch {
    return false;
  }
};

export const clearPasswordRecoveryPending = () => {
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.removeItem(PASSWORD_RECOVERY_PENDING_KEY);
    return true;
  } catch {
    return false;
  }
};

export const hasPendingPasswordRecovery = () => {
  const storage = getStorage();
  if (!storage) return false;
  try {
    return storage.getItem(PASSWORD_RECOVERY_PENDING_KEY) === '1';
  } catch {
    return false;
  }
};

export const parsePasswordRecoveryUrl = (hash = '', search = '') => {
  const fragment = new URLSearchParams(String(hash).replace(/^#/, ''));
  const query = new URLSearchParams(String(search).replace(/^\?/, ''));
  const hasError = Boolean(
    fragment.get('error') || fragment.get('error_code') || fragment.get('error_description') ||
    query.get('error') || query.get('error_code') || query.get('error_description')
  );
  const accessToken = fragment.get('type') === 'recovery' ? fragment.get('access_token') || '' : '';
  const tokenHash = query.get('type') === 'recovery' ? query.get('token_hash') || '' : '';

  return {
    hasRecoveryIntent: Boolean(accessToken || tokenHash),
    accessToken,
    tokenHash,
    errorMessage: hasError ? INVALID_RECOVERY_LINK_MESSAGE : '',
  };
};

export const stripPasswordRecoveryParams = (search = '') => {
  const params = new URLSearchParams(String(search).replace(/^\?/, ''));
  ['token_hash', 'type', 'error', 'error_code', 'error_description'].forEach(key => params.delete(key));
  const safeSearch = params.toString();
  return safeSearch ? `?${safeSearch}` : '';
};

// A session left by a different login must never make a failed recovery link
// appear valid. The implicit link's access token identifies the session that
// Supabase actually accepted from this URL.
export const isUsableRecoverySession = ({ session, expectedAccessToken }) => (
  Boolean(expectedAccessToken && session?.user && session.access_token === expectedAccessToken)
);
