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

// Walk points (which include a pre-window leading edge from getHistory's
// UNION) and credit each tank-energy delta to the mode active at the
// later sample. Positive deltas → gathered, negative → heating (during
// heating modes) or leakage (otherwise). Same algorithm as
// playground/js/energy-balance.js bucketRange().
function bucketEnergyByMode(points, modeEvents, windowStart) {
  let pMode = 'idle';
  let evIdx = 0;
  let gatheredWh = 0;
  let heatingLossWh = 0;
  let leakageLossWh = 0;
  let prevEnergy = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    while (evIdx < modeEvents.length && modeEvents[evIdx].ts <= p.ts) {
      pMode = modeEvents[evIdx].to || pMode;
      evIdx++;
    }
    if (typeof p.tank_top !== 'number' || typeof p.tank_bottom !== 'number') {
      prevEnergy = null;
      continue;
    }
    const e = tankStoredEnergyKwh((p.tank_top + p.tank_bottom) / 2);
    if (prevEnergy !== null && p.ts >= windowStart) {
      const d = e - prevEnergy;
      if (d > 0) {
        gatheredWh += d * 1000;
      } else if (d < 0) {
        const lossWh = -d * 1000;
        if (HEATING_MODES[pMode]) heatingLossWh += lossWh;
        else leakageLossWh += lossWh;
      }
    }
    prevEnergy = e;
  }
  return { gatheredWh, heatingLossWh, leakageLossWh };
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
