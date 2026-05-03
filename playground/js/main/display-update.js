// Status / Components / Device render pipeline. updateDisplay is the
// single entry from simLoop, WS frames, resetSim, the bootstrap
// snapshot, and rerenderWithHistoryFallback.

import { store } from '../app-state.js';
import { tankStoredEnergyKwh } from '../physics.js';
import { timeSeriesStore, trendStore, MODE_INFO, running, setLastLiveFrame } from './state.js';
import { detectLiveTransition, renderLogsList } from './logs.js';
import { drawHistoryGraph, toSchematicState } from './history-graph.js';
import { appendBalanceLivePoint } from './balance-card.js';
import { modeAt } from './mode-events.js';
import { formatHeldLines } from './logs-clipboard.js';

// Live data may have null sensors when a role is unassigned — show "—".
const TEMP_PLACEHOLDER = '—';
function isNum(v) { return typeof v === 'number' && !Number.isNaN(v); }
function fmtTemp(v, digits) {
  if (digits === undefined) digits = 0;
  return isNum(v) ? v.toFixed(digits) : TEMP_PLACEHOLDER;
}

// 5-minute rolling window, ~1 °C/hr threshold → ≥0.083 °C per 5 min
// counts as rising/falling. Reads from trendStore (not timeSeriesStore)
// so the user picking a longer graph range — which resets timeSeriesStore
// and reloads downsampled history — does not blow away the high-resolution
// recent samples the trend computation needs. The trend is an "is it
// changing right now?" indicator and is intentionally decoupled from
// the graph card's timeframe selector.
const TREND_WINDOW_S = 300;
const TREND_THRESHOLD = 0.083;

function trendFor(resolver) {
  if (trendStore.times.length < 2) return null;
  const now = trendStore.times[trendStore.times.length - 1];
  const windowStart = now - TREND_WINDOW_S;
  let startIdx = trendStore.times.length - 1;
  for (let i = trendStore.times.length - 2; i >= 0; i--) {
    if (trendStore.times[i] < windowStart) break;
    startIdx = i;
  }
  if (startIdx >= trendStore.times.length - 1) return null;
  const fn = typeof resolver === 'function'
    ? resolver
    : (entry) => entry[resolver];
  const latest = fn(trendStore.values[trendStore.values.length - 1]);
  const earlier = fn(trendStore.values[startIdx]);
  if (!isNum(latest) || !isNum(earlier)) return null;
  const delta = latest - earlier;
  if (delta >= TREND_THRESHOLD) return 'rising';
  if (delta <= -TREND_THRESHOLD) return 'falling';
  return 'stable';
}

function avgTank(entry) {
  if (!isNum(entry.t_tank_top) || !isNum(entry.t_tank_bottom)) return null;
  return (entry.t_tank_top + entry.t_tank_bottom) / 2;
}

// Empty string until enough samples — avoids a fake "stable" arrow
// on startup before the trend is meaningful.
function renderTrendIcon(trend) {
  if (!trend) return '';
  const icon = trend === 'rising' ? 'trending_up'
             : trend === 'falling' ? 'trending_down'
             : 'trending_flat';
  const title = trend === 'rising' ? 'Rising' : trend === 'falling' ? 'Dropping' : 'Stable';
  return '<span class="trend-icon trend-' + trend +
         '" title="' + title +
         '"><span class="material-symbols-outlined">' + icon + '</span></span>';
}

// ── Forced-mode / override status helpers ──
const MODE_NAMES_SHORT = {
  I: 'Idle', SC: 'Solar charging', GH: 'Greenhouse heating',
  AD: 'Active drain', EH: 'Emergency heating'
};
function prettyModeName(code) {
  if (!code) return 'Idle';
  if (MODE_NAMES_SHORT[code]) return MODE_NAMES_SHORT[code];
  return code.toLowerCase().replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); });
}
function remainingStr(expiresAt) {
  const remaining = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

// Schematic module handle + last tick cache (so we can apply the
// first update as soon as the async SVG build resolves).
let schematicHandle = null;
let lastState = null;
let lastResult = null;
// True after the first real live WebSocket frame has rendered. Used
// by rerenderWithHistoryFallback to decide whether to trust
// lastState (a live WS frame) or fall back to the last history
// point (the initial updateDisplay call at boot seeds lastState
// with the sim model defaults, which we do NOT want to show in
// live mode).
let liveFrameSeen = false;

export function setSchematicHandle(h) { schematicHandle = h; }
export function getLastFrame() { return { state: lastState, result: lastResult }; }
export function setLiveFrameSeen(v) { liveFrameSeen = v; }
// Test hook — frontend specs use it to verify the sync coordinator's
// onResyncStart hook actually clears the flag, which is the seam
// that fixes the Android wrong-direction-arrow bug.
window.__getLiveFrameSeen = function () { return liveFrameSeen; };

export function updateDisplay(state, result) {
  const mode = result.mode;
  const info = MODE_INFO[mode] || MODE_INFO.idle;

  // ── Status view ──
  // Active mode card — handle forced-mode / override indicators
  const moBadgeEl = document.getElementById('mode-badge-label');
  const moTitleEl = document.getElementById('mode-card-title');
  const statusEl = document.getElementById('mode-card-status');
  const exitLinkEl = document.getElementById('mode-card-exit-link');
  const modeCardActive = document.getElementById('mode-card-active');

  const mo = result.manual_override;
  if (mo && mo.active && mo.forcedMode) {
    // Forced mode active
    moBadgeEl.textContent = 'Forced · ' + remainingStr(mo.expiresAt) + ' left';
    moTitleEl.textContent = prettyModeName(mo.forcedMode);
    if (modeCardActive) modeCardActive.classList.add('mode-card--forced');
  } else if (mo && mo.active) {
    // Manual override active (no forced mode)
    moBadgeEl.textContent = 'Manual override · ' + remainingStr(mo.expiresAt) + ' left';
    moTitleEl.textContent = info.label;
    if (modeCardActive) modeCardActive.classList.remove('mode-card--forced');
  } else {
    // Normal operation
    moBadgeEl.textContent = 'Current Mode';
    moTitleEl.textContent = info.label;
    if (modeCardActive) modeCardActive.classList.remove('mode-card--forced');
  }

  // Status line: use a text node + pulse span. The exit link is a
  // sibling of statusEl (not a child — see index.html), so we just
  // clear text nodes and append fresh; no insertBefore relative to
  // the exit link.
  Array.from(statusEl.childNodes).forEach(function (node) {
    if (node.nodeType === Node.TEXT_NODE) statusEl.removeChild(node);
  });
  let pulseSpan = statusEl.querySelector('.pulse');
  if (!pulseSpan) {
    pulseSpan = document.createElement('span');
    pulseSpan.className = 'pulse';
    statusEl.insertBefore(pulseSpan, statusEl.firstChild);
  }
  const statusText = document.createTextNode(running ? ' System Active' : ' System Ready');
  statusEl.appendChild(statusText);

  // Exit override link — admin only, visible when override is active
  if (exitLinkEl) {
    const userRole = store.get('userRole') || 'admin';
    const showExit = !!(mo && mo.active) && userRole === 'admin';
    exitLinkEl.style.display = showExit ? '' : 'none';
  }

  const bgIcon = document.querySelector('.mode-card-bg-icon .material-symbols-outlined');
  bgIcon.textContent = info.icon;
  bgIcon.style.fontVariationSettings = info.iconFill
    ? "'FILL' 1, 'wght' 300, 'GRAD' 0, 'opsz' 48"
    : "'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 48";

  // Held-by banner — populated from result.held when a guard suppresses
  // the evaluator's preferred decision (refill cooldown, wb-ban, ea-mask,
  // …). Hidden when nothing is held this tick. Reuses formatHeldLines
  // so the live banner and the System Logs export render identically.
  const heldBannerEl = document.getElementById('mode-held-banner');
  const heldListEl = document.getElementById('mode-held-list');
  if (heldBannerEl && heldListEl) {
    const heldLines = formatHeldLines(result && result.held, Math.floor(Date.now() / 1000));
    if (heldLines.length === 0) {
      heldBannerEl.style.display = 'none';
      heldListEl.innerHTML = '';
    } else {
      heldBannerEl.style.display = '';
      heldListEl.replaceChildren(...heldLines.map(l => {
        const li = document.createElement('li');
        li.textContent = l;
        return li;
      }));
    }
  }

  // Inactive modes
  const inactiveEl = document.getElementById('inactive-modes');
  const otherModes = ['solar_charging', 'greenhouse_heating', 'idle']
    .filter(m => m !== mode)
    .filter(m => !(m === 'idle' && !['solar_charging', 'greenhouse_heating', 'idle'].includes(mode)));
  inactiveEl.innerHTML = otherModes.map(m => {
    const mi = MODE_INFO[m];
    return `<div class="card mode-card mode-card-inactive" style="margin-bottom:8px;">
      <div><h4>${mi.label}</h4><p>${mi.desc}</p></div>
      <div class="mode-icon"><span class="material-symbols-outlined">${mi.icon}</span></div>
    </div>`;
  }).join('');

  // Tank temperature gauge — average of tank_top and tank_bottom.
  const tankAvg = (isNum(state.t_tank_top) && isNum(state.t_tank_bottom))
    ? (state.t_tank_top + state.t_tank_bottom) / 2
    : null;
  document.getElementById('tank-temp-val').textContent = fmtTemp(tankAvg, 0);

  // Energy stored: Q = m · c · (T_avg − T_base), 300 L water, base 12 °C.
  // Reflects the *current* tank state only — past cooling is already
  // baked into the current temperatures, so there is no separate
  // "loss" term to subtract.
  const energyEl = document.getElementById('tank-stat-energy');
  if (isNum(state.t_tank_top) && isNum(state.t_tank_bottom)) {
    const avgTankTemp = (state.t_tank_top + state.t_tank_bottom) / 2;
    energyEl.textContent = tankStoredEnergyKwh(avgTankTemp).toFixed(1);
  } else {
    energyEl.textContent = TEMP_PLACEHOLDER;
  }

  // Greenhouse current temperature + trend
  document.getElementById('tank-stat-greenhouse').textContent = fmtTemp(state.t_greenhouse, 0);
  const ghTrendEl = document.getElementById('tank-stat-greenhouse-trend');
  if (ghTrendEl) ghTrendEl.innerHTML = renderTrendIcon(trendFor('t_greenhouse'));

  // Gauge arc: 0°C = empty, 100°C = full circle (628 circumference)
  const arc = document.getElementById('tank-gauge-arc');
  if (arc) {
    if (isNum(tankAvg)) {
      const tempFrac = Math.max(0, Math.min(1, tankAvg / 100));
      const dashOffset = 628 - (tempFrac * 628);
      arc.setAttribute('stroke-dashoffset', dashOffset.toFixed(0));
    } else {
      arc.setAttribute('stroke-dashoffset', '628');
    }
  }

  // Status label: Rising/Falling/Stable — from the same tank avg.
  const statusLabel = document.getElementById('tank-temp-status');
  const tankTrend = trendFor(avgTank);
  const rateStatus = tankTrend === 'rising' ? 'RISING'
                   : tankTrend === 'falling' ? 'FALLING'
                   : 'STABLE';
  const rateColor = tankTrend === 'rising' ? '#e9c349'
                  : tankTrend === 'falling' ? '#ee7d77'
                  : '#43aea4';
  statusLabel.textContent = rateStatus;
  statusLabel.style.color = rateColor;

  // Message — thresholds applied to the tank average.
  const msgEl = document.getElementById('tank-temp-message');
  if (!isNum(tankAvg)) msgEl.textContent = 'Waiting for sensor data — assign sensors in the Sensors view.';
  else if (tankAvg > 80) msgEl.textContent = 'Approaching maximum temperature.';
  else if (tankAvg > 50) msgEl.textContent = 'Tank is well charged.';
  else if (tankAvg > 25) msgEl.textContent = 'Moderate thermal storage.';
  else msgEl.textContent = 'Tank is cold — waiting for solar gain.';

  // Critical components
  updateComponent('comp-pump', result.actuators.pump, 'ACTIVE', 'OFF');
  updateComponent('comp-fan', result.actuators.fan, 'ON', 'OFF');
  updateComponent('comp-heater', result.actuators.space_heater, 'ON', 'OFF');

  // Collectors fluid state. Drained = the freeze-drain or overheat-drain
  // sequence has emptied the collector loop into the tank; refilling
  // happens automatically on the next safe SOLAR_CHARGING window.
  // Highlighted when drained because that's the protected (and the
  // operator-actionable) state — drained means no freeze warning will
  // fire, the system is parked.
  const drained = !!(result.flags && result.flags.collectors_drained);
  const collectorsEl = document.getElementById('comp-collectors');
  if (collectorsEl) {
    collectorsEl.textContent = drained ? 'DRAINED' : 'FILLED';
    collectorsEl.className = 'component-value ' +
      (drained ? 'component-value-optimal' : 'component-value-off');
  }
  const collectorsIcon = document.getElementById('comp-collectors-icon');
  if (collectorsIcon) {
    collectorsIcon.textContent = drained ? 'humidity_low' : 'water_drop';
  }
  // Live mode: 'running' is meaningless (sim-only). Reflect actual
  // operation by checking whether mode is non-idle.
  const isLivePhase = store.get('phase') === 'live';
  const ctrlEl = document.getElementById('comp-controller');
  if (isLivePhase) {
    const anyActive = result.mode && result.mode !== 'idle';
    ctrlEl.textContent = anyActive ? 'ACTIVE' : 'READY';
  } else {
    ctrlEl.textContent = running ? 'OPTIMAL' : 'READY';
  }

  // Logs
  // Live mode: detect mode changes from the incoming state frame and
  // prepend synthetic entries. Sim mode: transitionLog is populated
  // by simLoop, so just re-render.
  if (isLivePhase) detectLiveTransition(result);
  renderLogsList();

  // ── Components view ──
  const tempBody = document.getElementById('temp-table');
  const temps = [
    ['Collector', state.t_collector, 't_collector'],
    ['Tank Top', state.t_tank_top, 't_tank_top'],
    ['Tank Bottom', state.t_tank_bottom, 't_tank_bottom'],
    ['Greenhouse', state.t_greenhouse, 't_greenhouse'],
    ['Outdoor', state.t_outdoor, 't_outdoor'],
  ];
  tempBody.innerHTML = temps.map(([n, v, key]) => {
    const valText = isNum(v) ? v.toFixed(1) + '°C' : TEMP_PLACEHOLDER;
    const trend = isNum(v) ? renderTrendIcon(trendFor(key)) : '';
    return `<tr><td>${n}</td><td class="val">${valText}${trend}</td></tr>`;
  }).join('');

  // Valve grid
  const VALVE_LABELS = {
    vi_btm: 'In: Tank Btm',
    vi_top: 'In: Reservoir',
    vi_coll: 'In: Collector',
    vo_coll: 'Out: Collector',
    vo_rad: 'Out: Radiator',
    vo_tank: 'Out: Tank',
    v_air: 'Air Intake',
  };
  const valveNames = ['vi_btm', 'vi_top', 'vi_coll', 'vo_coll', 'vo_rad', 'vo_tank', 'v_air'];
  document.getElementById('valve-grid').innerHTML = valveNames.map(v => {
    const raw = result.valves[v];
    const isOpen = raw === true || raw === 'OPEN';
    const cls = isOpen ? 'valve-chip-open' : 'valve-chip-closed';
    return `<div class="valve-chip"><span class="valve-chip-name">${VALVE_LABELS[v]}</span><span class="valve-chip-state ${cls}">${isOpen ? 'OPEN' : 'CLOSED'}</span></div>`;
  }).join('');

  // Actuator grid
  const actuators = [
    ['Pump', result.actuators.pump, 'cyclone'],
    ['Fan', result.actuators.fan, 'mode_fan'],
    ['Space Heater', result.actuators.space_heater, 'heat_pump'],
  ];
  document.getElementById('actuator-grid').innerHTML = actuators.map(([name, on, icon]) => {
    const cls = on ? 'component-value-active' : 'component-value-off';
    return `<div class="component-card">
      <div><div class="component-label">${name}</div><div class="component-value ${cls}">${on ? 'ON' : 'OFF'}</div></div>
      <span class="material-symbols-outlined component-icon">${icon}</span>
    </div>`;
  }).join('');

  // ── Transition status (live mode) ──
  const transEl = document.getElementById('transition-status');
  const stepEl = document.getElementById('transition-step');
  const opening = Array.isArray(result.opening) ? result.opening : [];
  const queuedOpens = Array.isArray(result.queued_opens) ? result.queued_opens : [];
  const pendingCloses = Array.isArray(result.pending_closes) ? result.pending_closes : [];
  const hasStaged = opening.length > 0 || queuedOpens.length > 0 || pendingCloses.length > 0;
  if (transEl && stepEl) {
    if (result.transitioning && result.transition_step) {
      transEl.style.display = '';
      const stepLabels = {
        pump_stop: 'Stopping pump...',
        valves_closing: 'Closing all valves...',
        valves_opening: 'Opening new valves...',
        pump_start: 'Starting pump...',
      };
      stepEl.textContent = stepLabels[result.transition_step] || result.transition_step;
    } else if (hasStaged) {
      transEl.style.display = '';
      stepEl.textContent = 'Staged valve transition in progress';
    } else {
      transEl.style.display = 'none';
    }
  }

  // ── Staged valve indicator (US5, 023-limit-valve-operations) ──
  const stagedInd = document.getElementById('staged-valve-indicator');
  if (stagedInd) {
    if (hasStaged) {
      stagedInd.style.display = '';
      stagedInd.textContent =
        'Transitioning — ' + opening.length + ' opening, ' +
        queuedOpens.length + ' queued, ' +
        pendingCloses.length + ' pending close';
    } else {
      stagedInd.style.display = 'none';
    }
  }

  // ── Staged valve detail pane (Device view) ──
  const stagedDetailCard = document.getElementById('staged-valve-detail-card');
  if (stagedDetailCard) {
    if (hasStaged) {
      stagedDetailCard.style.display = '';
      const nowSec = Math.floor(Date.now() / 1000);
      const openingEl = document.getElementById('staged-valve-detail-opening');
      const queuedEl = document.getElementById('staged-valve-detail-queued');
      const pendingEl = document.getElementById('staged-valve-detail-pending-close');
      if (openingEl) {
        openingEl.innerHTML = opening.length > 0
          ? '<div class="staged-valve-list-label">Opening now</div>' +
            opening.map(v => `<div class="staged-valve-row staged-valve-opening"><span class="staged-valve-name">${v}</span></div>`).join('')
          : '';
      }
      if (queuedEl) {
        queuedEl.innerHTML = queuedOpens.length > 0
          ? '<div class="staged-valve-list-label">Queued to open</div>' +
            queuedOpens.map(v => `<div class="staged-valve-row staged-valve-queued"><span class="staged-valve-name">${v}</span></div>`).join('')
          : '';
      }
      if (pendingEl) {
        pendingEl.innerHTML = pendingCloses.length > 0
          ? '<div class="staged-valve-list-label">Pending close (hold)</div>' +
            pendingCloses.map(pc => {
              const readyAt = pc.readyAt || 0;
              const remaining = Math.max(0, readyAt - nowSec);
              return `<div class="staged-valve-row staged-valve-pending-close"><span class="staged-valve-name">${pc.valve}</span><span class="staged-valve-countdown">${remaining}s</span></div>`;
            }).join('')
          : '';
      }
    } else {
      stagedDetailCard.style.display = 'none';
    }
  }

  // ── Controls indicator ──
  const ctrlInd = document.getElementById('controls-indicator');
  if (ctrlInd && result.controls_enabled !== undefined) {
    ctrlInd.classList.toggle('visible', !result.controls_enabled);
  }

  // ── Schematic ──
  lastState = state;
  lastResult = result;
  setLastLiveFrame(state, result);
  if (schematicHandle) {
    schematicHandle.update(toSchematicState(state, result));
  }

  // ── Graph ──
  // Live mode: each incoming state frame gets recorded so the
  // sliding window advances. Simulation mode records points
  // directly from simLoop(), so we don't duplicate them here.
  recordLiveHistoryPoint(state, result);
  appendBalanceLivePoint(state, result);
  drawHistoryGraph();
}

function updateComponent(id, on, onLabel, offLabel) {
  const el = document.getElementById(id);
  el.textContent = on ? onLabel : offLabel;
  el.className = 'component-value ' + (on ? 'component-value-active' : 'component-value-off');
}

// Append an incoming live state frame to the history store so the
// graph ticks forward in real time. Rate-limited to one sample
// every ~5 seconds to match the simulation recording cadence.
// Lives here (rather than in live-history.js) so display-update
// doesn't have to import from a module that itself needs our
// rerenderWithHistoryFallback — breaks the old cycle.
function recordLiveHistoryPoint(state, result) {
  if (store.get('phase') !== 'live') return;
  // result is consumed elsewhere (detectLiveTransition / displays); the
  // bar chart and the clipboard table now resolve mode via the
  // mode-events store, so this function only persists the temperatures.
  void result;
  const tSec = Math.floor(Date.now() / 1000);
  const vals = {
    t_tank_top: state.t_tank_top,
    t_tank_bottom: state.t_tank_bottom,
    t_collector: state.t_collector,
    t_greenhouse: state.t_greenhouse,
    t_outdoor: state.t_outdoor,
  };
  // trendStore has its own dedup-by-timestamp + age-based pruning, so
  // we feed it every frame — trendFor wants the freshest sample
  // available regardless of the graph cadence.
  trendStore.addPoint(tSec, vals);
  const last = timeSeriesStore.times.length - 1;
  if (last >= 0 && (tSec - timeSeriesStore.times[last]) < 5) return;
  timeSeriesStore.addPoint(tSec, vals);
}

// Re-render the Status/Components views after something refills the
// timeSeriesStore (currently the live-history fetch). Uses the most
// recent observed state when available; otherwise synthesizes a
// minimal state from the last history point so the gauge and sensor
// table show something immediately instead of "--".
export function rerenderWithHistoryFallback() {
  // Only trust lastState if it came from a real live frame. The
  // initial updateDisplay() call during init() seeds lastState with
  // the sim model defaults — using those in live mode before the
  // first WS frame would show (e.g.) a gauge of "11 °C" instead of
  // the freshly-loaded history.
  if (liveFrameSeen && lastState && lastResult) {
    updateDisplay(lastState, lastResult);
    return;
  }
  const n = timeSeriesStore.times.length;
  if (n === 0) return;
  const lastVals = timeSeriesStore.values[n - 1];
  const lastMode = modeAt(timeSeriesStore.times[n - 1]);
  const synth = {
    t_tank_top: lastVals.t_tank_top,
    t_tank_bottom: lastVals.t_tank_bottom,
    t_collector: lastVals.t_collector,
    t_greenhouse: lastVals.t_greenhouse,
    t_outdoor: lastVals.t_outdoor,
    simTime: 0,
  };
  const idleResult = {
    mode: lastMode,
    actuators: { pump: false, fan: false, space_heater: false },
    valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
    transition: null,
    // Marker so detectLiveTransition skips this. The mode here comes
    // from the freshest history point, not a live state push, so it
    // has no cause/reason/temps — feeding it through the change
    // detector produced log rows with empty reason/sensors lines that
    // only a manual reload could fix.
    synthetic: true,
  };
  updateDisplay(synth, idleResult);
}
