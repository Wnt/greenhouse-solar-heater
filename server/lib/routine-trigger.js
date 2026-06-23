'use strict';

/**
 * Fires the Claude cloud incident-response routine via its API trigger endpoint.
 *
 *   const routineTrigger = require('./routine-trigger');
 *   routineTrigger.fire('shelly_script_crash', 'Control script crashed: ...');
 *
 * Each fire starts one routine run, which is a daily-capped subscription
 * resource. So firing is budgeted at the source (here), not left to the
 * routine — by the time a run starts the quota is already spent. Push
 * notifications are free and are sent by the caller regardless; we only
 * spend a routine run when we're under budget.
 *
 * Three gates, cheapest first:
 *   1. Config / preview — no-op (return false) if CLAUDE_ROUTINE_FIRE_URL or
 *      CLAUDE_ROUTINE_FIRE_TOKEN is unset, or PREVIEW_MODE=true.
 *   2. Per-kind cooldown — in-process, fast; suppresses a repeating kind
 *      within ROUTINE_FIRE_COOLDOWN_MIN (default 15 min).
 *   3. Daily cap — DURABLE (DB-backed); suppresses once ROUTINE_FIRE_DAILY_CAP
 *      (default 10) fires have happened in the rolling last 24 h. Durable
 *      because an in-process counter would reset on the pod restarts that
 *      incidents cause. Fails OPEN (still fires) if the DB is unavailable —
 *      missing a real incident is worse than slightly overspending the cap.
 *
 * Environment variables (set via Kubernetes secret / config):
 *   CLAUDE_ROUTINE_FIRE_URL    — the routine's /fire POST endpoint URL
 *   CLAUDE_ROUTINE_FIRE_TOKEN  — bearer token for the routine
 *   ROUTINE_FIRE_DAILY_CAP     — max fires per rolling 24 h (default 10)
 *   ROUTINE_FIRE_COOLDOWN_MIN  — per-kind cooldown minutes (default 15)
 *
 * Fire-and-forget: returns synchronously (true = accepted past the cheap
 * gates, false = no-op); the durable check + HTTP POST run asynchronously
 * and never throw.
 */

const https = require('node:https');
const http = require('node:http');
const createLogger = require('./logger');

const log = createLogger('routine-trigger');

const FIRE_URL = process.env.CLAUDE_ROUTINE_FIRE_URL || '';
const FIRE_TOKEN = process.env.CLAUDE_ROUTINE_FIRE_TOKEN || '';
const PREVIEW_MODE = process.env.PREVIEW_MODE === 'true';
const COOLDOWN_MS = (parseInt(process.env.ROUTINE_FIRE_COOLDOWN_MIN, 10) || 15) * 60 * 1000;
const DAILY_CAP = parseInt(process.env.ROUTINE_FIRE_DAILY_CAP, 10) || 10;

const COUNT_24H_SQL = "SELECT COUNT(*)::int AS n FROM routine_fires WHERE ts > NOW() - INTERVAL '24 hours'";

// Per-kind in-process cooldown: kind → timestamp of last accepted fire.
const lastFiredAt = Object.create(null);

/**
 * Fire the incident-response routine, subject to cooldown + daily budget.
 *
 * @param {string} kind  - Event type, used for cooldown + the fire log (e.g. 'shelly_script_crash')
 * @param {string} text  - Human-readable description passed to the routine prompt
 * @param {object} [opts]
 * @param {number} [opts.minIntervalMs] - Override the per-kind cooldown (ms)
 * @param {object} [opts.db]            - DB module override (defaults to require('./db')); for tests
 * @returns {boolean} true if accepted past the cheap gates, false if a no-op
 */
function fire(kind, text, opts) {
  opts = opts || {};
  if (!FIRE_URL || !FIRE_TOKEN) return false;
  if (PREVIEW_MODE) return false;

  const minIntervalMs = (opts.minIntervalMs != null) ? opts.minIntervalMs : COOLDOWN_MS;
  const now = Date.now();
  const last = lastFiredAt[kind];
  if (last !== undefined && (now - last) < minIntervalMs) {
    log.info('routine-trigger cooldown (same kind)', { kind, msSinceLastFire: now - last });
    return false;
  }
  lastFiredAt[kind] = now;

  // Durable daily-cap gate, then dispatch. Fail open if there's no DB.
  const db = opts.db || require('./db');
  const pool = (db && typeof db.getPool === 'function') ? db.getPool() : null;
  if (!pool) {
    dispatch(kind, text);
    return true;
  }

  pool.query(COUNT_24H_SQL, [], function (err, res) {
    if (err) {
      log.warn('routine-trigger budget check failed; firing anyway', { kind, error: err.message });
      dispatch(kind, text);
      return;
    }
    const n = (res && res.rows && res.rows[0]) ? res.rows[0].n : 0;
    if (n >= DAILY_CAP) {
      log.warn('routine-trigger daily budget exhausted; suppressing fire (push still sent by caller)',
        { kind, count: n, cap: DAILY_CAP });
      return;
    }
    pool.query('INSERT INTO routine_fires (kind) VALUES ($1)', [kind], function (insErr) {
      if (insErr) log.warn('routine-trigger fire-log insert failed', { kind, error: insErr.message });
    });
    dispatch(kind, text);
  });

  return true;
}

// Build and send the /fire POST. Drains the response; logs, never throws.
function dispatch(kind, text) {
  const body = JSON.stringify({ text });
  const parsed = new URL(FIRE_URL);
  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;
  const port = parsed.port ? parseInt(parsed.port, 10) : (isHttps ? 443 : 80);

  const options = {
    hostname: parsed.hostname,
    port,
    path: (parsed.pathname || '/') + (parsed.search || ''),
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + FIRE_TOKEN,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'experimental-cc-routine-2026-04-01',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const req = transport.request(options, function (res) {
    res.resume();
    if (res.statusCode >= 400) {
      log.warn('routine-trigger HTTP error', { kind, statusCode: res.statusCode });
    } else {
      log.info('routine-trigger fired', { kind, statusCode: res.statusCode });
    }
  });
  req.on('error', function (err) {
    log.error('routine-trigger request failed', { kind, error: err.message });
  });
  req.write(body);
  req.end();
}

module.exports = { fire };
