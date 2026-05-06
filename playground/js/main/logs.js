// System Logs UI — live-events pagination, transition detection, list
// render. Clipboard export lives in logs-clipboard.js. transitionLog
// lives in state.js (shared array, many writers); re-exported here so
// existing importers don't have to change.

import { store } from '../app-state.js';
import { registerDataSource } from '../sync/registry.js';
import {
  formatClockTime, formatCauseLabel, formatReasonLabel, formatSensorsLine,
  escapeHtml, formatTimeOfDay, formatConfigEntry, formatOverlayEntry,
  formatActuatorEntry,
} from './time-format.js';
import { MODE_INFO, transitionLog } from './state.js';
import { appendModeEvent, appendSpaceHeaterEvent } from './mode-events.js';

export { transitionLog };

const EVENTS_PAGE_SIZE = 10;
// Parallel cursors so the four feeds scroll independently. Overlay
// events are fan-cool / future overlay flips written by mqtt-bridge.
// Actuator events surface space-heater on/off so hybrid heating
// (greenhouse_heating + heater overlay) shows up alongside the mode rows.
let modeCursor = null;
let modeHasMore = false;
let configCursor = null;
let configHasMore = false;
let overlayCursor = null;
let overlayHasMore = false;
let actuatorCursor = null;
let actuatorHasMore = false;
let eventsLoading = false;
let lastLiveMode = null;
let lastLiveFanCool = null;
let lastLiveSpaceHeater = null;

// Drop pagination + mode-change state. fetchLiveEvents(null) repopulates.
export function resetEventsState() {
  modeCursor = null;
  modeHasMore = false;
  configCursor = null;
  configHasMore = false;
  overlayCursor = null;
  overlayHasMore = false;
  actuatorCursor = null;
  actuatorHasMore = false;
  lastLiveMode = null;
  lastLiveFanCool = null;
  lastLiveSpaceHeater = null;
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

function overlayRowToLogEntry(e) {
  return {
    kind: 'live',
    eventType: 'overlay',
    ts: e.ts,
    overlayId: e.id,
    from: e.from,
    to: e.to,
  };
}

function actuatorRowToLogEntry(e) {
  return {
    kind: 'live',
    eventType: 'actuator',
    ts: e.ts,
    actuatorId: e.id,
    from: e.from,
    to: e.to,
  };
}

// Only space-heater on/off rows surface in the System Logs feed today.
// Pump and fan transitions are mode-driven and the operator already
// reads them from the mode rows; immersion_heater is unused. Filtering
// at the render boundary keeps the database write-side untouched (still
// records every actuator) while the UI stays focused on the events the
// operator actually needs to see.
function isUserVisibleActuator(id) {
  return id === 'space_heater';
}

// Apply a paged fetch result into transitionLog + cursor state. Pulled
// out of fetchLiveEvents so the sync-coordinator data source can reuse
// the same write path on Android resume. `_skipped` data carries no
// fresh rows or pagination info, so its cursor branch no-ops.
function applyEventPages(modeData, configData, overlayData, actuatorData, isReset) {
  // Only apply to the current phase — the user may have switched back
  // to simulation while the requests were in flight.
  if (store.get('phase') !== 'live') return;
  const modeEvents = (modeData && Array.isArray(modeData.events)) ? modeData.events : [];
  const configEvents = (configData && Array.isArray(configData.events)) ? configData.events : [];
  const overlayEvents = (overlayData && Array.isArray(overlayData.events)) ? overlayData.events : [];
  const actuatorEvents = (actuatorData && Array.isArray(actuatorData.events)) ? actuatorData.events : [];

  if (isReset) transitionLog.length = 0;

  for (let i = 0; i < modeEvents.length; i++) {
    transitionLog.push(modeRowToLogEntry(modeEvents[i]));
  }
  for (let i = 0; i < configEvents.length; i++) {
    transitionLog.push(configRowToLogEntry(configEvents[i]));
  }
  for (let i = 0; i < overlayEvents.length; i++) {
    transitionLog.push(overlayRowToLogEntry(overlayEvents[i]));
  }
  for (let i = 0; i < actuatorEvents.length; i++) {
    if (!isUserVisibleActuator(actuatorEvents[i].id)) continue;
    transitionLog.push(actuatorRowToLogEntry(actuatorEvents[i]));
  }
  // Re-sort the merged list newest-first. Stable enough for our N (~30).
  transitionLog.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  if (!modeData._skipped) {
    if (modeEvents.length > 0) modeCursor = modeEvents[modeEvents.length - 1].ts;
    modeHasMore = !!(modeData && modeData.hasMore);
  }
  if (!configData._skipped) {
    if (configEvents.length > 0) configCursor = configEvents[configEvents.length - 1].ts;
    configHasMore = !!(configData && configData.hasMore);
  }
  if (!overlayData._skipped) {
    if (overlayEvents.length > 0) overlayCursor = overlayEvents[overlayEvents.length - 1].ts;
    overlayHasMore = !!(overlayData && overlayData.hasMore);
  }
  if (!actuatorData._skipped) {
    if (actuatorEvents.length > 0) actuatorCursor = actuatorEvents[actuatorEvents.length - 1].ts;
    actuatorHasMore = !!(actuatorData && actuatorData.hasMore);
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
  const overlayBefore = isReset ? null : (overlayHasMore ? overlayCursor : null);
  const actuatorBefore = isReset ? null : (actuatorHasMore ? actuatorCursor : null);

  // Skip a side that has no more rows AND it isn't a reset, to avoid
  // re-fetching identical pages.
  const modePromise = (isReset || modeHasMore)
    ? fetchEventPage('mode', modeBefore)
    : Promise.resolve({ events: [], hasMore: false, _skipped: true });
  const configPromise = (isReset || configHasMore)
    ? fetchEventPage('config', configBefore)
    : Promise.resolve({ events: [], hasMore: false, _skipped: true });
  const overlayPromise = (isReset || overlayHasMore)
    ? fetchEventPage('overlay', overlayBefore)
    : Promise.resolve({ events: [], hasMore: false, _skipped: true });
  const actuatorPromise = (isReset || actuatorHasMore)
    ? fetchEventPage('actuator', actuatorBefore)
    : Promise.resolve({ events: [], hasMore: false, _skipped: true });

  Promise.all([modePromise, configPromise, overlayPromise, actuatorPromise])
    .then(([modeData, configData, overlayData, actuatorData]) =>
      applyEventPages(modeData, configData, overlayData, actuatorData, isReset))
    .then(() => { eventsLoading = false; });
}

function formatLiveTransitionText(from, to) {
  const fromLabel = (from && MODE_INFO[from]) ? MODE_INFO[from].label : (from || '—');
  const toLabel = (to && MODE_INFO[to]) ? MODE_INFO[to].label : (to || '—');
  return fromLabel + ' → ' + toLabel;
}

// Muted-dot row used for config edits and overlay flips — neither is a
// mode transition, so the green/orange/red mode-color palette would be
// misleading.
function renderMutedEntry(fmt, timeLabel) {
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
  let dirty = false;
  const mode = result && result.mode;
  if (mode) {
    if (lastLiveMode === null) {
      lastLiveMode = mode;
    } else if (lastLiveMode !== mode) {
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
      dirty = true;
    }
  }

  // Fan-cool overlay flips: same eager-prepend pattern as mode changes.
  const flags = (result && result.flags) || {};
  if (typeof flags.greenhouse_fan_cooling_active === 'boolean') {
    const cur = flags.greenhouse_fan_cooling_active;
    if (lastLiveFanCool === null) {
      lastLiveFanCool = cur;
    } else if (lastLiveFanCool !== cur) {
      transitionLog.unshift({
        kind: 'live', eventType: 'overlay', ts: Date.now(),
        overlayId: 'greenhouse_fan_cooling',
        from: lastLiveFanCool ? 'on' : 'off',
        to: cur ? 'on' : 'off',
      });
      lastLiveFanCool = cur;
      dirty = true;
    }
  }

  // Space-heater on/off — surfaces hybrid heating in real time so the
  // operator doesn't have to wait for the next /api/events refresh.
  // Mirrors the fan-cool logic above; the on-disk record still flows
  // through mqtt-bridge → state_events.
  const actuators = (result && result.actuators) || {};
  if (typeof actuators.space_heater === 'boolean') {
    const cur = actuators.space_heater;
    if (lastLiveSpaceHeater === null) {
      lastLiveSpaceHeater = cur;
    } else if (lastLiveSpaceHeater !== cur) {
      const tsMs = Date.now();
      transitionLog.unshift({
        kind: 'live', eventType: 'actuator', ts: tsMs,
        actuatorId: 'space_heater',
        from: lastLiveSpaceHeater ? 'on' : 'off',
        to: cur ? 'on' : 'off',
      });
      // Mirror into the space-heater store so the EMERGENCY band on
      // the bar chart updates without waiting for the next /api/history
      // refresh (matches the appendModeEvent call above).
      appendSpaceHeaterEvent({
        ts: Math.floor(tsMs / 1000),
        type: 'actuator',
        id: 'space_heater',
        from: lastLiveSpaceHeater ? 'on' : 'off',
        to: cur ? 'on' : 'off',
      });
      lastLiveSpaceHeater = cur;
      dirty = true;
    }
  }

  if (dirty) renderLogsList();
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
      html += renderMutedEntry(formatConfigEntry(t), timeLabel);
      continue;
    }
    if (t.eventType === 'overlay') {
      html += renderMutedEntry(formatOverlayEntry(t), timeLabel);
      continue;
    }
    if (t.eventType === 'actuator') {
      html += renderMutedEntry(formatActuatorEntry(t), timeLabel);
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

  if (isLive && (modeHasMore || configHasMore || overlayHasMore || actuatorHasMore)) {
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
      fetchEventPage('overlay', null, signal),
      fetchEventPage('actuator', null, signal),
    ]).then(([modeData, configData, overlayData, actuatorData]) =>
      ({ modeData, configData, overlayData, actuatorData })),
    applyToStore: ({ modeData, configData, overlayData, actuatorData }) =>
      applyEventPages(modeData, configData, overlayData, actuatorData, true),
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
    if (!modeHasMore && !configHasMore && !overlayHasMore && !actuatorHasMore) return;
    // Trigger when the scroll reaches within 40px of the bottom
    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (remaining < 40) {
      fetchLiveEvents(false);
    }
  });
}
