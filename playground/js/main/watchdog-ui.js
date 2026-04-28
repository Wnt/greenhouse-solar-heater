// Watchdog UI extracted from main.js.
//
// Renders four distinct pieces:
//   1. Pending banner on #status (with live countdown + ack/shutdown)
//   2. Cool-off inline indicator on #status
//   3. Mode enablement card in #device (replaces old allowed-modes)
//   4. Anomaly watchdogs card in #settings (enable/disable + snooze)
// Live state arrives via WebSocket 'watchdog-state' messages; initial
// state is fetched from GET /api/watchdog/state on load.

import { store } from '../app-state.js';
import { postJson, putJson } from './fetch-helpers.js';

const WATCHDOG_PERMANENT_SENTINEL = 9999999999;
const WATCHDOG_ALL_MODES = [
  { code: 'I',  label: 'IDLE' },
  { code: 'SC', label: 'SOLAR_CHARGING' },
  { code: 'GH', label: 'GREENHOUSE_HEATING' },
  { code: 'AD', label: 'ACTIVE_DRAIN' },
  { code: 'EH', label: 'EMERGENCY_HEATING' },
];

let _watchdogCountdownTimer = null;
let _watchdogPending = null;
let _watchdogMeta = [];
let _watchdogSnapshot = { we: {}, wz: {}, wb: {} };
// Tracks whether the watchdog state has been seeded by either the
// initial GET or a WebSocket broadcast. The WS handler always wins —
// it represents the server's most recent push — so once any state has
// been applied, the (possibly in-flight) GET response is discarded
// rather than allowed to clobber a fresher WS update.
let _watchdogStateSeeded = false;

// Callback supplied by main.js that returns the current LiveSource
// instance, so reattachment after live-mode activation works without
// this module owning the instance.
let _getLiveSource = () => null;

export function getWatchdogSnapshot() {
  return _watchdogSnapshot;
}

function _watchdogCurrentUserRole() {
  return store.get('userRole') || 'admin';
}

export function initWatchdogUI({ getLiveSource } = {}) {
  if (typeof getLiveSource === 'function') _getLiveSource = getLiveSource;

  // Wire banner buttons
  const snoozeBtn = document.getElementById('watchdog-banner-snooze');
  const shutdownBtn = document.getElementById('watchdog-banner-shutdown');
  const replyInput = document.getElementById('watchdog-banner-reply');

  if (snoozeBtn) {
    snoozeBtn.addEventListener('click', () => {
      if (!_watchdogPending) return;
      const reason = (replyInput && replyInput.value.trim()) || '(no reason provided)';
      postJson('/api/watchdog/ack', {
        id: _watchdogPending.id,
        eventId: _watchdogPending.dbEventId,
        reason
      }).catch(err => console.error('watchdog ack failed', err));
    });
  }

  if (shutdownBtn) {
    shutdownBtn.addEventListener('click', () => {
      if (!_watchdogPending) return;
      postJson('/api/watchdog/shutdownnow', {
        id: _watchdogPending.id,
        eventId: _watchdogPending.dbEventId
      }).catch(err => console.error('watchdog shutdownnow failed', err));
    });
  }

  // Subscribe to live broadcasts via the LiveSource (if present).
  // The liveSource is created lazily in initModeToggle; wire here, and
  // also on every recreate via attachWatchdogWebSocket.
  attachWatchdogWebSocket();

  // Initial state load
  refreshWatchdogStateFromServer();
}

export function attachWatchdogWebSocket() {
  const liveSource = _getLiveSource();
  if (liveSource && typeof liveSource.onWatchdogState === 'function') {
    liveSource.onWatchdogState((msg) => {
      // Mark seeded so any still-in-flight GET /api/watchdog/state
      // response is discarded rather than clobbering this fresher
      // WS state.
      _watchdogStateSeeded = true;
      _watchdogPending = msg.pending || null;
      if (msg.snapshot) _watchdogSnapshot = msg.snapshot;
      if (msg.watchdogs) _watchdogMeta = msg.watchdogs;
      renderWatchdogBanner(_watchdogPending);
      renderModeEnablement(_watchdogSnapshot.wb || {}, _watchdogCurrentUserRole());
      renderWatchdogsCard(_watchdogSnapshot, _watchdogMeta, _watchdogCurrentUserRole());
      if (msg.recent) renderWatchdogHistory(msg.recent);
      renderCooloffIndicator(_watchdogSnapshot.wb || {});
    });
  }
}

function refreshWatchdogStateFromServer() {
  fetch('/api/watchdog/state', { credentials: 'include' })
    .then(r => r.ok ? r.json() : null)
    .then(state => {
      if (!state) return;
      // If a WebSocket broadcast arrived between issuing this GET and
      // it resolving, the WS state is fresher and we must NOT clobber
      // it with the now-stale GET response. The watchdog-flow e2e
      // test "shutdown now button POSTs..." was flaky on CI under
      // load specifically because of this race: it injected a WS
      // broadcast immediately after page load, but the GET resolved
      // shortly after with `pending: null` and reset the banner.
      if (_watchdogStateSeeded) return;
      _watchdogStateSeeded = true;
      _watchdogPending = state.pending || null;
      _watchdogSnapshot = state.snapshot || { we: {}, wz: {}, wb: {} };
      _watchdogMeta = state.watchdogs || [];
      renderWatchdogBanner(_watchdogPending);
      renderModeEnablement(_watchdogSnapshot.wb || {}, _watchdogCurrentUserRole());
      renderWatchdogsCard(_watchdogSnapshot, _watchdogMeta, _watchdogCurrentUserRole());
      renderWatchdogHistory(state.recent || []);
      renderCooloffIndicator(_watchdogSnapshot.wb || {});
    })
    .catch(() => { /* unauth (public browse) or offline — swallow */ });
}

function renderWatchdogBanner(pending) {
  _watchdogPending = pending;
  const banner = document.getElementById('watchdog-banner');
  if (!banner) return;

  if (!pending) {
    banner.style.display = 'none';
    if (_watchdogCountdownTimer) {
      clearInterval(_watchdogCountdownTimer);
      _watchdogCountdownTimer = null;
    }
    return;
  }

  banner.style.display = 'block';
  const title = document.getElementById('watchdog-banner-title');
  const reason = document.getElementById('watchdog-banner-reason');
  const replyInput = document.getElementById('watchdog-banner-reply');
  const meta = _watchdogMeta.find(w => w.id === pending.id);
  const label = meta ? meta.shortLabel : pending.id;
  if (title) title.textContent = 'Watchdog fired: ' + label;
  if (reason) reason.textContent = pending.triggerReason || '';
  if (replyInput) replyInput.value = '';

  // Disable buttons for readonly users
  const role = _watchdogCurrentUserRole();
  const isAdmin = role === 'admin';
  const snoozeBtn = document.getElementById('watchdog-banner-snooze');
  const shutdownBtn = document.getElementById('watchdog-banner-shutdown');
  if (snoozeBtn) snoozeBtn.disabled = !isAdmin;
  if (shutdownBtn) shutdownBtn.disabled = !isAdmin;

  // Local countdown ticking every second (5 min = 300s from firedAt)
  if (_watchdogCountdownTimer) clearInterval(_watchdogCountdownTimer);
  function updateCountdown() {
    const now = Math.floor(Date.now() / 1000);
    const remaining = Math.max(0, 300 - (now - pending.firedAt));
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    const el = document.getElementById('watchdog-banner-countdown-text');
    if (el) el.textContent = m + ' min ' + (s < 10 ? '0' : '') + s + ' s';
  }
  updateCountdown();
  _watchdogCountdownTimer = setInterval(updateCountdown, 1000);
}

function renderCooloffIndicator(wb) {
  const el = document.getElementById('watchdog-cooloff-indicator');
  if (!el) return;
  const now = Math.floor(Date.now() / 1000);
  const cooloffs = [];
  WATCHDOG_ALL_MODES.forEach(m => {
    const entry = wb && wb[m.code];
    if (entry && entry > now && entry !== WATCHDOG_PERMANENT_SENTINEL) {
      const remaining = entry - now;
      const h = Math.floor(remaining / 3600);
      const mn = Math.floor((remaining % 3600) / 60);
      cooloffs.push('⏸ ' + m.label + ' cooling off — ' + h + 'h ' + mn + 'm remaining');
    }
  });
  if (cooloffs.length === 0) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  el.style.display = 'block';
  el.textContent = cooloffs.join(' · ');
}

export function renderModeEnablement(wb, userRole) {
  const list = document.getElementById('mode-enablement-list');
  if (!list) return;
  const now = Math.floor(Date.now() / 1000);
  const isAdmin = userRole === 'admin';

  list.innerHTML = '';
  WATCHDOG_ALL_MODES.forEach(mode => {
    const row = document.createElement('div');
    row.className = 'mode-enablement-row';
    const entry = wb && wb[mode.code];

    let statusLabel;
    let actionLabel;
    let actionHandler;

    if (!entry || entry <= now) {
      statusLabel = '<span class="mode-allowed">• allowed</span>';
      actionLabel = 'Disable';
      actionHandler = () => _watchdogDisableMode(mode.code);
    } else if (entry === WATCHDOG_PERMANENT_SENTINEL) {
      statusLabel = '<span class="mode-disabled">✕ disabled by user</span>';
      actionLabel = 'Re-enable';
      actionHandler = () => _watchdogClearBan(mode.code);
    } else {
      const remaining = entry - now;
      const h = Math.floor(remaining / 3600);
      const mn = Math.floor((remaining % 3600) / 60);
      statusLabel = '<span class="mode-cooloff">⏸ cool-off — ' + h + 'h ' + mn + 'm</span>';
      actionLabel = 'Clear cool-off';
      actionHandler = () => _watchdogClearBan(mode.code);
    }

    row.innerHTML =
      '<div class="mode-enablement-label">' + mode.label + '</div>' +
      '<div class="mode-enablement-status">' + statusLabel + '</div>' +
      (isAdmin ? '<button class="mode-enablement-action" type="button">' + actionLabel + '</button>' : '');

    if (isAdmin) {
      const btn = row.querySelector('.mode-enablement-action');
      if (btn) btn.addEventListener('click', actionHandler);
    }
    list.appendChild(row);
  });
}

function _watchdogDisableMode(modeCode) {
  putJson('/api/device-config', { wb: { [modeCode]: WATCHDOG_PERMANENT_SENTINEL } })
    .catch(err => console.error('disable mode failed', err));
}

function _watchdogClearBan(modeCode) {
  putJson('/api/device-config', { wb: { [modeCode]: 0 } })
    .catch(err => console.error('clear ban failed', err));
}

function renderWatchdogsCard(snapshot, watchdogs, userRole) {
  const list = document.getElementById('watchdogs-list');
  if (!list) return;
  const isAdmin = userRole === 'admin';
  const now = Math.floor(Date.now() / 1000);

  list.innerHTML = '';
  if (!watchdogs || watchdogs.length === 0) {
    list.innerHTML = '<p class="empty-state">No watchdogs configured.</p>';
    return;
  }
  watchdogs.forEach(w => {
    const row = document.createElement('div');
    row.className = 'watchdog-row';

    const enabled = snapshot && snapshot.we && snapshot.we[w.id];
    const snoozeUntil = snapshot && snapshot.wz && snapshot.wz[w.id];
    const isSnoozed = snoozeUntil && snoozeUntil > now;

    const label = document.createElement('label');
    label.className = 'watchdog-row-label';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !!enabled;
    checkbox.disabled = !isAdmin;
    checkbox.addEventListener('change', () => {
      putJson('/api/watchdog/enabled', { id: w.id, enabled: checkbox.checked })
        .catch(err => console.error('toggle watchdog failed', err));
    });
    label.appendChild(checkbox);

    const text = document.createElement('span');
    text.innerHTML = '<strong>' + (w.label || w.id) + '</strong> &mdash; ' + (w.mode || '');
    label.appendChild(text);
    row.appendChild(label);

    if (isSnoozed) {
      const snoozeInfo = document.createElement('div');
      snoozeInfo.className = 'watchdog-snooze-info';
      const remaining = snoozeUntil - now;
      const h = Math.floor(remaining / 3600);
      const mn = Math.floor((remaining % 3600) / 60);
      snoozeInfo.textContent = '⏸ snoozed for ' + h + 'h ' + mn + 'm';
      row.appendChild(snoozeInfo);
      if (isAdmin) {
        const clearBtn = document.createElement('button');
        clearBtn.className = 'watchdog-clear-snooze';
        clearBtn.type = 'button';
        clearBtn.textContent = 'Clear snooze';
        clearBtn.addEventListener('click', () => {
          putJson('/api/device-config', { wz: { [w.id]: 0 } })
            .catch(err => console.error('clear snooze failed', err));
        });
        row.appendChild(clearBtn);
      }
    }
    list.appendChild(row);
  });
}

function renderWatchdogHistory(recent) {
  const list = document.getElementById('watchdogs-history-list');
  if (!list) return;
  list.innerHTML = '';
  if (!recent || recent.length === 0) {
    list.innerHTML = '<p class="empty-state">No events yet.</p>';
    return;
  }
  recent.forEach(ev => {
    const row = document.createElement('div');
    row.className = 'watchdog-history-row';
    const when = ev.fired_at
      ? new Date(ev.fired_at).toLocaleString([], { timeZone: 'Europe/Helsinki' })
      : '';
    const resolution = ev.resolution || 'pending';
    const safeReason = (ev.trigger_reason || '').replace(/</g, '&lt;');
    const safeSnooze = (ev.snooze_reason || '').replace(/</g, '&lt;');
    row.innerHTML =
      '<div class="history-row-top">' + when + ' &mdash; <code>' + ev.watchdog_id + '</code> &mdash; ' + resolution + '</div>' +
      '<div class="history-row-reason">' + safeReason + '</div>' +
      (ev.snooze_reason ? '<div class="history-row-snooze">Snoozed: "' + safeSnooze + '"</div>' : '');
    list.appendChild(row);
  });
}
