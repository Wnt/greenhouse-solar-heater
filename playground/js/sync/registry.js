// Data-source registry for the playground UI.
//
// Components that fetch their own data over HTTP/WS register a small
// spec here; the coordinator (./coordinator.js) re-runs every active
// source on app re-focus / network recovery so the whole view catches
// up in one round-trip instead of each component fetching on its own
// schedule (or never, which is what happened on Android resume before
// this module existed).
//
// A source spec is:
//   {
//     id:            string — unique. Throws on duplicate.
//     fetch(signal): Promise<data>. Must honour the AbortSignal so
//                    overlapping resyncs can cancel cleanly.
//     applyToStore(data): writes data into shared state (timeSeriesStore,
//                    component-local module state, …). Called only if
//                    the signal is still un-aborted.
//     isActive():    boolean. Sources whose `isActive()` is false are
//                    skipped on a resync (e.g. live-only sources while
//                    the user is in simulation mode).
//   }
//
// The contract is exercised in tests/frontend/sync-registry.spec.js —
// keep that suite green when changing the API.
//
// See ./README.md for the convention new full-stack features should
// follow.

const sources = new Map();

export function registerDataSource(spec) {
  if (!spec || typeof spec.id !== 'string' || !spec.id) {
    throw new Error('registerDataSource: spec.id is required');
  }
  if (typeof spec.fetch !== 'function') {
    throw new Error('registerDataSource: spec.fetch must be a function');
  }
  if (typeof spec.applyToStore !== 'function') {
    throw new Error('registerDataSource: spec.applyToStore must be a function');
  }
  if (typeof spec.isActive !== 'function') {
    throw new Error('registerDataSource: spec.isActive must be a function');
  }
  if (sources.has(spec.id)) {
    throw new Error('registerDataSource: duplicate id "' + spec.id + '"');
  }
  sources.set(spec.id, spec);
  return function unregister() { sources.delete(spec.id); };
}

// Internal accessor used by the coordinator. Returns a snapshot array
// so a source unregistering mid-iteration cannot trip the loop.
export function _registeredSources() {
  return Array.from(sources.values());
}

function _clearAllForTests() {
  sources.clear();
}

// Test bridge. The frontend Playwright suite drives the coordinator
// via window.__sync (see ./README.md and tests/frontend/sync-*.spec.js).
// Production code never reads it.
if (typeof window !== 'undefined') {
  window.__sync = window.__sync || {};
  window.__sync.registerDataSource = registerDataSource;
  window.__sync._registeredSources = _registeredSources;
  window.__sync._clearAllForTests = _clearAllForTests;
}
