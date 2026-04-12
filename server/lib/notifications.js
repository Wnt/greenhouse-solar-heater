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
var dailyEnergyWh = 0;
var nightHeatingMinutes = 0;
var lastModeCheckTs = 0;
var lastMode = null;

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

  // Track mode for reports
  var mode = payload.mode || null;
  if (lastModeCheckTs > 0 && mode && lastMode) {
    var elapsed = (now - lastModeCheckTs) / 60000; // minutes
    if (mode === 'SOLAR_CHARGING') {
      // Estimate energy: rough approximation from pump runtime
      // ~2kW thermal power when solar charging
      dailyEnergyWh += (elapsed / 60) * 2000;
    }
    if (lastMode === 'GREENHOUSE_HEATING' || lastMode === 'EMERGENCY_HEATING') {
      nightHeatingMinutes += elapsed;
    }
  }
  lastMode = mode;
  lastModeCheckTs = now;

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
      url: '/#status',
    });
  }
}

function checkFreezeWarning(temps) {
  if (typeof temps.outdoor !== 'number') return;
  var thresholds = getThresholds();
  var current = temps.outdoor;

  // Already past threshold
  if (current <= thresholds.freeze) return;

  var predicted = predictValue(outdoorTempHistory, PREDICTION_HORIZON_MS);
  if (predicted === null) return;

  if (predicted <= thresholds.freeze && current <= thresholds.freeze + 5) {
    pushRef.sendNotification('freeze_warning', {
      title: 'Freeze Warning',
      body: 'Outdoor temperature is ' + current.toFixed(1) + '\u00b0C and falling. ' +
            'Freeze drain may activate at ' + thresholds.freeze + '\u00b0C.',
      tag: 'freeze-warning',
      url: '/#status',
    });
  }
}

function checkEveningReport() {
  if (!isDataFresh()) return;

  var hour = getLocalHour();
  var day = getDayOfYear();

  // Send between 20:00 and 20:59 local time, once per day
  if (hour !== 20 || day === lastEveningReport) return;

  lastEveningReport = day;
  var energy = Math.round(dailyEnergyWh);
  var kwh = (energy / 1000).toFixed(1);

  pushRef.sendNotification('evening_report', {
    title: 'Daily Solar Report',
    body: 'Today your collectors gathered approximately ' + kwh + ' kWh' +
          ' (' + energy + ' Wh) of thermal energy.',
    tag: 'evening-report',
    url: '/#status',
  });

  // Reset daily counter
  dailyEnergyWh = 0;
}

function checkNoonReport() {
  if (!isDataFresh()) return;

  var hour = getLocalHour();
  var day = getDayOfYear();

  // Send between 12:00 and 12:59 local time, once per day
  if (hour !== 12 || day === lastNoonReport) return;

  lastNoonReport = day;
  var minutes = Math.round(nightHeatingMinutes);

  var body;
  if (minutes > 0) {
    var hrs = Math.floor(minutes / 60);
    var mins = minutes % 60;
    var duration = hrs > 0 ? hrs + 'h ' + mins + 'min' : mins + ' minutes';
    body = 'Overnight the greenhouse heating ran for ' + duration + '.';
  } else {
    body = 'No heating was needed overnight. The greenhouse stayed warm.';
  }

  pushRef.sendNotification('noon_report', {
    title: 'Overnight Heating Report',
    body: body,
    tag: 'noon-report',
    url: '/#status',
  });

  // Reset night counter
  nightHeatingMinutes = 0;
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
  lastEvaluateTs = 0;
  offlineSince = 0;
  offlineNotified = false;
  onlineSince = 0;
  onlineNotified = false;
  lastEveningReport = 0;
  lastNoonReport = 0;
  dailyEnergyWh = 0;
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
  _setNightHeatingMinutes: function (v) { nightHeatingMinutes = v; },
  _getNightHeatingMinutes: function () { return nightHeatingMinutes; },
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
