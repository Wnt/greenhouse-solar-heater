// Device Config UI. Extracted from main.js.
//
// External API: initDeviceConfig() — wire up the settings-view card.

import { store } from '../app-state.js';
import { renderModeEnablement } from './watchdog-ui.js';

let deviceConfigData = null;

export function initDeviceConfig() {
  // Toggle buttons (exclude relay override toggles — they have their own handlers)
  document.querySelectorAll('.device-toggle:not(#override-suppress-safety)').forEach(el => {
    el.addEventListener('click', () => el.classList.toggle('active'));
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

function loadDeviceConfig() {
  const loading = document.getElementById('device-config-loading');
  const form = document.getElementById('device-config-form');
  loading.style.display = '';
  form.style.display = 'none';

  fetch('/api/device-config')
    .then(r => r.json())
    .then(cfg => {
      deviceConfigData = cfg;
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

  // Mode enablement card (replaces the old allowed-modes checkboxes)
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
  const body = { ce, ea };

  fetch('/api/device-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(cfg => {
      deviceConfigData = cfg;
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
