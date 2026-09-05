import {
  disableNotificationsForDevice,
  getFcmPushStatus,
  refreshFCMTokenIfNeeded,
  requestNotificationPermission,
} from './firebase-messaging';
import {
  clearLegacyPushState,
  hasPushDeviceRegistration,
  registerPushDevice,
  removePushDeviceRegistration,
} from './push-device';
import {
  isAppleMobileDevice,
  isAppleMobileWebPushVersion,
  isStandaloneWebApp,
} from './apple-platform';

/** True on iPhone, iPad, or iPod. */
export const isIosDevice = () => (
  isAppleMobileDevice()
);

/** True when the iOS app was installed with Add to Home Screen. */
export const isIosPwa = () => {
  if (typeof window === 'undefined') return false;
  return isIosDevice() && isStandaloneWebApp();
};

/** True on iOS 16.4 or later, the minimum version with Web Push support. */
export const isIosPushSupported = () => {
  if (!isIosDevice()) return false;
  return isAppleMobileWebPushVersion();
};

/** Safari uses Apple's native Web Push service rather than Firebase. */
export const isSafariBrowser = () => (
  typeof window !== 'undefined'
  && /safari/i.test(window.navigator.userAgent)
  && !/(chrome|chromium|crios|edg|opr|fxios|android)/i.test(window.navigator.userAgent)
);

export const usesAppleWebPush = () => (
  isIosPwa() || (!isIosDevice() && isSafariBrowser())
);

const isAppleWebPushSupported = () => {
  if (typeof window === 'undefined') return false;
  if (isIosDevice()) return isIosPwa() && isIosPushSupported();
  return isSafariBrowser()
    && 'Notification' in window
    && 'serviceWorker' in navigator
    && 'PushManager' in window;
};

const getIosServiceWorkerRegistration = async () => {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration('/');
  return registration || navigator.serviceWorker.ready;
};

const getIosSubscription = async () => {
  if (typeof window === 'undefined' || !('PushManager' in window)) return null;
  const registration = await getIosServiceWorkerRegistration();
  if (!registration?.pushManager) return null;
  return registration.pushManager.getSubscription();
};

const subscriptionToken = (subscription) => (
  subscription ? `webpush:${JSON.stringify(subscription.toJSON())}` : null
);

const urlBase64ToUint8Array = (base64String) => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(character => character.charCodeAt(0)));
};

/** Register the native Apple Web Push subscription used by Safari/iOS PWAs. */
export const subscribeIosPush = async (userId) => {
  if (!userId || !usesAppleWebPush() || !isAppleWebPushSupported()) return null;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return null;

  try {
    const registration = await getIosServiceWorkerRegistration();
    if (!registration?.pushManager) return null;

    const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY
      || import.meta.env.VITE_FIREBASE_VAPID_KEY;
    if (!vapidKey) return null;

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    }
    if (!subscription) return null;

    const token = subscriptionToken(subscription);
    const registered = await registerPushDevice(userId, token);
    if (!registered) return null;

    clearLegacyPushState();
    return token;
  } catch {
    return null;
  }
};

/** Remove the current iOS subscription and only this user's device row. */
export const unsubscribeIosPush = async (userId) => {
  if (!userId) return false;

  let subscription = null;
  try {
    subscription = await getIosSubscription();
  } catch {
    // Continue with the device-ID database cleanup even if the browser API is
    // unavailable or the service worker is being replaced.
  }

  const token = subscriptionToken(subscription);
  const removedFromDatabase = await removePushDeviceRegistration(userId, token);
  if (!removedFromDatabase) return false;

  if (subscription) {
    try {
      const unsubscribed = await subscription.unsubscribe();
      if (unsubscribed === false) return false;
    } catch {
      return false;
    }
  }

  clearLegacyPushState();
  return true;
};

/**
 * Read the real status shown by Profile and About/Version.
 * `Notification.permission` is included as context, but never treated as an
 * active subscription by itself.
 */
export const getCurrentPushStatus = async (userId) => {
  const notificationSupported = typeof window !== 'undefined' && 'Notification' in window;
  const permission = notificationSupported ? Notification.permission : 'unsupported';
  const ios = isIosDevice();

  if (ios || isSafariBrowser()) {
    const installed = isIosPwa();
    const supported = notificationSupported && isAppleWebPushSupported();
    let subscription = null;
    if (supported) {
      try {
        subscription = await getIosSubscription();
      } catch {
        subscription = null;
      }
    }

    const token = subscriptionToken(subscription);
    const registered = supported && permission === 'granted'
      ? await hasPushDeviceRegistration(userId, token)
      : false;

    return {
      platform: 'apple-webpush',
      supported,
      notificationSupported,
      permission,
      // Report the real device, not the branch that was taken. Safari on a Mac
      // reaches this path too, and callers use these two flags to decide
      // whether to tell someone to Add to Home Screen — advice that is both
      // impossible and unnecessary on a desktop, where push already works.
      isIosDevice: ios,
      isIosInstalled: installed,
      iosPushSupported: isIosPushSupported(),
      registered,
      subscribed: Boolean(subscription && registered),
    };
  }

  const fcmStatus = await getFcmPushStatus(userId);
  return {
    ...fcmStatus,
    notificationSupported,
    isIosDevice: false,
    isIosInstalled: false,
    iosPushSupported: false,
  };
};

/** Remove the current platform's registration during logout. */
export const disablePushForCurrentDevice = async (userId) => {
  if (usesAppleWebPush()) return unsubscribeIosPush(userId);
  return disableNotificationsForDevice(userId);
};

// Keep these imports available to callers that already use this module for the
// shared push lifecycle. They are intentionally not used for status truth.
export { refreshFCMTokenIfNeeded, requestNotificationPermission };
