// Sign-up must never show Supabase's raw email-delivery error to a customer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  friendlySignupError,
  SIGNUP_EMAIL_UNAVAILABLE_MESSAGE,
  SIGNUP_RATE_LIMIT_MESSAGE,
  SIGNUP_ALREADY_REGISTERED_MESSAGE,
  SIGNUP_GENERIC_MESSAGE,
} from '../src/lib/signupErrors.js';

// SMTP failure (revoked email app password, provider outage or daily limit).
assert.equal(friendlySignupError({ message: 'Error sending confirmation email', code: 'unexpected_failure' }), SIGNUP_EMAIL_UNAVAILABLE_MESSAGE);
assert.equal(friendlySignupError({ message: 'Failed to send email: 535 SMTP authentication failed' }), SIGNUP_EMAIL_UNAVAILABLE_MESSAGE);

// Supabase's own email rate limit.
assert.equal(friendlySignupError({ message: 'email rate limit exceeded', code: 'over_email_send_rate_limit' }), SIGNUP_RATE_LIMIT_MESSAGE);
assert.equal(friendlySignupError({ message: 'Too many requests' }), SIGNUP_RATE_LIMIT_MESSAGE);

// Existing behaviour is unchanged.
assert.equal(friendlySignupError({ message: 'User already registered' }), SIGNUP_ALREADY_REGISTERED_MESSAGE);
assert.equal(friendlySignupError(new Error('This email is already registered. Please sign in instead.')), SIGNUP_ALREADY_REGISTERED_MESSAGE);
assert.equal(friendlySignupError({ message: 'Password should be at least 8 characters' }), 'Password should be at least 8 characters');
assert.equal(friendlySignupError({}), SIGNUP_GENERIC_MESSAGE);
assert.equal(friendlySignupError(null), SIGNUP_GENERIC_MESSAGE);

// The raw delivery error is never what the customer sees.
for (const raw of ['Error sending confirmation email', 'Failed to send email']) {
  assert.ok(!friendlySignupError({ message: raw }).includes(raw), `raw "${raw}" must not reach the customer`);
}

// register() routes every failure through the mapper.
const authContext = readFileSync(new URL('../src/contexts/AuthContext.jsx', import.meta.url), 'utf8');
assert.match(authContext, /import \{ friendlySignupError \} from '\.\.\/lib\/signupErrors';/);
assert.match(authContext, /return \{ success: false, error: friendlySignupError\(error\) \};/);

// RegisterPage must not treat a delivery problem as a wrong email address
// (the generic "message mentions email" branch would mark the field invalid
// and send the customer back to step 1).
const registerPage = readFileSync(new URL('../src/pages/auth/RegisterPage.jsx', import.meta.url), 'utf8');
const serviceCheck = registerPage.indexOf('errorMsg === SIGNUP_EMAIL_UNAVAILABLE_MESSAGE');
const emailFieldBranch = registerPage.indexOf("errorMsg.toLowerCase().includes('email')");
assert.ok(serviceCheck > 0, 'RegisterPage checks for the email-delivery message');
assert.ok(registerPage.includes('errorMsg === SIGNUP_RATE_LIMIT_MESSAGE'), 'RegisterPage checks for the rate-limit message');
assert.ok(emailFieldBranch > serviceCheck, 'service problems are handled before the email-field branch');

console.log('signup-error-message-test: passed');
