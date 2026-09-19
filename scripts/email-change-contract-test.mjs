import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  EMAIL_CHANGE_CALLBACK_PATH,
  getEmailChangeLinkError,
  getEmailChangeRedirectUrl,
  normalizeEmailChangeError,
} from '../src/lib/emailChange.js';

const redirect = getEmailChangeRedirectUrl({
  location: { origin: 'https://cargoexpress-ph.online', hostname: 'cargoexpress-ph.online' },
});
assert.equal(redirect, `https://cargoexpress-ph.online${EMAIL_CHANGE_CALLBACK_PATH}`);

const localRedirect = getEmailChangeRedirectUrl({
  location: { origin: 'http://localhost:5173', hostname: 'localhost' },
  appUrl: 'https://cargoexpress-ph.online/',
});
assert.equal(localRedirect, `https://cargoexpress-ph.online${EMAIL_CHANGE_CALLBACK_PATH}`);

assert.deepEqual(
  getEmailChangeLinkError({ search: '?error=access_denied&error_description=Link+expired', hash: '' }),
  { code: 'access_denied', message: 'Link expired' }
);
assert.equal(
  normalizeEmailChangeError(new Error('Invalid login credentials')),
  'Current password is incorrect.'
);
assert.equal(
  normalizeEmailChangeError(new Error('Email rate limit exceeded')),
  'Too many attempts. Please wait a few minutes and try again.'
);

const [authContext, page, callbackPage, app] = await Promise.all([
  readFile(new URL('../src/contexts/AuthContext.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/shared/ChangeEmailPage.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/auth/EmailChangeConfirmationPage.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.jsx', import.meta.url), 'utf8'),
]);

assert.match(authContext, /emailRedirectTo:\s*getEmailChangeRedirectUrl\(\)/);
assert.match(authContext, /type:\s*'email_change'/);
assert.match(authContext, /Email change requested/);
assert.match(page, /<form[^>]+onSubmit=\{handleSubmit\}/);
assert.match(page, /Confirm both email addresses/);
assert.match(page, /Resend confirmation messages/);
assert.match(callbackPage, /One more confirmation needed/);
assert.match(callbackPage, /Email changed successfully/);
assert.match(app, /path:\s*'\/email-change-confirmation'/);

console.log('Email-change production contract passed.');
