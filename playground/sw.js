/**
 * Service worker for Helios Canopy PWA.
 * Handles push notifications — no offline caching (the app requires
 * a live server connection to be useful).
 */

/* eslint-env serviceworker */

self.addEventListener('install', function () {
  // Activate immediately — no caching to wait for
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

// ── Push notifications ──

self.addEventListener('push', function (event) {
  var data = {};
  if (event.data) {
    try { data = event.data.json(); } catch (e) {
      data = { title: 'Helios Canopy', body: event.data.text() };
    }
  }

  var title = data.title || 'Helios Canopy';
  var options = {
    body: data.body || '',
    icon: 'assets/icon-192.svg',
    badge: 'assets/icon-192.svg',
    tag: data.tag || 'default',
    data: { url: data.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  var url = event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (clientList) {
        // Focus existing window if one is open
        for (var i = 0; i < clientList.length; i++) {
          if (clientList[i].url.indexOf(url) !== -1 && 'focus' in clientList[i]) {
            return clientList[i].focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(url);
        }
      })
  );
});
