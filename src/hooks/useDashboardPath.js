import { useAuth } from '../contexts/AuthContext';

/**
 * Where a signed-in visitor's "Go to Dashboard" link on a public page
 * should go — the same destination RootRedirect in App.jsx sends them to.
 * Null for a guest (or before the profile has loaded), so public headers
 * keep offering Sign In / Sign Up.
 */
export const useDashboardPath = () => {
  const { user, userProfile } = useAuth();
  if (!user || !userProfile?.role) return null;
  return userProfile.role === 'admin' ? '/admin' : '/customer';
};

export default useDashboardPath;
