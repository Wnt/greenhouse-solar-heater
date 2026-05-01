// Copy System Logs — clipboard export. Builds a plain-text diagnostic
// snapshot. Sim mode: parameters + transition log entries (≤ 24 h sim
// time). Live mode: 24 h sensor readings at 20-min resolution + a
// controller-state section + transition log entries.

import { store } from '../app-state.js';
import {
  formatTimeOfDay, formatFullTimeHelsinki, formatConfigEntry,
  formatConfigSourceLabel, formatReasonLabel, formatOverlayEntry,
} from './time-format.js';
import { model, params, MODE_INFO, timeSeriesStore, transitionLog, lastLiveFrame } from './state.js';
import { getWatchdogSnapshot } from './watchdog-ui.js';
import { modeAt } from './mode-events.js';

export function setupCopyLogsButton() {
  const btn = document.getElementById('copy-logs-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const text = buildLogsClipboardText();
    navigator.clipboard.writeText(text).then(() => {
      btn.classList.add('copied');
      const icon = btn.querySelector('.material-symbols-outlined');
      if (icon) icon.textContent = 'check';
      setTimeout(() => {
        btn.classList.remove('copied');
        if (icon) icon.textContent = 'content_copy';
      }, 2000);
    });
  });
}

function buildLogsClipboardText() {
  const isLive = store.get('phase') === 'live';
  const lines = [];

  lines.push('=== Greenhouse Solar Heater — System Logs ===');
  lines.push('Mode: ' + (isLive ? 'Live' : 'Simulation'));
  lines.push('Exported: ' + formatFullTimeHelsinki(Date.now()));
  lines.push('');

  // Controller-state snapshot (live mode only — captures the evaluator-
  // visible flags / device config that gate mode transitions).
  if (isLive) appendControllerState(lines);

  if (isLive) {
    lines.push('--- Sensor Readings (24h, 20-min resolution) ---');
    lines.push('Time                  Collector  Tank Top  Tank Btm  Greenhouse  Outdoor  Mode');
    const readings = downsampleHistory(1200);
    for (let i = 0; i < readings.length; i++) {
      const r = readings[i];
      lines.push(
        formatFullTimeHelsinki(r.time * 1000) + '  ' +
        fmtTempCol(r.t_collector) + '  ' +
        fmtTempCol(r.t_tank_top) + '  ' +
        fmtTempCol(r.t_tank_bottom) + '  ' +
        fmtTempCol(r.t_greenhouse) + '  ' +
        fmtTempCol(r.t_outdoor) + '  ' +
        (r.mode || 'idle')
      );
    }
    if (readings.length === 0) lines.push('(no history data available)');
  } else {
    lines.push('--- Simulation Parameters ---');
    lines.push('Outdoor Temp:       ' + params.t_outdoor + ' °C');
    lines.push('Solar Irradiance:   ' + params.irradiance + ' W/m²');
    lines.push('Tank Top:           ' + params.t_tank_top + ' °C');
    lines.push('Tank Bottom:        ' + params.t_tank_bottom + ' °C');
    lines.push('Greenhouse:         ' + params.t_greenhouse + ' °C');
    lines.push('GH Thermal Mass:    ' + params.gh_thermal_mass + ' J/K');
    lines.push('GH Heat Loss:       ' + params.gh_heat_loss + ' W/K');
    lines.push('Sim Speed:          ' + params.sim_speed + '×');
    lines.push('Day/Night Cycle:    ' + (params.day_night_cycle ? 'on' : 'off'));
    if (model) {
      lines.push('Sim Time:           ' + formatTimeOfDay(model.state.simTime) +
        ' (' + Math.floor(model.state.simTime / 3600) + 'h ' +
        Math.floor((model.state.simTime % 3600) / 60) + 'm elapsed)');
    }
    lines.push('');

    lines.push('--- Sensor History (20-min resolution) ---');
    lines.push('SimTime   Collector  Tank Top  Tank Btm  Greenhouse  Outdoor  Mode');
    const readings = downsampleHistory(1200);
    for (let i = 0; i < readings.length; i++) {
      const r = readings[i];
      lines.push(
        formatTimeOfDay(r.time) + '     ' +
        fmtTempCol(r.t_collector) + '  ' +
        fmtTempCol(r.t_tank_top) + '  ' +
        fmtTempCol(r.t_tank_bottom) + '  ' +
        fmtTempCol(r.t_greenhouse) + '  ' +
        fmtTempCol(r.t_outdoor) + '  ' +
        (r.mode || 'idle')
      );
    }
    if (readings.length === 0) lines.push('(no history data available)');
  }

  lines.push('');

  lines.push('--- Transition Log ---');
  if (transitionLog.length === 0) {
    lines.push('(no transitions recorded)');
  } else {
    for (let i = 0; i < transitionLog.length; i++) {
      const t = transitionLog[i];
      const timeLabel = t.kind === 'live'
        ? formatFullTimeHelsinki(t.ts)
        : formatTimeOfDay(t.time);

      // Config events get a one-line "Config: <title>" entry. Without the
      // dedicated branch they'd fall through to the mode-row formatter
      // and render as bare "Idle" lines (regression PR #—).
      if (t.eventType === 'config') {
        const fmt = formatConfigEntry(t);
        lines.push(timeLabel + '  Config  ' + fmt.title + '  [config: ' + (t.source || 'unknown') + ']');
        const subtitle = t.actor
          ? formatConfigSourceLabel(t.source) + ' by ' + t.actor
          : formatConfigSourceLabel(t.source);
        lines.push('    source: ' + subtitle);
        continue;
      }

      if (t.eventType === 'overlay') {
        const fmt = formatOverlayEntry(t);
        lines.push(timeLabel + '  Overlay  ' + fmt.title + '  [overlay: ' + (t.overlayId || 'unknown') + ']');
        lines.push('    detail: ' + fmt.desc);
        continue;
      }

      const mi = MODE_INFO[t.mode] || MODE_INFO.idle;
      let causeSuffix = '';
      if (t.cause && t.reason) causeSuffix = '  [' + t.cause + ': ' + t.reason + ']';
      else if (t.cause) causeSuffix = '  [' + t.cause + ']';
      else if (t.reason) causeSuffix = '  [' + t.reason + ']';
      lines.push(timeLabel + '  ' + mi.label + '  ' + (t.text || '') + causeSuffix);
      if (t.reason) lines.push('    reason: ' + formatReasonLabel(t.reason));
      if (t.sensors) {
        const s = t.sensors;
        const fmt = (v) => (typeof v === 'number' ? v.toFixed(1) + '°C' : '—');
        lines.push('    sensors: collector=' + fmt(s.collector) +
                   ' tank=' + fmt(s.tank_top) + '/' + fmt(s.tank_bottom) +
                   ' greenhouse=' + fmt(s.greenhouse) +
                   ' outdoor=' + fmt(s.outdoor));
      }
    }
  }

  return lines.join('\n');
}

// Mirrors deviceConfig.ea (server/lib/device-config.js). Bit order, not alphabetical.
const EA_BITS = [
  { bit: 1,  name: 'valves' },
  { bit: 2,  name: 'pump' },
  { bit: 4,  name: 'fan' },
  { bit: 8,  name: 'space_heater' },
  { bit: 16, name: 'immersion_heater' },
];

function formatEnabledActuators(ea) {
  if (typeof ea !== 'number') return '(unknown)';
  const on = EA_BITS.filter(b => (ea & b.bit) !== 0).map(b => b.name);
  return (on.length ? on.join(', ') : 'none') + ' (ea=' + ea + ')';
}

function formatBanList(wb, nowSec) {
  const PERMANENT = 9999999999;
  const out = [];
  Object.keys(wb || {}).forEach(code => {
    const until = wb[code];
    if (typeof until !== 'number' || until <= nowSec) return;
    if (until === PERMANENT) {
      out.push(code + '=disabled');
    } else {
      const rem = until - nowSec;
      const h = Math.floor(rem / 3600);
      const m = Math.floor((rem % 3600) / 60);
      out.push(code + '=' + h + 'h' + (m < 10 ? '0' : '') + m + 'm');
    }
  });
  return out.length ? out.join(' ') : 'none';
}

function formatWatchdogEnabled(we) {
  const on = Object.keys(we || {}).filter(id => we[id]);
  return on.length ? on.join(', ') : 'none';
}

function formatWatchdogSnoozed(wz, nowSec) {
  const out = [];
  Object.keys(wz || {}).forEach(id => {
    const until = wz[id];
    if (typeof until !== 'number' || until <= nowSec) return;
    out.push(id + '=' + Math.floor((until - nowSec) / 60) + 'm');
  });
  return out.length ? out.join(' ') : 'none';
}

function appendControllerState(lines) {
  const result = (lastLiveFrame && lastLiveFrame.result) || null;
  const snap = getWatchdogSnapshot() || {};
  const nowSec = Math.floor(Date.now() / 1000);

  lines.push('--- Controller State ---');
  if (!result && !snap.v) {
    lines.push('(no live snapshot received yet)');
    lines.push('');
    return;
  }

  const flags = (result && result.flags) || {};
  lines.push('Mode:               ' + ((result && result.mode) || 'idle'));
  lines.push('Collectors drained: ' + (flags.collectors_drained ? 'yes' : 'no'));
  lines.push('Emergency heating:  ' + (flags.emergency_heating_active ? 'on' : 'off'));
  lines.push('Fan cooling:        ' + (flags.greenhouse_fan_cooling_active ? 'on' : 'off'));
  lines.push('Controls enabled:   ' + (snap.ce ? 'yes' : 'no'));
  lines.push('Enabled actuators:  ' + formatEnabledActuators(snap.ea));

  const mo = snap.mo;
  if (mo && mo.a) {
    const exp = mo.ex ? formatFullTimeHelsinki(mo.ex * 1000) : '—';
    lines.push('Manual override:    ' + (mo.fm || 'active') + ' (until ' + exp + ')');
  } else {
    lines.push('Manual override:    off');
  }

  lines.push('Watchdogs enabled:  ' + formatWatchdogEnabled(snap.we));
  lines.push('Watchdogs snoozed:  ' + formatWatchdogSnoozed(snap.wz, nowSec));
  lines.push('Mode bans (wb):     ' + formatBanList(snap.wb, nowSec));
  lines.push('Config version:     ' + (typeof snap.v === 'number' ? snap.v : '(unknown)'));
  lines.push('');
}

function fmtTempCol(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return '    —   ';
  return String(v.toFixed(1)).padStart(8);
}

// Down-sample timeSeriesStore to a given interval (in seconds). Mode is
// resolved against mode-events (single source of truth) so the table
// column matches the bar chart and the transition log.
function downsampleHistory(intervalSec) {
  const out = [];
  if (timeSeriesStore.times.length === 0) return out;

  let nextBucket = timeSeriesStore.times[0];
  for (let i = 0; i < timeSeriesStore.times.length; i++) {
    if (timeSeriesStore.times[i] >= nextBucket) {
      const v = timeSeriesStore.values[i];
      const t = timeSeriesStore.times[i];
      out.push({
        time: t,
        t_collector: v.t_collector,
        t_tank_top: v.t_tank_top,
        t_tank_bottom: v.t_tank_bottom,
        t_greenhouse: v.t_greenhouse,
        t_outdoor: v.t_outdoor,
        mode: modeAt(t),
      });
      nextBucket = t + intervalSec;
    }
  }
  return out;
}

window.__buildLogsClipboardText = function () { return buildLogsClipboardText(); };
