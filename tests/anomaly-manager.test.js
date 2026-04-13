const { describe, it } = require('node:test');
const assert = require('node:assert');
const anomalyManager = require('../server/lib/anomaly-manager.js');

describe('anomaly-manager formatReason', () => {
  it('formats scs reason', () => {
    const text = anomalyManager.formatReason({
      id: 'scs', el: 305, dC: 1.2
    });
    assert.match(text, /Collector only -1\.2\u00B0C after 5:05/);
  });

  it('formats sng reason', () => {
    const text = anomalyManager.formatReason({
      id: 'sng', el: 612, dT: 0.3
    });
    assert.match(text, /Tank only \+0\.3\u00B0C after 10:12/);
  });

  it('formats ggr reason', () => {
    const text = anomalyManager.formatReason({
      id: 'ggr', el: 932, dG: 0.2
    });
    assert.match(text, /Greenhouse only \+0\.2\u00B0C after 15:32/);
  });

  it('pads seconds with leading zero', () => {
    const text = anomalyManager.formatReason({
      id: 'ggr', el: 905, dG: 0.1
    });
    assert.match(text, /15:05/);
  });
});

function makeMocks() {
  const calls = { history: [], push: [], ws: [], mqtt: [] };
  let nextId = 0;
  const history = {
    insert: (row) => {
      nextId++;
      calls.history.push(Object.assign({ _insert: true, id: nextId }, row));
      return Promise.resolve({ id: nextId });
    },
    update: (id, patch) => {
      calls.history.push(Object.assign({ _update: id }, patch));
      return Promise.resolve();
    },
    list: (limit) => Promise.resolve([])
  };
  const push = {
    sendByCategory: (category, payload) => {
      calls.push.push({ category, payload });
      return Promise.resolve();
    }
  };
  const wsBroadcast = (msg) => calls.ws.push(msg);
  const mqttBridge = {
    publishWatchdogCmd: (msg) => calls.mqtt.push(msg),
    publishConfig: () => {},
  };
  const deviceConfig = {
    getConfig: () => ({ we: {}, wz: {}, wb: {} }),
    updateConfig: (update, cb) => cb(null, Object.assign({ we: {}, wz: {}, wb: {} }, update))
  };
  return {
    history, push, wsBroadcast, mqttBridge, deviceConfig, calls,
    log: { info: () => {}, error: () => {}, warn: () => {} }
  };
}

describe('anomaly-manager handleDeviceEvent fired', () => {
  it('sets _pending and dispatches push + ws on fired event', async () => {
    const mocks = makeMocks();
    anomalyManager.init(mocks);

    await anomalyManager.handleDeviceEvent({
      t: 'fired', id: 'ggr', mode: 'GREENHOUSE_HEATING',
      el: 905, dT: 0.3, dC: 0, dG: 0.2, ts: 1700000000
    });

    const inserts = mocks.calls.history.filter(h => h._insert);
    assert.strictEqual(inserts.length, 1);
    assert.strictEqual(inserts[0].watchdog_id, 'ggr');
    assert.match(inserts[0].trigger_reason, /Greenhouse only \+0\.2/);

    // Push is fire-and-forget — give it a tick to fire
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(mocks.calls.push.length, 1);
    assert.strictEqual(mocks.calls.push[0].category, 'watchdog_fired');

    assert.strictEqual(mocks.calls.ws.length, 1);
    assert.strictEqual(mocks.calls.ws[0].type, 'watchdog-state');
    assert.ok(mocks.calls.ws[0].pending);
    assert.strictEqual(mocks.calls.ws[0].pending.id, 'ggr');

    const pending = anomalyManager.getPending();
    assert.strictEqual(pending.id, 'ggr');
    assert.strictEqual(pending.dbEventId, 1);
  });

  it('clears pending on resolved event and updates row', async () => {
    const mocks = makeMocks();
    anomalyManager.init(mocks);
    await anomalyManager.handleDeviceEvent({
      t: 'fired', id: 'ggr', mode: 'GREENHOUSE_HEATING',
      el: 905, dT: 0.3, dC: 0, dG: 0.2, ts: 1700000000
    });
    await anomalyManager.handleDeviceEvent({
      t: 'resolved', id: 'ggr', how: 'snoozed', ts: 1700000060
    });
    assert.strictEqual(anomalyManager.getPending(), null);
    const updates = mocks.calls.history.filter(h => h._update);
    assert.ok(updates.length >= 1);
    assert.strictEqual(updates[0].resolution, 'snoozed');
  });
});

describe('anomaly-manager ack', () => {
  it('computes snoozeUntil and publishes MQTT ack', async () => {
    const mocks = makeMocks();
    anomalyManager.init(mocks);

    await anomalyManager.handleDeviceEvent({
      t: 'fired', id: 'ggr', mode: 'GREENHOUSE_HEATING',
      el: 905, dT: 0.3, dC: 0, dG: 0.2, ts: 1700000000
    });

    const result = await anomalyManager.ack('ggr', 'door open, visiting today',
                                            { name: 'jonni', role: 'admin' });

    // ggr snooze TTL is 43200s (12h)
    const nowSec = Math.floor(Date.now() / 1000);
    assert.ok(result.snoozeUntil > nowSec);
    assert.ok(result.snoozeUntil - nowSec > 43000);

    assert.strictEqual(mocks.calls.mqtt.length, 1);
    assert.strictEqual(mocks.calls.mqtt[0].t, 'ack');
    assert.strictEqual(mocks.calls.mqtt[0].id, 'ggr');
    assert.strictEqual(mocks.calls.mqtt[0].u, result.snoozeUntil);

    const update = mocks.calls.history.find(h => h.snooze_reason);
    assert.ok(update);
    assert.strictEqual(update.snooze_reason, 'door open, visiting today');
    assert.strictEqual(update.resolved_by, 'jonni');
  });

  it('rejects ack with no matching pending', async () => {
    const mocks = makeMocks();
    anomalyManager.init(mocks);

    await assert.rejects(
      () => anomalyManager.ack('ggr', 'test', { name: 'x', role: 'admin' }),
      /no matching pending/
    );
  });
});

describe('anomaly-manager shutdownNow', () => {
  it('publishes MQTT shutdownnow command', async () => {
    const mocks = makeMocks();
    anomalyManager.init(mocks);

    await anomalyManager.handleDeviceEvent({
      t: 'fired', id: 'scs', mode: 'SOLAR_CHARGING',
      el: 305, dT: 0, dC: 1.0, dG: 0, ts: 1700000000
    });

    await anomalyManager.shutdownNow('scs', { name: 'jonni', role: 'admin' });

    assert.strictEqual(mocks.calls.mqtt.length, 1);
    assert.strictEqual(mocks.calls.mqtt[0].t, 'shutdownnow');
    assert.strictEqual(mocks.calls.mqtt[0].id, 'scs');

    const update = mocks.calls.history.find(h => h.resolved_by);
    assert.ok(update);
    assert.strictEqual(update.resolved_by, 'jonni');
  });
});

describe('anomaly-manager setEnabled / getState / getHistory', () => {
  it('setEnabled calls deviceConfig.updateConfig with correct we field', async () => {
    const mocks = makeMocks();
    let capturedUpdate = null;
    mocks.deviceConfig.updateConfig = (update, cb) => {
      capturedUpdate = update;
      cb(null, { we: update.we });
    };
    anomalyManager.init(mocks);

    await anomalyManager.setEnabled('ggr', true, { name: 'jonni', role: 'admin' });
    assert.deepStrictEqual(capturedUpdate.we, { ggr: 1 });
  });

  it('setEnabled rejects unknown watchdog ids', async () => {
    const mocks = makeMocks();
    anomalyManager.init(mocks);
    await assert.rejects(
      () => anomalyManager.setEnabled('bogus', true, { name: 'x', role: 'admin' }),
      /unknown watchdog id/
    );
  });

  it('getState returns pending + snapshot + recent', async () => {
    const mocks = makeMocks();
    mocks.history.list = (limit) => Promise.resolve([
      { id: 1, watchdog_id: 'ggr', trigger_reason: 'test', fired_at: new Date() }
    ]);
    anomalyManager.init(mocks);
    anomalyManager.updateSnapshot({ we: { ggr: 1 }, wz: {}, wb: {} });

    const state = await anomalyManager.getState();
    assert.strictEqual(state.pending, null);
    assert.deepStrictEqual(state.snapshot.we, { ggr: 1 });
    assert.strictEqual(state.recent.length, 1);
    assert.ok(Array.isArray(state.watchdogs));
  });
});
