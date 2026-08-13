importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  // Keep the project's real Firebase configuration.
  apiKey: 'AIzaSyA6lpUuP_8KHWzzP89ZIpmVts7ABuogGVw',
  authDomain: 'pet-spot-clinic.firebaseapp.com',
  projectId: 'pet-spot-clinic',
  storageBucket: 'pet-spot-clinic.firebasestorage.app',
  messagingSenderId: '98732499537',
  appId: '1:98732499537:web:878f3820f40a03151a8e70',
  measurementId: 'G-TY6N10TK80'
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  // The backend sends data-only FCM messages so this handler owns the
  // notification display and avoids duplicate browser notifications.
  const notification = payload.notification || {};
  const data = payload.data || {};
  const title = notification.title || data.title || 'Pet Spot Clinic';
  const body = notification.body || data.body || 'You have a new update.';

  return self.registration.showNotification(title, {
    body,
    icon: '/pet-spot-clinic/icon-192.png',
    badge: '/pet-spot-clinic/icon-192.png',
    data
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const target = '/pet-spot-clinic/';
      const existing = clientList.find((client) => {
        try {
          return new URL(client.url).pathname.startsWith(target);
        } catch (_) {
          return false;
        }
      });

      if (existing && 'focus' in existing) return existing.focus();
      if (clients.openWindow) return clients.openWindow(target);
      return undefined;
    })
  );
});
