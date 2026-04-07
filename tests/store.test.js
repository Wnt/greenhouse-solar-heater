const { describe, it } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('fs');
const { join } = require('path');

// Load the ES module as text and evaluate it (same pattern as control-logic tests)
const storeSource = readFileSync(join(__dirname, '..', 'playground', 'js', 'store.js'), 'utf-8');
const moduleShim = { exports: {} };
const wrapped = storeSource
  .replace(/^export function createStore/m, 'module.exports.createStore = function createStore');
const fn = new Function('module', 'exports', wrapped);
fn(moduleShim, moduleShim.exports);
const { createStore } = moduleShim.exports;

describe('reactive store', () => {
  describe('get/set', () => {
    it('returns initial value', () => {
      const store = createStore({ count: 0 });
      assert.strictEqual(store.get('count'), 0);
    });

    it('returns updated value after set', () => {
      const store = createStore({ count: 0 });
      store.set('count', 5);
      assert.strictEqual(store.get('count'), 5);
    });
  });

  describe('synchronous notification', () => {
    it('calls subscriber synchronously on set', () => {
      const store = createStore({ x: 1 });
      const calls = [];
      store.subscribe('x', (val) => calls.push(val));
      store.set('x', 2);
      assert.deepStrictEqual(calls, [2]);
    });

    it('calls subscriber with full state', () => {
      const store = createStore({ x: 1, y: 2 });
      let captured = null;
      store.subscribe('x', (_val, state) => { captured = state; });
      store.set('x', 10);
      assert.strictEqual(captured.x, 10);
      assert.strictEqual(captured.y, 2);
    });
  });

  describe('no spurious notifications', () => {
    it('does not notify when value unchanged (===)', () => {
      const store = createStore({ x: 1 });
      let callCount = 0;
      store.subscribe('x', () => callCount++);
      store.set('x', 1);
      assert.strictEqual(callCount, 0);
    });

    it('does notify for object reference change even with same shape', () => {
      const obj1 = { a: 1 };
      const obj2 = { a: 1 };
      const store = createStore({ data: obj1 });
      let callCount = 0;
      store.subscribe('data', () => callCount++);
      store.set('data', obj2);
      assert.strictEqual(callCount, 1);
    });
  });

  describe('atomic batch update', () => {
    it('notifies each changed key once after all mutations', () => {
      const store = createStore({ a: 1, b: 2, c: 3 });
      const aCalls = [];
      const bCalls = [];
      store.subscribe('a', (val) => aCalls.push(val));
      store.subscribe('b', (val) => bCalls.push(val));
      store.update({ a: 10, b: 20 });
      assert.deepStrictEqual(aCalls, [10]);
      assert.deepStrictEqual(bCalls, [20]);
    });

    it('does not notify unchanged keys in batch', () => {
      const store = createStore({ a: 1, b: 2 });
      let bCallCount = 0;
      store.subscribe('b', () => bCallCount++);
      store.update({ a: 10, b: 2 });
      assert.strictEqual(bCallCount, 0);
    });

    it('subscriber sees all batch values applied during notification', () => {
      const store = createStore({ a: 1, b: 2 });
      let seenB = null;
      store.subscribe('a', (_val, state) => { seenB = state.b; });
      store.update({ a: 10, b: 20 });
      assert.strictEqual(seenB, 20);
    });
  });

  describe('subscription cleanup', () => {
    it('unsubscribe removes the callback', () => {
      const store = createStore({ x: 0 });
      let callCount = 0;
      const unsub = store.subscribe('x', () => callCount++);
      store.set('x', 1);
      assert.strictEqual(callCount, 1);
      unsub();
      store.set('x', 2);
      assert.strictEqual(callCount, 1);
    });

    it('unsubscribe does not affect other subscribers', () => {
      const store = createStore({ x: 0 });
      let countA = 0;
      let countB = 0;
      const unsubA = store.subscribe('x', () => countA++);
      store.subscribe('x', () => countB++);
      unsubA();
      store.set('x', 1);
      assert.strictEqual(countA, 0);
      assert.strictEqual(countB, 1);
    });
  });

  describe('re-entrant set', () => {
    it('allows set() inside a subscriber', () => {
      const store = createStore({ x: 0, y: 0 });
      store.subscribe('x', (val) => {
        if (val === 1) store.set('y', 100);
      });
      let yVal = null;
      store.subscribe('y', (val) => { yVal = val; });
      store.set('x', 1);
      assert.strictEqual(store.get('y'), 100);
      assert.strictEqual(yVal, 100);
    });
  });

  describe('subscribeAll', () => {
    it('fires on any key change', () => {
      const store = createStore({ a: 1, b: 2 });
      const changes = [];
      store.subscribeAll((key) => changes.push(key));
      store.set('a', 10);
      store.set('b', 20);
      assert.deepStrictEqual(changes, ['a', 'b']);
    });

    it('unsubscribeAll removes wildcard', () => {
      const store = createStore({ a: 1 });
      let count = 0;
      const unsub = store.subscribeAll(() => count++);
      store.set('a', 2);
      assert.strictEqual(count, 1);
      unsub();
      store.set('a', 3);
      assert.strictEqual(count, 1);
    });
  });

  describe('snapshot', () => {
    it('returns shallow copy of state', () => {
      const store = createStore({ x: 1, y: 2 });
      const snap = store.snapshot();
      assert.deepStrictEqual(snap, { x: 1, y: 2 });
      snap.x = 999;
      assert.strictEqual(store.get('x'), 1);
    });
  });
});
