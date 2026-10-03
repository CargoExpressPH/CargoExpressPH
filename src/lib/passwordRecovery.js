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

export const parsePasswordRecoveryUrl = (hash = '') => {
  const params = new URLSearchParams(String(hash).replace(/^#/, ''));
  const hasError = Boolean(
    params.get('error') ||
    params.get('error_code') ||
    params.get('error_description')
  );

  return {
    hasRecoveryIntent: params.get('type') === 'recovery',
    errorMessage: hasError ? INVALID_RECOVERY_LINK_MESSAGE : '',
  };
};

export const isUsableRecoverySession = ({ event, session, initialRecoveryIntent = false }) => (
  Boolean(session) && (event === 'PASSWORD_RECOVERY' || initialRecoveryIntent)
);
