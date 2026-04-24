const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// Inject a custom `http` module via Node module cache so the discovery module
// talks to a local test server rather than making real network calls. The
// module uses host + port 80 — we monkey-patch http.request / http.get to
// redirect to our mock port.
function createMockHub(handler) {
  const calls = [];
  const server = http.createServer(function (req, res) {
    let body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      calls.push({ method: req.method, url: req.url, body: body || null });
      handler(req, res, body);
    });
  });
  return { server, calls };
}

function listen(server) {
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () { resolve(server.address().port); });
  });
}

// Wrap the sensor-discovery module so its host:80 calls hit our mock port.
function loadDiscoveryWithRedirect(portMap) {
  // portMap: { '127.0.0.1': <port> } — redirect sends for matching hosts.
  const realRequest = http.request;
  const realGet = http.get;

  const rewrite = function (opts) {
    if (!opts || !opts.host || !portMap[opts.host]) return opts;
    // Redirect to local mock — preserve the original host as a header so the
    // handler could disambiguate, and change both host + port.
    return Object.assign({}, opts, { host: '127.0.0.1', port: portMap[opts.host] });
  };
  http.request = function (opts, cb) { return realRequest.call(http, rewrite(opts), cb); };
  http.get = function (opts, cb) { return realGet.call(http, rewrite(opts), cb); };

  // Force re-require in case cached
  delete require.cache[require.resolve('../server/lib/sensor-discovery')];
  const mod = require('../server/lib/sensor-discovery');

  return {
    mod,
    restore: function () { http.request = realRequest; http.get = realGet; },
  };
}

describe('sensor-discovery (direct HTTP)', () => {
  describe('happy path: single host with temps', () => {
    let mock, port, loaded;

    before(async () => {
      mock = createMockHub(function (req, res, body) {
        if (req.method === 'POST' && req.url === '/rpc') {
          const payload = JSON.parse(body);
          if (payload.method === 'SensorAddon.OneWireScan') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: 1,
              result: {
                devices: [
                  { addr: '40:208:87:71:0:0:0:120', component: 'temperature:100' },
                  { addr: '40:52:155:84:0:0:0:62', component: 'temperature:102' },
                ],
              },
            }));
            return;
          }
        }
        if (req.method === 'GET' && req.url.indexOf('/rpc/Temperature.GetStatus') === 0) {
          const id = new URL('http://x' + req.url).searchParams.get('id');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ tC: id === '100' ? 22.9 : 22.2 }));
          return;
        }
        res.writeHead(404); res.end();
      });
      port = await listen(mock.server);
      loaded = loadDiscoveryWithRedirect({ '127.0.0.1': port });
    });

    after(async () => {
      loaded.restore();
      await new Promise((resolve) => mock.server.close(resolve));
    });

    it('returns per-host result with sensor list and temperatures', async () => {
      const out = await loaded.mod.discoverSensors(['127.0.0.1']);
      assert.ok(out.id && out.id.startsWith('disc-'));
      assert.equal(out.results.length, 1);
      const r = out.results[0];
      assert.equal(r.host, '127.0.0.1');
      assert.strictEqual(r.ok, true);
      assert.equal(r.sensors.length, 2);
      assert.equal(r.sensors[0].addr, '40:208:87:71:0:0:0:120');
      assert.equal(r.sensors[0].component, 'temperature:100');
      assert.equal(r.sensors[0].tC, 22.9);
      assert.equal(r.sensors[1].tC, 22.2);
    });

    it('skipTemp returns sensors without polling temperatures', async () => {
      mock.calls.length = 0;
      const out = await loaded.mod.discoverSensors(['127.0.0.1'], { skipTemp: true });
      const r = out.results[0];
      assert.strictEqual(r.ok, true);
      assert.equal(r.sensors.length, 2);
      assert.strictEqual(r.sensors[0].tC, null);
      // No Temperature.GetStatus calls were made
      const tempCalls = mock.calls.filter(c => c.url.indexOf('Temperature.GetStatus') !== -1);
      assert.equal(tempCalls.length, 0);
    });
  });

  describe('accepts bare {devices: ...} (no result wrapper)', () => {
    let mock, port, loaded;

    before(async () => {
      mock = createMockHub(function (req, res) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ devices: [{ addr: 'aa:bb', component: null }] }));
      });
      port = await listen(mock.server);
      loaded = loadDiscoveryWithRedirect({ '127.0.0.1': port });
    });

    after(async () => {
      loaded.restore();
      await new Promise((resolve) => mock.server.close(resolve));
    });

    it('extracts devices from bare response', async () => {
      const out = await loaded.mod.discoverSensors(['127.0.0.1'], { skipTemp: true });
      assert.strictEqual(out.results[0].ok, true);
      assert.equal(out.results[0].sensors[0].addr, 'aa:bb');
    });
  });

  describe('one host fails, other succeeds', () => {
    let okServer, badServer, okPort, badPort, loaded;

    before(async () => {
      const ok = createMockHub(function (req, res) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { devices: [] } }));
      });
      okServer = ok.server;
      okPort = await listen(okServer);

      const bad = createMockHub(function (req, res) {
        res.writeHead(500);
        res.end('nope');
      });
      badServer = bad.server;
      badPort = await listen(badServer);

      loaded = loadDiscoveryWithRedirect({ '127.0.0.1': okPort, '127.0.0.2': badPort });
    });

    after(async () => {
      loaded.restore();
      await Promise.all([
        new Promise((resolve) => okServer.close(resolve)),
        new Promise((resolve) => badServer.close(resolve)),
      ]);
    });

    it('returns per-host status — one ok, one error — in parallel', async () => {
      const out = await loaded.mod.discoverSensors(['127.0.0.1', '127.0.0.2'], { skipTemp: true });
      assert.equal(out.results.length, 2);
      const first = out.results.find(r => r.host === '127.0.0.1');
      const second = out.results.find(r => r.host === '127.0.0.2');
      assert.strictEqual(first.ok, true);
      assert.strictEqual(second.ok, false);
      assert.ok(/HTTP 500/.test(second.error));
    });
  });

  describe('unreachable host', () => {
    let loaded;

    before(() => {
      // No mock server bound at this port — connection refused.
      loaded = loadDiscoveryWithRedirect({ '127.0.0.1': 1 });
    });

    after(() => {
      loaded.restore();
    });

    it('returns a friendly per-host error rather than rejecting', async () => {
      const out = await loaded.mod.discoverSensors(['127.0.0.1'], { skipTemp: true });
      assert.equal(out.results.length, 1);
      assert.strictEqual(out.results[0].ok, false);
      assert.ok(/refused|ECONNREFUSED|unreachable/i.test(out.results[0].error),
        'expected friendly connection error, got: ' + out.results[0].error);
    });
  });

  describe('per-host overall timeout', () => {
    let slowServer, slowPort, loaded;

    before(async () => {
      const slow = createMockHub(function (req, res) {
        // Never respond — client must time out.
        setTimeout(function () { res.writeHead(200); res.end('{}'); }, 60000).unref();
      });
      slowServer = slow.server;
      slowPort = await listen(slowServer);
      loaded = loadDiscoveryWithRedirect({ '127.0.0.1': slowPort });
    });

    after(async () => {
      loaded.restore();
      await new Promise((resolve) => slowServer.close(resolve));
    });

    it('resolves with an error result when the host exceeds its budget', async () => {
      const out = await loaded.mod.discoverSensors(['127.0.0.1'], {
        skipTemp: true,
        rpcTimeoutMs: 150,
        perHostTimeoutMs: 300,
      });
      assert.strictEqual(out.results[0].ok, false);
      assert.ok(/timed out|exceeded|No response/i.test(out.results[0].error),
        'expected timeout error, got: ' + out.results[0].error);
    });
  });

  describe('friendlyNetError mapping', () => {
    it('maps common errno codes to readable messages', () => {
      delete require.cache[require.resolve('../server/lib/sensor-discovery')];
      const mod = require('../server/lib/sensor-discovery');
      const fn = mod._internals.friendlyNetError;
      assert.ok(fn({ code: 'ECONNREFUSED' }, '1.2.3.4').includes('refused'));
      assert.ok(fn({ code: 'EHOSTUNREACH' }, '1.2.3.4').includes('unreachable'));
      assert.ok(fn({ code: 'ETIMEDOUT' }, '1.2.3.4').includes('timed out'));
    });
  });
});
