/**
 * Unit tests for poc/lib/valve-poller.js
 * Tests pure functions (extractValveState, detectChanges) and
 * poller behavior with mocked HTTP calls.
 */

var test = require('node:test');
var assert = require('node:assert/strict');
var valvePoller = require('../poc/lib/valve-poller');

test.afterEach(function () {
  valvePoller._reset();
});

// ── Pure function tests ──

test('extractValveState extracts v1, v2, mode from status', function () {
  var status = {
    valves: { v1: { output: true }, v2: { output: false } },
    override: { active: false },
  };
  var state = valvePoller.extractValveState(status);
  assert.deepEqual(state, { v1: true, v2: false, mode: 'auto' });
});

test('extractValveState returns override mode when active', function () {
  var status = {
    valves: { v1: { output: false }, v2: { output: true } },
    override: { active: true },
  };
  var state = valvePoller.extractValveState(status);
  assert.equal(state.mode, 'override');
});

test('extractValveState handles missing valves gracefully', function () {
  var status = { override: { active: false } };
  var state = valvePoller.extractValveState(status);
  assert.deepEqual(state, { v1: false, v2: false, mode: 'auto' });
});

test('detectChanges returns empty array when no changes', function () {
  var prev = { v1: true, v2: false, mode: 'auto' };
  var curr = { v1: true, v2: false, mode: 'auto' };
  var changes = valvePoller.detectChanges(prev, curr);
  assert.equal(changes.length, 0);
});

test('detectChanges detects v1 change', function () {
  var prev = { v1: false, v2: false, mode: 'auto' };
  var curr = { v1: true, v2: false, mode: 'auto' };
  var changes = valvePoller.detectChanges(prev, curr);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].valve, 'v1');
  assert.equal(changes[0].state, 'open');
  assert.equal(changes[0].mode, 'auto');
  assert.ok(changes[0].timestamp);
});

test('detectChanges detects v2 change', function () {
  var prev = { v1: false, v2: true, mode: 'auto' };
  var curr = { v1: false, v2: false, mode: 'override' };
  var changes = valvePoller.detectChanges(prev, curr);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].valve, 'v2');
  assert.equal(changes[0].state, 'closed');
  assert.equal(changes[0].mode, 'override');
});

test('detectChanges detects both valves changing simultaneously', function () {
  var prev = { v1: false, v2: false, mode: 'auto' };
  var curr = { v1: true, v2: true, mode: 'override' };
  var changes = valvePoller.detectChanges(prev, curr);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].valve, 'v1');
  assert.equal(changes[1].valve, 'v2');
});

// ── Poller behavior tests ──

test('start returns false when CONTROLLER_IP not set', function () {
  delete process.env.CONTROLLER_IP;
  var result = valvePoller.start(function () {});
  assert.equal(result, false);
});

test('stop clears interval without error', function () {
  // Should not throw even when not started
  valvePoller.stop();
});
