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
//
// A parallel `spaceHeaterEventsStore` tracks space-heater on/off
// transitions. The space heater is an actuator that runs as an OVERLAY
// on top of any pump-mode (typically greenhouse_heating when the tank
// is too cold to drive the radiator), so EMERGENCY band coverage is
// the OR-union of `mode === 'emergency_heating'` and
// `space_heater === 'on'` — otherwise hybrid heating is invisible on
// the graph.

export const modeEventsStore = {
  events: [],
};

export const spaceHeaterEventsStore = {
  events: [],
};

export function resetModeEvents() {
  modeEventsStore.events = [];
}

export function resetSpaceHeaterEvents() {
  spaceHeaterEventsStore.events = [];
}

function isModeEvent(e) {
  return e && typeof e.ts === 'number' && (e.type === 'mode' || e.type === undefined);
}

function isSpaceHeaterEvent(e) {
  return e && typeof e.ts === 'number' && e.type === 'actuator' && e.id === 'space_heater';
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

// /api/events?type=actuator and /api/history's actuator stream both
// carry events for every actuator (pump, fan, space_heater,
// immersion_heater). This store keeps only space_heater rows.
export function populateSpaceHeaterEvents(events) {
  if (!Array.isArray(events)) {
    spaceHeaterEventsStore.events = [];
    return;
  }
  const filtered = [];
  for (let i = 0; i < events.length; i++) {
    if (isSpaceHeaterEvent(events[i])) filtered.push(events[i]);
  }
  filtered.sort((a, b) => a.ts - b.ts);
  spaceHeaterEventsStore.events = filtered;
}

export function appendModeEvent(event) {
  if (!isModeEvent(event)) return;
  appendInOrder(modeEventsStore.events, event);
}

export function appendSpaceHeaterEvent(event) {
  if (!isSpaceHeaterEvent(event)) return;
  appendInOrder(spaceHeaterEventsStore.events, event);
}

function appendInOrder(list, event) {
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
  return stateAt(modeEventsStore.events, ts, 'idle');
}

// Returns 'on' / 'off' for the space heater at `ts`, defaulting to
// 'off' when no event applies.
export function spaceHeaterAt(ts) {
  return stateAt(spaceHeaterEventsStore.events, ts, 'off');
}

function stateAt(list, ts, fallback) {
  if (list.length === 0) return fallback;
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].ts <= ts) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return fallback;
  return list[lo - 1].to || fallback;
}

// Per-mode wall-clock seconds covered by events that fall inside the
// half-open interval [start, end). Walks the merged timeline of mode
// events AND space-heater on/off events from one tick before `start`
// (the leading-event lookup) and clamps each segment to the bucket
// boundaries — so a 30-min bucket that starts mid-charge contributes
// the partial overlap, not the full bucket.
//
// Emergency coverage is the OR-union of `mode === 'emergency_heating'`
// and `space_heater === 'on'` over the bucket. Charging and heating
// are pure mode-driven and don't interact with the heater overlay.
export function coverageInBucket(start, end) {
  const out = { charging: 0, heating: 0, emergency: 0 };
  if (end <= start) return out;
  const modeList = modeEventsStore.events;
  const heaterList = spaceHeaterEventsStore.events;

  // Walking pointers through both lists in ts order. Between transition
  // points the (mode, heater) tuple is constant, so we accumulate
  // segments bounded by the next event from either timeline.
  let mode = modeAt(start);
  let heater = spaceHeaterAt(start);
  let cursor = start;

  let mi = 0; while (mi < modeList.length && modeList[mi].ts <= start) mi++;
  let hi = 0; while (hi < heaterList.length && heaterList[hi].ts <= start) hi++;

  while (true) {
    const nextModeTs = mi < modeList.length ? modeList[mi].ts : Infinity;
    const nextHeaterTs = hi < heaterList.length ? heaterList[hi].ts : Infinity;
    const nextTs = Math.min(nextModeTs, nextHeaterTs, end);
    addSegment(out, mode, heater, cursor, nextTs);
    if (nextTs >= end) break;
    if (nextModeTs === nextTs) {
      mode = modeList[mi].to || 'idle';
      mi++;
    }
    if (nextHeaterTs === nextTs) {
      heater = heaterList[hi].to || 'off';
      hi++;
    }
    cursor = nextTs;
  }
  return out;
}

function addSegment(out, mode, heater, from, to) {
  const dur = to - from;
  if (dur <= 0) return;
  if (mode === 'solar_charging') out.charging += dur;
  else if (mode === 'greenhouse_heating') out.heating += dur;
  // OR-union: emergency_heating mode OR space-heater on. The mode-only
  // and heater-only cases each contribute their full duration; the
  // overlap (heater on while mode === emergency_heating) contributes
  // once, not twice.
  if (mode === 'emergency_heating' || heater === 'on') out.emergency += dur;
}
