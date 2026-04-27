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

  // Auth
  userRole: 'admin',         // 'admin' | 'readonly'

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

  // Shelly control-script health. Populated by ws 'script-status'
  // messages. `null` = not yet known (default). `running: false` shows
  // the crash banner.
  scriptStatus: null,

  // Internal: staleness tick for periodic re-evaluation
  _staleTick: 0,

  // Sync coordinator (./sync/coordinator.js). `syncing` is true from
  // the moment a resync is triggered (visibility/pageshow/online) until
  // every active data source has settled. `syncReason` is the trigger
  // tag — UI components that distinguish between e.g. user-initiated
  // refresh and Android background-resume can read it.
  syncing: false,
  syncReason: null,
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
    const role = store.get('userRole');
    // 'components' is the merged System view (schematic + sensors/valves/actuators).
    // 'device' is the merged Device view (sensor assignment + controller runtime config).
    // 'crashes' is the script-crash log, only meaningful against a real server.
    // Settings (PWA install, notifications, account) only makes sense when the
    // app is backed by a real server — on GH Pages (isLiveCapable=false) it
    // has nothing to configure, so we hide it.
    const hasSettings = store.get('isLiveCapable');
    const views = ['status', 'components'];
    if (phase === 'live' || phase === 'init') views.push('device');
    if (phase === 'simulation') views.push('controls');
    if (hasSettings) views.push('crashes');
    if (hasSettings) views.push('settings');
    // Read-only users cannot see Controls or Device — they would be useless
    // (server enforces admin-only on every mutating endpoint).
    if (role === 'readonly') {
      return views.filter(v => v !== 'controls' && v !== 'device');
    }
    return views;
  },

  get connectionDisplay() {
    if (store.get('phase') !== 'live') return 'active';

    // A resync is in flight (Android resume / network recovery / user
    // returned focus). Surface as a single 'syncing' state so the
    // overlay + banner unify into one transition instead of the old
    // "blur clears, then banner clears" two-step.
    if (store.get('syncing')) return 'syncing';

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
