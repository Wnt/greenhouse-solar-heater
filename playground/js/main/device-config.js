// Device Config UI. Extracted from main.js.
//
// External API: initDeviceConfig() — wire up the settings-view card.

import { store } from '../app-state.js';
import { renderModeEnablement } from './watchdog-ui.js';
import { putJson } from './fetch-helpers.js';

// Tuning-threshold inputs. Compact key + UI metadata. Mirrors the
// server-side TUNING_RANGES table in server/lib/device-config.js and
// the TUNING_KEYS map in shelly/control-logic.js. Defaults shown here
// must match shelly/control-logic.js DEFAULT_CONFIG; a drift test in
// tests/device-config.test.js guards both directions.
const TUNING_FIELDS = [
  { key: 'geT', label: 'Greenhouse heat enter (°C)',     defaultValue: 10, min: 0,  max: 25,  step: 0.5, group: 'Greenhouse heating', help: 'Tank-fed heating starts when greenhouse drops below this.' },
  { key: 'gxT', label: 'Greenhouse heat exit (°C)',      defaultValue: 12, min: 1,  max: 30,  step: 0.5, group: 'Greenhouse heating', help: 'Tank-fed heating stops once the greenhouse exceeds this.' },
  { key: 'gmD', label: 'Min tank delta to start (K)',    defaultValue: 5,  min: 1,  max: 20,  step: 0.5, group: 'Greenhouse heating', help: 'Tank must be at least this many K warmer than the greenhouse to start heating.' },
  { key: 'gxD', label: 'Tank delta to keep going (K)',   defaultValue: 2,  min: 0,  max: 15,  step: 0.5, group: 'Greenhouse heating', help: 'While heating, stop if the tank drops below greenhouse + this delta.' },
  { key: 'ehE', label: 'Emergency heater enter (°C)',    defaultValue: 9,  min: 0,  max: 20,  step: 0.5, group: 'Emergency heater',   help: 'Electric space heater fires when greenhouse drops below this.' },
  { key: 'ehX', label: 'Emergency heater exit (°C)',     defaultValue: 12, min: 1,  max: 25,  step: 0.5, group: 'Emergency heater',   help: 'Electric space heater stops once the greenhouse exceeds this.' },
  { key: 'fcE', label: 'Fan-cool enter (°C)',            defaultValue: 30, min: 20, max: 50,  step: 0.5, group: 'Fan-cool',           help: 'Fan starts circulating air above this temperature.' },
  { key: 'fcX', label: 'Fan-cool exit (°C)',             defaultValue: 28, min: 15, max: 50,  step: 0.5, group: 'Fan-cool',           help: 'Fan stops once the greenhouse drops below this.' },
  { key: 'frT', label: 'Freeze drain (°C)',              defaultValue: 4,  min: 0,  max: 10,  step: 0.5, group: 'Safety',             help: 'Drain collectors when the colder of (outdoor, collector) falls below this.' },
  { key: 'ohT', label: 'Overheat drain (°C)',            defaultValue: 95, min: 70, max: 100, step: 1,   group: 'Safety',             help: 'Drain collectors if circulation cannot keep collector below this.' },
];

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

  // Render tuning inputs once at boot — values populated each load.
  renderTuningInputs();
  const resetBtn = document.getElementById('dc-tuning-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      TUNING_FIELDS.forEach((f) => {
        const input = document.getElementById('dc-tu-' + f.key);
        if (input) input.value = '';
      });
    });
  }

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

  // Tuning thresholds (sparse — undefined = use firmware default)
  const tu = cfg.tu || {};
  TUNING_FIELDS.forEach((f) => {
    const input = document.getElementById('dc-tu-' + f.key);
    if (!input) return;
    input.value = (typeof tu[f.key] === 'number') ? String(tu[f.key]) : '';
  });

  // Version & size
  document.getElementById('dc-version').textContent = cfg.v || '-';
  document.getElementById('dc-size').textContent = JSON.stringify(cfg).length;
}

function renderTuningInputs() {
  const list = document.getElementById('dc-tuning-list');
  if (!list) return;
  // Group fields under their group heading. Iteration order in
  // TUNING_FIELDS already matches the desired UI order.
  let html = '';
  let lastGroup = null;
  TUNING_FIELDS.forEach((f) => {
    if (f.group !== lastGroup) {
      html += '<div style="font-size:11px;font-weight:600;color:var(--on-surface-variant);margin:12px 0 4px;text-transform:uppercase;letter-spacing:0.5px;">'
        + escapeText(f.group) + '</div>';
      lastGroup = f.group;
    }
    html += '<div class="device-config-row">'
      + '<label class="device-config-label" for="dc-tu-' + f.key + '">' + escapeText(f.label) + '</label>'
      + '<input type="number" id="dc-tu-' + f.key + '" data-tu-key="' + f.key + '" '
      + 'min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" '
      + 'placeholder="' + f.defaultValue + '" '
      + 'style="width:88px;padding:4px 8px;border:1px solid var(--outline-variant);border-radius:6px;background:var(--surface-variant);color:var(--on-surface);font-size:13px;text-align:right;">'
      + '</div>'
      + '<p style="font-size:11px;color:var(--on-surface-variant);margin:-4px 0 4px;">' + escapeText(f.help) + '</p>';
  });
  list.innerHTML = html;
}

function escapeText(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function readTuningFromForm() {
  const tu = {};
  let hasAny = false;
  TUNING_FIELDS.forEach((f) => {
    const input = document.getElementById('dc-tu-' + f.key);
    if (!input) return;
    const raw = input.value.trim();
    if (raw === '') {
      // empty input → clear the override (server treats null as "remove")
      tu[f.key] = null;
      hasAny = true;
      return;
    }
    const num = Number(raw);
    if (!Number.isFinite(num)) return;
    tu[f.key] = num;
    hasAny = true;
  });
  return hasAny ? tu : null;
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
  const payload = { ce, ea };
  const tu = readTuningFromForm();
  if (tu) payload.tu = tu;
  putJson('/api/device-config', payload)
    .then(r => r.json().then(body => ({ ok: r.ok, status: r.status, body })))
    .then(({ ok, body }) => {
      if (!ok) throw new Error(body && body.error ? body.error : 'HTTP error');
      document.getElementById('dc-version').textContent = body.v;
      document.getElementById('dc-size').textContent = JSON.stringify(body).length;
      status.textContent = 'Saved (v' + body.v + ')';
      status.style.color = 'var(--secondary)';
      // Refresh the tuning inputs from the response so the user sees
      // any clamped values (e.g. typed 200, server saved 100).
      const ttu = body.tu || {};
      TUNING_FIELDS.forEach((f) => {
        const input = document.getElementById('dc-tu-' + f.key);
        if (!input) return;
        input.value = (typeof ttu[f.key] === 'number') ? String(ttu[f.key]) : '';
      });
      setTimeout(() => { status.textContent = ''; }, 3000);
    })
    .catch(err => {
      status.textContent = 'Error: ' + err.message;
      status.style.color = 'var(--error)';
    });
}
