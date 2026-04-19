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
const { createHistory: createWatchdogHistory } = require('./lib/watchdog-history');

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

// Paginated state_events feed for the System Logs UI. Supports newest-first
// cursor pagination so the client can lazy-load older entries on scroll.
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

// ── Device Config API ──

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
        watchdogs: require('../shelly/watchdogs-meta.js').WATCHDOGS,
        snapshot: { we: config.we || {}, wz: config.wz || {}, wb: config.wb || {} }
      });
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

// ── Push subscription handlers ──

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

  // /public/* — accessible without auth. Everything the login page and
  // any other unauthenticated view needs (HTML, CSS, JS, fonts) lives
  // under playground/public/ so this single prefix check covers them
  // all. Keep the directory public-by-convention: do not put anything
  // sensitive there.
  if (urlPath.startsWith('/public/')) {
    serveStatic(req, res);
    return;
  }

  // PWA static assets — accessible without auth.
  // Chrome fetches the manifest and icons with `credentials: 'omit'` by
  // default, so they must be reachable without a session cookie or the
  // install flow breaks (Chrome receives the 302 to the login page and
  // tries to parse the HTML as JSON, failing installability). These files contain
  // no sensitive data — just brand metadata, icons, and the service
  // worker script — so exempting them from auth is standard practice
  // for auth-gated PWAs (Slack, Discord, Notion, etc.).
  //
  // Paths covered:
  //   /sw.js                  — service worker script
  //   /manifest.webmanifest   — PWA manifest
  //   /assets/icon-*.png      — app icons listed in the manifest
  //   /assets/badge-*.png     — Android status-bar silhouette used as
  //                             `badge` in showNotification()
  //   /assets/notif-*.png     — per-category notification icons sent by
  //                             the SW via event.data.icon
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
      handleDeviceConfigApi(req, res, urlPath, body);
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
        handleSensorDiscovery(req, res, body);
      });
    } else {
      jsonResponse(res, 405, { error: 'Method not allowed' });
    }
  } else if (urlPath === '/api/push/subscribe' && req.method === 'POST') {
    readBody(req, function (body) {
      handlePushSubscribe(req, res, body);
    });
  } else if (urlPath === '/api/push/unsubscribe' && req.method === 'POST') {
    readBody(req, function (body) {
      handlePushUnsubscribe(req, res, body);
    });
  } else if (urlPath === '/api/push/subscription' && req.method === 'POST') {
    readBody(req, function (body) {
      handlePushGetSubscription(req, res, body);
    });
  } else if (urlPath === '/api/push/test' && req.method === 'POST') {
    readBody(req, function (body) {
      handlePushTest(req, res, body);
    });
  } else if (urlPath === '/api/history') {
    handleHistoryApi(req, res);
  } else if (urlPath === '/api/events') {
    handleEventsApi(req, res);
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

// ── WebSocket command handling ──

var VALID_RELAYS = ['vi_btm', 'vi_top', 'vi_coll', 'vo_coll', 'vo_rad', 'vo_tank', 'v_air', 'pump', 'fan'];
var overrideTtlTimer = null;

function wsSend(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function handleWsCommand(ws, data) {
  var msg;
  try {
    msg = JSON.parse(data.toString());
  } catch (e) {
    return;
  }
  if (!msg || !msg.type) return;

  // Read-only sessions cannot mutate device state via the websocket.
  if (ws._role && ws._role !== 'admin') {
    wsSend(ws, { type: 'override-error', message: 'Admin role required' });
    return;
  }

  if (msg.type === 'override-enter') {
    handleOverrideEnter(ws, msg);
  } else if (msg.type === 'override-exit') {
    handleOverrideExit(ws);
  } else if (msg.type === 'override-update') {
    handleOverrideUpdate(ws, msg);
  } else if (msg.type === 'override-set-mode') {
    handleOverrideSetMode(ws, msg);
  } else if (msg.type === 'relay-command') {
    handleRelayCommand(ws, msg);
  }
}

function handleOverrideEnter(ws, msg) {
  var cfg = deviceConfig.getConfig();
  if (!cfg.ce) {
    wsSend(ws, { type: 'override-error', message: 'Controls not enabled' });
    return;
  }

  var ttl = Math.max(60, Math.min(3600, parseInt(msg.ttl, 10) || 300));
  var ss = !!msg.suppressSafety;
  var ex = Math.floor(Date.now() / 1000) + ttl;

  deviceConfig.updateConfig({ mo: { a: true, ex: ex, ss: ss } }, function (err, updated) {
    if (err) {
      wsSend(ws, { type: 'override-error', message: err.message });
      return;
    }
    mqttBridge.publishConfig(updated);
    wsSend(ws, { type: 'override-ack', active: true, expiresAt: ex, suppressSafety: ss, forcedMode: (updated.mo && updated.mo.fm) || null });

    // Secondary server-side TTL tracking
    clearOverrideTtlTimer();
    overrideTtlTimer = setTimeout(function () {
      overrideTtlTimer = null;
      var current = deviceConfig.getConfig();
      if (current.mo && current.mo.a) {
        deviceConfig.updateConfig({ mo: null }, function (err2, cleared) {
          if (!err2) mqttBridge.publishConfig(cleared);
        });
      }
    }, ttl * 1000);
  });
}

function handleOverrideExit(ws) {
  clearOverrideTtlTimer();
  deviceConfig.updateConfig({ mo: null }, function (err, updated) {
    if (err) {
      wsSend(ws, { type: 'override-error', message: err.message });
      return;
    }
    mqttBridge.publishConfig(updated);
    wsSend(ws, { type: 'override-ack', active: false, forcedMode: null });
  });
}

function handleOverrideUpdate(ws, msg) {
  var cfg = deviceConfig.getConfig();
  if (!cfg.mo || !cfg.mo.a) {
    wsSend(ws, { type: 'override-error', message: 'Override not active' });
    return;
  }

  var ttl = Math.max(60, Math.min(3600, parseInt(msg.ttl, 10) || 300));
  var ex = Math.floor(Date.now() / 1000) + ttl;

  var newMo = { a: cfg.mo.a, ex: ex, ss: cfg.mo.ss };
  if (cfg.mo.fm) newMo.fm = cfg.mo.fm;
  deviceConfig.updateConfig({ mo: newMo }, function (err, updated) {
    if (err) {
      wsSend(ws, { type: 'override-error', message: err.message });
      return;
    }
    mqttBridge.publishConfig(updated);
    wsSend(ws, { type: 'override-ack', active: true, expiresAt: ex, suppressSafety: cfg.mo.ss, forcedMode: (updated.mo && updated.mo.fm) || null });

    // Reset secondary TTL timer
    clearOverrideTtlTimer();
    overrideTtlTimer = setTimeout(function () {
      overrideTtlTimer = null;
      var current = deviceConfig.getConfig();
      if (current.mo && current.mo.a) {
        deviceConfig.updateConfig({ mo: null }, function (err2, cleared) {
          if (!err2) mqttBridge.publishConfig(cleared);
        });
      }
    }, ttl * 1000);
  });
}

function handleOverrideSetMode(ws, msg) {
  var cfg = deviceConfig.getConfig();
  if (!cfg.mo || !cfg.mo.a) {
    wsSend(ws, { type: 'override-error', message: 'Override not active' });
    return;
  }

  var mode = msg.mode;
  var VALID_MODES = ['I', 'SC', 'GH', 'AD', 'EH'];
  if (mode !== null && VALID_MODES.indexOf(mode) === -1) {
    wsSend(ws, { type: 'override-error', message: 'Invalid mo.fm: must be one of I,SC,GH,AD,EH' });
    return;
  }
  if (mode !== null && cfg.wb && cfg.wb[mode] && cfg.wb[mode] > Math.floor(Date.now() / 1000)) {
    wsSend(ws, { type: 'override-error', message: 'Mode banned' });
    return;
  }

  var newMo = { a: cfg.mo.a, ex: cfg.mo.ex, ss: cfg.mo.ss };
  if (mode !== null) newMo.fm = mode;

  deviceConfig.updateConfig({ mo: newMo }, function (err, updated) {
    if (err) {
      wsSend(ws, { type: 'override-error', message: err.message });
      return;
    }
    mqttBridge.publishConfig(updated);
    wsSend(ws, {
      type: 'override-ack',
      active: true,
      expiresAt: updated.mo.ex,
      suppressSafety: updated.mo.ss,
      forcedMode: updated.mo.fm || null,
    });
  });
}

function handleRelayCommand(ws, msg) {
  var cfg = deviceConfig.getConfig();
  if (!cfg.mo || !cfg.mo.a) {
    wsSend(ws, { type: 'override-error', message: 'Override not active' });
    return;
  }
  var now = Math.floor(Date.now() / 1000);
  if (cfg.mo.ex <= now) {
    wsSend(ws, { type: 'override-error', message: 'Override expired' });
    return;
  }
  if (VALID_RELAYS.indexOf(msg.relay) < 0) {
    wsSend(ws, { type: 'override-error', message: 'Unknown relay: ' + msg.relay });
    return;
  }
  mqttBridge.publishRelayCommand(msg.relay, !!msg.on);
}

function clearOverrideTtlTimer() {
  if (overrideTtlTimer) {
    clearTimeout(overrideTtlTimer);
    overrideTtlTimer = null;
  }
}

// ── WebSocket server ──

var wsServer = null;

// Broadcast a message to all connected WebSocket clients. Used by the
// anomaly-manager to push watchdog-state updates to the UI.
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
      // Handle incoming commands from clients
      ws.on('message', function (data) {
        handleWsCommand(ws, data);
      });
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
        initAnomalyManager();
        callback();
      });
    } else {
      log.info('DATABASE_URL not found (checked env and S3) — history features disabled');
      initAnomalyManager();
      callback();
    }
  });
}

// Initialize the anomaly-manager with its dependencies. Called after DB
// init (or after confirming no DB is available) so the history storage
// can pick the right backend (Postgres when db is present, ring buffer
// fallback otherwise). Also applies the watchdog_events schema when a
// database connection is available.
function initAnomalyManager() {
  // Apply the watchdog_events schema if we have a database connection.
  if (db && typeof db.getPool === 'function') {
    try {
      var pool = db.getPool();
      var sqlPath = path.join(__dirname, 'db', 'watchdog-events-schema.sql');
      var schemaSql = fs.readFileSync(sqlPath, 'utf8');
      pool.query(schemaSql, [], function (schemaErr) {
        if (schemaErr) {
          log.warn('watchdog schema init failed', { error: schemaErr.message });
        } else {
          log.info('watchdog_events schema ready');
        }
      });
    } catch (e) {
      log.warn('failed to apply watchdog schema', { error: e.message });
    }
  }

  var wdHistoryDb = (db && typeof db.getPool === 'function') ? db.getPool() : null;
  var watchdogHistory = createWatchdogHistory({
    db: wdHistoryDb,
    log: log
  });
  anomalyManager.init({
    history: watchdogHistory,
    push: push,
    wsBroadcast: broadcastToWebSockets,
    mqttBridge: mqttBridge,
    deviceConfig: deviceConfig,
    log: log
  });
  log.info('anomaly-manager initialized', { backend: wdHistoryDb ? 'postgres' : 'ring-buffer' });
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
    deviceConfig: deviceConfig,
    sensorConfig: sensorConfig,
    push: push,
    anomalyManager: anomalyManager,
  });

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
// Exported so unit tests can exercise WS command handlers without starting the server.
module.exports = {
  handleWsCommand: handleWsCommand,
  wsSend: wsSend,
};
