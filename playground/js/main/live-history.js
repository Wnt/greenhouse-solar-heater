// Live-mode history fetch + live-frame append. Extracted from main.js.
//
// - fetchLiveHistory(rangeSeconds): user-triggered (mode-switch, range
//   slider). Pulls /api/history?range=<key>, applies into the shared
//   timeSeriesStore, redraws the graph, re-renders the gauge / trend
//   arrows. Internally split into liveHistoryFetch (async fetch only)
//   and applyLiveHistory (sync store-write + redraw) so the sync
//   coordinator can drive the same path on Android resume.
// - registerLiveHistorySource(getRange): registers the live-history
//   data source with the sync registry so visibility / pageshow /
//   online events automatically refresh the graph.
// - recordLiveHistoryPoint(state, result): appends a single live
//   frame (rate-limited to ~5 s) so the sliding window advances
//   between /api/history fetches.

import { store } from '../app-state.js';
import { timeSeriesStore } from './state.js';
import { drawHistoryGraph } from './history-graph.js';
import { rerenderWithHistoryFallback } from './display-update.js';
import { registerDataSource } from '../sync/registry.js';
import { populateModeEvents } from './mode-events.js';

const RANGE_MAP = {
  3600: '1h', 21600: '6h', 43200: '12h', 86400: '24h',
  259200: '3d', 604800: '7d', 10368000: '4mo',
};

let liveHistoryData = null;

export function clearLiveHistoryData() { liveHistoryData = null; }

function rangeKeyFor(rangeSeconds) {
  return RANGE_MAP[rangeSeconds] || '6h';
}

// Fetcher: returns Promise<data> or rejects. Honours AbortSignal so
// the sync coordinator can cancel an in-flight request when a newer
// resync supersedes it.
function liveHistoryFetch(rangeSeconds, signal) {
  return fetch('/api/history?range=' + rangeKeyFor(rangeSeconds), { signal })
    .then(r => r.json());
}

// Applier: writes data into the shared store + redraws. Idempotent.
function applyLiveHistory(data) {
  // Phase guard — the user may have flipped to simulation while the
  // fetch was in flight, in which case dumping live data into the
  // store would clobber the simulation history.
  if (store.get('phase') !== 'live') return;
  liveHistoryData = data;
  loadLiveHistoryIntoStore(data);
  drawHistoryGraph();
  // The history fetch is async; the first WebSocket state frame may
  // have already rendered the UI with empty trend arrows (because the
  // store was empty at that moment). Re-render now so trends and the
  // tank-avg gauge reflect the freshly-loaded 15-min window instead
  // of waiting for the next ~1 Hz WS frame to trigger a refresh.
  rerenderWithHistoryFallback();
}

export function fetchLiveHistory(rangeSeconds) {
  if (store.get('phase') !== 'live') return;
  liveHistoryFetch(rangeSeconds)
    .then(applyLiveHistory)
    .catch(() => { liveHistoryData = null; });
}

// Wires this module into the sync coordinator so visibilitychange /
// pageshow / online trigger a re-fetch of the current range.
// `getRange` is a thunk that returns the live graph range so the
// registered source always picks up the user's current selection.
export function registerLiveHistorySource(getRange) {
  return registerDataSource({
    id: 'live-history',
    isActive: () => store.get('phase') === 'live',
    fetch: (signal) => liveHistoryFetch(getRange(), signal),
    applyToStore: (data) => applyLiveHistory(data),
  });
}

// Convert /api/history response into timeSeriesStore format.
// Live-mode times are stored as Unix epoch seconds so the graph/inspector
// can render both simulation (simTime seconds) and live (epoch seconds)
// data with a single sliding-window routine.
function loadLiveHistoryIntoStore(data) {
  timeSeriesStore.reset();
  // Normalize event timestamps to seconds so they share the same time
  // base as timeSeriesStore.times[] — the bar renderer's buckets are in
  // epoch seconds.
  const rawEvents = (data && Array.isArray(data.events)) ? data.events : [];
  const eventsSec = rawEvents.map(e => Object.assign({}, e, {
    ts: typeof e.ts === 'number' ? Math.floor(e.ts / 1000) : e.ts,
  }));
  populateModeEvents(eventsSec);
  if (!data || !Array.isArray(data.points)) return;

  for (let i = 0; i < data.points.length; i++) {
    const p = data.points[i];
    if (!p || typeof p.ts !== 'number') continue;
    const tSec = Math.floor(p.ts / 1000);
    timeSeriesStore.addPoint(tSec, {
      t_tank_top: p.tank_top,
      t_tank_bottom: p.tank_bottom,
      t_collector: p.collector,
      t_greenhouse: p.greenhouse,
      t_outdoor: p.outdoor,
    });
  }
}

// recordLiveHistoryPoint moved into display-update.js — same
// pipeline (updateDisplay appends a live frame to timeSeriesStore
// via that helper), and keeping it here required a circular
// import to reach rerenderWithHistoryFallback.

// Test hook: report the number of history samples currently in the
// store. Used by e2e tests to verify that live data populates the graph.
window.__getHistoryPointCount = function () { return timeSeriesStore.times.length; };
