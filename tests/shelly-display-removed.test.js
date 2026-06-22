/**
 * Regression guard: the on-device control script must NOT write switch
 * configuration on every control-loop tick.
 *
 * The former updateDisplay() called Switch.SetConfig on all 4 switches
 * each 30 s tick to render live telemetry on the Pro 4PM's built-in
 * display. Switch.SetConfig is a flash-persisted *configuration* write
 * (it bumps cfg_rev), so doing it per tick wore flash (cfg_rev passed
 * 158 000 on the live device) and added per-tick heap pressure to a
 * script that already runs within ~280 bytes of its memory ceiling.
 * The display was removed (barely legible in sunlight); this test keeps
 * it from creeping back.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SHELLY_DIR = path.join(__dirname, '..', 'shelly');

function createRuntime() {
  const kvs = {};
  const calls = [];
  const timers = [];
  let timerIdCounter = 0;

  function shellyCall(method, params, cb) {
    calls.push(method);
    setImmediate(function () {
      let response = null;
      if (method === 'KVS.Get') {
        const val = kvs[(params || {}).key];
        response = val !== undefined ? { value: val } : null;
      } else if (method === 'KVS.Set') {
        kvs[(params || {}).key] = (params || {}).value;
        response = {};
      } else if (method === 'HTTP.GET') {
        if (cb) cb({ code: 200, body: '{"tC":20}' }, null);
        return;
      } else {
        response = {};
      }
      if (cb) cb(response, null);
    });
  }

  function timerSet(ms, repeat, cb) {
    const id = ++timerIdCounter;
    timers.push({ id, ms, repeat, cb });
    return id;
  }
  function timerClear(id) {
    for (let i = timers.length - 1; i >= 0; i--) if (timers[i].id === id) timers.splice(i, 1);
  }

  const mqtt = {
    subscribe: function () {},
    unsubscribe: function () {},
    publish: function () {},
    isConnected: function () { return true; },
    setConnectHandler: function () {},
  };

  const Shelly = {
    call: shellyCall,
    emitEvent: function () {},
    addEventHandler: function () {},
    addStatusHandler: function () {},
    getComponentStatus: function (type) {
      if (type === 'sys') return { unixtime: Math.floor(Date.now() / 1000) };
      return {};
    },
  };

  function loadControl() {
    const files = ['control-logic.js', 'control.js'];
    const src = files.map(f => fs.readFileSync(path.join(SHELLY_DIR, f), 'utf8')).join('\n');
    const fn = new Function(
      'Shelly', 'Timer', 'MQTT', 'JSON', 'Date', 'Math', 'parseInt', 'print', '__TEST_HARNESS',
      src
    );
    fn(Shelly, { set: timerSet, clear: timerClear }, mqtt, JSON, Date, Math, parseInt, function () {}, true);
  }

  function flushTimers() {
    const oneshot = timers.filter(t => !t.repeat);
    for (const t of oneshot) {
      const idx = timers.findIndex(x => x.id === t.id);
      if (idx >= 0) timers.splice(idx, 1);
      try { t.cb(); } catch (_e) {}
    }
  }

  function settle() {
    return new Promise(resolve => {
      let rounds = 0;
      function loop() {
        flushTimers();
        if (++rounds >= 40) { resolve(); return; }
        setImmediate(loop);
      }
      setImmediate(loop);
    });
  }

  return { loadControl, settle, calls, Shelly };
}

describe('shelly/control.js — display update removed', function () {
  it('never calls Switch.SetConfig during boot or a control-loop tick', async function () {
    const rt = createRuntime();
    rt.loadControl();
    await rt.settle();

    // Drive an explicit automation tick with sensible temps so the full
    // controlLoop body runs (sensor poll → evaluate → publish).
    rt.Shelly.__test_setTemps(
      { collector: 20, tank_top: 45, tank_bottom: 40, greenhouse: 18, outdoor: 15 },
      'IDLE'
    );
    rt.Shelly.__test_controlTick();
    await rt.settle();

    const setConfigCalls = rt.calls.filter(m => m === 'Switch.SetConfig');
    assert.strictEqual(
      setConfigCalls.length, 0,
      'control.js must not issue Switch.SetConfig (per-tick flash write); got ' + setConfigCalls.length
    );
  });
});
