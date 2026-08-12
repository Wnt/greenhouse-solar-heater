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
// JsVar memory guard (spec 025). Evaluated every 5 min off the freshest 30 s
// poll — no extra HTTP call, no second timer.
const DEFAULT_MEM_CHECK_INTERVAL_MS = 5 * 60 * 1000;
// 0.99, not 0.97: the first production firing (2026-08-12 15:06 UTC) showed
// the script's *routine* post-boot peak is 24528 / 25186 B = 97.4 %, while the
// starved state that truncated telemetry and stalled mode switching was
// mem_peak == 25186 == the whole pool. 0.97 cannot tell those apart and would
// burn the daily reboot budget on normal operation; 0.99 (≈250 B of headroom
// left at peak) sits above the routine peak and below a fully consumed pool.
const DEFAULT_MEM_PEAK_RATIO = 0.99;
const DEFAULT_MEM_CONSECUTIVE_HIGH = 2;
const DEFAULT_MEM_REBOOT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_MEM_REBOOTS_PER_DAY = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  // Injectable clock (defaults to Date.now) so backoff windows are
  // deterministic in tests.
  const now = typeof options.now === 'function' ? options.now : Date.now;

  // Reactive auto-restart: on a genuine crash, restart the control script
  // automatically instead of waiting for a human (the 2026-06-22 episode
  // left the collector to stagnate to ~90 °C for hours). Off unless
  // explicitly enabled.
  //
  // NEVER-GIVE-UP recovery (#262, 2026-06-25): the Pro 4PM OOM'd even at
  // IDLE/BOOT and crash-looped so hard that the old "3 restarts then one
  // reboot then stop" path exhausted and left the controller permanently
  // DOWN. The hardened loop instead:
  //   - spaces restart attempts by exponential backoff (no Stop/Start storm
  //     every 30 s poll — that itself adds HTTP churn to a sick device),
  //   - after `maxAutoRestarts` restarts inside a window, escalates to a
  //     device reboot and KEEPS escalating (repeated reboots, each spaced by
  //     an exponential, capped cooldown) — recovery is a loop, not a one-shot,
  //   - treats `exhausted` as informational ("currently in backoff /
  //     escalating"), never as a terminal stop.
  const autoRestartEnabled = options.autoRestart === true;
  const maxAutoRestarts = options.maxAutoRestarts || 3;
  // Base spacing between successive script restarts; doubles each attempt up
  // to maxBackoffMs.
  const restartBackoffMs = options.restartBackoffMs != null ? options.restartBackoffMs : 30 * 1000;
  // Base spacing between successive device-reboot escalations; doubles each
  // reboot up to maxBackoffMs.
  const rebootBackoffMs = options.rebootBackoffMs != null ? options.rebootBackoffMs : 5 * 60 * 1000;
  const maxBackoffMs = options.maxBackoffMs != null ? options.maxBackoffMs : 30 * 60 * 1000;

  // ── JsVar memory guard (spec 025) ──
  // Espruino's per-script JsVar pool fragments over days of uptime; mem_peak
  // is a high-water mark that only resets on script restart / device reboot.
  // When the peak sits at the pool ceiling the script OOMs at its transition
  // peak: it publishes truncated telemetry and can stop switching modes
  // entirely (2026-08-12 — 48 min idle with the collector at 71.7 °C). A
  // device reboot is the only way to reclaim the pool; a Script restart is
  // not. Off unless explicitly enabled (previews/tests must not actuate).
  const memGuardEnabled = options.memGuard === true;
  const memCheckIntervalMs = options.memCheckIntervalMs != null
    ? options.memCheckIntervalMs : DEFAULT_MEM_CHECK_INTERVAL_MS;
  const memPeakRebootRatio = options.memPeakRebootRatio != null
    ? options.memPeakRebootRatio : DEFAULT_MEM_PEAK_RATIO;
  const memConsecutiveHigh = options.memConsecutiveHigh != null
    ? options.memConsecutiveHigh : DEFAULT_MEM_CONSECUTIVE_HIGH;
  const memRebootCooldownMs = options.memRebootCooldownMs != null
    ? options.memRebootCooldownMs : DEFAULT_MEM_REBOOT_COOLDOWN_MS;
  const maxMemRebootsPerDay = options.maxMemRebootsPerDay != null
    ? options.maxMemRebootsPerDay : DEFAULT_MAX_MEM_REBOOTS_PER_DAY;
  const push = options.push || null;

  let timer = null;
  let inflight = false;
  let memLastCheckAt = 0;         // epoch-ms of the last 5-min evaluation
  let memConsecutive = 0;         // consecutive high-peak evaluations
  let memLastRebootAt = 0;        // epoch-ms of the last memory-triggered reboot
  let memRebootCount = 0;         // memory reboots since process start
  let memRebootTimes = [];        // trailing-24 h reboot timestamps
  let memGuardExhausted = false;  // latched once the daily cap is hit
  const memStats = { used: null, peak: null, free: null, total: null, peakRatio: null, checkedAt: null };
  let recentStates = []; // newest-last
  let restartAttempts = 0;        // script restarts this crash episode (reset on recovery)
  let autoRestartExhausted = false; // informational: in backoff / escalating
  let lastRestartAt = 0;          // epoch-ms of the most recent restart attempt
  let lastRebootAt = 0;           // epoch-ms of the most recent reboot escalation
  let rebootCount = 0;            // device reboots fired this crash episode
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
      memory: {
        used: memStats.used,
        peak: memStats.peak,
        free: memStats.free,
        total: memStats.total,
        peakRatio: memStats.peakRatio,
        checkedAt: memStats.checkedAt,
        guardEnabled: memGuardEnabled,
        threshold: memPeakRebootRatio,
        consecutiveHigh: memConsecutive,
        lastRebootAt: memLastRebootAt || null,
        rebootCount: memRebootCount,
        rebootsToday: memRebootTimes.length,
        exhausted: memGuardExhausted,
      },
      autoRestart: {
        enabled: autoRestartEnabled,
        attempts: restartAttempts,
        exhausted: autoRestartExhausted,
        rebootEscalated: rebootCount > 0,
        rebootCount,
      },
    };
  }

  // Restart the control script (Stop then Start). No status repoll — the
  // caller decides whether to schedule one.
  function restartScript(callback) {
    rpc(host, 'Script.Stop', { id: scriptId }, rpcTimeoutMs, function (stopErr) {
      rpc(host, 'Script.Start', { id: scriptId }, rpcTimeoutMs, function (startErr, startResult) {
        if (startErr) { callback(startErr, null); return; }
        callback(null, { ok: true, stopError: stopErr ? stopErr.message : null, result: startResult });
      });
    });
  }

  // Exponential backoff: base * 2^step, capped at maxBackoffMs.
  function backoff(base, step) {
    if (base <= 0) return 0;
    const ms = base * Math.pow(2, step);
    return ms > maxBackoffMs ? maxBackoffMs : ms;
  }

  // Called on every poll while the script is observed crashed. Drives the
  // never-give-up recovery loop: backoff-spaced script restarts, then
  // backoff-spaced device-reboot escalations that keep firing until the
  // script comes back. Only acts on genuine crashes (an error trace is
  // present) — a clean stop, e.g. a deploy's Script.Stop/Start, has none and
  // must not trigger a fight with the deployer. Does NOT emit status; the
  // poll loop emits once after calling this so the snapshot reflects new
  // state.
  function maybeAutoRestart() {
    if (!autoRestartEnabled) return;
    if (!lastStatus.error_trace) return;
    const t = now();

    if (restartAttempts < maxAutoRestarts) {
      // Still within the per-episode restart budget — try a script restart,
      // but only once the restart backoff since the last attempt has elapsed
      // (avoids a Stop/Start storm that piles HTTP churn on a sick device).
      // The budget counts CONSECUTIVE failed restarts in this crash episode
      // (reset on recovery), not a sliding time window — so backoff can space
      // attempts over minutes without the count silently ageing out and
      // starving the reboot escalation.
      if (lastRestartAt && t - lastRestartAt < backoff(restartBackoffMs, restartAttempts)) return;
      restartAttempts += 1;
      lastRestartAt = t;
      log.warn('auto-restarting control script', { attempt: restartAttempts, host });
      restartScript(function (err) {
        if (err) log.error('auto-restart failed', { error: err.message });
      });
      return;
    }

    // Restart budget exhausted: escalate to a device reboot. Never a one-shot
    // — keep escalating, each reboot spaced by an exponential (capped)
    // cooldown, so a controller that OOMs on boot is rebooted again and again
    // rather than abandoned. `exhausted` LATCHES true for the rest of this
    // crash episode (cleared only on recovery) so the critical "DOWN — action
    // needed" push fires once per episode on its rising edge, not on every
    // post-reboot restart attempt.
    autoRestartExhausted = true;
    if (lastRebootAt && t - lastRebootAt < backoff(rebootBackoffMs, rebootCount)) return;
    lastRebootAt = t;
    rebootCount += 1;
    // Reset the restart budget so script-level restarts resume after the
    // reboot (the device may come back healthy and only need a Script.Start).
    restartAttempts = 0;
    lastRestartAt = 0;
    log.warn('escalating to device reboot', { host, rebootCount });
    rpc(host, 'Shelly.Reboot', {}, rpcTimeoutMs, function (err) {
      if (err) log.error('device reboot failed', { error: err.message });
    });
  }

  // Latest device-authored snapshot, or null before the first one arrives.
  function latestSnapshot() {
    return recentStates.length ? recentStates[recentStates.length - 1] : null;
  }

  // Safety gates for a memory-triggered reboot. A boot re-closes every valve
  // and turns all actuators off (boot() in shelly/control.js), so rebooting
  // out of solar/greenhouse costs at most one 30 s tick — strictly better
  // than a starved pool. ACTIVE_DRAIN is the exception that must never be
  // interrupted: aborting a freeze or overheat drain is a hardware risk.
  // Manual override means the operator is driving; don't yank the device.
  // No snapshot at all → we don't know the mode → don't reboot.
  function memRebootBlockedBy() {
    const snap = latestSnapshot();
    if (!snap || !snap.mode) return 'no_mode_observation';
    if (snap.mode === 'active_drain') return 'active_drain';
    if (snap.transitioning) return 'transitioning';
    const mo = snap.manual_override;
    if (mo && (mo === true || mo.active)) return 'manual_override';
    return null;
  }

  function sendMemPush(kind, title, body) {
    if (!push || typeof push.sendNotification !== 'function') return;
    // Forced + rate-limit-bypassing for the same reason script_crash is: the
    // controller's ability to decide is safety-critical.
    push.sendNotification('script_crash', {
      title,
      body,
      tag: 'controller-' + kind,
      icon: 'assets/notif-script-crash.png',
      badge: 'assets/badge-72.png',
      url: '/#status',
      requireInteraction: true,
      renotify: true,
      data: { kind, url: '/#status' },
    }, { force: true, ignoreRateLimit: true });
  }

  // Called from the poll success path with a running script. Records memory
  // stats every poll (cheap, already in hand) but only *evaluates* on the
  // memCheckIntervalMs cadence.
  function memoryTick(result) {
    const used = typeof result.mem_used === 'number' ? result.mem_used : null;
    const peak = typeof result.mem_peak === 'number' ? result.mem_peak : null;
    const free = typeof result.mem_free === 'number' ? result.mem_free : null;
    // The pool is fixed: mem_used + mem_free is its size (25186 B on the
    // Pro 4PM, see shelly/script-budget.json).
    const total = used !== null && free !== null ? used + free : null;
    memStats.used = used;
    memStats.peak = peak;
    memStats.free = free;
    memStats.total = total;
    memStats.peakRatio = (peak !== null && total) ? peak / total : null;
    memStats.checkedAt = now();

    if (!memGuardEnabled) return;
    const t = now();
    if (memLastCheckAt && t - memLastCheckAt < memCheckIntervalMs) return;
    memLastCheckAt = t;
    if (memStats.peakRatio === null) return;

    if (memStats.peakRatio < memPeakRebootRatio) {
      memConsecutive = 0;
      return;
    }
    memConsecutive += 1;
    if (memConsecutive < memConsecutiveHigh) {
      log.warn('script memory peak high', {
        peak, total, ratio: Number(memStats.peakRatio.toFixed(4)), consecutive: memConsecutive,
      });
      return;
    }

    const blocked = memRebootBlockedBy();
    if (blocked) {
      log.warn('memory reboot deferred', { blockedBy: blocked, peak, total });
      return;
    }
    if (memLastRebootAt && t - memLastRebootAt < memRebootCooldownMs) return;

    // Trailing-24 h cap. A controller needing more than this many reboots a
    // day needs a smaller script, not a reboot loop — escalate to a human
    // once and stop rebooting until the window drains.
    memRebootTimes = memRebootTimes.filter(function (ts) { return t - ts < DAY_MS; });
    if (memRebootTimes.length >= maxMemRebootsPerDay) {
      if (!memGuardExhausted) {
        memGuardExhausted = true;
        log.error('memory guard exhausted — not rebooting', {
          rebootsToday: memRebootTimes.length, peak, total,
        });
        sendMemPush('memory_guard_exhausted', 'Controller memory guard exhausted',
          'The control script has exhausted its memory ' + memRebootTimes.length
          + ' times in 24 h. Reboots have stopped — the script needs to be shrunk.');
      }
      return;
    }

    memGuardExhausted = false;
    memLastRebootAt = t;
    memRebootCount += 1;
    memRebootTimes.push(t);
    memConsecutive = 0;
    log.warn('rebooting controller — script memory pool exhausted', {
      peak, total, ratio: Number(memStats.peakRatio.toFixed(4)), rebootCount: memRebootCount,
    });
    rpc(host, 'Shelly.Reboot', {}, rpcTimeoutMs, function (err) {
      if (err) log.error('memory reboot failed', { error: err.message });
    });
    sendMemPush('memory_reboot', 'Controller rebooted — script memory exhausted',
      'The control script hit its JsVar pool ceiling (' + peak + ' of ' + total
      + ' B). Rebooted the Pro 4PM to reclaim memory; automation resumes within a minute.');
    emitStatus();
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
      manual_override: payload.manual_override || null,
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
      lastStatus.checkedAt = now();
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
        memoryTick(result);
        // Clear stuck crash fields on recovery. DB row is preserved;
        // crashId still points at it for the resolved-incident UI.
        if (wasRunning !== true) {
          lastStatus.error_msg = null;
          lastStatus.error_trace = null;
          lastStatus.crashId = null;
          // Recovery — clear the auto-restart episode so a later crash can
          // be auto-restarted again from scratch.
          restartAttempts = 0;
          autoRestartExhausted = false;
          lastRestartAt = 0;
          lastRebootAt = 0;
          rebootCount = 0;
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
        maybeAutoRestart();
        emitStatus();
        if (callback) callback(null, getStatus());
        return;
      }

      captureCrash(result, function () {
        maybeAutoRestart();
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
    restartScript(function (err, result) {
      if (err) { callback(err, null); return; }
      // Kick an immediate re-poll so the WS status flips to running ASAP
      // rather than waiting for the 30 s cadence.
      setTimeout(pollOnce, 500);
      callback(null, result);
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
