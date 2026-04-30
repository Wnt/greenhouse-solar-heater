// System Logs UI — live-events pagination, transition detection,
// render + clipboard export. transitionLog lives in state.js (shared
// array, many writers); re-exported here so existing importers don't
// have to change.

import { store } from '../app-state.js';
import { registerDataSource } from '../sync/registry.js';
import {
  formatClockTime, formatFullTimeHelsinki, formatCauseLabel,
  formatReasonLabel, formatSensorsLine, escapeHtml, formatTimeOfDay,
  formatConfigEntry, formatConfigSourceLabel,
} from './time-format.js';
import { model, params, MODE_INFO, timeSeriesStore, transitionLog, lastLiveFrame } from './state.js';
import { getWatchdogSnapshot } from './watchdog-ui.js';
import { modeAt, appendModeEvent } from './mode-events.js';

export { transitionLog };

const EVENTS_PAGE_SIZE = 10;
// Parallel cursors so config and mode pages scroll independently —
// a long quiet stretch on one feed shouldn't block the other.
let modeCursor = null;
let modeHasMore = false;
let configCursor = null;
let configHasMore = false;
let eventsLoading = false; // in-flight guard for either side
let lastLiveMode = null;   // last observed live mode (change detector)

// Drop pagination + mode-change state. fetchLiveEvents(null) repopulates.
export function resetEventsState() {
  modeCursor = null;
  modeHasMore = false;
  configCursor = null;
  configHasMore = false;
  lastLiveMode = null;
}

function fetchEventPage(type, before, signal) {
  let url = '/api/events?type=' + type + '&limit=' + EVENTS_PAGE_SIZE;
  if (before !== null && before !== undefined) url += '&before=' + before;
  const opts = signal ? { signal } : undefined;
  return fetch(url, opts)
    .then(r => r.ok ? r.json() : { events: [], hasMore: false })
    .catch((e) => {
      // Re-throw aborts so the sync coordinator's catch branch handles
      // them and skips applyToStore; swallow everything else (network
      // blips, etc.) so the existing scroll-loader keeps quietly
      // retrying on the next page.
      if (e && e.name === 'AbortError') throw e;
      return { events: [], hasMore: false };
    });
}

function modeRowToLogEntry(e) {
  return {
    kind: 'live',
    eventType: 'mode',
    ts: e.ts,
    mode: e.to,
    from: e.from,
    text: formatLiveTransitionText(e.from, e.to),
    cause: e.cause || null,
    reason: e.reason || null,
    sensors: e.sensors || null,
  };
}

function configRowToLogEntry(e) {
  return {
    kind: 'live',
    eventType: 'config',
    ts: e.ts,
    configKind: e.kind,
    configKey: e.key,
    from: e.from,
    to: e.to,
    source: e.source,
    actor: e.actor,
  };
}

// Apply a paged fetch result into transitionLog + cursor state. Pulled
// out of fetchLiveEvents so the sync-coordinator data source can reuse
// the same write path on Android resume. `_skipped` data carries no
// fresh rows or pagination info, so its cursor branch no-ops.
function applyEventPages(modeData, configData, isReset) {
  // Only apply to the current phase — the user may have switched back
  // to simulation while the requests were in flight.
  if (store.get('phase') !== 'live') return;
  const modeEvents = (modeData && Array.isArray(modeData.events)) ? modeData.events : [];
  const configEvents = (configData && Array.isArray(configData.events)) ? configData.events : [];

  if (isReset) transitionLog.length = 0;

  for (let i = 0; i < modeEvents.length; i++) {
    transitionLog.push(modeRowToLogEntry(modeEvents[i]));
  }
  for (let i = 0; i < configEvents.length; i++) {
    transitionLog.push(configRowToLogEntry(configEvents[i]));
  }
  // Re-sort the merged list newest-first. Stable enough for our N (~20).
  transitionLog.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  if (!modeData._skipped) {
    if (modeEvents.length > 0) modeCursor = modeEvents[modeEvents.length - 1].ts;
    modeHasMore = !!(modeData && modeData.hasMore);
  }
  if (!configData._skipped) {
    if (configEvents.length > 0) configCursor = configEvents[configEvents.length - 1].ts;
    configHasMore = !!(configData && configData.hasMore);
  }

  renderLogsList();
}

// Fetch the next page of events. `reset` true clears the log and
// fetches both feeds afresh; otherwise advances each feed's cursor
// independently and appends to the existing list. Sorting by ts DESC
// happens once after both fetches return.
export function fetchLiveEvents(reset) {
  if (store.get('phase') !== 'live') return;
  if (eventsLoading) return;
  eventsLoading = true;

  const isReset = reset === null || reset === undefined || reset === true;
  const modeBefore = isReset ? null : (modeHasMore ? modeCursor : null);
  const configBefore = isReset ? null : (configHasMore ? configCursor : null);

  // Skip a side that has no more rows AND it isn't a reset, to avoid
  // re-fetching identical pages.
  const modePromise = (isReset || modeHasMore)
    ? fetchEventPage('mode', modeBefore)
    : Promise.resolve({ events: [], hasMore: false, _skipped: true });
  const configPromise = (isReset || configHasMore)
    ? fetchEventPage('config', configBefore)
    : Promise.resolve({ events: [], hasMore: false, _skipped: true });

  Promise.all([modePromise, configPromise])
    .then(([modeData, configData]) => applyEventPages(modeData, configData, isReset))
    .then(() => { eventsLoading = false; });
}

function formatLiveTransitionText(from, to) {
  const fromLabel = (from && MODE_INFO[from]) ? MODE_INFO[from].label : (from || '—');
  const toLabel = (to && MODE_INFO[to]) ? MODE_INFO[to].label : (to || '—');
  return fromLabel + ' → ' + toLabel;
}

function renderConfigEntry(t, timeLabel) {
  const fmt = formatConfigEntry(t);
  // Use a neutral muted dot for config edits — they aren't mode
  // transitions, so the green/orange/red mode-color palette would be
  // misleading.
  return '<div class="log-item">' +
    '<div class="log-dot log-dot-muted"></div>' +
    '<div class="log-content">' +
      '<div class="log-title">' + escapeHtml(fmt.title) + '</div>' +
      '<div class="log-desc">' + escapeHtml(fmt.desc) + '</div>' +
    '</div>' +
    '<div class="log-time">' + timeLabel + '</div>' +
  '</div>';
}

// Detect client-side mode changes from incoming live state frames and
// prepend synthetic log entries. The server also persists these to the DB,
// so a subsequent refresh will replay the same transitions.
export function detectLiveTransition(result) {
  if (store.get('phase') !== 'live') return;
  // Synthetic renders from rerenderWithHistoryFallback carry a mode
  // taken from the latest history point, not a live state push, and
  // lack cause/reason/temps. Skip them entirely (don't even update
  // lastLiveMode) so the next real WS frame can detect the transition
  // with full metadata. Without this guard the resync path was
  // prepending a partial row that only a manual reload could repair.
  if (result && result.synthetic) return;
  const mode = result && result.mode;
  if (!mode) return;
  if (lastLiveMode === null) {
    lastLiveMode = mode;
    return;
  }
  if (lastLiveMode === mode) return;
  const tsMs = Date.now();
  transitionLog.unshift({
    kind: 'live',
    eventType: 'mode',
    ts: tsMs,
    mode,
    from: lastLiveMode,
    text: formatLiveTransitionText(lastLiveMode, mode),
    // Carry cause + reason + temps through from the state payload so the
    // log can show them immediately, without waiting for a /api/events
    // round-trip.
    cause: (result && result.cause) || null,
    reason: (result && result.reason) || null,
    sensors: (result && result.temps) ? Object.assign({}, result.temps) : null,
  });
  // Mirror into the mode-events store (in seconds, matching the bar
  // renderer's time base) so the duty-cycle bars reflect the new mode
  // immediately — without waiting for the next /api/history round-trip.
  appendModeEvent({
    ts: Math.floor(tsMs / 1000),
    type: 'mode',
    from: lastLiveMode,
    to: mode,
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
    const timeLabel = t.kind === 'live' ? formatClockTime(t.ts) : formatTimeOfDay(t.time);

    if (t.eventType === 'config') {
      html += renderConfigEntry(t, timeLabel);
      continue;
    }

    const mi = MODE_INFO[t.mode] || MODE_INFO.idle;
    const dotClass = t.mode === 'solar_charging' || t.mode === 'active_drain' ? 'log-dot-charging'
      : t.mode === 'greenhouse_heating' ? 'log-dot-heating'
      : t.mode === 'emergency_heating' ? 'log-dot-emergency' : 'log-dot-muted';
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

  if (isLive && (modeHasMore || configHasMore)) {
    html += '<div class="log-loading" data-log-loading="true" style="color:var(--on-surface-variant);font-size:12px;text-align:center;padding:8px 0;">' +
      (eventsLoading ? 'Loading older transitions…' : 'Scroll to load older transitions') +
    '</div>';
  }

  container.innerHTML = html;
}

// Wires the System Logs panel into the sync coordinator so Android
// resume / network recovery / focus events refresh the events feed.
// Without this, fetchLiveEvents() only fires on phase switch and the
// log freezes while the tab is backgrounded. Note: applyToStore must
// NOT touch lastLiveMode — that tracks live WS state frames; clearing
// it would make the next frame silently seed instead of appending.
export function registerLogsSource() {
  return registerDataSource({
    id: 'logs',
    isActive: () => store.get('phase') === 'live',
    fetch: (signal) => Promise.all([
      fetchEventPage('mode', null, signal),
      fetchEventPage('config', null, signal),
    ]).then(([modeData, configData]) => ({ modeData, configData })),
    applyToStore: ({ modeData, configData }) => applyEventPages(modeData, configData, true),
  });
}

// Attach a one-time scroll listener that lazy-loads older events when the
// user reaches the bottom of the System Logs card.
export function setupLogsScrollLoader() {
  const container = document.getElementById('logs-list');
  if (!container || container._scrollHandlerAttached) return;
  container._scrollHandlerAttached = true;
  container.addEventListener('scroll', function () {
    if (store.get('phase') !== 'live') return;
    if (eventsLoading) return;
    if (!modeHasMore && !configHasMore) return;
    // Trigger when the scroll reaches within 40px of the bottom
    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (remaining < 40) {
      fetchLiveEvents(false);
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
  lines.push('Exported: ' + formatFullTimeHelsinki(Date.now()));
  lines.push('');

  // Controller-state snapshot — captures the evaluator-visible flags
  // that gate mode transitions but are otherwise invisible from the
  // sensor table alone (controls_enabled, manual override, collector
  // drain flag, watchdog cool-offs). Live mode only — the simulator
  // does not maintain these.
  if (isLive) {
    appendControllerState(lines);
  }

  if (isLive) {
    // Live: include 24h sensor readings at 20-min resolution from timeSeriesStore
    lines.push('--- Sensor Readings (24h, 20-min resolution) ---');
    lines.push('Time                  Collector  Tank Top  Tank Btm  Greenhouse  Outdoor  Mode');
    const readings = downsampleHistory(1200); // 20 minutes = 1200 seconds
    for (let i = 0; i < readings.length; i++) {
      const r = readings[i];
      const ts = formatFullTimeHelsinki(r.time * 1000);
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
      const timeLabel = t.kind === 'live'
        ? formatFullTimeHelsinki(t.ts)
        : formatTimeOfDay(t.time);

      // Config events (wb / ea / mo) get a one-line "Config: <title>"
      // entry tagged with the source/actor. Without this branch they
      // fell through the mode-row formatter and rendered as bare
      // "Idle" rows because t.mode is undefined for config events.
      if (t.eventType === 'config') {
        const fmt = formatConfigEntry(t);
        const tag = '[config: ' + (t.source || 'unknown') + ']';
        lines.push(timeLabel + '  Config  ' + fmt.title + '  ' + tag);
        const subtitle = t.actor
          ? formatConfigSourceLabel(t.source) + ' by ' + t.actor
          : formatConfigSourceLabel(t.source);
        lines.push('    source: ' + subtitle);
        continue;
      }

      const mi = MODE_INFO[t.mode] || MODE_INFO.idle;
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

// Mirrors the deviceConfig actuator bitmask (server/lib/device-config.js
// — `ea` field). Order is the bit order, not alphabetical.
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
    const rem = until - nowSec;
    const m = Math.floor(rem / 60);
    out.push(id + '=' + m + 'm');
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

  // Live state (sensors / mode / flags) from the WS state push.
  const flags = (result && result.flags) || {};
  lines.push('Mode:               ' + ((result && result.mode) || 'idle'));
  lines.push('Collectors drained: ' + (flags.collectors_drained ? 'yes' : 'no'));
  lines.push('Emergency heating:  ' + (flags.emergency_heating_active ? 'on' : 'off'));

  // Device config mirror (ce/ea/mo/we/wz/wb/v) from the watchdog-state
  // broadcast. These are the evaluator's gating fields — invisible from
  // the temperature table, but each one can independently keep the
  // controller from picking a mode the temperatures would otherwise
  // call for.
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

// Format a temperature value as a right-aligned string for the clipboard table.
function fmtTempCol(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return '    —   ';
  return String(v.toFixed(1)).padStart(8);
}

// Down-sample timeSeriesStore to a given interval (in seconds).
// Returns an array of { time, t_collector, t_tank_top, t_tank_bottom, t_greenhouse, t_outdoor, mode }.
// `mode` is resolved against the mode-events store (single source of
// truth) so the table column always agrees with the bar chart and the
// transition log — no per-sample mode tagging happens any more.
function downsampleHistory(intervalSec) {
  const out = [];
  if (timeSeriesStore.times.length === 0) return out;

  // Walk through the store, picking one sample per interval bucket
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

// Expose for testing
window.__buildLogsClipboardText = function () { return buildLogsClipboardText(); };
