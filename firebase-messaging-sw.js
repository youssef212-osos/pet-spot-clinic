importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
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
  const n = payload.notification || {};
  const title = n.title || 'Pet Spot Clinic';
  const options = {
    body: n.body || 'You have a new update.',
    icon: '/pet-spot-clinic/icon-192.png',
    badge: '/pet-spot-clinic/icon-192.png',
    data: payload.data || {}
  };
  self.registration.showNotification(title, options);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.matchAll({type: 'window', includeUncontrolled: true}).then((clientList) => {
    for (const client of clientList) {
      if ('focus' in client) return client.focus();
    }
    if (clients.openWindow) return clients.openWindow('/pet-spot-clinic/');
  }));
});
