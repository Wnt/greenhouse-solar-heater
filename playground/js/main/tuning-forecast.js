// Forecast preview for the device-view Tuning thresholds section.
//
// Runs the real thermal model + control logic forward 24 h from the
// latest live sensor readings, once for the values typed into the
// tuning form and once for the values currently saved on the
// controller, and draws both trajectories on a canvas so the operator
// can see what a threshold change does before pushing it.
//
// External API:
//   initTuningForecast()        — wire view/resize triggers (call once at boot).
//   setForecastBaseline(tu)     — set the saved-on-controller tuning map.
//   setForecastEntered(tu)      — set the typed-into-form tuning map.
// Both setters schedule a debounced redraw.

import { store } from '../app-state.js';
import { ThermalModel } from '../physics.js';
import { ControlStateMachine } from '../control.js';
import { SIM_START_HOUR, getDayNightEnv } from '../sim-bootstrap.js';
import { model, lastLiveFrame, timeSeriesStore } from './state.js';

// 24 h projection at a 30 s integration step. The control logic's
// timers are all minutes-scale, so 30 s resolves every transition;
// finer steps only cost compute on the debounced live-recompute.
const HORIZON_SEC = 24 * 3600;
const DT = 30;
// Representative clear-day peak irradiance (W/m²) — matches the
// simulator's default so the forecast curve reads like the live sim.
const PEAK_IRRADIANCE = 500;

// Series colours mirror the main history graph.
const COLORS = {
  tank: '#e9c349', collector: '#ef5350', greenhouse: '#69d0c5', outdoor: '#42a5f5',
};

let _baselineTu = {};   // tuning saved on the controller (dashed lines)
let _enteredTu = {};    // tuning typed into the form (solid lines)
let _timer = null;

// ── Public API ───────────────────────────────────────────────────────────────

export function initTuningForecast() {
  store.subscribe('currentView', () => {
    if (store.get('currentView') === 'device') scheduleRender();
  });
  window.addEventListener('resize', () => {
    if (store.get('currentView') === 'device') scheduleRender();
  });
}

export function setForecastBaseline(tu) {
  _baselineTu = tu || {};
  scheduleRender();
}

export function setForecastEntered(tu) {
  _enteredTu = tu || {};
  scheduleRender();
}

// ── Render orchestration ─────────────────────────────────────────────────────

function scheduleRender() {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => { _timer = null; renderTuningForecast(); }, 200);
}

function renderTuningForecast() {
  const canvas = document.getElementById('tuning-forecast-chart');
  const statusEl = document.getElementById('tuning-forecast-status');
  if (!canvas) return;
  // Skip while the device view is hidden: a display:none canvas has no
  // layout size. The currentView subscription redraws on entry.
  if (canvas.offsetWidth === 0) return;

  const readings = currentReadings();
  if (!readings) {
    clearCanvas(canvas);
    setStatus(statusEl,
      'Waiting for live readings — the forecast appears once the controller reports sensor data.');
    return;
  }

  let entered, baseline;
  try {
    entered = runForecast(readings, _enteredTu);
    baseline = runForecast(readings, _baselineTu);
  } catch (err) {
    clearCanvas(canvas);
    setStatus(statusEl, 'Forecast unavailable: ' + err.message);
    return;
  }
  setStatus(statusEl, '');
  draw(canvas, entered, baseline);
}

// ── Simulation ───────────────────────────────────────────────────────────────

// Latest valid sensor snapshot to seed the simulation from. Prefers the
// freshest live frame; falls back to the newest history sample. Returns
// null when no frame has all five temperatures as finite numbers.
function currentReadings() {
  const candidates = [];
  if (lastLiveFrame && lastLiveFrame.state) candidates.push(lastLiveFrame.state);
  const n = timeSeriesStore.times.length;
  if (n > 0) candidates.push(timeSeriesStore.values[n - 1]);
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const r = {
      t_tank_top: c.t_tank_top,
      t_tank_bottom: c.t_tank_bottom,
      t_collector: c.t_collector,
      t_greenhouse: c.t_greenhouse,
      t_outdoor: c.t_outdoor,
    };
    let ok = true;
    for (const k in r) {
      if (typeof r[k] !== 'number' || !isFinite(r[k])) { ok = false; break; }
    }
    if (ok) return r;
  }
  return null;
}

// Synthetic day/night environment shifted so sim-time 0 maps to the
// current hour-of-day, with the outdoor curve's base picked so it is
// continuous with the latest outdoor reading.
function makeEnv(currentOutdoor) {
  const now = new Date();
  const currentHour = now.getHours() + now.getMinutes() / 60;
  const offsetSec = (currentHour - SIM_START_HOUR) * 3600;
  const baseOutdoor = currentOutdoor - 5 * Math.cos((currentHour - 15) / 24 * 2 * Math.PI);
  return function (simTime) {
    return getDayNightEnv(simTime + offsetSec, baseOutdoor, PEAK_IRRADIANCE);
  };
}

// Run the model + control logic forward HORIZON_SEC from `initial`,
// applying `tu` as a tuning overlay. ce/ea are forced fully-enabled so
// the forecast isolates the effect of the thresholds themselves rather
// than the actuator-enable mask.
function runForecast(initial, tu) {
  const m = new ThermalModel(model && model.p ? model.p : undefined);
  m.reset({
    t_tank_top: initial.t_tank_top,
    t_tank_bottom: initial.t_tank_bottom,
    t_collector: initial.t_collector,
    t_greenhouse: initial.t_greenhouse,
    t_outdoor: initial.t_outdoor,
  });
  const ctrl = new ControlStateMachine(null, { ce: true, ea: 31, tu: tu || {} });
  const getEnv = makeEnv(initial.t_outdoor);
  const points = [];
  const steps = Math.floor(HORIZON_SEC / DT);
  for (let i = 0; i < steps; i++) {
    const env = getEnv(m.state.simTime);
    const sensors = {
      t_collector: m.state.t_collector,
      t_tank_top: m.state.t_tank_top,
      t_tank_bottom: m.state.t_tank_bottom,
      t_greenhouse: m.state.t_greenhouse,
      t_outdoor: m.state.t_outdoor,
    };
    const result = ctrl.evaluate(sensors, m.state.simTime);
    m.step(DT, env, result.actuators, result.mode);
    points.push({
      t: m.state.simTime,
      tank: (m.state.t_tank_top + m.state.t_tank_bottom) / 2,
      collector: m.state.t_collector,
      greenhouse: m.state.t_greenhouse,
      outdoor: m.state.t_outdoor,
    });
  }
  return points;
}

// ── Canvas rendering ─────────────────────────────────────────────────────────

function clearCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const dw = canvas.offsetWidth;
  const dh = canvas.offsetHeight;
  canvas.width = dw * dpr;
  canvas.height = dh * dpr;
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

function setStatus(el, text) {
  if (el) el.textContent = text;
}

function draw(canvas, entered, baseline) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const dw = canvas.offsetWidth;
  const dh = canvas.offsetHeight;
  canvas.width = dw * dpr;
  canvas.height = dh * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, dw, dh);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const pad = { top: 12, right: 12, bottom: 22, left: 34 };
  const pw = dw - pad.left - pad.right;
  const ph = dh - pad.top - pad.bottom;
  if (pw <= 0 || ph <= 0) return;

  // Y range spans both runs, padded and snapped to 5° steps.
  let lo = Infinity;
  let hi = -Infinity;
  const runs = [entered, baseline];
  for (let r = 0; r < runs.length; r++) {
    const pts = runs[r];
    for (let i = 0; i < pts.length; i++) {
      const vals = [pts[i].tank, pts[i].collector, pts[i].greenhouse, pts[i].outdoor];
      for (let k = 0; k < 4; k++) {
        if (vals[k] < lo) lo = vals[k];
        if (vals[k] > hi) hi = vals[k];
      }
    }
  }
  if (!isFinite(lo) || !isFinite(hi)) return;
  if (hi - lo < 10) hi = lo + 10;
  const span = hi - lo;
  const yMin = Math.floor((lo - span * 0.08) / 5) * 5;
  const yMax = Math.ceil((hi + span * 0.08) / 5) * 5;

  // Grid lines + Y-axis labels.
  ctx.font = '10px Manrope, sans-serif';
  ctx.fillStyle = '#a5abb9';
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const frac = i / 4;
    const y = pad.top + ph - frac * ph;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + pw, y);
    ctx.stroke();
    ctx.fillText(Math.round(yMin + frac * (yMax - yMin)) + '°', pad.left - 4, y);
  }

  // X-axis labels — hour-of-day every 6 h from "now".
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const now = new Date();
  const startHour = now.getHours() + now.getMinutes() / 60;
  for (let h = 0; h <= 24; h += 6) {
    const x = pad.left + (h / 24) * pw;
    const tod = Math.floor((startHour + h) % 24);
    ctx.fillText((tod < 10 ? '0' : '') + tod + ':00', x, dh - 6);
  }

  const xOf = function (t) { return pad.left + (t / HORIZON_SEC) * pw; };
  const yOf = function (v) { return pad.top + ph - ((v - yMin) / (yMax - yMin)) * ph; };

  const series = [
    { key: 'outdoor', color: COLORS.outdoor, width: 1 },
    { key: 'collector', color: COLORS.collector, width: 1.5 },
    { key: 'greenhouse', color: COLORS.greenhouse, width: 1.5 },
    { key: 'tank', color: COLORS.tank, width: 2 },
  ];
  // Baseline first (dashed, faint) so the entered (solid) lines sit on top.
  // Outdoor is environment-driven and identical for both runs — drawn once.
  for (let s = 0; s < series.length; s++) {
    if (series[s].key === 'outdoor') continue;
    drawLine(ctx, baseline, series[s].key, xOf, yOf, series[s].color, series[s].width, true);
  }
  for (let s = 0; s < series.length; s++) {
    drawLine(ctx, entered, series[s].key, xOf, yOf, series[s].color, series[s].width, false);
  }
}

function drawLine(ctx, pts, key, xOf, yOf, color, width, dashed) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = dashed ? 0.4 : 0.95;
  if (dashed) ctx.setLineDash([4, 3]);
  ctx.moveTo(xOf(pts[0].t), yOf(pts[0][key]));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(xOf(pts[i].t), yOf(pts[i][key]));
  ctx.stroke();
  ctx.restore();
}
