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
  const calls = { history: [], push: [], ws: [], deviceConfigPut: [], publishedConfigs: [] };
  let nextId = 0;
  const storedConfig = { ce: true, ea: 0, fm: null, we: {}, wz: {}, wb: {}, v: 1 };
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
    publishConfig: (cfg) => calls.publishedConfigs.push(cfg),
  };
  const deviceConfig = {
    getConfig: () => storedConfig,
    updateConfig: (update, cb) => {
      calls.deviceConfigPut.push(update);
      // Mimic the real partial-update merge for wb/wz/we.
      if (update.wz) {
        storedConfig.wz = Object.assign({}, storedConfig.wz);
        for (const k of Object.keys(update.wz)) {
          const v = update.wz[k];
          if (v === 0 || v === null) delete storedConfig.wz[k];
          else storedConfig.wz[k] = v;
        }
      }
      if (update.wb) {
        storedConfig.wb = Object.assign({}, storedConfig.wb);
        for (const k of Object.keys(update.wb)) {
          const v = update.wb[k];
          if (v === 0 || v === null) delete storedConfig.wb[k];
          else storedConfig.wb[k] = v;
        }
      }
      if (update.we) {
        storedConfig.we = Object.assign({}, storedConfig.we, update.we);
      }
      storedConfig.v++;
      cb(null, storedConfig);
    }
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

  it('dispatches a snooze ack push when the device confirms snoozed resolution', async () => {
    const mocks = makeMocks();
    anomalyManager.init(mocks);

    // Fire → ack → resolved (snoozed) — the full happy path.
    await anomalyManager.handleDeviceEvent({
      t: 'fired', id: 'ggr', mode: 'GREENHOUSE_HEATING',
      el: 905, dT: 0.3, dC: 0, dG: 0.2, ts: 1700000000
    });

    await anomalyManager.ack('ggr', 'door open, visiting today',
                             { name: 'jonni', role: 'admin' });

    // Drain the fire-and-forget push from _handleFired
    await new Promise(r => setTimeout(r, 10));
    const firePushes = mocks.calls.push.filter(p => p.payload.data.kind === 'watchdog_fired');
    assert.strictEqual(firePushes.length, 1, 'expected one fire push');

    // Now the device acknowledges the snooze
    await anomalyManager.handleDeviceEvent({
      t: 'resolved', id: 'ggr', how: 'snoozed', ts: 1700000060
    });
    await new Promise(r => setTimeout(r, 10));

    const ackPushes = mocks.calls.push.filter(p => p.payload.data.kind === 'watchdog_ack');
    assert.strictEqual(ackPushes.length, 1, 'expected one ack push');
    const ack = ackPushes[0].payload;
    assert.strictEqual(ackPushes[0].category, 'watchdog_fired');
    assert.match(ack.title, /Snooze applied/);
    assert.match(ack.title, /Greenhouse not warming/);
    assert.match(ack.body, /door open, visiting today/);
    assert.match(ack.body, /running until \d{2}:\d{2}/);
    // Same tag as the original fire so this REPLACES the fire
    // notification on the device rather than stacking.
    assert.strictEqual(ack.tag, 'watchdog-ggr');
    assert.strictEqual(ack.data.watchdogId, 'ggr');
  });

  it('does not dispatch an ack push when the device auto-shuts-down (no snooze metadata)', async () => {
    const mocks = makeMocks();
    anomalyManager.init(mocks);

    await anomalyManager.handleDeviceEvent({
      t: 'fired', id: 'ggr', mode: 'GREENHOUSE_HEATING',
      el: 905, dT: 0.3, dC: 0, dG: 0.2, ts: 1700000000
    });

    // Auto-shutdown path: no ack() was called, so _pending has no
    // snooze metadata. The resolved event should NOT dispatch an
    // ack push (only DB update + WS broadcast).
    await anomalyManager.handleDeviceEvent({
      t: 'resolved', id: 'ggr', how: 'shutdown_auto', ts: 1700000300
    });
    await new Promise(r => setTimeout(r, 10));

    const ackPushes = mocks.calls.push.filter(p => p.payload.data.kind === 'watchdog_ack');
    assert.strictEqual(ackPushes.length, 0);
  });
});

describe('anomaly-manager ack', () => {
  it('computes snoozeUntil and pushes wz update via device-config', async () => {
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

    // Server should NOT publish to a watchdog/cmd topic — that
    // subscription was deliberately removed from the device. Instead,
    // it issues a partial wz update and republishes the full config
    // via the existing greenhouse/config subscription.
    const wzUpdate = mocks.calls.deviceConfigPut.find(u => u.wz);
    assert.ok(wzUpdate, 'expected a wz partial update');
    assert.strictEqual(wzUpdate.wz.ggr, result.snoozeUntil);

    // The merged config should be published via greenhouse/config
    assert.strictEqual(mocks.calls.publishedConfigs.length, 1);
    assert.strictEqual(mocks.calls.publishedConfigs[0].wz.ggr, result.snoozeUntil);

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
  it('pushes wb cool-off ban via device-config update', async () => {
    const mocks = makeMocks();
    anomalyManager.init(mocks);

    await anomalyManager.handleDeviceEvent({
      t: 'fired', id: 'scs', mode: 'SOLAR_CHARGING',
      el: 305, dT: 0, dC: 1.0, dG: 0, ts: 1700000000
    });

    await anomalyManager.shutdownNow('scs', { name: 'jonni', role: 'admin' });

    // The shutdown command is encoded as a wb[modeCode] cool-off ban
    // pushed via greenhouse/config — no separate watchdog/cmd topic.
    // scs maps to mode SOLAR_CHARGING → modeCode "SC".
    const wbUpdate = mocks.calls.deviceConfigPut.find(u => u.wb);
    assert.ok(wbUpdate, 'expected a wb partial update');
    const nowSec = Math.floor(Date.now() / 1000);
    assert.ok(wbUpdate.wb.SC > nowSec);
    assert.ok(wbUpdate.wb.SC < nowSec + 14401, 'ban TTL <= 4h');
    assert.ok(wbUpdate.wb.SC > nowSec + 14000, 'ban TTL ~4h');

    assert.strictEqual(mocks.calls.publishedConfigs.length, 1);
    assert.strictEqual(mocks.calls.publishedConfigs[0].wb.SC, wbUpdate.wb.SC);

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

  it('updateSnapshot mirrors the full deviceConfig (ce, ea, mo, v) so log export can render it', async () => {
    const mocks = makeMocks();
    mocks.history.list = () => Promise.resolve([]);
    anomalyManager.init(mocks);
    anomalyManager.updateSnapshot({
      ce: true,
      ea: 31,
      mo: { a: true, ex: 1840000000, fm: 'I' },
      we: { ggr: 1, sng: 1, scs: 1 },
      wz: { ggr: 1840003600 },
      wb: { GH: 1840014400 },
      v: 42,
    });

    const state = await anomalyManager.getState();
    assert.strictEqual(state.snapshot.ce, true);
    assert.strictEqual(state.snapshot.ea, 31);
    assert.deepStrictEqual(state.snapshot.mo, { a: true, ex: 1840000000, fm: 'I' });
    assert.strictEqual(state.snapshot.v, 42);
    assert.deepStrictEqual(state.snapshot.we, { ggr: 1, sng: 1, scs: 1 });
    assert.deepStrictEqual(state.snapshot.wz, { ggr: 1840003600 });
    assert.deepStrictEqual(state.snapshot.wb, { GH: 1840014400 });
  });
});
