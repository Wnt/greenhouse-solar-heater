/**
 * Server-side valve state poller.
 * Polls the Shelly controller via HTTP GET (Script.Eval) at a regular interval.
 * Detects valve state changes and calls onChange callback.
 *
 * Environment variables:
 *   CONTROLLER_IP        - Shelly Pro 4PM IP address (required)
 *   CONTROLLER_SCRIPT_ID - Script slot ID (default: 1)
 *   POLL_INTERVAL_MS     - Poll interval in ms (default: 10000)
 */

var http = require('http');

var interval = null;
var previousState = null;

function getConfig() {
  return {
    host: process.env.CONTROLLER_IP || '',
    scriptId: parseInt(process.env.CONTROLLER_SCRIPT_ID || '1', 10),
    intervalMs: parseInt(process.env.POLL_INTERVAL_MS || '10000', 10),
  };
}

/**
 * Poll the Shelly controller for valve status.
 * @param {string} host - Controller IP
 * @param {number} scriptId - Script slot ID
 * @param {function} callback - callback(err, status)
 */
function pollController(host, scriptId, callback) {
  var url = 'http://' + host + '/rpc/Script.Eval?id=' + scriptId + '&code=getStatus()';

  var req = http.get(url, { timeout: 5000 }, function (res) {
    var body = '';
    res.on('data', function (chunk) { body += chunk; });
    res.on('end', function () {
      try {
        var raw = JSON.parse(body);
        if (raw && raw.result !== undefined) {
          var status = JSON.parse(raw.result);
          callback(null, status);
        } else {
          callback(new Error('Invalid Script.Eval response'));
        }
      } catch (e) {
        callback(new Error('Failed to parse response: ' + e.message));
      }
    });
  });

  req.on('error', function (err) {
    callback(err);
  });

  req.on('timeout', function () {
    req.destroy();
    callback(new Error('Request timed out'));
  });
}

/**
 * Extract valve state from controller status object.
 * @param {object} status - Status from Script.Eval getStatus()
 * @returns {{ v1: boolean, v2: boolean, mode: string }}
 */
function extractValveState(status) {
  var v1 = status.valves && status.valves.v1 ? status.valves.v1.output : false;
  var v2 = status.valves && status.valves.v2 ? status.valves.v2.output : false;
  var mode = status.override && status.override.active ? 'override' : 'auto';
  return { v1: v1, v2: v2, mode: mode };
}

/**
 * Compare two valve states and return changes.
 * @param {object} prev - Previous state
 * @param {object} curr - Current state
 * @returns {Array<{valve: string, state: string, mode: string, timestamp: string}>}
 */
function detectChanges(prev, curr) {
  var changes = [];
  var now = new Date().toISOString();
  if (prev.v1 !== curr.v1) {
    changes.push({ valve: 'v1', state: curr.v1 ? 'open' : 'closed', mode: curr.mode, timestamp: now });
  }
  if (prev.v2 !== curr.v2) {
    changes.push({ valve: 'v2', state: curr.v2 ? 'open' : 'closed', mode: curr.mode, timestamp: now });
  }
  return changes;
}

/**
 * Start polling the controller for valve state changes.
 * @param {function} onChange - Called with {valve, state, mode, timestamp} for each change
 * @param {function} [onError] - Called with error on poll failure
 * @returns {boolean} true if polling started, false if CONTROLLER_IP not set
 */
function start(onChange, onError) {
  var config = getConfig();
  if (!config.host) {
    return false;
  }

  previousState = null;

  function poll() {
    pollController(config.host, config.scriptId, function (err, status) {
      if (err) {
        if (onError) onError(err);
        return; // retain previous state, skip comparison
      }
      var current = extractValveState(status);
      if (previousState === null) {
        // First poll — store baseline, no notification
        previousState = current;
        return;
      }
      var changes = detectChanges(previousState, current);
      for (var i = 0; i < changes.length; i++) {
        onChange(changes[i]);
      }
      previousState = current;
    });
  }

  poll();
  interval = setInterval(poll, config.intervalMs);
  return true;
}

/**
 * Stop polling.
 */
function stop() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  previousState = null;
}

// Reset for testing
function _reset() {
  stop();
  previousState = null;
}

module.exports = {
  start: start,
  stop: stop,
  detectChanges: detectChanges,
  extractValveState: extractValveState,
  _reset: _reset,
  // Exposed for testing
  _pollController: pollController,
};
