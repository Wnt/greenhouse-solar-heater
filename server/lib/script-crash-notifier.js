/**
 * Bridges the script-monitor's status callback to the push module.
 *
 * Fires a `script_crash` push notification on every running → not-running
 * transition (or the first observed not-running poll if we boot into a
 * crashed state) and clears the per-type rate limit on recovery so a
 * crash → recovery → crash sequence within the 1 h window still notifies
 * the second time.
 *
 * The callback shape matches script-monitor.onStatusChange — keep this
 * module dumb so the wiring in server.js is a single line.
 */

'use strict';

const createLogger = require('./logger');
const log = createLogger('script-crash-notifier');

function truncate(str, max) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

function buildPayload(status) {
  const errMsg = truncate(status.error_msg || 'Unknown error', 140);
  return {
    title: 'Control script crashed',
    body: errMsg + ' — the control loop is stopped.',
    tag: 'script-crash-' + (status.crashId != null ? status.crashId : 'unknown'),
    icon: 'assets/notif-script-crash.png',
    badge: 'assets/badge-72.png',
    url: '/#status',
    requireInteraction: true,
    renotify: true,
    actions: [
      { action: 'restart', type: 'button', title: 'Restart script' },
    ],
    data: {
      kind: 'script_crash',
      crashId: status.crashId || null,
      url: '/#status',
    },
  };
}

// Critical alert when reactive auto-restart has given up: the control
// loop is stopped and won't come back on its own — a human must act before
// the collector stagnates. Always delivered (force + ignore rate limit).
function buildCriticalPayload(status) {
  const attempts = (status.autoRestart && status.autoRestart.attempts) || 0;
  return {
    title: 'Control system DOWN — action needed',
    body: 'Automatic restart failed after ' + attempts + ' attempt'
      + (attempts === 1 ? '' : 's')
      + '. The controller is stopped and the collector can overheat — restart it now.',
    tag: 'script-crash-critical-' + (status.crashId != null ? status.crashId : 'unknown'),
    icon: 'assets/notif-script-crash.png',
    badge: 'assets/badge-72.png',
    url: '/#status',
    requireInteraction: true,
    renotify: true,
    actions: [
      { action: 'restart', type: 'button', title: 'Restart script' },
    ],
    data: { kind: 'script_crash_critical', crashId: status.crashId || null, url: '/#status' },
  };
}

// Returns a function suitable for scriptMonitor.onStatusChange(). The
// closure tracks the previous `running` and `exhausted` values so we only
// fire on real transitions, not on every poll.
function createScriptCrashNotifier(push) {
  let prevRunning = null;    // null = no observation yet
  let prevExhausted = false;
  return function onStatusChange(status) {
    const isRunning = status.running;
    const wasRunning = prevRunning;
    prevRunning = isRunning;

    // Critical escalation — fire once on the false → true edge, independent
    // of running transitions. Bypasses opt-in AND the rate limit so it can
    // never be suppressed by an earlier crash notification.
    const exhausted = !!(status.autoRestart && status.autoRestart.exhausted);
    const wasExhausted = prevExhausted;
    prevExhausted = exhausted;
    if (exhausted && !wasExhausted) {
      push.sendNotification('script_crash', buildCriticalPayload(status), { force: true, ignoreRateLimit: true });
      log.error('auto-restart exhausted — sent critical push');
    }

    if (isRunning === true) {
      // Recovery (or first observation that's healthy). Reset the rate-
      // limit slot so the next crash within an hour still fires.
      if (wasRunning === false) {
        push.clearRateLimit('script_crash');
        log.info('script recovered, rate-limit cleared');
      }
      return;
    }

    if (isRunning !== false) return; // null / unknown — wait for next poll

    // Only fire on transition into not-running. If we were already
    // observed not-running, the script-monitor already wrote the crash
    // row on the original transition; the listener fires again on
    // every poll while down (script-monitor.emitStatus()) and we must
    // not push on each poll. Forced: control-script-down is safety-
    // critical, so deliver regardless of the per-category opt-in.
    const justCrashed = wasRunning === true || wasRunning === null;
    if (!justCrashed) return;

    push.sendNotification('script_crash', buildPayload(status), { force: true });
  };
}

module.exports = { createScriptCrashNotifier, buildPayload, buildCriticalPayload };
