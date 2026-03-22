/**
 * Service Worker for Greenhouse Monitor PWA.
 * Handles push notifications, notification clicks, and offline fallback.
 */

var OFFLINE_CACHE = 'greenhouse-offline-v1';
var OFFLINE_URL = '/offline.html';
var OFFLINE_ASSETS = ['/offline.html', '/icons/icon-192.png'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(OFFLINE_CACHE).then(function (cache) {
      return cache.addAll(OFFLINE_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  // Only handle navigation requests (HTML page loads)
  if (event.request.mode !== 'navigate') return;

  event.respondWith(
    fetch(event.request).catch(function () {
      return caches.match(OFFLINE_URL);
    })
  );
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
