/**
 * Script-monitor UI glue.
 *
 * Listens for `script-status` messages from the LiveSource WebSocket,
 * keeps the top-of-page crash banner in sync, and wires the restart
 * button to POST /api/script/restart.
 *
 * The crashes list view is rendered separately in main.js from
 * GET /api/script/crashes — this module only owns the banner + restart.
 */

import { store } from '../app-state.js';

function wireRestartButton() {
  const btn = document.getElementById('script-crash-banner-restart');
  if (!btn || btn._wired) return;
  btn._wired = true;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = 'Restarting…';
    fetch('/api/script/restart', {
      method: 'POST',
      credentials: 'include',
    }).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(() => {
      // Leave the button disabled briefly — a status-change broadcast
      // will arrive within ~500 ms (the monitor kicks a re-poll after
      // the Start RPC returns) and render() resets button state.
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = 'Restart script';
      }, 3000);
    }).catch(err => {
      btn.disabled = false;
      btn.textContent = 'Restart script';
      window.alert('Restart failed: ' + (err && err.message || err));
    });
  });
}

function renderScriptCrashBanner() {
  const banner = document.getElementById('script-crash-banner');
  if (!banner) return;
  const status = store.get('scriptStatus');
  const phase = store.get('phase');
  // Only meaningful in live mode. In sim mode the script is irrelevant.
  if (phase !== 'live' || !status || status.running !== false) {
    banner.style.display = 'none';
    return;
  }
  banner.style.display = 'block';
  const msgEl = document.getElementById('script-crash-banner-msg');
  if (msgEl) {
    msgEl.textContent = status.error_msg
      ? status.error_msg
      : 'Script is not running (no error message was reported).';
  }
  const restartBtn = document.getElementById('script-crash-banner-restart');
  if (restartBtn) {
    // `data-admin-only` is globally hidden for readonly users by auth.js;
    // here we just ensure the default enabled state.
    if (!restartBtn._wired) wireRestartButton();
  }
}

/**
 * Hook into the live data source so every script-status broadcast
 * updates the store. Also re-renders the banner on subscription so a
 * late-attached listener pulls in the last-seen state immediately.
 */
export function attachScriptStatusWebSocket(liveSource) {
  if (!liveSource || typeof liveSource.onScriptStatus !== 'function') return;
  liveSource.onScriptStatus((data) => {
    store.set('scriptStatus', data);
    renderScriptCrashBanner();
  });
}

// Re-render whenever anything in the store changes the banner's
// visibility predicates (phase flips or scriptStatus set).
store.subscribe('phase', () => renderScriptCrashBanner());
store.subscribe('scriptStatus', () => renderScriptCrashBanner());
