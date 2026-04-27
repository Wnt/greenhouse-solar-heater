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
  let data = {};
  if (event.data) {
    try { data = event.data.json(); } catch (e) {
      data = { title: 'Helios Canopy', body: event.data.text() };
    }
  }

  const title = data.title || 'Helios Canopy';
  // `icon` is the large image shown in the notification tray. The server
  // picks a category-specific glyph (wb_sunny / bedtime / local_fire /
  // ac_unit / cloud_off) and passes the path in `data.icon`; fall back
  // to the app icon if absent.
  // `badge` is the monochrome silhouette shown in the Android status bar
  // next to the clock — Android masks it to white, so it MUST be a
  // transparent PNG (otherwise the whole rectangle renders white).
  const options = {
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
  const data = event.notification.data || {};
  event.notification.close();

  // Script-crash notifications carry one inline action: "restart"
  // (button) → POST /api/script/restart. Same credentials:include
  // pattern as watchdog so the session cookie rides along.
  if (data.kind === 'script_crash') {
    if (data.test) {
      // Test notifications must NOT actually restart the live script.
      // Mirror the real flow client-side with a confirmation toast.
      if (event.action === 'restart') {
        event.waitUntil(self.registration.showNotification(
          '[Test] Restart requested',
          {
            body: 'Would call /api/script/restart on the live server.',
            icon: 'assets/notif-script-crash.png',
            badge: 'assets/badge-72.png',
            tag: 'test-script-crash',
            data: { kind: 'script_crash_ack_test', test: true, url: '/#status' },
          }
        ));
      }
      return;
    }
    if (event.action === 'restart') {
      event.waitUntil(fetch('/api/script/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      }).catch(function () { /* swallow — banner will reconcile */ }));
      return;
    }
    // Main click (no action) falls through to the open-window logic.
  }

  // Watchdog fired notifications have two inline actions beyond the
  // main click: "shutdownnow" (button) and "snooze" (text input).
  // Both POST to the watchdog HTTP endpoints; credentials:include so
  // the session cookie rides along.
  if (data.kind === 'watchdog_fired') {
    // Test notifications (sent from Settings → "send test") use the
    // same shape as a real fire so the user can preview the inline
    // reply input and the Shutdown now button on their actual device.
    // But the server has no pending fire, so we must NOT POST to the
    // real endpoints — that would 409. Instead, mirror the real flow
    // entirely client-side by showing a local acknowledgement
    // notification with the user's reply text. This lets the user
    // verify the full UX (fire → snooze with reason → ack confirmation)
    // without involving the device.
    if (data.test) {
      const testTitle = data.testLabel || 'Greenhouse not warming';
      if (event.action === 'snooze') {
        const testReply = (event.reply && event.reply.trim()) || '(no reason provided)';
        const ttlSec = data.snoozeTtlSeconds || 43200;
        const until = new Date(Date.now() + ttlSec * 1000);
        const untilStr = new Intl.DateTimeFormat('en-GB', {
          hour: '2-digit', minute: '2-digit', hour12: false,
          timeZone: 'Europe/Helsinki',
        }).format(until);
        event.waitUntil(self.registration.showNotification(
          '[Test] Snooze applied \u2014 ' + testTitle,
          {
            body: '"' + testReply + '" \u2014 would run until ' + untilStr,
            icon: 'assets/notif-watchdog.png',
            badge: 'assets/badge-72.png',
            // Same tag as the test fire notification so this REPLACES
            // it on the device, mirroring the real-flow behaviour
            // where the ack push reuses the watchdog-<id> tag.
            tag: 'test-watchdog-fired',
            data: { kind: 'watchdog_ack_test', test: true, url: '/#status' },
          }
        ));
      } else if (event.action === 'shutdownnow') {
        event.waitUntil(self.registration.showNotification(
          '[Test] Shutdown applied \u2014 ' + testTitle,
          {
            body: 'Cool-off would be active for the next 4 h.',
            icon: 'assets/notif-watchdog.png',
            badge: 'assets/badge-72.png',
            tag: 'test-watchdog-fired',
            data: { kind: 'watchdog_ack_test', test: true, url: '/#status' },
          }
        ));
      }
      return;
    }

    const action = event.action;
    const reply  = event.reply;

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

  const url = data.url ? data.url : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (clientList) {
        // Focus existing window if one is open
        for (let i = 0; i < clientList.length; i++) {
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
