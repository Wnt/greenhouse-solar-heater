const { describe, it } = require('node:test');
const assert = require('node:assert');
const { evaluate, MODES, DEFAULT_CONFIG, MODE_VALVES,
        VALVE_TIMING, planValveTransition,
        buildSnapshotFromState, runBoundedPool,
        formatDuration, formatTemp, buildDisplayLabels } = require('../shelly/control-logic.js');

function makeState(overrides) {
  const base = {
    temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    currentMode: MODES.IDLE,
    modeEnteredAt: 0,
    now: 2000,
    collectorsDrained: false,
    lastRefillAttempt: 0,
    emergencyHeatingActive: false,
    sensorAge: { collector: 0, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 }
  };
  return Object.assign({}, base, overrides);
}

const VALVE_NAMES = ['vi_btm', 'vi_top', 'vi_coll', 'vo_coll', 'vo_rad', 'vo_tank', 'v_air'];

function allClosed() {
  const m = {};
  for (const n of VALVE_NAMES) m[n] = false;
  return m;
}

function allOpenSinceZero() {
  const m = {};
  for (const n of VALVE_NAMES) m[n] = 0;
  return m;
}

function assertInvariants(plan, input) {
  const { opening, now, current, openSince, cfg } = input;
  const timing = cfg || VALVE_TIMING;

  // INV1: slot budget.
  let liveOpens = 0;
  for (const k in opening) if (opening[k] > now) liveOpens++;
  assert.ok(
    liveOpens + plan.startOpening.length <= timing.maxConcurrentOpens,
    `INV1: liveOpens(${liveOpens}) + startOpening(${plan.startOpening.length}) > maxConcurrentOpens(${timing.maxConcurrentOpens})`
  );

  // INV2: no valve in both startOpening and closeNow.
  for (const v of plan.startOpening) {
    assert.ok(plan.closeNow.indexOf(v) === -1, `INV2: ${v} in both startOpening and closeNow`);
  }

  // INV3: no valve in closeNow has (now - openSince[v]) < minOpenMs unless openSince[v] === 0.
  for (const v of plan.closeNow) {
    const since = openSince[v] || 0;
    if (since !== 0) {
      assert.ok(
        now - since >= timing.minOpenMs,
        `INV3: ${v} in closeNow but now(${now}) - openSince(${since}) = ${now - since} < minOpenMs(${timing.minOpenMs})`
      );
    }
  }

  // INV4: no valve in startOpening has current[v] === true.
  for (const v of plan.startOpening) {
    assert.ok(!current[v], `INV4: ${v} in startOpening but current[${v}] === true`);
  }

  // INV5: no valve in closeNow has current[v] === false.
  for (const v of plan.closeNow) {
    assert.ok(current[v], `INV5: ${v} in closeNow but current[${v}] === false`);
  }

  // INV6: targetReached ⇒ all lists empty AND no live opens.
  if (plan.targetReached) {
    assert.strictEqual(plan.startOpening.length, 0, 'INV6: targetReached but startOpening non-empty');
    assert.strictEqual(plan.closeNow.length, 0, 'INV6: targetReached but closeNow non-empty');
    assert.strictEqual(plan.queuedOpens.length, 0, 'INV6: targetReached but queuedOpens non-empty');
    assert.strictEqual(Object.keys(plan.deferredCloses).length, 0, 'INV6: targetReached but deferredCloses non-empty');
    assert.strictEqual(liveOpens, 0, 'INV6: targetReached but live opening windows remain');
  }

  // INV7: nextResumeAt > now when non-null.
  if (plan.nextResumeAt !== null) {
    assert.ok(plan.nextResumeAt > now, `INV7: nextResumeAt(${plan.nextResumeAt}) <= now(${now})`);
  }
}

describe('planValveTransition — foundational', () => {
  it('target reached: all target === current, no live opens → targetReached=true, nextResumeAt=null (case 9)', () => {
    const state = { vi_btm: true, vo_coll: true, v_air: false };
    const current = { vi_btm: true, vo_coll: true, v_air: false };
    const openSince = { vi_btm: 1000, vo_coll: 1000, v_air: 0 };
    const opening = {};
    const now = 100000;
    const plan = planValveTransition(state, current, openSince, opening, now, VALVE_TIMING);
    assert.strictEqual(plan.targetReached, true);
    assert.strictEqual(plan.nextResumeAt, null);
    assert.deepStrictEqual(plan.startOpening, []);
    assert.deepStrictEqual(plan.closeNow, []);
    assert.deepStrictEqual(plan.queuedOpens, []);
    assert.deepStrictEqual(plan.deferredCloses, {});
    assertInvariants(plan, { target: state, current, openSince, opening, now });
  });

  it('pure/deterministic: same inputs → deep-equal output (INV8)', () => {
    const target = { vi_btm: true, vi_top: false, vo_coll: true };
    const current = { vi_btm: false, vi_top: false, vo_coll: false };
    const openSince = { vi_btm: 0, vi_top: 0, vo_coll: 0 };
    const opening = {};
    const now = 1234567;
    const a = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    const b = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.deepStrictEqual(a, b);
  });

  it('VALVE_TIMING has documented defaults', () => {
    assert.strictEqual(VALVE_TIMING.maxConcurrentOpens, 2);
    assert.strictEqual(VALVE_TIMING.openWindowMs, 20000);
    assert.strictEqual(VALVE_TIMING.minOpenMs, 60000);
  });
});

describe('planValveTransition — US1 PSU slot budget', () => {
  it('case 1: single valve needs to open → startOpening=[v], nextResumeAt=now+openWindowMs', () => {
    const target = { vi_btm: true };
    const current = { vi_btm: false };
    const openSince = { vi_btm: 0 };
    const opening = {};
    const now = 100000;
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.deepStrictEqual(plan.startOpening, ['vi_btm']);
    assert.deepStrictEqual(plan.closeNow, []);
    assert.deepStrictEqual(plan.queuedOpens, []);
    assert.deepStrictEqual(plan.deferredCloses, {});
    assert.strictEqual(plan.targetReached, false);
    assert.strictEqual(plan.nextResumeAt, now + VALVE_TIMING.openWindowMs);
    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('case 2: four closed valves all need to open → 2 in startOpening, 2 in queuedOpens, alphabetical order', () => {
    const target = { vi_btm: true, vi_top: true, vo_coll: true, vo_rad: true };
    const current = { vi_btm: false, vi_top: false, vo_coll: false, vo_rad: false };
    const openSince = { vi_btm: 0, vi_top: 0, vo_coll: 0, vo_rad: 0 };
    const opening = {};
    const now = 500000;
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.strictEqual(plan.startOpening.length, 2);
    assert.strictEqual(plan.queuedOpens.length, 2);
    // Stable alphabetical ordering across the combined [startOpening, queuedOpens] list.
    const combined = plan.startOpening.concat(plan.queuedOpens);
    assert.deepStrictEqual(combined, ['vi_btm', 'vi_top', 'vo_coll', 'vo_rad']);
    assert.deepStrictEqual(plan.closeNow, []);
    assert.strictEqual(plan.targetReached, false);
    assert.strictEqual(plan.nextResumeAt, now + VALVE_TIMING.openWindowMs);
    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('case 15: deterministic ordering (same input different key insertion order → same output arrays)', () => {
    const target1 = {};
    target1.vo_rad = true; target1.vi_btm = true; target1.vo_coll = true; target1.vi_top = true;
    const target2 = {};
    target2.vi_btm = true; target2.vi_top = true; target2.vo_coll = true; target2.vo_rad = true;
    const current = { vi_btm: false, vi_top: false, vo_coll: false, vo_rad: false };
    const openSince = { vi_btm: 0, vi_top: 0, vo_coll: 0, vo_rad: 0 };
    const opening = {};
    const now = 200000;
    const p1 = planValveTransition(target1, current, openSince, opening, now, VALVE_TIMING);
    const p2 = planValveTransition(target2, current, openSince, opening, now, VALVE_TIMING);
    assert.deepStrictEqual(p1, p2);
  });

  it('case 11: mix — two valves closing (hold satisfied) + three opening from closed', () => {
    const target = {
      vi_btm: true, vi_top: true, vo_coll: true,    // three to open
      vo_rad: false, vo_tank: false                  // two to close
    };
    const current = {
      vi_btm: false, vi_top: false, vo_coll: false,
      vo_rad: true, vo_tank: true
    };
    // openSince values are old enough that closes are immediately eligible.
    // Hold behavior is exercised in US3; this test isolates slot-budget logic.
    const openSince = { vi_btm: 0, vi_top: 0, vo_coll: 0, vo_rad: 1000, vo_tank: 1000 };
    const opening = {};
    const now = 70000 + 1000; // > 60s after openSince for the closing pair
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.strictEqual(plan.startOpening.length, 2, 'two opens this tick (slot budget)');
    assert.strictEqual(plan.queuedOpens.length, 1, 'one queued');
    // Slot budget counts only opens.
    assert.strictEqual(plan.closeNow.length, 2);
    assert.strictEqual(plan.closeNow.indexOf('vo_rad') > -1, true);
    assert.strictEqual(plan.closeNow.indexOf('vo_tank') > -1, true);
    assertInvariants(plan, { target, current, openSince, opening, now });
  });
});

describe('planValveTransition — US2 cross-tick queue', () => {
  it('case 3: two valves mid-flight, two more queued → startOpening=[], queuedOpens=[remaining two], nextResumeAt=min(opening[v])', () => {
    const target = { vi_btm: true, vi_top: true, vo_coll: true, vo_rad: true };
    const current = { vi_btm: false, vi_top: false, vo_coll: false, vo_rad: false };
    const openSince = { vi_btm: 0, vi_top: 0, vo_coll: 0, vo_rad: 0 };
    // Both slots are taken: vi_btm + vo_coll are mid-flight
    const now = 100000;
    const opening = { vi_btm: now + 12000, vo_coll: now + 15000 };
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.deepStrictEqual(plan.startOpening, []);
    assert.strictEqual(plan.queuedOpens.length, 2);
    assert.ok(plan.queuedOpens.indexOf('vi_top') > -1);
    assert.ok(plan.queuedOpens.indexOf('vo_rad') > -1);
    // nextResumeAt is the earliest live window end.
    assert.strictEqual(plan.nextResumeAt, now + 12000);
    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('case 4: first batch window ended → opening now empty, queued valves move into startOpening', () => {
    const target = { vi_btm: true, vi_top: true, vo_coll: true, vo_rad: true };
    // First batch finished; the shell cleared the opening entries and updated current.
    const current = { vi_btm: true, vo_coll: true, vi_top: false, vo_rad: false };
    const openSince = { vi_btm: 120000, vo_coll: 120000, vi_top: 0, vo_rad: 0 };
    const opening = {}; // window ended, caller cleared
    const now = 120000;
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.strictEqual(plan.startOpening.length, 2);
    assert.deepStrictEqual(plan.startOpening.slice().sort(), ['vi_top', 'vo_rad']);
    assert.deepStrictEqual(plan.queuedOpens, []);
    assert.strictEqual(plan.nextResumeAt, now + VALVE_TIMING.openWindowMs);
    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('case 10: mid-transition target change — valve in opening but target now closes it → not in any action list, nextResumeAt includes its window end', () => {
    // vi_btm is mid-flight opening, but the new target says it should be closed.
    // Chosen behavior (b): scheduler does not add it to any action list; the
    // window will end naturally, the shell will record openSince[v], and on
    // the next resume it will be re-evaluated as a normal close candidate.
    const target = { vi_btm: false, vi_top: true };
    const current = { vi_btm: false, vi_top: false };
    const openSince = { vi_btm: 0, vi_top: 0 };
    const now = 100000;
    const opening = { vi_btm: now + 10000 };
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    // vi_btm: physically still closing→opening, but target says closed. Do
    // nothing — wait for the window to end.
    assert.ok(plan.closeNow.indexOf('vi_btm') === -1);
    assert.ok(plan.startOpening.indexOf('vi_btm') === -1);
    assert.ok(plan.queuedOpens.indexOf('vi_btm') === -1);
    assert.ok(!('vi_btm' in plan.deferredCloses));
    // vi_top can still open — one slot free (2 - 1 live = 1).
    assert.ok(plan.startOpening.indexOf('vi_top') > -1);
    // nextResumeAt includes the opening window of vi_btm.
    assert.strictEqual(plan.nextResumeAt, Math.min(now + 10000, now + VALVE_TIMING.openWindowMs));
    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('case 14: nextResumeAt is the earliest of live opening windows and deferred closes', () => {
    const target = { vi_btm: true, vo_rad: false };
    const current = { vi_btm: false, vo_rad: true };
    // vo_rad was opened very recently; close is deferred. vi_btm will open now.
    const now = 100000;
    const openSince = { vi_btm: 0, vo_rad: now - 10000 }; // open for 10s → ready at now+50000
    const opening = {};
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.ok(plan.startOpening.indexOf('vi_btm') > -1);
    // Expected readyAt for vo_rad: openSince + 60000 = now - 10000 + 60000 = now + 50000
    assert.strictEqual(plan.deferredCloses.vo_rad, now + 50000);
    // Opening window of vi_btm ends at now + 20000. That's earlier than now + 50000.
    assert.strictEqual(plan.nextResumeAt, now + VALVE_TIMING.openWindowMs);
    assertInvariants(plan, { target, current, openSince, opening, now });
  });
});

describe('planValveTransition — US3 min-open hold', () => {
  it('case 5: valve open 10s, needs to close → deferredCloses with readyAt = openSince + 60000', () => {
    const target = { vi_btm: false };
    const current = { vi_btm: true };
    const now = 100000;
    const openSince = { vi_btm: now - 10000 };
    const opening = {};
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.deepStrictEqual(plan.closeNow, []);
    assert.strictEqual(plan.deferredCloses.vi_btm, (now - 10000) + 60000);
    assert.strictEqual(plan.nextResumeAt, (now - 10000) + 60000);
    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('case 6: valve open 70s, needs to close → closeNow', () => {
    const target = { vi_btm: false };
    const current = { vi_btm: true };
    const now = 100000;
    const openSince = { vi_btm: now - 70000 };
    const opening = {};
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.deepStrictEqual(plan.closeNow, ['vi_btm']);
    assert.deepStrictEqual(plan.deferredCloses, {});
    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('case 8: boot recovery — openSince[v]=0, target says closed → closeNow (trivially satisfied)', () => {
    const target = { vi_btm: false };
    const current = { vi_btm: true }; // first iteration after boot before closeAllValves took effect
    const now = 100000;
    const openSince = { vi_btm: 0 }; // R7 boot default
    const opening = {};
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.deepStrictEqual(plan.closeNow, ['vi_btm']);
    assert.deepStrictEqual(plan.deferredCloses, {});
    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('mixed hold: two elders closeNow, youngster deferred, nextResumeAt = youngster.readyAt', () => {
    const target = { vi_btm: false, vi_top: false, vo_coll: false };
    const current = { vi_btm: true, vi_top: true, vo_coll: true };
    const now = 100000;
    const openSince = {
      vi_btm: now - 70000,   // elder
      vi_top: now - 70000,   // elder
      vo_coll: now - 10000   // youngster
    };
    const opening = {};
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.strictEqual(plan.closeNow.length, 2);
    assert.ok(plan.closeNow.indexOf('vi_btm') > -1);
    assert.ok(plan.closeNow.indexOf('vi_top') > -1);
    assert.strictEqual(plan.deferredCloses.vo_coll, (now - 10000) + 60000);
    assert.strictEqual(plan.nextResumeAt, (now - 10000) + 60000);
    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('INV3: no valve in closeNow has (now - openSince) < minOpenMs unless openSince === 0', () => {
    // Run case 6 and confirm INV3 explicitly (already covered by generic
    // assertInvariants but make it loud).
    const target = { vi_btm: false };
    const current = { vi_btm: true };
    const now = 100000;
    const openSince = { vi_btm: now - 70000 };
    const plan = planValveTransition(target, current, openSince, {}, now, VALVE_TIMING);
    for (const v of plan.closeNow) {
      const since = openSince[v] || 0;
      if (since !== 0) {
        assert.ok(now - since >= VALVE_TIMING.minOpenMs);
      }
    }
  });

  it('no-op: target[v] === current[v] does not consume a slot or change openSince', () => {
    const target = { vi_btm: true, vi_top: false };
    const current = { vi_btm: true, vi_top: false };
    const now = 100000;
    const openSince = { vi_btm: now - 30000, vi_top: 0 };
    const opening = {};
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.strictEqual(plan.targetReached, true);
    assert.deepStrictEqual(plan.startOpening, []);
    assert.deepStrictEqual(plan.closeNow, []);
  });

  it('fuzz: 1000 random configurations → invariants hold', () => {
    // Seeded PRNG (mulberry32) for reproducibility.
    let seed = 0x9e3779b9;
    function rnd() {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
    function randBool() { return rnd() > 0.5; }
    function randInt(lo, hi) { return Math.floor(lo + rnd() * (hi - lo)); }
    const cfg = VALVE_TIMING;

    for (let iter = 0; iter < 1000; iter++) {
      const target = {};
      const current = {};
      const openSince = {};
      const opening = {};
      const now = randInt(1000000, 10000000);
      let liveOpenCount = 0;
      for (const n of VALVE_NAMES) {
        target[n] = randBool();
        current[n] = randBool();
        // 50% chance: openSince is boot (0); else now - [0..2*minOpenMs]
        openSince[n] = randBool() ? 0 : now - randInt(0, 2 * cfg.minOpenMs);
        // Up to maxConcurrentOpens valves may be mid-flight (precondition
        // of the scheduler: INV1 in the contract refers to a reachable
        // state, and the shell never commands more than that many to open
        // at once). Past/expired windows are always allowed.
        if (rnd() < 0.35) {
          if (liveOpenCount < cfg.maxConcurrentOpens && rnd() < 0.5) {
            opening[n] = now + randInt(1, cfg.openWindowMs);
            liveOpenCount++;
          } else {
            opening[n] = now - randInt(0, cfg.openWindowMs); // already expired
          }
        }
      }
      const plan = planValveTransition(target, current, openSince, opening, now, cfg);
      assertInvariants(plan, { target, current, openSince, opening, now, cfg });
    }
  });
});

// Integration-style: drive the SCHEDULE loop across simulated time to
// verify the two-batch cadence required by SC-004 and the freeze-drain
// scenario from US4.
function drivePlanLoop(initial) {
  // Simulates exactly what the shell does in resumeTransition/scheduleStep:
  //  1. call planValveTransition(now)
  //  2. record live opening windows for startOpening entries
  //  3. update current to reflect closeNow + startOpening (after window end
  //     for opens, immediately for closes)
  //  4. advance now to plan.nextResumeAt
  //  5. expire any opening windows (write openSince = window end)
  //  6. repeat until plan.targetReached
  // Returns a trace array of {t, startOpening, closeNow, deferredCloses, opening}.
  const target = initial.target;
  const current = Object.assign({}, initial.current);
  const openSince = Object.assign({}, initial.openSince);
  const opening = Object.assign({}, initial.opening || {});
  const cfg = initial.cfg || VALVE_TIMING;
  let now = initial.now;
  const trace = [];
  const maxIters = 50;
  for (let iter = 0; iter < maxIters; iter++) {
    const plan = planValveTransition(target, current, openSince, opening, now, cfg);
    trace.push({
      t: now,
      startOpening: plan.startOpening.slice(),
      closeNow: plan.closeNow.slice(),
      deferredCloses: Object.assign({}, plan.deferredCloses),
      queuedOpens: plan.queuedOpens.slice(),
      opening: Object.assign({}, opening),
      current: Object.assign({}, current),
      targetReached: plan.targetReached,
    });
    if (plan.targetReached) break;
    // Apply closeNow immediately.
    for (const v of plan.closeNow) {
      current[v] = false;
      openSince[v] = 0;
    }
    // Schedule opens: record opening window. (current[v] stays false until
    // the window ends — this mirrors the shell's behavior where the open
    // command is in flight and the physical state flips at window end.)
    for (const v of plan.startOpening) {
      opening[v] = now + cfg.openWindowMs;
    }
    assertInvariants(plan, { target, current: trace[trace.length - 1].current, openSince, opening: trace[trace.length - 1].opening, now });
    // If the scheduler fired immediate actions but set nextResumeAt=null
    // (no future work waiting), the effect of those actions will be seen
    // on the next iteration without advancing the clock. Otherwise, jump
    // to the resume moment.
    if (plan.nextResumeAt !== null) {
      now = plan.nextResumeAt;
    }
    // Expire any opening windows at or before now; record openSince.
    const toExpire = [];
    for (const k in opening) {
      if (opening[k] <= now) toExpire.push(k);
    }
    for (const k of toExpire) {
      const windowEnd = opening[k];
      openSince[k] = windowEnd;
      current[k] = true; // physical state reaches open at window end
      delete opening[k];
    }
  }
  return trace;
}

describe('planValveTransition — SCHEDULE loop integration', () => {
  it('four closed valves all need to open → two batches within 45 s total', () => {
    const trace = drivePlanLoop({
      target: { vi_btm: true, vi_top: true, vo_coll: true, vo_rad: true },
      current: { vi_btm: false, vi_top: false, vo_coll: false, vo_rad: false },
      openSince: { vi_btm: 0, vi_top: 0, vo_coll: 0, vo_rad: 0 },
      opening: {},
      now: 1000000,
    });
    const lastFrame = trace[trace.length - 1];
    assert.strictEqual(lastFrame.targetReached, true, 'target reached');
    const wallClock = lastFrame.t - trace[0].t;
    assert.ok(wallClock <= 45000, `wall clock ${wallClock}ms > 45000ms`);
    assert.ok(wallClock >= 40000, `wall clock ${wallClock}ms < 40000ms (should take 2 × 20s)`);
    // Each frame must honor the slot budget.
    for (const f of trace) {
      let liveOpens = 0;
      for (const k in f.opening) if (f.opening[k] > f.t) liveOpens++;
      assert.ok(liveOpens + f.startOpening.length <= 2, `frame at t=${f.t}: live=${liveOpens} + starting=${f.startOpening.length} > 2`);
    }
    // Every valve ended up open.
    for (const v of ['vi_btm', 'vi_top', 'vo_coll', 'vo_rad']) {
      assert.strictEqual(lastFrame.current[v], true, `${v} not open at end`);
    }
  });

  it('freeze drain from mixed state: elders close immediately, youngsters defer, opens follow 2-at-a-time', () => {
    // Synthetic 3-valve mixed-age starting state (does not correspond to any
    // real mode after spec 024 — SOLAR_CHARGING now has only 2 open valves).
    // The point of this test is the scheduler's elder/youngster behaviour,
    // not the mode invariants. Starting with vi_btm + vo_coll + vo_rad open:
    // vi_btm and vo_coll are elders (open >60s), vo_rad is a youngster.
    // Target is ACTIVE_DRAIN: vi_coll + vo_tank + v_air open.
    const oldOpenSince = 1000000 - 70000; // 70s ago → elders
    const youngOpenSince = 1000000 - 10000; // 10s ago → youngster
    const trace = drivePlanLoop({
      target: {
        vi_btm: false, vi_top: false, vi_coll: true,
        vo_coll: false, vo_rad: false, vo_tank: true,
        v_air: true
      },
      current: {
        vi_btm: true, vi_top: false, vi_coll: false,
        vo_coll: true, vo_rad: true, vo_tank: false,
        v_air: false
      },
      openSince: {
        vi_btm: oldOpenSince, vi_top: 0, vi_coll: 0,
        vo_coll: oldOpenSince, vo_rad: youngOpenSince, vo_tank: 0,
        v_air: 0
      },
      opening: {},
      now: 1000000,
    });
    const lastFrame = trace[trace.length - 1];
    assert.strictEqual(lastFrame.targetReached, true, 'drain transition completed');

    // At no frame was the slot budget exceeded.
    for (const f of trace) {
      let liveOpens = 0;
      for (const k in f.opening) if (f.opening[k] > f.t) liveOpens++;
      assert.ok(liveOpens + f.startOpening.length <= 2);
    }

    // First frame: vi_btm + vo_coll in closeNow (elders), vo_rad in deferredCloses.
    const first = trace[0];
    assert.ok(first.closeNow.indexOf('vi_btm') > -1);
    assert.ok(first.closeNow.indexOf('vo_coll') > -1);
    assert.ok('vo_rad' in first.deferredCloses);
  });
});

describe('planValveTransition — US4 safety drain mix', () => {
  it('case 7: two valves closing with openSince=now-70s, one closing with openSince=now-10s, three opening', () => {
    // Safety override does not add any throttles — the same rules apply.
    // Synthetic target/current — not a real mode, exercises the scheduler's
    // 2-elder + 1-youngster close pattern combined with 3 simultaneous opens.
    const target = {
      vi_btm: false, vi_top: false, vo_rad: false,      // three to close
      vo_coll: true, vo_tank: true, vi_coll: true       // three to open
    };
    const current = {
      vi_btm: true, vi_top: true, vo_rad: true,
      vo_coll: false, vo_tank: false, vi_coll: false
    };
    const now = 200000;
    const openSince = {
      vi_btm: now - 70000,   // elder → closeNow
      vi_top: now - 70000,   // elder → closeNow
      vo_rad: now - 10000,   // youngster → deferredCloses
      vo_coll: 0, vo_tank: 0, vi_coll: 0
    };
    const opening = {};
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);

    assert.strictEqual(plan.closeNow.length, 2);
    assert.ok(plan.closeNow.indexOf('vi_btm') > -1);
    assert.ok(plan.closeNow.indexOf('vi_top') > -1);
    assert.strictEqual(plan.deferredCloses.vo_rad, (now - 10000) + 60000);

    // Slot budget on opens: exactly two this tick.
    assert.strictEqual(plan.startOpening.length, 2);
    assert.strictEqual(plan.queuedOpens.length, 1);

    // nextResumeAt = min(opening window end of two new opens = now+20000,
    //                   deferred close ready = now+50000)
    //              = now + 20000
    assert.strictEqual(plan.nextResumeAt, now + VALVE_TIMING.openWindowMs);

    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('freeze drain: evaluate() returns safetyOverride immediately regardless of mode age', () => {
    // Locks in that evaluate() bypasses min-mode-duration for freeze. The
    // downstream SCHEDULE path still honors physical limits, verified in
    // unit tests above.
    const state = {
      temps: { collector: 0, tank_top: 30, tank_bottom: 20, greenhouse: 15, outdoor: 1 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 1000, // just 1 second ago → would normally be blocked
      now: 1001,
      collectorsDrained: false,
      lastRefillAttempt: 0,
      emergencyHeatingActive: false,
      sensorAge: { collector: 0, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 }
    };
    const result = evaluate(state, null, null);
    assert.strictEqual(result.safetyOverride, true);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });
});

describe('runBoundedPool — bounded parallelism (T050b)', () => {
  it('actuating 8 items with limit=4: never more than 4 in flight', (t, done) => {
    const inFlightHistory = [];
    let inFlight = 0;
    const pending = [];
    const dispatch = (item, cb) => {
      inFlight++;
      inFlightHistory.push(inFlight);
      assert.ok(inFlight <= 4, `inFlight=${inFlight} exceeded limit=4 for item ${item}`);
      // Defer completion to simulate async HTTP.
      pending.push(() => { inFlight--; cb(true); });
    };
    runBoundedPool([1, 2, 3, 4, 5, 6, 7, 8], 4, dispatch, (ok) => {
      assert.strictEqual(ok, true);
      done();
    });
    // Flush pending dispatches in FIFO order.
    function flush() {
      while (pending.length > 0) {
        const step = pending.shift();
        step();
      }
    }
    // Two waves because items 5-8 get dispatched only after items 1-4 complete.
    flush();
    flush();
  });

  it('empty input → callback invoked with true immediately', (t, done) => {
    runBoundedPool([], 4, () => { throw new Error('should not dispatch'); }, (ok) => {
      assert.strictEqual(ok, true);
      done();
    });
  });

  it('one failure → final callback ok=false', (t, done) => {
    const dispatch = (item, cb) => cb(item !== 3);
    runBoundedPool([1, 2, 3, 4], 2, dispatch, (ok) => {
      assert.strictEqual(ok, false);
      done();
    });
  });

  it('synchronous completion: limit=1 acts like sequential execution', (t, done) => {
    const order = [];
    const dispatch = (item, cb) => { order.push(item); cb(true); };
    runBoundedPool([1, 2, 3, 4, 5], 1, dispatch, (ok) => {
      assert.deepStrictEqual(order, [1, 2, 3, 4, 5]);
      done();
    });
  });

  // Regression: 2026-04-20 the live Pro 4PM crashed with
  //   "Too much recursion - the stack is about to overflow"
  // at scheduleStep → runValveBatch → runBoundedPool → drain → dispatch → cb
  // → drain → … when forced-mode ACTIVE_DRAIN was activated from override.
  // Espruino's stack tops out around 20 frames; drain() recursing once per
  // item via a synchronous dispatch callback blows right past that.
  //
  // The pool must tolerate arbitrarily many synchronously-completing items
  // without letting stack depth grow with N. We assert that by capturing
  // the stack height at each dispatch and requiring the spread to stay
  // small no matter how many items run through.
  it('synchronous dispatch does not recurse: stack depth stays bounded across N items', (t, done) => {
    // V8 caps stack traces at 10 frames by default — raise it so we see
    // every frame below the dispatch call.
    const prevLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = Infinity;
    try {
      const N = 500;
      const depths = [];
      const items = [];
      for (let i = 0; i < N; i++) items.push(i);
      const dispatch = (item, cb) => {
        depths.push(new Error().stack.split('\n').length);
        cb(true);
      };
      runBoundedPool(items, 4, dispatch, (ok) => {
        assert.strictEqual(ok, true);
        const minD = Math.min(...depths);
        const maxD = Math.max(...depths);
        // Espruino on Shelly tops out at ~20 frames. A correct pool keeps
        // stack depth flat regardless of N; a recursive drain() grows
        // linearly. Allow minor slack for engine bookkeeping frames.
        assert.ok(
          maxD - minD <= 4,
          'synchronous dispatch must not grow the stack per item; ' +
          'saw min=' + minD + ' max=' + maxD + ' over ' + N + ' items'
        );
        done();
      });
    } finally {
      Error.stackTraceLimit = prevLimit;
    }
  });
});

describe('buildSnapshotFromState — US5 staged-transition fields', () => {
  function baseShellState() {
    return {
      mode: MODES.IDLE,
      mode_start: 0,
      transitioning: false,
      transition_step: null,
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      valve_states: {},
      pump_on: false, fan_on: false, space_heater_on: false, immersion_heater_on: false,
      collectors_drained: false, emergency_heating_active: false,
      valveOpenSince: {}, valveOpening: {},
      valvePendingOpen: [], valvePendingClose: []
    };
  }
  const baseDc = { ce: true, ea: 31, am: null, v: 1 };

  it('idle state: opening/queued_opens/pending_closes are empty', () => {
    const snap = buildSnapshotFromState(baseShellState(), baseDc, 1000000);
    assert.deepStrictEqual(snap.opening, []);
    assert.deepStrictEqual(snap.queued_opens, []);
    assert.deepStrictEqual(snap.pending_closes, []);
  });

  it('mid-transition: two opening, one queued, one pending close', () => {
    const st = baseShellState();
    const now = 1000000;
    st.transitioning = true;
    st.transition_step = 'valves_opening';
    st.valveOpening = { vi_btm: now + 10000, vo_coll: now + 15000 };
    st.valvePendingOpen = ['vi_top'];
    st.valvePendingClose = ['vo_rad'];
    st.valveOpenSince = { vo_rad: now - 30000 }; // open 30s → ready at now+30s
    const snap = buildSnapshotFromState(st, baseDc, now);
    assert.deepStrictEqual(snap.opening.slice().sort(), ['vi_btm', 'vo_coll']);
    assert.deepStrictEqual(snap.queued_opens, ['vi_top']);
    assert.strictEqual(snap.pending_closes.length, 1);
    assert.strictEqual(snap.pending_closes[0].valve, 'vo_rad');
    // readyAt is unix seconds.
    assert.strictEqual(snap.pending_closes[0].readyAt, Math.floor((now - 30000 + 60000) / 1000));
  });

  it('expired opening entries are excluded from opening[]', () => {
    const st = baseShellState();
    const now = 1000000;
    st.valveOpening = { vi_btm: now - 100 }; // expired
    const snap = buildSnapshotFromState(st, baseDc, now);
    assert.deepStrictEqual(snap.opening, []);
  });

  it('preserves existing snapshot fields (ts, mode, valves, actuators)', () => {
    const st = baseShellState();
    st.mode = MODES.SOLAR_CHARGING;
    st.valve_states = { vi_btm: true, vo_coll: true };
    st.pump_on = true;
    const snap = buildSnapshotFromState(st, baseDc, 1234567);
    assert.strictEqual(snap.ts, 1234567);
    assert.strictEqual(snap.mode, 'solar_charging');
    assert.strictEqual(snap.valves.vi_btm, true);
    assert.strictEqual(snap.valves.vo_coll, true);
    assert.strictEqual(snap.valves.vi_top, false);
    assert.strictEqual(snap.actuators.pump, true);
  });
});

describe('evaluate() emits a decision reason for each path', () => {
  function evalWith(overrides) {
    return evaluate(makeState(overrides), null);
  }

  it('solar_enter when collector crosses tank_bottom + solarEnterDelta', () => {
    const r = evalWith({
      temps: { collector: 36, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 }
    });
    assert.strictEqual(r.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(r.reason, 'solar_enter');
  });

  it('solar_active while mean tank is still gaining heat', () => {
    // Mean = (42+40)/2 = 41 > carried peak of 40 — gaining.
    const r = evalWith({
      temps: { collector: 50, tank_top: 42, tank_bottom: 40, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      solarChargePeakTankAvg: 40, solarChargePeakTankAvgAt: 1500, now: 2000
    });
    assert.strictEqual(r.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(r.reason, 'solar_active');
  });

  it('solar_stall when mean tank has not risen for solarExitStallSeconds', () => {
    // Mean equals peak (40), peakAt 300 s ago. Collector 5 K above
    // tank_top so the much-hotter-collector bypass does not suppress.
    const r = evalWith({
      temps: { collector: 45, tank_top: 40, tank_bottom: 40, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      solarChargePeakTankAvg: 40, solarChargePeakTankAvgAt: 1700, now: 2000
    });
    assert.strictEqual(r.nextMode, MODES.IDLE);
    assert.strictEqual(r.reason, 'solar_stall');
  });

  it('solar_drop_from_peak when mean tank falls solarExitTankDrop below peak', () => {
    // Mean = 38, peak 40 — dropped 2 °C.
    const r = evalWith({
      temps: { collector: 50, tank_top: 38, tank_bottom: 38, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      solarChargePeakTankAvg: 40, solarChargePeakTankAvgAt: 1900, now: 2000
    });
    assert.strictEqual(r.nextMode, MODES.IDLE);
    assert.strictEqual(r.reason, 'solar_drop_from_peak');
  });

  it('freeze_drain when coldest sensor drops below freezeDrainTemp', () => {
    const r = evalWith({
      temps: { collector: -1, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 5 }
    });
    assert.strictEqual(r.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(r.reason, 'freeze_drain');
    assert.strictEqual(r.safetyOverride, true);
  });

  it('overheat_drain when collector > overheatDrainTemp during SOLAR_CHARGING', () => {
    const r = evalWith({
      temps: { collector: 96, tank_top: 90, tank_bottom: 80, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 100000
    });
    assert.strictEqual(r.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(r.reason, 'overheat_drain');
  });

  it('overheat_circulate forces SOLAR_CHARGING when collector is dangerously hot but solar entry did not fire', () => {
    // tank_bottom already near boiling leaves the entry delta unsatisfied
    // (96 is not > 95 + 5). The overheat_circulate override still fires so
    // the pump dumps heat rather than letting the collector boil.
    const r = evalWith({
      temps: { collector: 96, tank_top: 90, tank_bottom: 95, greenhouse: 15, outdoor: 10 }
    });
    assert.strictEqual(r.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(r.reason, 'overheat_circulate');
  });

  it('greenhouse_enter when greenhouse is cold and tank has delta', () => {
    const r = evalWith({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 9, outdoor: 10 }
    });
    assert.strictEqual(r.nextMode, MODES.GREENHOUSE_HEATING);
    assert.strictEqual(r.reason, 'greenhouse_enter');
  });

  it('greenhouse_active while in GH and not yet at exit', () => {
    const r = evalWith({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 11, outdoor: 10 },
      currentMode: MODES.GREENHOUSE_HEATING,
      modeEnteredAt: 0, now: 2000
    });
    assert.strictEqual(r.nextMode, MODES.GREENHOUSE_HEATING);
    assert.strictEqual(r.reason, 'greenhouse_active');
  });

  it('greenhouse_warm when greenhouse crosses exit temp', () => {
    const r = evalWith({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 13, outdoor: 10 },
      currentMode: MODES.GREENHOUSE_HEATING,
      modeEnteredAt: 0, now: 2000
    });
    assert.strictEqual(r.nextMode, MODES.IDLE);
    assert.strictEqual(r.reason, 'greenhouse_warm');
  });

  it('greenhouse_tank_depleted when tank drops below greenhouse + exit delta', () => {
    const r = evalWith({
      temps: { collector: 5, tank_top: 12, tank_bottom: 10, greenhouse: 11, outdoor: 10 },
      currentMode: MODES.GREENHOUSE_HEATING,
      modeEnteredAt: 0, now: 2000,
      collectorsDrained: true
    });
    assert.strictEqual(r.nextMode, MODES.IDLE);
    assert.strictEqual(r.reason, 'greenhouse_tank_depleted');
  });

  it('emergency_enter when greenhouse is critically cold and pump mode is IDLE', () => {
    const r = evalWith({
      temps: { collector: 5, tank_top: 12, tank_bottom: 10, greenhouse: 8, outdoor: -5 },
      collectorsDrained: true
    });
    assert.strictEqual(r.nextMode, MODES.EMERGENCY_HEATING);
    assert.strictEqual(r.reason, 'emergency_enter');
  });

  it('sensor_stale forces IDLE with reason sensor_stale', () => {
    const r = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      sensorAge: { collector: 999, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 }
    }), null);
    assert.strictEqual(r.nextMode, MODES.IDLE);
    assert.strictEqual(r.reason, 'sensor_stale');
  });

  it('min_duration when a non-IDLE mode is within its hold window', () => {
    // 30s into a SOLAR_CHARGING session, min duration is 300s → hold.
    const r = evalWith({
      temps: { collector: 50, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 1970, now: 2000,
      solarChargePeakTankAvg: 40, solarChargePeakTankAvgAt: 1970
    });
    assert.strictEqual(r.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(r.reason, 'min_duration');
  });

  it('drain_running while still inside an ACTIVE_DRAIN', () => {
    const r = evalWith({
      temps: { collector: 5, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 5 },
      currentMode: MODES.ACTIVE_DRAIN,
      modeEnteredAt: 1900, now: 2000
    });
    assert.strictEqual(r.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(r.reason, 'drain_running');
  });

  it('mode_disabled when evaluator chose a mode the user has permanently banned', () => {
    // Sentinel 9999999999 — set by the user via the device-config UI to
    // permanently disable a mode. Distinct from a watchdog cool-off.
    const dc = { ce: true, wb: { SC: 9999999999 } };
    const r = evaluate(makeState({
      temps: { collector: 50, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 }
    }), null, dc);
    assert.strictEqual(r.nextMode, MODES.IDLE);
    assert.strictEqual(r.reason, 'mode_disabled');
  });

  it('watchdog_ban when evaluator chose a mode under a watchdog cool-off', () => {
    // wb entry that is not the permanent sentinel — the 4-hour cool-off
    // applied after a watchdog firing.
    const dc = { ce: true, wb: { SC: 1000000 + 3600 } };
    const r = evaluate(makeState({
      temps: { collector: 50, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      now: 1000000
    }), null, dc);
    assert.strictEqual(r.nextMode, MODES.IDLE);
    assert.strictEqual(r.reason, 'watchdog_ban');
  });

  it('emergency-disabled with depleted tank reports the natural reason, not watchdog_ban', () => {
    // Reproduces the 2026-04-28 04:54 field log: in GH, greenhouse drops
    // below the emergency-enter threshold (so emergencyHeatingActive
    // would flip on), tank is too cool to heat the greenhouse, and EH
    // is permanently disabled by the user. The transition to IDLE is
    // correct — but the reason must surface the actual cause
    // (greenhouse_tank_depleted), not "mode blocked by watchdog".
    const dc = { ce: true, wb: { EH: 9999999999 } };
    const r = evaluate(makeState({
      temps: { collector: -3.9, tank_top: 10.2, tank_bottom: 9.5, greenhouse: 8.3, outdoor: 0.8 },
      currentMode: MODES.GREENHOUSE_HEATING,
      modeEnteredAt: 0,
      now: 100000,
      collectorsDrained: true
    }), null, dc);
    assert.strictEqual(r.nextMode, MODES.IDLE);
    assert.strictEqual(r.reason, 'greenhouse_tank_depleted');
  });

  it('emergency-disabled with no other trigger falls through to idle reason', () => {
    // Greenhouse cold (would activate emergency) but tank can't heat it
    // and we are not currently in GH. Without the EH disable the
    // evaluator would return EMERGENCY_HEATING. With it, the natural
    // result is IDLE with reason "idle" — not "watchdog_ban".
    const dc = { ce: true, wb: { EH: 9999999999 } };
    const r = evaluate(makeState({
      temps: { collector: 5, tank_top: 10, tank_bottom: 9, greenhouse: 8, outdoor: 5 },
      collectorsDrained: true
    }), null, dc);
    assert.strictEqual(r.nextMode, MODES.IDLE);
    assert.strictEqual(r.reason, 'idle');
  });

  it('idle when no trigger is active', () => {
    const r = evalWith({});
    assert.strictEqual(r.nextMode, MODES.IDLE);
    assert.strictEqual(r.reason, 'idle');
  });
});

describe('buildSnapshotFromState exposes reason alongside cause', () => {
  function baseState() {
    return {
      mode: MODES.IDLE, mode_start: 0, transitioning: false, transition_step: null,
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      valve_states: {}, pump_on: false, fan_on: false, space_heater_on: false, immersion_heater_on: false,
      collectors_drained: false, emergency_heating_active: false,
      valveOpening: {}, valveOpenSince: {}, valvePendingOpen: [], valvePendingClose: [],
    };
  }
  const dc = { ce: true, mo: null };

  it('publishes null reason when lastTransitionReason is unset', () => {
    const st = baseState();
    st.lastTransitionCause = 'boot';
    const snap = buildSnapshotFromState(st, dc, 123);
    assert.strictEqual(snap.cause, 'boot');
    assert.strictEqual(snap.reason, null);
  });

  it('publishes the stashed reason', () => {
    const st = baseState();
    st.lastTransitionCause = 'automation';
    st.lastTransitionReason = 'solar_stall';
    const snap = buildSnapshotFromState(st, dc, 123);
    assert.strictEqual(snap.cause, 'automation');
    assert.strictEqual(snap.reason, 'solar_stall');
  });
});

describe('v_air has no polarity inversion (physical valve is normally-closed like every other valve)', () => {
  it('logical open/close maps 1:1 to scheduler open/close for every valve including v_air', () => {
    // There is no polarity helper anymore: the scheduler view == the logical
    // view. A failing assertion here means an inversion sneaked back in.
    const logical = {
      vi_btm: true, vi_top: false, vi_coll: true, vo_coll: false,
      vo_rad: true, vo_tank: false, v_air: true
    };
    assert.strictEqual(typeof require('../shelly/control-logic').toSchedulerView, 'undefined');
    assert.strictEqual(typeof require('../shelly/control-logic').fromSchedulerView, 'undefined');
    // The logical map is the canonical form — no wrapper is needed.
    assert.strictEqual(logical.v_air, true);
  });
});
