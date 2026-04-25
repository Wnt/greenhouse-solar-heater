// Drainage control card — high-level wrapper around the existing
// override → AD (drain) and override → SC (refill) flows. Surfaces the
// persisted drainage status (KVS key "drained" on the controller,
// broadcast as flags.collectors_drained in every state frame) and
// auto-exits the override once the controller confirms completion so
// freeze-drain safety automation comes back online immediately.
//
// External API:
//   initDrainageControl({ getLiveSource })
//   updateDrainageControl(result)   — called from each live state frame
//
// State-machine notes:
//   pendingOp = 'drain'   set when this card sent override-enter fm=AD;
//                         cleared when state shows drained && idle (then
//                         we send override-exit so automation resumes).
//   pendingOp = 'refill'  set when this card sent override-enter fm=SC;
//                         cleared when state shows !drained && solar_charging
//                         (then we send override-exit; if conditions still
//                         warrant SC, automation re-enters it on its own).
//
// We deliberately do not auto-exit when the override was started from
// the manual-relay-testing card — `pendingOp` is only set by our own
// button handlers, so other override sources are left alone.

import { store } from '../app-state.js';

let _getLiveSource = () => null;
let pendingOp = null;        // null | 'drain' | 'refill'
let pendingStartedAt = 0;    // ms timestamp — for ack-timeout detection
let lastResult = null;       // most recent state frame (for button-disable logic)
let ackTimer = null;
let msgFadeTimer = null;

const DRAIN_TTL_S = 600;      // 10 min — drain takes ~5 min plus exit handling
const REFILL_TTL_S = 1800;    // 30 min — leave room for fill + a charging window
const ACK_TIMEOUT_MS = 5000;

export function initDrainageControl({ getLiveSource } = {}) {
  if (typeof getLiveSource === 'function') _getLiveSource = getLiveSource;

  document.getElementById('drainage-drain-btn').addEventListener('click', startDrain);
  document.getElementById('drainage-refill-btn').addEventListener('click', startRefill);
  document.getElementById('drainage-abort-btn').addEventListener('click', abortPending);

  const liveSource = _getLiveSource();
  if (liveSource) liveSource.onCommandResponse(handleCommandResponse);
}

function startDrain() {
  if (!confirmAction(
    'Drain the collector loop?\n\n' +
    'Active drain runs the pump for ~5 minutes to push collector water back to ' +
    'the tank, then closes valves. Automation is suspended for the duration; ' +
    'this card will hand control back to automation as soon as the controller ' +
    'reports drained = true.\n\nContinue?'
  )) return;
  sendOverrideEnter('drain', 'AD', DRAIN_TTL_S, 'Starting drain…');
}

function startRefill() {
  if (!confirmAction(
    'Refill the collector loop via solar charging?\n\n' +
    'This forces SOLAR_CHARGING mode to push water from the tank back into the ' +
    'collectors. Automation is suspended for the duration; this card will hand ' +
    'control back to automation as soon as the controller reports drained = false.\n\n' +
    'Note: nothing here checks weather — only refill when the collector is above ' +
    'freezing and you actually want water in the loop.\n\nContinue?'
  )) return;
  sendOverrideEnter('refill', 'SC', REFILL_TTL_S, 'Starting refill…');
}

function sendOverrideEnter(op, forcedMode, ttl, progressLabel) {
  const liveSource = _getLiveSource();
  if (!liveSource) {
    showMsg('WebSocket not connected.', 'var(--error)');
    return;
  }
  // Reject if another override is already active (could be ours mid-flight,
  // or the manual-relay-testing card's). The user should abort/exit that
  // first — we never silently take over a session we didn't initiate.
  if (lastResult && lastResult.manual_override && lastResult.manual_override.active) {
    showMsg('Another manual override is active. Exit it first.', 'var(--error)');
    return;
  }

  pendingOp = op;
  pendingStartedAt = Date.now();
  showProgress(progressLabel, 'Waiting for controller acknowledgement…');
  setActionsDisabled(true);

  const sent = liveSource.sendCommand({ type: 'override-enter', ttl, forcedMode });
  if (!sent) {
    pendingOp = null;
    pendingStartedAt = 0;
    hideProgress();
    setActionsDisabled(false);
    showMsg('WebSocket not connected.', 'var(--error)');
    return;
  }

  if (ackTimer) clearTimeout(ackTimer);
  ackTimer = setTimeout(function () {
    ackTimer = null;
    if (pendingOp === op && lastResult && (!lastResult.manual_override || !lastResult.manual_override.active)) {
      pendingOp = null;
      pendingStartedAt = 0;
      hideProgress();
      setActionsDisabled(false);
      showMsg('No response from controller.', 'var(--error)');
    }
  }, ACK_TIMEOUT_MS);
}

function abortPending() {
  if (!pendingOp) return;
  const liveSource = _getLiveSource();
  if (!liveSource) return;
  // We mark pendingOp as null BEFORE sending exit so the next state
  // frame doesn't re-trigger our auto-exit logic.
  const wasOp = pendingOp;
  pendingOp = null;
  pendingStartedAt = 0;
  hideProgress();
  liveSource.sendCommand({ type: 'override-exit' });
  showMsg(wasOp === 'drain' ? 'Drain aborted.' : 'Refill aborted.', 'var(--on-surface-variant)');
}

function handleCommandResponse(msg) {
  if (!msg || !pendingOp) return;
  if (msg.type === 'override-error') {
    // Only react if we're still waiting on the entry ack — once we're past
    // that (override active), errors come from elsewhere (e.g. relay-board).
    if (lastResult && lastResult.manual_override && lastResult.manual_override.active) return;
    pendingOp = null;
    pendingStartedAt = 0;
    if (ackTimer) { clearTimeout(ackTimer); ackTimer = null; }
    hideProgress();
    setActionsDisabled(false);
    showMsg(msg.message || 'Override request rejected.', 'var(--error)');
  }
  // override-ack updates flow through the regular updateDrainageControl
  // path via the state broadcast — no need to handle them here.
}

export function updateDrainageControl(result) {
  if (!result) return;
  lastResult = result;

  const drained = !!(result.flags && result.flags.collectors_drained);
  const mode = result.mode || '';
  const mo = result.manual_override;
  const overrideActive = !!(mo && mo.active);
  const overrideFm = (mo && mo.forcedMode) || null;
  const ce = !!result.controls_enabled;

  updateStatusBadge(drained);

  // Auto-exit logic: the controller has reached the target state, hand
  // control back to automation immediately so freeze-drain safety
  // returns. The transitions:
  //   drain  →  drained=true  AND mode=idle (stopDrain transitions to IDLE)
  //   refill →  drained=false AND mode=solar_charging
  if (pendingOp === 'drain' && overrideActive && overrideFm === 'AD'
      && drained && mode === 'idle') {
    completeOp('drain', 'Drain complete — automation resumed.');
    return;
  }
  if (pendingOp === 'refill' && overrideActive && overrideFm === 'SC'
      && !drained && mode === 'solar_charging') {
    completeOp('refill', 'Refill complete — automation resumed.');
    return;
  }

  // Update the in-progress banner detail line while waiting for completion.
  if (pendingOp && overrideActive && (
    (pendingOp === 'drain' && overrideFm === 'AD') ||
    (pendingOp === 'refill' && overrideFm === 'SC')
  )) {
    const remaining = Math.max(0, (mo.expiresAt || 0) - Math.floor(Date.now() / 1000));
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    const cd = min + ':' + (sec < 10 ? '0' : '') + sec;
    if (pendingOp === 'drain') {
      const detail = mode === 'active_drain'
        ? 'Pump running — collectors emptying. Override expires in ' + cd + '.'
        : 'Transitioning to ACTIVE_DRAIN. Override expires in ' + cd + '.';
      showProgress('Draining collectors…', detail);
    } else {
      const detail = mode === 'solar_charging'
        ? 'Pump running — collectors filling. Override expires in ' + cd + '.'
        : 'Transitioning to SOLAR_CHARGING. Override expires in ' + cd + '.';
      showProgress('Refilling collectors…', detail);
    }
  } else if (pendingOp && !overrideActive && Date.now() - pendingStartedAt > ACK_TIMEOUT_MS) {
    // Override was cancelled externally (TTL expired, exited from another
    // tab, or controller dropped offline) — clear our pending flag.
    pendingOp = null;
    pendingStartedAt = 0;
    hideProgress();
    setActionsDisabled(false);
    showMsg('Override ended before completion.', 'var(--on-surface-variant)');
  }

  // Button-disable logic. Disabled when:
  //   - controls disabled at the device level (ce=false)
  //   - pendingOp is in flight (we're driving an op)
  //   - someone else holds an override (don't fight over it)
  //   - state already at the target (drain when drained, refill when filled)
  // The user role gate is applied via #view-device having data-admin-only.
  if (pendingOp) return; // banner is showing the buttons
  const userRole = store.get('userRole') || 'admin';
  const isAdmin = userRole === 'admin';
  const blocked = !ce || !isAdmin || overrideActive;
  document.getElementById('drainage-drain-btn').disabled = blocked || drained;
  document.getElementById('drainage-refill-btn').disabled = blocked || !drained;
}

function completeOp(op, msg) {
  pendingOp = null;
  pendingStartedAt = 0;
  if (ackTimer) { clearTimeout(ackTimer); ackTimer = null; }
  hideProgress();
  setActionsDisabled(false);
  const liveSource = _getLiveSource();
  if (liveSource) liveSource.sendCommand({ type: 'override-exit' });
  showMsg(msg, 'var(--primary)');
}

function updateStatusBadge(drained) {
  const badge = document.getElementById('drainage-status-badge');
  const icon = document.getElementById('drainage-status-icon');
  const text = document.getElementById('drainage-status-text');
  if (drained) {
    badge.textContent = 'DRAINED';
    badge.style.background = 'var(--primary)';
    badge.style.color = 'var(--on-primary)';
    icon.textContent = 'humidity_low';
    icon.style.color = 'var(--primary)';
    text.textContent = 'Loop is empty. Safe from freezing. Refill before solar charging.';
  } else {
    badge.textContent = 'FILLED';
    badge.style.background = 'var(--surface-variant)';
    badge.style.color = 'var(--on-surface-variant)';
    icon.textContent = 'water_drop';
    icon.style.color = 'var(--on-surface-variant)';
    text.textContent = 'Loop is filled. Solar charging available; freeze-drain on standby.';
  }
}

function setActionsDisabled(disabled) {
  document.getElementById('drainage-drain-btn').disabled = disabled;
  document.getElementById('drainage-refill-btn').disabled = disabled;
}

function showProgress(title, detail) {
  document.getElementById('drainage-progress-title').textContent = title;
  document.getElementById('drainage-progress-detail').textContent = detail;
  document.getElementById('drainage-progress').style.display = '';
}

function hideProgress() {
  document.getElementById('drainage-progress').style.display = 'none';
}

function showMsg(text, color) {
  const el = document.getElementById('drainage-msg');
  el.textContent = text;
  el.style.color = color || 'var(--on-surface-variant)';
  el.style.display = '';
  if (msgFadeTimer) clearTimeout(msgFadeTimer);
  msgFadeTimer = setTimeout(function () { el.style.display = 'none'; }, 6000);
}

// Indirection so tests can stub window.confirm via fixtures.
function confirmAction(text) {
  return window.confirm(text);
}
