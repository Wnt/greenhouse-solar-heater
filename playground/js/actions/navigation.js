/**
 * Navigation actions.
 * Binds URL hash to store.currentView with validation against derived.availableViews.
 */

import { derived } from '../app-state.js';

// Legacy hash aliases — the Schematic and Sensors views were merged into
// Components and Device respectively. Existing bookmarks and tests that use
// the old hashes still route to the right place.
const HASH_ALIASES = {
  schematic: 'components',
  sensors: 'device',
};

function resolveHash(raw) {
  const key = raw.replace('#', '') || 'status';
  return HASH_ALIASES[key] || key;
}

/**
 * Initialize hash-based navigation. Binds hashchange listener and sets initial view.
 */
export function initNavigation(store) {
  // Click handler: update hash (triggers hashchange → store update)
  document.querySelectorAll('[data-view]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.hash = HASH_ALIASES[link.dataset.view] || link.dataset.view;
    });
  });

  // Hash change handler
  window.addEventListener('hashchange', () => {
    const viewId = resolveHash(window.location.hash);
    navigateTo(store, viewId);
  });

  // Initial view from hash (or default to status)
  const initialView = resolveHash(window.location.hash);
  if (window.location.hash === '') window.location.hash = 'status';
  // Force initial navigation even if value matches default (=== check would skip notification)
  const available = derived.availableViews;
  const resolved = available.includes(initialView) ? initialView : 'status';
  // Temporarily set a different value to ensure the subscription fires
  store.set('currentView', '');
  store.set('currentView', resolved);
}

/**
 * Navigate to a view. Validates against currently available views.
 */
export function navigateTo(store, viewId) {
  const available = derived.availableViews;
  const resolved = available.includes(viewId) ? viewId : 'status';
  store.set('currentView', resolved);
}
