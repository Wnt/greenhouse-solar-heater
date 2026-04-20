/**
 * Control-script monitor.
 *
 * Polls Script.GetStatus on the Pro 4PM every 30 s. When the script
 * transitions from running to not-running the monitor captures
 *
 *   - the error_msg / error trace from Script.GetStatus
 *   - Sys.GetStatus (ram, uptime, reset_reason)
 *   - a ring buffer of the last N greenhouse/state snapshots from MQTT
 *
 * and writes one row to script_crashes. A single callback fires on every
 * status change so the HTTP/WS layer can push "script down" banners to
 * connected playgrounds without polling their own.
 *
 * Reachability: the Pro 4PM is addressable from the server over the
 * greenhouse VLAN in local mode, and over the openvpn sidecar in cloud
 * mode — both expose it on the same IP:port. CONTROLLER_IP sets the
 * host (defaults to 192.168.30.50, the greenhouse-VLAN DHCP
 * reservation). CONTROLLER_SCRIPT_ID sets the Shelly script slot id
 * (defaults to 1).
 *
 * Adding a new direct-HTTP path here is a deliberate third exception
 * to the MQTT-only rule in CLAUDE.md, joining sensor-discovery /
 * sensor-config/apply. Justification: we need to observe the script's
 * health *when MQTT has gone silent* — if we routed this through MQTT
 * we'd be querying the crashed script's own MQTT subscription.
 */

'use strict';

var http = require('http');
var createLogger = require('./logger');
var log = createLogger('script-monitor');

var DEFAULT_POLL_INTERVAL_MS = 30 * 1000;
var DEFAULT_RPC_TIMEOUT_MS = 5000;
var DEFAULT_RECENT_STATES = 100;

function rpcCall(host, method, params, timeoutMs, callback) {
  var body = JSON.stringify({ id: 1, method: method, params: params || {} });
  var req = http.request({
    host: host,
    port: 80,
    path: '/rpc',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: timeoutMs,
  }, function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () {
      if (res.statusCode !== 200) {
        callback(new Error('HTTP ' + res.statusCode + ' from ' + host));
        return;
      }
      try {
        var parsed = JSON.parse(Buffer.concat(chunks).toString());
        if (parsed.error) { callback(new Error(parsed.error.message || 'rpc_error')); return; }
        callback(null, parsed.result);
      } catch (e) {
        callback(new Error('Invalid JSON from ' + host + ': ' + e.message));
      }
    });
  });
  req.on('error', function (err) { callback(err); });
  req.on('timeout', function () {
    req.destroy();
    callback(new Error('timeout_' + method + '_after_' + timeoutMs + 'ms'));
  });
  req.write(body);
  req.end();
}

function createScriptMonitor(options) {
  options = options || {};
  var host = options.host || process.env.CONTROLLER_IP || '192.168.30.50';
  var scriptId = parseInt(options.scriptId || process.env.CONTROLLER_SCRIPT_ID || '1', 10);
  var pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
  var rpcTimeoutMs = options.rpcTimeoutMs || DEFAULT_RPC_TIMEOUT_MS;
  var bufferSize = options.bufferSize || DEFAULT_RECENT_STATES;
  var db = options.db || null;
  // Injectable so tests can mock the Shelly without real HTTP.
  var rpc = options.rpc || rpcCall;

  var timer = null;
  var inflight = false;
  var recentStates = []; // newest-last
  var lastStatus = {
    running: null,         // true / false / null (unknown)
    checkedAt: null,       // last poll epoch ms
    reachable: false,      // did the last RPC succeed?
    error_msg: null,
    error_trace: null,
    crashId: null,         // set when the latest observed crash produced a DB row
  };
  var statusListeners = [];

  function emitStatus() {
    var snap = getStatus();
    for (var i = 0; i < statusListeners.length; i++) {
      try { statusListeners[i](snap); } catch (e) {
        log.error('status listener threw', { error: e.message });
      }
    }
  }

  function getStatus() {
    return {
      running: lastStatus.running,
      checkedAt: lastStatus.checkedAt,
      reachable: lastStatus.reachable,
      error_msg: lastStatus.error_msg,
      error_trace: lastStatus.error_trace,
      crashId: lastStatus.crashId,
      host: host,
      scriptId: scriptId,
    };
  }

  function onStatusChange(cb) {
    statusListeners.push(cb);
    return function unsubscribe() {
      var idx = statusListeners.indexOf(cb);
      if (idx !== -1) statusListeners.splice(idx, 1);
    };
  }

  function recordStateSnapshot(payload) {
    if (!payload) return;
    // Keep a trimmed view. MQTT payloads can include arbitrary extras —
    // we only need enough to debug a crash.
    var snap = {
      ts: payload.ts || Date.now(),
      mode: payload.mode || null,
      cause: payload.cause || null,
      transitioning: !!payload.transitioning,
      transition_step: payload.transition_step || null,
      temps: payload.temps || null,
      valves: payload.valves || null,
      actuators: payload.actuators || null,
      flags: payload.flags || null,
    };
    recentStates.push(snap);
    if (recentStates.length > bufferSize) {
      recentStates = recentStates.slice(-bufferSize);
    }
  }

  // ── Crash capture ──
  //
  // On the first poll that observes running:false + errors, fetch
  // Sys.GetStatus for context and write one script_crashes row
  // containing the error, sys status, and the snapshot buffer. Until
  // the script comes back up we keep emitting the same crash snapshot
  // to status listeners — no repeated rows per poll cycle.
  function captureCrash(scriptStatus, callback) {
    lastStatus.error_msg = scriptStatus.error_msg || null;
    lastStatus.error_trace = (scriptStatus.errors && scriptStatus.errors.length)
      ? scriptStatus.errors.join('\n')
      : null;

    rpc(host, 'Sys.GetStatus', {}, rpcTimeoutMs, function (sysErr, sysResult) {
      var sysStatus = sysErr ? { error: sysErr.message } : sysResult;
      var row = {
        ts: new Date(),
        error_msg: lastStatus.error_msg,
        error_trace: lastStatus.error_trace,
        sys_status: sysStatus,
        recent_states: recentStates.slice(),
      };
      if (!db || typeof db.insertScriptCrash !== 'function') {
        log.warn('script crash detected but no db — not persisted', {
          error_msg: row.error_msg,
        });
        if (callback) callback(null, null);
        return;
      }
      db.insertScriptCrash(row, function (err, id) {
        if (err) {
          log.error('script crash insert failed', { error: err.message });
          if (callback) callback(err, null);
          return;
        }
        lastStatus.crashId = id;
        log.warn('script crash recorded', { id: id, error: row.error_msg });
        if (callback) callback(null, id);
      });
    });
  }

  function pollOnce(callback) {
    if (inflight) { if (callback) callback(null, getStatus()); return; }
    inflight = true;
    rpc(host, 'Script.GetStatus', { id: scriptId }, rpcTimeoutMs, function (err, result) {
      inflight = false;
      lastStatus.checkedAt = Date.now();
      if (err) {
        var reachabilityChanged = lastStatus.reachable !== false;
        lastStatus.reachable = false;
        if (reachabilityChanged) {
          log.warn('script poll unreachable', { host: host, error: err.message });
          emitStatus();
        }
        if (callback) callback(err, getStatus());
        return;
      }
      lastStatus.reachable = true;
      var wasRunning = lastStatus.running;
      var isRunning = !!result.running;
      lastStatus.running = isRunning;

      if (isRunning) {
        // Clear any stuck crash context when the script is back up. The
        // DB row is preserved; crashId stays pointing at it so the UI
        // can still mark the incident resolved.
        if (wasRunning !== true) {
          lastStatus.error_msg = null;
          lastStatus.error_trace = null;
          lastStatus.crashId = null;
          log.info('script running', { host: host });
          emitStatus();
        }
        if (callback) callback(null, getStatus());
        return;
      }

      // Not running. If we just transitioned from running → crashed, or
      // this is the first poll, persist a new crash row. If we were
      // already observed as not-running, the crashId stays the same.
      var justCrashed = wasRunning === true || (wasRunning === null && lastStatus.crashId === null);
      if (!justCrashed) {
        emitStatus();
        if (callback) callback(null, getStatus());
        return;
      }

      captureCrash(result, function () {
        emitStatus();
        if (callback) callback(null, getStatus());
      });
    });
  }

  function start() {
    if (timer) return;
    // First poll immediately so the banner reflects real state without a
    // 30 s wait after server boot.
    pollOnce();
    timer = setInterval(pollOnce, pollIntervalMs);
    log.info('script monitor started', { host: host, scriptId: scriptId, pollMs: pollIntervalMs });
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function triggerRestart(callback) {
    rpc(host, 'Script.Stop', { id: scriptId }, rpcTimeoutMs, function (stopErr) {
      // Ignore stop errors — script may already be stopped.
      rpc(host, 'Script.Start', { id: scriptId }, rpcTimeoutMs, function (startErr, startResult) {
        if (startErr) { callback(startErr, null); return; }
        // Kick an immediate re-poll so the WS status flips to running ASAP
        // rather than waiting for the 30 s cadence.
        setTimeout(pollOnce, 500);
        callback(null, { ok: true, stopError: stopErr ? stopErr.message : null, result: startResult });
      });
    });
  }

  function resolveCrash(crashId, callback) {
    if (!db || typeof db.resolveScriptCrash !== 'function') {
      if (callback) callback(null, false);
      return;
    }
    db.resolveScriptCrash(crashId, function (err, updated) {
      if (err) { if (callback) callback(err, false); return; }
      if (callback) callback(null, updated);
    });
  }

  return {
    start: start,
    stop: stop,
    pollOnce: pollOnce,
    recordStateSnapshot: recordStateSnapshot,
    getStatus: getStatus,
    onStatusChange: onStatusChange,
    triggerRestart: triggerRestart,
    resolveCrash: resolveCrash,
    // Test-only — lets the harness assert ring-buffer contents without
    // triggering a real crash.
    _getRecentStates: function () { return recentStates.slice(); },
  };
}

module.exports = { createScriptMonitor: createScriptMonitor };
