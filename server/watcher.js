'use strict';

/**
 * server/watcher.js — health-endpoint watcher for the greenhouse app.
 *
 * Polls WATCH_URL every WATCH_INTERVAL_MS. When the endpoint has been
 * continuously DOWN for >= WATCH_DOWN_THRESHOLD_MIN minutes it fires the
 * incident routine ONCE per outage via routine-trigger.fire('server_down', …).
 * Any UP result resets the down-streak and the fired flag so a later outage
 * fires again.
 *
 * Exposes GET /healthz on PORT for Kubernetes liveness probes.
 *
 * Pure decision logic is isolated in decide() for unit-testing with no
 * network or timers.
 *
 * Env vars consumed (all optional, defaults shown):
 *   WATCH_URL                  default "https://greenhouse.madekivi.fi/health"
 *   WATCH_INTERVAL_MS          default 30000  (30 s)
 *   WATCH_DOWN_THRESHOLD_MIN   default 5
 *   WATCH_TIMEOUT_MS           default 10000  (10 s)
 *   PORT                       default 8080   (liveness server)
 *   DATABASE_URL               (via db resolveUrl)
 *   CLAUDE_ROUTINE_FIRE_URL    (via routine-trigger)
 *   CLAUDE_ROUTINE_FIRE_TOKEN  (via routine-trigger)
 */

const https = require('node:https');
const http = require('node:http');
const createLogger = require('./lib/logger');
const routineTrigger = require('./lib/routine-trigger');
const db = require('./lib/db');

const log = createLogger('watcher');

const WATCH_URL = process.env.WATCH_URL || 'https://greenhouse.madekivi.fi/health';
const WATCH_INTERVAL_MS = parseInt(process.env.WATCH_INTERVAL_MS, 10) || 30000;
const WATCH_DOWN_THRESHOLD_MIN = parseInt(process.env.WATCH_DOWN_THRESHOLD_MIN, 10) || 5;
const WATCH_TIMEOUT_MS = parseInt(process.env.WATCH_TIMEOUT_MS, 10) || 10000;
const PORT = parseInt(process.env.PORT, 10) || 8080;

const THRESHOLD_MS = WATCH_DOWN_THRESHOLD_MIN * 60 * 1000;

/**
 * Pure state-transition function — no side effects, no I/O, fully testable.
 *
 * @param {{ downSince: number|null, fired: boolean }} state - Current watcher state
 * @param {boolean} ok        - Whether the latest health check succeeded (2xx)
 * @param {number}  nowMs     - Current timestamp in ms (Date.now())
 * @param {number}  thresholdMs - How long the endpoint must be down before firing (ms)
 * @returns {{ state: { downSince: number|null, fired: boolean }, fire: boolean }}
 */
function decide(state, ok, nowMs, thresholdMs) {
  if (ok) {
    return { state: { downSince: null, fired: false }, fire: false };
  }

  // Still down.
  const downSince = state.downSince !== null ? state.downSince : nowMs;
  const elapsed = nowMs - downSince;
  const shouldFire = elapsed >= thresholdMs && !state.fired;

  return {
    state: { downSince, fired: state.fired || shouldFire },
    fire: shouldFire,
  };
}

// ── Runtime wiring (only runs when executed directly, not when require()'d by tests) ──

if (require.main === module) {
  // Initialise DB connection so routine-trigger's daily-budget check works.
  db.resolveUrl(function () {
    log.info('watcher starting', {
      watchUrl: WATCH_URL,
      intervalMs: WATCH_INTERVAL_MS,
      thresholdMin: WATCH_DOWN_THRESHOLD_MIN,
      timeoutMs: WATCH_TIMEOUT_MS,
      port: PORT,
    });

    startLivenessServer();
    startPollLoop();
  });
}

/** In-memory watcher state. Reset on each UP result. */
let watcherState = { downSince: null, fired: false };

/**
 * Perform a single HTTP/HTTPS GET to WATCH_URL.
 * Calls back with ok=true on 2xx, ok=false on non-2xx / timeout / error.
 *
 * @param {function(boolean): void} callback
 */
function checkHealth(callback) {
  let settled = false;

  const parsed = new URL(WATCH_URL);
  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;
  const port = parsed.port ? parseInt(parsed.port, 10) : (isHttps ? 443 : 80);

  const options = {
    hostname: parsed.hostname,
    port,
    path: (parsed.pathname || '/') + (parsed.search || ''),
    method: 'GET',
    timeout: WATCH_TIMEOUT_MS,
  };

  const req = transport.request(options, function (res) {
    // Drain response body so the socket is released.
    res.resume();
    if (!settled) {
      settled = true;
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      callback(ok);
    }
  });

  req.on('timeout', function () {
    if (!settled) {
      settled = true;
      req.destroy();
      callback(false);
    }
  });

  req.on('error', function (err) {
    if (!settled) {
      settled = true;
      log.warn('health check request error', { url: WATCH_URL, error: err.message });
      callback(false);
    }
  });

  req.end();
}

function startPollLoop() {
  function poll() {
    checkHealth(function (ok) {
      const nowMs = Date.now();
      const result = decide(watcherState, ok, nowMs, THRESHOLD_MS);
      watcherState = result.state;

      if (ok) {
        log.info('health check OK', { url: WATCH_URL });
      } else {
        const downForMs = watcherState.downSince !== null ? nowMs - watcherState.downSince : 0;
        log.warn('health check DOWN', {
          url: WATCH_URL,
          downForMs,
          fired: watcherState.fired,
        });
      }

      if (result.fire) {
        const downMin = Math.round((nowMs - watcherState.downSince) / 60000);
        const message = `Server DOWN: ${WATCH_URL} has been unreachable for approximately ${downMin} minute(s). Incident response required.`;
        log.warn('firing incident routine', { kind: 'server_down', message });
        routineTrigger.fire('server_down', message);
      }
    });
  }

  // Run immediately, then on each interval.
  poll();
  setInterval(poll, WATCH_INTERVAL_MS);
}

function startLivenessServer() {
  const server = http.createServer(function (req, res) {
    if (req.method === 'GET' && req.url === '/healthz') {
      const body = JSON.stringify({
        ok: true,
        watchUrl: WATCH_URL,
        downSince: watcherState.downSince,
        fired: watcherState.fired,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(PORT, function () {
    log.info('liveness server listening', { port: PORT });
  });

  server.on('error', function (err) {
    log.error('liveness server error', { error: err.message });
  });
}

module.exports = { decide };
