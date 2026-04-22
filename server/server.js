/**
 * Greenhouse monitoring server — serves playground, proxies Shelly RPC,
 * bridges MQTT→WebSocket, provides history and device config APIs.
 *
 * Usage: node server.js [port]
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const createLogger = require('./lib/logger');
const mqttBridge = require('./lib/mqtt-bridge');
const deviceConfig = require('./lib/device-config');

const otelApi = require('@opentelemetry/api');

const sensorConfig = require('./lib/sensor-config');
const sensorDiscovery = require('./lib/sensor-discovery');
const push = require('./lib/push');
const anomalyManager = require('./lib/anomaly-manager');
const { createScriptMonitor } = require('./lib/script-monitor');
const { handleWsCommand } = require('./lib/ws-command-handlers');
const { createHandlers, readBody, jsonResponse } = require('./lib/http-handlers');
const { getNetworkAddress, printBanner } = require('./lib/banner');

const log = createLogger('server');
const PORT = parseInt(process.env.PORT || process.argv[2] || '3000', 10);
const PLAYGROUND_DIR = path.join(__dirname, '..', 'playground');
const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const VPN_CHECK_HOST = process.env.VPN_CHECK_HOST || '';
const MQTT_HOST = process.env.MQTT_HOST || '';

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mjs': 'application/javascript',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

// ── Static file serving ──
// Playground is served at /; shelly/ and system.yaml served for simulation support.

var SHELLY_DIR = path.join(__dirname, '..', 'shelly');
var REPO_ROOT = path.join(__dirname, '..');

function serveStatic(req, res) {
  var urlPath = new URL(req.url, 'http://localhost').pathname;

  // Serve system.yaml from repo root (playground fetches /system.yaml)
  if (urlPath === '/system.yaml') {
    return serveFile(path.join(REPO_ROOT, 'system.yaml'), urlPath, res);
  }

  // /shelly/* → serve from shelly/ dir (control-logic-loader fetches 'shelly/control-logic.js')
  if (urlPath.startsWith('/shelly/')) {
    var shellyFile = path.join(SHELLY_DIR, urlPath.slice('/shelly'.length));
    if (!shellyFile.startsWith(SHELLY_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
    return serveFile(shellyFile, urlPath, res);
  }

  // Everything else from playground directory
  if (urlPath === '/') urlPath = '/index.html';
  var filePath = path.join(PLAYGROUND_DIR, urlPath);
  if (!filePath.startsWith(PLAYGROUND_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  serveFile(filePath, urlPath, res);
}

function serveFile(filePath, urlPath, res) {
  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    var ext = path.extname(filePath);
    var contentType = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}


// ── Auth middleware ──

var authMiddleware = null;
if (AUTH_ENABLED) {
  authMiddleware = require('./auth/webauthn');
  log.info('auth enabled', { rpId: process.env.RPID || 'localhost' });
}

var db = null;
var scriptMonitor = null;
var handlers = null;

// ── HTTP route detection (for OTel span naming) ──

function resolveRoute(urlPath, method) {
  if (urlPath === '/health') return '/health';
  if (urlPath === '/version') return '/version';
  if (urlPath.startsWith('/auth/users/')) return '/auth/users/*';
  if (urlPath.startsWith('/auth/')) return '/auth/*';
  if (urlPath === '/api/device-config') return '/api/device-config';
  if (urlPath === '/api/sensor-config') return '/api/sensor-config';
  if (urlPath.startsWith('/api/sensor-config/')) return '/api/sensor-config/*';
  if (urlPath === '/api/sensor-discovery') return '/api/sensor-discovery';
  if (urlPath === '/api/history') return '/api/history';
  if (urlPath === '/api/events') return '/api/events';
  if (urlPath.startsWith('/api/push/')) return '/api/push/*';
  if (urlPath === '/ws') return '/ws';
  return urlPath;
}

// ── HTTP Server ──

var server = http.createServer(function (req, res) {
  var urlPath = new URL(req.url, 'http://localhost').pathname;

  // Set http.route on the active span for better grouping in APM
  var route = resolveRoute(urlPath, req.method);
  var span = otelApi.trace.getSpan(otelApi.context.active());
  if (span) {
    span.setAttribute('http.route', route);
    span.updateName(req.method + ' ' + route);
  }

  // Health — always accessible
  if (urlPath === '/health') {
    handlers.handleHealth(req, res);
    return;
  }

  // Version — always accessible (no sensitive data)
  if (urlPath === '/version') {
    handlers.handleVersion(req, res);
    return;
  }

  // Auth endpoints — always accessible
  if (AUTH_ENABLED && urlPath.startsWith('/auth/')) {
    readBody(req, function (body) {
      authMiddleware.handleRequest(req, res, urlPath, body);
    });
    return;
  }

  // /public/* — login page + shared assets (HTML/CSS/JS/fonts) that
  // must load before auth. Public-by-convention: no secrets in there.
  if (urlPath.startsWith('/public/')) {
    serveStatic(req, res);
    return;
  }

  // PWA static assets — Chrome fetches the manifest + icons with
  // `credentials: 'omit'` so they must be reachable without a session
  // cookie or the install flow breaks. Safe: they contain no sensitive
  // data — brand metadata, icons, service-worker script.
  if (
    urlPath === '/sw.js' ||
    urlPath === '/manifest.webmanifest' ||
    urlPath.startsWith('/assets/icon-') ||
    urlPath.startsWith('/assets/badge-') ||
    urlPath.startsWith('/assets/notif-')
  ) {
    serveStatic(req, res);
    return;
  }

  // Push VAPID public key — unauthenticated (needed to create PushSubscription)
  if (urlPath === '/api/push/vapid-key' && req.method === 'GET') {
    var vapidKey = push.getPublicKey();
    if (!vapidKey) {
      jsonResponse(res, 503, { error: 'Push not configured' });
    } else {
      jsonResponse(res, 200, { publicKey: vapidKey });
    }
    return;
  }

  // Device config GET — unauthenticated (Shelly can't do WebAuthn, VPN-only access)
  if (urlPath === '/api/device-config' && req.method === 'GET') {
    deviceConfig.handleGet(req, res);
    return;
  }

  // Sensor config GET — unauthenticated (same rationale as device config)
  if (urlPath === '/api/sensor-config' && req.method === 'GET') {
    sensorConfig.handleGet(req, res);
    return;
  }

  // Auth gate for all other routes
  var authedSession = null;
  var currentUser = null;
  if (AUTH_ENABLED) {
    authedSession = authMiddleware.validateRequest(req);
    if (!authedSession) {
      if (urlPath.startsWith('/api/')) {
        jsonResponse(res, 401, { error: 'Not authenticated' });
      } else {
        res.writeHead(302, { 'Location': '/public/login.html' });
        res.end();
      }
      return;
    }
    currentUser = authMiddleware.getCurrentUser(req);
  }

  // Helper: enforce admin role on mutating endpoints. Read-only users
  // can browse the playground but cannot push config or operate relays.
  function isAdminOrReject() {
    if (!AUTH_ENABLED) return true;
    if (currentUser && currentUser.role === 'admin') return true;
    jsonResponse(res, 403, { error: 'Admin role required' });
    return false;
  }

  // Authenticated routes
  if (urlPath === '/api/device-config') {
    readBody(req, function (body) {
      handlers.handleDeviceConfigApi(req, res, urlPath, body);
    });
  } else if (urlPath === '/api/sensor-config') {
    readBody(req, function (body) {
      if (req.method === 'PUT') {
        if (!isAdminOrReject()) return;
        // Publish the new routing to MQTT right away. The hub bindings for
        // the picked probes already match the cids that collectAssignments
        // resolved from the scan, so the controller can immediately start
        // polling the right cid for each role — closing the gap between the
        // sensors tab (live per-hub reads) and the status view (MQTT snapshot
        // driven by state.temps) without waiting for Apply.
        sensorConfig.handlePut(req, res, body, function (config) {
          if (mqttBridge) {
            mqttBridge.publishSensorConfig(sensorConfig.toCompactFormat(config));
          }
        });
      } else {
        jsonResponse(res, 405, { error: 'Method not allowed' });
      }
    });
  } else if (urlPath === '/api/sensor-config/apply') {
    if (req.method === 'POST') {
      if (!isAdminOrReject()) return;
      sensorConfig.handleApply(req, res, mqttBridge);
    } else {
      jsonResponse(res, 405, { error: 'Method not allowed' });
    }
  } else if (urlPath.startsWith('/api/sensor-config/apply/')) {
    if (req.method === 'POST') {
      if (!isAdminOrReject()) return;
      var targetId = urlPath.split('/').pop();
      sensorConfig.handleApplyTarget(req, res, targetId, mqttBridge);
    } else {
      jsonResponse(res, 405, { error: 'Method not allowed' });
    }
  } else if (urlPath === '/api/sensor-discovery') {
    if (req.method === 'POST') {
      if (!isAdminOrReject()) return;
      readBody(req, function (body) {
        handlers.handleSensorDiscovery(req, res, body);
      });
    } else {
      jsonResponse(res, 405, { error: 'Method not allowed' });
    }
  } else if (urlPath === '/api/push/subscribe' && req.method === 'POST') {
    readBody(req, function (body) {
      handlers.handlePushSubscribe(req, res, body);
    });
  } else if (urlPath === '/api/push/unsubscribe' && req.method === 'POST') {
    readBody(req, function (body) {
      handlers.handlePushUnsubscribe(req, res, body);
    });
  } else if (urlPath === '/api/push/subscription' && req.method === 'POST') {
    readBody(req, function (body) {
      handlers.handlePushGetSubscription(req, res, body);
    });
  } else if (urlPath === '/api/push/test' && req.method === 'POST') {
    readBody(req, function (body) {
      handlers.handlePushTest(req, res, body);
    });
  } else if (urlPath === '/api/history') {
    handlers.handleHistoryApi(req, res);
  } else if (urlPath === '/api/events') {
    handlers.handleEventsApi(req, res);
  } else if (urlPath === '/api/watchdog/state' && req.method === 'GET') {
    anomalyManager.getState().then(function (state) {
      jsonResponse(res, 200, state);
    }).catch(function (err) {
      log.error('watchdog state failed', { error: err.message });
      jsonResponse(res, 500, { error: 'Failed to load watchdog state' });
    });
  } else if (urlPath === '/api/watchdog/ack' && req.method === 'POST') {
    if (!isAdminOrReject()) return;
    readBody(req, function (body) {
      var parsed;
      try { parsed = JSON.parse(body); } catch (e) {
        jsonResponse(res, 400, { error: 'Invalid JSON' });
        return;
      }
      if (!parsed || !parsed.id || typeof parsed.reason !== 'string') {
        jsonResponse(res, 400, { error: 'Missing id or reason' });
        return;
      }
      anomalyManager.ack(parsed.id, parsed.reason, currentUser || { name: 'admin', role: 'admin' })
        .then(function (result) {
          jsonResponse(res, 200, result);
        })
        .catch(function (err) {
          var code = /no matching pending/.test(err.message) ? 409 : 500;
          jsonResponse(res, code, { error: err.message });
        });
    });
  } else if (urlPath === '/api/watchdog/shutdownnow' && req.method === 'POST') {
    if (!isAdminOrReject()) return;
    readBody(req, function (body) {
      var parsed;
      try { parsed = JSON.parse(body); } catch (e) {
        jsonResponse(res, 400, { error: 'Invalid JSON' });
        return;
      }
      if (!parsed || !parsed.id) {
        jsonResponse(res, 400, { error: 'Missing id' });
        return;
      }
      anomalyManager.shutdownNow(parsed.id, currentUser || { name: 'admin', role: 'admin' })
        .then(function () { jsonResponse(res, 200, { ok: true }); })
        .catch(function (err) {
          var code = /no matching pending/.test(err.message) ? 409 : 500;
          jsonResponse(res, code, { error: err.message });
        });
    });
  } else if (urlPath === '/api/script/status' && req.method === 'GET') {
    jsonResponse(res, 200, scriptMonitor ? scriptMonitor.getStatus() : { running: null, reachable: false });
  } else if (urlPath === '/api/script/crashes' && req.method === 'GET') {
    if (!db) { jsonResponse(res, 503, { error: 'Database not available' }); return; }
    var limit = parseInt(new URL(req.url, 'http://localhost').searchParams.get('limit'), 10) || 50;
    db.listScriptCrashes(limit, function (err, rows) {
      if (err) { jsonResponse(res, 500, { error: err.message }); return; }
      jsonResponse(res, 200, { crashes: rows });
    });
  } else if (urlPath.startsWith('/api/script/crashes/') && req.method === 'GET') {
    if (!db) { jsonResponse(res, 503, { error: 'Database not available' }); return; }
    var crashId = urlPath.substring('/api/script/crashes/'.length);
    db.getScriptCrash(crashId, function (err, row) {
      if (err) { jsonResponse(res, 500, { error: err.message }); return; }
      if (!row) { jsonResponse(res, 404, { error: 'Not found' }); return; }
      jsonResponse(res, 200, row);
    });
  } else if (urlPath === '/api/script/restart' && req.method === 'POST') {
    if (!isAdminOrReject()) return;
    if (!scriptMonitor) { jsonResponse(res, 503, { error: 'Script monitor not available' }); return; }
    scriptMonitor.triggerRestart(function (err, result) {
      if (err) { jsonResponse(res, 502, { error: err.message }); return; }
      jsonResponse(res, 200, result);
    });
  } else if (urlPath === '/api/watchdog/enabled' && req.method === 'PUT') {
    if (!isAdminOrReject()) return;
    readBody(req, function (body) {
      var parsed;
      try { parsed = JSON.parse(body); } catch (e) {
        jsonResponse(res, 400, { error: 'Invalid JSON' });
        return;
      }
      if (!parsed || !parsed.id || typeof parsed.enabled !== 'boolean') {
        jsonResponse(res, 400, { error: 'Missing id or enabled' });
        return;
      }
      anomalyManager.setEnabled(parsed.id, parsed.enabled, currentUser || { name: 'admin', role: 'admin' })
        .then(function (updated) { jsonResponse(res, 200, { we: updated.we }); })
        .catch(function (err) {
          jsonResponse(res, 500, { error: err.message });
        });
    });
  } else {
    serveStatic(req, res);
  }
});

// ── WebSocket server + broadcast ──
// anomaly-manager calls broadcastToWebSockets to push watchdog-state.

var wsServer = null;

function broadcastToWebSockets(msg) {
  if (!wsServer) return;
  var str = JSON.stringify(msg);
  wsServer.clients.forEach(function (ws) {
    if (ws.readyState === 1) ws.send(str);
  });
}

function initWebSocket() {
  var WebSocketServer = require('ws').WebSocketServer;
  wsServer = new WebSocketServer({ noServer: true });

  server.on('upgrade', function (req, socket, head) {
    var urlPath = new URL(req.url, 'http://localhost').pathname;
    if (urlPath !== '/ws') {
      socket.destroy();
      return;
    }

    // Auth check for WebSocket upgrade
    var wsUser = null;
    if (AUTH_ENABLED) {
      var session = authMiddleware.validateRequest(req);
      if (!session) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wsUser = authMiddleware.getCurrentUser(req);
    }

    wsServer.handleUpgrade(req, socket, head, function (ws) {
      // Stamp the role on the socket so command handlers can gate writes.
      ws._role = wsUser ? wsUser.role : 'admin';
      wsServer.emit('connection', ws, req);
      // Send current MQTT connection status on connect
      ws.send(JSON.stringify({
        type: 'connection',
        status: mqttBridge.getConnectionStatus(),
      }));
      // Replay the last cached state so the client can render an immediate
      // snapshot instead of waiting up to ~30s for the next Shelly publish.
      var lastState = mqttBridge.getLastState();
      if (lastState) {
        ws.send(JSON.stringify({ type: 'state', data: lastState }));
      }
      // Push the current script health so a late joiner sees the crash
      // banner immediately instead of waiting for the next poll cycle.
      if (scriptMonitor) {
        ws.send(JSON.stringify({ type: 'script-status', data: scriptMonitor.getStatus() }));
      }
      // Handle incoming commands from clients
      ws.on('message', function (data) {
        handleWsCommand(ws, data);
      });
    });
  });

  return wsServer;
}

// ── Startup ──


function initServices(callback) {
  // Resolve DATABASE_URL from env or S3
  var dbModule = require('./lib/db');
  dbModule.resolveUrl(function (err, url) {
    function finish() {
      handlers = createHandlers({
        db: db,
        authMiddleware: authMiddleware,
        broadcastToWebSockets: broadcastToWebSockets,
      });
      callback();
    }
    if (url) {
      db = dbModule;
      db.initSchema(function (schemaErr) {
        if (schemaErr) {
          log.error('db schema init failed', { error: schemaErr.message });
          db = null;
        } else {
          log.info('database initialized');
          db.startMaintenance();
        }
        initAnomalyManager();
        finish();
      });
    } else {
      log.info('DATABASE_URL not found (checked env and S3) — history features disabled');
      initAnomalyManager();
      finish();
    }
  });
}

function initAnomalyManager() {
  anomalyManager.bootstrap({
    db: db,
    push: push,
    wsBroadcast: broadcastToWebSockets,
    mqttBridge: mqttBridge,
    deviceConfig: deviceConfig,
    log: log,
  });
}

function startMqttBridge() {
  if (!MQTT_HOST) {
    log.info('MQTT_HOST not set — live features disabled');
    return;
  }

  var ws = initWebSocket();

  // Script monitor is started alongside the MQTT bridge so its snapshot
  // buffer is fed by the same stream the bridge handles. The monitor
  // pushes "script-status" WS messages on every transition — the
  // playground listens for these to show the crash banner.
  scriptMonitor = createScriptMonitor({ db: db });
  scriptMonitor.onStatusChange(function (status) {
    broadcastToWebSockets({ type: 'script-status', data: status });
  });

  mqttBridge.start({
    mqttHost: MQTT_HOST,
    wsServer: ws,
    db: db,
    deviceConfig: deviceConfig,
    sensorConfig: sensorConfig,
    push: push,
    anomalyManager: anomalyManager,
    onStateSnapshot: function (payload) {
      scriptMonitor.recordStateSnapshot(payload);
    },
  });

  scriptMonitor.start();

  log.info('MQTT bridge started', { host: MQTT_HOST });
}

function startServer() {
  // Load device and sensor config
  deviceConfig.load(function (err) {
    if (err) log.error('device config load failed', { error: err.message });
    sensorConfig.load(function (err) {
      if (err) log.error('sensor config load failed', { error: err.message });
      push.init(function (err) {
        if (err) log.error('push init failed', { error: err.message });

      initServices(function () {
        server.listen(PORT, '0.0.0.0', function () {
          printBanner(PORT, getNetworkAddress());
          log.info('server started', { port: PORT, auth: AUTH_ENABLED, mqtt: !!MQTT_HOST, db: !!db });
          startMqttBridge();
        });
      });
      });
    });
  });
}

// ── Graceful shutdown ──
function shutdown(signal) {
  log.info('shutdown signal received', { signal: signal });
  server.close(function () {
    log.info('server closed');
    process.exit(0);
  });
  // Force exit if close hangs
  setTimeout(function () { process.exit(1); }, 3000);
}
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('SIGINT', function () { shutdown('SIGINT'); });

if (require.main === module) {
  if (AUTH_ENABLED) {
    var session = require('./auth/session');
    var secretCheck = session.validateSecret();
    if (!secretCheck.valid) {
      log.error('FATAL: ' + secretCheck.reason);
      process.exit(1);
    }
    authMiddleware.init(function (err) {
      if (err) log.error('auth init failed, starting with empty credentials', { error: err.message });
      startServer();
    });
  } else {
    startServer();
  }
}

// ── Test-only exports ──
// WS command handlers moved to ./lib/ws-command-handlers.js; tests
// require that module directly now.
module.exports = {
  handleWsCommand: handleWsCommand,
};
