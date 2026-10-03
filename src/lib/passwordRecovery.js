export const INVALID_RECOVERY_LINK_MESSAGE =
  'This password reset link is invalid, expired, or has already been used. Please request a new link.';

// Supabase creates a real, persisted auth session when a recovery link is
// opened. Keep a small, non-sensitive marker beside that session so the app
// can distinguish an unfinished recovery session from a normal login after a
// browser/PWA restart. Never store the access token or any URL fragment here.
export const PASSWORD_RECOVERY_PENDING_KEY = 'cargoexpress:password-recovery-pending';
export const USED_PASSWORD_RECOVERY_LINKS_KEY = 'cargoexpress:used-password-recovery-links';

const USED_LINK_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_USED_LINKS = 20;

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

const recoveryLinkFingerprint = async (tokenHash) => {
  try {
    if (!tokenHash || !globalThis.crypto?.subtle) return null;
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(tokenHash),
    );
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
};

const readUsedLinks = (storage) => {
  try {
    const entries = JSON.parse(storage.getItem(USED_PASSWORD_RECOVERY_LINKS_KEY) || '[]');
    return Array.isArray(entries)
      ? entries.filter(entry =>
        typeof entry?.fingerprint === 'string' &&
        Number.isFinite(entry.expiresAt) && entry.expiresAt > Date.now()
      ).slice(-MAX_USED_LINKS)
      : [];
  } catch {
    return [];
  }
};

// A digest of the one-time token lets this browser/PWA recognize a reopened
// link without keeping the credential itself. The server remains authoritative
// on a different device or after this small local cache expires.
export const hasUsedPasswordRecoveryLink = async (tokenHash) => {
  const storage = getStorage();
  const fingerprint = await recoveryLinkFingerprint(tokenHash);
  return Boolean(storage && fingerprint &&
    readUsedLinks(storage).some(entry => entry.fingerprint === fingerprint));
};

export const rememberUsedPasswordRecoveryLink = async (tokenHash) => {
  const storage = getStorage();
  const fingerprint = await recoveryLinkFingerprint(tokenHash);
  if (!storage || !fingerprint) return false;
  try {
    const entries = readUsedLinks(storage).filter(entry => entry.fingerprint !== fingerprint);
    entries.push({ fingerprint, expiresAt: Date.now() + USED_LINK_RETENTION_MS });
    storage.setItem(USED_PASSWORD_RECOVERY_LINKS_KEY, JSON.stringify(entries.slice(-MAX_USED_LINKS)));
    return true;
  } catch {
    return false;
  }
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
