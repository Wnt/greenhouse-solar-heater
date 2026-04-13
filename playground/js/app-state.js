/**
 * Application state store instance and derived getters.
 * Single source of truth for all application-level state.
 */

import { createStore } from './store.js';

const REQUIRED_ROLES = ['collector', 'tank_top', 'tank_bottom', 'greenhouse', 'outdoor'];

export const store = createStore({
  // App lifecycle
  phase: 'init',             // 'init' | 'simulation' | 'live'
  isLiveCapable: false,

  // Navigation
  currentView: 'status',

  // Connection (live mode)
  wsStatus: 'disconnected',
  mqttStatus: 'unknown',
  lastDataTime: 0,
  hasReceivedData: false,
  wsConnectedAt: 0,

  // Simulation
  running: false,
  graphRange: 86400,

  // Sensors
  sensorConfig: null,
  detectedSensors: {},
  sensorScanPending: false,

  // Device config
  deviceConfig: null,

  // Version check
  baselineHash: null,
  serverHash: null,
  versionDismissed: false,

  // Internal: staleness tick for periodic re-evaluation
  _staleTick: 0,
});

/**
 * Derived state — computed on every access, never stored.
 */
export const derived = {
  get scanning() {
    if (store.get('sensorScanPending')) return true;
    const cfg = store.get('sensorConfig');
    const det = store.get('detectedSensors');
    if (!cfg || !cfg.hosts) return false;
    return cfg.hosts.some(h => det[h.id] === null);
  },

  get availableViews() {
    const phase = store.get('phase');
    // Settings (PWA install, notifications, account) only makes sense when the
    // app is backed by a real server. On GH Pages (isLiveCapable=false) there
    // is nothing to configure, so we hide it.
    const hasSettings = store.get('isLiveCapable');
    const views = ['status', 'components', 'schematic'];
    if (phase === 'live' || phase === 'init') views.push('sensors', 'device');
    if (phase === 'simulation') views.push('controls');
    if (hasSettings) views.push('settings');
    return views;
  },

  get connectionDisplay() {
    if (store.get('phase') !== 'live') return 'active';

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
    return REQUIRED_ROLES.filter(r => !cfg.assignments[r] || !cfg.assignments[r].addr);
  },

  get updateAvailable() {
    const base = store.get('baselineHash');
    const server = store.get('serverHash');
    return base !== null && server !== null && base !== server && !store.get('versionDismissed');
  },
};
