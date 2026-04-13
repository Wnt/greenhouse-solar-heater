/**
 * Global store → DOM subscriptions.
 * Wires store state changes to navigation, overlays, indicators, and view lifecycle.
 */

import { derived } from './app-state.js';
import { navigateTo } from './actions/navigation.js';

const OVERLAY_MESSAGES = {
  connecting: {
    title: 'Reaching out to your sanctuary.',
    subtitle: 'Connecting to the server...'
  },
  never_connected: {
    title: 'Your sanctuary is sleeping.',
    subtitle: 'Cannot reach the server.'
  },
  device_offline: {
    title: 'Your sanctuary is sleeping.',
    subtitle: 'The server is running, but the controller is unreachable.'
  },
  disconnected: {
    title: 'Lost touch with your sanctuary.',
    subtitle: 'Connection to the server was lost.'
  },
  stale: {
    title: 'Your sanctuary has gone quiet.',
    subtitle: 'No data received for over 60 seconds.'
  }
};

// View lifecycle callbacks — set by the app via setViewLifecycle
let viewCallbacks = {};

export function setViewLifecycle(callbacks) {
  viewCallbacks = callbacks;
}

/**
 * Wire all global store subscriptions. Call once during init.
 */
export function initSubscriptions(store) {
  // ── Navigation: show/hide nav links based on phase ──
  store.subscribe('phase', () => {
    const available = derived.availableViews;
    document.querySelectorAll('[data-view]').forEach(el => {
      const view = el.dataset.view;
      el.style.display = available.includes(view) ? '' : 'none';
    });
    // Controls view visibility
    document.querySelectorAll('[data-view="controls"]').forEach(el => {
      el.style.display = available.includes('controls') ? '' : 'none';
    });
    // Live-only time range pills
    const isLive = store.get('phase') === 'live';
    document.querySelectorAll('.live-only').forEach(el => {
      el.style.display = isLive ? '' : 'none';
    });
    // FAB is hidden in live mode
    const fab = document.getElementById('fab-play');
    if (fab) fab.style.display = isLive ? 'none' : '';
    // If current view is no longer available, redirect
    const current = store.get('currentView');
    if (!available.includes(current)) {
      navigateTo(store, 'status');
    }
  });

  // ── View switching: toggle active class, lifecycle ──
  let currentMountedView = null;
  let currentUnmount = null;

  store.subscribe('currentView', (viewId) => {
    // Unmount previous view
    if (currentMountedView && currentMountedView !== viewId) {
      if (currentUnmount) {
        currentUnmount();
        currentUnmount = null;
      }
    }

    // Toggle view containers
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const viewEl = document.getElementById('view-' + viewId);
    if (viewEl) viewEl.classList.add('active');

    // Toggle nav link active state
    document.querySelectorAll('[data-view]').forEach(l => l.classList.remove('active'));
    document.querySelectorAll('[data-view="' + viewId + '"]').forEach(l => l.classList.add('active'));

    // Mount new view
    currentMountedView = viewId;
    if (viewCallbacks[viewId] && viewCallbacks[viewId].mount) {
      const container = viewEl ? viewEl.querySelector('[id$="-content"]') || viewEl : null;
      currentUnmount = viewCallbacks[viewId].mount(container, store) || null;
    }
  });

  // ── Connection indicator ──
  function updateConnectionIndicator() {
    const dot = document.getElementById('connection-dot');
    const label = document.getElementById('connection-label');
    if (!dot || !label) return;

    const displayState = derived.connectionDisplay;
    switch (displayState) {
      case 'active':
        dot.className = 'connection-dot connected';
        label.textContent = 'Live';
        break;
      case 'connecting':
        dot.className = 'connection-dot reconnecting';
        label.textContent = 'Connecting\u2026';
        break;
      case 'reconnecting':
        dot.className = 'connection-dot reconnecting';
        label.textContent = 'Reconnecting\u2026';
        break;
      case 'device_offline':
        dot.className = 'connection-dot device-offline';
        label.textContent = 'Controller offline';
        break;
      case 'stale':
        dot.className = 'connection-dot reconnecting';
        label.textContent = 'Stale';
        break;
      default:
        dot.className = 'connection-dot disconnected';
        label.textContent = 'Offline';
    }
  }

  // ── Connection overlays ──
  function updateOverlays() {
    var displayState = derived.connectionDisplay;
    var overlayIds = ['overlay-modes', 'overlay-gauge', 'overlay-components'];
    var msg = OVERLAY_MESSAGES[displayState];
    for (var i = 0; i < overlayIds.length; i++) {
      var overlay = document.getElementById(overlayIds[i]);
      if (!overlay) continue;
      if (msg) {
        overlay.classList.add('visible');
        var titleEl = document.getElementById(overlayIds[i] + '-title');
        var subtitleEl = document.getElementById(overlayIds[i] + '-subtitle');
        if (titleEl) titleEl.textContent = msg.title;
        if (subtitleEl) subtitleEl.textContent = msg.subtitle;
      } else {
        overlay.classList.remove('visible');
      }
    }
  }

  // ── Device push state ──
  function updateDevicePush() {
    var btn = document.getElementById('dc-save');
    var warning = document.getElementById('dc-connection-warning');
    if (!btn || !warning) return;
    var displayState = derived.connectionDisplay;
    var canPush = store.get('phase') !== 'live' || displayState === 'active' || displayState === 'stale';
    if (canPush) {
      btn.classList.remove('disabled');
      btn.disabled = false;
      warning.style.display = 'none';
    } else {
      btn.classList.add('disabled');
      btn.disabled = true;
      warning.style.display = '';
    }
  }

  // ── Staleness banner ──
  function updateStalenessBanner() {
    const banner = document.getElementById('staleness-banner');
    if (!banner) return;
    const displayState = derived.connectionDisplay;
    banner.classList.toggle('visible', displayState === 'stale');
  }

  // ── Initial render: trigger subscriptions with current state ──
  // Subscriptions only fire on changes, so we need to force an initial render
  // by calling the phase and currentView handlers directly
  {
    const phase = store.get('phase');
    const available = derived.availableViews;
    document.querySelectorAll('[data-view]').forEach(el => {
      el.style.display = available.includes(el.dataset.view) ? '' : 'none';
    });
    const isLive = phase === 'live';
    document.querySelectorAll('.live-only').forEach(el => {
      el.style.display = isLive ? '' : 'none';
    });
    const fab = document.getElementById('fab-play');
    if (fab) fab.style.display = isLive ? 'none' : '';
  }

  // Subscribe connection-related keys to update indicators
  const connKeys = ['wsStatus', 'mqttStatus', 'hasReceivedData', 'lastDataTime', 'wsConnectedAt', '_staleTick'];
  for (const key of connKeys) {
    store.subscribe(key, () => {
      updateConnectionIndicator();
      updateOverlays();
      updateDevicePush();
      updateStalenessBanner();
    });
  }

  // Also update on phase change (sim vs live affects display)
  store.subscribe('phase', () => {
    updateConnectionIndicator();
    updateOverlays();
    updateDevicePush();
    updateStalenessBanner();
  });

  // ── Role change: re-evaluate available views and reroute if needed ──
  store.subscribe('userRole', () => {
    const available = derived.availableViews;
    document.querySelectorAll('[data-view]').forEach(el => {
      const view = el.dataset.view;
      if (!available.includes(view)) {
        el.style.display = 'none';
      } else {
        // Defer to phase logic to decide whether live-only items should show.
        el.style.display = '';
      }
    });
    const current = store.get('currentView');
    if (!available.includes(current)) {
      navigateTo(store, 'status');
    }
  });
}
