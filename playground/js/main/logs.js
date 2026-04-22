// System Logs UI — live-events pagination, transition detection,
// render + clipboard export. Extracted from main.js.
//
// transitionLog lives in state.js (shared array, many writers).
// Re-exported from here for back-compat with existing importers in
// main.js — they can keep importing `transitionLog` from logs.js.

import { store } from '../app-state.js';
import {
  formatClockTime, formatFullTimeHelsinki, formatCauseLabel,
  formatReasonLabel, formatSensorsLine, escapeHtml, formatTimeOfDay,
} from './time-format.js';
import { model, params, MODE_INFO, timeSeriesStore, transitionLog } from './state.js';

export { transitionLog };

const EVENTS_PAGE_SIZE = 10;
let eventsCursor = null;   // ms timestamp of oldest entry currently shown
let eventsHasMore = false; // true if the DB has older entries to load
let eventsLoading = false; // in-flight guard
let lastLiveMode = null;   // last observed live mode (change detector)

// Drop pagination + mode-change state. Called when the mode-switch UI
// clears the live display; fetchLiveEvents(null) will repopulate.
export function resetEventsState() {
  eventsCursor = null;
  eventsHasMore = false;
  lastLiveMode = null;
}

// Fetch the next page of mode-transition events from the DB. When `before`
// is null this is a fresh load (replaces the log); otherwise appended.
export function fetchLiveEvents(before) {
  if (store.get('phase') !== 'live') return;
  if (eventsLoading) return;
  eventsLoading = true;

  let url = '/api/events?type=mode&limit=' + EVENTS_PAGE_SIZE;
  if (before !== null && before !== undefined) url += '&before=' + before;

  fetch(url)
    .then(r => r.json())
    .then(data => {
      // Only apply to the current phase — the user may have switched back
      // to simulation while the request was in flight.
      if (store.get('phase') !== 'live') return;
      const events = (data && Array.isArray(data.events)) ? data.events : [];
      if (before === null) {
        // First load: replace everything
        transitionLog.length = 0;
      }
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        transitionLog.push({
          kind: 'live',
          ts: e.ts,
          mode: e.to,
          from: e.from,
          text: formatLiveTransitionText(e.from, e.to),
          // cause/sensors may be null for pre-2026-04-20 rows or for
          // firmware that doesn't yet carry the transition cause.
          // reason (added 2026-04-21) is the evaluator's decision code;
          // null when the transition did not come from evaluate().
          cause: e.cause || null,
          reason: e.reason || null,
          sensors: e.sensors || null,
        });
      }
      if (events.length > 0) {
        eventsCursor = events[events.length - 1].ts;
      }
      eventsHasMore = !!(data && data.hasMore);
      renderLogsList();
    })
    .catch(() => {
      // Silent fail — leave whatever is already rendered
    })
    .then(() => { eventsLoading = false; });
}

function formatLiveTransitionText(from, to) {
  const fromLabel = (from && MODE_INFO[from]) ? MODE_INFO[from].label : (from || '—');
  const toLabel = (to && MODE_INFO[to]) ? MODE_INFO[to].label : (to || '—');
  return fromLabel + ' → ' + toLabel;
}

// Detect client-side mode changes from incoming live state frames and
// prepend synthetic log entries. The server also persists these to the DB,
// so a subsequent refresh will replay the same transitions.
export function detectLiveTransition(result) {
  if (store.get('phase') !== 'live') return;
  const mode = result && result.mode;
  if (!mode) return;
  if (lastLiveMode === null) {
    lastLiveMode = mode;
    return;
  }
  if (lastLiveMode === mode) return;
  transitionLog.unshift({
    kind: 'live',
    ts: Date.now(),
    mode: mode,
    from: lastLiveMode,
    text: formatLiveTransitionText(lastLiveMode, mode),
    // Carry cause + reason + temps through from the state payload so the
    // log can show them immediately, without waiting for a /api/events
    // round-trip.
    cause: (result && result.cause) || null,
    reason: (result && result.reason) || null,
    sensors: (result && result.temps) ? Object.assign({}, result.temps) : null,
  });
  lastLiveMode = mode;
  renderLogsList();
}

// Render the transition log into the #logs-list container. Handles both
// simulation-time and wall-clock entries. In live mode we also render a
// trailing "Load more" sentinel which the scroll handler uses to lazy-load.
export function renderLogsList() {
  const container = document.getElementById('logs-list');
  if (!container) return;
  const isLive = store.get('phase') === 'live';

  if (transitionLog.length === 0) {
    const isSim = store.get('phase') === 'simulation';
    container.innerHTML = '<div data-empty="true" style="color:var(--on-surface-variant);font-size:13px;">' +
      (isSim ? 'No transitions yet. Start the simulation.' : 'No transitions yet. Awaiting controller activity…') +
      '</div>';
    return;
  }

  // Sim mode caps at 20 rendered rows to mirror the pre-existing behavior.
  // Live mode renders all fetched rows — the DB-backed list is bounded by
  // how many pages the user has scrolled through.
  const visible = isLive ? transitionLog : transitionLog.slice(0, 20);

  let html = '';
  for (let i = 0; i < visible.length; i++) {
    const t = visible[i];
    const mi = MODE_INFO[t.mode] || MODE_INFO.idle;
    const dotClass = t.mode === 'solar_charging' || t.mode === 'active_drain' ? 'log-dot-charging'
      : t.mode === 'greenhouse_heating' ? 'log-dot-heating'
      : t.mode === 'emergency_heating' ? 'log-dot-emergency' : 'log-dot-muted';
    const timeLabel = t.kind === 'live' ? formatClockTime(t.ts) : formatTimeOfDay(t.time);
    const causeChip = t.cause ? ' <span class="log-cause">' + escapeHtml(formatCauseLabel(t.cause)) + '</span>' : '';
    // reason sits on its own line so operators can skim the cause chip
    // row and dive into the decision code only when needed.
    const reasonLine = t.reason
      ? '<div class="log-reason">' + escapeHtml(formatReasonLabel(t.reason)) + '</div>'
      : '';
    const sensorsLine = t.sensors ? '<div class="log-sensors">' + formatSensorsLine(t.sensors) + '</div>' : '';
    html += '<div class="log-item">' +
      '<div class="log-dot ' + dotClass + '"></div>' +
      '<div class="log-content">' +
        '<div class="log-title">' + escapeHtml(mi.label) + causeChip + '</div>' +
        '<div class="log-desc">' + escapeHtml(t.text || '') + '</div>' +
        reasonLine +
        sensorsLine +
      '</div>' +
      '<div class="log-time">' + timeLabel + '</div>' +
    '</div>';
  }

  if (isLive && eventsHasMore) {
    html += '<div class="log-loading" data-log-loading="true" style="color:var(--on-surface-variant);font-size:12px;text-align:center;padding:8px 0;">' +
      (eventsLoading ? 'Loading older transitions…' : 'Scroll to load older transitions') +
    '</div>';
  }

  container.innerHTML = html;
}

// Attach a one-time scroll listener that lazy-loads older events when the
// user reaches the bottom of the System Logs card.
export function setupLogsScrollLoader() {
  const container = document.getElementById('logs-list');
  if (!container || container._scrollHandlerAttached) return;
  container._scrollHandlerAttached = true;
  container.addEventListener('scroll', function () {
    if (store.get('phase') !== 'live') return;
    if (!eventsHasMore || eventsLoading || eventsCursor === null) return;
    // Trigger when the scroll reaches within 40px of the bottom
    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (remaining < 40) {
      fetchLiveEvents(eventsCursor);
    }
  });
}

// ── Copy System Logs ──
// Builds a plain-text diagnostic snapshot of the system and copies it to
// the clipboard. Sim mode: all sim parameters + transition log entries
// (up to 24h sim time). Live mode: sensor readings at 20-min resolution
// for the past 24h + transition log entries.
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

  // Header
  lines.push('=== Greenhouse Solar Heater — System Logs ===');
  lines.push('Mode: ' + (isLive ? 'Live' : 'Simulation'));
  lines.push('Exported: ' + new Date().toISOString());
  lines.push('');

  if (isLive) {
    // Live: include 24h sensor readings at 20-min resolution from timeSeriesStore
    lines.push('--- Sensor Readings (24h, 20-min resolution) ---');
    lines.push('Time                  Collector  Tank Top  Tank Btm  Greenhouse  Outdoor  Mode');
    const readings = downsampleHistory(1200); // 20 minutes = 1200 seconds
    for (let i = 0; i < readings.length; i++) {
      const r = readings[i];
      const ts = new Date(r.time * 1000).toISOString().replace('T', ' ').slice(0, 19);
      lines.push(
        ts + '  ' +
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
    // Simulation: include all parameters
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

    // Simulation: include sensor history at 20-min sim-time resolution
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

  // Transition log — all entries. Live rows include the sim-time
  // timestamp in Europe/Helsinki, the cause that drove the transition
  // (when the device reported one), and the sensor snapshot captured
  // at the moment of the transition.
  lines.push('--- Transition Log ---');
  if (transitionLog.length === 0) {
    lines.push('(no transitions recorded)');
  } else {
    for (let i = 0; i < transitionLog.length; i++) {
      const t = transitionLog[i];
      const mi = MODE_INFO[t.mode] || MODE_INFO.idle;
      const timeLabel = t.kind === 'live'
        ? formatFullTimeHelsinki(t.ts)
        : formatTimeOfDay(t.time);
      // Header row carries cause and, when present, the evaluator's
      // decision code in the form `[cause: reason]` so `grep` on a
      // single bracketed pair still matches the cause.
      let causeSuffix = '';
      if (t.cause && t.reason) causeSuffix = '  [' + t.cause + ': ' + t.reason + ']';
      else if (t.cause) causeSuffix = '  [' + t.cause + ']';
      else if (t.reason) causeSuffix = '  [' + t.reason + ']';
      lines.push(timeLabel + '  ' + mi.label + '  ' + (t.text || '') + causeSuffix);
      if (t.reason) {
        lines.push('    reason: ' + formatReasonLabel(t.reason));
      }
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

// Format a temperature value as a right-aligned string for the clipboard table.
function fmtTempCol(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return '    —   ';
  return String(v.toFixed(1)).padStart(8);
}

// Down-sample timeSeriesStore to a given interval (in seconds).
// Returns an array of { time, t_collector, t_tank_top, t_tank_bottom, t_greenhouse, t_outdoor, mode }.
function downsampleHistory(intervalSec) {
  const out = [];
  if (timeSeriesStore.times.length === 0) return out;

  // Walk through the store, picking one sample per interval bucket
  let nextBucket = timeSeriesStore.times[0];
  for (let i = 0; i < timeSeriesStore.times.length; i++) {
    if (timeSeriesStore.times[i] >= nextBucket) {
      const v = timeSeriesStore.values[i];
      out.push({
        time: timeSeriesStore.times[i],
        t_collector: v.t_collector,
        t_tank_top: v.t_tank_top,
        t_tank_bottom: v.t_tank_bottom,
        t_greenhouse: v.t_greenhouse,
        t_outdoor: v.t_outdoor,
        mode: timeSeriesStore.modes[i],
      });
      nextBucket = timeSeriesStore.times[i] + intervalSec;
    }
  }
  return out;
}

// Expose for testing
window.__buildLogsClipboardText = function () { return buildLogsClipboardText(); };
