// 24-hour virtual-time simulation of control.js + (today) telemetry.js
// against the instrumented runtime. Enforces every platform cap from
// docs/superpowers/specs/2026-04-20-shelly-platform-limits-and-single-script-merge-design.md.
//
// This test is DELIBERATELY FAILING at introduction. Section 2 merge
// brings the peak-runtime-proxy cap into compliance; Commit 3 collapses
// valve bookkeeping to hit the 0.7× reduction; Commit 4 locks in the
// achieved number + 512 B.
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { CAPS, createInstrumentedRuntime, runtimeProxy } = require('./shelly/platform-limits.js');

const SHELLY_DIR = path.join(__dirname, '..', 'shelly');

function minify(src) {
  return src.split('\n').map(l => l.replace(/^\s+/, '')).filter(l => l && !l.startsWith('//')).join('\n') + '\n';
}

function loadShellyScripts(runtime, files) {
  const src = files.map(f => fs.readFileSync(path.join(SHELLY_DIR, f), 'utf8')).join('\n');
  const fn = new Function(
    'Shelly', 'Timer', 'MQTT', 'JSON', 'Date', 'Math', 'parseInt', 'print',
    '__TEST_HARNESS',
    src
  );
  const g = runtime.globals;
  fn(g.Shelly, g.Timer, g.MQTT, g.JSON, g.Date, g.Math, g.parseInt, g.print, true);
}

function deployedBytecodeSize(files) {
  return files
    .map(f => minify(fs.readFileSync(path.join(SHELLY_DIR, f), 'utf8')).length)
    .reduce((a, b) => a + b, 0);
}

// Files-under-test. Merge commit drops 'telemetry.js' from this list.
const FILES = fs.existsSync(path.join(SHELLY_DIR, 'telemetry.js'))
  ? ['control-logic.js', 'control.js', 'telemetry.js']
  : ['control-logic.js', 'control.js'];

describe('Shelly platform-limit 24 h simulation', () => {
  let now = 1700000000000;
  let lastStateJson = '{}';
  const runtime = createInstrumentedRuntime({
    now: () => now,
    setNow: n => { now = n; },
    mqttConnected: true,
    onPublish: (topic, payload) => {
      if (topic === 'greenhouse/state') lastStateJson = payload;
    },
    httpResponder: (url) => {
      if (url && url.indexOf('Temperature.GetStatus') >= 0) {
        return { code: 200, body: JSON.stringify({ tC: 20 + Math.random() * 5 }) };
      }
      // Valve/sensor host RPCs — return success so setValve doesn't
      // retry+fail and infinite-loop the boot chain.
      return { code: 200, body: '{}' };
    },
    kvs: {
      config: JSON.stringify({ ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1 }),
      sensor_config: JSON.stringify({
        s: { collector: { h: 0, i: 100 }, tank_top: { h: 0, i: 101 } },
        h: ['192.168.30.20'],
        v: 1,
      }),
    },
  });

  const minifiedBytes = deployedBytecodeSize(FILES);
  const proxySamples = [];
  const statePeakBytes = { v: 0 };

  // Drain setImmediate callbacks. Each Shelly.call's cb runs on
  // setImmediate and may schedule the next call in a chain — one
  // setImmediate round only processes one link. pollAllSensors →
  // updateDisplay → publish can be 10+ links. Default 30 rounds is
  // enough to fully resolve a controlLoop tick; models the real device
  // where 30 s between ticks is plenty for the previous chain to end.
  async function drainImmediates(rounds = 30) {
    for (let i = 0; i < rounds; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  async function settleBootChain() {
    // Boot flow: setActuators (4 × setImmediate Switch.Set) →
    // closeAllValves (7 × HTTP.GET via setImmediate) → Timer.set(5 s) →
    // loadPersistedState (3 × setImmediate KVS.Get) → Timer.set(POLL) +
    // controlLoop() (sensors) + bootstrapConfig + setupMqttSubscriptions.
    // Alternate drain/advance until the chain quiesces.
    for (let i = 0; i < 40; i++) {
      await drainImmediates();
      runtime.advance(1);
    }
    // Fire the two 5 s boot timers.
    runtime.advance(15000);
    for (let i = 0; i < 40; i++) {
      await drainImmediates();
      runtime.advance(1);
    }
  }

  before(async () => {
    loadShellyScripts(runtime, FILES);
    await settleBootChain();

    const TICK_MS = 30000;
    const SAMPLES = 24 * 60 * 60 * 1000 / TICK_MS; // 2880
    for (let tick = 0; tick < SAMPLES; tick++) {
      // Every ~45 min push a new device-config via MQTT (v++).
      if (tick > 0 && tick % 90 === 0) {
        try {
          const cfg = JSON.parse(runtime.kvs.config);
          cfg.v = cfg.v + 1;
          runtime.deliverMqtt('greenhouse/config', JSON.stringify(cfg));
        } catch (_e) {}
      }
      // Every ~2.5 h fire a 4-command relay storm.
      if (tick > 0 && tick % 300 === 0) {
        ['pump', 'fan', 'fan', 'pump'].forEach((relay, i) => {
          try {
            runtime.deliverMqtt('greenhouse/relay-command',
              JSON.stringify({ relay, on: i % 2 === 0 }));
          } catch (_e) {}
        });
      }
      runtime.advance(TICK_MS);
      // Drain the setImmediate callbacks scheduled by the tick's controlLoop
      // (pollAllSensors → HTTP.GET → state update → publish). Without this
      // the peak counters stay at zero because Shelly.call callbacks never
      // fire inside a synchronous for-loop.
      await drainImmediates();

      if (lastStateJson.length > statePeakBytes.v) statePeakBytes.v = lastStateJson.length;
      const s = runtime.stats();
      proxySamples.push(runtimeProxy({
        state: safeParse(lastStateJson),
        deviceConfig: safeParse(runtime.kvs.config),
        sensorConfig: safeParse(runtime.kvs.sensor_config),
        liveTimers: s.liveTimers,
        liveCalls: s.liveCalls,
        minifiedBytecodeSize: minifiedBytes,
      }));
    }
  });

  // Sanity gate: if the sim never ran the script (e.g. setImmediate
  // callbacks got stuck), every peak would be ≈0 and all caps would
  // pass vacuously. These lower-bound assertions catch that.
  it('sim actually exercised the script (peaks are non-zero)', () => {
    const s = runtime.stats();
    assert.ok(s.peakCalls >= 1,
      `expected at least one Shelly.call observed; the sim may not have run the script`);
    assert.ok(s.peakSubs >= 3,
      `expected 3 MQTT subs (config, sensor-config, relay-command), got ${s.peakSubs}`);
    assert.ok(s.peakTimers >= 1,
      `expected at least the repeating controlLoop timer live`);
    assert.ok(statePeakBytes.v > 0,
      `expected at least one greenhouse/state publish`);
  });

  it('timer handles stay within cap', () => {
    const s = runtime.stats();
    assert.ok(s.peakTimers <= CAPS.LIVE_TIMERS,
      `peakTimers=${s.peakTimers} > cap ${CAPS.LIVE_TIMERS}`);
  });

  it('in-flight Shelly.call stays within cap', () => {
    const s = runtime.stats();
    assert.ok(s.peakCalls <= CAPS.INFLIGHT_CALLS,
      `peakCalls=${s.peakCalls} > cap ${CAPS.INFLIGHT_CALLS}; in-flight methods at peak: ${JSON.stringify(s.peakCallsSnapshot)}`);
  });

  it('MQTT subscriptions stay within cap', () => {
    const s = runtime.stats();
    assert.ok(s.peakSubs <= CAPS.MQTT_SUBS,
      `peakSubs=${s.peakSubs} > cap ${CAPS.MQTT_SUBS}`);
  });

  it('no KVS value exceeded 256 B', () => {
    const s = runtime.stats();
    assert.strictEqual(s.kvsTooLarge, null,
      'KVS write rejected: ' + JSON.stringify(s.kvsTooLarge));
  });

  it('state snapshot stays under STATE_BYTES cap', () => {
    assert.ok(statePeakBytes.v <= CAPS.STATE_BYTES,
      `state snapshot peak=${statePeakBytes.v} B > cap ${CAPS.STATE_BYTES}`);
  });

  it('runtime proxy peak is under cap (BASELINE PRINT ON FAIL)', () => {
    const peak = proxySamples.length ? Math.max.apply(null, proxySamples) : 0;
    if (CAPS.RUNTIME_PROXY_PEAK === 0) {
      console.log(`[BASELINE] runtimeProxy peak over 24 h simulation: ${peak} B`);
      console.log(`[BASELINE] Set CAPS.RUNTIME_PROXY_PEAK in tests/shelly/platform-limits.js to ${Math.floor(peak * 0.7)}`);
      assert.fail('RUNTIME_PROXY_PEAK cap is unset — rerun with the baseline number above.');
    }
    assert.ok(peak <= CAPS.RUNTIME_PROXY_PEAK,
      `peak=${peak} > cap ${CAPS.RUNTIME_PROXY_PEAK}`);
  });
});

function safeParse(s) {
  try { return JSON.parse(s); } catch (_e) { return {}; }
}
