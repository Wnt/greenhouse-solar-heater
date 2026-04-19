// Unit tests for Shelly lint rules.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as acorn from 'acorn';
import { lintScript } from './rules/index.js';

function lintIds(source) {
  return lintScript(source, { acorn }).map(f => f.rule);
}

describe('SH-LEAK-TIMER: Timer.set inside unbounded loop', () => {
  it('flags Timer.set inside for-loop', () => {
    const src = 'for (var i = 0; i < n; i++) { Timer.set(1000, false, function() {}); }';
    assert.ok(lintIds(src).includes('SH-LEAK-TIMER'));
  });

  it('flags Timer.set inside while-loop', () => {
    const src = 'while (cond) { Timer.set(1000, false, function() {}); }';
    assert.ok(lintIds(src).includes('SH-LEAK-TIMER'));
  });

  it('does NOT flag Timer.set outside a loop', () => {
    const src = 'Timer.set(1000, false, function() {});';
    assert.ok(!lintIds(src).includes('SH-LEAK-TIMER'));
  });
});

describe('SH-LEAK-SUB: MQTT.subscribe inside unbounded loop', () => {
  it('flags MQTT.subscribe inside a loop', () => {
    const src = 'for (var i = 0; i < topics.length; i++) { MQTT.subscribe(topics[i], cb); }';
    assert.ok(lintIds(src).includes('SH-LEAK-SUB'));
  });

  it('does NOT flag MQTT.subscribe outside a loop', () => {
    const src = 'MQTT.subscribe("topic", function() {});';
    assert.ok(!lintIds(src).includes('SH-LEAK-SUB'));
  });
});

describe('SH-LEAK-RPC: Shelly.call inside unbounded loop', () => {
  it('flags Shelly.call inside a loop', () => {
    const src = 'while (cond) { Shelly.call("Switch.Set", { id: 0, on: true }); }';
    assert.ok(lintIds(src).includes('SH-LEAK-RPC'));
  });

  it('does NOT flag Shelly.call in callback-chained recursion', () => {
    // setActuators / setValves pattern: recursion via `next()` instead of
    // a loop. Must not be flagged.
    const src = `
      function next(i) {
        if (i >= arr.length) return;
        Shelly.call("Switch.Set", { id: i, on: true }, function() { next(i + 1); });
      }
      next(0);
    `;
    assert.ok(!lintIds(src).includes('SH-LEAK-RPC'));
  });
});
