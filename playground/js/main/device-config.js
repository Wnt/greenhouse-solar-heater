// Device Config UI. Extracted from main.js.
//
// External API: initDeviceConfig() — wire up the settings-view card.

import { store } from '../app-state.js';
import { renderModeEnablement } from './watchdog-ui.js';
import { putJson } from './fetch-helpers.js';
import { initTuningForecast, setForecastEntered } from './tuning-forecast.js';

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

// Keys handled by the dual-knob sliders under the forecast preview
// instead of the regular Tuning thresholds list above.
const SLIDER_KEYS = new Set(['geT', 'gxT', 'ehE', 'ehX']);
const SLIDER_CONTAINERS = ['dc-greenhouse-heat-slider', 'dc-emergency-heat-slider'];

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
  // The Greenhouse-heating (geT/gxT) and Emergency-heater (ehE/ehX)
  // pairs live under the forecast preview as dual-knob sliders. Their
  // hidden number inputs are created here so the rest of this module
  // can keep reading dc-tu-<key>.value without caring about the UI.
  SLIDER_CONTAINERS.forEach(initDualTemperatureSlider);
  // Each tuning input drives the forecast preview live as the user types.
  // Includes the hidden slider inputs — the slider dispatches 'input'
  // events on them after every drag, so the listener still fires.
  TUNING_FIELDS.forEach((f) => {
    const input = document.getElementById('dc-tu-' + f.key);
    if (input) input.addEventListener('input', pushEnteredTuning);
  });
  const resetBtn = document.getElementById('dc-tuning-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      TUNING_FIELDS.forEach((f) => {
        const input = document.getElementById('dc-tu-' + f.key);
        if (input) input.value = '';
      });
      syncSliderUI();
      pushEnteredTuning();
    });
  }

  // Forecast preview under the tuning inputs.
  initTuningForecast();

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
  // Hidden slider inputs were just rewritten — push the new values into
  // the slider thumb positions before refreshing the forecast preview.
  syncSliderUI();
  // Feed the forecast preview with the freshly-populated form values.
  // The dashed baseline is the live /api/forecast (saved config), so
  // it needs no client-side input.
  pushEnteredTuning();

  // Version & size
  document.getElementById('dc-version').textContent = cfg.v || '-';
  document.getElementById('dc-size').textContent = JSON.stringify(cfg).length;
}

function renderTuningInputs() {
  const list = document.getElementById('dc-tuning-list');
  if (!list) return;
  // Group fields under their group heading. Iteration order in
  // TUNING_FIELDS already matches the desired UI order. Fields handled
  // by a dual-knob slider are skipped here — their hidden inputs live
  // inside the slider container.
  let html = '';
  let lastGroup = null;
  TUNING_FIELDS.forEach((f) => {
    if (SLIDER_KEYS.has(f.key)) return;
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

// Dual-knob range slider for a pair of related tuning thresholds
// (enter/exit). The visible thumbs drive hidden number inputs that
// share IDs with the rest of the tuning form, so every other code
// path (read, save, reset) keeps working untouched.
//
// Each thumb is clamped to its own field's [min, max] *and* kept at
// least one step away from the other thumb, mirroring the server-side
// invariant gxT > geT (and ehX > ehE).
function initDualTemperatureSlider(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const loKey = container.dataset.loKey;
  const hiKey = container.dataset.hiKey;
  const loField = TUNING_FIELDS.find((f) => f.key === loKey);
  const hiField = TUNING_FIELDS.find((f) => f.key === hiKey);
  if (!loField || !hiField) return;

  // Slider range — by default the union of the two field ranges, but
  // each container may narrow it via data-slider-min / data-slider-max
  // (the typical operator-tweak range, not the full hardware range).
  const sMin = container.dataset.sliderMin !== undefined
    ? Number(container.dataset.sliderMin) : Math.min(loField.min, hiField.min);
  const sMax = container.dataset.sliderMax !== undefined
    ? Number(container.dataset.sliderMax) : Math.max(loField.max, hiField.max);
  const step = Math.min(loField.step, hiField.step);
  const minGap = step;
  // Effective per-knob bounds: intersect the field's own [min, max]
  // with the slider's visual [sMin, sMax]. This is what clamp() uses.
  const loLo = Math.max(sMin, loField.min);
  const loHi = Math.min(sMax, loField.max);
  const hiLo = Math.max(sMin, hiField.min);
  const hiHi = Math.min(sMax, hiField.max);
  const loLabel = container.dataset.loLabel || loField.label;
  const hiLabel = container.dataset.hiLabel || hiField.label;

  container.innerHTML = ''
    + '<div class="temp-dual-slider-readouts">'
    +   '<div class="temp-dual-slider-readout">'
    +     '<span class="temp-dual-slider-readout-label">' + escapeText(loLabel) + '</span>'
    +     '<span class="temp-dual-slider-readout-value" data-role="lo-readout">—</span>'
    +   '</div>'
    +   '<div class="temp-dual-slider-readout temp-dual-slider-readout--right">'
    +     '<span class="temp-dual-slider-readout-label">' + escapeText(hiLabel) + '</span>'
    +     '<span class="temp-dual-slider-readout-value" data-role="hi-readout">—</span>'
    +   '</div>'
    + '</div>'
    + '<div class="temp-dual-slider-track-wrap" data-role="track-wrap">'
    +   '<div class="temp-dual-slider-track"></div>'
    +   '<div class="temp-dual-slider-range" data-role="fill"></div>'
    +   '<input type="range" class="temp-dual-slider-input temp-dual-slider-input--lo"'
    +     ' min="' + sMin + '" max="' + sMax + '" step="' + step + '"'
    +     ' value="' + loField.defaultValue + '"'
    +     ' aria-label="' + escapeText(loLabel) + '" data-role="lo-range">'
    +   '<input type="range" class="temp-dual-slider-input temp-dual-slider-input--hi"'
    +     ' min="' + sMin + '" max="' + sMax + '" step="' + step + '"'
    +     ' value="' + hiField.defaultValue + '"'
    +     ' aria-label="' + escapeText(hiLabel) + '" data-role="hi-range">'
    + '</div>'
    + '<div class="temp-dual-slider-scale">'
    +   '<span>' + sMin + '°C</span>'
    +   '<span>' + sMax + '°C</span>'
    + '</div>'
    + '<input type="hidden" id="dc-tu-' + loKey + '" data-tu-key="' + loKey + '">'
    + '<input type="hidden" id="dc-tu-' + hiKey + '" data-tu-key="' + hiKey + '">';

  const loRange = container.querySelector('[data-role="lo-range"]');
  const hiRange = container.querySelector('[data-role="hi-range"]');
  const loReadout = container.querySelector('[data-role="lo-readout"]');
  const hiReadout = container.querySelector('[data-role="hi-readout"]');
  const fill = container.querySelector('[data-role="fill"]');
  const wrap = container.querySelector('[data-role="track-wrap"]');
  const loHidden = container.querySelector('#dc-tu-' + loKey);
  const hiHidden = container.querySelector('#dc-tu-' + hiKey);

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function frac(v) { return (v - sMin) / (sMax - sMin); }

  // 14 px thumb-radius inset on each side of the rail — the fill bar
  // lives in the same coordinate space as the rail and the thumb
  // centers, so they all align at every value.
  function paint() {
    const lo = Number(loRange.value);
    const hi = Number(hiRange.value);
    const loF = frac(lo);
    const widthF = Math.max(0, frac(hi) - loF);
    fill.style.left = 'calc(14px + ' + loF + ' * (100% - 28px))';
    fill.style.width = 'calc(' + widthF + ' * (100% - 28px))';
    const loRaw = loHidden.value;
    const hiRaw = hiHidden.value;
    const loDefault = loRaw === '';
    const hiDefault = hiRaw === '';
    const loShown = loDefault ? loField.defaultValue : Number(loRaw);
    const hiShown = hiDefault ? hiField.defaultValue : Number(hiRaw);
    loReadout.textContent = formatTemp(loShown);
    hiReadout.textContent = formatTemp(hiShown);
    loReadout.classList.toggle('temp-dual-slider-readout-value--default', loDefault);
    hiReadout.classList.toggle('temp-dual-slider-readout-value--default', hiDefault);
  }

  function syncFromHidden() {
    const loRaw = loHidden.value;
    const hiRaw = hiHidden.value;
    const loVal = loRaw === '' ? loField.defaultValue : Number(loRaw);
    const hiVal = hiRaw === '' ? hiField.defaultValue : Number(hiRaw);
    loRange.value = String(loVal);
    hiRange.value = String(hiVal);
    paint();
  }

  // Push behavior: when one knob invades the other's space, shove the
  // other knob along instead of clamping the moving one. Final values
  // are kept within their own field bounds AND the slider's visual
  // range. If the receiving knob hits its ceiling/floor, the moving
  // knob clamps so the one-step gap is preserved.
  function commitLo() {
    let lo = clamp(Number(loRange.value), loLo, loHi);
    let hi = Number(hiRange.value);
    const origHi = hi;
    if (lo > hi - minGap) {
      hi = clamp(lo + minGap, hiLo, hiHi);
      if (lo > hi - minGap) lo = hi - minGap;
    }
    loRange.value = String(lo);
    hiRange.value = String(hi);
    loHidden.value = String(lo);
    loHidden.dispatchEvent(new Event('input', { bubbles: true }));
    if (hi !== origHi) {
      hiHidden.value = String(hi);
      hiHidden.dispatchEvent(new Event('input', { bubbles: true }));
    }
    paint();
  }

  function commitHi() {
    let hi = clamp(Number(hiRange.value), hiLo, hiHi);
    let lo = Number(loRange.value);
    const origLo = lo;
    if (hi < lo + minGap) {
      lo = clamp(hi - minGap, loLo, loHi);
      if (hi < lo + minGap) hi = lo + minGap;
    }
    loRange.value = String(lo);
    hiRange.value = String(hi);
    hiHidden.value = String(hi);
    hiHidden.dispatchEvent(new Event('input', { bubbles: true }));
    if (lo !== origLo) {
      loHidden.value = String(lo);
      loHidden.dispatchEvent(new Event('input', { bubbles: true }));
    }
    paint();
  }

  loRange.addEventListener('input', commitLo);
  hiRange.addEventListener('input', commitHi);

  // When two thumbs overlap the upper one covers the lower one. Before
  // a touch lands, lift whichever thumb is closer to the touch point
  // above the other so either can always be grabbed.
  wrap.addEventListener('pointerdown', (e) => {
    const r = wrap.getBoundingClientRect();
    if (r.width <= 0) return;
    const px = e.clientX - r.left;
    // Thumb X centers live in the rail's 14 px-inset coordinate space.
    const loX = 14 + frac(Number(loRange.value)) * (r.width - 28);
    const hiX = 14 + frac(Number(hiRange.value)) * (r.width - 28);
    if (Math.abs(px - loX) < Math.abs(px - hiX)) {
      loRange.style.zIndex = '4'; hiRange.style.zIndex = '3';
    } else {
      hiRange.style.zIndex = '4'; loRange.style.zIndex = '3';
    }
  });

  container._syncFromHidden = syncFromHidden;
  syncFromHidden();
}

function formatTemp(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const s = (v === Math.floor(v)) ? v.toFixed(0) : v.toFixed(1);
  return s + '°';
}

function syncSliderUI() {
  SLIDER_CONTAINERS.forEach((id) => {
    const c = document.getElementById(id);
    if (c && typeof c._syncFromHidden === 'function') c._syncFromHidden();
  });
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

// Read the tuning form into a sparse numeric map for the forecast
// preview: empty fields are omitted (firmware default applies).
function readTuningForSim() {
  const tu = {};
  TUNING_FIELDS.forEach((f) => {
    const input = document.getElementById('dc-tu-' + f.key);
    if (!input) return;
    const raw = input.value.trim();
    if (raw === '') return;
    const num = Number(raw);
    if (Number.isFinite(num)) tu[f.key] = num;
  });
  return tu;
}

function pushEnteredTuning() {
  setForecastEntered(readTuningForSim());
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
      syncSliderUI();
      // The saved values are now the live forecast's baseline; refresh
      // the entered trajectory from the (post-clamp) form.
      pushEnteredTuning();
      setTimeout(() => { status.textContent = ''; }, 3000);
    })
    .catch(err => {
      status.textContent = 'Error: ' + err.message;
      status.style.color = 'var(--error)';
    });
}
