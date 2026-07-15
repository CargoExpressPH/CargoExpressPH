import { createContext, useContext, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { disableNotificationsForDevice } from '../lib/firebase-messaging';
import { buildProfileAddress, normalizeProfileAddressFields } from '../lib/address';
import { getProfile, createProfile } from '../lib/database';
import useNetworkRecovery from '../hooks/useNetworkRecovery';

const AuthContext = createContext({});

export const useAuth = () => useContext(AuthContext);

const getPasswordResetRedirectUrl = () => {
  if (typeof window !== 'undefined' && window.location.origin && !window.location.hostname.includes('localhost')) {
    return `${window.location.origin}/reset-password`;
  }
  const fallback = import.meta.env.VITE_APP_URL || 'https://cargoexpress-ph.vercel.app';
  return `${fallback.replace(/\/+$/, '')}/reset-password`;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  // Flag to prevent onAuthStateChange from fetching profile during login/registration.
  // The login() and register() functions handle fetchProfile themselves.
  const isAuthAction = useRef(false);

  useEffect(() => {
    let isMounted = true;

    const initialize = async () => {
      try {
        const { data: { session }, error } = await supabase.auth.getSession();

        if (error) {
          if (isMounted) setLoading(false);
          return;
        }

        if (session?.user) {
          if (isMounted) setUser(session.user);
          fetchProfile(session.user.id, isMounted);
        } else {
          if (isMounted) setLoading(false);
        }
      } catch (err) {
        if (isMounted) setLoading(false);
      }
    };

    initialize();

    // Listen for auth changes (sign in / sign out)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (!isMounted) return;

        if (event === 'SIGNED_OUT') {
          setUser(null);
          setUserProfile(null);
          setLoading(false);
          return;
        }

        if (session?.user) {
          setUser(session.user);
          if (event === 'SIGNED_IN' && !isAuthAction.current) {
            fetchProfile(session.user.id, isMounted);
          } else {
            // Ensure loading is cleared for TOKEN_REFRESHED or other events
            setLoading(false);
          }
        } else {
          setUser(null);
          setUserProfile(null);
          setLoading(false);
        }
      }
    );

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  /**
   * fetchProfile — always reads from the `profiles` table (Single Source of Truth).
   * Fallback behaviour: if the profile row doesn't exist yet, or takes too long,
   * we set a minimal placeholder so the app never hangs.
   */
  const fetchProfile = async (userId, isMounted = true) => {
    let timeoutId;
    try {
      const profilePromise = getProfile(userId);
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Profile fetch timeout')), 15000);
      });
      const profile = await Promise.race([profilePromise, timeoutPromise]);
      clearTimeout(timeoutId);
      if (isMounted) {
        setUserProfile(profile);
        setLoading(false);
      }
      return { success: true, profile };
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      if (isMounted) {
        setUserProfile(prev => {
          // If we already have a valid profile, preserve it during transient network errors
          if (prev && prev.id === userId && prev.role) {
            return prev;
          }
          return { id: userId, role: null, name: '', email: '' };
        });
        setLoading(false);
      }
      return { success: false, error };
    }
  };

  const login = async (email, password) => {
    try {
      isAuthAction.current = true;
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      
      setLoading(true);
      const profileResult = await fetchProfile(data.user.id);
      
      if (!profileResult.success) {
        // If profile fetching fails, clear the broken session and surface the error.
        await supabase.auth.signOut();
        throw new Error(`Failed to retrieve user profile: ${profileResult.error.message || 'Unknown database error'}`);
      }

      isAuthAction.current = false;
      return { success: true, user: data.user };
    } catch (error) {
      isAuthAction.current = false;
      setLoading(false);
      let msg = error.message || 'An unexpected error occurred.';
      // Map Supabase generic error to user-friendly messages
      if (msg.toLowerCase().includes('invalid login credentials') ||
          msg.toLowerCase().includes('invalid login')) {
        msg = 'Incorrect password or email.';
      } else if (msg.toLowerCase().includes('email not confirmed')) {
        msg = 'Your email is not confirmed. Please check your inbox.';
      } else if (msg.toLowerCase().includes('rate limit') ||
                 msg.toLowerCase().includes('too many')) {
        msg = 'Too many failed attempts. Please wait a few minutes and try again.';
      }
      return { success: false, error: msg };
    }
  };

  const register = async (email, password, profileData) => {
    try {
      setLoading(true);

      // Set flag BEFORE signUp so onAuthStateChange skips the premature fetchProfile.
      isAuthAction.current = true;

      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;

      const normalizedAddress = normalizeProfileAddressFields(profileData);
      const combinedAddress = buildProfileAddress(normalizedAddress);

      await createProfile({
        id: data.user.id,
        email,
        name: profileData.name,
        facebook_name: profileData.facebook_name || null,
        phone: profileData.phone || null,
        role: 'customer',
        address: combinedAddress || null,
        address_lot_block: normalizedAddress.address_lot_block || null,
        address_street: normalizedAddress.address_street || null,
        address_barangay: normalizedAddress.address_barangay || null,
        address_city: normalizedAddress.address_city || null,
        address_province: normalizedAddress.address_province || null,
        address_landmark: normalizedAddress.address_landmark || null,
      });

      // Profile row now exists — safe to fetch
      await fetchProfile(data.user.id);

      // Clear flag so future sign-ins work normally
      isAuthAction.current = false;

      return { success: true, user: data.user };
    } catch (error) {
      isAuthAction.current = false;
      setLoading(false);
      let msg = error.message;
      if (msg.includes('already registered')) {
        msg = 'This email is already registered. Please sign in instead.';
      }
      return { success: false, error: msg };
    }
  };

  const logout = useCallback(async () => {
    const signedInUserId = user?.id;

    // A browser token must not remain associated with an account after logout.
    // This avoids token conflicts when a different account signs in on this device.
    if (signedInUserId) {
      await disableNotificationsForDevice(signedInUserId);
    }

    // Clear local state immediately so user is logged out even if offline
    setUser(null);
    setUserProfile(null);
    setLoading(false);

    // Remove only auth-related storage keys (preserve PWA cache, user preferences, drafts)
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith('sb-') || k === 'supabase.auth.token')
        .forEach(k => localStorage.removeItem(k));
      sessionStorage.removeItem('fcm_asked');
    } catch (e) {
      // Storage access can fail in some browsers (e.g. incognito Safari)
    }

    try {
      await supabase.auth.signOut();
    } catch (error) {
      // Silently handle sign out errors — local state is already cleared
    }
    
    return { success: true };
  }, [user]);

  const resetPassword = useCallback(async (email) => {
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: getPasswordResetRedirectUrl(),
      });
      if (error) throw error;
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }, []);

  const changePassword = useCallback(async (newPassword) => {
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }, []);

  /**
   * refreshProfile — re-fetches the profiles row from Supabase and updates context state.
   * Call this after any profile save to keep the UI in sync without a full page reload.
   */
  const refreshProfile = useCallback(async () => {
    if (user) await fetchProfile(user.id);
  }, [user]);

  // If network recovers, automatically refresh profile in case it was a minimal fallback
  useNetworkRecovery(refreshProfile);

  const value = useMemo(() => ({
    user,
    userProfile,
    loading,
    isAdmin: userProfile?.role === 'admin',
    isCustomer: userProfile?.role === 'customer',
    login,
    register,
    logout,
    resetPassword,
    changePassword,
    refreshProfile,
  }), [user, userProfile, loading, logout, resetPassword, changePassword, refreshProfile]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export { AuthContext };
