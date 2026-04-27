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

// Returns a function suitable for scriptMonitor.onStatusChange(). The
// closure tracks the previous `running` value so we only fire on real
// transitions, not on every poll.
function createScriptCrashNotifier(push) {
  let prevRunning = null; // null = no observation yet
  return function onStatusChange(status) {
    const isRunning = status.running;
    const wasRunning = prevRunning;
    prevRunning = isRunning;

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
    // not push on each poll.
    const justCrashed = wasRunning === true || wasRunning === null;
    if (!justCrashed) return;

    push.sendNotification('script_crash', buildPayload(status));
  };
}

module.exports = { createScriptCrashNotifier, buildPayload };
