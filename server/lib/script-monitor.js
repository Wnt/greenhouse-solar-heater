// Control-script monitor: polls Script.GetStatus on the Pro 4PM every
// 30 s. On a running→stopped transition captures the script's error
// trace, Sys.GetStatus, and the recent-states ring buffer, then writes
// one script_crashes row. Status changes fan out via callbacks for the
// HTTP/WS "script down" banner.
//
// Direct HTTP (not MQTT) is intentional — see CLAUDE.md: we need to
// observe the script's health *when MQTT has gone silent*. Joins
// sensor-discovery / sensor-config/apply as the third exception.

'use strict';

const http = require('http');
const createLogger = require('./logger');
const log = createLogger('script-monitor');

const DEFAULT_POLL_INTERVAL_MS = 30 * 1000;
const DEFAULT_RPC_TIMEOUT_MS = 5000;
const DEFAULT_RECENT_STATES = 100;

function rpcCall(host, method, params, timeoutMs, callback) {
  const body = JSON.stringify({ id: 1, method, params: params || {} });
  const req = http.request({
    host,
    port: 80,
    path: '/rpc',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: timeoutMs,
  }, function (res) {
    const chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () {
      if (res.statusCode !== 200) {
        callback(new Error('HTTP ' + res.statusCode + ' from ' + host));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString());
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
  const host = options.host || process.env.CONTROLLER_IP || '192.168.30.50';
  const scriptId = parseInt(options.scriptId || process.env.CONTROLLER_SCRIPT_ID || '1', 10);
  const pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
  const rpcTimeoutMs = options.rpcTimeoutMs || DEFAULT_RPC_TIMEOUT_MS;
  const bufferSize = options.bufferSize || DEFAULT_RECENT_STATES;
  const db = options.db || null;
  // Injectable so tests can mock the Shelly without real HTTP.
  const rpc = options.rpc || rpcCall;

  let timer = null;
  let inflight = false;
  let recentStates = []; // newest-last
  const lastStatus = {
    running: null,         // true / false / null (unknown)
    checkedAt: null,       // last poll epoch ms
    reachable: false,      // did the last RPC succeed?
    error_msg: null,
    error_trace: null,
    crashId: null,         // set when the latest observed crash produced a DB row
  };
  const statusListeners = [];

  function emitStatus() {
    const snap = getStatus();
    for (let i = 0; i < statusListeners.length; i++) {
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
      host,
      scriptId,
    };
  }

  function onStatusChange(cb) {
    statusListeners.push(cb);
    return function unsubscribe() {
      const idx = statusListeners.indexOf(cb);
      if (idx !== -1) statusListeners.splice(idx, 1);
    };
  }

  function recordStateSnapshot(payload) {
    if (!payload) return;
    const snap = {
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

  // First running:false poll: fetch Sys.GetStatus and write one
  // script_crashes row. Subsequent polls just re-emit the same snapshot
  // — no duplicate rows per cycle.
  function captureCrash(scriptStatus, callback) {
    lastStatus.error_msg = scriptStatus.error_msg || null;
    lastStatus.error_trace = (scriptStatus.errors && scriptStatus.errors.length)
      ? scriptStatus.errors.join('\n')
      : null;

    rpc(host, 'Sys.GetStatus', {}, rpcTimeoutMs, function (sysErr, sysResult) {
      const sysStatus = sysErr ? { error: sysErr.message } : sysResult;
      const row = {
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
        log.warn('script crash recorded', { id, error: row.error_msg });
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
        const reachabilityChanged = lastStatus.reachable !== false;
        lastStatus.reachable = false;
        if (reachabilityChanged) {
          log.warn('script poll unreachable', { host, error: err.message });
          emitStatus();
        }
        if (callback) callback(err, getStatus());
        return;
      }
      lastStatus.reachable = true;
      const wasRunning = lastStatus.running;
      const isRunning = !!result.running;
      lastStatus.running = isRunning;

      if (isRunning) {
        // Clear stuck crash fields on recovery. DB row is preserved;
        // crashId still points at it for the resolved-incident UI.
        if (wasRunning !== true) {
          lastStatus.error_msg = null;
          lastStatus.error_trace = null;
          lastStatus.crashId = null;
          log.info('script running', { host });
          emitStatus();
        }
        if (callback) callback(null, getStatus());
        return;
      }

      // Not running. If we just transitioned from running → crashed, or
      // this is the first poll, persist a new crash row. If we were
      // already observed as not-running, the crashId stays the same.
      const justCrashed = wasRunning === true || (wasRunning === null && lastStatus.crashId === null);
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
    log.info('script monitor started', { host, scriptId, pollMs: pollIntervalMs });
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
    start,
    stop,
    pollOnce,
    recordStateSnapshot,
    getStatus,
    onStatusChange,
    triggerRestart,
    resolveCrash,
    // Test-only — lets the harness assert ring-buffer contents without
    // triggering a real crash.
    _getRecentStates: function () { return recentStates.slice(); },
  };
}

module.exports = { createScriptMonitor };
