// Minimal service worker: exists so notifications work on mobile browsers
// (Android Chrome requires ServiceWorkerRegistration.showNotification).
// No caching/offline logic — the app is served straight from GitHub Pages.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const client = list.find((c) => 'focus' in c);
      return client ? client.focus() : null;
    })
  );
});
