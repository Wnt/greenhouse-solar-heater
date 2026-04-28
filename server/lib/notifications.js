// Notification engine. Evaluates state for overheat/freeze trends,
// daily/overnight reports, and offline transitions, then dispatches
// through the push module (which rate-limits to 1/type/hour).

const createLogger = require('./logger');
const log = createLogger('notifications');

// Pull thresholds from control-logic so the notification body always
// matches what the device actually does (freeze 4°C, overheat 95°C).
const CONTROL_DEFAULTS = require('../../shelly/control-logic.js').DEFAULT_CONFIG;

const {
  HEATING_MODES,
  tankStoredEnergyKwh,
  computeOvernightStats,
  computeDailyStats,
} = require('./energy-balance.js');

let pushRef = null;
let deviceConfigRef = null;
let dbRef = null;

let tankTempHistory = [];
let outdoorTempHistory = [];
let collectorTempHistory = [];
const HISTORY_WINDOW_MS = 10 * 60 * 1000;
const PREDICTION_HORIZON_MS = 15 * 60 * 1000;

const DATA_STALE_MS = 2 * 60 * 1000;
let lastEvaluateTs = 0;

const OFFLINE_THRESHOLD_MS = 15 * 60 * 1000;
let offlineSince = 0;
let offlineNotified = false;
let onlineSince = 0;
let onlineNotified = false;
let tickTimer = null;

// Day-of-year of last send so we don't double-fire in the same window.
let lastEveningReport = 0;
let lastNoonReport = 0;
// Daily accumulators reset after each evening report. Negative tank-
// energy deltas while mode is GREENHOUSE_HEATING or EMERGENCY_HEATING
// count as heating losses; otherwise leakage. Positive deltas count as
// gathered. Same Status-view formula:
// 300 L · 4.186 kJ/kg·K · max(0, avgTank − 12 °C) / 3600.
let dailyEnergyWh = 0;
let dailyHeatingLossWh = 0;
let dailyLeakageLossWh = 0;
let nightHeatingLossWh = 0;
let nightLeakageLossWh = 0;
let lastTankEnergyKwh = null;
let nightHeatingMinutes = 0;
let lastModeCheckTs = 0;
let lastMode = null;

// Approximate Finland local hour: UTC+2 winter, UTC+3 summer (Mar-Oct).
function getLocalHour() {
  const now = new Date();
  const month = now.getUTCMonth();
  const isDST = month >= 2 && month <= 9;
  const offset = isDST ? 3 : 2;
  return (now.getUTCHours() + offset) % 24;
}

function getDayOfYear() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now - start;
  return Math.floor(diff / 86400000);
}

function addSample(history, ts, value) {
  history.push({ ts, value });
  const cutoff = ts - HISTORY_WINDOW_MS;
  while (history.length > 0 && history[0].ts < cutoff) {
    history.shift();
  }
}

// Linear regression to predict value at horizonMs ahead. Returns null
// if fewer than 2 samples or span < 60s.
function predictValue(history, horizonMs) {
  if (history.length < 2) return null;
  const span = history[history.length - 1].ts - history[0].ts;
  if (span < 60000) return null;

  const n = history.length;
  let sumT = 0, sumV = 0, sumTV = 0, sumTT = 0;
  const t0 = history[0].ts;
  for (let i = 0; i < n; i++) {
    const t = (history[i].ts - t0) / 1000;
    const v = history[i].value;
    sumT += t;
    sumV += v;
    sumTV += t * v;
    sumTT += t * t;
  }
  const denom = n * sumTT - sumT * sumT;
  if (Math.abs(denom) < 0.001) return null;

  const b = (n * sumTV - sumT * sumV) / denom;
  const a = (sumV - b * sumT) / n;
  const futureT = (history[history.length - 1].ts - t0) / 1000 + horizonMs / 1000;
  return a + b * futureT;
}

function getThresholds() {
  return {
    overheat: CONTROL_DEFAULTS.overheatDrainTemp,
    freeze: CONTROL_DEFAULTS.freezeDrainTemp,
  };
}

function isDataFresh() {
  if (lastEvaluateTs === 0) return false;
  return (Date.now() - lastEvaluateTs) < DATA_STALE_MS;
}

// Called by mqtt-bridge on each greenhouse/state message.
function evaluate(payload) {
  if (!pushRef) return;

  const now = Date.now();
  lastEvaluateTs = now;

  if (offlineSince > 0 && offlineNotified) {
    if (onlineSince === 0) {
      onlineSince = now;
      onlineNotified = false;
      log.info('controller data resumed, tracking recovery');
    }
  } else if (offlineSince > 0 && !offlineNotified) {
    // Data arrived before the 15-min threshold — cancel the offline state.
    offlineSince = 0;
  }

  const temps = payload.temps || {};

  if (typeof temps.tank_top === 'number') {
    addSample(tankTempHistory, now, temps.tank_top);
  }
  if (typeof temps.outdoor === 'number') {
    addSample(outdoorTempHistory, now, temps.outdoor);
  }
  if (typeof temps.collector === 'number') {
    addSample(collectorTempHistory, now, temps.collector);
  }

  const mode = payload.mode || null;
  if (lastModeCheckTs > 0 && mode && lastMode) {
    const elapsed = (now - lastModeCheckTs) / 60000;
    if (HEATING_MODES[lastMode]) {
      nightHeatingMinutes += elapsed;
    }
  }
  lastMode = mode;
  lastModeCheckTs = now;

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

  // Predictive warnings are pointless when the collectors are drained —
  // there's no water to circulate, so neither the freeze nor the
  // overheat drain can fire.
  const collectorsDrained = !!(payload.flags && payload.flags.collectors_drained);
  checkOverheatWarning(temps, collectorsDrained);
  checkFreezeWarning(temps, collectorsDrained);

  checkEveningReport();
  checkNoonReport();
}

// Runs every 60s to detect offline/online transitions that evaluate()
// can't see (it isn't called while offline).
function tick() {
  if (!pushRef) return;

  const now = Date.now();

  if (lastEvaluateTs > 0 && (now - lastEvaluateTs) >= DATA_STALE_MS) {
    if (offlineSince === 0) {
      offlineSince = lastEvaluateTs;
      onlineSince = 0;
      onlineNotified = false;
    }

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

  // Recovery: 15 min of steady data after an offline notification.
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

  // Past the threshold — control-logic is already draining; warning is moot.
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
  // Trigger on whichever of outdoor/collector is colder — same as
  // control-logic. On clear nights the sky-facing collector reads
  // several K below sheltered ambient, so outdoor alone is too late.
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

// True if GREENHOUSE_HEATING is banned for >1 day — operator has
// intentionally turned it off via the device config.
function isHeatingDisabled() {
  if (!deviceConfigRef || typeof deviceConfigRef.getConfig !== 'function') return false;
  const cfg = deviceConfigRef.getConfig();
  if (!cfg || !cfg.wb) return false;
  const until = cfg.wb.GH;
  if (!until) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return until > nowSec + 86400;
}

const { buildEveningBody, buildNoonBody } = require('./notification-bodies.js');

function checkEveningReport() {
  if (!isDataFresh()) return;

  const hour = getLocalHour();
  const day = getDayOfYear();

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

    // Keep lastTankEnergyKwh so the next sample doesn't read the reset
    // as a huge gain on re-accumulation.
    dailyEnergyWh = 0;
    dailyHeatingLossWh = 0;
    dailyLeakageLossWh = 0;
  }

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

    nightHeatingMinutes = 0;
    nightHeatingLossWh = 0;
    nightLeakageLossWh = 0;
  }

  // DB-first: in-memory accumulators are wiped on every server restart,
  // which used to produce "no heating needed" notifications even after
  // a long heating night when the morning included a redeploy.
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

function init(options) {
  pushRef = options.push || null;
  deviceConfigRef = options.deviceConfig || null;
  dbRef = options.db || null;
  // unref() so the tick timer doesn't keep the event loop alive in
  // tests that don't call stop().
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
