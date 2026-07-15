// Firebase Cloud Messaging — Push Notifications
// Handles FCM token registration, foreground message listening, and token refresh
// Works on Firebase Free (Spark) plan — FCM is free & unlimited

import { deleteToken, getMessaging, getToken, onMessage } from 'firebase/messaging';
import app from './firebase';
import { supabase } from './supabase';

// Key for localStorage timestamp tracking token freshness
const TOKEN_REFRESH_KEY = 'fcm_token_last_refresh';
const TOKEN_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Request notification permission and register FCM token
 * @param {string} userId - Supabase user ID to save the token against
 * @returns {string|null} - FCM token or null if permission denied
 */
export const requestNotificationPermission = async (userId) => {
  // Check browser support
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    return null;
  }

  // Don't re-ask if already denied
  if (Notification.permission === 'denied') {
    return null;
  }

  try {
    // Request permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return null;
    }

    // Firebase app must be initialized
    if (!app) {
      return null;
    }

    const messaging = getMessaging(app);

    // Wait for the service worker registered with scope '/' (matches index.html registration)
    const swRegistration = await navigator.serviceWorker.getRegistration('/')
      || await navigator.serviceWorker.ready;

    const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;

    const token = await getToken(messaging, {
      vapidKey: vapidKey,
      serviceWorkerRegistration: swRegistration,
    });

    if (!token) {
      return null;
    }

    // Save token to user's device tokens list in Supabase
    const { error: tokenSaveError } = await supabase
      .from('user_device_tokens')
      .upsert({ user_id: userId, token: token }, { onConflict: 'token' });
    if (tokenSaveError) throw tokenSaveError;

    // Track when we last refreshed so we can skip redundant refreshes
    try {
      localStorage.setItem(TOKEN_REFRESH_KEY, String(Date.now()));
      localStorage.setItem('fcm_enabled', 'true');
    } catch {}

    return token;
  } catch (err) {
    return null;
  }
};

/**
 * Refresh the FCM token if it's stale (older than 12 hours).
 * Call this on app mount — it's lightweight and non-blocking.
 * @param {string} userId - Supabase user ID
 * @returns {boolean} true if token was refreshed, false otherwise
 */
export const refreshFCMTokenIfNeeded = async (userId) => {
  try {
    const lastRefresh = parseInt(localStorage.getItem(TOKEN_REFRESH_KEY) || '0', 10);
    if (Date.now() - lastRefresh < TOKEN_REFRESH_INTERVAL_MS) return false;

    if (!app || !('Notification' in window) || Notification.permission !== 'granted') return false;

    const messaging = getMessaging(app);
    const swRegistration = await navigator.serviceWorker.getRegistration('/')
      || await navigator.serviceWorker.ready;
    const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;

    const freshToken = await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: swRegistration,
    });

    if (!freshToken) return false;

    // Check if the token is already registered for this user
    const { data, error: tokenLookupError } = await supabase
      .from('user_device_tokens')
      .select('id')
      .eq('token', freshToken)
      .eq('user_id', userId)
      .maybeSingle();
    if (tokenLookupError) throw tokenLookupError;

    if (!data) {
      const { error: tokenInsertError } = await supabase
        .from('user_device_tokens')
        .insert({ user_id: userId, token: freshToken });
      if (tokenInsertError) throw tokenInsertError;
    }

    try { localStorage.setItem(TOKEN_REFRESH_KEY, String(Date.now())); } catch {}
    return true;
  } catch {
    return false;
  }
};

/**
 * Unregister/delete the current FCM token from the database for this device
 * @param {string} userId - Supabase user ID
 */
export const disableNotificationsForDevice = async (userId) => {
  try {
    if (!app || !('Notification' in window) || Notification.permission !== 'granted') return false;

    const messaging = getMessaging(app);
    const swRegistration = await navigator.serviceWorker.getRegistration('/')
      || await navigator.serviceWorker.ready;
    const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;

    const token = await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: swRegistration,
    });

    if (!token) return false;

    const { error: deleteError } = await supabase
      .from('user_device_tokens')
      .delete()
      .eq('token', token)
      .eq('user_id', userId);
    if (deleteError) throw deleteError;

    await deleteToken(messaging);
    try { localStorage.setItem('fcm_enabled', 'false'); } catch {}
    return true;
  } catch {
    return false;
  }
};

/**
 * Listen for foreground messages (when app is open)
 * Shows a toast/in-app notification instead of system notification
 * @param {function} callback - Called with message payload
 * @returns {function} unsubscribe function
 */
export const onForegroundMessage = (callback) => {
  if (!app) return () => {};

  try {
    const messaging = getMessaging(app);
    return onMessage(messaging, (payload) => {
      callback(payload);
    });
  } catch (err) {
    return () => {};
  }
};
