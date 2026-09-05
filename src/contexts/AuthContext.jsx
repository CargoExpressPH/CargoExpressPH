import { createContext, useContext, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { disablePushForCurrentDevice } from '../lib/push-notifications';
import { normalizeProfileAddressFields } from '../lib/address';
import { LEGAL_DOCUMENT_VERSION } from '../constants/legalDocuments';
import { getProfile, createProfile } from '../lib/database';
import { logAuth } from '../lib/activityLog';
import useNetworkRecovery from '../hooks/useNetworkRecovery';
import { AUTH_TRANSITIONS } from '../lib/authRouteState';

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
  const [authTransition, setAuthTransition] = useState(null);

  // Flag to prevent onAuthStateChange from fetching profile during login/registration.
  // The login() and register() functions handle fetchProfile themselves.
  const isAuthAction = useRef(false);

  // Whose profile is currently loaded. Lets onAuthStateChange tell a real
  // account switch apart from GoTrue re-emitting SIGNED_IN on a token refresh
  // or a tab focus, which it does routinely and which must not trigger work.
  const lastProfileUserId = useRef(null);

  useEffect(() => {
    let isMounted = true;

    // Recovery links use the implicit flow: GoTrue appends
    // `#access_token=...&type=recovery&...` to whichever URL it redirects to,
    // and the Supabase client — a module-level singleton created well before
    // this component mounts — can parse that hash and fire PASSWORD_RECOVERY
    // (below) before this effect's listener even subscribes. Checking the
    // hash directly, synchronously, on mount closes that race outright rather
    // than hoping the event is still in flight when we ask.
    if (window.location.hash.includes('type=recovery') && window.location.pathname !== '/reset-password') {
      window.location.assign(`/reset-password${window.location.hash}`);
      return () => { isMounted = false; };
    }

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
          setAuthTransition(null);
          setUser(null);
          setUserProfile(null);
          setLoading(false);
          return;
        }

        // A recovery link's token gives GoTrue a real, working session — that's
        // what lets updateUser({ password }) succeed — but it must never be
        // treated as "the user is logged in". Skip the normal sign-in handling
        // entirely (no profile fetch, no `user` state) and just get them to the
        // page that can act on it. This is deliberately NOT `useNavigate()`:
        // AuthProvider wraps <RouterProvider> (see App.jsx), so it sits outside
        // the router context and has no navigate() to call. A hard navigation
        // also works regardless of which URL Supabase's own redirect actually
        // landed on — detectSessionInUrl parses the recovery hash from
        // wherever the browser lands the moment this client boots, and the
        // resulting session lives in the Supabase client, not in the URL, so
        // nothing is lost by replacing the location.
        if (event === 'PASSWORD_RECOVERY') {
          setAuthTransition(null);
          setLoading(false);
          if (window.location.pathname !== '/reset-password') {
            window.location.assign('/reset-password');
          }
          return;
        }

        if (session?.user) {
          // Replace the user object ONLY when the identity actually changed.
          // GoTrue hands us a fresh object on every token refresh; storing it
          // unconditionally changes the context value on a timer, re-rendering
          // every consumer in the app for no semantic change.
          setUser(prev =>
            prev && prev.id === session.user.id && prev.email === session.user.email
              ? prev
              : session.user
          );

          // Which events justify re-reading the profile row?
          //
          // NOT plain SIGNED_IN. GoTrue re-emits SIGNED_IN on every token
          // refresh and whenever the tab regains focus — it does not mean "a
          // user just signed in". Refetching there put a network round trip on
          // a ~1-minute cadence whose failure path rewrote userProfile, and a
          // userProfile without a role makes ProtectedRoute redirect. That is
          // the spontaneous eject out of a half-filled booking form.
          //
          // A genuine account switch still refetches, because the id changes.
          // USER_UPDATED fires after an email change is confirmed.
          const isDifferentUser = lastProfileUserId.current !== session.user.id;
          const shouldFetchProfile =
            event === 'USER_UPDATED' ||
            (event === 'SIGNED_IN' && !isAuthAction.current && isDifferentUser);

          if (shouldFetchProfile) {
            fetchProfile(session.user.id, isMounted);
          } else if (event !== 'INITIAL_SESSION' && !isAuthAction.current) {
            // Ensure loading is cleared for TOKEN_REFRESHED or other events
            // NOT already being driven by login()/register() below.
            // DO NOT clear loading on INITIAL_SESSION, because initialize() handles fetching the profile.
            //
            // DO NOT clear it while isAuthAction.current is true either: both
            // login() and register() await their own fetchProfile() before
            // they're done, and signUp()/signInWithPassword() fire this
            // 'SIGNED_IN' event mid-flight, well before that. Clearing
            // `loading` here raced register()'s still-in-flight
            // createProfile/fetchProfile — AuthRoute would see loading=false
            // with userProfile still null and fall through to `children`,
            // remounting RegisterPage from scratch (wiping its local
            // `success`/step state) for the one render before userProfile
            // finally landed and the real redirect fired. That remount was
            // the registration "flash back to the form" bug. login()/
            // register() own this loading flag end-to-end and clear it
            // themselves once truly done — this listener steps back
            // entirely whenever one of them is in flight.
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
        lastProfileUserId.current = userId;
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
      // AuthRoute must keep this exact RegisterPage mounted while the global
      // session/profile state changes underneath it. Otherwise its local
      // success state is destroyed and the form can flash back on screen.
      setAuthTransition(AUTH_TRANSITIONS.REGISTERING);
      setLoading(true);

      const { legal_consent: legalConsent, ...profileFields } = profileData || {};
      if (
        legalConsent?.termsAccepted !== true ||
        legalConsent?.privacyAccepted !== true ||
        legalConsent?.version !== LEGAL_DOCUMENT_VERSION
      ) {
        throw new Error('You must agree to the current Terms of Service and Privacy Policy to create an account.');
      }

      // Set flag BEFORE signUp so onAuthStateChange skips the premature fetchProfile.
      isAuthAction.current = true;

      // These fields are written during the same auth transaction. The database
      // trigger validates the version against its published-document registry,
      // records both consents, AND inserts a minimal `profiles` row (id, email,
      // name, role) atomically with the auth user — see handle_new_user() /
      // on_auth_user_created. That guarantee is what the recovery path below
      // depends on: a signed-up user always has SOME profile row, so a failure
      // in the detailed upsert that follows is never "no profile exists," only
      // "the address/phone details never made it in."
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            name: profileFields.name,
            legal_terms_accepted: true,
            legal_privacy_accepted: true,
            legal_policy_version: legalConsent.version,
          },
        },
      });
      if (error) throw error;

      const normalizedAddress = normalizeProfileAddressFields(profileFields);
      const profilePayload = {
        id: data.user.id,
        email,
        name: profileFields.name,
        facebook_name: profileFields.facebook_name || null,
        phone: profileFields.phone || null,
        role: 'customer',
        address_lot_block: normalizedAddress.address_lot_block || null,
        address_street: normalizedAddress.address_street || null,
        address_barangay: normalizedAddress.address_barangay || null,
        address_city: normalizedAddress.address_city || null,
        address_province: normalizedAddress.address_province || null,
        address_landmark: normalizedAddress.address_landmark || null,
        wants_announcements: profileFields.wants_announcements === true,
      };

      // The auth user now exists — Supabase has already handed this browser a
      // live session for it, whether or not the rest of this function
      // succeeds. That means a thrown error from here on must never just
      // report failure: ProtectedRoute requires a `userProfile`, and with none
      // set this account would be signed in but permanently bounced back to
      // /login, with no profile row for a retry and "already registered"
      // blocking a second signUp(). Every path below ends in fetchProfile()
      // so the account is always left usable.
      let profileSaved = true;
      try {
        await createProfile(profilePayload);
      } catch (profileError) {
        // One retry: registration is a multi-request sequence, and the most
        // likely cause of a failure here is a transient network blip rather
        // than a real conflict — worth one more try before accepting the
        // address/phone details are lost.
        await new Promise(resolve => setTimeout(resolve, 800));
        try {
          await createProfile(profilePayload);
        } catch (retryError) {
          profileSaved = false;
        }
      }

      // Always attempt to load the profile. The trigger's baseline row means
      // this succeeds even when both createProfile attempts above failed —
      // that is what turns a failed detail-write into "the account exists and
      // is usable, please finish your profile" instead of a dead end.
      const fetchResult = await fetchProfile(data.user.id);
      isAuthAction.current = false;

      if (!fetchResult.success) {
        // Genuinely nothing usable came back (e.g. the network is down for
        // this whole request sequence) — surface the real failure rather than
        // pretending the account is ready.
        throw new Error(
          profileSaved
            ? `Account created, but we could not load your profile: ${fetchResult.error?.message || 'Unknown error'}. Please try logging in.`
            : 'Your account was created, but we could not save your address and phone number. Please log in and complete your profile from the Profile page.'
        );
      }

      return { success: true, user: data.user, profileIncomplete: !profileSaved };
    } catch (error) {
      isAuthAction.current = false;
      setAuthTransition(null);
      setLoading(false);
      let msg = error.message || 'Registration failed. Please try again.';
      if (msg.includes('already registered')) {
        msg = 'This email is already registered. Please sign in instead.';
      }
      return { success: false, error: msg };
    }
  };

  const logout = useCallback(async () => {
    const signedInUserId = user?.id;

    // Logged HERE, not at a button. There are two ways out — the sidebar and
    // the profile page — and only the sidebar was logging it, so half of every
    // admin's sessions ended with no record. This is the one funnel both go
    // through, and it fires while the session still exists: after signOut()
    // there is no auth.uid() for guard_activity_log_insert to attribute the
    // row to, and the insert would be dropped.
    if (signedInUserId) {
      await logAuth(userProfile?.role === 'admin' ? 'Admin Logged Out' : 'User Logged Out', {
        recordId: signedInUserId,
        recordRef: userProfile?.name || user?.email || null,
        details: 'Session ended.',
      });
    }

    // Remove only this browser/device registration before signOut(). The
    // database RPC uses the current auth session and leaves the same account's
    // registrations on other phones untouched.
    if (signedInUserId) {
      try {
        await disablePushForCurrentDevice(signedInUserId);
      } catch {
        // Logout must still complete if the browser push API or network is
        // unavailable. The next account's explicit enable can claim the device.
      }
    }

    // Clear local state immediately so user is logged out even if offline
    lastProfileUserId.current = null;
    setAuthTransition(null);
    setUser(null);
    setUserProfile(null);
    setLoading(false);

    // Remove only auth-related storage keys (preserve PWA cache, user preferences, drafts)
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith('sb-') || k === 'supabase.auth.token')
        .forEach(k => localStorage.removeItem(k));
      sessionStorage.removeItem('fcm_asked');
      sessionStorage.removeItem('admin_fcm_asked');
    } catch (e) {
      // Storage access can fail in some browsers (e.g. incognito Safari)
    }

    try {
      await supabase.auth.signOut();
    } catch (error) {
      // Silently handle sign out errors — local state is already cleared
    }
    
    return { success: true };
  }, [user, userProfile]);

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
   * changeEmail — world-class email update flow:
   * 1. Re-authenticates with the current password (Supabase rejects sensitive
   *    updates when the session is older than ~1 hour).
   * 2. Requests the change via supabase.auth.updateUser({ email }).
   * 3. Supabase emails a confirmation link to the NEW address; the email only
   *    changes after the link is clicked (USER_UPDATED event + DB trigger sync
   *    the profiles.email column).
   */
  const changeEmail = useCallback(async (newEmail, currentPassword) => {
    try {
      if (!user?.email) throw new Error('You are not logged in.');

      // 1) Re-authenticate with the current password
      const { error: verifyError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: currentPassword,
      });
      if (verifyError) {
        if (verifyError.message?.toLowerCase().includes('invalid login')) {
          throw new Error('Current password is incorrect.');
        }
        throw verifyError;
      }

      // 2) Request the email change
      const { error } = await supabase.auth.updateUser({ email: newEmail });
      if (error) throw error;
      return { success: true };
    } catch (error) {
      let msg = error.message || 'Failed to update email. Please try again.';
      if (msg.toLowerCase().includes('email already registered') ||
          msg.toLowerCase().includes('already been registered')) {
        msg = 'This email is already registered to another account.';
      } else if (msg.toLowerCase().includes('rate limit') ||
                 msg.toLowerCase().includes('too many')) {
        msg = 'Too many attempts. Please wait a few minutes and try again.';
      }
      return { success: false, error: msg };
    }
  }, [user?.email]);

  /**
   * refreshProfile — re-fetches the profiles row from Supabase and updates context state.
   * Call this after any profile save to keep the UI in sync without a full page reload.
   */
  const refreshProfile = useCallback(async () => {
    if (user) await fetchProfile(user.id);
  }, [user]);

  const completeRegistrationTransition = useCallback(() => {
    setAuthTransition(current => (
      current === AUTH_TRANSITIONS.REGISTERING ? null : current
    ));
  }, []);

  // If network recovers, automatically refresh profile in case it was a minimal fallback
  useNetworkRecovery(refreshProfile);

  const value = useMemo(() => ({
    user,
    userProfile,
    loading,
    authTransition,
    isAdmin: userProfile?.role === 'admin',
    isCustomer: userProfile?.role === 'customer',
    login,
    register,
    completeRegistrationTransition,
    logout,
    resetPassword,
    changePassword,
    changeEmail,
    refreshProfile,
  }), [user, userProfile, loading, authTransition, logout, resetPassword, changePassword, changeEmail, refreshProfile, completeRegistrationTransition]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export { AuthContext };
