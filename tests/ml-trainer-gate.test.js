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

// ── Lane E: mode-schedule promotion guard (findings-doc rec #3) ──────
// A candidate model must not be promotable on better temperature RMSE
// alone when it degrades the 48 h MODE SCHEDULE — the operational
// output. The guard replays episode rollouts from the held-out tail
// with candidate vs serving forests and rejects the candidate when its
// dominant-mode accuracy is more than 3 pp below the serving model's on
// the same episodes. `computeForecast` is injectable so these tests
// stub the rollout and control each model's predicted schedule without
// training real forests.

const modeGate = require('../server/lib/forecast/ml/mode-gate.js');

const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-07-01T00:00:00Z'); // hour-aligned

// Ground truth: even hours idle, odd hours greenhouse_heating — a
// pattern a stub can predict perfectly (or butcher deliberately).
function actualModeAt(ms) {
  return (Math.floor(ms / HOUR) % 2 === 0) ? 'idle' : 'greenhouse_heating';
}

// Synthetic trainer payload surfaces covering [T0, T0 + windowHours h]:
// 5-min sensor points, hourly mode transitions, hourly weather (padded
// 48 h past the window so late episodes have forecast weather).
function fixture(windowHours) {
  const points = [];
  for (let t = T0; t <= T0 + windowHours * HOUR; t += 5 * 60000) {
    points.push({ ts: t, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 });
  }
  const events = [];
  for (let h = 0; h < windowHours; h++) {
    const ts = T0 + h * HOUR;
    events.push({
      ts, type: 'mode', id: 'controller',
      from: actualModeAt(ts - HOUR), to: actualModeAt(ts),
    });
  }
  const weather = [];
  for (let h = 0; h < windowHours + 48; h++) {
    weather.push({
      validAt: new Date(T0 + h * HOUR).toISOString(),
      temperature: 12, radiationGlobal: 0, windSpeed: 2, precipitation: 0,
    });
  }
  return { points, events, weather };
}

const servingTank = { marker: 'serving-tank' };
const candidateTank = { marker: 'candidate-tank' };
const servingModel = {
  tank: servingTank, greenhouse: { marker: 'serving-gh' },
  trainedAt: new Date(T0).toISOString(),
};
const candidateModel = { tank: candidateTank, greenhouse: { marker: 'candidate-gh' } };

// Rollout stub: returns a modeFractions schedule per model. Behaviour
// per side: 'perfect' predicts the ground-truth pattern, 'always-idle'
// predicts idle for all 48 h (~50 % accuracy on the alternating truth).
function stubCompute(servingBehaviour, candidateBehaviour) {
  return function compute(opts) {
    const behaviour = opts.model.tank === servingTank ? servingBehaviour : candidateBehaviour;
    const now = opts.now instanceof Date ? opts.now.getTime() : Number(opts.now);
    const modeFractions = [];
    for (let h = 0; h < 48; h++) {
      const hourStart = now + h * HOUR;
      const mode = behaviour === 'always-idle' ? 'idle' : actualModeAt(hourStart);
      const fractions = {};
      fractions[mode] = 1;
      modeFractions.push({ ts: new Date(hourStart).toISOString(), fractions, solar: 0 });
    }
    return { modeFractions };
  };
}

function guardOpts(fx, compute) {
  return {
    candidate: candidateModel,
    serving: servingModel,
    points: fx.points,
    events: fx.events,
    weather: fx.weather,
    testStartMs: T0,
    computeForecast: compute,
  };
}

describe('mode-schedule promotion guard (evaluateModeGuard)', () => {
  it('rejects a candidate whose dominant-mode accuracy is more than 3pp worse than serving', () => {
    const fx = fixture(96); // 8 episodes at 12 h spacing
    const res = modeGate.evaluateModeGuard(guardOpts(fx, stubCompute('perfect', 'always-idle')));
    assert.strictEqual(res.skipped, false);
    assert.strictEqual(res.pass, false);
    assert.match(res.reason, /mode schedule regressed/);
    assert.ok(res.servingAccuracy - res.candidateAccuracy > 0.03,
      'expected a wide accuracy gap, got ' + res.candidateAccuracy + ' vs ' + res.servingAccuracy);
    assert.ok(res.episodes >= modeGate.MIN_EPISODES);
    assert.ok(res.samples >= modeGate.MIN_MODE_SAMPLES);
  });

  it('passes a candidate whose schedule is equal to serving', () => {
    const fx = fixture(96);
    const res = modeGate.evaluateModeGuard(guardOpts(fx, stubCompute('perfect', 'perfect')));
    assert.strictEqual(res.skipped, false);
    assert.strictEqual(res.pass, true);
    assert.strictEqual(res.reason, null);
    assert.strictEqual(res.candidateAccuracy, res.servingAccuracy);
  });

  it('passes a candidate whose schedule is better than serving', () => {
    const fx = fixture(96);
    const res = modeGate.evaluateModeGuard(guardOpts(fx, stubCompute('always-idle', 'perfect')));
    assert.strictEqual(res.skipped, false);
    assert.strictEqual(res.pass, true);
    assert.ok(res.candidateAccuracy > res.servingAccuracy);
  });

  // ── Margin boundary (strictly greater than 3.0 pp rejects) ────────
  // fixture(68) yields 6 episodes joining 48+48+44+32+20+8 = 200 scored
  // hours per side. Errors are injected as flipped predictions on the
  // first K forecast hours of episode 0 (all of which join), giving
  // exact integer correct-counts and therefore exact rational accuracy
  // gaps.
  //
  // FP caveat: accuracies are integer ratios and the comparison is on
  // raw doubles, so a rationally-exact 3.0 pp gap can round to either
  // side of 0.03 depending on the counts. Serving errs 7 (193/200 =
  // 0.965), candidate errs 13 (187/200 = 0.935): the double gap is
  // 0.0299999999999999916 — the exact boundary lands on the promote
  // side, matching the strictly-greater intent.
  function stubComputeWithErrors(servingErrHours, candidateErrHours) {
    return function compute(opts) {
      const errHours = opts.model.tank === servingTank ? servingErrHours : candidateErrHours;
      const now = opts.now instanceof Date ? opts.now.getTime() : Number(opts.now);
      const modeFractions = [];
      for (let h = 0; h < 48; h++) {
        const hourStart = now + h * HOUR;
        let mode = actualModeAt(hourStart);
        if (now === T0 && h < errHours) mode = mode === 'idle' ? 'greenhouse_heating' : 'idle';
        const fractions = {};
        fractions[mode] = 1;
        modeFractions.push({ ts: new Date(hourStart).toISOString(), fractions, solar: 0 });
      }
      return { modeFractions };
    };
  }

  it('promotes a candidate exactly 3.0 pp worse than serving (boundary is exclusive)', () => {
    const fx = fixture(68);
    const res = modeGate.evaluateModeGuard(guardOpts(fx, stubComputeWithErrors(7, 13)));
    assert.strictEqual(res.skipped, false);
    assert.strictEqual(res.samples, 200);
    assert.ok(Math.abs(res.servingAccuracy - 0.965) < 1e-9, 'serving ' + res.servingAccuracy);
    assert.ok(Math.abs(res.candidateAccuracy - 0.935) < 1e-9, 'candidate ' + res.candidateAccuracy);
    assert.strictEqual(res.pass, true,
      'exactly 3.0 pp worse must be PROMOTED (strictly-greater rejection): ' + res.reason);
    assert.strictEqual(res.reason, null);
  });

  it('rejects a candidate just past the 3.0 pp boundary', () => {
    // One more wrong hour (candidate 186/200 = 0.93): a 3.5 pp gap —
    // the smallest representable step past the margin at 200 samples
    // (an exact 3.1 pp gap needs a sample count divisible by 1000) —
    // must be REJECTED.
    const fx = fixture(68);
    const res = modeGate.evaluateModeGuard(guardOpts(fx, stubComputeWithErrors(7, 14)));
    assert.strictEqual(res.skipped, false);
    assert.strictEqual(res.samples, 200);
    assert.strictEqual(res.pass, false, 'more than 3.0 pp worse must be rejected');
    assert.match(res.reason, /mode schedule regressed/);
  });

  it('skips cleanly (pass=true) when there are fewer than MIN_EPISODES episodes', () => {
    const fx = fixture(30); // starts at 0/12/24 h -> only 3 episodes
    const res = modeGate.evaluateModeGuard(guardOpts(fx, stubCompute('perfect', 'always-idle')));
    assert.strictEqual(res.pass, true, 'a skipped guard must never block promotion');
    assert.strictEqual(res.skipped, true);
    assert.match(res.reason, /episode/);
  });

  it('skips cleanly when mode-event ground truth is too thin', () => {
    const fx = fixture(96);
    fx.events = []; // no logged transitions -> zero hourly coverage
    const res = modeGate.evaluateModeGuard(guardOpts(fx, stubCompute('perfect', 'always-idle')));
    assert.strictEqual(res.pass, true);
    assert.strictEqual(res.skipped, true);
    assert.match(res.reason, /ground-truth coverage/);
  });

  it('skips cleanly when there is no serving model to compare against', () => {
    const fx = fixture(96);
    const opts = guardOpts(fx, stubCompute('perfect', 'always-idle'));
    opts.serving = null; // first-ever promotion
    const res = modeGate.evaluateModeGuard(opts);
    assert.strictEqual(res.pass, true);
    assert.strictEqual(res.skipped, true);
    assert.match(res.reason, /serving model/);
  });

  it('drops an episode for BOTH models when either rollout throws (sample parity)', () => {
    const fx = fixture(96);
    const inner = stubCompute('perfect', 'always-idle');
    let calls = 0;
    const flaky = function compute(opts) {
      calls++;
      // Fail the first rollout — its whole episode must be dropped for
      // both models, not just the side that threw.
      if (calls === 1) throw new Error('boom');
      return inner(opts);
    };
    const res = modeGate.evaluateModeGuard(guardOpts(fx, flaky));
    assert.strictEqual(res.skipped, false);
    assert.strictEqual(res.pass, false); // still enough episodes to judge
    assert.strictEqual(res.episodes, 7); // 8 built, 1 dropped
  });
});
