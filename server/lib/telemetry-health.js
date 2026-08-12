// Corrupt-telemetry tracker for greenhouse/state/min (spec 025, FR-1).
//
// A Pro 4PM whose JsVar pool is starved cannot finish serializing its own
// state snapshot: buildMinPayload emits a truncated string and the server's
// JSON.parse throws. That happened for 10 consecutive publishes on
// 2026-08-12 while the controller silently stopped switching modes and the
// collector stagnated to 71.7 °C. Each failure was a `warn` line nobody saw.
//
// This module turns a *sustained* run of unparseable payloads into exactly
// one operator-visible escalation per episode: an `error` log plus one forced
// web push. A single truncated payload is a transient and stays quiet.
//
// Deliberately dumb and side-effect-free apart from log/push so the wiring in
// mqtt-bridge.js is two calls (recordInvalid / recordValid).

'use strict';

const createLogger = require('./logger');
const defaultLog = createLogger('telemetry-health');

const DEFAULT_THRESHOLD = 3;

function buildPayload(status) {
  return {
    title: 'Controller telemetry corrupt',
    body: status.consecutive + ' consecutive unreadable state publishes — the '
      + 'controller is likely out of memory and may have stopped switching modes.',
    tag: 'telemetry-corrupt-' + (status.firstAt || 0),
    icon: 'assets/notif-script-crash.png',
    badge: 'assets/badge-72.png',
    url: '/#status',
    requireInteraction: true,
    renotify: true,
    data: { kind: 'telemetry_corrupt', url: '/#status' },
  };
}

// @param {object}   [opts.push]      - push module; null/undefined = log only
// @param {number}   [opts.threshold] - consecutive failures before escalating
// @param {object}   [opts.log]       - injectable logger
// @param {function} [opts.now]       - injectable clock (epoch ms)
function createTelemetryHealth(opts) {
  opts = opts || {};
  const push = opts.push || null;
  const threshold = opts.threshold != null ? opts.threshold : DEFAULT_THRESHOLD;
  const log = opts.log || defaultLog;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  let consecutive = 0;
  let total = 0;
  let episodes = 0;
  let firstAt = null;   // start of the current episode
  let lastAt = null;
  let lastError = null;
  let escalated = false; // latched per episode; cleared by recordValid()

  function getStatus() {
    return {
      consecutive,
      total,
      episodes,
      firstAt,
      lastAt,
      lastError,
      escalated,
      threshold,
    };
  }

  function recordInvalid(errMsg) {
    const t = now();
    if (consecutive === 0) firstAt = t;
    consecutive += 1;
    total += 1;
    lastAt = t;
    lastError = errMsg || null;

    if (escalated || consecutive < threshold) return;
    escalated = true;
    episodes += 1;
    const status = getStatus();
    log.error('telemetry corrupt on greenhouse/state/min', {
      consecutive,
      firstAt,
      lastError,
    });
    if (push && typeof push.sendNotification === 'function') {
      // Forced + rate-limit-bypassing for the same reason script_crash is:
      // a controller that has stopped deciding is safety-critical, and the
      // operator must hear about it even with the category opted out.
      push.sendNotification('script_crash', buildPayload(status),
        { force: true, ignoreRateLimit: true });
    }
  }

  function recordValid() {
    if (consecutive === 0) return;
    if (escalated) {
      log.info('telemetry recovered on greenhouse/state/min', {
        badPublishes: consecutive,
      });
    }
    consecutive = 0;
    firstAt = null;
    escalated = false;
  }

  return { recordInvalid, recordValid, getStatus };
}

module.exports = { createTelemetryHealth, buildPayload };
