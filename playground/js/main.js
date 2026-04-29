import { loadSystemYaml } from './yaml-loader.js';
import { ThermalModel } from './physics.js';
import { ControlStateMachine, initControlLogic } from './control.js';
import { createSlider } from './ui.js';
import { startVersionCheck, triggerVersionCheck } from './version-check.js';
import { initSensorsView, destroySensorsView } from './sensors.js';
import { store } from './app-state.js';
import { initSubscriptions, setViewLifecycle } from './subscriptions.js';
import { initNavigation } from './actions/navigation.js';
import { mountCrashesView } from './crashes-view.js';
import { initAuth } from './auth.js';
import { captureInstallPrompt, initNotifications } from './notifications.js';
import { buildSchematic as buildSchematicFromSvg } from './schematic.js';
import { setupFAB, togglePlay, updateFABIcon, resetSimulationTime } from './main/simulation.js';
import { resetModeEvents, appendModeEvent } from './main/mode-events.js';
import { initWatchdogUI } from './main/watchdog-ui.js';
import { initRelayBoard } from './main/relay-board.js';
import { initDrainageControl } from './main/drainage-control.js';
import { initDeviceConfig } from './main/device-config.js';
import { wireNotificationUI } from './main/notifications-ui.js';
import { drawHistoryGraph, toSchematicState } from './main/history-graph.js';
import {
  transitionLog, setupLogsScrollLoader, setupCopyLogsButton,
} from './main/logs.js';
import { initBalanceCard } from './main/balance-card.js';
import { setupInspector } from './main/graph-inspector.js';
import { fetchLiveHistory } from './main/live-history.js';
import {
  updateDisplay, rerenderWithHistoryFallback,
  setSchematicHandle, getLastFrame, resetYesterdayTracking,
} from './main/display-update.js';
import {
  initConnection, initModeToggle, updateSidebarSubtitle, getLiveSource,
} from './main/connection.js';
window.__triggerVersionCheck = triggerVersionCheck;

// Shared mutable state lives in ./main/state.js as a leaf module so
// siblings don't have to import back from main.js (which would cycle).
import {
  model, controller, running, graphRange, showAllSensors,
  params, timeSeriesStore,
  setModel, setController, setRunning,
  setSimSpeed, setGraphRange, setShowAllSensors,
} from './main/state.js';

let config = null;

const PRESETS = {
  spring_fall:   { label: 'Spring / Fall',      t_outdoor: 10,   irradiance: 500, t_tank_top: 12, t_tank_bottom: 9,  t_greenhouse: 11, gh_thermal_mass: 250000, gh_heat_loss: 100 },
  summer_peak:   { label: 'Summer Peak Heat',   t_outdoor: 26,   irradiance: 500, t_tank_top: 88, t_tank_bottom: 85, t_greenhouse: 11, gh_thermal_mass: 250000, gh_heat_loss: 100 },
  early_late:    { label: 'Late / Early Season', t_outdoor: -5.5, irradiance: 240, t_tank_top: 13, t_tank_bottom: 13, t_greenhouse: 5,  gh_thermal_mass: 250000, gh_heat_loss: 100 },
};

// ── Init ──
async function init() {
  try {
    config = await loadSystemYaml('../system.yaml');
  } catch {
    config = buildFallbackConfig();
  }

  await initControlLogic();
  setModel(new ThermalModel({
    greenhouse_thermal_mass: params.gh_thermal_mass,
    greenhouse_UA: params.gh_heat_loss,
  }));
  setController(new ControlStateMachine(config.modes));

  // Set up view lifecycle callbacks for the store-driven navigation.
  // Sensor discovery UI lives inside the merged Device view, so it mounts
  // when currentView === 'device'.
  setViewLifecycle({
    device: {
      mount: () => {
        initSensorsView();
        return () => destroySensorsView();
      }
    },
    crashes: {
      mount: () => mountCrashesView()
    }
  });

  // Initialize store subscriptions (nav, overlays, indicators)
  initSubscriptions(store);

  // Initialize hash-based navigation via store
  initNavigation(store);

  setupControls();
  setupTimeRangeSlider();
  setupAllSensorsToggle();
  setupFAB();
  resetSim();
  // Schematic view — async build, handle held in display-update module.
  (async () => {
    try {
      const handle = await buildSchematicFromSvg({
        container: document.getElementById('schematic'),
        svgUrl: './assets/system-topology.svg',
      });
      setSchematicHandle(handle);
      // If a result is already available, apply it immediately
      const last = getLastFrame();
      if (last.state && last.result) {
        handle.update(toSchematicState(last.state, last.result));
      }
    } catch (err) {
      console.error('[schematic] build failed:', err);
      const el = document.getElementById('schematic');
      if (el) el.textContent = 'Failed to load schematic';
    }
  })();
  setupInspector();
  setupLogsScrollLoader();
  setupCopyLogsButton();
  initBalanceCard({ onRerender: rerenderWithHistoryFallback });
  updateDisplay(model.getState(), { mode: 'idle', valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false }, actuators: { pump: false, fan: false, space_heater: false }, transition: null });

  // Initialize live/simulation mode toggle
  initConnection({ setRunning });
  initModeToggle();
  initDeviceConfig();
  initRelayBoard({ getLiveSource });
  initDrainageControl({ getLiveSource });
  initWatchdogUI({ getLiveSource });

  // On deploys without live mode (e.g. GitHub Pages) load the
  // pre-baked simulation snapshot so the dashboard is populated on
  // first paint instead of empty. The snapshot is generated at build
  // time by `scripts/generate-bootstrap-history.mjs` and a drift test
  // in `tests/bootstrap-history-drift.test.js` ensures it stays in
  // sync with the current control logic + thermal model.
  if (!store.get('isLiveCapable')) {
    // Fire-and-forget — async fetch + render. init() doesn't await it
    // so the rest of the page stays interactive.
    loadBootstrapSnapshotAndAutoStart();
  }

  // Initialize auth UI (logout + invite buttons) — noop when auth disabled
  initAuth();

  // PWA install prompt capture (must be early, before beforeinstallprompt fires)
  captureInstallPrompt();

  // Wire DOM listeners synchronously — must run before __initComplete so
  // tests (and slow real-network users) don't race against initNotifications().
  wireNotificationUI();
  initNotifications();

  // Start polling for JS source updates
  startVersionCheck();

  // Test hook — frontend specs poll this to know that init() has
  // wired everything (initConnection + initModeToggle, in
  // particular). Same pattern as window.__getHistoryPointCount.
  window.__initComplete = true;
}

function buildFallbackConfig() {
  return {
    modes: {
      idle: { description: 'Default', valve_states: { vi_btm: 'CLOSED', vi_top: 'CLOSED', vi_coll: 'CLOSED', vo_coll: 'CLOSED', vo_rad: 'CLOSED', vo_tank: 'CLOSED', v_air: 'CLOSED' }, actuators: { pump: 'OFF', fan: 'OFF' } },
      solar_charging: { description: 'Solar charging', trigger: 't_collector > t_tank_bottom + 7', exit: 't_collector < t_tank_bottom + 3', valve_states: { vi_btm: 'OPEN', vi_top: 'CLOSED', vi_coll: 'CLOSED', vo_coll: 'OPEN', vo_rad: 'CLOSED', vo_tank: 'CLOSED', v_air: 'CLOSED' }, actuators: { pump: 'ON', fan: 'OFF' } },
      greenhouse_heating: { description: 'Greenhouse heating', trigger: 't_greenhouse < 10 AND t_tank_top > 25', exit: 't_greenhouse > 12', valve_states: { vi_btm: 'CLOSED', vi_top: 'OPEN', vi_coll: 'CLOSED', vo_coll: 'CLOSED', vo_rad: 'OPEN', vo_tank: 'CLOSED', v_air: 'CLOSED' }, actuators: { pump: 'ON', fan: 'ON' } },
      active_drain: { description: 'Active drain', trigger: 't_outdoor < 2', exit: null, valve_states: { vi_btm: 'CLOSED', vi_top: 'CLOSED', vi_coll: 'OPEN', vo_coll: 'CLOSED', vo_rad: 'CLOSED', vo_tank: 'OPEN', v_air: 'OPEN' }, actuators: { pump: 'ON', fan: 'OFF' } },
      overheat_drain: { description: 'Overheat drain', trigger: 't_tank_top > 85', exit: null, valve_states: { vi_btm: 'CLOSED', vi_top: 'CLOSED', vi_coll: 'OPEN', vo_coll: 'CLOSED', vo_rad: 'CLOSED', vo_tank: 'OPEN', v_air: 'OPEN' }, actuators: { pump: 'ON', fan: 'OFF' } },
      emergency_heating: { description: 'Emergency', trigger: 't_greenhouse < 5 AND t_tank_top < 25', exit: 't_greenhouse > 8', valve_states: { vi_btm: 'CLOSED', vi_top: 'CLOSED', vi_coll: 'CLOSED', vo_coll: 'CLOSED', vo_rad: 'CLOSED', vo_tank: 'CLOSED', v_air: 'CLOSED' }, actuators: { pump: 'OFF', fan: 'OFF', space_heater: 'ON' } },
    },
    valves: {}, sensors: {}, components: {}, safety: [],
    project: { name: 'Greenhouse Solar Heater' },
  };
}

// ── Navigation is now store-driven via js/actions/navigation.js + js/subscriptions.js ──


// ── Timeframe progressive slider ──

// Haptic tick on snap. Matches the createSlider pattern in ui.js so the
// feel is consistent with the simulation-controls sliders (8 ms pulse).
function hapticTick() {
  try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) { /* noop */ }
}

function setupTimeRangeSlider() {
  const slider = document.getElementById('time-range-slider');
  if (!slider) return;
  const thumb = slider.querySelector('.time-range-slider-thumb');
  const fill = slider.querySelector('.time-range-slider-fill');
  const stepsWrap = slider.querySelector('.time-range-slider-steps');
  const allSteps = Array.from(stepsWrap.querySelectorAll('.time-range-slider-step'));

  function visibleSteps() {
    return allSteps.filter(el => el.style.display !== 'none');
  }

  function updateThumb(stepEls, activeIdx) {
    if (stepEls.length === 0) return;
    // Position thumb over the active step. Width/position are fractions of
    // the steps-container width so the thumb tracks flex sizing regardless
    // of how many steps are visible.
    const widthPct = 100 / stepEls.length;
    const leftPct = widthPct * activeIdx;
    thumb.style.width = widthPct + '%';
    thumb.style.transform = 'translateX(' + (leftPct / widthPct * 100) + '%)';
    fill.style.width = (leftPct + widthPct) + '%';
    allSteps.forEach(b => b.classList.remove('active'));
    stepEls[activeIdx].classList.add('active');
    slider.setAttribute('aria-valuemin', '0');
    slider.setAttribute('aria-valuemax', String(stepEls.length - 1));
    slider.setAttribute('aria-valuenow', String(activeIdx));
    slider.setAttribute('aria-valuetext', stepEls[activeIdx].textContent);
  }

  function commit(stepEls, idx, fromUser) {
    idx = Math.max(0, Math.min(stepEls.length - 1, idx));
    const el = stepEls[idx];
    const seconds = parseInt(el.dataset.range, 10);
    const changed = graphRange !== seconds;
    setGraphRange(seconds);
    updateThumb(stepEls, idx);
    if (changed) {
      if (fromUser) hapticTick();
      if (store.get('phase') === 'live') {
        fetchLiveHistory(graphRange);
      } else {
        drawHistoryGraph();
      }
    }
  }

  function idxFromClientX(stepEls, clientX) {
    const rect = stepsWrap.getBoundingClientRect();
    const frac = (clientX - rect.left) / rect.width;
    return Math.round(frac * (stepEls.length - 1));
  }

  // Initialize: reflect the current graphRange (default 24h / step 3).
  function syncFromState() {
    const stepEls = visibleSteps();
    let idx = stepEls.findIndex(el => parseInt(el.dataset.range, 10) === graphRange);
    if (idx < 0) {
      // graphRange points at a step hidden in this phase (e.g. switched
      // live→sim while on 7d). Clamp to the largest visible step and
      // rewrite state so subsequent fetches use a supported range.
      idx = stepEls.length - 1;
      const el = stepEls[idx];
      setGraphRange(parseInt(el.dataset.range, 10));
    }
    updateThumb(stepEls, idx);
  }
  syncFromState();

  // Clicks on an individual step snap directly — same as the old pills.
  stepsWrap.addEventListener('click', (e) => {
    const btn = e.target.closest('.time-range-slider-step');
    if (!btn || btn.style.display === 'none') return;
    const stepEls = visibleSteps();
    const idx = stepEls.indexOf(btn);
    if (idx >= 0) commit(stepEls, idx, true);
  });

  // Drag support: pointer events cover mouse + touch + pen uniformly.
  let dragging = false;
  let activePointer = null;
  let lastIdx = -1;

  function onDown(e) {
    // Only react to the primary button; touch/pen pointer types always have button=0.
    if (e.button !== undefined && e.button !== 0) return;
    dragging = true;
    activePointer = e.pointerId;
    slider.classList.add('dragging');
    try { slider.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
    const stepEls = visibleSteps();
    const idx = idxFromClientX(stepEls, e.clientX);
    lastIdx = idx;
    commit(stepEls, idx, true);
    e.preventDefault();
  }

  function onMove(e) {
    if (!dragging || e.pointerId !== activePointer) return;
    const stepEls = visibleSteps();
    const idx = idxFromClientX(stepEls, e.clientX);
    if (idx !== lastIdx) {
      lastIdx = idx;
      commit(stepEls, idx, true);
    }
  }

  function onUp(e) {
    if (!dragging || (activePointer !== null && e.pointerId !== activePointer)) return;
    dragging = false;
    activePointer = null;
    lastIdx = -1;
    slider.classList.remove('dragging');
  }

  slider.addEventListener('pointerdown', onDown);
  slider.addEventListener('pointermove', onMove);
  slider.addEventListener('pointerup', onUp);
  slider.addEventListener('pointercancel', onUp);

  // Keyboard access: arrow keys step, Home/End jump to bounds.
  slider.addEventListener('keydown', (e) => {
    const stepEls = visibleSteps();
    const current = stepEls.findIndex(el => parseInt(el.dataset.range, 10) === graphRange);
    const cur = current < 0 ? 0 : current;
    let next;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - 1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = stepEls.length - 1;
    else return;
    e.preventDefault();
    commit(stepEls, next, true);
  });

  // Re-sync when phase flips live↔sim — .live-only steps show/hide and
  // the visible set changes. subscriptions.js has already toggled
  // display:none by the time this subscriber fires (it registers earlier
  // via initSubscriptions).
  store.subscribe('phase', () => { syncFromState(); });
}

function setupAllSensorsToggle() {
  // Reuse the same pill-switch component the mode-toggle uses. The switch
  // itself (#graph-show-all-sensors) is a <div> whose `.active` class drives
  // the visual + aria state; the surrounding container (-toggle) captures
  // clicks on both the label text and the switch.
  const sw = document.getElementById('graph-show-all-sensors');
  const container = document.getElementById('graph-show-all-sensors-toggle');
  if (!sw || !container) return;

  const render = () => {
    sw.classList.toggle('active', showAllSensors);
    sw.setAttribute('aria-checked', showAllSensors ? 'true' : 'false');
  };
  const toggle = () => {
    setShowAllSensors(!showAllSensors);
    render();
    applyAllSensorsVisibility();
    drawHistoryGraph();
  };

  render();
  applyAllSensorsVisibility();
  container.addEventListener('click', toggle);
  sw.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggle();
    }
  });
}

function applyAllSensorsVisibility() {
  const display = showAllSensors ? '' : 'none';
  document.querySelectorAll('.sensor-detail').forEach((el) => {
    el.style.display = display;
  });
}

// ── Controls ──
const liveStateKeys = { t_tank_top: 't_tank_top', t_tank_bottom: 't_tank_bottom', t_greenhouse: 't_greenhouse' };

const sliderRefs = {};

function setupControls() {
  const el = document.getElementById('controls');
  const sliders = [
    { id: 'outdoor', label: 'Outdoor Temp', min: -30, max: 40, step: 2, value: params.t_outdoor, unit: '°C', key: 't_outdoor' },
    { id: 'irradiance', label: 'Solar Irradiance', min: 0, max: 1000, step: 50, value: params.irradiance, unit: ' W/m²', key: 'irradiance' },
    { id: 'tank-top', label: 'Tank Top', min: 5, max: 95, step: 5, value: params.t_tank_top, unit: '°C', key: 't_tank_top' },
    { id: 'tank-bot', label: 'Tank Bottom', min: 5, max: 95, step: 5, value: params.t_tank_bottom, unit: '°C', key: 't_tank_bottom' },
    { id: 'greenhouse', label: 'Greenhouse', min: -10, max: 40, step: 2, value: params.t_greenhouse, unit: '°C', key: 't_greenhouse' },
    { id: 'gh-thermal-mass', label: 'GH Thermal Mass', value: params.gh_thermal_mass, unit: ' J/K', key: 'gh_thermal_mass',
      steps: [10000, 25000, 50000, 100000, 250000, 500000] },
    { id: 'gh-heat-loss', label: 'GH Night Heat Loss', min: 5, max: 750, step: 25, value: params.gh_heat_loss, unit: ' W/K', key: 'gh_heat_loss' },
    { id: 'speed', label: 'Sim Speed', min: 1, max: 10000, step: 1, value: params.sim_speed, unit: '×', key: 'sim_speed',
      steps: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 3000, 5000, 10000] },
  ];

  for (const s of sliders) {
    const ref = createSlider(el, {
      ...s,
      onChange: (v) => {
        params[s.key] = v;
        if (s.key === 'sim_speed') setSimSpeed(v);
        if (model && running && liveStateKeys[s.key]) {
          model.state[liveStateKeys[s.key]] = v;
        }
        // Physics params: push into model immediately
        if (model && s.key === 'gh_thermal_mass') model.p.greenhouse_thermal_mass = v;
        if (model && s.key === 'gh_heat_loss') model.p.greenhouse_UA = v;
        // Tank top must be >= tank bottom
        if (s.key === 't_tank_bottom' && v > params.t_tank_top) {
          params.t_tank_top = v;
          sliderRefs.t_tank_top.update(v);
        }
        if (s.key === 't_tank_top' && v < params.t_tank_bottom) {
          params.t_tank_bottom = v;
          sliderRefs.t_tank_bottom.update(v);
        }
      },
    });
    sliderRefs[s.key] = ref;
  }

  // Scenario presets
  const bar = document.getElementById('preset-bar');
  for (const [key, preset] of Object.entries(PRESETS)) {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.textContent = preset.label;
    btn.dataset.preset = key;
    btn.addEventListener('click', () => applyPreset(key));
    bar.appendChild(btn);
  }
  updatePresetHighlight('spring_fall');

  // Day/night toggle
  const dnGroup = document.createElement('div');
  dnGroup.className = 'control-group';
  dnGroup.innerHTML = `
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
      <input type="checkbox" id="day-night-toggle" checked> Day / Night Cycle
    </label>
    <div id="day-night-info" style="font-size:12px;color:var(--text-muted);margin-top:4px;">
      Sliders set base outdoor temp &amp; peak irradiance.<br>
      Time of day: <strong id="sim-time-of-day" style="color:var(--text-bright);">08:00</strong>
    </div>
  `;
  el.appendChild(dnGroup);

  document.getElementById('day-night-toggle').addEventListener('change', (e) => {
    params.day_night_cycle = e.target.checked;
    document.getElementById('day-night-info').style.display = e.target.checked ? '' : 'none';
  });

  // Reset
  document.getElementById('btn-reset').addEventListener('click', () => resetSim());
}

function resetSim() {
  model.p.greenhouse_thermal_mass = params.gh_thermal_mass;
  model.p.greenhouse_UA = params.gh_heat_loss;
  model.reset({
    t_tank_top: params.t_tank_top,
    t_tank_bottom: params.t_tank_bottom,
    t_greenhouse: params.t_greenhouse,
    t_outdoor: params.t_outdoor,
    irradiance: params.irradiance,
  });
  controller.reset();
  timeSeriesStore.reset();
  transitionLog.length = 0;
  resetYesterdayTracking();
  setRunning(false);
  resetSimulationTime();
  updateFABIcon();
  document.getElementById('sim-status-text').textContent = 'Ready — press play to start';
  updateSidebarSubtitle();
  updateDisplay(model.getState(), { mode: 'idle', valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false }, actuators: { pump: false, fan: false, space_heater: false }, transition: null });
}

// Restore the model + controller from a pre-baked snapshot. Used by
// the auto-bootstrap path on deploys where live mode is unavailable
// (GitHub Pages) — the snapshot is generated at build time by
// `scripts/generate-bootstrap-history.mjs` and lives at
// `playground/assets/bootstrap-history.json`. A drift test
// (`tests/bootstrap-history-drift.test.js`) ensures the snapshot is
// regenerated whenever the control logic or thermal model changes.
function restoreBootstrapSnapshot(snapshot) {
  // Re-init the model with default params, then overwrite the state
  // wholesale. Doing it via `model.reset()` plus direct assignment
  // (rather than constructing a new model) keeps the same instance
  // ref so simLoop keeps working.
  resetSim();

  const fms = snapshot.final_model_state;
  model.state.t_tank_top = fms.t_tank_top;
  model.state.t_tank_bottom = fms.t_tank_bottom;
  model.state.t_collector = fms.t_collector;
  model.state.t_greenhouse = fms.t_greenhouse;
  model.state.t_outdoor = fms.t_outdoor;
  model.state.irradiance = fms.irradiance;
  model.state.simTime = fms.simTime;

  const fcs = snapshot.final_controller_state;
  controller.currentMode = fcs.currentMode;
  controller.modeStartTime = fcs.modeStartTime;
  controller.collectorsDrained = fcs.collectorsDrained;
  controller.lastRefillAttempt = fcs.lastRefillAttempt;
  controller.emergencyHeatingActive = fcs.emergencyHeatingActive;
  controller.solarChargePeakTankAvg = (fcs.solarChargePeakTankAvg !== undefined)
    ? fcs.solarChargePeakTankAvg
    : null;
  controller.solarChargePeakTankAvgAt = fcs.solarChargePeakTankAvgAt || 0;

  // Push the historical points + log entries into the UI stores.
  // resetSim() already cleared both, so we can just append.
  resetModeEvents();
  for (let i = 0; i < snapshot.points.length; i++) {
    const p = snapshot.points[i];
    timeSeriesStore.addPoint(p.time, p.values);
  }
  // Reconstruct mode-events from the bootstrap log: each transition
  // entry encodes the mode the controller switched INTO at sim time
  // `time`, which is exactly what coverageInBucket / modeAt need.
  for (let i = 0; i < snapshot.log_entries.length; i++) {
    const e = snapshot.log_entries[i];
    transitionLog.unshift(e);
    if (e.kind === 'sim' && typeof e.time === 'number' && e.mode) {
      appendModeEvent({ ts: e.time, type: 'mode', to: e.mode });
    }
  }
}

// Fetch the pre-baked bootstrap snapshot, restore it into the model,
// repaint the UI, and start the run loop. Used on deploys where live
// mode is unavailable so the user lands on a populated dashboard
// instead of an empty placeholder.
async function loadBootstrapSnapshotAndAutoStart() {
  let snapshot = null;
  try {
    const response = await fetch('./assets/bootstrap-history.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    snapshot = await response.json();
  } catch (err) {
    console.warn('[bootstrap] Failed to load bootstrap-history.json, starting empty:', err);
  }

  if (snapshot) {
    restoreBootstrapSnapshot(snapshot);
  }

  // Re-render with a synthesised idle result. togglePlay() immediately
  // steps the simLoop and overwrites this with a real result.
  const idleResult = {
    mode: (controller && controller.currentMode) || 'idle',
    actuators: { pump: false, fan: false, space_heater: false },
    valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
    transition: null,
  };
  updateDisplay(model.getState(), idleResult);

  // Auto-start the run loop. togglePlay() preserves simTime since it's
  // non-zero after the snapshot restore, so our pre-rolled history is
  // kept. (And if the fetch failed, simTime is still 0 and togglePlay
  // will reset cleanly — the dashboard just starts with empty history.)
  togglePlay();
}

function applyPreset(key) {
  const preset = PRESETS[key];
  if (!preset) return;
  const keys = ['t_outdoor', 'irradiance', 't_tank_top', 't_tank_bottom', 't_greenhouse', 'gh_thermal_mass', 'gh_heat_loss'];
  for (const k of keys) {
    params[k] = preset[k];
    if (sliderRefs[k]) sliderRefs[k].update(preset[k]);
  }
  updatePresetHighlight(key);
  resetSim();
}

function updatePresetHighlight(activeKey) {
  for (const btn of document.querySelectorAll('.preset-btn')) {
    btn.classList.toggle('preset-active', btn.dataset.preset === activeKey);
  }
}



init();
