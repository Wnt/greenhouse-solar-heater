const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// DRIFT GUARD for scripts/spare-2pm-memcheck.mjs.
//
// The spare-2PM OOM harness measures the per-tick JsVar transient on real
// hardware. Its PASS variant must build the EXACT payload the device ships, or
// the hardware headroom measurement is fiction. After the #254 refinement the
// PASS variant calls the REAL buildMinPayload from the minified
// shelly/control-logic.js blob the harness prepends — NOT a re-inlined copy
// that could silently diverge. This test enforces both halves:
//
//   1. STRUCTURAL: the generated harness body contains no local
//      `function buildMinPayload` (so PASS resolves to the blob's real one),
//      while still inlining `function buildFullPayload` for the FAIL repro
//      (that pre-#254 snapshot was removed from control-logic.js).
//   2. BEHAVIOURAL: running the minified control-logic blob + the harness PASS
//      snapshot line in a sandbox emits a payload whose key set is exactly the
//      key set of the real buildMinPayload in shelly/control-logic.js. A field
//      added/removed in the device builder fails CI here instead of skewing a
//      hand-run hardware number.

const HARNESS_PATH = path.join(__dirname, '..', 'scripts', 'spare-2pm-memcheck.mjs');
const LOGIC_PATH = path.join(__dirname, '..', 'shelly', 'control-logic.js');

const { buildMinPayload } = require('../shelly/control-logic.js');

// Mirror deploy.sh / the harness minify(): drop blank lines + full-line //
// comments + leading indentation. Used so the sandboxed blob matches what the
// harness actually uploads.
function minify(src) {
  const out = [];
  for (const line of src.split('\n')) {
    const s = line.replace(/^\s+/, '');
    if (!s || s.startsWith('//')) continue;
    out.push(s);
  }
  return out.join('\n') + '\n';
}

// Pull the buildHarness() template body and the SNAP_PASS/SNAP_FAIL lines out
// of the harness source by evaluating just those declarations in a sandbox —
// they are pure string builders with no I/O.
function loadHarnessPieces() {
  const src = fs.readFileSync(HARNESS_PATH, 'utf8');
  // Isolate the buildHarness function and the SNAP_* consts. They reference
  // PAD (a module-level number) — provide it.
  // buildHarness returns a template literal, so its body contains `}` chars;
  // bound the slice on the `const SNAP_FAIL` declaration that follows it.
  const fnStart = src.indexOf('function buildHarness(snapLine) {');
  const fnEnd = src.indexOf('const SNAP_FAIL', fnStart);
  assert.ok(fnStart >= 0 && fnEnd > fnStart, 'could not locate buildHarness in the harness source');
  const fnSource = src.slice(fnStart, fnEnd).trimEnd();
  const fnMatch = [fnSource];
  const snapPass = src.match(/const SNAP_PASS = '([^']*)'/);
  const snapFail = src.match(/const SNAP_FAIL = '([^']*)'/);
  assert.ok(snapPass && snapFail, 'could not locate SNAP_PASS / SNAP_FAIL');
  const sandbox = { PAD: 58 };
  vm.createContext(sandbox);
  vm.runInContext(fnMatch[0] + '\nthis.buildHarness = buildHarness;', sandbox);
  return {
    buildHarness: sandbox.buildHarness,
    snapPass: snapPass[1],
    snapFail: snapFail[1],
  };
}

describe('spare-2pm-memcheck PASS builder must be the real device buildMinPayload', () => {
  const { buildHarness, snapPass, snapFail } = loadHarnessPieces();

  it('the harness body does NOT re-inline buildMinPayload (uses the blob\'s real one)', () => {
    const body = buildHarness(snapPass);
    assert.strictEqual(/function\s+buildMinPayload\s*\(/.test(body), false,
      'harness must not define its own buildMinPayload — PASS must call the real one from the control-logic blob');
    // Sanity: the PASS snapshot line DOES invoke buildMinPayload (resolved from
    // the prepended blob).
    assert.ok(/buildMinPayload\(ST,DC,1000000\)/.test(snapPass),
      'SNAP_PASS must call buildMinPayload');
  });

  it('the harness still inlines buildFullPayload for the FAIL repro', () => {
    const body = buildHarness(snapFail);
    assert.ok(/function\s+buildFullPayload\s*\(/.test(body),
      'harness must keep an inlined buildFullPayload (removed from control-logic.js, needed for the OOM repro)');
    assert.ok(/buildFullPayload\(ST,DC,1000000\)/.test(snapFail),
      'SNAP_FAIL must call buildFullPayload');
  });

  it('PASS emits exactly the real buildMinPayload key set (no field drift)', () => {
    // Reference key set: the real device builder over the harness ST/DC.
    const ST = {
      mode: 'SOLAR_CHARGING', transitioning: true, transition_step: 'valves_opening',
      temps: { collector: 78.5, tank_top: 62, tank_bottom: 55, greenhouse: 24, outdoor: 10 },
      collectors_drained: false, emergency_heating_active: false, greenhouse_fan_cooling_active: true,
      valveOpenSince: { vo_rad: 940000 }, valveOpening: { vi_btm: 1010000 },
      valvePendingOpen: ['vi_top'], valvePendingClose: ['vo_rad'],
      lastTransitionCause: 'automation', lastTransitionReason: 'solar_enter',
      last_eval_reason: 'collector still climbing', last_held: null,
    };
    const DC = { ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, tu: {}, mo: null, v: 1 };
    const expectedKeys = Object.keys(JSON.parse(buildMinPayload(ST, DC, 1000000)));

    // Now run the minified blob + the harness PASS line in a sandbox and
    // capture the snapshot the harness builds (the same code path that ships).
    const blob = minify(fs.readFileSync(LOGIC_PATH, 'utf8'));
    const captured = { snap: null };
    const sandbox = {
      // Shelly runtime shims — the harness schedules ticks via Timer.set and
      // builds JSON via JSON. We run the tick body synchronously instead.
      Timer: { set: function () {} },
      JSON, Math,
      __capture: function (s) { captured.snap = s; },
    };
    vm.createContext(sandbox);
    // Prepend the device logic (defines buildMinPayload, evaluate,
    // planValveTransition, VALVE_NAMES_SORTED, VALVE_TIMING, …), then the PASS
    // snapshot line wrapped to capture its output.
    const program = blob + `
var ST=${JSON.stringify(ST)};
var DC=${JSON.stringify(DC)};
${snapPass}
__capture(snap);
`;
    vm.runInContext(program, sandbox);
    assert.ok(typeof captured.snap === 'string', 'harness PASS line must produce a JSON string');
    const harnessKeys = Object.keys(JSON.parse(captured.snap));
    assert.deepStrictEqual(harnessKeys, expectedKeys,
      'harness PASS payload key set must equal the real buildMinPayload key set (order included)');
  });
});
