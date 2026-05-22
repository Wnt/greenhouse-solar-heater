/**
 * Server-side energy bucketing for the noon and evening notification
 * reports. Mirrors playground/js/energy-balance.js so notifications
 * agree with the in-app balance card.
 *
 * Pulled from durable history (sensor_readings + state_events), so the
 * reports survive server restarts that wipe the in-memory accumulators
 * in notifications.js. Without this, a redeploy between the report's
 * accounting window and the send time silently truncated the body
 * (see commit a012bd0).
 */

// Mode names arrive lowercased on greenhouse/state — the device's
// buildStatePayload() in shelly/control-logic.js does st.mode.toLowerCase()
// before publishing, and state_events store the lowercased values.
// Same set the playground uses (energy-balance.js).
const HEATING_MODES = { greenhouse_heating: 1, emergency_heating: 1 };

// Q = 300 kg · 4.186 kJ/(kg·K) · max(0, avgTank − 12 °C) / 3600.
// Must stay in sync with tankStoredEnergyKwh() in playground/js/physics.js.
function tankStoredEnergyKwh(avgTankC) {
  if (typeof avgTankC !== 'number' || !isFinite(avgTankC)) return 0;
  let dT = avgTankC - 12;
  if (dT < 0) dT = 0;
  return 300 * 4.186 * dT / 3600;
}

// Window for the 12:00 noon "Overnight Heating Report" — reaches back
// to ~18:00 the previous evening, capturing the full night plus
// pre-sunset leakage. Positive solar deltas inside the window are
// not reported (the body talks about heating + leakage only).
const OVERNIGHT_WINDOW_MS = 18 * 3600 * 1000;

// Window for the 20:00 evening "Daily Solar Report" — the cadence
// between evening reports.
const DAILY_WINDOW_MS = 24 * 3600 * 1000;

function sortModeEvents(events) {
  return (events || [])
    .filter(function (e) { return e && e.type === 'mode' && typeof e.ts === 'number'; })
    .slice()
    .sort(function (a, b) { return a.ts - b.ts; });
}

// Bucket the tank-energy change by the *net* change within each contiguous
// run of one mode — NOT the sum of every sample-to-sample delta. The 30 s
// tank signal is quantised to 0.1 °C and carries ±0.5 K of sensor jitter;
// summing each delta's magnitude is the signal's total variation, which over
// thousands of samples accretes tens of phantom kWh (a flat night reported
// 6 kWh "to air" and 3 kWh of nonexistent solar "gathered"). Scoring each
// run by its endpoints telescopes the wiggles away and ties gain to the mode
// that was actually running. Mirrors playground/js/energy-balance.js
// bucketRange(); keep the two in sync.
//   - solar_charging: net rise → gathered (a net fall → leakage)
//   - heating modes:  net fall → heating
//   - everything else: net fall → leakage
// `points` includes a pre-window leading edge from getHistory's UNION; the
// first counted segment is seeded from the sample just before windowStart so
// the energy change across the window boundary is captured.
function bucketEnergyByMode(points, modeEvents, windowStart) {
  // Per-point mode (forward-walking event cursor) and tank energy.
  const modes = new Array(points.length);
  const energy = new Array(points.length);
  let pMode = 'idle';
  let evIdx = 0;
  let firstIn = points.length;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    while (evIdx < modeEvents.length && modeEvents[evIdx].ts <= p.ts) {
      pMode = modeEvents[evIdx].to || pMode;
      evIdx++;
    }
    modes[i] = pMode;
    energy[i] = (typeof p.tank_top === 'number' && typeof p.tank_bottom === 'number')
      ? tankStoredEnergyKwh((p.tank_top + p.tank_bottom) / 2)
      : null;
    if (firstIn === points.length && p.ts >= windowStart) firstIn = i;
  }
  if (firstIn >= points.length) {
    return { gatheredWh: 0, heatingLossWh: 0, leakageLossWh: 0 };
  }
  const base = firstIn > 0 ? firstIn - 1 : 0;

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
  for (let i = base; i < points.length; i++) {
    const e = energy[i];
    const m = modes[i];
    if (e === null) {
      if (segMode !== null && segStartE !== null && lastE !== null) commit(lastE - segStartE);
      segMode = null; segStartE = null; lastE = null;
      continue;
    }
    if (segMode === null) { segMode = m; segStartE = e; lastE = e; continue; }
    if (m !== segMode) {
      commit(lastE - segStartE);
      segMode = m; segStartE = lastE;
    }
    lastE = e;
  }
  if (segMode !== null && segStartE !== null && lastE !== null) commit(lastE - segStartE);

  return {
    gatheredWh: gathered * 1000,
    heatingLossWh: heating * 1000,
    leakageLossWh: leakage * 1000,
  };
}

function computeOvernightFromHistory(points, events, now) {
  const windowStart = now - OVERNIGHT_WINDOW_MS;
  const modeEvents = sortModeEvents(events);

  // Mode at windowStart — last event with ts <= windowStart.
  let modeAtStart = 'idle';
  let firstInWindow = 0;
  for (let i = 0; i < modeEvents.length; i++) {
    if (modeEvents[i].ts > windowStart) { firstInWindow = i; break; }
    modeAtStart = modeEvents[i].to || modeAtStart;
    firstInWindow = i + 1;
  }

  // Heating duration: sum (segment end - segment start) for each
  // greenhouse_heating / emergency_heating run that overlaps the window.
  let durationMs = 0;
  let curMode = modeAtStart;
  let segStart = HEATING_MODES[curMode] ? windowStart : null;
  for (let i = firstInWindow; i < modeEvents.length; i++) {
    const ev = modeEvents[i];
    if (ev.ts >= now) break;
    if (HEATING_MODES[curMode] && segStart !== null) {
      durationMs += ev.ts - segStart;
      segStart = null;
    }
    if (ev.to && HEATING_MODES[ev.to]) {
      segStart = ev.ts;
    }
    curMode = ev.to || curMode;
  }
  if (HEATING_MODES[curMode] && segStart !== null) {
    durationMs += now - segStart;
  }

  const buckets = bucketEnergyByMode(points, modeEvents, windowStart);

  return {
    durationMinutes: Math.round(durationMs / 60000),
    heatingLossWh: buckets.heatingLossWh,
    leakageLossWh: buckets.leakageLossWh,
  };
}

function computeDailyFromHistory(points, events, now) {
  const windowStart = now - DAILY_WINDOW_MS;
  const modeEvents = sortModeEvents(events);
  return bucketEnergyByMode(points, modeEvents, windowStart);
}

function computeOvernightStats(db, now, callback) {
  fetchAndCompute(db, now, computeOvernightFromHistory, callback);
}

function computeDailyStats(db, now, callback) {
  fetchAndCompute(db, now, computeDailyFromHistory, callback);
}

function fetchAndCompute(db, now, fromHistory, callback) {
  if (!db || typeof db.getHistory !== 'function' || typeof db.getEvents !== 'function') {
    callback(new Error('db_unavailable'));
    return;
  }
  db.getHistory('24h', null, function (hErr, points) {
    if (hErr) { callback(hErr); return; }
    db.getEvents('24h', 'mode', function (eErr, events) {
      if (eErr) { callback(eErr); return; }
      try {
        callback(null, fromHistory(points || [], events || [], now));
      } catch (e) {
        callback(e);
      }
    });
  });
}

module.exports = {
  HEATING_MODES,
  tankStoredEnergyKwh,
  computeOvernightFromHistory,
  computeDailyFromHistory,
  computeOvernightStats,
  computeDailyStats,
};
