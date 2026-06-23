'use strict';

/**
 * Fires the Claude cloud incident-response routine via its API trigger endpoint.
 *
 * Usage:
 *   const routineTrigger = require('./routine-trigger');
 *   routineTrigger.fire('shelly_script_crash', 'Control script crashed: ...');
 *
 * Environment variables (set via Kubernetes secret):
 *   CLAUDE_ROUTINE_FIRE_URL   — the routine's /fire POST endpoint URL
 *   CLAUDE_ROUTINE_FIRE_TOKEN — bearer token for the routine
 *
 * No-ops (returns false) when:
 *   - CLAUDE_ROUTINE_FIRE_URL or CLAUDE_ROUTINE_FIRE_TOKEN are unset
 *   - PREVIEW_MODE=true (preview pods must not fire production routines)
 *
 * fire-and-forget: the function returns synchronously (true on dispatch,
 * false on no-op) and logs any HTTP errors via logger without throwing.
 *
 * Per-kind rate limiting (default 15 min) prevents flooding the routine
 * with repeated identical events.
 */

const https = require('node:https');
const http = require('node:http');
const createLogger = require('./logger');

const log = createLogger('routine-trigger');

// Read config at module load time. Both values must be present to fire.
const FIRE_URL = process.env.CLAUDE_ROUTINE_FIRE_URL || '';
const FIRE_TOKEN = process.env.CLAUDE_ROUTINE_FIRE_TOKEN || '';
const PREVIEW_MODE = process.env.PREVIEW_MODE === 'true';

// Default minimum interval between fires of the same kind (15 minutes)
const DEFAULT_MIN_INTERVAL_MS = 15 * 60 * 1000;

// Per-kind rate-limit map: kind → timestamp of last fire
const lastFiredAt = Object.create(null);

/**
 * Fire the incident-response routine.
 *
 * @param {string} kind       - Logical event type (used for rate-limiting, e.g. 'shelly_script_crash')
 * @param {string} text       - Human-readable description sent as the routine prompt
 * @param {object} [opts]
 * @param {number} [opts.minIntervalMs] - Override rate-limit interval (ms)
 * @returns {boolean} true if fired (or scheduled to fire), false if no-op
 */
function fire(kind, text, opts) {
  if (!FIRE_URL || !FIRE_TOKEN) {
    return false;
  }
  if (PREVIEW_MODE) {
    return false;
  }

  const minIntervalMs = (opts && opts.minIntervalMs != null)
    ? opts.minIntervalMs
    : DEFAULT_MIN_INTERVAL_MS;

  const now = Date.now();
  const last = lastFiredAt[kind];
  if (last !== undefined && (now - last) < minIntervalMs) {
    log.info('routine-trigger rate-limited', { kind, msSinceLastFire: now - last });
    return false;
  }

  lastFiredAt[kind] = now;

  const body = JSON.stringify({ text });

  // Parse the URL to determine http vs https and extract host/port/path
  const parsed = new URL(FIRE_URL);
  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;
  const port = parsed.port
    ? parseInt(parsed.port, 10)
    : (isHttps ? 443 : 80);

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
    // Drain the response body to free the socket
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

  return true;
}

module.exports = { fire };
