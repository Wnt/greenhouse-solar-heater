/**
 * Service worker for Helios Canopy PWA.
 *
 * This SW has two jobs:
 *  1. Receive and display web-push notifications
 *  2. Satisfy Chrome's PWA installability criteria (which require a
 *     `fetch` event handler to be registered — even a pass-through is
 *     enough)
 *
 * The app requires a live server connection to be useful, so there's
 * no offline caching. The fetch handler simply falls through to the
 * network.
 */

/* eslint-env serviceworker */

self.addEventListener('install', function () {
  // Activate immediately — no caching to wait for
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

// Minimal fetch handler — required by Chrome's PWA installability
// criteria (https://web.dev/install-criteria/). Not used for caching;
// we just pass through to the network so online behavior is unchanged.
self.addEventListener('fetch', function (event) {
  // Respond only to same-origin GETs to avoid interfering with cross-
  // origin requests or non-idempotent methods we don't care about.
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request));
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
    icon: 'assets/icon-192.png',
    badge: 'assets/icon-192.png',
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
