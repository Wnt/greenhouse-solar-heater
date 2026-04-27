// Sync coordinator.
//
// Owns the page-visibility / network-recovery seams the rest of the
// app relies on. When the user backgrounds the tab on Android (or
// loses network, or the browser pauses timers), the WebSocket may
// keep its socket but not deliver fresh data; on resume we need to
// re-fetch everything that has a registered data source so the cards,
// graph, and trend arrows reflect reality instead of pre-background
// values.
//
// Public API
//   initSyncCoordinator({ onResyncStart, onResyncComplete })
//     Wires the visibilitychange / pageshow / online listeners.
//     Callbacks fire around each resync (see triggerResync below).
//   triggerResync(reason)
//     Public entry point — also invoked by the listeners above.
//     Returns a Promise that resolves once every active source has
//     settled (or aborted by a newer resync).
//   _resetForTests()
//     Tears down listeners + aborts in-flight work. Test-only.
//
// Lifecycle of a single resync
//   1. If a resync is in flight, abort it (its sources see signal.aborted
//      and bail out). The caller's Promise resolves with `{ aborted: true }`.
//   2. Set store.syncing = true.
//   3. Call onResyncStart(reason). Use this to reset stale-frame flags
//      so the UI falls back to the synthesised "last history point"
//      rendering until fresh data lands.
//   4. Run every spec.isActive() source's spec.fetch(signal) in
//      parallel. Failures and aborts are swallowed — one source falling
//      over must not freeze the others.
//   5. For each source whose fetch resolved un-aborted, run
//      spec.applyToStore(data).
//   6. Set store.syncing = false.
//   7. Call onResyncComplete(reason).

import { _registeredSources } from './registry.js';
import { store } from '../app-state.js';

let currentController = null;
let _onResyncStart = function () {};
let _onResyncComplete = function () {};
let _listeners = null;

export function initSyncCoordinator(opts) {
  const { onResyncStart, onResyncComplete } = opts || {};
  if (typeof onResyncStart === 'function') _onResyncStart = onResyncStart;
  if (typeof onResyncComplete === 'function') _onResyncComplete = onResyncComplete;

  if (_listeners) return; // idempotent — main.js init can be re-entered in tests

  function onVisibility() {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      triggerResync('visibility');
    }
  }
  function onPageShow(e) {
    // Only re-fetch on bfcache restore. A non-persisted pageshow is
    // just the initial page load, which already kicks off its own
    // data fetches via the live-mode init path.
    if (e && e.persisted) triggerResync('pageshow');
  }
  function onOnline() { triggerResync('online'); }

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('online', onOnline);

  _listeners = { onVisibility, onPageShow, onOnline };
}

function triggerResync(reason) {
  if (currentController) currentController.abort();
  const controller = new AbortController();
  currentController = controller;

  const all = _registeredSources();
  const active = [];
  for (let i = 0; i < all.length; i++) {
    const src = all[i];
    let alive = false;
    try { alive = !!src.isActive(); }
    catch (e) { console.error('[sync] isActive threw for', src.id, e); }
    if (alive) active.push(src);
  }

  store.set('syncing', true);
  store.set('syncReason', reason || null);
  try { _onResyncStart(reason); }
  catch (e) { console.error('[sync] onResyncStart threw:', e); }

  if (active.length === 0) {
    finishResync(controller);
    return Promise.resolve({ aborted: false, ran: 0 });
  }

  const settles = active.map(function (src) {
    return Promise.resolve()
      .then(function () { return src.fetch(controller.signal); })
      .then(function (data) {
        if (controller.signal.aborted) return;
        try { src.applyToStore(data); }
        catch (e) { console.error('[sync] applyToStore threw for', src.id, e); }
      })
      .catch(function (e) {
        if (controller.signal.aborted) return;
        // Don't propagate — one bad source must not break the others.
        console.warn('[sync] fetch failed for', src.id, e);
      });
  });

  return Promise.all(settles).then(function () {
    if (controller.signal.aborted) return { aborted: true, ran: active.length };
    finishResync(controller);
    return { aborted: false, ran: active.length };
  });
}

function finishResync(controller) {
  if (currentController === controller) {
    currentController = null;
    store.set('syncing', false);
  }
  try { _onResyncComplete(store.get('syncReason')); }
  catch (e) { console.error('[sync] onResyncComplete threw:', e); }
}

function _resetForTests() {
  if (currentController) currentController.abort();
  currentController = null;
  store.set('syncing', false);
  store.set('syncReason', null);
  if (_listeners) {
    document.removeEventListener('visibilitychange', _listeners.onVisibility);
    window.removeEventListener('pageshow', _listeners.onPageShow);
    window.removeEventListener('online', _listeners.onOnline);
    _listeners = null;
  }
  _onResyncStart = function () {};
  _onResyncComplete = function () {};
}

// Test bridge. The frontend Playwright suite drives the coordinator
// via window.__sync — see ./README.md. registry.js attaches its own
// pieces; we attach ours here. Production code never reads it.
if (typeof window !== 'undefined') {
  window.__sync = window.__sync || {};
  window.__sync.triggerResync = triggerResync;
  window.__sync._resetForTests = _resetForTests;
}
