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
const createLogger = require('./logger');

const log = createLogger('http');
const APP_VERSION = process.env.GIT_COMMIT || 'unknown';
const VPN_CHECK_HOST = process.env.VPN_CHECK_HOST || '';
const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';

function checkVpn(callback) {
  if (!VPN_CHECK_HOST) { callback('unknown'); return; }
  var parts = VPN_CHECK_HOST.split(':');
  var host = parts[0];
  var port = parseInt(parts[1] || '80', 10);
  var sock = net.createConnection({ host: host, port: port, timeout: 2000 });
  sock.on('connect', function () { sock.destroy(); callback('connected'); });
  sock.on('error', function () { sock.destroy(); callback('disconnected'); });
  sock.on('timeout', function () { sock.destroy(); callback('disconnected'); });
}

function readBody(req, callback) {
  var body = '';
  req.on('data', function (chunk) { body += chunk; });
  req.on('end', function () { callback(body); });
}

function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function createHandlers(deps) {
  var db = deps.db;
  var authMiddleware = deps.authMiddleware;
  var broadcastToWebSockets = deps.broadcastToWebSockets;

  function handleHealth(req, res) {
    checkVpn(function (vpnStatus) {
      var status = vpnStatus === 'disconnected' ? 'degraded' : 'ok';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: status,
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

  function handleHistoryApi(req, res) {
    if (!db) {
      jsonResponse(res, 503, { error: 'Database not available' });
      return;
    }

    var parsed = new URL(req.url, 'http://localhost');
    var range = parsed.searchParams.get('range') || '6h';
    var sensor = parsed.searchParams.get('sensor') || null;

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
        jsonResponse(res, 200, { range: range, points: points, events: events });
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

    var parsed = new URL(req.url, 'http://localhost');
    var type = parsed.searchParams.get('type') || 'mode';
    var limit = parseInt(parsed.searchParams.get('limit'), 10) || 10;
    var beforeRaw = parsed.searchParams.get('before');
    var before = beforeRaw ? parseInt(beforeRaw, 10) : null;
    if (beforeRaw && (Number.isNaN(before) || before <= 0)) {
      jsonResponse(res, 400, { error: 'Invalid `before` cursor' });
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
      deviceConfig.handlePut(req, res, body, function (config) {
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
      });
      return;
    }

    jsonResponse(res, 405, { error: 'Method not allowed' });
  }

  function handleSensorDiscovery(req, res, body) {
    var parsed;
    try { parsed = JSON.parse(body); } catch (e) {
      jsonResponse(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    if (!parsed.hosts || !Array.isArray(parsed.hosts)) {
      jsonResponse(res, 400, { error: 'Missing hosts array' });
      return;
    }
    // Direct HTTP scan of each hub in parallel. Bypasses the Pro 4PM + MQTT
    // path because it was slow and produced opaque timeouts on a single hub
    // failure. See server/lib/sensor-discovery.js.
    var options = {};
    if (parsed.skipTemp) options.skipTemp = true;
    sensorDiscovery.discoverSensors(parsed.hosts, options).then(function (result) {
      jsonResponse(res, 200, result);
    }).catch(function (err) {
      jsonResponse(res, 500, { error: err.message || String(err) });
    });
  }

  function handlePushSubscribe(req, res, body) {
    var parsed;
    try { parsed = JSON.parse(body); } catch (e) {
      jsonResponse(res, 400, { error: 'Invalid JSON' });
      return;
    }
    if (!parsed.subscription || !parsed.subscription.endpoint || !parsed.subscription.keys) {
      jsonResponse(res, 400, { error: 'Missing subscription object (endpoint + keys)' });
      return;
    }
    var categories = Array.isArray(parsed.categories) ? parsed.categories : [];
    push.addSubscription(parsed.subscription, categories, function (err) {
      if (err) {
        jsonResponse(res, 500, { error: 'Failed to save subscription' });
        return;
      }
      jsonResponse(res, 200, { ok: true });
    });
  }

  function handlePushUnsubscribe(req, res, body) {
    var parsed;
    try { parsed = JSON.parse(body); } catch (e) {
      jsonResponse(res, 400, { error: 'Invalid JSON' });
      return;
    }
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
    var parsed;
    try { parsed = JSON.parse(body); } catch (e) {
      jsonResponse(res, 400, { error: 'Invalid JSON' });
      return;
    }
    if (!parsed.endpoint) {
      jsonResponse(res, 400, { error: 'Missing endpoint' });
      return;
    }
    var sub = push.getSubscription(parsed.endpoint);
    if (!sub) {
      jsonResponse(res, 200, { subscribed: false, categories: [] });
      return;
    }
    jsonResponse(res, 200, { subscribed: true, categories: sub.categories });
  }

  // Send a mock notification of the given category to the caller's
  // subscription. Bypasses rate limiting and category filtering so the
  // user can preview how each notification type renders on their device.
  function handlePushTest(req, res, body) {
    var parsed;
    try { parsed = JSON.parse(body); } catch (e) {
      jsonResponse(res, 400, { error: 'Invalid JSON' });
      return;
    }
    if (!parsed.endpoint || !parsed.category) {
      jsonResponse(res, 400, { error: 'Missing endpoint or category' });
      return;
    }
    var payload = push.buildMockPayload(parsed.category);
    if (!payload) {
      jsonResponse(res, 400, { error: 'Unknown category: ' + parsed.category });
      return;
    }
    push.sendTestToEndpoint(parsed.endpoint, payload, function (err) {
      if (err) {
        var status = err.message === 'Subscription not found' ? 404 : 500;
        jsonResponse(res, status, { error: err.message });
        return;
      }
      jsonResponse(res, 200, { ok: true });
    });
  }

  return {
    handleHealth: handleHealth,
    handleVersion: handleVersion,
    handleHistoryApi: handleHistoryApi,
    handleEventsApi: handleEventsApi,
    handleDeviceConfigApi: handleDeviceConfigApi,
    handleSensorDiscovery: handleSensorDiscovery,
    handlePushSubscribe: handlePushSubscribe,
    handlePushUnsubscribe: handlePushUnsubscribe,
    handlePushGetSubscription: handlePushGetSubscription,
    handlePushTest: handlePushTest,
  };
}

module.exports = {
  createHandlers: createHandlers,
  readBody: readBody,
  jsonResponse: jsonResponse,
};
