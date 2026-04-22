// Relay toggle board + manual-override UI. Extracted from main.js.
//
// External API:
//   initRelayBoard({ getLiveSource })
//   updateRelayBoard(result)   — called from each live state frame
//
// State is kept module-local; the only main.js-owned reference that
// leaks in is the live WebSocket source (passed via getLiveSource).

import { store } from '../app-state.js';
import { load as loadControlLogic } from '../control-logic-loader.js';
import { getWatchdogSnapshot } from './watchdog-ui.js';

let overrideActive = false;
let overrideExpiresAt = 0;
let overrideCountdownTimer = null;
let relayPendingState = {}; // relay → expected state (for reconciliation)
let relayPendingTimers = {}; // relay → timeout ID
// Last known controls_enabled value from any state message — used for
// optimistic re-enable of the Enter button after Exit Override, so the
// user doesn't wait up to 30s for the next Shelly state broadcast.
let lastControlsEnabled = false;
// Currently active forced-mode short code (null = Automatic)
var currentForcedMode = null;

// Short code → full MODE_VALVES/MODE_ACTUATORS key
var MODE_CODE_MAP = {
  I: 'IDLE', SC: 'SOLAR_CHARGING', GH: 'GREENHOUSE_HEATING',
  AD: 'ACTIVE_DRAIN', EH: 'EMERGENCY_HEATING'
};

// Original button labels keyed by data-mode value (for restoring after ban suffix)
var FM_BTN_LABELS = {
  I: 'Idle', SC: 'Solar charging',
  GH: 'Greenhouse heating', AD: 'Active drain', EH: 'Emergency heating'
};

let _getLiveSource = () => null;

// Apply forced-mode relay preview optimistically (no server round-trip)
function applyForcedModePreview(modeCode) {
  if (!modeCode) return; // Automatic — let real state reconcile
  var fullName = MODE_CODE_MAP[modeCode];
  if (!fullName) return;
  // loadControlLogic() is already cached after init()
  loadControlLogic().then(function (cl) {
    var valves = cl.MODE_VALVES[fullName] || {};
    var actuators = cl.MODE_ACTUATORS[fullName] || {};
    document.querySelectorAll('.relay-btn').forEach(function (btn) {
      var relay = btn.dataset.relay;
      var on = (relay === 'pump' || relay === 'fan')
        ? !!actuators[relay]
        : !!valves[relay];
      btn.classList.toggle('on', on);
    });
  });
}

export function initRelayBoard({ getLiveSource } = {}) {
  if (typeof getLiveSource === 'function') _getLiveSource = getLiveSource;

  // Enter override
  document.getElementById('override-enter-btn').addEventListener('click', enterOverride);

  // Exit override
  document.getElementById('override-exit-btn').addEventListener('click', exitOverride);

  // TTL buttons
  document.querySelectorAll('.ttl-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.ttl-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      if (overrideActive) updateOverrideTtl(parseInt(this.dataset.ttl, 10));
    });
  });

  // Relay buttons
  document.querySelectorAll('.relay-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      if (this.disabled || !overrideActive) return;
      toggleRelay(this);
    });
  });

  // Forced-mode buttons
  var forcedModeSendTimer = null;
  document.querySelectorAll('#forced-mode-btns .fm-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      if (this.disabled || !overrideActive) return;
      var mode = this.dataset.mode;
      if (!mode || mode === currentForcedMode) return;

      document.querySelectorAll('#forced-mode-btns .fm-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      try { if (navigator.vibrate) navigator.vibrate(50); } catch (e) {}
      applyForcedModePreview(mode);

      if (forcedModeSendTimer) clearTimeout(forcedModeSendTimer);
      forcedModeSendTimer = setTimeout(function () {
        var liveSource = _getLiveSource();
        if (liveSource) liveSource.sendCommand({ type: 'override-set-mode', mode: mode });
      }, 300);
      currentForcedMode = mode;
    });
  });

  // Status-view "Exit override" link
  var exitLink = document.getElementById('mode-card-exit-link');
  if (exitLink) {
    exitLink.addEventListener('click', function (ev) {
      ev.preventDefault();
      var liveSource = _getLiveSource();
      if (liveSource) liveSource.sendCommand({ type: 'override-exit' });
    });
  }

  // Command response handler
  var liveSource = _getLiveSource();
  if (liveSource) {
    liveSource.onCommandResponse(handleOverrideResponse);
  }
}

var overrideAckTimer = null;

function enterOverride() {
  var liveSource = _getLiveSource();
  if (!liveSource) return;
  // Hard-override confirmation. Automation including freeze-drain is
  // off while in override; the user needs to acknowledge that each
  // time so it's not triggered by a stray click. No confirmation on
  // subsequent fm changes within the same override session — we
  // trust the first "yes, I meant it" for the whole TTL window.
  var ok = window.confirm(
    'Manual override disables ALL automation until you exit (or the TTL expires) — ' +
    'including freeze-drain safety. On a cold night an active override can let the ' +
    'collectors freeze.\n\nContinue?'
  );
  if (!ok) return;

  var fmSelect = document.getElementById('override-entry-fm');
  var fm = fmSelect ? fmSelect.value : 'I';

  var btn = document.getElementById('override-enter-btn');
  btn.disabled = true;
  btn.textContent = 'Connecting...';

  var activeTtlBtn = document.querySelector('.ttl-btn.active');
  var ttl = activeTtlBtn ? parseInt(activeTtlBtn.dataset.ttl, 10) : 300;
  var sent = liveSource.sendCommand({ type: 'override-enter', ttl: ttl, forcedMode: fm });

  if (!sent) {
    btn.disabled = false;
    btn.textContent = 'Enter Manual Override';
    showOverrideMsg('WebSocket not connected.', 'var(--error)');
    return;
  }

  // Timeout if no ack received
  clearTimeout(overrideAckTimer);
  overrideAckTimer = setTimeout(function () {
    if (!overrideActive) {
      btn.disabled = false;
      btn.textContent = 'Enter Manual Override';
      showOverrideMsg('No response from server. Is the controller reachable?', 'var(--error)');
    }
  }, 5000);
}

function showOverrideMsg(text, color) {
  var el = document.getElementById('override-expired-msg');
  el.textContent = text;
  el.style.color = color || 'var(--on-surface-variant)';
  el.style.display = '';
  setTimeout(function () { el.style.display = 'none'; }, 6000);
}

function exitOverride() {
  var liveSource = _getLiveSource();
  if (!liveSource) return;
  liveSource.sendCommand({ type: 'override-exit' });
}

function updateOverrideTtl(ttl) {
  var liveSource = _getLiveSource();
  if (!liveSource || !overrideActive) return;
  liveSource.sendCommand({ type: 'override-update', ttl: ttl });
}

export function handleOverrideResponse(msg) {
  clearTimeout(overrideAckTimer);
  if (msg.type === 'override-ack') {
    if (msg.active) {
      activateOverrideUI(msg.expiresAt, msg.forcedMode);
    } else {
      deactivateOverrideUI();
    }
  } else if (msg.type === 'override-error') {
    // Restore enter button
    var btn = document.getElementById('override-enter-btn');
    btn.disabled = false;
    btn.textContent = 'Enter Manual Override';
    showOverrideMsg(msg.message, 'var(--error)');
  }
}

function activateOverrideUI(expiresAt, forcedMode) {
  overrideActive = true;
  overrideExpiresAt = expiresAt;
  currentForcedMode = forcedMode || null;
  document.getElementById('override-entry').style.display = 'none';
  document.getElementById('override-active-header').style.display = '';
  document.getElementById('relay-board').style.display = '';
  document.getElementById('override-expired-msg').style.display = 'none';
  document.querySelectorAll('.relay-btn').forEach(btn => { btn.disabled = false; });

  // Show forced-mode group; gate buttons for readonly users. Reflect
  // the active fm from the server so the button highlight matches the
  // mode we actually entered with.
  var fmGroup = document.getElementById('forced-mode-group');
  if (fmGroup) fmGroup.style.display = '';
  var userRole = store.get('userRole') || 'admin';
  var isAdmin = userRole === 'admin';
  document.querySelectorAll('#forced-mode-btns .fm-btn').forEach(function (b) {
    b.disabled = !isAdmin;
    b.classList.toggle('active', b.dataset.mode === forcedMode);
  });

  startCountdown();
}

function deactivateOverrideUI(msg) {
  overrideActive = false;
  overrideExpiresAt = 0;
  clearCountdown();
  document.getElementById('override-entry').style.display = '';
  document.getElementById('override-active-header').style.display = 'none';
  document.getElementById('relay-board').style.display = 'none';
  document.querySelectorAll('.relay-btn').forEach(btn => {
    btn.disabled = true;
    btn.classList.remove('on', 'relay-btn--pending', 'relay-btn--error');
  });
  relayPendingState = {};
  for (var k in relayPendingTimers) clearTimeout(relayPendingTimers[k]);
  relayPendingTimers = {};

  // Hide forced-mode group and reset its state
  currentForcedMode = null;
  var fmGroup = document.getElementById('forced-mode-group');
  if (fmGroup) fmGroup.style.display = 'none';
  document.querySelectorAll('#forced-mode-btns .fm-btn').forEach(function (b) {
    b.classList.remove('active');
    // Restore original button text (strip any " · banned" suffix)
    var orig = FM_BTN_LABELS[b.dataset.mode !== undefined ? b.dataset.mode : ''];
    if (orig) b.textContent = orig;
    b.disabled = false;
  });
  // No Automatic tile anymore — with hard override, fm is required
  // whenever override is active. On deactivation the whole group hides.
  // Reset the Enter button so the user doesn't see a stale "Connecting..."
  // and doesn't have to wait ~30s for the next state broadcast to recover.
  var enterBtn = document.getElementById('override-enter-btn');
  enterBtn.textContent = 'Enter Manual Override';
  enterBtn.disabled = !lastControlsEnabled;
  var gateMsg = document.getElementById('override-gate-msg');
  if (gateMsg) gateMsg.style.display = lastControlsEnabled ? 'none' : 'block';
  if (msg) {
    var expEl = document.getElementById('override-expired-msg');
    expEl.textContent = msg;
    expEl.style.display = '';
    expEl.style.color = 'var(--on-surface-variant)';
    setTimeout(() => { expEl.style.display = 'none'; }, 5000);
  }
}

function startCountdown() {
  clearCountdown();
  updateCountdownDisplay();
  overrideCountdownTimer = setInterval(updateCountdownDisplay, 1000);
}

function clearCountdown() {
  if (overrideCountdownTimer) { clearInterval(overrideCountdownTimer); overrideCountdownTimer = null; }
}

function updateCountdownDisplay() {
  var remaining = Math.max(0, overrideExpiresAt - Math.floor(Date.now() / 1000));
  var min = Math.floor(remaining / 60);
  var sec = remaining % 60;
  document.getElementById('override-countdown').textContent = min + ':' + (sec < 10 ? '0' : '') + sec;
  if (remaining <= 0 && overrideActive) {
    deactivateOverrideUI('Override expired — automation resumed.');
  }
}

function toggleRelay(btn) {
  var relay = btn.dataset.relay;
  var currentlyOn = btn.classList.contains('on');
  var newState = !currentlyOn;

  // Optimistic UI + haptic feedback
  btn.classList.toggle('on', newState);
  btn.classList.add('relay-btn--pending');
  try { if (navigator.vibrate) navigator.vibrate(50); } catch (e) {}

  // Send command
  var liveSource = _getLiveSource();
  if (liveSource) liveSource.sendCommand({ type: 'relay-command', relay: relay, on: newState });

  // Track pending state for reconciliation
  relayPendingState[relay] = newState;
  if (relayPendingTimers[relay]) clearTimeout(relayPendingTimers[relay]);
  relayPendingTimers[relay] = setTimeout(function () {
    // Reconciliation timeout — if state hasn't been confirmed, revert
    delete relayPendingState[relay];
    delete relayPendingTimers[relay];
    btn.classList.remove('relay-btn--pending');
    // Don't revert — next state broadcast will reconcile
  }, 2000);
}

export function updateRelayBoard(result) {
  if (!result) return;
  var mo = result.manual_override;
  // Update last-known controls_enabled FIRST so deactivateOverrideUI()
  // can use the fresh value for its optimistic re-enable.
  lastControlsEnabled = !!result.controls_enabled;

  // Handle override state from server
  if (mo && mo.active && !overrideActive) {
    // Override started externally or on reconnect
    activateOverrideUI(mo.expiresAt, mo.forcedMode);
  } else if ((!mo || !mo.active) && overrideActive) {
    // Override ended externally
    deactivateOverrideUI('Override ended — automation resumed.');
    return;
  } else if (mo && mo.active && overrideActive) {
    // Update expiry (may have been adjusted)
    overrideExpiresAt = mo.expiresAt;
  }

  // Update controls-enabled gate
  var ceEnabled = lastControlsEnabled;
  var enterBtn = document.getElementById('override-enter-btn');
  var gateMsg = document.getElementById('override-gate-msg');
  if (!overrideActive) {
    enterBtn.disabled = !ceEnabled;
    gateMsg.style.display = ceEnabled ? 'none' : 'block';
  }

  // ce=false during active override → force deactivate
  if (overrideActive && !ceEnabled) {
    deactivateOverrideUI('Controls disabled — override ended.');
    return;
  }

  if (!overrideActive) return;

  // Update relay button states from actual hardware state
  var valves = result.valves || {};
  var actuators = result.actuators || {};
  document.querySelectorAll('.relay-btn').forEach(btn => {
    var relay = btn.dataset.relay;
    var actual = (relay === 'pump' || relay === 'fan')
      ? !!actuators[relay]
      : !!valves[relay];

    // Reconcile with pending state
    if (relay in relayPendingState) {
      if (relayPendingState[relay] === actual) {
        // Confirmed — clear pending
        delete relayPendingState[relay];
        if (relayPendingTimers[relay]) { clearTimeout(relayPendingTimers[relay]); delete relayPendingTimers[relay]; }
        btn.classList.remove('relay-btn--pending');
      } else {
        // State doesn't match — command may have failed
        // Revert optimistic update
        delete relayPendingState[relay];
        if (relayPendingTimers[relay]) { clearTimeout(relayPendingTimers[relay]); delete relayPendingTimers[relay]; }
        btn.classList.remove('relay-btn--pending');
        btn.classList.add('relay-btn--error');
        setTimeout(() => btn.classList.remove('relay-btn--error'), 400);
      }
    }

    btn.classList.toggle('on', actual);
  });

  // Sync forced-mode button active state from server
  var fm = (mo && mo.forcedMode) || null;
  currentForcedMode = fm;
  var fmCode = fm || '';
  document.querySelectorAll('#forced-mode-btns .fm-btn').forEach(function (b) {
    b.classList.toggle('active', b.dataset.mode === fmCode);
  });

  // Apply wb bans to forced-mode buttons
  var wb = getWatchdogSnapshot().wb || {};
  var now = Math.floor(Date.now() / 1000);
  document.querySelectorAll('#forced-mode-btns .fm-btn').forEach(function (b) {
    var code = b.dataset.mode;
    if (!code) return; // Automatic button is never banned
    var banUntil = wb[code];
    var isBanned = banUntil && banUntil > now;
    var orig = FM_BTN_LABELS[code] || code;
    if (isBanned) {
      b.disabled = true;
      b.textContent = orig + ' · banned';
    } else {
      var userRole = store.get('userRole') || 'admin';
      b.disabled = userRole !== 'admin';
      b.textContent = orig;
    }
  });
}
