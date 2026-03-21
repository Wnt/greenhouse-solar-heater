/**
 * PoC dev server — serves static files and proxies /api/rpc/* to a Shelly device.
 *
 * Usage: node server.js [port]
 *   port defaults to 3000
 *
 * The Shelly device IP is sent by the browser as a query param:
 *   /api/rpc/Temperature.GetStatus?id=0&_host=192.168.1.20
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const createLogger = require('./lib/logger');

const log = createLogger('server');
const PORT = parseInt(process.env.PORT || process.argv[2] || '3000', 10);
const STATIC_DIR = __dirname;
const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const VPN_CHECK_HOST = process.env.VPN_CHECK_HOST || ''; // Shelly IP to check VPN connectivity

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
};

function serveStatic(req, res) {
  var urlPath = new URL(req.url, 'http://localhost').pathname;
  if (urlPath === '/') urlPath = '/index.html';
  var filePath = path.join(STATIC_DIR, urlPath);

  // Prevent directory traversal
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    var ext = path.extname(filePath);
    var contentType = MIME[ext] || 'application/octet-stream';
    // Serve manifest.json with proper PWA content type
    if (urlPath === '/manifest.json') contentType = 'application/manifest+json';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function proxyRpc(req, res) {
  var parsed = new URL(req.url, 'http://localhost');
  var host = parsed.searchParams.get('_host');
  if (!host) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing _host parameter' }));
    return;
  }

  // Strip /api prefix and _host param, forward to Shelly device
  var rpcPath = parsed.pathname.replace(/^\/api/, '');
  parsed.searchParams.delete('_host');
  var query = parsed.searchParams.toString();
  var shellyUrl = 'http://' + host + rpcPath + (query ? '?' + query : '');

  http.get(shellyUrl, { timeout: 5000 }, function (shellyRes) {
    var body = '';
    shellyRes.on('data', function (chunk) { body += chunk; });
    shellyRes.on('end', function () {
      res.writeHead(shellyRes.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
    });
  }).on('error', function (err) {
    var isTimeout = err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED';
    var isUnreachable = err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH';
    var statusCode = isUnreachable ? 503 : 502;
    var message = isTimeout
      ? 'Device unreachable: request timed out after 5s'
      : isUnreachable
        ? 'Device unreachable: ' + err.message + ' (check VPN connectivity)'
        : 'Device unreachable: ' + err.message;
    log.warn('proxy error', { host: host, code: err.code, message: err.message });
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  });
}

// ── Health endpoint (no auth required) ──

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
      timestamp: new Date().toISOString(),
    }));
  });
}

// ── Auth middleware (loaded lazily when AUTH_ENABLED) ──

var authMiddleware = null;
if (AUTH_ENABLED) {
  authMiddleware = require('./auth/webauthn');
  authMiddleware.init();
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

var server = http.createServer(function (req, res) {
  var urlPath = new URL(req.url, 'http://localhost').pathname;

  // Health — always accessible
  if (urlPath === '/health') {
    handleHealth(req, res);
    return;
  }

  // Auth endpoints — always accessible (they handle their own auth)
  if (AUTH_ENABLED && urlPath.startsWith('/auth/')) {
    readBody(req, function (body) {
      authMiddleware.handleRequest(req, res, urlPath, body);
    });
    return;
  }

  // Login page and its assets — accessible without auth
  if (urlPath === '/login.html' || urlPath === '/js/login.js' || urlPath === '/vendor/simplewebauthn-browser.mjs' || urlPath === '/css/style.css') {
    serveStatic(req, res);
    return;
  }

  // Auth gate — check session for all other routes
  if (AUTH_ENABLED) {
    var session = authMiddleware.validateRequest(req);
    if (!session) {
      // API requests get JSON 401, page requests redirect to login
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
  if (req.url.startsWith('/api/rpc/')) {
    proxyRpc(req, res);
  } else {
    serveStatic(req, res);
  }
});

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

  var lines = [
    '',
    '   Serving!',
    '',
    '   - Local:    ' + local,
  ];
  if (network) {
    lines.push('   - Network:  ' + network);
  }
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

server.listen(PORT, '0.0.0.0', function () {
  printBanner(PORT, getNetworkAddress());
  log.info('server started', { port: PORT, auth: AUTH_ENABLED });
});
