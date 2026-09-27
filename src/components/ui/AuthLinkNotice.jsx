import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useToast } from '../../hooks/useToast';
import { supabase, initialAuthRedirectHash } from '../../lib/supabase';

/**
 * Supabase Auth sends people back from email links with the outcome in the
 * URL hash, and nothing else in the app reads it:
 *
 *   #message=Confirmation link accepted. Please proceed to confirm link sent to the other email
 *       first click of a secure (two-inbox) email change
 *   #access_token=…&type=email_change
 *       second click: the change is done
 *   #access_token=…&type=signup
 *       sign-up confirmation link: the account is active and signed in
 *   #error=access_denied&error_code=otp_expired&error_description=…
 *       an expired or reused link of any kind
 *
 * Without this, each of those lands on a page with no word on what happened.
 * Password-recovery links are left alone: AuthContext routes them to
 * /reset-password, which reports its own outcome.
 */
export const readAuthLinkNotice = (hash = '') => {
  const params = new URLSearchParams(String(hash).replace(/^#/, ''));
  if (params.get('type') === 'recovery') return null;

  if (params.get('error') || params.get('error_code') || params.get('error_description')) {
    return {
      kind: 'error',
      text: 'This email link is invalid or has expired. Please request a new one.',
    };
  }

  const message = params.get('message') || '';
  if (/other email/i.test(message)) {
    return {
      kind: 'info',
      text: 'One more step: open the confirmation link we sent to your other email address to finish changing your email.',
    };
  }

  if (params.get('type') === 'email_change' && params.get('access_token')) {
    return { kind: 'success', text: 'Your email address has been updated.', token: params.get('access_token') };
  }

  // The sign-up confirmation link: the account is now active and signed in.
  if (params.get('type') === 'signup' && params.get('access_token')) {
    return { kind: 'success', text: 'Your email is confirmed. Welcome to CargoExpress PH!', token: params.get('access_token') };
  }

  return null;
};

const AuthLinkNotice = () => {
  const { pathname } = useLocation();
  const toast = useToast();
  // The Supabase client may already have consumed the hash by the first React
  // render. Read the copy captured before createClient ran in that case.
  const notice = useRef(
    typeof window !== 'undefined' && pathname !== '/reset-password'
      ? readAuthLinkNotice(initialAuthRedirectHash || window.location.hash)
      : null,
  );

  useEffect(() => {
    const current = notice.current;
    if (!current) return;
    notice.current = null;
    // Drop a message/error hash so a reload or Back does not show it again.
    // A token-bearing hash is left for the Supabase client, which consumes it.
    if (!window.location.hash.includes('access_token=')) {
      try {
        window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
      } catch {
        // History can be unavailable in embedded browsers; the notice still shows.
      }
    }
    if (current.kind === 'success') {
      // Only claim success once the Supabase client has accepted THIS link's
      // token as the session (getSession waits for it). A hand-edited URL, even
      // opened while signed in, must not produce 'Your email address has been updated'.
      supabase.auth.getSession()
        .then(({ data }) => { if (data?.session?.access_token === current.token) toast.success(current.text, 8000); })
        .catch(() => {});
      return;
    }
    toast[current.kind](current.text, 8000);
  }, [toast]);

  return null;
};

export default AuthLinkNotice;
