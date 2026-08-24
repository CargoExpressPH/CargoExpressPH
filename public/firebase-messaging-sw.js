// firebase-messaging-sw.js
// Required by Firebase Cloud Messaging SDK for background push on Android/Chrome.
// This file MUST be named exactly "firebase-messaging-sw.js" at the root scope.
// iOS Safari uses the native Web Push path instead — see usePushNotification.js

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// Firebase config — must match src/lib/firebase.js
// These are public client-side values (safe to expose).
firebase.initializeApp({
  apiKey:            'AIzaSyCyEkwwiJP6OBwwJOi1UIsVrRbC0rSYLLM',
  authDomain:        'ship2door-e8405.firebaseapp.com',
  projectId:         'ship2door-e8405',
  messagingSenderId: '284016614377',
  appId:             '1:284016614377:web:bcd29bbd8a4d2479bbc978',
});

const messaging = firebase.messaging();

// ── Background message handler ───────────────────────────────────────────────
// Fires when a push arrives and the app tab is in the background or closed.
// On Android/Chrome this shows a system notification automatically.
messaging.onBackgroundMessage((payload) => {
  const notif  = payload.notification || {};
  const data   = payload.data         || {};
  const title  = notif.title || 'CargoExpress PH';
  const body   = notif.body  || 'You have a new update';
  const url    = data.url    || notif.click_action || '/customer/notifications';

  self.registration.showNotification(title, {
    body,
    icon:     '/icons/icon-192.png',
    badge:    '/icons/icon-72.png',
    data:     { url },
    vibrate:  [200, 100, 200],
    tag:      'cargoexpress-fcm',
    renotify: true,
    actions: [
      { action: 'open',    title: 'Open App' },
      { action: 'dismiss', title: 'Dismiss'  },
    ],
  });
});

// ── Notification click handler ───────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || '/customer/notifications';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.navigate(targetUrl);
          return;
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
