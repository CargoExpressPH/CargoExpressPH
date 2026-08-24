import { useState, useEffect, useCallback, useRef } from 'react';
import { onForegroundMessage } from '../lib/firebase-messaging';
import {
  disablePushForCurrentDevice,
  getCurrentPushStatus,
  isIosDevice,
  isIosPwa,
  isIosPushSupported,
  refreshFCMTokenIfNeeded,
  requestNotificationPermission,
  subscribeIosPush,
} from '../lib/push-notifications';

/**
 * Unified push hook:
 * - Android/Chrome/Edge/desktop use Firebase Cloud Messaging.
 * - Installed iOS PWAs use native Web Push.
 *
 * The hook reports server-backed registration state, not a localStorage flag.
 */
export function usePushNotification(userId, onMsg) {
  const [permissionState, setPermissionState] = useState(() => (
    typeof window !== 'undefined' && 'Notification' in window
      ? Notification.permission
      : 'unsupported'
  ));
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isIosDeviceState] = useState(isIosDevice);
  const [isIosInstalled] = useState(isIosPwa);
  const [iosPushSupported] = useState(isIosPushSupported);

  const enablePush = useCallback(async () => {
    if (!userId) return { success: false, reason: 'no_user' };
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return { success: false, reason: 'not_supported' };
    }

    // iOS Safari (not installed) cannot use Web Push.
    if (isIosDevice() && !isIosPwa()) {
      if (!isIosPushSupported()) return { success: false, reason: 'ios_version' };
      return { success: false, reason: 'ios_not_installed' };
    }

    const permission = await Notification.requestPermission();
    setPermissionState(permission);
    if (permission !== 'granted') return { success: false, reason: 'denied' };

    if (isIosPwa()) {
      const token = await subscribeIosPush(userId);
      if (token) {
        setIsSubscribed(true);
        return { success: true, platform: 'ios-webpush' };
      }
      return { success: false, reason: 'ios_subscribe_failed' };
    }

    // Permission was already requested above, so the FCM helper must not ask
    // a second time. It only registers the token here.
    const token = await requestNotificationPermission(userId, { permissionAlreadyGranted: true });
    if (token) {
      setIsSubscribed(true);
      return { success: true, platform: 'fcm' };
    }
    return { success: false, reason: 'fcm_failed' };
  }, [userId]);

  const disablePush = useCallback(async () => {
    if (!userId) return { success: false, reason: 'no_user' };

    const ios = isIosDevice();
    const ok = await disablePushForCurrentDevice(userId);
    if (!ok) {
      return {
        success: false,
        reason: ios ? 'ios_unsubscribe_failed' : 'fcm_unsubscribe_failed',
      };
    }

    setIsSubscribed(false);
    return { success: true, platform: ios ? 'ios-webpush' : 'fcm' };
  }, [userId]);

  // Sync silently on mount, but only refresh an existing registration. A
  // granted browser permission must never re-enable a user who disabled push.
  useEffect(() => {
    let cancelled = false;
    if (!userId || typeof window === 'undefined') return undefined;

    const sync = async () => {
      const status = await getCurrentPushStatus(userId);
      if (cancelled) return;

      setPermissionState(status.permission);
      setIsSubscribed(status.subscribed);
      if (status.permission !== 'granted' || !status.registered) return;

      if (status.platform === 'ios-webpush') {
        // The database row proves prior opt-in. Recreate a missing browser
        // subscription after a service-worker replacement, but never after an
        // explicit disable (which removes the row).
        if (!status.subscribed) {
          const token = await subscribeIosPush(userId);
          if (!cancelled) setIsSubscribed(Boolean(token));
        }
        return;
      }

      const refreshed = await refreshFCMTokenIfNeeded(userId);
      if (!cancelled) setIsSubscribed(refreshed);
    };

    sync().catch(() => {
      if (!cancelled) setIsSubscribed(false);
    });

    return () => { cancelled = true; };
  }, [userId]);

  const onMsgRef = useRef(onMsg);
  useEffect(() => {
    onMsgRef.current = onMsg;
  }, [onMsg]);

  const hasOnMsg = typeof onMsg === 'function';

  // Foreground FCM message listener (Android/Chrome/desktop).
  useEffect(() => {
    if (!userId || isIosPwa() || !hasOnMsg) return undefined;

    const unsubscribe = onForegroundMessage((payload) => {
      if (typeof onMsgRef.current !== 'function') return;
      const notification = payload.notification || {};
      const data = payload.data || {};
      onMsgRef.current({
        title: notification.title || 'CargoExpress PH',
        body: notification.body || 'You have a new update',
        url: data.url || '/customer/notifications',
      });
    });
    return unsubscribe;
  }, [userId, hasOnMsg]);

  return {
    permissionState,
    isSubscribed,
    isIosDevice: isIosDeviceState,
    isIosInstalled,
    iosPushSupported,
    enablePush,
    disablePush,
  };
}
