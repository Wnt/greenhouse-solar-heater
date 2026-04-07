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

// ── Health endpoint ──

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

// ── Version endpoint ──
// Returns the git commit hash for client-side change detection.
// GIT_COMMIT is baked into the Docker image at build time (see Dockerfile).

var APP_VERSION = process.env.GIT_COMMIT || 'unknown';

function handleVersion(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ hash: APP_VERSION }));
}

// ── Auth middleware ──

var authMiddleware = null;
if (AUTH_ENABLED) {
  authMiddleware = require('./auth/webauthn');
  log.info('auth enabled', { rpId: process.env.RPID || 'localhost' });
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

// ── History API ──

var db = null;

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

// ── Device Config API ──

function handleDeviceConfigApi(req, res, urlPath, body) {
  if (req.method === 'GET') {
    deviceConfig.handleGet(req, res);
    return;
  }

  if (req.method === 'PUT') {
    // PUT requires auth
    if (AUTH_ENABLED) {
      var session = authMiddleware.validateRequest(req);
      if (!session) {
        jsonResponse(res, 401, { error: 'Not authenticated' });
        return;
      }
    }
    deviceConfig.handlePut(req, res, body, function (config) {
      // Publish to MQTT for instant push to device
      mqttBridge.publishConfig(config);
    });
    return;
  }

  jsonResponse(res, 405, { error: 'Method not allowed' });
}

// ── Sensor Discovery API ──

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
  mqttBridge.publishDiscoveryRequest(parsed.hosts).then(function (result) {
    jsonResponse(res, 200, result);
  }).catch(function (err) {
    var msg = err.message || String(err);
    var statusCode = msg === 'Request timed out' ? 504 : msg === 'MQTT not connected' ? 503 : 500;
    jsonResponse(res, statusCode, { error: msg });
  });
}

// ── HTTP route detection (for OTel span naming) ──

function resolveRoute(urlPath, method) {
  if (urlPath === '/health') return '/health';
  if (urlPath === '/version') return '/version';
  if (urlPath.startsWith('/auth/')) return '/auth/*';
  if (urlPath === '/api/device-config') return '/api/device-config';
  if (urlPath === '/api/sensor-config') return '/api/sensor-config';
  if (urlPath.startsWith('/api/sensor-config/')) return '/api/sensor-config/*';
  if (urlPath === '/api/sensor-discovery') return '/api/sensor-discovery';
  if (urlPath === '/api/history') return '/api/history';
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
    handleHealth(req, res);
    return;
  }

  // Version — always accessible (no sensitive data)
  if (urlPath === '/version') {
    handleVersion(req, res);
    return;
  }

  // Auth endpoints — always accessible
  if (AUTH_ENABLED && urlPath.startsWith('/auth/')) {
    readBody(req, function (body) {
      authMiddleware.handleRequest(req, res, urlPath, body);
    });
    return;
  }

  // Login page and its assets — accessible without auth
  if (urlPath === '/login.html' || urlPath === '/js/login.js' || urlPath === '/vendor/simplewebauthn-browser.mjs' || urlPath === '/vendor/qrcode-generator.mjs') {
    serveStatic(req, res);
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
  if (AUTH_ENABLED) {
    var session = authMiddleware.validateRequest(req);
    if (!session) {
      if (urlPath.startsWith('/api/')) {
        jsonResponse(res, 401, { error: 'Not authenticated' });
      } else {
        res.writeHead(302, { 'Location': '/login.html' });
        res.end();
      }
      return;
    }
  }

  // Authenticated routes
  if (urlPath === '/api/device-config') {
    readBody(req, function (body) {
      handleDeviceConfigApi(req, res, urlPath, body);
    });
  } else if (urlPath === '/api/sensor-config') {
    readBody(req, function (body) {
      if (req.method === 'PUT') {
        sensorConfig.handlePut(req, res, body);
      } else {
        jsonResponse(res, 405, { error: 'Method not allowed' });
      }
    });
  } else if (urlPath === '/api/sensor-config/apply') {
    if (req.method === 'POST') {
      sensorConfig.handleApply(req, res, mqttBridge);
    } else {
      jsonResponse(res, 405, { error: 'Method not allowed' });
    }
  } else if (urlPath.startsWith('/api/sensor-config/apply/')) {
    if (req.method === 'POST') {
      var targetId = urlPath.split('/').pop();
      sensorConfig.handleApplyTarget(req, res, targetId, mqttBridge);
    } else {
      jsonResponse(res, 405, { error: 'Method not allowed' });
    }
  } else if (urlPath === '/api/sensor-discovery') {
    if (req.method === 'POST') {
      readBody(req, function (body) {
        handleSensorDiscovery(req, res, body);
      });
    } else {
      jsonResponse(res, 405, { error: 'Method not allowed' });
    }
  } else if (urlPath === '/api/history') {
    handleHistoryApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

// ── WebSocket server ──

var wsServer = null;

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
    if (AUTH_ENABLED) {
      var session = authMiddleware.validateRequest(req);
      if (!session) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wsServer.handleUpgrade(req, socket, head, function (ws) {
      wsServer.emit('connection', ws, req);
      // Send current MQTT connection status on connect
      ws.send(JSON.stringify({
        type: 'connection',
        status: mqttBridge.getConnectionStatus(),
      }));
    });
  });

  return wsServer;
}

// ── Startup ──

function getNetworkAddress() {
  var interfaces = os.networkInterfaces();
  for (var name in interfaces) {
    var addrs = interfaces[name];
    for (var i = 0; i < addrs.length; i++) {
      if (addrs[i].family === 'IPv4' && !addrs[i].internal) {
        return addrs[i].address;
      }
    }
  }
  return null;
}

function printBanner(port, networkIp) {
  var local = 'http://localhost:' + port;
  var network = networkIp ? 'http://' + networkIp + ':' + port : null;

  var lines = ['', '   Serving!', '', '   - Local:    ' + local];
  if (network) lines.push('   - Network:  ' + network);
  lines.push('');

  var maxLen = 0;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].length > maxLen) maxLen = lines[i].length;
  }
  var width = maxLen + 4;
  console.log('');
  console.log('   \u250c' + '\u2500'.repeat(width) + '\u2510');
  for (var j = 0; j < lines.length; j++) {
    var padded = lines[j] + ' '.repeat(width - lines[j].length);
    console.log('   \u2502' + padded + '\u2502');
  }
  console.log('   \u2514' + '\u2500'.repeat(width) + '\u2518');
  console.log('');
}

function initServices(callback) {
  // Resolve DATABASE_URL from env or S3
  var dbModule = require('./lib/db');
  dbModule.resolveUrl(function (err, url) {
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
        callback();
      });
    } else {
      log.info('DATABASE_URL not found (checked env and S3) — history features disabled');
      callback();
    }
  });
}

function startMqttBridge() {
  if (!MQTT_HOST) {
    log.info('MQTT_HOST not set — live features disabled');
    return;
  }

  var ws = initWebSocket();

  mqttBridge.start({
    mqttHost: MQTT_HOST,
    wsServer: ws,
    db: db,
  });

  log.info('MQTT bridge started', { host: MQTT_HOST });
}

function startServer() {
  // Load device and sensor config
  deviceConfig.load(function (err) {
    if (err) log.error('device config load failed', { error: err.message });
    sensorConfig.load(function (err) {
      if (err) log.error('sensor config load failed', { error: err.message });

      initServices(function () {
        server.listen(PORT, '0.0.0.0', function () {
          printBanner(PORT, getNetworkAddress());
          log.info('server started', { port: PORT, auth: AUTH_ENABLED, mqtt: !!MQTT_HOST, db: !!db });
          startMqttBridge();
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
