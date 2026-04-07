/**
 * Reactive state store.
 * Single source of truth for application-level state.
 * Setting a value automatically notifies subscribers — no manual render calls needed.
 */

export function createStore(initial) {
  const state = { ...initial };
  const subscribers = new Map();   // key → Set<fn>
  const wildcards = new Set();     // fns called on any change
  let batch = null;                // Set<key> being batched

  function get(key) {
    return state[key];
  }

  function set(key, value) {
    if (state[key] === value) return;
    state[key] = value;
    if (batch) {
      batch.add(key);
    } else {
      notify(key);
    }
  }

  function update(partial) {
    batch = new Set();
    for (const key in partial) {
      set(key, partial[key]);
    }
    const changed = batch;
    batch = null;
    for (const key of changed) notify(key);
  }

  function notify(key) {
    const fns = subscribers.get(key);
    if (fns) fns.forEach(fn => fn(state[key], state));
    wildcards.forEach(fn => fn(key, state));
  }

  function subscribe(key, fn) {
    if (!subscribers.has(key)) subscribers.set(key, new Set());
    subscribers.get(key).add(fn);
    return () => subscribers.get(key).delete(fn);
  }

  function subscribeAll(fn) {
    wildcards.add(fn);
    return () => wildcards.delete(fn);
  }

  function snapshot() {
    return { ...state };
  }

  return { get, set, update, subscribe, subscribeAll, snapshot };
}
