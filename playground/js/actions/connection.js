/**
 * Connection actions.
 * Manages live/simulation mode switching, LiveSource lifecycle, and staleness checking.
 */

import { derived } from '../app-state.js';
import { navigateTo } from './navigation.js';

let liveSourceInstance = null;
let stalenessTimer = null;
let liveHistoryData = null;

/**
 * Switch to live mode. Starts LiveSource, updates phase, hides sim controls.
 * @param {object} store - reactive store
 * @param {Function} LiveSourceClass - LiveSource constructor
 * @param {Function} onLiveUpdate - callback for live data updates (state, result)
 * @param {Function} onFetchHistory - callback to fetch live history data
 * @param {Function} onClearDisplay - callback to clear display for live mode
 */
export function switchToLive(store, LiveSourceClass, onLiveUpdate, onFetchHistory, onClearDisplay) {
  store.set('phase', 'live');

  // Toggle UI for mode switch
  const sw = document.getElementById('mode-toggle-switch');
  const label = document.getElementById('mode-toggle-label');
  if (sw) sw.classList.add('active');
  if (label) { label.textContent = 'Live'; label.classList.add('active'); }

  // Hide FAB in live mode
  document.getElementById('fab-play').style.display = 'none';

  if (!liveSourceInstance) {
    liveSourceInstance = new LiveSourceClass();
    liveSourceInstance.onUpdate(function (state, result) {
      store.set('lastDataTime', Date.now());
      if (store.get('phase') === 'live') {
        onLiveUpdate(state, result);
      }
    });
    liveSourceInstance.onConnectionChange(function (status) {
      if (store.get('phase') === 'live') {
        store.update({
          wsStatus: status,
          mqttStatus: liveSourceInstance.mqttStatus || 'unknown',
          hasReceivedData: liveSourceInstance.hasReceivedData || false,
          wsConnectedAt: liveSourceInstance._connectedAt || 0,
        });
      }
    });
  }
  liveSourceInstance.start();

  // Pause simulation
  store.set('running', false);

  // Re-navigate to current hash now that live-only views are available
  const hashView = window.location.hash.replace('#', '');
  if (hashView) {
    navigateTo(store, hashView);
  }

  if (onFetchHistory) onFetchHistory(store.get('graphRange'));

  startStalenessCheck(store);

  // Show connecting state
  if (onClearDisplay) onClearDisplay();
  store.update({ wsStatus: 'disconnected', hasReceivedData: false, mqttStatus: 'unknown' });
}

/**
 * Switch to simulation mode. Stops LiveSource, updates phase.
 * @param {object} store - reactive store
 */
export function switchToSimulation(store) {
  store.set('phase', 'simulation');

  const sw = document.getElementById('mode-toggle-switch');
  const label = document.getElementById('mode-toggle-label');
  if (sw) sw.classList.remove('active');
  if (label) { label.textContent = 'Simulation'; label.classList.remove('active'); }

  // Show FAB
  document.getElementById('fab-play').style.display = '';

  if (liveSourceInstance) liveSourceInstance.stop();
  liveHistoryData = null;

  store.update({ wsStatus: 'disconnected', hasReceivedData: false, mqttStatus: 'unknown' });

  stopStalenessCheck();

  // Redirect if on live-only view
  const current = store.get('currentView');
  if (!derived.availableViews.includes(current)) {
    navigateTo(store, 'status');
  }
}

export function startStalenessCheck(store) {
  stopStalenessCheck();
  stalenessTimer = setInterval(() => {
    if (store.get('phase') !== 'live') return;
    // Touch lastDataTime to trigger connectionDisplay re-evaluation
    // The subscription will pick up the staleness state
    const ld = store.get('lastDataTime');
    // Force re-notify by setting a new object reference on a connection key
    // Actually, we just need to re-evaluate derived.connectionDisplay which reads Date.now()
    // Trigger subscribers by re-setting wsStatus to its current value won't work (=== check)
    // Instead, we use a subscribeAll in the overlay subscription that checks periodically
    // For now, we can emit a synthetic change to force re-evaluation
    store.set('_staleTick', Date.now());
  }, 5000);
}

export function stopStalenessCheck() {
  if (stalenessTimer) {
    clearInterval(stalenessTimer);
    stalenessTimer = null;
  }
}

export function getLiveSource() {
  return liveSourceInstance;
}

export function getLiveHistoryData() {
  return liveHistoryData;
}

export function setLiveHistoryData(data) {
  liveHistoryData = data;
}
