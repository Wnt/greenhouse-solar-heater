/**
 * Regression: the e2e harness (tests/e2e/_setup/start.cjs) crashed on
 * teardown. Its SIGTERM/SIGINT handler did `broker.close().then(...)`, but
 * aedes' `broker.close()` returns `undefined` and signals completion via a
 * callback — so `.then` threw a TypeError. Every Playwright e2e run ended
 * with an uncaught exception + non-zero exit on webServer teardown, and a
 * stalled broker close was never awaited.
 *
 * Fix: pass a callback to `broker.close()` (with an unref'd timer fallback
 * so a stalled close still lets the process exit).
 *
 * The behavioural half builds a real aedes broker (in-memory; no port is
 * bound, so this is sandbox-safe and fast) and pins the close() contract.
 * The source-guard half ensures start.cjs never regresses to the broken
 * `.close().then()` shape.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Aedes } = require('aedes');

const START_CJS = path.join(__dirname, 'e2e', '_setup', 'start.cjs');

describe('e2e harness shutdown', () => {
  it('aedes broker.close() returns undefined and signals via callback', async () => {
    // This is the contract the bug violated: close() is callback-style and
    // its return value is undefined, so calling .then() on it throws.
    const broker = await Aedes.createBroker();
    let returnValue;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('broker.close() never invoked its callback')),
        2000,
      );
      returnValue = broker.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    assert.equal(
      returnValue,
      undefined,
      'broker.close() returns undefined — callers must use the callback, not .then()',
    );
  });

  it('start.cjs does not call broker.close().then() (crashes teardown)', () => {
    const src = fs.readFileSync(START_CJS, 'utf8');
    assert.doesNotMatch(
      src,
      /broker\.close\(\s*\)\s*\.then/,
      'broker.close().then(...) throws — aedes close() returns undefined',
    );
  });

  it('start.cjs passes a callback to broker.close()', () => {
    const src = fs.readFileSync(START_CJS, 'utf8');
    assert.match(
      src,
      /broker\.close\(\s*[^)]/,
      'shutdown must pass a completion callback to broker.close()',
    );
  });
});
