// Single source of truth for "what mode was active at time T" in live
// mode. Replaces the per-sample `timeSeriesStore.modes[]` array that
// the bar chart, the inspector, and the clipboard table used to read
// from independently — those three views now all binary-search this
// store, which keeps them mathematically consistent with each other and
// with the System Logs panel.
//
// The store holds an ascending-sorted list of mode-transition events.
// `populateModeEvents` is called by the live-history fetch with the
// rows from /api/history; that response always includes a "leading
// event" (the most recent transition before the visible window — see
// db.getEvents) so the first sample's mode is well-defined.
// `appendModeEvent` is called by detectLiveTransition for live deltas.

export const modeEventsStore = {
  events: [],
};

export function resetModeEvents() {
  modeEventsStore.events = [];
}

function isModeEvent(e) {
  return e && typeof e.ts === 'number' && (e.type === 'mode' || e.type === undefined);
}

export function populateModeEvents(events) {
  if (!Array.isArray(events)) {
    modeEventsStore.events = [];
    return;
  }
  const filtered = [];
  for (let i = 0; i < events.length; i++) {
    if (isModeEvent(events[i])) filtered.push(events[i]);
  }
  filtered.sort((a, b) => a.ts - b.ts);
  modeEventsStore.events = filtered;
}

export function appendModeEvent(event) {
  if (!isModeEvent(event)) return;
  const list = modeEventsStore.events;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].ts === event.ts && list[i].to === event.to) return;
    if (list[i].ts < event.ts) {
      list.splice(i + 1, 0, event);
      return;
    }
  }
  list.unshift(event);
}

// Returns the mode active at `ts`, defaulting to 'idle' when no event
// applies (no leading event seen, or `ts` predates every known event).
export function modeAt(ts) {
  const list = modeEventsStore.events;
  if (list.length === 0) return 'idle';
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].ts <= ts) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return 'idle';
  return list[lo - 1].to || 'idle';
}

// Per-mode wall-clock seconds covered by events that fall inside the
// half-open interval [start, end). Walks events from one tick before
// `start` (the leading-event lookup) and clamps each segment to the
// bucket boundaries — so a 30-min bucket that starts mid-charge
// contributes the partial overlap, not the full bucket.
export function coverageInBucket(start, end) {
  const out = { charging: 0, heating: 0, emergency: 0 };
  if (end <= start) return out;
  const list = modeEventsStore.events;

  let mode = modeAt(start);
  let cursor = start;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.ts <= start) continue;
    if (e.ts >= end) break;
    addSegment(out, mode, cursor, e.ts);
    mode = e.to || 'idle';
    cursor = e.ts;
  }
  addSegment(out, mode, cursor, end);
  return out;
}

function addSegment(out, mode, from, to) {
  const dur = to - from;
  if (dur <= 0) return;
  if (mode === 'solar_charging') out.charging += dur;
  else if (mode === 'greenhouse_heating') out.heating += dur;
  else if (mode === 'emergency_heating') out.emergency += dur;
}
