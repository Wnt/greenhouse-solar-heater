// Live-mode history fetch + live-frame append. Extracted from main.js.
//
// - fetchLiveHistory(rangeSeconds): pulls /api/history?range=<key>,
//   loads the response into the shared timeSeriesStore, redraws the
//   graph, and invokes onRerender so the gauge / trend arrows catch
//   up without waiting for the next WS frame.
// - recordLiveHistoryPoint(state, result): appends a single live
//   frame (rate-limited to ~5 s) so the sliding window advances
//   between /api/history fetches.

import { store } from '../app-state.js';
import { timeSeriesStore } from '../main.js';
import { drawHistoryGraph } from './history-graph.js';
import { rerenderWithHistoryFallback } from './display-update.js';

const RANGE_MAP = {
  3600: '1h', 21600: '6h', 43200: '12h', 86400: '24h',
  604800: '7d', 2592000: '30d', 31536000: '1y',
};

let liveHistoryData = null;

export function getLiveHistoryData() { return liveHistoryData; }
export function clearLiveHistoryData() { liveHistoryData = null; }

export function fetchLiveHistory(rangeSeconds) {
  if (store.get('phase') !== 'live') return;
  const rangeKey = RANGE_MAP[rangeSeconds] || '6h';
  fetch('/api/history?range=' + rangeKey)
    .then(r => r.json())
    .then(data => {
      // Only apply to the current phase — the user may have switched
      // back to simulation while the request was in flight.
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
    })
    .catch(() => { liveHistoryData = null; });
}

// Convert /api/history response into timeSeriesStore format.
// Live-mode times are stored as Unix epoch seconds so the graph/inspector
// can render both simulation (simTime seconds) and live (epoch seconds)
// data with a single sliding-window routine.
function loadLiveHistoryIntoStore(data) {
  timeSeriesStore.reset();
  if (!data || !Array.isArray(data.points)) return;

  const modeEvents = Array.isArray(data.events)
    ? data.events.filter(e => e && e.type === 'mode').sort((a, b) => a.ts - b.ts)
    : [];
  let currentMode = 'idle';
  let eventIdx = 0;

  for (let i = 0; i < data.points.length; i++) {
    const p = data.points[i];
    if (!p || typeof p.ts !== 'number') continue;
    while (eventIdx < modeEvents.length && modeEvents[eventIdx].ts <= p.ts) {
      currentMode = modeEvents[eventIdx].to || currentMode;
      eventIdx++;
    }
    const tSec = Math.floor(p.ts / 1000);
    timeSeriesStore.addPoint(tSec, {
      t_tank_top: p.tank_top,
      t_tank_bottom: p.tank_bottom,
      t_collector: p.collector,
      t_greenhouse: p.greenhouse,
      t_outdoor: p.outdoor,
    }, currentMode);
  }
}

// Append an incoming live state frame to the history store so the
// graph ticks forward in real time. Rate-limited to one sample every
// ~5 seconds to match the simulation recording cadence.
export function recordLiveHistoryPoint(state, result) {
  if (store.get('phase') !== 'live') return;
  const tSec = Math.floor(Date.now() / 1000);
  const last = timeSeriesStore.times.length - 1;
  if (last >= 0 && (tSec - timeSeriesStore.times[last]) < 5) return;
  timeSeriesStore.addPoint(tSec, {
    t_tank_top: state.t_tank_top,
    t_tank_bottom: state.t_tank_bottom,
    t_collector: state.t_collector,
    t_greenhouse: state.t_greenhouse,
    t_outdoor: state.t_outdoor,
  }, result.mode || 'idle');
}

// Test hook: report the number of history samples currently in the
// store. Used by e2e tests to verify that live data populates the graph.
window.__getHistoryPointCount = function () { return timeSeriesStore.times.length; };
