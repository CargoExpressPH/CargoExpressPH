// Turns a Supabase sign-up error into a message a customer can act on.
//
// The confirmation email is sent by Supabase Auth through its configured SMTP
// server. When that server rejects the send (for example a revoked email app
// password, or the provider's daily sending limit), GoTrue fails the sign-up
// with "Error sending confirmation email". Showing that raw text tells the
// customer nothing about what to do, so it is mapped here.

export const SIGNUP_EMAIL_UNAVAILABLE_MESSAGE =
  "We couldn't send your confirmation email right now. Please try again in a few minutes. If it keeps happening, please contact us.";

export const SIGNUP_RATE_LIMIT_MESSAGE =
  'Too many sign-up attempts right now. Please wait a few minutes and try again.';

export const SIGNUP_ALREADY_REGISTERED_MESSAGE =
  'This email is already registered. Please sign in instead.';

export const SIGNUP_GENERIC_MESSAGE = 'Registration failed. Please try again.';

export function friendlySignupError(error) {
  const message = String(error?.message || '');
  const code = String(error?.code || '');

  if (/already registered/i.test(message)) return SIGNUP_ALREADY_REGISTERED_MESSAGE;
  if (code === 'over_email_send_rate_limit' || /rate limit|too many/i.test(message)) {
    return SIGNUP_RATE_LIMIT_MESSAGE;
  }
  if (/sending confirmation email|error sending|failed to send|smtp/i.test(message)) {
    return SIGNUP_EMAIL_UNAVAILABLE_MESSAGE;
  }
  return message || SIGNUP_GENERIC_MESSAGE;
}
