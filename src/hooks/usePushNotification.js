// usePushNotification.js
// Dual-path push notification subscription:
//   • Android / Chrome / Edge  →  Firebase Cloud Messaging (FCM) token
//   • iOS Safari PWA (16.4+)   →  Native Web Push subscription (VAPID)
//
// iOS Safari does NOT support the Firebase Messaging SDK at all.
// The native PushManager API is the only way to get push on iPhone.

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import {
  requestNotificationPermission,
  refreshFCMTokenIfNeeded,
  disableNotificationsForDevice,
  onForegroundMessage,
} from '../lib/firebase-messaging';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** True when running as installed PWA on iOS (Add to Home Screen) */
const isIosPwa = () => {
  const ua = window.navigator.userAgent.toLowerCase();
  const isIos = /iphone|ipad|ipod/.test(ua);
  const isStandalone =
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  return isIos && isStandalone;
};

/** True on any iOS device (browser or installed) */
const isIos = () => /iphone|ipad|ipod/i.test(window.navigator.userAgent);

/** True on iOS 16.4 or later (minimum for Web Push support) */
const isIosPushSupported = () => {
  if (!isIos()) return false;
  const match = window.navigator.userAgent.match(/OS (\d+)_/);
  if (!match) return false;
  return parseInt(match[1], 10) >= 16;
};

/**
 * Convert a base64url VAPID public key to a Uint8Array
 * required by PushManager.subscribe()
 */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

// ── iOS Web Push subscription ─────────────────────────────────────────────────

/**
 * Subscribe an iOS PWA user via the native Web Push API.
 * Saves the subscription JSON as the "token" in user_device_tokens
 * with a prefix so the edge function knows to use Web Push delivery.
 */
async function subscribeIosPush(userId) {
  try {
    if (!('PushManager' in window)) return null;

    const swReg =
      (await navigator.serviceWorker.getRegistration('/')) ||
      (await navigator.serviceWorker.ready);

    if (!swReg) return null;

    // Use the standard VAPID public key for iOS Web Push
    // (VITE_VAPID_PUBLIC_KEY) — distinct from the Firebase-specific VAPID key
    const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY || import.meta.env.VITE_FIREBASE_VAPID_KEY;
    if (!vapidKey) return null;

    // Check for existing subscription first
    let subscription = await swReg.pushManager.getSubscription();

    if (!subscription) {
      subscription = await swReg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    }

    if (!subscription) return null;

    // Prefix "webpush:" so the edge function routes it correctly
    const token = 'webpush:' + JSON.stringify(subscription.toJSON());

    const { error } = await supabase
      .from('user_device_tokens')
      .upsert({ user_id: userId, token }, { onConflict: 'token' });

    if (error) throw error;

    try {
      localStorage.setItem('ios_push_subscribed', 'true');
      localStorage.setItem('fcm_enabled', 'true');
    } catch {}

    return token;
  } catch (err) {
    console.warn('[PushNotification] iOS Web Push subscription failed:', err);
    return null;
  }
}

/**
 * Unsubscribe iOS Web Push and remove from database
 */
async function unsubscribeIosPush(userId) {
  try {
    const swReg = await navigator.serviceWorker.getRegistration('/');
    if (!swReg) return;

    const subscription = await swReg.pushManager.getSubscription();
    if (!subscription) return;

    const token = 'webpush:' + JSON.stringify(subscription.toJSON());

    await supabase
      .from('user_device_tokens')
      .delete()
      .eq('token', token)
      .eq('user_id', userId);

    await subscription.unsubscribe();
    localStorage.removeItem('ios_push_subscribed');
  } catch (err) {
    console.warn('[PushNotification] iOS unsubscribe failed:', err);
  }
}

// ── Main hook ─────────────────────────────────────────────────────────────────

/**
 * usePushNotification
 *
 * Unified push notification hook — handles both FCM (Android) and
 * native Web Push (iOS PWA) transparently.
 *
 * @param {string} userId   - Supabase user ID
 * @param {function} onMsg  - Callback for in-app foreground messages
 */
export function usePushNotification(userId, onMsg) {
  const [permissionState, setPermissionState] = useState('default');
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isIosDevice] = useState(isIos);
  const [isIosInstalled] = useState(isIosPwa);
  const [iosPushSupported] = useState(isIosPushSupported);

  // ── Request / enable push ────────────────────────────────────────────────
  const enablePush = useCallback(async () => {
    if (!userId) return { success: false, reason: 'no_user' };
    if (!('Notification' in window)) return { success: false, reason: 'not_supported' };

    const permission = await Notification.requestPermission();
    setPermissionState(permission);

    if (permission !== 'granted') return { success: false, reason: 'denied' };

    // iOS PWA path — use native Web Push
    if (isIosPwa()) {
      const token = await subscribeIosPush(userId);
      if (token) {
        setIsSubscribed(true);
        return { success: true, platform: 'ios-webpush' };
      }
      return { success: false, reason: 'ios_subscribe_failed' };
    }

    // Android / Chrome / Desktop — use FCM
    const token = await requestNotificationPermission(userId);
    if (token) {
      setIsSubscribed(true);
      return { success: true, platform: 'fcm' };
    }
    return { success: false, reason: 'fcm_failed' };
  }, [userId]);

  // ── Disable push ─────────────────────────────────────────────────────────
  const disablePush = useCallback(async () => {
    if (!userId) return;
    if (isIosPwa()) {
      await unsubscribeIosPush(userId);
    } else {
      await disableNotificationsForDevice(userId);
    }
    setIsSubscribed(false);
  }, [userId]);

  // ── Auto-init on mount ───────────────────────────────────────────────────
  useEffect(() => {
    if (!userId || !('Notification' in window)) return;

    const perm = Notification.permission;
    setPermissionState(perm);

    if (perm !== 'granted') return;

    // Already subscribed — refresh silently in background
    if (isIosPwa()) {
      // Check existing subscription
      navigator.serviceWorker.getRegistration('/').then(async (reg) => {
        if (!reg) return;
        const sub = await reg.pushManager.getSubscription();
        setIsSubscribed(!!sub);
        // Re-register if missing (e.g. after SW update)
        if (!sub) {
          const token = await subscribeIosPush(userId);
          setIsSubscribed(!!token);
        }
      });
    } else {
      // FCM refresh check
      refreshFCMTokenIfNeeded(userId).then(() => {
        setIsSubscribed(localStorage.getItem('fcm_enabled') === 'true');
      });
      setIsSubscribed(localStorage.getItem('fcm_enabled') === 'true');
    }
  }, [userId]);

  // ── Foreground FCM message listener (Android/Chrome) ────────────────────
  useEffect(() => {
    if (!userId || isIosPwa() || typeof onMsg !== 'function') return;
    const unsub = onForegroundMessage((payload) => {
      const notif = payload.notification || {};
      const data  = payload.data         || {};
      onMsg({
        title: notif.title || 'CargoExpress PH',
        body:  notif.body  || 'You have a new update',
        url:   data.url    || '/customer/notifications',
      });
    });
    return unsub;
  }, [userId, onMsg]);

  return {
    permissionState,
    isSubscribed,
    isIosDevice,
    isIosInstalled,
    iosPushSupported,
    enablePush,
    disablePush,
  };
}
