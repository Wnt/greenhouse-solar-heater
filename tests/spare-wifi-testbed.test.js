const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Static guard for scripts/spare-wifi-testbed.mjs (issue #262 WS1).
//
// The harness runs against real spare hardware later; we cannot exercise its
// HTTP/RPC paths here. Instead we assert the LOAD-BEARING invariants by
// extracting its pure on-device script builders (buildOld/buildNew, plus the
// header/ballast helpers + the constants they close over) and checking the
// uploaded ES5 shape:
//   1. SAFETY: target is the spare .55 / mac EC6260A00240 only; no Switch.Set is
//      ever emitted toward the spare's own relays; the on-device script HTTP.GETs
//      only the harness callback host.
//   2. OLD shape is the current-fragile one: no per-call timeout, overlap-capable
//      (repeating Timer drives controlLoop), 5 sensor calls/tick.
//   3. NEW shape is the #262-hardened one: every HTTP.GET carries a timeout, an
//      in-flight guard prevents overlap, reads are batched to 2 calls/tick, a
//      staleness cache with SENSOR_MAX_AGE_S exists, and valve actuation is
//      bounded-retry + verified.

const HARNESS_PATH = path.join(__dirname, '..', 'scripts', 'spare-wifi-testbed.mjs');
const SRC = fs.readFileSync(HARNESS_PATH, 'utf8');

// Pull the named declarations we need out of the ESM source and eval them in a
// sandbox. They are pure string builders + plain consts (no imports, no I/O).
function loadBuilders() {
  // Grab only the single-line consts the builders close over. RUN_MS / BALLAST_N
  // are computed from CLI/env across multiple lines; we stub them in the sandbox
  // instead (their exact values don't change the shapes under test).
  const names = [
    'SPARE', 'EXPECT_MAC', 'EXPECT_APP', 'SLOT_ID',
    'HTTP_TIMEOUT_S', 'SENSOR_MAX_AGE_S', 'VALVE_MAX_RETRIES', 'VALVE_BACKOFF_MS',
  ];
  function grab(decl, name) {
    // Match `const NAME = … ;` up to the first terminating semicolon, allowing
    // the RHS to span multiple lines (e.g. a ternary over BALLAST_N / RUN_MS).
    const re = new RegExp('const ' + name + ' = [\\s\\S]*?;');
    const m = decl.match(re);
    assert.ok(m, 'could not find const ' + name);
    return m[0];
  }
  const constLines = names.map(function (n) { return grab(SRC, n); }).join('\n');

  function fn(name) {
    const start = SRC.indexOf('function ' + name + '(');
    assert.ok(start >= 0, 'could not find function ' + name);
    // Walk braces from the first { after the signature to find the body end.
    const open = SRC.indexOf('{', start);
    let depth = 0;
    let i = open;
    for (; i < SRC.length; i++) {
      if (SRC[i] === '{') depth++;
      else if (SRC[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return SRC.slice(start, i);
  }
  const fns = ['ballastPrefix', 'commonHeader', 'buildOld', 'buildNew', 'buildCalib'].map(fn).join('\n\n');

  const sandbox = {};
  vm.createContext(sandbox);
  // Stub the CLI/env-derived values the builders read (kept out of `names`).
  const stubs = 'const BALLAST_N = 207;\nconst RUN_MS = 180000;\n';
  vm.runInContext(stubs + constLines + '\n' + fns +
    '\nthis.buildOld = buildOld; this.buildNew = buildNew; this.buildCalib = buildCalib;' +
    '\nthis.K = { SPARE:SPARE, EXPECT_MAC:EXPECT_MAC, HTTP_TIMEOUT_S:HTTP_TIMEOUT_S, SENSOR_MAX_AGE_S:SENSOR_MAX_AGE_S, VALVE_MAX_RETRIES:VALVE_MAX_RETRIES };',
    sandbox);
  return sandbox;
}

const B = loadBuilders();
const SELF = '10.0.0.9:8599';
const OLD = B.buildOld(SELF);
const NEW = B.buildNew(SELF);
const CALIB = B.buildCalib();

describe('spare-wifi-testbed safety invariants', () => {
  it('targets only the spare .55 / mac EC6260A00240', () => {
    assert.strictEqual(B.K.SPARE, '192.168.30.55');
    assert.strictEqual(B.K.EXPECT_MAC, 'EC6260A00240');
    // The harness must hard-code the spare and the expected mac; the source must
    // not parameterise the host (no env/arg override of SPARE).
    assert.ok(/const SPARE = '192\.168\.30\.55'/.test(SRC));
    assert.ok(!/SPARE\s*=\s*(?:argOf|process\.env)/.test(SRC), 'SPARE must not be overridable');
  });

  it('the uploaded on-device script never emits a real Switch.Set RPC', () => {
    // Faithful shape uses HTTP.GET to a Switch.Set URL on OUR server, never a
    // direct Shelly.call("Switch.Set", …) that would move the spare's relays.
    for (const code of [OLD, NEW, CALIB]) {
      assert.ok(!/Shelly\.call\("Switch\.Set"/.test(code),
        'on-device script must not call Switch.Set on the spare');
    }
  });

  it('the on-device script only HTTP.GETs the harness callback host', () => {
    for (const code of [OLD, NEW]) {
      const urls = code.match(/https?:\/\/[^"']+/g) || [];
      for (const u of urls) {
        assert.ok(u.indexOf(SELF.split(':')[0]) >= 0,
          'on-device URL ' + u + ' must point at the harness callback host');
      }
    }
  });

  it('every on-device script carries a fail-safe auto-stop timer', () => {
    for (const code of [OLD, NEW]) {
      assert.ok(/Script\.Stop/.test(code) && /Timer\.set\(\d+, false, function\(\){ Shelly\.call\("Script\.Stop"/.test(code),
        'on-device script must self-stop if the runner vanishes');
    }
  });
});

describe('spare-wifi-testbed OLD = current fragile shape', () => {
  it('uses NO per-call HTTP.GET timeout', () => {
    assert.ok(/Shelly\.call\("HTTP\.GET", \{url: [^}]*\}, function/.test(OLD));
    assert.ok(!/timeout:/.test(OLD), 'old shape must not pass a timeout (faithful to current control.js)');
  });

  it('is overlap-capable (repeating timer drives controlLoop, no in-flight guard)', () => {
    assert.ok(/Timer\.set\(2000, true, controlLoop\)/.test(OLD), 'old must use a repeating tick timer');
    assert.ok(!/inFlight/.test(OLD), 'old must not have an in-flight guard');
  });

  it('polls 5 sensors per tick', () => {
    assert.ok(/SIDS = \[100,101,102,103,104\]/.test(OLD));
    assert.ok(/i >= SIDS\.length/.test(OLD), 'old iterates all 5 sensor ids sequentially');
  });
});

describe('spare-wifi-testbed NEW = #262 hardened shape', () => {
  it('puts a short timeout on every HTTP.GET', () => {
    const gets = NEW.match(/Shelly\.call\("HTTP\.GET", \{[^}]*\}/g) || [];
    assert.ok(gets.length >= 3, 'expected multiple HTTP.GET calls in the hardened shape');
    for (const g of gets) {
      assert.ok(/timeout: HTTP_TIMEOUT_S/.test(g), 'every HTTP.GET must carry timeout: ' + g);
    }
    assert.strictEqual(B.K.HTTP_TIMEOUT_S, 3);
  });

  it('has an in-flight guard so controlLoop never overlaps', () => {
    assert.ok(/var inFlight = false;/.test(NEW));
    assert.ok(/if \(inFlight\) \{ return; \}/.test(NEW), 'controlLoop must bail when a cycle is in flight');
    assert.ok(/inFlight = false;/.test(NEW), 'guard must be released on completion');
  });

  it('batches reads to 2 hub calls per tick (not 5)', () => {
    assert.ok(/hubRead\("a"/.test(NEW) && /hubRead\("b"/.test(NEW), 'two hub reads, not five sensor reads');
    assert.ok(!/i >= SIDS\.length/.test(NEW), 'new must not iterate the 5-sensor loop');
  });

  it('keeps a staleness cache governed by a single max-age const', () => {
    assert.strictEqual(B.K.SENSOR_MAX_AGE_S, 180);
    assert.ok(/var cache = \{/.test(NEW), 'must hold a last-good cache');
    assert.ok(/SENSOR_MAX_AGE_S \* 1000/.test(NEW), 'freshness must be gated by the max-age const');
    assert.ok(/fresh\(cache\.aTs\) \? cache\.a : null/.test(NEW),
      'past max-age a role must resolve to null (caller degrades to IDLE)');
  });

  it('bounds valve retries and verifies actuation', () => {
    assert.strictEqual(B.K.VALVE_MAX_RETRIES, 2);
    assert.ok(/attempt > VALVE_MAX_RETRIES/.test(NEW), 'retries must be bounded');
    assert.ok(/VALVE_BACKOFF_MS/.test(NEW), 'retries must back off');
    assert.ok(/function verify\(/.test(NEW) && /Switch\.GetStatus/.test(NEW),
      'success must be confirmed via a Switch.GetStatus-shaped verify read');
  });
});
