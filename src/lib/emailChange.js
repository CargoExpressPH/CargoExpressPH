export const EMAIL_CHANGE_CALLBACK_PATH = '/email-change-confirmation';

const DEFAULT_APP_URL = 'https://cargoexpress-ph.online';

export const getEmailChangeRedirectUrl = ({ location, appUrl } = {}) => {
  const currentLocation = location || (typeof window !== 'undefined' ? window.location : null);
  if (currentLocation?.origin && currentLocation?.hostname && !currentLocation.hostname.includes('localhost')) {
    return `${currentLocation.origin}${EMAIL_CHANGE_CALLBACK_PATH}`;
  }

  const configuredUrl = appUrl || import.meta.env?.VITE_APP_URL || DEFAULT_APP_URL;
  return `${configuredUrl.replace(/\/+$/, '')}${EMAIL_CHANGE_CALLBACK_PATH}`;
};

export const getEmailChangeLinkError = (locationLike) => {
  const source = locationLike || (typeof window !== 'undefined' ? window.location : null);
  if (!source) return null;

  const search = new URLSearchParams(source.search || '');
  const hash = new URLSearchParams((source.hash || '').replace(/^#/, ''));
  const code = search.get('error_code') || search.get('error') || hash.get('error_code') || hash.get('error');
  const description = search.get('error_description') || hash.get('error_description');

  if (!code && !description) return null;
  return {
    code: code || 'email_change_failed',
    message: (description || 'This confirmation link is invalid or has expired.').replace(/\+/g, ' '),
  };
};

export const normalizeEmailChangeError = (error) => {
  const raw = error?.message || String(error || '') || 'Failed to update email. Please try again.';
  const message = raw.toLowerCase();

  if (message.includes('invalid login') || message.includes('invalid credentials')) {
    return 'Current password is incorrect.';
  }
  if (message.includes('email already registered') || message.includes('already been registered')) {
    return 'This email is already registered to another account.';
  }
  if (message.includes('rate limit') || message.includes('too many') || message.includes('security purposes')) {
    return 'Too many attempts. Please wait a few minutes and try again.';
  }
  return raw;
};
