/**
 * Unit tests for the corrupt-telemetry tracker (spec 025, FR-1).
 *
 * Background: on 2026-08-12 the Pro 4PM published 10 consecutive truncated
 * greenhouse/state/min payloads (Espruino OOM string truncation) while the
 * collector stagnated to 71.7 °C. The server logged each as `warn` and
 * nothing reached the operator. This tracker turns a sustained run of
 * unparseable payloads into exactly one escalation per episode.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTelemetryHealth } = require('../server/lib/telemetry-health');

function makeFakePush() {
  const sent = [];
  return {
    sent,
    sendNotification(type, payload, opts) { sent.push({ type, payload, opts }); },
  };
}

describe('telemetry-health', () => {
  it('does not escalate below the consecutive threshold', () => {
    const push = makeFakePush();
    const th = createTelemetryHealth({ push });
    th.recordInvalid('Unexpected token .');
    th.recordInvalid('Unexpected token .');
    assert.strictEqual(push.sent.length, 0);
    assert.strictEqual(th.getStatus().consecutive, 2);
    assert.strictEqual(th.getStatus().escalated, false);
  });

  it('escalates exactly once at the threshold and not on later failures', () => {
    const push = makeFakePush();
    const th = createTelemetryHealth({ push });
    for (let i = 0; i < 10; i++) th.recordInvalid('Unexpected token .');
    assert.strictEqual(push.sent.length, 1);
    const s = push.sent[0];
    assert.strictEqual(s.type, 'script_crash');
    assert.strictEqual(s.opts.force, true);
    assert.strictEqual(s.opts.ignoreRateLimit, true);
    assert.match(s.payload.title, /telemetry/i);
    assert.strictEqual(th.getStatus().total, 10);
    assert.strictEqual(th.getStatus().consecutive, 10);
  });

  it('resets the episode on a valid parse and re-escalates on a new run', () => {
    const push = makeFakePush();
    const th = createTelemetryHealth({ push });
    for (let i = 0; i < 3; i++) th.recordInvalid('bad');
    assert.strictEqual(push.sent.length, 1);
    th.recordValid();
    assert.strictEqual(th.getStatus().consecutive, 0);
    assert.strictEqual(th.getStatus().escalated, false);
    for (let i = 0; i < 3; i++) th.recordInvalid('bad');
    assert.strictEqual(push.sent.length, 2);
    // total accumulates across episodes; recoveries are counted too.
    assert.strictEqual(th.getStatus().total, 6);
    assert.strictEqual(th.getStatus().episodes, 2);
  });

  it('honors a custom threshold', () => {
    const push = makeFakePush();
    const th = createTelemetryHealth({ push, threshold: 1 });
    th.recordInvalid('bad');
    assert.strictEqual(push.sent.length, 1);
  });

  it('works without a push module (preview pods log only)', () => {
    const th = createTelemetryHealth({ push: null });
    for (let i = 0; i < 5; i++) th.recordInvalid('bad');
    assert.strictEqual(th.getStatus().escalated, true);
  });

  it('reports first/last timestamps and the last error from the injected clock', () => {
    const push = makeFakePush();
    let t = 1000;
    const th = createTelemetryHealth({ push, now: () => t });
    th.recordInvalid('first error');
    t = 4000;
    th.recordInvalid('second error');
    const s = th.getStatus();
    assert.strictEqual(s.firstAt, 1000);
    assert.strictEqual(s.lastAt, 4000);
    assert.strictEqual(s.lastError, 'second error');
  });
});
