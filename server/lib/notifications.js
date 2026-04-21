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

var createLogger = require('./logger');
var log = createLogger('notifications');

var pushRef = null;
var deviceConfigRef = null;

// Temperature history buffers for trend prediction
var tankTempHistory = [];    // { ts: ms, value: number }
var outdoorTempHistory = [];
var collectorTempHistory = [];
var HISTORY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes of samples
var PREDICTION_HORIZON_MS = 15 * 60 * 1000; // 15 minutes ahead

// Data freshness: suppress notifications when data is stale
var DATA_STALE_MS = 2 * 60 * 1000; // 2 minutes without data = stale
var lastEvaluateTs = 0;

// Offline/online detection
var OFFLINE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
var offlineSince = 0;      // timestamp when we first detected staleness (0 = not offline)
var offlineNotified = false; // whether we sent the offline notification
var onlineSince = 0;        // timestamp when data resumed after offline (0 = not recovering)
var onlineNotified = false;  // whether we sent the recovery notification
var tickTimer = null;

// Report scheduling state
var lastEveningReport = 0;  // day-of-year when last sent
var lastNoonReport = 0;
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
var dailyEnergyWh = 0;
var dailyHeatingLossWh = 0;
var dailyLeakageLossWh = 0;
// Noon report covers the night just past — separate overnight accumulators
// reset after each noon report.
var nightHeatingLossWh = 0;
var nightLeakageLossWh = 0;
var lastTankEnergyKwh = null; // last observed stored-energy reading
var nightHeatingMinutes = 0;
var lastModeCheckTs = 0;
var lastMode = null;

// Tank energy helper — kept local so the CommonJS notifications module
// doesn't depend on the ES-module physics.js. Must stay in sync with
// tankStoredEnergyKwh() in playground/js/physics.js.
function tankStoredEnergyKwh(avgTankC) {
  if (typeof avgTankC !== 'number' || !isFinite(avgTankC)) return 0;
  var dT = avgTankC - 12;
  if (dT < 0) dT = 0;
  return 300 * 4.186 * dT / 3600;
}

// Timezone offset for Finland (EET = UTC+2, EEST = UTC+3)
// We use a simple approximation: UTC+2 in winter, UTC+3 in summer
function getLocalHour() {
  var now = new Date();
  // Finland DST: last Sunday in March to last Sunday in October
  var month = now.getUTCMonth(); // 0-11
  var isDST = month >= 2 && month <= 9; // approximate Mar-Oct
  var offset = isDST ? 3 : 2;
  return (now.getUTCHours() + offset) % 24;
}

function getDayOfYear() {
  var now = new Date();
  var start = new Date(now.getFullYear(), 0, 0);
  var diff = now - start;
  return Math.floor(diff / 86400000);
}

// ── Temperature trend prediction ──

function addSample(history, ts, value) {
  history.push({ ts: ts, value: value });
  // Trim old samples
  var cutoff = ts - HISTORY_WINDOW_MS;
  while (history.length > 0 && history[0].ts < cutoff) {
    history.shift();
  }
}

// Linear regression to predict value at `horizonMs` in the future.
// Returns null if insufficient data (need at least 2 samples spanning 60s+).
function predictValue(history, horizonMs) {
  if (history.length < 2) return null;
  var span = history[history.length - 1].ts - history[0].ts;
  if (span < 60000) return null; // need at least 60s of data

  // Simple linear regression: y = a + b*t
  var n = history.length;
  var sumT = 0, sumV = 0, sumTV = 0, sumTT = 0;
  var t0 = history[0].ts;
  for (var i = 0; i < n; i++) {
    var t = (history[i].ts - t0) / 1000; // seconds
    var v = history[i].value;
    sumT += t;
    sumV += v;
    sumTV += t * v;
    sumTT += t * t;
  }
  var denom = n * sumTT - sumT * sumT;
  if (Math.abs(denom) < 0.001) return null; // flat or singular

  var b = (n * sumTV - sumT * sumV) / denom;
  var a = (sumV - b * sumT) / n;
  var futureT = (history[history.length - 1].ts - t0) / 1000 + horizonMs / 1000;
  return a + b * futureT;
}

// ── Default thresholds (from control-logic.js DEFAULT_CONFIG) ──
var DEFAULT_OVERHEAT_TEMP = 85;
var DEFAULT_FREEZE_TEMP = 2;

function getThresholds() {
  var cfg = deviceConfigRef ? deviceConfigRef.getConfig() : null;
  // Device config uses compact keys but thresholds are in control-logic defaults.
  // The device config doesn't carry these values — use the fixed defaults.
  return {
    overheat: DEFAULT_OVERHEAT_TEMP,
    freeze: DEFAULT_FREEZE_TEMP,
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

  var now = Date.now();
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

  var temps = payload.temps || {};

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

  // Track mode for reports
  var mode = payload.mode || null;
  if (lastModeCheckTs > 0 && mode && lastMode) {
    var elapsed = (now - lastModeCheckTs) / 60000; // minutes
    if (lastMode === 'GREENHOUSE_HEATING' || lastMode === 'EMERGENCY_HEATING') {
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
    var avgTankC = (temps.tank_top + temps.tank_bottom) / 2;
    var currentKwh = tankStoredEnergyKwh(avgTankC);
    if (lastTankEnergyKwh !== null) {
      var delta = currentKwh - lastTankEnergyKwh;
      if (delta > 0) {
        dailyEnergyWh += delta * 1000;
      } else if (delta < 0) {
        var lossWh = -delta * 1000;
        if (lastMode === 'GREENHOUSE_HEATING' || lastMode === 'EMERGENCY_HEATING') {
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
  checkOverheatWarning(temps);
  checkFreezeWarning(temps);

  // ── Scheduled reports (only with fresh data) ──
  checkEveningReport();
  checkNoonReport();
}

// ── Periodic tick ──
// Called every 60s to detect offline/online transitions that can't be
// detected inside evaluate() (because evaluate() isn't called when offline).

function tick() {
  if (!pushRef) return;

  var now = Date.now();

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
      var offlineMin = Math.round((now - offlineSince) / 60000);
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
      var offlineDuration = Math.round((onlineSince - offlineSince) / 60000);
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

function checkOverheatWarning(temps) {
  if (typeof temps.tank_top !== 'number') return;
  var thresholds = getThresholds();
  var current = temps.tank_top;

  // Already past threshold — control logic handles it, no need for warning
  if (current >= thresholds.overheat) return;

  var predicted = predictValue(tankTempHistory, PREDICTION_HORIZON_MS);
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

function checkFreezeWarning(temps) {
  // Match control-logic's trigger: whichever of outdoor/collector is
  // colder drives the drain. On clear nights the sky-facing collector
  // reads several K below sheltered ambient, so warning on outdoor
  // alone is too late.
  var thresholds = getThresholds();
  var outdoor = typeof temps.outdoor === 'number' ? temps.outdoor : null;
  var collector = typeof temps.collector === 'number' ? temps.collector : null;
  if (outdoor === null && collector === null) return;

  var current = outdoor;
  var history = outdoorTempHistory;
  var label = 'Outdoor';
  if (collector !== null && (current === null || collector < current)) {
    current = collector;
    history = collectorTempHistory;
    label = 'Collector';
  }

  // Already past threshold
  if (current <= thresholds.freeze) return;

  var predicted = predictValue(history, PREDICTION_HORIZON_MS);
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
  var cfg = deviceConfigRef.getConfig();
  if (!cfg || !cfg.wb) return false;
  var until = cfg.wb.GH;
  if (!until) return false;
  var nowSec = Math.floor(Date.now() / 1000);
  return until > nowSec + 86400;
}

function fmtKwh(wh) { return (Math.round(wh) / 1000).toFixed(1); }

// Threshold below which we treat an accumulator as "held steady" and don't
// mention it. 50 Wh = 0.05 kWh, which rounds to 0.1 at display resolution.
var KWH_NOISE_FLOOR_WH = 50;

function buildEveningBody(gatheredWh, heatingLossWh, leakageLossWh) {
  var gained = gatheredWh >= KWH_NOISE_FLOOR_WH;
  var heating = heatingLossWh >= KWH_NOISE_FLOOR_WH;
  var leakage = leakageLossWh >= KWH_NOISE_FLOOR_WH;
  var netWh = gatheredWh - heatingLossWh - leakageLossWh;
  var netSign = netWh >= 0 ? '+' : '−';
  var netAbs = fmtKwh(Math.abs(netWh));

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
  var heating = heatingLossWh >= KWH_NOISE_FLOOR_WH;
  var leakage = leakageLossWh >= KWH_NOISE_FLOOR_WH;

  if (heatingDisabled) {
    if (!leakage) return 'Greenhouse heating is resting. The tank held steady overnight.';
    return 'Greenhouse heating is resting. Overnight the tank released ' +
      fmtKwh(leakageLossWh) + ' kWh to air.';
  }

  if (minutes > 0) {
    var hrs = Math.floor(minutes / 60);
    var mins = minutes % 60;
    var duration = hrs > 0 ? hrs + 'h ' + mins + 'min' : mins + ' minutes';
    var tail = heating
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

  var hour = getLocalHour();
  var day = getDayOfYear();

  // Send between 20:00 and 20:59 local time, once per day
  if (hour !== 20 || day === lastEveningReport) return;

  lastEveningReport = day;

  pushRef.sendNotification('evening_report', {
    title: 'Daily Solar Report',
    body: buildEveningBody(dailyEnergyWh, dailyHeatingLossWh, dailyLeakageLossWh),
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

function checkNoonReport() {
  if (!isDataFresh()) return;

  var hour = getLocalHour();
  var day = getDayOfYear();

  // Send between 12:00 and 12:59 local time, once per day
  if (hour !== 12 || day === lastNoonReport) return;

  lastNoonReport = day;
  var minutes = Math.round(nightHeatingMinutes);

  pushRef.sendNotification('noon_report', {
    title: 'Overnight Heating Report',
    body: buildNoonBody(minutes, nightHeatingLossWh, nightLeakageLossWh, isHeatingDisabled()),
    tag: 'noon-report',
    icon: pushRef.iconFor('noon_report'),
    url: '/#status',
  });

  // Reset night counters
  nightHeatingMinutes = 0;
  nightHeatingLossWh = 0;
  nightLeakageLossWh = 0;
}

// ── Lifecycle ──

function init(options) {
  pushRef = options.push || null;
  deviceConfigRef = options.deviceConfig || null;
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
  init: init,
  stop: stop,
  evaluate: evaluate,
  tick: tick,
  isDataFresh: isDataFresh,
  predictValue: predictValue,
  addSample: addSample,
  _reset: _reset,
  PREDICTION_HORIZON_MS: PREDICTION_HORIZON_MS,
  OFFLINE_THRESHOLD_MS: OFFLINE_THRESHOLD_MS,
  DATA_STALE_MS: DATA_STALE_MS,
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
  buildEveningBody: buildEveningBody,
  buildNoonBody: buildNoonBody,
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
