const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// Redirect sensor-apply's http.request / http.get to a local mock port so we
// can simulate Add-on behavior without real Shelly hubs.
function loadWithRedirect(portMap) {
  const realRequest = http.request;
  const realGet = http.get;
  const rewrite = (opts) => {
    if (!opts || !opts.host || !portMap[opts.host]) return opts;
    return Object.assign({}, opts, { host: '127.0.0.1', port: portMap[opts.host] });
  };
  http.request = function (opts, cb) { return realRequest.call(http, rewrite(opts), cb); };
  http.get = function (opts, cb) { return realGet.call(http, rewrite(opts), cb); };
  delete require.cache[require.resolve('../server/lib/sensor-apply')];
  const mod = require('../server/lib/sensor-apply');
  return {
    mod,
    restore: () => { http.request = realRequest; http.get = realGet; },
  };
}

// Programmable Add-on simulator. Tracks state across the remove→reboot→add
// flow so tests can assert the RPC sequence and the final peripheral table.
function makeFakeHub({ existing = {}, simulateStaleCache = false } = {}) {
  let state = Object.assign({}, existing);
  // Tracks addresses that were recently removed; until the fake reboot, an
  // Add for one of these addrs fails with the real Shelly -106 error.
  let staleAddrs = new Set();
  let rebooted = false;
  let bootingUntil = 0;   // if Date.now() < bootingUntil, SensorAddon is unavailable
  const log = [];

  const handle = (req, res, body) => {
    // Simulate the post-reboot window where SensorAddon is not yet loaded.
    if (bootingUntil && Date.now() < bootingUntil) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
      return;
    }

    let payload;
    try { payload = JSON.parse(body); } catch (_) {
      res.writeHead(400); res.end(); return;
    }
    log.push(payload);
    const { method, params = {} } = payload;

    const reply = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: payload.id, result }));
    };
    const replyErr = (code, message) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: payload.id, error: { code, message } }));
    };

    if (method === 'Shelly.GetDeviceInfo') return reply({ id: 'fake', ver: '1.7.4' });
    if (method === 'SensorAddon.GetPeripherals') return reply({ ds18b20: state });
    if (method === 'Temperature.SetConfig') {
      // Name persistence is verified via the request log, not the peripheral
      // state, so deepEqual(state, ...) in legacy assertions still holds.
      return reply({ restart_required: false });
    }
    if (method === 'SensorAddon.RemovePeripheral') {
      const comp = params.component;
      if (!state[comp]) return replyErr(-105, `Argument '${comp}' not found!`);
      if (simulateStaleCache) staleAddrs.add(state[comp].addr);
      delete state[comp];
      return reply(null);
    }
    if (method === 'SensorAddon.AddPeripheral') {
      const cid = params.attrs && params.attrs.cid;
      const addr = params.attrs && params.attrs.addr;
      const key = `temperature:${cid}`;
      if (staleAddrs.has(addr)) {
        return replyErr(-106, `Resource 'address:${addr}' already exists!`);
      }
      if (state[key]) {
        return replyErr(-114, 'Resource unavailable: cid for this type!');
      }
      state[key] = { addr };
      return reply({ [key]: {} });
    }
    if (method === 'Shelly.Reboot') {
      rebooted = true;
      // Reboot clears the stale-address cache — that's the whole point of
      // the two-reboot dance in sensor-apply.
      staleAddrs = new Set();
      bootingUntil = Date.now() + 150;  // short unavailable window for tests
      return reply(null);
    }
    replyErr(-103, `No handler for ${method}`);
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handle(req, res, body));
  });

  return {
    server,
    state: () => state,
    log: () => log,
    wasRebooted: () => rebooted,
  };
}

describe('sensor-apply (direct HTTP)', () => {
  describe('fresh hub — no existing peripherals', () => {
    let fake, loaded, port;

    before(async () => {
      fake = makeFakeHub();
      port = await listen(fake.server);
      loaded = loadWithRedirect({ '127.0.0.1': port });
    });

    after(async () => {
      loaded.restore();
      await new Promise((r) => fake.server.close(r));
    });

    it('adds all target peripherals and reboots once', async () => {
      const result = await loaded.mod.applyAll(
        [{ ip: '127.0.0.1' }],
        {
          collector: { addr: 'aa:01', hostIndex: 0, componentId: 100 },
          tank_top: { addr: 'aa:02', hostIndex: 0, componentId: 101 },
        },
        { collector: 'Collector Outlet', tank_top: 'Tank Top' }
      );
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.results[0].ok, true);
      assert.strictEqual(result.results[0].peripherals, 2);
      assert.strictEqual(result.results[0].rebooted, true);
      assert.deepEqual(fake.state(), {
        'temperature:100': { addr: 'aa:01' },
        'temperature:101': { addr: 'aa:02' },
      });

      // Each AddPeripheral is followed by a Temperature.SetConfig naming the
      // new component so the Shelly app shows "Tank Top" instead of
      // "Temperature 101".
      const tempSetConfigs = fake.log().filter((m) => m.method === 'Temperature.SetConfig');
      assert.strictEqual(tempSetConfigs.length, 2,
        'expected one Temperature.SetConfig per added peripheral');
      const byId = {};
      for (const m of tempSetConfigs) byId[m.params.id] = m.params.config.name;
      assert.strictEqual(byId[100], 'Collector Outlet');
      assert.strictEqual(byId[101], 'Tank Top');
    });

  });

  describe('naming fallback — no roleLabels provided', () => {
    let fake, loaded, port;

    before(async () => {
      fake = makeFakeHub();
      port = await listen(fake.server);
      loaded = loadWithRedirect({ '127.0.0.1': port });
    });

    after(async () => {
      loaded.restore();
      await new Promise((r) => fake.server.close(r));
    });

    it('uses the role key as the label when no roleLabels are given', async () => {
      // Simulate a caller that forgot to pass roleLabels. The peripheral
      // should still be named — using the role key as the label — so the
      // app never shows the raw "Temperature 100" default.
      const result = await loaded.mod.applyAll(
        [{ ip: '127.0.0.1' }],
        { outdoor: { addr: 'aa:03', hostIndex: 0, componentId: 102 } }
        // no roleLabels arg
      );
      assert.strictEqual(result.success, true);
      const tempSetConfigs = fake.log().filter((m) => m.method === 'Temperature.SetConfig');
      assert.strictEqual(tempSetConfigs.length, 1);
      assert.strictEqual(tempSetConfigs[0].params.config.name, 'outdoor');
    });
  });

  describe('reconfigure hub — existing peripherals need remove→reboot→add→reboot', () => {
    let fake, loaded, port;

    before(async () => {
      // Start with peripherals that DON'T match the target so we exercise the
      // full remove→reboot→add→reboot path. Enable staleAddrs so this is only
      // solvable via the reboot-clears-cache behavior.
      fake = makeFakeHub({
        existing: {
          'temperature:100': { addr: 'old:99' },
          'temperature:101': { addr: 'aa:01' },
        },
        simulateStaleCache: true,
      });
      port = await listen(fake.server);
      loaded = loadWithRedirect({ '127.0.0.1': port });
    });

    after(async () => {
      loaded.restore();
      await new Promise((r) => fake.server.close(r));
    });

    it('survives the stale-address cache by rebooting between remove and add', async () => {
      const result = await loaded.mod.applyAll(
        [{ ip: '127.0.0.1' }],
        {
          collector: { addr: 'aa:01', hostIndex: 0, componentId: 100 },
          tank_top: { addr: 'new:02', hostIndex: 0, componentId: 101 },
        }
      );
      assert.strictEqual(result.results[0].ok, true, 'result: ' + JSON.stringify(result.results[0]));
      assert.strictEqual(result.results[0].peripherals, 2);
      assert.deepEqual(fake.state(), {
        'temperature:100': { addr: 'aa:01' },
        'temperature:101': { addr: 'new:02' },
      });
      const methods = fake.log().map((m) => m.method);
      // The dance: GetPeripherals → remove → remove → reboot → (wait) →
      //           GetPeripherals(s) while booting → add → add → reboot.
      const rebootCount = methods.filter((m) => m === 'Shelly.Reboot').length;
      assert.strictEqual(rebootCount, 2, 'expected two reboots, got methods: ' + methods.join(','));
    });
  });

  describe('idempotent — current state already matches target', () => {
    let fake, loaded, port;

    before(async () => {
      fake = makeFakeHub({
        existing: {
          'temperature:100': { addr: 'aa:01' },
          'temperature:101': { addr: 'aa:02' },
        },
      });
      port = await listen(fake.server);
      loaded = loadWithRedirect({ '127.0.0.1': port });
    });

    after(async () => {
      loaded.restore();
      await new Promise((r) => fake.server.close(r));
    });

    it('no-ops when existing peripherals already match the target', async () => {
      const result = await loaded.mod.applyAll(
        [{ ip: '127.0.0.1' }],
        {
          collector: { addr: 'aa:01', hostIndex: 0, componentId: 100 },
          tank_top: { addr: 'aa:02', hostIndex: 0, componentId: 101 },
        }
      );
      assert.strictEqual(result.results[0].ok, true);
      assert.strictEqual(result.results[0].peripherals, 2);
      assert.strictEqual(fake.wasRebooted(), false, 'no reboot expected on no-op');
      assert.strictEqual(result.results[0].rebooted, undefined);
    });

    it('still syncs Temperature.SetConfig names even when peripherals match', async () => {
      // currentMatchesTarget only compares addresses. If an earlier apply
      // bound the peripherals before role labels were pushed, the label pass
      // would have been skipped. Re-running apply must fix the labels even
      // without a reboot — otherwise the Shelly app's temperature tiles stay
      // on "Temperature sensor (N)" forever.
      const before = fake.log().length;
      await loaded.mod.applyAll(
        [{ ip: '127.0.0.1' }],
        {
          collector: { addr: 'aa:01', hostIndex: 0, componentId: 100 },
          tank_top: { addr: 'aa:02', hostIndex: 0, componentId: 101 },
        },
        { collector: 'Collector Outlet', tank_top: 'Tank Top' }
      );
      const newEntries = fake.log().slice(before);
      const setConfigs = newEntries.filter((m) => m.method === 'Temperature.SetConfig');
      assert.strictEqual(setConfigs.length, 2, 'one SetConfig per target peripheral');
      const byId = Object.fromEntries(setConfigs.map((m) => [m.params.id, m.params.config.name]));
      assert.deepStrictEqual(byId, { 100: 'Collector Outlet', 101: 'Tank Top' });
      assert.strictEqual(fake.wasRebooted(), false, 'still no reboot on name-only sync');
    });
  });

  describe('error surfacing', () => {
    let server, loaded, port;

    before(async () => {
      // Hub that always rejects AddPeripheral with -106 — exercises the
      // error-capture path without depending on the full Add-on state
      // machine.
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const p = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (p.method === 'SensorAddon.GetPeripherals') {
            res.end(JSON.stringify({ id: p.id, result: { ds18b20: {} } }));
          } else if (p.method === 'SensorAddon.AddPeripheral') {
            res.end(JSON.stringify({
              id: p.id,
              error: { code: -106, message: `Resource 'address:${p.params.attrs.addr}' already exists!` },
            }));
          } else {
            res.end(JSON.stringify({ id: p.id, result: null }));
          }
        });
      });
      port = await listen(server);
      loaded = loadWithRedirect({ '127.0.0.1': port });
    });

    after(async () => {
      loaded.restore();
      await new Promise((r) => server.close(r));
    });

    it('captures per-role RPC errors with enough detail to diagnose', async () => {
      const result = await loaded.mod.applyAll(
        [{ ip: '127.0.0.1' }],
        {
          collector: { addr: 'aa:01', hostIndex: 0, componentId: 100 },
        }
      );
      assert.strictEqual(result.results[0].ok, false);
      assert.match(result.results[0].error, /add collector.*cid 100.*addr aa:01.*already exists/);
    });
  });

  describe('currentMatchesTarget helper', () => {
    it('returns true only when cid set and addrs line up', () => {
      delete require.cache[require.resolve('../server/lib/sensor-apply')];
      const mod = require('../server/lib/sensor-apply');
      const { currentMatchesTarget } = mod._internals;
      assert.equal(currentMatchesTarget({}, {}), true);
      assert.equal(
        currentMatchesTarget(
          { 'temperature:100': { addr: 'a' } },
          { '100': { addr: 'a' } }
        ),
        true
      );
      assert.equal(
        currentMatchesTarget(
          { 'temperature:100': { addr: 'a' } },
          { '100': { addr: 'b' } }
        ),
        false
      );
      assert.equal(
        currentMatchesTarget(
          { 'temperature:100': { addr: 'a' } },
          { '100': { addr: 'a' }, '101': { addr: 'b' } }
        ),
        false
      );
    });
  });
});
