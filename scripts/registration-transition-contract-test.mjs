import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AUTH_TRANSITIONS,
  resolveAuthRouteState,
} from '../src/lib/authRouteState.js';

const customer = { id: 'customer-1' };
const customerProfile = { id: customer.id, role: 'customer' };

assert.deepEqual(
  resolveAuthRouteState({ loading: true }),
  { kind: 'loading' },
  'The initial session restore must keep using the full-page loader.',
);

for (const state of [
  { loading: true, authTransition: AUTH_TRANSITIONS.REGISTERING },
  { loading: true, user: customer, authTransition: AUTH_TRANSITIONS.REGISTERING },
  {
    loading: false,
    user: customer,
    userProfile: customerProfile,
    authTransition: AUTH_TRANSITIONS.REGISTERING,
  },
]) {
  assert.deepEqual(
    resolveAuthRouteState(state),
    { kind: 'content' },
    'Registration must keep one mounted RegisterPage from submit through its success screen.',
  );
}

assert.deepEqual(
  resolveAuthRouteState({ loading: false, user: customer, userProfile: customerProfile }),
  { kind: 'redirect', to: '/customer' },
  'Completing the registration transition must route directly to the customer app.',
);

assert.deepEqual(
  resolveAuthRouteState({ loading: false }),
  { kind: 'content' },
  'A signed-out visitor must still be able to see an auth page.',
);

const authContext = readFileSync('src/contexts/AuthContext.jsx', 'utf8');
const registerPage = readFileSync('src/pages/auth/RegisterPage.jsx', 'utf8');
const app = readFileSync('src/App.jsx', 'utf8');

assert.match(authContext, /setAuthTransition\(AUTH_TRANSITIONS\.REGISTERING\)/);
assert.match(authContext, /completeRegistrationTransition/);
assert.match(registerPage, /preloadCustomerHomePage\(\)/);
assert.match(registerPage, /completeRegistrationTransition\(\)/);
assert.match(registerPage, /navigate\('\/customer',\s*\{\s*replace:\s*true\s*\}\)/);
assert.match(app, /resolveAuthRouteState\(/);

console.log('Registration transition contract tests passed.');
