const { describe, it } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('fs');
const { join } = require('path');

// Load store.js
const storeSource = readFileSync(join(__dirname, '..', 'playground', 'js', 'store.js'), 'utf-8');
const storeModule = { exports: {} };
const storeWrapped = storeSource
  .replace(/^export function createStore/m, 'module.exports.createStore = function createStore');
new Function('module', 'exports', storeWrapped)(storeModule, storeModule.exports);
const { createStore } = storeModule.exports;

// Load app-state.js — we can't use the module directly since it imports store.js.
// Instead, test the derived logic by creating a store with the same shape and
// replicating the derived getters.
function makeDerived(store) {
  const REQUIRED_ROLES = ['collector', 'tank_top', 'tank_bottom', 'greenhouse', 'outdoor'];
  return {
    get scanning() {
      if (store.get('sensorScanPending')) return true;
      const cfg = store.get('sensorConfig');
      const det = store.get('detectedSensors');
      if (!cfg || !cfg.hosts) return false;
      return cfg.hosts.some(function(h) { return det[h.id] === null; });
    },
    get availableViews() {
      const phase = store.get('phase');
      if (phase === 'live') return ['status', 'components', 'schematic', 'sensors', 'device'];
      if (phase === 'simulation') return ['status', 'components', 'schematic', 'controls'];
      return ['status', 'components', 'schematic'];
    },
    get connectionDisplay() {
      const ws = store.get('wsStatus');
      const mqtt = store.get('mqttStatus');
      const hasData = store.get('hasReceivedData');
      const connAt = store.get('wsConnectedAt');
      const lastData = store.get('lastDataTime');
      if (ws === 'reconnecting') return 'reconnecting';
      if (ws !== 'connected') return 'disconnected';
      if (!hasData && mqtt === 'disconnected') return 'device_offline';
      if (!hasData && (Date.now() - connAt) < 2000) return 'connecting';
      if (!hasData) return 'never_connected';
      if (lastData > 0 && (Date.now() - lastData) > 60000) return 'stale';
      return 'active';
    },
    get missingRoles() {
      const cfg = store.get('sensorConfig');
      if (!cfg || !cfg.assignments) return REQUIRED_ROLES.slice();
      return REQUIRED_ROLES.filter(function(r) { return !cfg.assignments[r] || !cfg.assignments[r].addr; });
    },
    get updateAvailable() {
      const base = store.get('baselineHash');
      const server = store.get('serverHash');
      return base !== null && server !== null && base !== server && !store.get('versionDismissed');
    },
  };
}

describe('derived state', () => {
  describe('scanning', () => {
    it('returns false when no sensor config', () => {
      const store = createStore({ sensorScanPending: false, sensorConfig: null, detectedSensors: {} });
      const d = makeDerived(store);
      assert.strictEqual(d.scanning, false);
    });

    it('returns true when sensorScanPending is true', () => {
      const store = createStore({ sensorScanPending: true, sensorConfig: null, detectedSensors: {} });
      const d = makeDerived(store);
      assert.strictEqual(d.scanning, true);
    });

    it('returns true when any host has null result', () => {
      const store = createStore({
        sensorScanPending: false,
        sensorConfig: { hosts: [{ id: 'h1' }, { id: 'h2' }] },
        detectedSensors: { h1: { sensors: [], error: null }, h2: null },
      });
      const d = makeDerived(store);
      assert.strictEqual(d.scanning, true);
    });

    it('returns false when all hosts have results', () => {
      const store = createStore({
        sensorScanPending: false,
        sensorConfig: { hosts: [{ id: 'h1' }] },
        detectedSensors: { h1: { sensors: [], error: null } },
      });
      const d = makeDerived(store);
      assert.strictEqual(d.scanning, false);
    });
  });

  describe('availableViews', () => {
    it('returns base views for init phase', () => {
      const store = createStore({ phase: 'init' });
      const d = makeDerived(store);
      assert.deepStrictEqual(d.availableViews, ['status', 'components', 'schematic']);
    });

    it('includes controls for simulation phase', () => {
      const store = createStore({ phase: 'simulation' });
      const d = makeDerived(store);
      assert.ok(d.availableViews.includes('controls'));
      assert.ok(!d.availableViews.includes('sensors'));
    });

    it('includes sensors and device for live phase', () => {
      const store = createStore({ phase: 'live' });
      const d = makeDerived(store);
      assert.ok(d.availableViews.includes('sensors'));
      assert.ok(d.availableViews.includes('device'));
      assert.ok(!d.availableViews.includes('controls'));
    });
  });

  describe('connectionDisplay', () => {
    it('returns disconnected when ws not connected', () => {
      const store = createStore({ wsStatus: 'disconnected', mqttStatus: 'unknown', hasReceivedData: false, wsConnectedAt: 0, lastDataTime: 0 });
      assert.strictEqual(makeDerived(store).connectionDisplay, 'disconnected');
    });

    it('returns reconnecting when ws reconnecting', () => {
      const store = createStore({ wsStatus: 'reconnecting', mqttStatus: 'unknown', hasReceivedData: false, wsConnectedAt: 0, lastDataTime: 0 });
      assert.strictEqual(makeDerived(store).connectionDisplay, 'reconnecting');
    });

    it('returns device_offline when connected but mqtt disconnected and no data', () => {
      const store = createStore({ wsStatus: 'connected', mqttStatus: 'disconnected', hasReceivedData: false, wsConnectedAt: Date.now() - 5000, lastDataTime: 0 });
      assert.strictEqual(makeDerived(store).connectionDisplay, 'device_offline');
    });

    it('returns connecting within grace period', () => {
      const store = createStore({ wsStatus: 'connected', mqttStatus: 'unknown', hasReceivedData: false, wsConnectedAt: Date.now(), lastDataTime: 0 });
      assert.strictEqual(makeDerived(store).connectionDisplay, 'connecting');
    });

    it('returns active when data flowing', () => {
      const store = createStore({ wsStatus: 'connected', mqttStatus: 'connected', hasReceivedData: true, wsConnectedAt: Date.now() - 10000, lastDataTime: Date.now() });
      assert.strictEqual(makeDerived(store).connectionDisplay, 'active');
    });

    it('returns stale when data older than 60s', () => {
      const store = createStore({ wsStatus: 'connected', mqttStatus: 'connected', hasReceivedData: true, wsConnectedAt: Date.now() - 120000, lastDataTime: Date.now() - 61000 });
      assert.strictEqual(makeDerived(store).connectionDisplay, 'stale');
    });
  });

  describe('missingRoles', () => {
    it('returns all required roles when no config', () => {
      const store = createStore({ sensorConfig: null });
      const d = makeDerived(store);
      assert.deepStrictEqual(d.missingRoles, ['collector', 'tank_top', 'tank_bottom', 'greenhouse', 'outdoor']);
    });

    it('returns empty when all required roles assigned', () => {
      const store = createStore({
        sensorConfig: {
          assignments: {
            collector: { addr: 'a1' },
            tank_top: { addr: 'a2' },
            tank_bottom: { addr: 'a3' },
            greenhouse: { addr: 'a4' },
            outdoor: { addr: 'a5' },
          },
        },
      });
      const d = makeDerived(store);
      assert.deepStrictEqual(d.missingRoles, []);
    });

    it('returns only unassigned required roles', () => {
      const store = createStore({
        sensorConfig: {
          assignments: {
            collector: { addr: 'a1' },
            tank_top: { addr: 'a2' },
          },
        },
      });
      const d = makeDerived(store);
      assert.deepStrictEqual(d.missingRoles, ['tank_bottom', 'greenhouse', 'outdoor']);
    });
  });

  describe('updateAvailable', () => {
    it('returns false when no hashes', () => {
      const store = createStore({ baselineHash: null, serverHash: null, versionDismissed: false });
      assert.strictEqual(makeDerived(store).updateAvailable, false);
    });

    it('returns false when hashes match', () => {
      const store = createStore({ baselineHash: 'abc', serverHash: 'abc', versionDismissed: false });
      assert.strictEqual(makeDerived(store).updateAvailable, false);
    });

    it('returns true when hashes differ', () => {
      const store = createStore({ baselineHash: 'abc', serverHash: 'def', versionDismissed: false });
      assert.strictEqual(makeDerived(store).updateAvailable, true);
    });

    it('returns false when dismissed', () => {
      const store = createStore({ baselineHash: 'abc', serverHash: 'def', versionDismissed: true });
      assert.strictEqual(makeDerived(store).updateAvailable, false);
    });
  });
});
