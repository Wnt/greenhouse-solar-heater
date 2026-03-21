/**
 * Service Worker for Greenhouse Monitor PWA.
 * Handles push notifications and notification clicks.
 * No fetch interception or offline caching.
 */

self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  if (!event.data) return;

  var payload;
  try {
    payload = event.data.json();
  } catch (e) {
    payload = { title: 'Greenhouse Monitor', body: event.data.text() };
  }

  var title = payload.title || 'Valve Change';
  var options = {
    body: payload.body || '',
    tag: payload.tag || 'valve-change',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: payload.data || {},
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      // Focus existing window if open
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.indexOf('/') !== -1 && 'focus' in client) {
          return client.focus();
        }
      }
      // Open new window
      return self.clients.openWindow('/');
    })
  );
});
