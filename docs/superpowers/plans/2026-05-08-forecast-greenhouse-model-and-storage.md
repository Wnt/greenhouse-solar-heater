# Forecast greenhouse-model fix + multi-horizon prediction storage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two greenhouse-temperature projection bugs (no solar absorption, cooling τ too slow, no vent saturation) and rewrite `forecast_predictions` storage to keep one row per `(generated_at, horizon_h)` so all 48 forecast horizons are auditable against ground truth.

**Architecture:** A single per-hour heat-balance equation replaces the four hand-tuned greenhouse-temp updates in `sustain-forecast.js`. Four new fitted coefficients (τ_gh, α_solar, vent_open_c, τ_vent) live in `sustain-forecast-fit.js` with safe defaults. The engine emits a parallel `componentTrajectory` array exposing the per-step inputs (predicted solar gain, radiator output, heater duty, tank loss, cloud factor). `forecast-predictions.js` is rewritten to capture all 48 horizon rows per HH:30 generation in one multi-row INSERT, with the schema gated to drop-and-recreate the legacy single-PK table.

**Tech Stack:** Node.js (ES5 in `shelly/`, ES6+ in `server/`), TimescaleDB (Postgres), `pg` driver, `node:test` runner. No new npm deps.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `server/lib/forecast/sustain-forecast.js` | modify | Replace per-branch GH update with unified heat balance; emit `componentTrajectory` |
| `server/lib/forecast/sustain-forecast-fit.js` | modify | New fit functions for τ_gh, α_solar, vent params; per-coefficient `usedDefaults` map |
| `server/lib/forecast/forecast-predictions.js` | modify | `buildRow` → `buildRows` (returns 48); multi-row INSERT; `listRecent` filters `horizon_h = 1` |
| `server/lib/db-schema.js` | modify | Gated DROP of legacy table; new schema with `(generated_at, horizon_h)` PK |
| `tests/sustain-forecast.test.js` | modify | Existing GH-evolution assertions updated; new heat-balance regression tests |
| `tests/forecast-predictions.test.js` | modify | Capture writes 48 rows; multi-row INSERT shape; `listRecent` filter |
| `tests/db.test.js` | modify | Schema migration test (legacy → new shape) |

No frontend changes. No new files apart from optional `tests/sustain-forecast-gh-model.test.js` (folded into the existing `sustain-forecast.test.js` to keep the test corpus flat).

---

## Conventions

- Run all `node:test` specs via `node --test tests/<file>.test.js`. Run `npm run test:unit` for the full suite.
- Commit messages: `engine: …`, `forecast: …`, `db: …` per the repo's recent-commit style.
- ES5 only inside `shelly/` (we don't touch shelly here, but keep server-side code in the same simple `function`-style as existing forecast modules — no class/extends, callbacks not promises, matching the surrounding codebase).
- Frequent commits — one per task minimum.

---

### Task 1: Add the four new GH-model defaults to `DEFAULT_CONFIG`

Establishes the baseline values the engine uses before any fit converges. Pure additive — no behavior change yet because the engine still uses the old `idle`-branch lerp.

**Files:**
- Modify: `server/lib/forecast/sustain-forecast.js:31-77`

- [ ] **Step 1: Add the four config keys**

In `DEFAULT_CONFIG` (around line 31), insert after `greenhouseLossWPerK: 120,`:

```js
  // Greenhouse-air heat balance (used in the unified per-hour update,
  // active across all simulated modes — replaces the τ=8 h outdoor lerp
  // that ignored solar gain and let the simulation hover near outdoor
  // temperature even on bright days). All four values are normally
  // overridden by sustain-forecast-fit; the defaults here keep the
  // engine sane on cold start.
  ghTimeConstantH:          2.0,   // passive cooling τ (hours), gh<vent
  ghSolarAlphaCPerWm2:      0.025, // °C rise per W/m² of radiation
  ghVentOpenC:              27,    // gravity vents engage above this
  ghVentTauH:               0.3,   // cooling τ once vents open
```

- [ ] **Step 2: Verify the test suite still passes (no behavior change yet)**

```bash
timeout 30 node --test tests/sustain-forecast.test.js
```

Expected: all tests still pass — the new keys are unused.

- [ ] **Step 3: Commit**

```bash
git add server/lib/forecast/sustain-forecast.js
git commit -m "engine: seed GH heat-balance config defaults"
```

---

### Task 2: Add a failing regression test — sunny day raises GH temp

Tests bug 2 (no solar absorption). Will fail because the current engine ignores radiation in the GH update.

**Files:**
- Modify: `tests/sustain-forecast.test.js`

- [ ] **Step 1: Append the new describe block**

Add at the end of `tests/sustain-forecast.test.js`, before the final `});` if any wraps everything (otherwise just append at file end):

```js
describe('greenhouse heat balance — solar absorption', () => {
  it('predicted GH temp rises above outdoor on a sunny day', () => {
    // Sunny noon: outdoor 15 °C, ramp radiation 0 → 700 W/m² over the
    // first 6 hours, hold flat. Tank starts cold so no heating overlay
    // muddies the GH curve.
    const now = Date.UTC(2026, 5, 1, 6, 0, 0); // Helsinki noon (UTC+3)
    const weather = [];
    for (let h = 0; h < 48; h++) {
      const ts = new Date(now + h * 3600 * 1000).toISOString();
      const rad = h < 6 ? Math.min(700, 100 * h)
                : h < 12 ? 700
                : h < 18 ? Math.max(0, 700 - 100 * (h - 12))
                : 0;
      weather.push({ ts, temperature: 15, radiationGlobal: rad, windSpeed: 1, precipitation: 0 });
    }
    const prices = weather.map(w => ({ ts: w.ts, priceCKwh: 5 }));

    const { computeSustainForecast } = require('../server/lib/forecast/sustain-forecast');
    const fc = computeSustainForecast({
      now,
      tankTop: 14, tankBottom: 13,
      greenhouseTemp: 15,
      currentMode: 'idle',
      weather48h: weather, prices48h: prices,
      coefficients: { tankLeakageWPerK: 3, solarGainKwhByHour: new Array(24).fill(0) },
      config: {},
    });
    const peakGh = Math.max.apply(null, fc.greenhouseTrajectory.map(p => p.temp));
    assert.ok(peakGh >= 25, 'expected GH peak ≥ 25 °C from solar gain, got ' + peakGh);
  });
});
```

- [ ] **Step 2: Run it — confirm it fails**

```bash
timeout 30 node --test tests/sustain-forecast.test.js 2>&1 | grep -E "fail|expected GH peak"
```

Expected: a failure showing `peakGh` ≈ 15 °C (current engine just hugs outdoor).

- [ ] **Step 3: Commit (red test)**

```bash
git add tests/sustain-forecast.test.js
git commit -m "test: GH must rise above outdoor on a sunny day (currently fails)"
```

---

### Task 3: Add a failing regression test — cold outdoor triggers heating

Tests bug 1 (cooling τ too slow). With τ=8 h the model never crosses geT.

**Files:**
- Modify: `tests/sustain-forecast.test.js`

- [ ] **Step 1: Append the test**

Inside the `describe('greenhouse heat balance ...')` block, add:

```js
  it('cold overnight triggers greenhouse_heating within 4 h', () => {
    // GH starts at 18 °C, outdoor steady at 5 °C, no sun. With the
    // realistic τ ≈ 2 h the GH should drop below the heating threshold
    // (geT default 10) within 4 h, which the simulation must surface
    // as a greenhouse_heating mode entry.
    const now = Date.UTC(2026, 5, 1, 18, 0, 0);
    const weather = []; const prices = [];
    for (let h = 0; h < 48; h++) {
      const ts = new Date(now + h * 3600 * 1000).toISOString();
      weather.push({ ts, temperature: 5, radiationGlobal: 0, windSpeed: 1, precipitation: 0 });
      prices.push({ ts, priceCKwh: 5 });
    }
    const { computeSustainForecast } = require('../server/lib/forecast/sustain-forecast');
    const fc = computeSustainForecast({
      now,
      tankTop: 35, tankBottom: 30, greenhouseTemp: 18,
      currentMode: 'idle',
      weather48h: weather, prices48h: prices,
      coefficients: { tankLeakageWPerK: 3, solarGainKwhByHour: new Array(24).fill(0) },
      config: {},
    });
    const firstHeating = fc.modeForecast.findIndex(m => m.mode === 'greenhouse_heating');
    assert.ok(firstHeating >= 0 && firstHeating <= 4,
      'expected greenhouse_heating within 4 h, first entry at hour ' + firstHeating);
  });
```

- [ ] **Step 2: Run it — confirm it fails**

```bash
timeout 30 node --test tests/sustain-forecast.test.js 2>&1 | grep -E "fail|first entry"
```

Expected: `firstHeating` is far past 4 (current τ=8 h means GH=18 → 10 takes ~12 h).

- [ ] **Step 3: Commit (red test)**

```bash
git add tests/sustain-forecast.test.js
git commit -m "test: cold outdoor must trigger heating within 4 h (currently fails)"
```

---

### Task 4: Add a failing regression test — vent cap saturates GH

Models the gravity vents that cap actual greenhouse around 33 °C.

**Files:**
- Modify: `tests/sustain-forecast.test.js`

- [ ] **Step 1: Append the test**

```js
  it('vent saturation holds GH below 35 °C even at 700 W/m² + outdoor 25 °C', () => {
    // Worst-case summer: hot outdoor + full sun. The new vent term
    // must keep the prediction realistic — without it the heat-balance
    // would diverge to ~50 °C.
    const now = Date.UTC(2026, 6, 1, 9, 0, 0);
    const weather = []; const prices = [];
    for (let h = 0; h < 48; h++) {
      const ts = new Date(now + h * 3600 * 1000).toISOString();
      weather.push({ ts, temperature: 25, radiationGlobal: 700, windSpeed: 1, precipitation: 0 });
      prices.push({ ts, priceCKwh: 5 });
    }
    const { computeSustainForecast } = require('../server/lib/forecast/sustain-forecast');
    const fc = computeSustainForecast({
      now,
      tankTop: 40, tankBottom: 35, greenhouseTemp: 25,
      currentMode: 'idle',
      weather48h: weather, prices48h: prices,
      coefficients: { tankLeakageWPerK: 3, solarGainKwhByHour: new Array(24).fill(0) },
      config: {},
    });
    const peakGh = Math.max.apply(null, fc.greenhouseTrajectory.map(p => p.temp));
    assert.ok(peakGh <= 35, 'vent cap must hold GH below 35 °C; got ' + peakGh);
    assert.ok(peakGh >= 28, 'expected non-trivial solar warming; got ' + peakGh);
  });
```

- [ ] **Step 2: Run it — confirm it fails**

```bash
timeout 30 node --test tests/sustain-forecast.test.js 2>&1 | grep -E "fail|vent cap"
```

Expected: fails because no vent term exists yet (peak = 25 since current model hugs outdoor).

- [ ] **Step 3: Commit (red test)**

```bash
git add tests/sustain-forecast.test.js
git commit -m "test: vent saturation must cap GH below 35 °C (currently fails)"
```

---

### Task 5: Implement the unified GH heat balance

The core algorithm change. Replace per-branch `newGhTemp` updates with one heat-balance equation applied per hour after mode-specific tank/heater work. The heating-mode branches still use their existing radiator/heater logic for the tank side; the GH update is unified.

**Files:**
- Modify: `server/lib/forecast/sustain-forecast.js:230-413` (the main per-hour loop body)

- [ ] **Step 1: Refactor the per-hour GH update**

Replace the per-branch `newGhTemp` writes inside the simulation loop. Strategy: each branch still computes its own `tankDeltaJ` (radiator/heater/leakage), but `newGhTemp` is computed once after the mode block using the unified heat balance.

In `sustain-forecast.js`, locate the simulation loop body (`for (let h = 0; h < HOURS; h++) { ... }`). Restructure so each mode branch sets two new locals — `radHeatToGhW` (W delivered to GH air by radiator this hour, 0 if no heating) and `heaterHeatToGhW` (heater W contribution, 0 if not active) — instead of writing `newGhTemp`. Then a single block after the if/elif chain runs the heat balance:

```js
    // ── Unified greenhouse heat balance (every mode, every hour) ──
    // dT/dt = (outdoor − gh)/τ_gh                ← passive loss
    //       + α_solar · radiation                ← solar absorption
    //       − max(0, gh − vent_open)/τ_vent      ← gravity-vent saturation
    //       + (radHeat + heaterHeat) / C_gh      ← active mode contribution
    //
    // C_gh is a lumped greenhouse air+soil capacity. greenhouseLossWPerK
    // already encodes the same lumped system, so we reuse it: passive
    // τ_gh is enforced explicitly via the time constant, and the active
    // term converts power → temp via 1/(greenhouseLossWPerK·τ_gh) which
    // is the same lumped capacity inverted. Practical effect: when the
    // radiator delivers exactly greenhouseLossWPerK·(gh − outdoor) the
    // GH temp stays put — same equilibrium the device exhibits.

    const ghPassive  = (outdoorC - curGhTemp) / cfg.ghTimeConstantH;
    const ghSolar    = cfg.ghSolarAlphaCPerWm2 * radiation;
    const ghVent     = curGhTemp > cfg.ghVentOpenC
      ? -(curGhTemp - cfg.ghVentOpenC) / cfg.ghVentTauH : 0;
    const ghCapacityWPerK = cfg.greenhouseLossWPerK * cfg.ghTimeConstantH * 3600 / 3600; // = greenhouseLossWPerK·τ (W·h/K)
    const ghActive   = ghCapacityWPerK > 0
      ? (radHeatToGhW + heaterHeatToGhW) / ghCapacityWPerK : 0;
    newGhTemp = curGhTemp + ghPassive + ghSolar + ghVent + ghActive;
```

Replace each existing branch's `newGhTemp` assignment with `radHeatToGhW` / `heaterHeatToGhW` declarations. The `idle` branch keeps `radHeatToGhW = 0; heaterHeatToGhW = 0;`. The `greenhouse_heating` branch sets `radHeatToGhW = radDeliveredW;` and the existing `greenhouseHeatingHours += 1;` etc. stay. The `emergency_heating` branch sets `radHeatToGhW = radDeliveredW; heaterHeatToGhW = heaterDuty * heaterW;` and removes the `if (heaterDuty > 0) newGhTemp = ghTarget; else { …ghEq lerp… }` block — the unified heat balance handles convergence.

Concretely:

In `sustain-forecast.js`, inside the per-hour loop, declare at the top of the body:

```js
    let radHeatToGhW = 0;
    let heaterHeatToGhW = 0;
```

In the `greenhouse_heating` branch (around line 276), replace lines that compute `newGhTemp` with `radHeatToGhW = radDeliveredW;`. Specifically, delete:

```js
      // Greenhouse evolution: when the radiator's delivered W matches the
      // greenhouse's loss to outdoor, gh stays roughly stable...
      const radEffectiveness = radPeakW > 0 ? Math.min(1, radDeliveredW / radPeakW) : 0;
      const observedGhKpH = (observedGhDropKPerH !== null && currentMode === 'greenhouse_heating' && h < 6)
        ? observedGhDropKPerH : 0.2;
      const naturalCoolKpH = (curGhTemp - outdoorC) / 8;
      const ghDropKpH = radEffectiveness * observedGhKpH + (1 - radEffectiveness) * naturalCoolKpH;
      newGhTemp = curGhTemp - ghDropKpH;
```

…and replace with:

```js
      radHeatToGhW = radDeliveredW;
```

In the `emergency_heating` branch, delete:

```js
      if (heaterDuty > 0) {
        newGhTemp = ghTarget;
      } else {
        const ghEq = cfg.greenhouseLossWPerK > 0
          ? outdoorC + radDeliveredW / cfg.greenhouseLossWPerK
          : ghTarget;
        newGhTemp = curGhTemp + (ghEq - curGhTemp) * (1 - Math.exp(-1 / 8));
      }
```

…and replace with:

```js
      radHeatToGhW = radDeliveredW;
      heaterHeatToGhW = heaterDuty * heaterW;
```

In the `idle` branch (the final `else`), delete:

```js
    } else {
      // Idle.
      const tankLossW = tankLeakageWPerK * Math.max(0, tankAvg - curGhTemp);
      tankDeltaJ -= tankLossW * SECONDS_PER_HOUR;
      // Greenhouse drifts toward outdoor with τ = 8 h.
      newGhTemp = curGhTemp + (outdoorC - curGhTemp) * (1 - Math.exp(-1 / 8));
    }
```

…and replace with:

```js
    } else {
      // Idle: only tank leakage on the tank side; GH update happens in
      // the unified heat balance below.
      const tankLossW = tankLeakageWPerK * Math.max(0, tankAvg - curGhTemp);
      tankDeltaJ -= tankLossW * SECONDS_PER_HOUR;
    }
```

Then immediately after the if/else chain (still inside the loop, before `// ── 3. Solar charging credit ──`), insert the unified heat-balance block from above.

- [ ] **Step 2: Drop the now-stale clamp**

The "GH can't go below outdoor" line (around 404):

```js
    // Clamp: greenhouse can't go below outdoor (passive equilibrium).
    if (curGhTemp < outdoorC) curGhTemp = outdoorC;
```

Keep as defence-in-depth — passive term can't push gh below outdoor mathematically, but a faulty fit could. Comment update:

```js
    // Hard floor at outdoor: the heat balance can't drive GH below
    // outdoor mathematically, but a misfit α_solar < 0 could; clamp.
    if (curGhTemp < outdoorC) curGhTemp = outdoorC;
```

- [ ] **Step 3: Run the three failing tests — confirm they pass**

```bash
timeout 30 node --test tests/sustain-forecast.test.js 2>&1 | tail -30
```

Expected: all three new tests pass; older tests may now fail because the GH dynamics changed shape — that is OK and addressed in Task 6.

- [ ] **Step 4: Commit (green tests for the new behavior)**

```bash
git add server/lib/forecast/sustain-forecast.js
git commit -m "engine: unified greenhouse heat balance (passive, solar, vent, active)"
```

---

### Task 6: Update legacy GH-trajectory tests for the new model

Existing assertions in `tests/sustain-forecast.test.js` were calibrated to the old τ=8 h, no-solar model. With the new heat balance, GH temperatures and the `firstHeating` index will shift. Tests that asserted exact temperature numbers need recalibration; tests that asserted high-level invariants (mode-decision ordering, hoursUntilFloor, etc.) should still pass.

**Files:**
- Modify: `tests/sustain-forecast.test.js` (existing tests only)

- [ ] **Step 1: Identify failing tests**

```bash
timeout 30 node --test tests/sustain-forecast.test.js 2>&1 | grep -E "^not ok|fail" | head -20
```

- [ ] **Step 2: For each failing test, decide**

For each failure decide:
1. **The test's invariant is still meaningful with new dynamics.** Adjust the numeric expectation (e.g. `assert.ok(gh > 12)` → `assert.ok(gh > 10)` if the new model cools faster). Add a one-line comment noting why the threshold shifted.
2. **The test asserted an artefact of the old model** (e.g. "GH stays at 18 °C for 6 h" — only true under τ=8). Rewrite it as the corresponding invariant under the new model (e.g. "GH cools monotonically toward outdoor + solar floor").
3. **The test is unrelated to GH dynamics** (tank floor, mode hysteresis, cost computation). Should still pass — investigate if it doesn't.

Do NOT loosen assertions to "anything passes". Each adjusted assertion should still fail if the new model regressed.

- [ ] **Step 3: Run the suite**

```bash
timeout 30 node --test tests/sustain-forecast.test.js
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add tests/sustain-forecast.test.js
git commit -m "test: recalibrate GH trajectory expectations for unified heat balance"
```

---

### Task 7: Add τ_gh and α_solar fitters in `sustain-forecast-fit.js`

Empirical fits replace the hardcoded defaults once enough history exists. Pure functions, no I/O.

**Files:**
- Modify: `server/lib/forecast/sustain-forecast-fit.js`

- [ ] **Step 1: Add `fitGhTimeConstantH`**

After `fitGreenhouseLossWPerK` (around line 267), insert:

```js
/**
 * Fit passive greenhouse cooling τ from idle, no-radiation history.
 *
 * Energy balance during idle/no-sun:  d(gh)/dt = (outdoor − gh) / τ_gh.
 * Regress -d(gh)/dt against (gh − outdoor) over clean idle hours where
 * radiation < 30 W/m² and no heating mode fires; the slope's reciprocal
 * is τ_gh. Falls back to null when fewer than MIN_BUCKETS_FOR_FIT clean
 * pairs are available — caller falls through to the engine default.
 *
 * @param {object} history { readings, modes }
 * @returns {number|null} τ in hours, or null on insufficient data
 */
function fitGhTimeConstantH(history) {
  if (!history || !Array.isArray(history.readings) || history.readings.length < 2 ||
      !Array.isArray(history.modes)) return null;
  const readings = history.readings;
  const modes    = history.modes;
  const modeLabels = labelModes(readings, modes);

  const xs = []; const ys = [];
  for (let i = 0; i < readings.length - 1; i++) {
    if (modeLabels[i] !== 'idle') continue;
    const r0 = readings[i]; const r1 = readings[i + 1];
    const t0 = r0.ts instanceof Date ? r0.ts.getTime() : Number(r0.ts);
    const t1 = r1.ts instanceof Date ? r1.ts.getTime() : Number(r1.ts);
    const dtH = (t1 - t0) / 3600000;
    if (dtH <= 0 || dtH > 0.25) continue;
    if (typeof r0.greenhouse !== 'number' || typeof r0.outdoor !== 'number' ||
        typeof r1.greenhouse !== 'number') continue;
    if (typeof r0.radiationGlobal === 'number' && r0.radiationGlobal > 30) continue;
    const ghDelta = r1.greenhouse - r0.greenhouse;
    const dT = r0.greenhouse - r0.outdoor;
    if (dT <= 1) continue;
    xs.push(dT);
    ys.push(-ghDelta / dtH);
  }
  if (xs.length < MIN_BUCKETS_FOR_FIT) return null;
  const slope = slopeThruOrigin(xs, ys);
  if (slope === null || slope <= 0) return null;
  return 1 / slope;
}
```

- [ ] **Step 2: Add `fitGhSolarAlphaCPerWm2`**

```js
/**
 * Fit greenhouse solar absorption α from sunny daytime history.
 *
 * Steady-state daytime when no heating active and vents not yet open:
 *   gh − outdoor ≈ α_solar · radiation · τ_gh
 * so α_solar = slope of (gh − outdoor) / radiation, divided by τ_gh.
 * Vents masked off (gh < ventOpenC) to keep the fit linear.
 *
 * @param {object} history
 * @param {number} tauGhH τ_gh from fitGhTimeConstantH (hours)
 * @param {number} ventOpenC vent threshold (°C)
 * @returns {number|null}
 */
function fitGhSolarAlphaCPerWm2(history, tauGhH, ventOpenC) {
  if (!history || !Array.isArray(history.readings) || history.readings.length < 2 ||
      !Array.isArray(history.modes) || !(tauGhH > 0)) return null;
  const readings = history.readings;
  const modes    = history.modes;
  const modeLabels = labelModes(readings, modes);

  const xs = []; const ys = [];
  for (let i = 0; i < readings.length; i++) {
    if (modeLabels[i] === 'greenhouse_heating' || modeLabels[i] === 'emergency_heating') continue;
    const r = readings[i];
    if (typeof r.greenhouse !== 'number' || typeof r.outdoor !== 'number' ||
        typeof r.radiationGlobal !== 'number') continue;
    if (r.radiationGlobal < 100) continue;
    if (r.greenhouse > ventOpenC) continue;       // vents masked off
    xs.push(r.radiationGlobal);
    ys.push(r.greenhouse - r.outdoor);
  }
  if (xs.length < MIN_BUCKETS_FOR_FIT) return null;
  const slope = slopeThruOrigin(xs, ys);
  if (slope === null || slope <= 0) return null;
  return slope / tauGhH;
}
```

- [ ] **Step 3: Add the shared mode-labeller helper**

The two new fitters and `fitGreenhouseLossWPerK` all duplicate the forward-walking mode cursor pattern. Extract once. Above the new functions:

```js
// Shared mode-labeller: returns one mode string per reading by
// forward-walking the modes array. Was duplicated in three fit
// functions — kept inline there pre-2026-05-08 because they shipped
// independently; consolidated when the new GH fits added a fourth copy.
function labelModes(readings, modes) {
  const labels = new Array(readings.length);
  let cursor = 0;
  let currentMode = 'idle';
  while (cursor < modes.length) {
    const tsMs = modes[cursor].ts instanceof Date ? modes[cursor].ts.getTime() : Number(modes[cursor].ts);
    const r0Ms = readings[0].ts instanceof Date ? readings[0].ts.getTime() : Number(readings[0].ts);
    if (tsMs <= r0Ms) { currentMode = modes[cursor].mode; cursor++; }
    else break;
  }
  labels[0] = currentMode;
  for (let i = 1; i < readings.length; i++) {
    const rMs = readings[i].ts instanceof Date ? readings[i].ts.getTime() : Number(readings[i].ts);
    while (cursor < modes.length) {
      const mMs = modes[cursor].ts instanceof Date ? modes[cursor].ts.getTime() : Number(modes[cursor].ts);
      if (mMs <= rMs) { currentMode = modes[cursor].mode; cursor++; }
      else break;
    }
    labels[i] = currentMode;
  }
  return labels;
}
```

Replace the inlined cursor in `fitSolarGainByHour`, `fitGreenhouseLossWPerK`, and `fitEmpiricalCoefficients` with `const modeLabels = labelModes(readings, modes);`.

- [ ] **Step 4: Wire into `fitEmpiricalCoefficients`**

In `fitEmpiricalCoefficients`, after the `tankSlope` computation, add:

```js
  const ghTau = fitGhTimeConstantH(history);
  const ghAlpha = ghTau !== null
    ? fitGhSolarAlphaCPerWm2(history, ghTau, /* ventOpenC */ 27)
    : null;
```

And in the returned `out` object, after `usedDefaults`, attach when defined:

```js
  if (ghTau   !== null) out.ghTimeConstantH      = ghTau;
  if (ghAlpha !== null) out.ghSolarAlphaCPerWm2  = ghAlpha;
```

(`ghVentOpenC` and `ghVentTauH` stay at defaults — they need more data than 14 d typically yields; can fit later when we have more history.)

- [ ] **Step 5: Update the engine to consume fitted GH params**

In `server/lib/forecast/sustain-forecast.js`, after the existing `if (typeof coeff.greenhouseLossWPerK …)` override (around line 125), add:

```js
  if (typeof coeff.ghTimeConstantH === 'number' && coeff.ghTimeConstantH > 0) {
    cfg.ghTimeConstantH = coeff.ghTimeConstantH;
  }
  if (typeof coeff.ghSolarAlphaCPerWm2 === 'number' && coeff.ghSolarAlphaCPerWm2 >= 0) {
    cfg.ghSolarAlphaCPerWm2 = coeff.ghSolarAlphaCPerWm2;
  }
  if (typeof coeff.ghVentOpenC === 'number' && coeff.ghVentOpenC > 0) {
    cfg.ghVentOpenC = coeff.ghVentOpenC;
  }
  if (typeof coeff.ghVentTauH === 'number' && coeff.ghVentTauH > 0) {
    cfg.ghVentTauH = coeff.ghVentTauH;
  }
```

- [ ] **Step 6: Write a test for the τ_gh fit**

Append to `tests/sustain-forecast.test.js`:

```js
describe('fitGhTimeConstantH', () => {
  it('recovers τ ≈ 2 h from synthetic idle cooling data', () => {
    const { fitEmpiricalCoefficients } = require('../server/lib/forecast/sustain-forecast');
    // Synthetic readings: gh starts at 25, outdoor at 5, no sun, idle.
    // Expected τ_synth = 2 h. With 30 s sampling and dT/dt = (out-gh)/τ:
    //   gh(t+dt) = gh + (out - gh) · dt/τ
    const dtSec = 30;
    const tauH  = 2.0;
    const readings = [];
    let gh = 25;
    for (let i = 0; i < 24 * 60 * 2; i++) { // 24 h of 30 s samples
      const ts = new Date(Date.UTC(2026, 4, 1) + i * dtSec * 1000);
      readings.push({ ts, greenhouse: gh, outdoor: 5, tankTop: 20, tankBottom: 20, radiationGlobal: 0 });
      gh = gh + (5 - gh) * (dtSec / 3600) / tauH;
    }
    const modes = [{ ts: readings[0].ts, mode: 'idle' }];
    const coeff = fitEmpiricalCoefficients({ readings, modes });
    assert.ok(coeff.ghTimeConstantH !== undefined, 'fit did not converge');
    assert.ok(Math.abs(coeff.ghTimeConstantH - tauH) / tauH < 0.2,
      'τ off by >20%: ' + coeff.ghTimeConstantH);
  });
});
```

- [ ] **Step 7: Run all tests**

```bash
timeout 30 node --test tests/sustain-forecast.test.js
```

Expected: green.

- [ ] **Step 8: Commit**

```bash
git add server/lib/forecast/sustain-forecast.js server/lib/forecast/sustain-forecast-fit.js tests/sustain-forecast.test.js
git commit -m "engine: fit τ_gh and α_solar from greenhouse history"
```

---

### Task 8: Emit `componentTrajectory` from the engine

The capture layer needs the per-hour predicted components (solar gain, radiator delivered W, heater kWh, tank loss W, cloud factor) to populate the new schema columns. The values are already computed inside the loop — just need to be collected and returned.

**Files:**
- Modify: `server/lib/forecast/sustain-forecast.js`

- [ ] **Step 1: Initialise the array**

Near the other accumulators (around line 199), add:

```js
  const componentTrajectory    = [];
```

- [ ] **Step 2: Push one entry per hour after the heat balance**

Inside the loop, immediately before the `// ── Floor crossing detection ──` block, push:

```js
    componentTrajectory.push({
      ts: hourDate,
      solarGainKwh:    round4(solarGainKwh),
      radDeliveredW:   round2(radHeatToGhW),
      heaterKwh:       round4(simMode === 'emergency_heating' ? heaterEnergyKwh : 0),
      tankLossW:       round2(simMode === 'idle'
        ? tankLeakageWPerK * Math.max(0, tankAvg - curGhTemp) : 0),
      cloudFactor:     round2(cloudFactor),
    });
```

(`solarGainKwh`, `cloudFactor`, `heaterEnergyKwh` already exist as locals from the existing solar-credit and emergency branches. `radHeatToGhW` is the new variable from Task 5.)

For modes that didn't compute a particular value (e.g. `tankLossW` outside the idle branch — the heating branches already account for `tankLossW` differently), use `0` rather than leaving undefined; analysis is downstream.

- [ ] **Step 3: Return the array**

In the returned forecast object (around line 478), add `componentTrajectory,` between `greenhouseTrajectory` and `hoursUntilFloor`.

- [ ] **Step 4: Add a smoke test**

Append to `tests/sustain-forecast.test.js`:

```js
describe('componentTrajectory', () => {
  it('emits 48 entries with the per-hour input/output components', () => {
    const { computeSustainForecast } = require('../server/lib/forecast/sustain-forecast');
    const now = Date.UTC(2026, 5, 1);
    const weather = []; const prices = [];
    for (let h = 0; h < 48; h++) {
      const ts = new Date(now + h * 3600 * 1000).toISOString();
      weather.push({ ts, temperature: 10, radiationGlobal: 200, windSpeed: 1, precipitation: 0 });
      prices.push({ ts, priceCKwh: 5 });
    }
    const fc = computeSustainForecast({
      now, tankTop: 30, tankBottom: 25, greenhouseTemp: 12,
      currentMode: 'idle', weather48h: weather, prices48h: prices,
      coefficients: { tankLeakageWPerK: 3, solarGainKwhByHour: new Array(24).fill(0.3) },
      config: {},
    });
    assert.equal(fc.componentTrajectory.length, 48);
    const c0 = fc.componentTrajectory[0];
    assert.ok('solarGainKwh' in c0);
    assert.ok('radDeliveredW' in c0);
    assert.ok('heaterKwh' in c0);
    assert.ok('tankLossW' in c0);
    assert.ok('cloudFactor' in c0);
  });
});
```

- [ ] **Step 5: Run tests, commit**

```bash
timeout 30 node --test tests/sustain-forecast.test.js
git add server/lib/forecast/sustain-forecast.js tests/sustain-forecast.test.js
git commit -m "engine: emit componentTrajectory for storage capture"
```

---

### Task 9: Schema migration — drop legacy table, add new shape

**Files:**
- Modify: `server/lib/db-schema.js:114-157`

- [ ] **Step 1: Replace the existing `forecast_predictions` block**

In `SCHEMA_SQL`, locate the legacy `CREATE TABLE forecast_predictions (...)` and the trailing `UPDATE ... SET for_hour = for_hour + INTERVAL '1 hour'` migration. Replace from the legacy table comment through that UPDATE (roughly lines 114-157) with:

```js
  // Captured forecast predictions — one row per (generated_at, horizon_h)
  // pair, written in batches of 48 by the HH:30 scheduler so the full 48 h
  // forecast trajectory is auditable against future ground truth.
  //
  // Replaces the pre-2026-05-08 single-row-per-for_hour layout, which
  // only kept the +1 h projection — useless for verifying the 48 h
  // trajectory the user actually reads on the forecast graph. The DROP
  // below detects the legacy shape (no horizon_h column) and removes it
  // so the new CREATE can take over. Idempotent: once the new shape
  // exists, the column check finds horizon_h and the DROP is skipped.
  "DO $$ BEGIN " +
  "  IF EXISTS (SELECT 1 FROM information_schema.tables " +
  "             WHERE table_name = 'forecast_predictions') AND NOT EXISTS ( " +
  "    SELECT 1 FROM information_schema.columns " +
  "    WHERE table_name = 'forecast_predictions' AND column_name = 'horizon_h' " +
  "  ) THEN DROP TABLE forecast_predictions; END IF; " +
  "END $$",

  "CREATE TABLE IF NOT EXISTS forecast_predictions (\n" +
  "  generated_at        TIMESTAMPTZ NOT NULL,\n" +
  "  horizon_h           SMALLINT    NOT NULL,\n" +
  "  for_hour            TIMESTAMPTZ NOT NULL,\n" +
  "  mode                TEXT        NOT NULL,\n" +
  "  has_solar_overlay   BOOLEAN     NOT NULL DEFAULT FALSE,\n" +
  "  duty                DOUBLE PRECISION,\n" +
  "  tank_top_c          DOUBLE PRECISION,\n" +
  "  tank_bottom_c       DOUBLE PRECISION,\n" +
  "  tank_avg_c          DOUBLE PRECISION,\n" +
  "  greenhouse_c        DOUBLE PRECISION,\n" +
  "  pred_solar_gain_kwh    DOUBLE PRECISION,\n" +
  "  pred_rad_delivered_w   DOUBLE PRECISION,\n" +
  "  pred_heater_kwh        DOUBLE PRECISION,\n" +
  "  pred_tank_loss_w       DOUBLE PRECISION,\n" +
  "  pred_cloud_factor      DOUBLE PRECISION,\n" +
  "  outdoor_c           DOUBLE PRECISION,\n" +
  "  radiation_w_m2      DOUBLE PRECISION,\n" +
  "  wind_speed_m_s      DOUBLE PRECISION,\n" +
  "  precipitation_mm    DOUBLE PRECISION,\n" +
  "  price_c_kwh         DOUBLE PRECISION,\n" +
  "  algorithm_version   TEXT,\n" +
  "  tu                  JSONB,\n" +
  "  coefficients        JSONB,\n" +
  "  PRIMARY KEY (generated_at, horizon_h)\n" +
  ")",

  "SELECT create_hypertable('forecast_predictions', 'generated_at', if_not_exists => true)",

  "CREATE INDEX IF NOT EXISTS forecast_predictions_for_hour ON forecast_predictions (for_hour DESC)",
  "CREATE INDEX IF NOT EXISTS forecast_predictions_horizon ON forecast_predictions (horizon_h, generated_at DESC)",
```

The legacy `CREATE INDEX forecast_predictions_for_hour ON forecast_predictions (for_hour DESC)` line is duplicated by the new index above — just leave one. The legacy `UPDATE forecast_predictions SET for_hour = for_hour + INTERVAL '1 hour' WHERE ...` line is removed entirely (the DROP supersedes it).

- [ ] **Step 2: Run the existing schema test**

```bash
timeout 10 node --test tests/db.test.js
```

Expected: `initSchema runs all schema SQL statements` still passes — pg-mem may not support `DO $$ ... END $$` blocks; if it errors, see step 3.

- [ ] **Step 3: If pg-mem can't handle the DO block, gate it**

pg-mem's SQL coverage is partial. If the test fails on the `DO $$ … END $$` block, replace that block with a simpler approach: detect the legacy shape in JS (a one-shot query) and run a plain `DROP TABLE IF EXISTS` only when needed. Implement in `server/lib/db.js`'s `initSchema` flow, before the SCHEMA_SQL loop:

```js
// Pre-migration: legacy forecast_predictions had no horizon_h column.
// Detect and drop so the SCHEMA_SQL CREATE can take over with the new
// PK shape. Real Postgres skips this branch after the first run.
function migrateLegacyForecastPredictions(pool, callback) {
  pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_name='forecast_predictions'",
    [], function (err, exists) {
      if (err || !exists.rows || exists.rows.length === 0) return callback(null);
      pool.query(
        "SELECT 1 FROM information_schema.columns " +
        "WHERE table_name='forecast_predictions' AND column_name='horizon_h'",
        [], function (cErr, hasCol) {
          if (cErr) return callback(null); // best-effort
          if (hasCol.rows && hasCol.rows.length > 0) return callback(null);
          pool.query('DROP TABLE forecast_predictions', [], callback);
        });
    });
}
```

Wire this in front of the SCHEMA_SQL execution in `initSchema`. Drop the SQL `DO $$ ... END $$` block from `db-schema.js`.

- [ ] **Step 4: Commit**

```bash
git add server/lib/db-schema.js server/lib/db.js
git commit -m "db: rewrite forecast_predictions schema for multi-horizon storage"
```

---

### Task 10: Rewrite `forecast-predictions.js` for multi-row capture

**Files:**
- Modify: `server/lib/forecast/forecast-predictions.js`

- [ ] **Step 1: Replace `buildRow` with `buildRows`**

Replace the existing `buildRow` function with `buildRows` returning an array of 48 rows (one per horizon hour).

```js
// Build one row per horizon hour (1..HORIZON_HOURS) from a forecast
// response. Returns null when the response shape is unusable. Each row
// describes the predicted state at the END of horizon hour h (= start
// of hour h+1) and the components consumed during that hour.
function buildRows(response) {
  if (!response || !response.forecast) return null;
  const fc = response.forecast;
  const tank = Array.isArray(fc.tankTrajectory) ? fc.tankTrajectory : [];
  const gh   = Array.isArray(fc.greenhouseTrajectory) ? fc.greenhouseTrajectory : [];
  const cmp  = Array.isArray(fc.componentTrajectory) ? fc.componentTrajectory : [];
  const modeEntries = Array.isArray(fc.modeForecast) ? fc.modeForecast : [];
  if (tank.length < 2 || gh.length < 2) return null;

  // Index modeForecast by ts; collapse solar overlay by setting hasSolar
  const modeByTs = {};
  for (let i = 0; i < modeEntries.length; i++) {
    const m = modeEntries[i];
    let entry = modeByTs[m.ts];
    if (!entry) {
      entry = { mode: 'idle', hasSolar: false, duty: null };
      modeByTs[m.ts] = entry;
    }
    if (m.mode === 'solar_charging') {
      if (entry.mode === 'idle') entry.mode = 'solar_charging';
      else entry.hasSolar = true;
    } else {
      if (entry.mode === 'solar_charging') entry.hasSolar = true;
      entry.mode = m.mode;
      if (typeof m.duty === 'number') entry.duty = m.duty;
    }
  }

  const generatedAt = response.generatedAt || new Date().toISOString();
  const algo = response.algorithmVersion || ALGORITHM_VERSION;
  const tu   = response.tu && typeof response.tu === 'object' ? response.tu : null;
  const coeff = response.coefficients && typeof response.coefficients === 'object'
    ? response.coefficients : null;

  const rows = [];
  const horizon = Math.min(tank.length - 1, gh.length - 1);
  for (let h = 1; h <= horizon; h++) {
    const tankAt = tank[h]; const ghAt = gh[h];
    if (!tankAt || !ghAt) continue;
    // The mode entry for hour-h-1 → h is keyed by the hour-(h-1) trajectory
    // ts (engine pushes mode entries at start-of-hour).
    const startTs = tank[h - 1] && tank[h - 1].ts;
    const me = (startTs && modeByTs[startTs]) || { mode: 'idle', hasSolar: false, duty: null };
    const c  = cmp[h - 1] || {};
    const wx = nearestRow(response.weather, ghAt.ts, 'validAt', 90 * 60 * 1000);
    const px = nearestRow(response.prices,  ghAt.ts, 'validAt', 90 * 60 * 1000);
    rows.push({
      generatedAt,
      horizonH:        h,
      forHour:         ghAt.ts,
      mode:            me.mode,
      hasSolarOverlay: me.hasSolar,
      duty:            me.duty,
      tankTopC:        round2(tankAt.top),
      tankBottomC:     round2(tankAt.bottom),
      tankAvgC:        round2(tankAt.avg),
      greenhouseC:     round2(ghAt.temp),
      predSolarGainKwh:    typeof c.solarGainKwh  === 'number' ? c.solarGainKwh  : null,
      predRadDeliveredW:   typeof c.radDeliveredW === 'number' ? c.radDeliveredW : null,
      predHeaterKwh:       typeof c.heaterKwh    === 'number' ? c.heaterKwh    : null,
      predTankLossW:       typeof c.tankLossW    === 'number' ? c.tankLossW    : null,
      predCloudFactor:     typeof c.cloudFactor  === 'number' ? c.cloudFactor  : null,
      outdoorC:        wx && typeof wx.temperature     === 'number' ? wx.temperature     : null,
      radiationWm2:    wx && typeof wx.radiationGlobal === 'number' ? wx.radiationGlobal : null,
      windSpeedMs:     wx && typeof wx.windSpeed       === 'number' ? wx.windSpeed       : null,
      precipitationMm: wx && typeof wx.precipitation   === 'number' ? wx.precipitation   : null,
      priceCKwh:       px && typeof px.priceCKwh       === 'number' ? px.priceCKwh       : null,
      algorithmVersion: algo,
      tu, coefficients: coeff,
    });
  }
  return rows.length > 0 ? rows : null;
}
```

(Keep the old `buildRow` only as `_buildRow: function () { throw new Error('removed in 2026-05-08 multi-horizon migration'); }` to surface clear failure if any caller still references it. Or just remove the export altogether — search the repo first.)

- [ ] **Step 2: Replace `persistRow` with `persistRows` (multi-row INSERT)**

```js
function persistRows(rows, callback) {
  if (!rows || rows.length === 0) { callback(null); return; }
  // Build a single INSERT … VALUES (…), (…), … ON CONFLICT DO UPDATE.
  // 22 columns × N rows.
  const cols = [
    'generated_at', 'horizon_h', 'for_hour', 'mode', 'has_solar_overlay', 'duty',
    'tank_top_c', 'tank_bottom_c', 'tank_avg_c', 'greenhouse_c',
    'pred_solar_gain_kwh', 'pred_rad_delivered_w', 'pred_heater_kwh',
    'pred_tank_loss_w', 'pred_cloud_factor',
    'outdoor_c', 'radiation_w_m2', 'wind_speed_m_s', 'precipitation_mm',
    'price_c_kwh', 'algorithm_version', 'tu', 'coefficients',
  ];
  const values = [];
  const placeholders = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const base = i * cols.length;
    const ph = []; for (let j = 0; j < cols.length; j++) ph.push('$' + (base + j + 1));
    placeholders.push('(' + ph.join(',') + ')');
    values.push(
      r.generatedAt, r.horizonH, r.forHour, r.mode, r.hasSolarOverlay, r.duty,
      r.tankTopC, r.tankBottomC, r.tankAvgC, r.greenhouseC,
      r.predSolarGainKwh, r.predRadDeliveredW, r.predHeaterKwh,
      r.predTankLossW, r.predCloudFactor,
      r.outdoorC, r.radiationWm2, r.windSpeedMs, r.precipitationMm,
      r.priceCKwh, r.algorithmVersion,
      r.tu ? JSON.stringify(r.tu) : null,
      r.coefficients ? JSON.stringify(r.coefficients) : null,
    );
  }
  const sql =
    'INSERT INTO forecast_predictions (' + cols.join(', ') + ') ' +
    'VALUES ' + placeholders.join(', ') + ' ' +
    'ON CONFLICT (generated_at, horizon_h) DO UPDATE SET ' +
      cols.filter(c => c !== 'generated_at' && c !== 'horizon_h')
          .map(c => c + ' = EXCLUDED.' + c).join(', ');
  pool.query(sql, values, callback);
}
```

- [ ] **Step 3: Update `captureFromForecast` to use the new functions**

```js
function captureFromForecast(response, callback) {
  const rows = buildRows(response);
  if (!rows) {
    if (callback) callback(null, null);
    return;
  }
  persistRows(rows, function (err) {
    if (err) {
      log.error('forecast-predictions: insert failed', { error: err.message });
    } else {
      log.info('forecast-predictions: captured', {
        generated_at: rows[0].generatedAt, count: rows.length,
      });
    }
    if (callback) callback(err, err ? null : rows);
  });
}
```

- [ ] **Step 4: Update `listRecent` to filter `horizon_h = 1`**

```js
function listRecent(limit, callback) {
  const n = Math.max(1, Math.min(parseInt(limit, 10) || RECENT_DEFAULT_LIMIT, 500));
  const sql =
    'SELECT for_hour, generated_at, mode, has_solar_overlay, duty, ' +
    '  tank_avg_c, greenhouse_c, outdoor_c, radiation_w_m2, price_c_kwh, ' +
    '  algorithm_version, tu, coefficients ' +
    'FROM forecast_predictions WHERE horizon_h = 1 ' +
    'ORDER BY for_hour DESC LIMIT $1';
  pool.query(sql, [n], function (err, result) {
    if (err) return callback(err);
    const rows = (result.rows || []).map(function (r) {
      return {
        forHour:         r.for_hour instanceof Date ? r.for_hour.toISOString() : r.for_hour,
        generatedAt:     r.generated_at instanceof Date ? r.generated_at.toISOString() : r.generated_at,
        mode:            r.mode,
        hasSolarOverlay: !!r.has_solar_overlay,
        duty:            r.duty,
        tankAvgC:        r.tank_avg_c,
        greenhouseC:     r.greenhouse_c,
        outdoorC:        r.outdoor_c,
        radiationWm2:    r.radiation_w_m2,
        priceCKwh:       r.price_c_kwh,
        algorithmVersion: r.algorithm_version,
        tu:               typeof r.tu === 'string' ? safeParseJson(r.tu) : (r.tu || null),
        coefficients:     typeof r.coefficients === 'string' ? safeParseJson(r.coefficients) : (r.coefficients || null),
      };
    });
    callback(null, rows);
  });
}
```

- [ ] **Step 5: Pass `coefficients` through from forecast-handler**

In `server/lib/forecast/forecast-handler.js`'s response-building block (around line 345), add `coefficients: coeff,` next to `tu: dcfg.tu || {},` so each captured row carries the active fit values.

- [ ] **Step 6: Update tests**

In `tests/forecast-predictions.test.js`:
- The `_buildRow` describe block should be replaced/extended with `_buildRows`. Add assertions: returns an array of 48 elements, each has `horizonH` 1..48, `tankTopC` and `tankBottomC` populated, `coefficients` propagated.
- The "generates correct INSERT SQL" test (around line 179) should now check the multi-row VALUES (`)·(`)`) shape and `(generated_at, horizon_h)` ON CONFLICT clause.
- Add a test for `listRecent`: when 48 rows exist for one generated_at, only the `horizon_h=1` row is returned.

```js
describe('forecast-predictions._buildRows', () => {
  const svc = forecastPredictions.create({ pool: null, log: makeLog() });

  it('returns one row per horizon hour with components and coefficients', () => {
    const rows = svc._buildRows(makeForecastResponse({
      forecast: {
        modeForecast: [{ ts: HOUR0, mode: 'greenhouse_heating' }],
        tankTrajectory: [
          { ts: HOUR0, top: 16, bottom: 14, avg: 15 },
          { ts: HOUR1, top: 14.5, bottom: 13, avg: 13.75 },
        ],
        greenhouseTrajectory: [
          { ts: HOUR0, temp: 12.4 }, { ts: HOUR1, temp: 11.8 },
        ],
        componentTrajectory: [
          { ts: HOUR0, solarGainKwh: 0, radDeliveredW: 250, heaterKwh: 0, tankLossW: 5, cloudFactor: 0.8 },
        ],
      },
      coefficients: { ghTimeConstantH: 1.8, ghSolarAlphaCPerWm2: 0.027 },
    }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].horizonH, 1);
    assert.equal(rows[0].forHour, HOUR1);
    assert.equal(rows[0].tankTopC, 14.5);
    assert.equal(rows[0].predRadDeliveredW, 250);
    assert.equal(rows[0].coefficients.ghTimeConstantH, 1.8);
  });
});
```

(`makeForecastResponse` needs an extra `coefficients` parameter — extend the helper at the top of the test file.)

- [ ] **Step 7: Update `_buildRow` references in `module.exports`**

```js
return {
  start, stop,
  captureFromForecast, listRecent,
  _buildRows: buildRows,
  _msUntilNextHH30: msUntilNextHH30,
};
```

Drop `_buildRow` from the exports entirely.

- [ ] **Step 8: Run the test suite**

```bash
timeout 30 node --test tests/forecast-predictions.test.js
```

Expected: green.

- [ ] **Step 9: Commit**

```bash
git add server/lib/forecast/forecast-predictions.js server/lib/forecast/forecast-handler.js tests/forecast-predictions.test.js
git commit -m "forecast: capture all 48 horizons per generation in one INSERT"
```

---

### Task 11: Full unit + frontend + e2e suite

Run the gates locally before pushing.

- [ ] **Step 1: Lint and dead-code**

```bash
npm run lint && npm run knip
```

Expected: both exit 0.

- [ ] **Step 2: File-size check**

```bash
npm run check:file-size -- --strict
```

Expected: `0 over hard cap` in the summary line.

- [ ] **Step 3: Unit tests**

```bash
timeout 30 npm run test:unit
```

Expected: green.

- [ ] **Step 4: Playwright (frontend + e2e)**

```bash
timeout 180 npx playwright test
```

Expected: green. If "Executable doesn't exist" → use the cached-Chromium recipe in CLAUDE.md ("Test Setup Gotchas"). Run `timeout 30 npm run test:unit` again afterward to confirm `--no-save` reinstall didn't disturb anything.

- [ ] **Step 5: If anything failed, fix and re-run that step alone before iterating further**

---

### Task 12: Push and watch CI to green

- [ ] **Step 1: Push**

```bash
git push -u origin HEAD
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "Forecast: GH heat balance + multi-horizon storage" --body "$(cat <<'EOF'
## Summary

- Replace per-branch greenhouse-temperature update in `sustain-forecast.js` with a unified per-hour heat balance (passive loss, solar absorption, gravity-vent saturation, active heating contribution) so the projection actually rises into the 30s on sunny days and crosses heating thresholds when outdoor cools to ~10 °C.
- Add τ_gh and α_solar fits in `sustain-forecast-fit.js`; vent params keep their defaults until more history is available.
- Rewrite `forecast_predictions` table to `(generated_at, horizon_h)` PK and capture all 48 horizons per HH:30 generation, with per-component breakdown and the active fit coefficients alongside.
- Spec: `docs/superpowers/specs/2026-05-08-forecast-greenhouse-model-and-storage-design.md`

Closes nothing; follow-up issue #169 builds the diagnostic view on top of the new data.

## Test plan

- [ ] `npm run lint`, `npm run knip`, `npm run check:file-size -- --strict` exit 0
- [ ] `npm run test:unit` green
- [ ] `npx playwright test` green
- [ ] Manual smoke: pull `/api/forecast` from a preview deploy, verify GH trajectory peaks into the 30s on sunny noon and shows heating mode within a few hours of outdoor dropping to 10 °C.
EOF
)"
```

- [ ] **Step 3: Subscribe to CI activity**

```bash
gh pr view --json number -q .number | xargs -I{} gh api -X POST repos/Wnt/greenhouse-solar-heater/issues/{}/subscribe 2>/dev/null || true
```

Then attach via `mcp__github__subscribe_pr_activity` so failures stream into the session.

- [ ] **Step 4: If CI fails**

Read the failing job, reproduce locally, fix, push. Cap auto-fix loop at 3 cycles per CLAUDE.md mobile workflow.

---

## Self-review checklist

Run before declaring complete:

1. Spec coverage — every section of `docs/superpowers/specs/2026-05-08-forecast-greenhouse-model-and-storage-design.md` corresponds to at least one task above. Algorithm fix → Tasks 1, 5, 7. Vent saturation → Tasks 1, 4, 5. Multi-horizon storage → Tasks 8, 9, 10. Migration → Task 9. System Logs preservation → Task 10 step 4.
2. Placeholders — none ("TBD", "TODO", "implement later", etc. absent).
3. Type consistency — `componentTrajectory` shape matches between Task 8 (engine emits) and Task 10 (capture consumes). `coefficients` shape matches between Task 7 (fit emits ghTimeConstantH/ghSolarAlphaCPerWm2) and Task 10 (forecast-handler attaches, capture serialises).
