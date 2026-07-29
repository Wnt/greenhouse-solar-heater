/**
 * Shelly control-script memory budget gate.
 *
 * 2026-07-28 incident: the wired-control-path change added ~0.5 KB of
 * resident JsVars to a control script already riding its fixed 25,186-byte
 * per-script pool, and the Pro 4PM OOM-crash-looped at the first
 * transition. Nothing in CI measured script growth, so the regression
 * shipped silently.
 *
 * The gate: shelly/script-budget.json pins a hard cap on the DEPLOY-SHAPE
 * size (comment-stripped, whitespace-trimmed — exactly deploy.sh's minify)
 * of control-logic.js + control.js. scripts/check-shelly-script-size.mjs
 * enforces it in CI and the pre-push hook. The cap may only be raised
 * together with a fresh on-device calibration (recorded in the budget
 * file) showing acceptable transition mem_peak headroom.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CHECKER = path.join(ROOT, 'scripts', 'check-shelly-script-size.mjs');

function runChecker(env) {
  try {
    const out = execFileSync('node', [CHECKER], { env: { ...process.env, ...(env || {}) }, encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

describe('shelly script memory budget', () => {
  const budget = require('../shelly/script-budget.json');

  it('budget file pins the real Gen2 JsVar pool size', () => {
    // Must match POOL_BYTES in scripts/spare-2pm-memcheck.mjs — the fixed
    // per-script pool (used+free) observed on both the 4PM and the spare 2PM.
    assert.strictEqual(budget.jsvarPoolBytes, 25186);
  });

  it('budget covers exactly the deployed script pair', () => {
    assert.deepStrictEqual(budget.files, ['control-logic.js', 'control.js']);
  });

  it('carries an on-device calibration so cap raises are evidence-based', () => {
    const c = budget.calibration;
    assert.ok(c && c.date, 'calibration.date required');
    assert.strictEqual(typeof c.minifiedBytes, 'number');
    assert.strictEqual(typeof c.transitionMemPeak, 'number');
    assert.ok(c.transitionMemPeak <= budget.jsvarPoolBytes,
      'measured peak cannot exceed the pool');
  });

  it('the current repo passes the gate (checker exits 0)', () => {
    const r = runChecker();
    assert.strictEqual(r.code, 0, 'checker should pass on the committed scripts:\n' + r.out);
    assert.match(r.out, /deploy-shape bytes/i);
  });

  it('the checker fails when the cap is exceeded', () => {
    // Simulate a shrunken cap via env override — same code path a real
    // regression would take.
    const r = runChecker({ SHELLY_SCRIPT_MAX_BYTES: '1000' });
    assert.notStrictEqual(r.code, 0, 'checker must exit non-zero over cap');
    assert.match(r.out, /over the budget/i);
    assert.match(r.out, /script-budget\.json/,
      'failure message must point at the budget + recalibration procedure');
  });

  it('cap leaves no silent runway past the calibrated peak headroom', () => {
    // The cap may exceed the calibrated size only by less than the measured
    // peak headroom at calibration time — growth beyond what the device
    // demonstrably survived requires a fresh calibration, not a hopeful cap.
    const peakHeadroom = budget.jsvarPoolBytes - budget.calibration.transitionMemPeak;
    const runway = budget.maxMinifiedBytes - budget.calibration.minifiedBytes;
    assert.ok(runway >= 0, 'cap below calibrated size makes the repo permanently red');
    assert.ok(runway < peakHeadroom,
      `cap allows ${runway} B growth but the calibrated transition peak headroom is only ${peakHeadroom} B`);
  });
});
