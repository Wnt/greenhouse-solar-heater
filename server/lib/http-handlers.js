// HTTP API handlers extracted from server.js.
//
// Usage:
//   const { createHandlers } = require('./lib/http-handlers');
//   const handlers = createHandlers({
//     db, scriptMonitor, authMiddleware, broadcastToWebSockets,
//   });
//   handlers.handleHealth(req, res);
//
// Dependencies come in via createHandlers rather than module-scope
// globals so server.js can construct them after initServices resolves
// (db + scriptMonitor are null at require time).

const net = require('net');
const mqttBridge = require('./mqtt-bridge');
const deviceConfig = require('./device-config');
const sensorDiscovery = require('./sensor-discovery');
const push = require('./push');
const anomalyManager = require('./anomaly-manager');
const { emitConfigEvents } = require('./config-events');
const createLogger = require('./logger');

const log = createLogger('http');
const APP_VERSION = process.env.GIT_COMMIT || 'unknown';
const VPN_CHECK_HOST = process.env.VPN_CHECK_HOST || '';
const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';

function checkVpn(callback) {
  if (!VPN_CHECK_HOST) { callback('unknown'); return; }
  const parts = VPN_CHECK_HOST.split(':');
  const host = parts[0];
  const port = parseInt(parts[1] || '80', 10);
  const sock = net.createConnection({ host, port, timeout: 2000 });
  sock.on('connect', function () { sock.destroy(); callback('connected'); });
  sock.on('error', function () { sock.destroy(); callback('disconnected'); });
  sock.on('timeout', function () { sock.destroy(); callback('disconnected'); });
}

function readBody(req, callback) {
  let body = '';
  req.on('data', function (chunk) { body += chunk; });
  req.on('end', function () { callback(body); });
}

function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Parse a JSON request body and call onSuccess(parsed) — or write a 400
// and stop. Returns true on success so callers can early-return on parse
// failure without an extra flag.
function parseJsonOrFail(res, body) {
  try {
    return JSON.parse(body);
  } catch (e) {
    jsonResponse(res, 400, { error: 'Invalid JSON' });
    return undefined;
  }
}

function createHandlers(deps) {
  const db = deps.db;
  const authMiddleware = deps.authMiddleware;
  const broadcastToWebSockets = deps.broadcastToWebSockets;

  function handleHealth(req, res) {
    checkVpn(function (vpnStatus) {
      const status = vpnStatus === 'disconnected' ? 'degraded' : 'ok';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status,
        vpn: vpnStatus,
        mqtt: mqttBridge.getConnectionStatus(),
        timestamp: new Date().toISOString(),
      }));
    });
  }

  function handleVersion(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hash: APP_VERSION }));
  }

  // Public deploy-time runtime metadata, used by the frontend (and the
  // unauthenticated login page) to rebrand themselves on PR previews.
  // Shape: { preview: null | { pr: number|null, branch: string|null } }.
  // Never returns 401; lives at the same trust level as /version.
  function handleRuntimeApi(req, res) {
    const isPreview = process.env.PREVIEW_MODE === 'true';
    let preview = null;
    if (isPreview) {
      const prRaw = process.env.PR_NUMBER;
      const prNum = prRaw && /^\d+$/.test(prRaw) ? parseInt(prRaw, 10) : null;
      const branch = process.env.BRANCH_NAME || null;
      preview = { pr: prNum, branch };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ preview }));
  }

  function handleHistoryApi(req, res) {
    if (!db) {
      jsonResponse(res, 503, { error: 'Database not available' });
      return;
    }

    const parsed = new URL(req.url, 'http://localhost');
    const range = parsed.searchParams.get('range') || '6h';
    const sensor = parsed.searchParams.get('sensor') || null;

    db.getHistory(range, sensor, function (err, points) {
      if (err) {
        log.error('history query failed', { error: err.message });
        jsonResponse(res, 500, { error: 'Query failed' });
        return;
      }
      db.getEvents(range, 'mode', function (evErr, events) {
        if (evErr) {
          log.error('events query failed', { error: evErr.message });
          events = [];
        }
        // Space-heater on/off intervals feed the EMERGENCY band on the
        // history graph (OR-unioned with `mode === 'emergency_heating'`)
        // and the SH annotation in the clipboard export. Fetched here
        // alongside mode events so a single /api/history round-trip
        // gives the client everything the bar chart and the readings
        // table need.
        db.getEvents(range, 'actuator', 'space_heater', function (shErr, spaceHeaterEvents) {
          if (shErr) {
            log.error('space-heater events query failed', { error: shErr.message });
            spaceHeaterEvents = [];
          }
          jsonResponse(res, 200, { range, points, events, spaceHeaterEvents });
        });
      });
    });
  }

  // Paginated state_events feed for the System Logs UI. Supports
  // newest-first cursor pagination so the client can lazy-load older
  // entries on scroll.
  //   GET /api/events?type=mode&limit=10&before=<unix_ms>
  //   -> { events: [...], hasMore: bool }
  function handleEventsApi(req, res) {
    if (!db) {
      jsonResponse(res, 503, { error: 'Database not available' });
      return;
    }

    const parsed = new URL(req.url, 'http://localhost');
    const type = parsed.searchParams.get('type') || 'mode';
    const limit = parseInt(parsed.searchParams.get('limit'), 10) || 10;
    const beforeRaw = parsed.searchParams.get('before');
    const before = beforeRaw ? parseInt(beforeRaw, 10) : null;
    if (beforeRaw && (Number.isNaN(before) || before <= 0)) {
      jsonResponse(res, 400, { error: 'Invalid `before` cursor' });
      return;
    }

    // type=config queries the separate config_events table (wb/mo
     // mutations: mode-enablement edits, manual override enter/exit,
     // device auto-shutdowns). Same { events, hasMore } shape as the
     // mode-events feed; the System Logs view fetches both and
     // interleaves by ts.
    if (type === 'config') {
      db.getConfigEventsPaginated(limit, before, function (err, result) {
        if (err) {
          log.error('config events query failed', { error: err.message });
          jsonResponse(res, 500, { error: 'Query failed' });
          return;
        }
        jsonResponse(res, 200, result);
      });
      return;
    }

    db.getEventsPaginated(type, limit, before, function (err, result) {
      if (err) {
        log.error('events query failed', { error: err.message });
        jsonResponse(res, 500, { error: 'Query failed' });
        return;
      }
      jsonResponse(res, 200, result);
    });
  }

  function handleDeviceConfigApi(req, res, urlPath, body) {
    if (req.method === 'GET') {
      deviceConfig.handleGet(req, res);
      return;
    }

    if (req.method === 'PUT') {
      // PUT requires admin role
      if (AUTH_ENABLED && !authMiddleware.requireAdmin(req, res)) return;
      // Capture user identity at request time — needed for the config-
      // events audit row written below. Falls back to 'admin' when auth
      // is disabled (local LAN dev mode) so single-user setups still
      // get a non-null actor in the log.
      const user = authMiddleware && authMiddleware.getCurrentUser
        ? authMiddleware.getCurrentUser(req)
        : null;
      const actor = (user && user.name) || 'admin';
      deviceConfig.handlePut(req, res, body, function (config, prevConfig) {
        // Publish to MQTT for instant push to device
        mqttBridge.publishConfig(config);
        // Mirror the latest snapshot into anomaly-manager so wb-clear
        // actions from the Mode Enablement UI are reflected in WS
        // broadcasts and subsequent getState() calls.
        anomalyManager.updateSnapshot(config);
        // Push a watchdog-state broadcast so UIs re-render the mode
        // enablement / watchdog cards live.
        broadcastToWebSockets({
          type: 'watchdog-state',
          pending: anomalyManager.getPending(),
          watchdogs: require('../../shelly/watchdogs-meta.js').WATCHDOGS,
          snapshot: { we: config.we || {}, wz: config.wz || {}, wb: config.wb || {} }
        });
        // Audit-log wb / mo deltas. Best-effort — emitConfigEvents
        // logs and swallows individual insert failures.
        emitConfigEvents(db, log, prevConfig, config, 'api', actor);
      });
      return;
    }

    jsonResponse(res, 405, { error: 'Method not allowed' });
  }

  function handleSensorDiscovery(req, res, body) {
    const parsed = parseJsonOrFail(res, body);
    if (parsed === undefined) return;
    if (!parsed.hosts || !Array.isArray(parsed.hosts)) {
      jsonResponse(res, 400, { error: 'Missing hosts array' });
      return;
    }
    const options = {};
    if (parsed.skipTemp) options.skipTemp = true;
    sensorDiscovery.discoverSensors(parsed.hosts, options).then(function (result) {
      jsonResponse(res, 200, result);
    }).catch(function (err) {
      jsonResponse(res, 500, { error: err.message || String(err) });
    });
  }

  function handlePushSubscribe(req, res, body) {
    const parsed = parseJsonOrFail(res, body);
    if (parsed === undefined) return;
    if (!parsed.subscription || !parsed.subscription.endpoint || !parsed.subscription.keys) {
      jsonResponse(res, 400, { error: 'Missing subscription object (endpoint + keys)' });
      return;
    }
    const categories = Array.isArray(parsed.categories) ? parsed.categories : [];
    push.addSubscription(parsed.subscription, categories, function (err) {
      if (err) {
        jsonResponse(res, 500, { error: 'Failed to save subscription' });
        return;
      }
      jsonResponse(res, 200, { ok: true });
    });
  }

  function handlePushUnsubscribe(req, res, body) {
    const parsed = parseJsonOrFail(res, body);
    if (parsed === undefined) return;
    if (!parsed.endpoint) {
      jsonResponse(res, 400, { error: 'Missing endpoint' });
      return;
    }
    push.removeSubscription(parsed.endpoint, function (err) {
      if (err) {
        jsonResponse(res, 500, { error: 'Failed to remove subscription' });
        return;
      }
      jsonResponse(res, 200, { ok: true });
    });
  }

  function handlePushGetSubscription(req, res, body) {
    const parsed = parseJsonOrFail(res, body);
    if (parsed === undefined) return;
    if (!parsed.endpoint) {
      jsonResponse(res, 400, { error: 'Missing endpoint' });
      return;
    }
    const sub = push.getSubscription(parsed.endpoint);
    if (!sub) {
      jsonResponse(res, 200, { subscribed: false, categories: [] });
      return;
    }
    jsonResponse(res, 200, { subscribed: true, categories: sub.categories });
  }

  // Send a mock notification of the given category to the caller's
  // subscription. Bypasses rate limiting and category filtering so the
  // user can preview how each type renders on their device.
  function handlePushTest(req, res, body) {
    const parsed = parseJsonOrFail(res, body);
    if (parsed === undefined) return;
    if (!parsed.endpoint || !parsed.category) {
      jsonResponse(res, 400, { error: 'Missing endpoint or category' });
      return;
    }
    const payload = push.buildMockPayload(parsed.category);
    if (!payload) {
      jsonResponse(res, 400, { error: 'Unknown category: ' + parsed.category });
      return;
    }
    push.sendTestToEndpoint(parsed.endpoint, payload, function (err) {
      if (err) {
        const status = err.message === 'Subscription not found' ? 404 : 500;
        jsonResponse(res, status, { error: err.message });
        return;
      }
      jsonResponse(res, 200, { ok: true });
    });
  }

  return {
    handleHealth,
    handleVersion,
    handleRuntimeApi,
    handleHistoryApi,
    handleEventsApi,
    handleDeviceConfigApi,
    handleSensorDiscovery,
    handlePushSubscribe,
    handlePushUnsubscribe,
    handlePushGetSubscription,
    handlePushTest,
  };
}

module.exports = {
  createHandlers,
  readBody,
  jsonResponse,
  parseJsonOrFail,
};
