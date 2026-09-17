export const INVALID_RECOVERY_LINK_MESSAGE =
  'This password reset link is invalid, expired, or has already been used. Please request a new link.';

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
