const { describe, it } = require('node:test');
const assert = require('node:assert');
const forecastBootstrap = require('../server/lib/forecast/forecast-bootstrap.js');

// The in-process ML trainer OOM'd the app pod (2026-06-22 incident). The
// incident-responder needs a runtime kill-switch so it can quarantine a
// crash-looping trainer with `kubectl set env DISABLE_ML_TRAINER=true`
// (then a rollout-restart) WITHOUT a code deploy. This guards the gate.
describe('ml trainer start gate (mlTrainerEnabled)', () => {
  const fn = forecastBootstrap.mlTrainerEnabled;

  it('is exported as a pure helper', () => {
    assert.strictEqual(typeof fn, 'function');
  });

  it('enabled by default (prod, not preview, flag unset)', () => {
    assert.strictEqual(fn({}, false), true);
  });

  it('disabled when NODE_ENV=test', () => {
    assert.strictEqual(fn({ NODE_ENV: 'test' }, false), false);
  });

  it('disabled in preview mode', () => {
    assert.strictEqual(fn({}, true), false);
  });

  it('disabled when DISABLE_ML_TRAINER=true (the kill-switch)', () => {
    assert.strictEqual(fn({ DISABLE_ML_TRAINER: 'true' }, false), false);
  });

  it('stays enabled for any non-"true" value of the flag', () => {
    assert.strictEqual(fn({ DISABLE_ML_TRAINER: 'false' }, false), true);
    assert.strictEqual(fn({ DISABLE_ML_TRAINER: '1' }, false), true);
    assert.strictEqual(fn({ DISABLE_ML_TRAINER: '' }, false), true);
  });
});
