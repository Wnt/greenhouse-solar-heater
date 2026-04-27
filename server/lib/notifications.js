/**
 * Notification engine — evaluates incoming state for alert/report conditions
 * and triggers push notifications via the push module.
 *
 * Alert types:
 *   overheat_warning  — tank temp trending toward overheat drain threshold
 *   freeze_warning    — outdoor temp trending toward freeze drain threshold
 *   evening_report    — daily solar energy summary (sent ~20:00 local time)
 *   noon_report       — overnight heating operations summary (sent ~12:00 local time)
 *   offline_warning   — controller offline for 15+ min / back online for 15+ min
 *
 * Temperature prediction: linear extrapolation from last N readings to
 * estimate whether a threshold will be crossed within 15 minutes.
 *
 * Data freshness: all temperature/report notifications are suppressed when
 * the controller is offline (no state messages received for >2 min).
 * Only offline_warning notifications are sent during an outage.
 *
 * Rate limiting is enforced by the push module (1 per type per hour).
 */

const createLogger = require('./logger');
const log = createLogger('notifications');

// Source freeze/overheat thresholds from the Shelly control-logic defaults
// so the notification body never drifts from the device's actual drain
// trigger. Previously these were copied as literals here and went stale
// when the control-logic defaults moved (freezeDrainTemp 2->4 on 2026-04-22,
// overheatDrainTemp was already 95 while this file still said 85).
const CONTROL_DEFAULTS = require('../../shelly/control-logic.js').DEFAULT_CONFIG;

// Mode names arrive lowercased on greenhouse/state — the device's
// buildStatePayload() in shelly/control-logic.js does st.mode.toLowerCase()
// before publishing, and state_events store the lowercased values.
// Match the same set the playground uses (energy-balance.js).
const HEATING_MODES = { greenhouse_heating: 1, emergency_heating: 1 };

let pushRef = null;
let deviceConfigRef = null;
let dbRef = null;

// Temperature history buffers for trend prediction
let tankTempHistory = [];    // { ts: ms, value: number }
let outdoorTempHistory = [];
let collectorTempHistory = [];
const HISTORY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes of samples
const PREDICTION_HORIZON_MS = 15 * 60 * 1000; // 15 minutes ahead

// Data freshness: suppress notifications when data is stale
const DATA_STALE_MS = 2 * 60 * 1000; // 2 minutes without data = stale
let lastEvaluateTs = 0;

// Offline/online detection
const OFFLINE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
let offlineSince = 0;      // timestamp when we first detected staleness (0 = not offline)
let offlineNotified = false; // whether we sent the offline notification
let onlineSince = 0;        // timestamp when data resumed after offline (0 = not recovering)
let onlineNotified = false;  // whether we sent the recovery notification
let tickTimer = null;

// Report scheduling state
let lastEveningReport = 0;  // day-of-year when last sent
let lastNoonReport = 0;
// Daily tank-energy accounting. Accumulators reset after each evening report.
// Classification is by the mode that was active during each delta (credited
// to lastMode, since the drop happened between the last eval and now):
//   gathered         — all positive deltas
//   heating loss     — negative deltas while mode was GREENHOUSE_HEATING or
//                      EMERGENCY_HEATING (tank water actively drawn for heat)
//   leakage loss     — negative deltas while mode was anything else (IDLE /
//                      SOLAR_CHARGING / ACTIVE_DRAIN) — heat quietly leaving
//                      the tank to the surrounding air.
// All three use the same Status-view formula (300 L · 4.186 kJ/kg·K ·
// max(0, avgTank − 12 °C) / 3600).
let dailyEnergyWh = 0;
let dailyHeatingLossWh = 0;
let dailyLeakageLossWh = 0;
// Noon report covers the night just past — separate overnight accumulators
// reset after each noon report.
let nightHeatingLossWh = 0;
let nightLeakageLossWh = 0;
let lastTankEnergyKwh = null; // last observed stored-energy reading
let nightHeatingMinutes = 0;
let lastModeCheckTs = 0;
let lastMode = null;

// Tank energy helper — kept local so the CommonJS notifications module
// doesn't depend on the ES-module physics.js. Must stay in sync with
// tankStoredEnergyKwh() in playground/js/physics.js.
function tankStoredEnergyKwh(avgTankC) {
  if (typeof avgTankC !== 'number' || !isFinite(avgTankC)) return 0;
  let dT = avgTankC - 12;
  if (dT < 0) dT = 0;
  return 300 * 4.186 * dT / 3600;
}

// Timezone offset for Finland (EET = UTC+2, EEST = UTC+3)
// We use a simple approximation: UTC+2 in winter, UTC+3 in summer
function getLocalHour() {
  const now = new Date();
  // Finland DST: last Sunday in March to last Sunday in October
  const month = now.getUTCMonth(); // 0-11
  const isDST = month >= 2 && month <= 9; // approximate Mar-Oct
  const offset = isDST ? 3 : 2;
  return (now.getUTCHours() + offset) % 24;
}

function getDayOfYear() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now - start;
  return Math.floor(diff / 86400000);
}

// ── Temperature trend prediction ──

function addSample(history, ts, value) {
  history.push({ ts, value });
  // Trim old samples
  const cutoff = ts - HISTORY_WINDOW_MS;
  while (history.length > 0 && history[0].ts < cutoff) {
    history.shift();
  }
}

// Linear regression to predict value at `horizonMs` in the future.
// Returns null if insufficient data (need at least 2 samples spanning 60s+).
function predictValue(history, horizonMs) {
  if (history.length < 2) return null;
  const span = history[history.length - 1].ts - history[0].ts;
  if (span < 60000) return null; // need at least 60s of data

  // Simple linear regression: y = a + b*t
  const n = history.length;
  let sumT = 0, sumV = 0, sumTV = 0, sumTT = 0;
  const t0 = history[0].ts;
  for (let i = 0; i < n; i++) {
    const t = (history[i].ts - t0) / 1000; // seconds
    const v = history[i].value;
    sumT += t;
    sumV += v;
    sumTV += t * v;
    sumTT += t * t;
  }
  const denom = n * sumTT - sumT * sumT;
  if (Math.abs(denom) < 0.001) return null; // flat or singular

  const b = (n * sumTV - sumT * sumV) / denom;
  const a = (sumV - b * sumT) / n;
  const futureT = (history[history.length - 1].ts - t0) / 1000 + horizonMs / 1000;
  return a + b * futureT;
}

function getThresholds() {
  // Read live from control-logic's DEFAULT_CONFIG on every call so a
  // future threshold change is picked up without redeploying the server
  // (require cache holds the object reference; updates flow through).
  return {
    overheat: CONTROL_DEFAULTS.overheatDrainTemp,
    freeze: CONTROL_DEFAULTS.freezeDrainTemp,
  };
}

// ── Data freshness ──

function isDataFresh() {
  if (lastEvaluateTs === 0) return false;
  return (Date.now() - lastEvaluateTs) < DATA_STALE_MS;
}

// ── State evaluation ──
// Called by mqtt-bridge on each greenhouse/state message.

function evaluate(payload) {
  if (!pushRef) return;

  const now = Date.now();
  lastEvaluateTs = now;

  // ── Online recovery tracking ──
  // If we were offline and data is now arriving, start the recovery timer.
  if (offlineSince > 0 && offlineNotified) {
    if (onlineSince === 0) {
      onlineSince = now;
      onlineNotified = false;
      log.info('controller data resumed, tracking recovery');
    }
  } else if (offlineSince > 0 && !offlineNotified) {
    // Data arrived before the 15-min offline threshold — cancel the offline state
    offlineSince = 0;
  }

  const temps = payload.temps || {};

  // Update temperature histories
  if (typeof temps.tank_top === 'number') {
    addSample(tankTempHistory, now, temps.tank_top);
  }
  if (typeof temps.outdoor === 'number') {
    addSample(outdoorTempHistory, now, temps.outdoor);
  }
  if (typeof temps.collector === 'number') {
    addSample(collectorTempHistory, now, temps.collector);
  }

  // Track mode for reports. payload.mode is lowercase (the device
  // lowercases it in buildStatePayload before publishing).
  const mode = payload.mode || null;
  if (lastModeCheckTs > 0 && mode && lastMode) {
    const elapsed = (now - lastModeCheckTs) / 60000; // minutes
    if (HEATING_MODES[lastMode]) {
      nightHeatingMinutes += elapsed;
    }
  }
  lastMode = mode;
  lastModeCheckTs = now;

  // Tank-energy deltas: positive → gathered, negative → bucketed by the
  // mode that was active during the drop (heating vs. quiet leakage).
  // The drop is credited to the current sample's mode; state frames
  // arrive every few seconds so a single delta straddling a mode change
  // biases at most ~1 frame's worth of energy the wrong way.
  if (typeof temps.tank_top === 'number' && typeof temps.tank_bottom === 'number') {
    const avgTankC = (temps.tank_top + temps.tank_bottom) / 2;
    const currentKwh = tankStoredEnergyKwh(avgTankC);
    if (lastTankEnergyKwh !== null) {
      const delta = currentKwh - lastTankEnergyKwh;
      if (delta > 0) {
        dailyEnergyWh += delta * 1000;
      } else if (delta < 0) {
        const lossWh = -delta * 1000;
        if (HEATING_MODES[lastMode]) {
          dailyHeatingLossWh += lossWh;
          nightHeatingLossWh += lossWh;
        } else {
          dailyLeakageLossWh += lossWh;
          nightLeakageLossWh += lossWh;
        }
      }
    }
    lastTankEnergyKwh = currentKwh;
  }

  // ── Pre-emergency alerts (only with fresh data) ──
  // Drained collectors hold no water, so neither the freeze drain nor
  // the overheat drain (which both circulate fluid through the
  // collector loop) can fire. Suppressing the predictive warnings
  // avoids cluttering the operator with alerts that reference a
  // physically-impossible action.
  const collectorsDrained = !!(payload.flags && payload.flags.collectors_drained);
  checkOverheatWarning(temps, collectorsDrained);
  checkFreezeWarning(temps, collectorsDrained);

  // ── Scheduled reports (only with fresh data) ──
  checkEveningReport();
  checkNoonReport();
}

// ── Periodic tick ──
// Called every 60s to detect offline/online transitions that can't be
// detected inside evaluate() (because evaluate() isn't called when offline).

function tick() {
  if (!pushRef) return;

  const now = Date.now();

  // ── Offline detection ──
  if (lastEvaluateTs > 0 && (now - lastEvaluateTs) >= DATA_STALE_MS) {
    // Data is stale — controller may be offline
    if (offlineSince === 0) {
      offlineSince = lastEvaluateTs; // mark the start of the outage
      onlineSince = 0;
      onlineNotified = false;
    }

    // Send offline notification after 15 minutes of no data
    if (!offlineNotified && (now - offlineSince) >= OFFLINE_THRESHOLD_MS) {
      offlineNotified = true;
      const offlineMin = Math.round((now - offlineSince) / 60000);
      pushRef.sendNotification('offline_warning', {
        title: 'Controller Offline',
        body: 'No data received from the greenhouse controller for ' + offlineMin + ' minutes.',
        tag: 'offline-warning',
        icon: pushRef.iconFor('offline_warning'),
        url: '/#status',
      });
      log.info('sent offline notification', { offlineMinutes: offlineMin });
    }
  }

  // ── Online recovery ──
  // If data resumed after we sent an offline notification, and it's been
  // flowing steadily for 15 minutes, send a recovery notification.
  if (onlineSince > 0 && !onlineNotified && isDataFresh()) {
    if ((now - onlineSince) >= OFFLINE_THRESHOLD_MS) {
      onlineNotified = true;
      const offlineDuration = Math.round((onlineSince - offlineSince) / 60000);
      pushRef.sendNotification('offline_warning', {
        title: 'Controller Back Online',
        body: 'The greenhouse controller is back online after ' + offlineDuration + ' minutes.',
        tag: 'online-recovery',
        icon: pushRef.iconFor('offline_warning'),
        url: '/#status',
      });
      log.info('sent online recovery notification', { offlineMinutes: offlineDuration });
      // Reset offline tracking
      offlineSince = 0;
      offlineNotified = false;
      onlineSince = 0;
    }
  }
}

function checkOverheatWarning(temps, collectorsDrained) {
  if (collectorsDrained) return;
  if (typeof temps.tank_top !== 'number') return;
  const thresholds = getThresholds();
  const current = temps.tank_top;

  // Already past threshold — control logic handles it, no need for warning
  if (current >= thresholds.overheat) return;

  const predicted = predictValue(tankTempHistory, PREDICTION_HORIZON_MS);
  if (predicted === null) return;

  if (predicted >= thresholds.overheat && current >= thresholds.overheat - 10) {
    pushRef.sendNotification('overheat_warning', {
      title: 'Overheat Warning',
      body: 'Tank temperature is ' + current.toFixed(1) + '\u00b0C and rising. ' +
            'Overheat drain may activate at ' + thresholds.overheat + '\u00b0C.',
      tag: 'overheat-warning',
      icon: pushRef.iconFor('overheat_warning'),
      url: '/#status',
    });
  }
}

function checkFreezeWarning(temps, collectorsDrained) {
  if (collectorsDrained) return;
  // Match control-logic's trigger: whichever of outdoor/collector is
  // colder drives the drain. On clear nights the sky-facing collector
  // reads several K below sheltered ambient, so warning on outdoor
  // alone is too late.
  const thresholds = getThresholds();
  const outdoor = typeof temps.outdoor === 'number' ? temps.outdoor : null;
  const collector = typeof temps.collector === 'number' ? temps.collector : null;
  if (outdoor === null && collector === null) return;

  let current = outdoor;
  let history = outdoorTempHistory;
  let label = 'Outdoor';
  if (collector !== null && (current === null || collector < current)) {
    current = collector;
    history = collectorTempHistory;
    label = 'Collector';
  }

  // Already past threshold
  if (current <= thresholds.freeze) return;

  const predicted = predictValue(history, PREDICTION_HORIZON_MS);
  if (predicted === null) return;

  if (predicted <= thresholds.freeze && current <= thresholds.freeze + 5) {
    pushRef.sendNotification('freeze_warning', {
      title: 'Freeze Warning',
      body: label + ' temperature is ' + current.toFixed(1) + '\u00b0C and falling. ' +
            'Freeze drain may activate at ' + thresholds.freeze + '\u00b0C.',
      tag: 'freeze-warning',
      icon: pushRef.iconFor('freeze_warning'),
      url: '/#status',
    });
  }
}

// True if the operator has permanently banned GREENHOUSE_HEATING via the
// device config — i.e. greenhouse heating is intentionally off. The short
// code for GH is 'GH' and `wb` uses WB_PERMANENT_SENTINEL (9999999999) for
// indefinite bans; any timestamp >1 day in the future counts as disabled
// from the notification's point of view.
function isHeatingDisabled() {
  if (!deviceConfigRef || typeof deviceConfigRef.getConfig !== 'function') return false;
  const cfg = deviceConfigRef.getConfig();
  if (!cfg || !cfg.wb) return false;
  const until = cfg.wb.GH;
  if (!until) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return until > nowSec + 86400;
}

function fmtKwh(wh) { return (Math.round(wh) / 1000).toFixed(1); }

// Threshold below which we treat an accumulator as "held steady" and don't
// mention it. 50 Wh = 0.05 kWh, which rounds to 0.1 at display resolution.
const KWH_NOISE_FLOOR_WH = 50;

function buildEveningBody(gatheredWh, heatingLossWh, leakageLossWh) {
  const gained = gatheredWh >= KWH_NOISE_FLOOR_WH;
  const heating = heatingLossWh >= KWH_NOISE_FLOOR_WH;
  const leakage = leakageLossWh >= KWH_NOISE_FLOOR_WH;
  const netWh = gatheredWh - heatingLossWh - leakageLossWh;
  const netSign = netWh >= 0 ? '+' : '−';
  const netAbs = fmtKwh(Math.abs(netWh));

  if (!gained) {
    if (!heating && !leakage) return 'Tank energy held steady today.';
    if (heating && leakage) {
      return 'No solar gain today. The greenhouse drew ' + fmtKwh(heatingLossWh) +
        ' kWh from the tank; another ' + fmtKwh(leakageLossWh) + ' kWh slipped to air.';
    }
    if (heating) {
      return 'No solar gain today. The greenhouse drew ' + fmtKwh(heatingLossWh) +
        ' kWh from the tank.';
    }
    return 'No solar gain today. The tank released ' + fmtKwh(leakageLossWh) + ' kWh to air.';
  }

  // We gathered something.
  if (!heating && !leakage) {
    return 'Today your collectors gathered ' + fmtKwh(gatheredWh) + ' kWh. The tank is holding steady.';
  }
  if (heating && leakage) {
    return 'Today your collectors gathered ' + fmtKwh(gatheredWh) +
      ' kWh. The greenhouse drew ' + fmtKwh(heatingLossWh) + ' kWh of warmth, ' +
      fmtKwh(leakageLossWh) + ' kWh slipped to air (net ' + netSign + netAbs + ' kWh).';
  }
  if (heating) {
    return 'Today your collectors gathered ' + fmtKwh(gatheredWh) +
      ' kWh. The greenhouse drew ' + fmtKwh(heatingLossWh) +
      ' kWh of warmth (net ' + netSign + netAbs + ' kWh).';
  }
  return 'Today your collectors gathered ' + fmtKwh(gatheredWh) +
    ' kWh. ' + fmtKwh(leakageLossWh) + ' kWh slipped to air since peak (net ' +
    netSign + netAbs + ' kWh).';
}

function buildNoonBody(minutes, heatingLossWh, leakageLossWh, heatingDisabled) {
  const heating = heatingLossWh >= KWH_NOISE_FLOOR_WH;
  const leakage = leakageLossWh >= KWH_NOISE_FLOOR_WH;

  if (heatingDisabled) {
    if (!leakage) return 'Greenhouse heating is resting. The tank held steady overnight.';
    return 'Greenhouse heating is resting. Overnight the tank released ' +
      fmtKwh(leakageLossWh) + ' kWh to air.';
  }

  if (minutes > 0) {
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;
    const duration = hrs > 0 ? hrs + 'h ' + mins + 'min' : mins + ' minutes';
    const tail = heating
      ? ' — ' + fmtKwh(heatingLossWh) + ' kWh delivered' +
        (leakage ? ', ' + fmtKwh(leakageLossWh) + ' kWh slipped to air' : '') + '.'
      : '.';
    return 'Overnight the greenhouse drew warmth for ' + duration + tail;
  }

  if (!leakage) return 'No heating was needed overnight. The greenhouse stayed warm.';
  return 'No heating was needed overnight. The tank released ' +
    fmtKwh(leakageLossWh) + ' kWh to air.';
}

function checkEveningReport() {
  if (!isDataFresh()) return;

  const hour = getLocalHour();
  const day = getDayOfYear();

  // Send between 20:00 and 20:59 local time, once per day
  if (hour !== 20 || day === lastEveningReport) return;

  lastEveningReport = day;

  sendEveningReport(Date.now());
}

function sendEveningReport(now) {
  function dispatch(stats) {
    pushRef.sendNotification('evening_report', {
      title: 'Daily Solar Report',
      body: buildEveningBody(stats.gatheredWh, stats.heatingLossWh, stats.leakageLossWh),
      tag: 'evening-report',
      icon: pushRef.iconFor('evening_report'),
      url: '/#status',
    });

    // Reset daily counters. Keep lastTankEnergyKwh so the next sample
    // doesn't treat the reset as a huge "gain" on re-accumulation.
    dailyEnergyWh = 0;
    dailyHeatingLossWh = 0;
    dailyLeakageLossWh = 0;
  }

  // Same DB-first strategy as the noon report. The in-memory daily*
  // accumulators are still maintained as a fallback when the database
  // is unreachable.
  if (dbRef) {
    computeDailyStats(dbRef, now, function (err, stats) {
      if (err) {
        log.warn('evening report: DB query failed, falling back to live accumulators', { error: err.message });
        dispatch({
          gatheredWh: dailyEnergyWh,
          heatingLossWh: dailyHeatingLossWh,
          leakageLossWh: dailyLeakageLossWh,
        });
      } else {
        dispatch(stats);
      }
    });
  } else {
    dispatch({
      gatheredWh: dailyEnergyWh,
      heatingLossWh: dailyHeatingLossWh,
      leakageLossWh: dailyLeakageLossWh,
    });
  }
}

function checkNoonReport() {
  if (!isDataFresh()) return;

  const hour = getLocalHour();
  const day = getDayOfYear();

  // Send between 12:00 and 12:59 local time, once per day
  if (hour !== 12 || day === lastNoonReport) return;

  lastNoonReport = day;

  sendNoonReport(Date.now());
}

function sendNoonReport(now) {
  function dispatch(stats) {
    pushRef.sendNotification('noon_report', {
      title: 'Overnight Heating Report',
      body: buildNoonBody(stats.durationMinutes, stats.heatingLossWh, stats.leakageLossWh, isHeatingDisabled()),
      tag: 'noon-report',
      icon: pushRef.iconFor('noon_report'),
      url: '/#status',
    });

    // Reset live accumulators (they are no longer the report's source
    // of truth, but we keep them to avoid a one-off jump on the next
    // evening report).
    nightHeatingMinutes = 0;
    nightHeatingLossWh = 0;
    nightLeakageLossWh = 0;
  }

  // Prefer the durable database history. The in-memory accumulators
  // are wiped on every server restart, which produced "no heating
  // needed" notifications even after a long heating night when the
  // server happened to redeploy that morning. The database survives
  // restarts and is the same source the in-app balance card draws
  // from, so the notification now matches the UI.
  if (dbRef) {
    computeOvernightStats(dbRef, now, function (err, stats) {
      if (err) {
        log.warn('noon report: DB query failed, falling back to live accumulators', { error: err.message });
        dispatch({
          durationMinutes: Math.round(nightHeatingMinutes),
          heatingLossWh: nightHeatingLossWh,
          leakageLossWh: nightLeakageLossWh,
        });
      } else {
        dispatch(stats);
      }
    });
  } else {
    dispatch({
      durationMinutes: Math.round(nightHeatingMinutes),
      heatingLossWh: nightHeatingLossWh,
      leakageLossWh: nightLeakageLossWh,
    });
  }
}

// Compute overnight heating stats from durable history. Called from
// checkNoonReport at noon to summarise the night that just ended,
// independently of in-memory accumulators that get wiped on restart.
//
// Window: last 18 h. At 12:00 local that reaches back to ~18:00 the
// previous evening, capturing the full night plus pre-sunset leakage.
// We don't try to identify the precise sunset/sunrise transition —
// any positive solar deltas in the window are not reported anyway
// (only heating loss and leakage are).
const OVERNIGHT_WINDOW_MS = 18 * 3600 * 1000;

function computeOvernightStats(db, now, callback) {
  if (!db || typeof db.getHistory !== 'function' || typeof db.getEvents !== 'function') {
    callback(new Error('db_unavailable'));
    return;
  }
  db.getHistory('24h', null, function (hErr, points) {
    if (hErr) { callback(hErr); return; }
    db.getEvents('24h', 'mode', function (eErr, events) {
      if (eErr) { callback(eErr); return; }
      try {
        callback(null, computeOvernightFromHistory(points || [], events || [], now));
      } catch (e) {
        callback(e);
      }
    });
  });
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

// Daily stats for the 20:00 evening report — same brittleness story as
// computeOvernightStats: in-memory daily* accumulators reset on every
// server restart, so a redeploy mid-afternoon would silently truncate
// the report. Window = last 24 h, matching the cadence between evening
// reports.
const DAILY_WINDOW_MS = 24 * 3600 * 1000;

function computeDailyStats(db, now, callback) {
  if (!db || typeof db.getHistory !== 'function' || typeof db.getEvents !== 'function') {
    callback(new Error('db_unavailable'));
    return;
  }
  db.getHistory('24h', null, function (hErr, points) {
    if (hErr) { callback(hErr); return; }
    db.getEvents('24h', 'mode', function (eErr, events) {
      if (eErr) { callback(eErr); return; }
      try {
        callback(null, computeDailyFromHistory(points || [], events || [], now));
      } catch (e) {
        callback(e);
      }
    });
  });
}

function computeDailyFromHistory(points, events, now) {
  const windowStart = now - DAILY_WINDOW_MS;
  const modeEvents = sortModeEvents(events);
  return bucketEnergyByMode(points, modeEvents, windowStart);
}

// ── Lifecycle ──

function init(options) {
  pushRef = options.push || null;
  deviceConfigRef = options.deviceConfig || null;
  dbRef = options.db || null;
  // Start periodic tick for offline/online detection.
  // .unref() prevents the timer from keeping the event loop alive when
  // the process is otherwise idle (e.g. in tests that don't call stop()).
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(tick, 60000);
  if (tickTimer.unref) tickTimer.unref();
}

function stop() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

function _reset() {
  stop();
  pushRef = null;
  deviceConfigRef = null;
  dbRef = null;
  tankTempHistory = [];
  outdoorTempHistory = [];
  collectorTempHistory = [];
  lastEvaluateTs = 0;
  offlineSince = 0;
  offlineNotified = false;
  onlineSince = 0;
  onlineNotified = false;
  lastEveningReport = 0;
  lastNoonReport = 0;
  dailyEnergyWh = 0;
  dailyHeatingLossWh = 0;
  dailyLeakageLossWh = 0;
  nightHeatingLossWh = 0;
  nightLeakageLossWh = 0;
  lastTankEnergyKwh = null;
  nightHeatingMinutes = 0;
  lastModeCheckTs = 0;
  lastMode = null;
}

module.exports = {
  init,
  stop,
  evaluate,
  tick,
  isDataFresh,
  predictValue,
  addSample,
  _reset,
  PREDICTION_HORIZON_MS,
  OFFLINE_THRESHOLD_MS,
  DATA_STALE_MS,
  // Exposed for testing
  _getTankHistory: function () { return tankTempHistory; },
  _getOutdoorHistory: function () { return outdoorTempHistory; },
  _setTankHistory: function (h) { tankTempHistory = h; },
  _setOutdoorHistory: function (h) { outdoorTempHistory = h; },
  _setDailyEnergyWh: function (v) { dailyEnergyWh = v; },
  _getDailyEnergyWh: function () { return dailyEnergyWh; },
  _setDailyHeatingLossWh: function (v) { dailyHeatingLossWh = v; },
  _getDailyHeatingLossWh: function () { return dailyHeatingLossWh; },
  _setDailyLeakageLossWh: function (v) { dailyLeakageLossWh = v; },
  _getDailyLeakageLossWh: function () { return dailyLeakageLossWh; },
  _setNightHeatingLossWh: function (v) { nightHeatingLossWh = v; },
  _getNightHeatingLossWh: function () { return nightHeatingLossWh; },
  _setNightLeakageLossWh: function (v) { nightLeakageLossWh = v; },
  _getNightLeakageLossWh: function () { return nightLeakageLossWh; },
  _setNightHeatingMinutes: function (v) { nightHeatingMinutes = v; },
  _getNightHeatingMinutes: function () { return nightHeatingMinutes; },
  buildEveningBody,
  buildNoonBody,
  computeOvernightStats,
  computeOvernightFromHistory,
  computeDailyStats,
  computeDailyFromHistory,
  _setLastEveningReport: function (v) { lastEveningReport = v; },
  _setLastNoonReport: function (v) { lastNoonReport = v; },
  _setLastEvaluateTs: function (v) { lastEvaluateTs = v; },
  _getLastEvaluateTs: function () { return lastEvaluateTs; },
  _setOfflineSince: function (v) { offlineSince = v; },
  _getOfflineSince: function () { return offlineSince; },
  _setOfflineNotified: function (v) { offlineNotified = v; },
  _getOfflineNotified: function () { return offlineNotified; },
  _setOnlineSince: function (v) { onlineSince = v; },
  _getOnlineSince: function () { return onlineSince; },
  _setOnlineNotified: function (v) { onlineNotified = v; },
  _getOnlineNotified: function () { return onlineNotified; },
};
