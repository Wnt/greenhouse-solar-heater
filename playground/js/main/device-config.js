// Device Config UI. Extracted from main.js.
//
// External API: initDeviceConfig() — wire up the settings-view card.

import { store } from '../app-state.js';
import { renderModeEnablement } from './watchdog-ui.js';
import { putJson } from './fetch-helpers.js';

// Last-known wb (mode-ban map). Updated on form load and via the
// 'wb-changed' DOM event dispatched by renderModeEnablement, which
// fires on initial render AND on every WS-driven mode-enablement
// update — so the mismatch warning stays accurate even if the user
// disables EH from the mode-enablement card while looking at the
// device-config form.
let _currentWb = {};

export function initDeviceConfig() {
  // Toggle buttons (exclude relay override toggles — they have their own handlers)
  document.querySelectorAll('.device-toggle:not(#override-suppress-safety)').forEach(el => {
    el.addEventListener('click', () => el.classList.toggle('active'));
  });

  // Re-evaluate the heater-mask warning when the user flips the
  // Space Heater toggle. Runs after the generic toggle handler above
  // so .active reflects the new state.
  const ehToggle = document.getElementById('dc-ea-sh');
  if (ehToggle) {
    ehToggle.addEventListener('click', updateHeaterMaskWarning);
  }
  document.addEventListener('wb-changed', (e) => {
    _currentWb = (e && e.detail) || {};
    updateHeaterMaskWarning();
  });

  // Save button
  document.getElementById('dc-save').addEventListener('click', saveDeviceConfig);

  // "Try anyway" link
  const tryLink = document.getElementById('dc-try-anyway');
  if (tryLink) {
    tryLink.addEventListener('click', function (e) {
      e.preventDefault();
      saveDeviceConfig();
    });
  }

  // Load on first view
  loadDeviceConfig();
}

// Show the warning when Emergency Heating mode is enabled (no active
// wb.EH ban) but the EA_SPACE_HEATER bit (8) is unset. In that
// configuration the controller will enter EMERGENCY_HEATING mode
// when the greenhouse is cold, but setSpaceHeater() short-circuits
// the relay write — the mode is theatrical and no heat is delivered.
function updateHeaterMaskWarning() {
  const banner = document.getElementById('dc-heater-mask-warning');
  const toggle = document.getElementById('dc-ea-sh');
  if (!banner || !toggle) return;
  const heaterEnabled = toggle.classList.contains('active');
  const ehBan = _currentWb && _currentWb.EH;
  const now = Math.floor(Date.now() / 1000);
  const ehDisabled = ehBan && ehBan > now;
  banner.style.display = (!heaterEnabled && !ehDisabled) ? '' : 'none';
}

function loadDeviceConfig() {
  const loading = document.getElementById('device-config-loading');
  const form = document.getElementById('device-config-form');
  loading.style.display = '';
  form.style.display = 'none';

  fetch('/api/device-config')
    .then(r => r.json())
    .then(cfg => {
      populateDeviceForm(cfg);
      loading.style.display = 'none';
      form.style.display = '';
    })
    .catch(err => {
      loading.textContent = 'Failed to load config: ' + err.message;
    });
}

function populateDeviceForm(cfg) {
  // Controls enabled toggle
  setToggle('dc-ce', cfg.ce);

  // Actuator bitmask toggles
  const ea = cfg.ea || 0;
  setToggle('dc-ea-v', !!(ea & 1));
  setToggle('dc-ea-p', !!(ea & 2));
  setToggle('dc-ea-f', !!(ea & 4));
  setToggle('dc-ea-sh', !!(ea & 8));
  setToggle('dc-ea-ih', !!(ea & 16));

  // Mode enablement card (replaces the old allowed-modes checkboxes).
  // renderModeEnablement also dispatches the 'wb-changed' event, which
  // updates _currentWb and the heater-mask warning.
  renderModeEnablement(cfg.wb || {}, store.get('userRole') || 'admin');

  // Version & size
  document.getElementById('dc-version').textContent = cfg.v || '-';
  document.getElementById('dc-size').textContent = JSON.stringify(cfg).length;
}

function setToggle(id, on) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('active', on);
}

function saveDeviceConfig() {
  const status = document.getElementById('dc-status');
  status.textContent = 'Saving...';
  status.style.color = 'var(--on-surface-variant)';

  // Read form state
  const ce = document.getElementById('dc-ce').classList.contains('active');
  let ea = 0;
  if (document.getElementById('dc-ea-v').classList.contains('active')) ea |= 1;
  if (document.getElementById('dc-ea-p').classList.contains('active')) ea |= 2;
  if (document.getElementById('dc-ea-f').classList.contains('active')) ea |= 4;
  if (document.getElementById('dc-ea-sh').classList.contains('active')) ea |= 8;
  if (document.getElementById('dc-ea-ih').classList.contains('active')) ea |= 16;

  // Mode enablement is edited directly via the Mode Enablement card
  // (Disable / Re-enable / Clear cool-off), which calls PUT
  // /api/device-config with a partial wb payload. No am field is
  // computed or sent from this form.
  putJson('/api/device-config', { ce, ea })
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(cfg => {
      document.getElementById('dc-version').textContent = cfg.v;
      document.getElementById('dc-size').textContent = JSON.stringify(cfg).length;
      status.textContent = 'Saved (v' + cfg.v + ')';
      status.style.color = 'var(--secondary)';
      setTimeout(() => { status.textContent = ''; }, 3000);
    })
    .catch(err => {
      status.textContent = 'Error: ' + err.message;
      status.style.color = 'var(--error)';
    });
}
