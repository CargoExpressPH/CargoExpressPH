export const AUTH_TRANSITIONS = Object.freeze({
  REGISTERING: 'registering',
});

/**
 * Decide what an authentication route should render without coupling the
 * decision to React. Registration is deliberately monotonic: once submit has
 * started, the same RegisterPage stays mounted until it has shown success and
 * hands control to the customer route. That preserves all local form/success
 * state while Supabase emits SIGNED_IN and the profile is being completed.
 */
export const resolveAuthRouteState = ({
  user = null,
  userProfile = null,
  loading = false,
  authTransition = null,
} = {}) => {
  if (authTransition === AUTH_TRANSITIONS.REGISTERING) {
    return { kind: 'content' };
  }

  if (loading) return { kind: 'loading' };

  if (user && userProfile?.role) {
    return {
      kind: 'redirect',
      to: userProfile.role === 'admin' ? '/admin' : '/customer',
    };
  }

  return { kind: 'content' };
};
