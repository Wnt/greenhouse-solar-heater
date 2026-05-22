// Energy balance — computes the "Today's balance" card numbers from a
// history window of temperature points + mode events. Splits the window
// into a completed "day" (the most recent chain of solar_charging
// activity) and a "night" (the surrounding idle period).
//
// Independent of the Status view's time-range pills: call with 24–48 h
// of data and the function decides what slice to label day vs. night.

import { tankStoredEnergyKwh } from './physics.js';

// Gap (ms) between two solar_charging events that splits them into
// separate "days". 2 h is long enough to survive the brief idle
// "stall → retry" pattern we see mid-afternoon, short enough that
// evening leakage after sunset gets counted toward night rather than day.
export const DAY_GAP_MS = 2 * 3600 * 1000;

// Heating-mode set for loss classification. Lowercase because that's
// what the server's history API returns (state events store the
// lowercased mode name).
const HEATING_MODES = { greenhouse_heating: 1, emergency_heating: 1 };

function pointEnergyKwh(p) {
  if (!p || typeof p.tank_top !== 'number' || typeof p.tank_bottom !== 'number') return null;
  return tankStoredEnergyKwh((p.tank_top + p.tank_bottom) / 2);
}

function firstIdxAtOrAfter(points, ts) {
  for (let i = 0; i < points.length; i++) {
    if (points[i].ts >= ts) return i;
  }
  return points.length - 1;
}

function lastIdxAtOrBefore(points, ts) {
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].ts <= ts) return i;
  }
  return 0;
}

// Bucket the tank-energy change across [startIdx, endIdx] by the *net*
// change within each contiguous run of one mode — NOT the sum of every
// sample-to-sample delta. The 30 s tank signal is quantised to 0.1 °C and
// carries ±0.5 K of sensor jitter; summing the magnitude of each delta is
// the signal's total variation, which over thousands of samples accretes
// tens of phantom kWh (a flat night "leaked" 6 kWh and "gathered" 3 kWh of
// nonexistent solar). Net-per-segment telescopes those wiggles away: a run
// is scored only by its endpoints, so noise cancels and gain is tied to the
// mode that was actually running.
//   - solar_charging: net rise → gathered (a net fall → leakage)
//   - heating modes:  net fall → heating
//   - everything else: net fall → leakage
// A positive swing outside solar_charging is discarded (you cannot gather
// solar at night), so gathered − heating − leakage tracks, but does not
// exactly equal, the raw endpoint-to-endpoint change.
function bucketRange(modes, energy, startIdx, endIdx) {
  let gathered = 0, heating = 0, leakage = 0;
  let segMode = null, segStartE = null, lastE = null;
  function commit(net) {
    if (segMode === 'solar_charging') {
      if (net > 0) gathered += net; else leakage += -net;
    } else if (HEATING_MODES[segMode]) {
      if (net < 0) heating += -net;
    } else {
      if (net < 0) leakage += -net;
    }
  }
  for (let i = startIdx; i <= endIdx; i++) {
    const e = energy[i];
    const m = modes[i];
    if (e === null) {
      // Data gap — close the open segment and don't bridge across it.
      if (segMode !== null && segStartE !== null && lastE !== null) commit(lastE - segStartE);
      segMode = null; segStartE = null; lastE = null;
      continue;
    }
    if (segMode === null) { segMode = m; segStartE = e; lastE = e; continue; }
    if (m !== segMode) {
      commit(lastE - segStartE);
      // The boundary delta (this sample vs. the previous run's last sample)
      // belongs to the new mode, matching the old per-sample attribution.
      segMode = m; segStartE = lastE;
    }
    lastE = e;
  }
  if (segMode !== null && segStartE !== null && lastE !== null) commit(lastE - segStartE);
  return { gathered, heating, leakage };
}

/**
 * Compute today's energy balance.
 *
 * @param {Array} points — history points, each {ts (ms), tank_top, tank_bottom, ...}, sorted ascending by ts.
 * @param {Array} events — mode events [{ts (ms), type:'mode', to:'idle'|'solar_charging'|...}]
 * @param {number} nowMs — wall-clock time in ms
 * @returns {{ night: ?object, day: ?object }} — each section has
 *   startTs, endTs, complete, gatheredKwh, heatingKwh, leakageKwh, netKwh
 */
export function computeEnergyBalance(points, events, nowMs) {
  if (!Array.isArray(points) || points.length < 2) return { night: null, day: null };

  const modeEvents = (events || [])
    .filter(e => e && e.type === 'mode' && typeof e.ts === 'number')
    .slice()
    .sort((a, b) => a.ts - b.ts);

  // Per-point mode via a forward-walking event cursor.
  const n = points.length;
  const modes = new Array(n);
  const energy = new Array(n);

  let eventIdx = 0;
  let currentMode = 'idle';
  while (eventIdx < modeEvents.length && modeEvents[eventIdx].ts <= points[0].ts) {
    currentMode = modeEvents[eventIdx].to || currentMode;
    eventIdx++;
  }
  modes[0] = currentMode;
  energy[0] = pointEnergyKwh(points[0]);

  for (let i = 1; i < n; i++) {
    while (eventIdx < modeEvents.length && modeEvents[eventIdx].ts <= points[i].ts) {
      currentMode = modeEvents[eventIdx].to || currentMode;
      eventIdx++;
    }
    modes[i] = currentMode;
    energy[i] = pointEnergyKwh(points[i]);
  }

  // Build charge windows from mode events — [startTs, endTs] pairs of
  // contiguous solar_charging runs. Base detection on event timestamps,
  // not sample density, so sparse sampling doesn't fragment a day.
  const chargeWindows = [];
  let scanMode = 'idle';
  let chargeStart = null;
  for (let i = 0; i < modeEvents.length; i++) {
    const to = modeEvents[i].to || scanMode;
    if (scanMode !== 'solar_charging' && to === 'solar_charging') {
      chargeStart = modeEvents[i].ts;
    } else if (scanMode === 'solar_charging' && to !== 'solar_charging') {
      chargeWindows.push({ start: chargeStart, end: modeEvents[i].ts });
      chargeStart = null;
    }
    scanMode = to;
  }
  if (chargeStart !== null) {
    chargeWindows.push({ start: chargeStart, end: nowMs });
  }

  // Merge adjacent charge windows into "days" — cluster anything separated
  // by less than DAY_GAP_MS so brief solar_stall → solar_enter bounces
  // don't split the afternoon into multiple tiny days.
  const days = [];
  for (let i = 0; i < chargeWindows.length; i++) {
    const w = chargeWindows[i];
    const last = days[days.length - 1];
    if (last && w.start - last.end < DAY_GAP_MS) {
      last.end = w.end;
    } else {
      days.push({ start: w.start, end: w.end });
    }
  }

  const latestDay = days.length > 0 ? days[days.length - 1] : null;
  const prevDayEnd = days.length > 1 ? days[days.length - 2].end : null;

  // Is the day still ongoing? (within DAY_GAP_MS of its last charge, OR
  // currently charging)
  let dayStartIdx = -1;
  let dayEndIdx = -1;
  let dayComplete = true;
  if (latestDay) {
    dayStartIdx = firstIdxAtOrAfter(points, latestDay.start);
    const ongoing = nowMs - latestDay.end < DAY_GAP_MS;
    dayComplete = !ongoing;
    dayEndIdx = ongoing ? n - 1 : lastIdxAtOrBefore(points, latestDay.end);
  }

  // Night bounds.
  let nightStartIdx;
  let nightEndIdx;

  if (!latestDay) {
    // No day in the window → everything is an ongoing night.
    nightStartIdx = 0;
    nightEndIdx = n - 1;
  } else if (dayComplete) {
    // Night is ongoing, starts at the day's end (or latestDay.end).
    nightStartIdx = dayEndIdx;
    nightEndIdx = n - 1;
  } else {
    // Day is ongoing; night is the gap before this day.
    nightEndIdx = dayStartIdx;
    nightStartIdx = prevDayEnd !== null
      ? lastIdxAtOrBefore(points, prevDayEnd)
      : 0;
  }

  let night = null;
  if (nightEndIdx > nightStartIdx) {
    const b = bucketRange(modes, energy, nightStartIdx, nightEndIdx);
    // A "night" is ongoing when it runs up to nowMs (no day after it, or
    // this day is completed).
    const nightComplete = dayStartIdx !== -1 && !dayComplete;
    night = {
      startTs: points[nightStartIdx].ts,
      endTs: points[nightEndIdx].ts,
      complete: nightComplete,
      gatheredKwh: b.gathered,
      leakageKwh: b.leakage,
      heatingKwh: b.heating,
      netKwh: b.gathered - b.leakage - b.heating,
    };
  }

  let day = null;
  if (dayStartIdx !== -1 && dayEndIdx > dayStartIdx) {
    const b = bucketRange(modes, energy, dayStartIdx, dayEndIdx);
    day = {
      startTs: points[dayStartIdx].ts,
      endTs: points[dayEndIdx].ts,
      complete: dayComplete,
      gatheredKwh: b.gathered,
      leakageKwh: b.leakage,
      heatingKwh: b.heating,
      netKwh: b.gathered - b.leakage - b.heating,
    };
  }

  return { night, day };
}

// Editorial one-liners for the card subtitle. Matches the Stitch tone
// ("sanctuary-like", Newsreader italic). Returns an empty string when the
// section has no meaningful numbers to narrate.
export function editorialNightSentence(night) {
  if (!night) return '';
  const heating = night.heatingKwh >= 0.05;
  const leakage = night.leakageKwh >= 0.05;
  if (!heating && !leakage) return 'The tank held steady.';
  if (heating && leakage) return 'The greenhouse drew warmth; leftover heat slipped to air.';
  if (heating) return 'The greenhouse drew warmth while the sanctuary slept.';
  return 'The tank rested without the sun.';
}

export function editorialDaySentence(day) {
  if (!day) return '';
  const gained = day.gatheredKwh >= 0.05;
  const heating = day.heatingKwh >= 0.05;
  const leakage = day.leakageKwh >= 0.05;
  if (!gained && !heating && !leakage) return 'A still day for the sanctuary.';
  if (!gained && heating) return 'No sun reached the collectors; the greenhouse drew from the tank.';
  if (!gained) return 'No sun reached the collectors today.';
  if (heating && leakage) return 'Warmth moved in and out of the tank today.';
  if (heating) return 'The collectors gathered warmth; the greenhouse drew its share.';
  if (leakage) return 'Your collectors gathered warmth; some slipped away after peak.';
  return 'Your collectors gathered warmth today.';
}
