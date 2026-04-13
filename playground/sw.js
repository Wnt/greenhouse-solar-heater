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
  // `icon` is the large image shown in the notification tray. The server
  // picks a category-specific glyph (wb_sunny / bedtime / local_fire /
  // ac_unit / cloud_off) and passes the path in `data.icon`; fall back
  // to the app icon if absent.
  // `badge` is the monochrome silhouette shown in the Android status bar
  // next to the clock — Android masks it to white, so it MUST be a
  // transparent PNG (otherwise the whole rectangle renders white).
  var options = {
    body: data.body || '',
    icon: data.icon || 'assets/icon-192.png',
    badge: 'assets/badge-72.png',
    tag: data.tag || 'default',
    data: data.data || { url: data.url || '/' },
  };
  // Forward optional fields the server may include (watchdog notifications)
  if (data.requireInteraction) options.requireInteraction = true;
  if (data.renotify) options.renotify = true;
  if (data.actions) options.actions = data.actions;

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  var data = event.notification.data || {};
  event.notification.close();

  // Watchdog fired notifications have two inline actions beyond the
  // main click: "shutdownnow" (button) and "snooze" (text input).
  // Both POST to the watchdog HTTP endpoints; credentials:include so
  // the session cookie rides along.
  if (data.kind === 'watchdog_fired') {
    var action = event.action;
    var reply  = event.reply;

    if (action === 'shutdownnow') {
      event.waitUntil(fetch('/api/watchdog/shutdownnow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: data.watchdogId, eventId: data.eventId }),
        credentials: 'include'
      }).catch(function () { /* swallow — UI will reconcile */ }));
      return;
    }
    if (action === 'snooze') {
      event.waitUntil(fetch('/api/watchdog/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id:      data.watchdogId,
          eventId: data.eventId,
          reason:  (reply && reply.trim()) || '(no reason provided)'
        }),
        credentials: 'include'
      }).catch(function () { /* swallow */ }));
      return;
    }
    // Main click (no action) falls through to the open-window logic.
  }

  var url = data.url ? data.url : '/';

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
