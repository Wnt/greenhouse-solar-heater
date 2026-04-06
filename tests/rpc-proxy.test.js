/**
 * Unit tests for RPC proxy security middleware.
 * Tests marker header validation, method enforcement, CORS preflight,
 * and body parsing for the /api/rpc/ endpoint.
 */
var { describe, it, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert/strict');
var http = require('http');

// Constants matching server implementation
var MARKER_HEADER = 'x-requested-with';
var MARKER_VALUE = 'greenhouse-monitor';

/**
 * Helper: make an HTTP request to the test server.
 */
function request(port, opts) {
  return new Promise(function (resolve, reject) {
    var options = {
      hostname: '127.0.0.1',
      port: port,
      path: opts.path || '/api/rpc/Shelly.GetDeviceInfo',
      method: opts.method || 'POST',
      headers: opts.headers || {},
    };
    var req = http.request(options, function (res) {
      var body = '';
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers, body: body });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/**
 * Create a minimal mock Shelly device that responds to GET /rpc/*.
 */
function createMockShelly(callback) {
  var s = http.createServer(function (req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 1, src: 'mock-shelly' }));
  });
  s.listen(0, '127.0.0.1', function () {
    callback(s, s.address().port);
  });
}

describe('rpc-proxy security', function () {
  var proxyServer;
  var proxyPort;
  var shellyServer;
  var shellyPort;

  beforeEach(function (t) {
    return new Promise(function (resolve) {
      createMockShelly(function (shelly, sPort) {
        shellyServer = shelly;
        shellyPort = sPort;

        // Point CONTROLLER_IP at the mock Shelly backend
        process.env.CONTROLLER_IP = '127.0.0.1:' + shellyPort;

        // Create a minimal server that replicates the proxy logic
        // We import the actual server module indirectly by testing the behavior
        // For unit tests, we replicate the middleware logic inline
        proxyServer = http.createServer(function (req, res) {
          var urlPath = new URL(req.url, 'http://localhost').pathname;

          // Only handle /api/rpc/ routes
          if (!urlPath.startsWith('/api/rpc/')) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }

          // OPTIONS preflight
          if (req.method === 'OPTIONS') {
            var origin = process.env.ORIGIN || '';
            res.writeHead(204, {
              'Access-Control-Allow-Origin': origin || req.headers.origin || '*',
              'Access-Control-Allow-Methods': 'POST',
              'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
              'Access-Control-Max-Age': '86400',
            });
            res.end();
            return;
          }

          // Method enforcement
          if (req.method !== 'POST') {
            res.writeHead(405, {
              'Allow': 'POST, OPTIONS',
              'Content-Type': 'application/json',
            });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
          }

          // Marker header check
          var headerVal = req.headers[MARKER_HEADER];
          if (headerVal !== MARKER_VALUE) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden' }));
            return;
          }

          // Parse JSON body
          var body = '';
          req.on('data', function (chunk) { body += chunk; });
          req.on('end', function () {
            var parsed;
            try { parsed = JSON.parse(body); } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON body' }));
              return;
            }

            // Determine target host: _host override or CONTROLLER_IP default
            var host = parsed._host || process.env.CONTROLLER_IP;
            if (!host) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Controller IP not configured' }));
              return;
            }

            // Validate host against allowlist
            var allowlist = {};
            var ctrlIp = process.env.CONTROLLER_IP;
            if (ctrlIp) allowlist[ctrlIp] = true;
            var sensorIps = (process.env.SENSOR_HOST_IPS || '').split(',').filter(Boolean);
            for (var si = 0; si < sensorIps.length; si++) {
              allowlist[sensorIps[si].trim()] = true;
            }
            if (!allowlist[host]) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Host not in allowlist' }));
              return;
            }

            // Build Shelly URL from body params (exclude _host if present)
            var rpcPath = urlPath.replace(/^\/api/, '');
            var params = new URLSearchParams();
            for (var key in parsed) {
              if (key !== '_host') params.set(key, parsed[key]);
            }
            var query = params.toString();
            var shellyUrl = 'http://' + host + rpcPath + (query ? '?' + query : '');

            var corsOrigin = process.env.ORIGIN || '';
            http.get(shellyUrl, { timeout: 5000 }, function (shellyRes) {
              var data = '';
              shellyRes.on('data', function (chunk) { data += chunk; });
              shellyRes.on('end', function () {
                res.writeHead(shellyRes.statusCode, {
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': corsOrigin || req.headers.origin || '*',
                });
                res.end(data);
              });
            }).on('error', function (err) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
            });
          });
        });

        proxyServer.listen(0, '127.0.0.1', function () {
          proxyPort = proxyServer.address().port;
          resolve();
        });
      });
    });
  });

  afterEach(function () {
    delete process.env.CONTROLLER_IP;
    return Promise.all([
      new Promise(function (r) { if (proxyServer) proxyServer.close(r); else r(); }),
      new Promise(function (r) { if (shellyServer) shellyServer.close(r); else r(); }),
    ]);
  });

  describe('marker header validation', function () {
    it('rejects POST without marker header with 403', async function () {
      var res = await request(proxyPort, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 1 }),
      });
      assert.equal(res.status, 403);
      var data = JSON.parse(res.body);
      assert.equal(data.error, 'Forbidden');
    });

    it('rejects POST with wrong marker header value with 403', async function () {
      var res = await request(proxyPort, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'wrong-value',
        },
        body: JSON.stringify({ id: 1 }),
      });
      assert.equal(res.status, 403);
    });

    it('accepts POST with correct marker header', async function () {
      var res = await request(proxyPort, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': MARKER_VALUE,
        },
        body: JSON.stringify({ id: 1 }),
      });
      assert.equal(res.status, 200);
      var data = JSON.parse(res.body);
      assert.equal(data.src, 'mock-shelly');
    });
  });

  describe('method enforcement', function () {
    it('rejects GET with 405', async function () {
      var res = await request(proxyPort, {
        method: 'GET',
        path: '/api/rpc/Shelly.GetDeviceInfo?_host=127.0.0.1',
        headers: { 'X-Requested-With': MARKER_VALUE },
      });
      assert.equal(res.status, 405);
      assert.ok(res.headers.allow);
      assert.ok(res.headers.allow.includes('POST'));
    });

    it('accepts POST method', async function () {
      var res = await request(proxyPort, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': MARKER_VALUE,
        },
        body: JSON.stringify({ id: 1 }),
      });
      assert.equal(res.status, 200);
    });
  });

  describe('body parsing', function () {
    it('returns 503 when CONTROLLER_IP is not configured', async function () {
      delete process.env.CONTROLLER_IP;
      var res = await request(proxyPort, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': MARKER_VALUE,
        },
        body: JSON.stringify({ id: 1 }),
      });
      assert.equal(res.status, 503);
      var data = JSON.parse(res.body);
      assert.equal(data.error, 'Controller IP not configured');
      // Restore for other tests
      process.env.CONTROLLER_IP = '127.0.0.1:' + shellyPort;
    });

    it('forwards body params as query string to Shelly device', async function () {
      var res = await request(proxyPort, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': MARKER_VALUE,
        },
        body: JSON.stringify({ id: 1, code: 'getStatus()' }),
      });
      assert.equal(res.status, 200);
    });

    it('rejects _host not in allowlist with 403', async function () {
      var res = await request(proxyPort, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': MARKER_VALUE,
        },
        body: JSON.stringify({ _host: '10.0.0.1', id: 1 }),
      });
      assert.equal(res.status, 403);
      var data = JSON.parse(res.body);
      assert.equal(data.error, 'Host not in allowlist');
    });

    it('allows _host that matches CONTROLLER_IP', async function () {
      var capturedUrl;
      shellyServer.removeAllListeners('request');
      shellyServer.on('request', function (req, res) {
        capturedUrl = req.url;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 1, src: 'mock-shelly' }));
      });

      var res = await request(proxyPort, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': MARKER_VALUE,
        },
        body: JSON.stringify({ _host: process.env.CONTROLLER_IP, id: 1 }),
      });
      assert.equal(res.status, 200);
      assert.ok(capturedUrl, 'mock shelly should have received the request');
      assert.ok(!capturedUrl.includes('_host'), '_host must not appear in forwarded URL');
    });

    it('allows _host that matches SENSOR_HOST_IPS entry', async function () {
      // Add the mock shelly as a sensor host IP
      process.env.SENSOR_HOST_IPS = '127.0.0.1:' + shellyPort + ',192.168.30.21';

      var res = await request(proxyPort, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': MARKER_VALUE,
        },
        body: JSON.stringify({ _host: '127.0.0.1:' + shellyPort, id: 1 }),
      });
      assert.equal(res.status, 200);
      delete process.env.SENSOR_HOST_IPS;
    });
  });

  describe('CORS preflight', function () {
    it('responds to OPTIONS with 204 and correct headers', async function () {
      var res = await request(proxyPort, {
        method: 'OPTIONS',
        path: '/api/rpc/Script.Eval',
        headers: {
          'Origin': 'https://evil.example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'X-Requested-With, Content-Type',
        },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers['access-control-allow-methods'], 'POST');
      assert.ok(res.headers['access-control-allow-headers'].includes('X-Requested-With'));
      assert.ok(res.headers['access-control-allow-headers'].includes('Content-Type'));
      assert.equal(res.headers['access-control-max-age'], '86400');
    });

    it('uses ORIGIN env var for Access-Control-Allow-Origin when set', async function () {
      var origOrigin = process.env.ORIGIN;
      process.env.ORIGIN = 'https://greenhouse.madekivi.fi';
      try {
        var res = await request(proxyPort, {
          method: 'OPTIONS',
          path: '/api/rpc/Script.Eval',
          headers: { 'Origin': 'https://evil.example.com' },
        });
        assert.equal(res.headers['access-control-allow-origin'], 'https://greenhouse.madekivi.fi');
      } finally {
        if (origOrigin === undefined) {
          delete process.env.ORIGIN;
        } else {
          process.env.ORIGIN = origOrigin;
        }
      }
    });

    it('POST response includes restrictive Access-Control-Allow-Origin', async function () {
      var origOrigin = process.env.ORIGIN;
      process.env.ORIGIN = 'https://greenhouse.madekivi.fi';
      try {
        var res = await request(proxyPort, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': MARKER_VALUE,
          },
          body: JSON.stringify({ id: 1 }),
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers['access-control-allow-origin'], 'https://greenhouse.madekivi.fi');
      } finally {
        if (origOrigin === undefined) {
          delete process.env.ORIGIN;
        } else {
          process.env.ORIGIN = origOrigin;
        }
      }
    });
  });
});
