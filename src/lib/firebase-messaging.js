// Firebase Cloud Messaging for Android, Chrome, Edge, and desktop browsers.
// Push registration is verified against Supabase; browser storage is never
// treated as proof that a token is active.

import { deleteToken, getMessaging, getToken, onMessage } from 'firebase/messaging';
import app from './firebase';
import {
  clearLegacyPushState,
  hasPushDeviceRegistration,
  registerPushDevice,
  removePushDeviceRegistration,
} from './push-device';

const isFcmSupported = () => (
  typeof window !== 'undefined'
  && 'Notification' in window
  && 'serviceWorker' in navigator
);

const getMessagingContext = async () => {
  if (!app || !isFcmSupported() || Notification.permission !== 'granted') return null;

  const messaging = getMessaging(app);
  const swRegistration = await navigator.serviceWorker.getRegistration('/')
    || await navigator.serviceWorker.ready;
  const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
  const options = { serviceWorkerRegistration: swRegistration };
  if (vapidKey) options.vapidKey = vapidKey;

  return { messaging, token: await getToken(messaging, options) };
};

/** Read the current browser token without asking for permission. */
export const getCurrentFcmToken = async () => {
  try {
    const context = await getMessagingContext();
    return context?.token || null;
  } catch {
    return null;
  }
};

/** Return actual FCM registration state for the current user/device. */
export const getFcmPushStatus = async (userId) => {
  const supported = isFcmSupported();
  const permission = supported ? Notification.permission : 'unsupported';

  if (!supported || permission !== 'granted') {
    return {
      platform: 'fcm',
      supported,
      permission,
      registered: false,
      subscribed: false,
    };
  }

  const token = await getCurrentFcmToken();
  if (!token) {
    return {
      platform: 'fcm',
      supported: true,
      permission,
      registered: false,
      subscribed: false,
    };
  }

  const registered = await hasPushDeviceRegistration(userId, token);
  return {
    platform: 'fcm',
    supported: true,
    permission,
    registered,
    subscribed: registered,
  };
};

/**
 * Request permission when needed and register the current FCM token.
 * `permissionAlreadyGranted` prevents the Profile screen from prompting
 * twice: it owns the permission prompt, then calls this helper to register.
 */
export const requestNotificationPermission = async (userId, { permissionAlreadyGranted = false } = {}) => {
  if (!userId || !isFcmSupported()) return null;
  if (Notification.permission === 'denied') return null;

  try {
    let permission = Notification.permission;
    if (permission !== 'granted') {
      if (permissionAlreadyGranted) return null;
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') return null;

    const token = await getCurrentFcmToken();
    if (!token) return null;

    const registered = await registerPushDevice(userId, token);
    if (!registered) return null;

    clearLegacyPushState();
    return token;
  } catch {
    return null;
  }
};

/**
 * Refresh a token only when this user already enabled push on this device.
 * Permission alone is not consent and must never silently opt an account in.
 */
export const refreshFCMTokenIfNeeded = async (userId) => {
  if (!userId || !isFcmSupported() || Notification.permission !== 'granted') return false;

  const token = await getCurrentFcmToken();
  if (!token) return false;

  // A missing registration means the user disabled push or this is a new
  // account on the device. In both cases, wait for an explicit enable action.
  const wasRegistered = await hasPushDeviceRegistration(userId, token);
  if (!wasRegistered) return false;

  const registered = await registerPushDevice(userId, token);
  if (registered) clearLegacyPushState();
  return registered;
};

/**
 * Remove only the current browser/device registration.
 * Database removal must succeed before the helper reports success. Firebase
 * token deletion is also required when a live token is available.
 */
export const disableNotificationsForDevice = async (userId) => {
  if (!userId) return false;

  const token = await getCurrentFcmToken();
  const removedFromDatabase = await removePushDeviceRegistration(userId, token);
  if (!removedFromDatabase) return false;

  if (token && app) {
    try {
      const deleted = await deleteToken(getMessaging(app));
      if (deleted === false) return false;
    } catch {
      return false;
    }
  }

  clearLegacyPushState();
  return true;
};

/** Listen for foreground FCM messages. */
export const onForegroundMessage = (callback) => {
  if (!app) return () => {};

  try {
    const messaging = getMessaging(app);
    return onMessage(messaging, (payload) => {
      callback(payload);
    });
  } catch {
    return () => {};
  }
};
