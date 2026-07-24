'use strict';

// ml-forecast.js — 48 h forecast engine driven by the random-forest
// temperature model. Pure: no I/O, no DB.
//
// Mirrors the *output contract* of computeSustainForecast
// (sustain-forecast.js) so the /api/forecast card and the history-graph
// overlay render an ML forecast with no client changes — only the
// per-step thermal step differs.
//
// The rollout is multi-resolution: 5-min steps across the near term
// (features.FINE_HORIZON_MS), then 1-h steps for the tail. Fine steps
// give precise near-term mode timing — the window the operator acts on
// — without paying the recursive-error cost of running 5-min steps for
// the whole 48 h. The trained forest takes the step length as a feature
// (`step_h`), so one model serves both regimes.
//
// Each step: decide the controller mode from the same hysteresis the
// physics engine uses (evaluated on the ML-predicted state), build the
// shared feature row, and step tank-average + greenhouse temperature
// with the trained forest. Backup electricity is derived from the
// predicted greenhouse/outdoor gap with the same gap-fill formula the
// physics engine uses.

const rf = require('./random-forest');
const {
  featureRow, STEP_FINE_MS, STEP_COARSE_MS, FINE_HORIZON_MS, HORIZON_MS, MS_PER_HOUR,
} = require('./features');
const { physicsStep } = require('../physics-step');
const { tankStoredEnergyKwh } = require('../../energy-balance');
// The device's own solar entry/exit thresholds. Server-side require of
// shelly/control-logic.js is established precedent (device-config.js);
// pulling the constants from the controller's DEFAULT_CONFIG keeps the
// rollout's solar rules from drifting against the real decision core —
// three parallel solar definitions already diverged once
// (design/docs/ml-mode-forecast-findings.md rec #6).
const { DEFAULT_CONFIG: CONTROL_DEFAULTS } = require('../../../../shelly/control-logic.js');

const HORIZON_HOURS = 48;

// Defaults mirror sustain-forecast.js DEFAULT_CONFIG; the handler
// overrides the threshold fields from live device-config tuning.
const DEFAULT_CONFIG = {
  tankFloorC: 12,
  greenhouseEnterC: 10,
  greenhouseExitC: 12,
  greenhouseMinTankDeltaC: 5,
  greenhouseExitTankDeltaC: 2,
  emergencyEnterC: 9,
  emergencyExitC: 12,
  fanCoolEnterC: 30,
  fanCoolExitC: 28,
  spaceHeaterKw: 1,
  transferFeeCKwh: 5,
  greenhouseLossWPerK: 120,
  radiatorPowerKw: 2.4,
  radiatorUaWPerK: 80,
  tankMaxC: 55,
  // Min FMI radiation (W/m^2) for an idle hour to be modelled as
  // solar_charging. The original 150 came from median-radiation
  // separation (solar hours median ~550 W/m^2 vs ~44 for idle), but the
  // offline backtest (design/docs/ml-mode-forecast-findings.md) showed
  // 150 over-predicts solar-dominant hours (828 false-positive hours);
  // 300 improved schedule accuracy +11.6 pp (2-6 h), +3.0 pp (7-24 h),
  // +3.3 pp (25-48 h) at an acceptable solar-recall cost.
  solarChargeRadiationMinWm2: 300,
  // Device solar entry/exit thresholds (used only when the model carries
  // a collector forest — see the solar-decision block in the rollout).
  // Sourced from the controller so they cannot drift; overridable like
  // every other cfg field.
  solarEnterDelta: CONTROL_DEFAULTS.solarEnterDelta,
  solarExitTankDrop: CONTROL_DEFAULTS.solarExitTankDrop,
  solarStallBypassDelta: CONTROL_DEFAULTS.solarStallBypassDelta,
  // Probabilistic emergency entry (findings-doc rec #4): enter
  // emergency_heating when P(gh_true < emergencyEnterC) >= this,
  // instead of the point rule that predicted 0-4 emergency hours vs 56
  // actual in the backtest window.
  emergencyProbMin: 0.3,
  // Floor on the assumed std of the greenhouse prediction. Measured
  // greenhouse MAE is ~2.4 degC at 13-48 h (≈3 degC normal sigma), but
  // that error grows with horizon and the initial state is a sensor
  // reading — 1.5 degC roughly matches mid-horizon spread without
  // making the near-term window hair-triggered, and keeps the entry
  // probabilistic even when the ensemble is overconfident (tree spread
  // underestimates true error in-distribution).
  emergencyStdFloorC: 1.5,
  weatherFetchedAt: null,
};

// Feature indices whose drift outside the trained envelope means the
// model is extrapolating (winter cold, an unseen tank regime, ...).
const OOD_FEATURE_INDICES = [0, 4, 5]; // wx_temp_c, tank_avg_c, greenhouse_c

function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
function round2(v) { return Math.round(v * 100) / 100; }
function round4(v) { return Math.round(v * 10000) / 10000; }

// One-hot mode-fraction object for a feature row.
function modeOneHot(mode) {
  const frac = {};
  frac[mode] = 1;
  return frac;
}

// Standard normal CDF via the Zelen & Severo polynomial approximation
// (Abramowitz & Stegun 26.2.17, |err| < 7.5e-8) — plenty for a mode
// gate compared against a 0..1 threshold.
function normalCdf(z) {
  if (z < -8) return 0;
  if (z > 8) return 1;
  const x = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782
    + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

// Inverse of normalCdf via bisection — evaluated once per forecast, so
// the fixed iteration count is irrelevant.
function normalQuantile(p) {
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  let lo = -8;
  let hi = 8;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function helsinkiHHMM(ms) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms));
}

const HELSINKI_HH = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Helsinki', hour: '2-digit', hour12: false,
});
function helsinkiHour(ms) { return parseInt(HELSINKI_HH.format(new Date(ms)), 10) || 0; }

// Count of OOD_FEATURE_INDICES columns sitting outside the trained
// range (with a 10% margin) for this row.
function outOfRangeCount(row, ranges) {
  if (!Array.isArray(ranges)) return 0;
  let n = 0;
  for (let i = 0; i < OOD_FEATURE_INDICES.length; i++) {
    const f = OOD_FEATURE_INDICES[i];
    const r = ranges[f];
    if (!r) continue;
    const margin = (r.max - r.min) * 0.1;
    if (row[f] < r.min - margin || row[f] > r.max + margin) n += 1;
  }
  return n;
}

// Multi-resolution step plan: 5-min steps until FINE_HORIZON_MS, then
// 1-h steps out to HORIZON_MS. The lengths sum to exactly HORIZON_MS.
function buildStepSchedule() {
  const steps = [];
  let elapsed = 0;
  while (elapsed < FINE_HORIZON_MS) { steps.push(STEP_FINE_MS); elapsed += STEP_FINE_MS; }
  while (elapsed < HORIZON_MS) { steps.push(STEP_COARSE_MS); elapsed += STEP_COARSE_MS; }
  return steps;
}

/**
 * Compute the 48 h ML forecast.
 *
 * @param {object} opts
 *   opts.now            — Date or ms
 *   opts.tankTop        — degC
 *   opts.tankBottom     — degC
 *   opts.greenhouseTemp — degC
 *   opts.currentMode    — string
 *   opts.emergencyRecentlyActive — bool
 *   opts.weather48h     — [{ temperature, radiationGlobal, windSpeed, precipitation }]
 *   opts.prices48h      — [{ priceCKwh }]
 *   opts.model          — loaded random-forest model { tank, greenhouse, featureRanges }
 *   opts.config         — threshold overrides
 * @returns forecast object (computeSustainForecast-compatible subset)
 */
function computeMlForecast(opts) {
  const model = opts.model;
  if (!model || !model.tank || !model.greenhouse) {
    throw new Error('computeMlForecast: model not loaded');
  }
  const now = opts.now instanceof Date ? opts.now.getTime() : Number(opts.now || Date.now());
  const weather = opts.weather48h || [];
  const prices = opts.prices48h || [];

  const cfg = Object.assign({}, DEFAULT_CONFIG);
  if (opts.config) {
    Object.keys(opts.config).forEach(function over(k) {
      if (opts.config[k] !== undefined) cfg[k] = opts.config[k];
    });
  }

  const tankTop0 = Number(opts.tankTop != null ? opts.tankTop : 20);
  const tankBottom0 = Number(opts.tankBottom != null ? opts.tankBottom : 18);
  // Stratification spread is held constant — the model predicts the
  // average; top/bottom ride it so the hysteresis tank gate still works.
  const spread = tankTop0 - tankBottom0;
  let tankAvg = (tankTop0 + tankBottom0) / 2;
  let gh = Number(opts.greenhouseTemp != null ? opts.greenhouseTemp : 10);

  const currentMode = String(opts.currentMode || 'idle');
  let heatMode = (currentMode === 'greenhouse_heating' || currentMode === 'emergency_heating')
    ? currentMode : 'idle';
  // Fan-cooling is an overlay (not a mode) with its own hysteresis;
  // tracked independently across the rollout.
  let fanCooling = false;
  // Collector-driven solar session state (findings rec #6) — only used
  // when the artifact carries the optional collector forest. Peak
  // simulated tankAvg while in solar backs the drop-from-peak exit,
  // mirroring flags.solarChargePeakTankAvg on the device. Seeding
  // solarActive from the live mode lets an in-progress session continue
  // straight into the exit hysteresis instead of re-qualifying entry.
  const hasCollectorForest = !!model.collector;
  let solarActive = hasCollectorForest && currentMode === 'solar_charging';
  let solarPeakTankAvg = tankAvg;

  const tankTrajectory = [];
  const greenhouseTrajectory = [];
  const modeForecast = [];
  // Per-forecast-hour mode-occupancy accumulators (findings-doc rec #5):
  // the controller's median real dwell is 6-9 min and 27.8% of hours
  // have no >=75% dominant mode, so a single hourly label is a lossy
  // target — occupancy fractions are the honest schedule output. This
  // aggregates the rollout's own step schedule (12 five-min samples per
  // fine hour, one sample per coarse hour); a learned occupancy model
  // per mode is the planned v2.
  const hourAgg = [];
  const costBreakdown = [];
  let electricKwh = 0;
  let electricCostEur = 0;
  let solarChargingHours = 0;
  let greenhouseHeatingHours = 0;
  let hoursUntilFloor = null;
  let hoursUntilBackupNeeded = opts.emergencyRecentlyActive ? 0 : null;
  // OOD time is summed in hours (steps have unequal length).
  let oodHours = 0;

  // Probabilistic-entry geometry: P(gh_true < enterC) >= emergencyProbMin
  // fires entry at gh <= enterC + z*sigma, with z = Phi^-1(1 -
  // emergencyProbMin) (≈ 0.524 at the default 0.3). INVARIANT: the
  // effective entry threshold must stay strictly BELOW emergencyExitC —
  // when a large sigma (OOD winter spread) or tight tuning pushes
  // enterC + z*sigma past exitC, every exit immediately re-qualifies
  // entry and the rollout chatters emergency<->idle on 5-min steps,
  // inflating electricKwh. Capping sigma at 90% of the head-room keeps
  // enterC + z*sigmaCap at most 90% of the way to exitC. The cap only
  // applies when z > 0 (emergencyProbMin < 0.5); at z <= 0 the entry
  // threshold sits at or below enterC < exitC already.
  const entryZ = normalQuantile(1 - cfg.emergencyProbMin);
  const sigmaCap = (entryZ > 0 && cfg.emergencyExitC > cfg.emergencyEnterC)
    ? 0.9 * (cfg.emergencyExitC - cfg.emergencyEnterC) / entryZ
    : Infinity;

  const steps = buildStepSchedule();
  let elapsedMs = 0;
  for (let i = 0; i < steps.length; i++) {
    const stepMs = steps[i];
    const stepH = stepMs / MS_PER_HOUR;
    const tMs = now + elapsedMs;
    const tIso = new Date(tMs).toISOString();
    const elapsedH = elapsedMs / MS_PER_HOUR;
    const tankTop = tankAvg + spread / 2;

    tankTrajectory.push({
      ts: tIso, top: round2(tankTop), bottom: round2(tankAvg - spread / 2), avg: round2(tankAvg),
    });
    greenhouseTrajectory.push({ ts: tIso, temp: round2(gh) });
    if (hoursUntilFloor === null && tankAvg < cfg.tankFloorC) hoursUntilFloor = elapsedH;

    // Weather and prices are hourly; index by the elapsed hour so the
    // 12 fine steps inside an hour all read that hour's forecast row.
    const wxIdx = Math.floor(elapsedMs / MS_PER_HOUR);
    const wx = weather[wxIdx] || weather[weather.length - 1]
      || { temperature: 0, radiationGlobal: 0, windSpeed: 0, precipitation: 0 };
    const outdoorC = num(wx.temperature);
    const radiation = num(wx.radiationGlobal);
    const px = prices[wxIdx] || prices[prices.length - 1] || { priceCKwh: 10 };
    const priceCKwh = typeof px.priceCKwh === 'number' ? px.priceCKwh : 10;

    // ── Mode decision — same hysteresis as the physics engine ──
    const tankCanEnter = tankTop > gh + cfg.greenhouseMinTankDeltaC;
    const tankCanSustain = tankTop >= gh + cfg.greenhouseExitTankDeltaC;
    // Probabilistic emergency ENTRY (findings-doc rec #4): a point
    // forecast with ~2.4 degC greenhouse MAE cannot see threshold
    // crossings — it predicted 0-4 emergency hours vs 56 actual. Model
    // P(gh_true < emergencyEnterC) as a normal around the predicted gh
    // with std = max(floor, per-tree spread of the greenhouse forest at
    // this state), and enter when it clears cfg.emergencyProbMin. The
    // probe row uses the pre-decision mode; the spread is dominated by
    // the weather/state features, so the mode fraction is second-order.
    // EXIT hysteresis stays point-based, mirroring the device rules.
    const probeRow = featureRow(tankAvg, gh, outdoorC, wx, modeOneHot(heatMode),
      { heaterOn: 0, fanCooling: fanCooling ? 1 : 0 }, tMs, stepMs);
    const ghStd = rf.predictForestStats(model.greenhouse, probeRow).std;
    // Floor first, then the entry-below-exit cap (see sigmaCap above).
    const ghSigma = Math.min(Math.max(cfg.emergencyStdFloorC, ghStd), sigmaCap);
    const emergencyProb = normalCdf((cfg.emergencyEnterC - gh) / ghSigma);
    if (heatMode !== 'emergency_heating' && emergencyProb >= cfg.emergencyProbMin) {
      if (hoursUntilBackupNeeded === null) hoursUntilBackupNeeded = elapsedH;
      heatMode = 'emergency_heating';
    } else if (heatMode === 'emergency_heating' && gh > cfg.emergencyExitC) {
      heatMode = (gh < cfg.greenhouseEnterC && tankCanEnter) ? 'greenhouse_heating' : 'idle';
    } else if (gh < cfg.greenhouseEnterC && heatMode === 'idle' && tankCanEnter) {
      heatMode = 'greenhouse_heating';
    } else if (heatMode === 'greenhouse_heating' && (gh > cfg.greenhouseExitC || !tankCanSustain)) {
      heatMode = 'idle';
    }
    // solar_charging is an exclusive mode in the training data; model it
    // as an overlay on an idle step. With a collector forest in the
    // artifact the overlay follows the DEVICE's entry/exit semantics
    // evaluated on a simulated collector temperature; without one, the
    // legacy flat radiation gate stays as the fallback (unchanged).
    let mode = heatMode;
    let simCollector = NaN;
    if (hasCollectorForest) {
      // Predict the collector outlet directly from the current feature
      // row. The row's mode fraction reflects the CURRENT pump state
      // (solar_charging while a session is active): collector
      // temperature depends strongly on flow vs stagnation, and the
      // training rows carry the logged mode mix — so entry sees the
      // stagnating-collector regime and exit sees the pumped one, just
      // like the device's sensor does.
      const collMode = (solarActive && heatMode === 'idle') ? 'solar_charging' : heatMode;
      const collRow = featureRow(tankAvg, gh, outdoorC, wx, modeOneHot(collMode),
        { heaterOn: 0, fanCooling: fanCooling ? 1 : 0 }, tMs, stepMs);
      simCollector = rf.predictForest(model.collector, collRow);
    }
    if (hasCollectorForest && isFinite(simCollector)) {
      if (heatMode !== 'idle') {
        // solar_charging is exclusive — a heating mode pre-empts it
        // (the device drains and switches; sessions don't survive).
        solarActive = false;
      } else if (!solarActive) {
        // ENTRY — the device rule verbatim (control-logic.js):
        // collector > tank_bottom + solarEnterDelta. tank_bottom rides
        // the carried average via the constant stratification spread.
        // The tankMaxC guard is a rollout addition standing in for the
        // device's separate overheat protection.
        if (simCollector > (tankAvg - spread / 2) + cfg.solarEnterDelta && tankAvg < cfg.tankMaxC) {
          solarActive = true;
          solarPeakTankAvg = tankAvg;
        }
      } else {
        // EXIT — "the tank stopped accepting". Device semantics
        // (control-logic.js) with two tractable simplifications:
        //  (a) drop-from-peak is exact: exit when mean tank has fallen
        //      >= solarExitTankDrop from the session peak;
        //  (b) the device's 300 s no-rise STALL timer can't be
        //      reproduced from ~5-min/1-h simulated steps, so stall is
        //      approximated as exhausted thermodynamic head:
        //      collector - tank_top <= 0 (no delivery possible). The
        //      collector-much-hotter bypass (> solarStallBypassDelta)
        //      is kept for rule fidelity, though the head proxy makes
        //      it vacuous — a stalled step can't also be far above
        //      tank_top the way a timer-stalled device step can.
        if (tankAvg > solarPeakTankAvg) solarPeakTankAvg = tankAvg;
        const droppedFromPeak = (solarPeakTankAvg - tankAvg) >= cfg.solarExitTankDrop;
        const head = simCollector - tankTop;
        const stalled = head <= 0 && !(head > cfg.solarStallBypassDelta);
        if (droppedFromPeak || stalled) solarActive = false;
      }
      if (solarActive) mode = 'solar_charging';
    } else if (heatMode === 'idle' && radiation >= cfg.solarChargeRadiationMinWm2 && tankAvg < cfg.tankMaxC) {
      // Legacy radiation gate — the fallback until the daily trainer
      // ships a collector forest (also covers a NaN collector
      // prediction from a degenerate forest).
      mode = 'solar_charging';
    }

    // ── Physics step — threshold-sensitive structural baseline. ──
    // Same call dataset.js uses to compute training targets, so the
    // ML residual stays meaningful: tankAvg += physics + ml.
    const phys = physicsStep({
      tankAvg, gh, outdoor: outdoorC, radiation,
      mode, stepHours: stepH,
      hourOfDayHelsinki: helsinkiHour(tMs),
      cfg: { emergencyEnterC: cfg.emergencyEnterC, emergencyExitC: cfg.emergencyExitC },
    });

    // Backup electricity (emergency steps only). Driven by the physics
    // heater duty so the cost figure tracks the same model the trees
    // were trained against.
    const duty = mode === 'emergency_heating' ? phys.heaterDuty : null;
    if (mode === 'emergency_heating') {
      const kwh = phys.heaterDuty * cfg.spaceHeaterKw * stepH;
      if (kwh > 0) {
        electricKwh += kwh;
        const eur = kwh * (priceCKwh + cfg.transferFeeCKwh) / 100;
        electricCostEur += eur;
        costBreakdown.push({ ts: tIso, kWh: round4(kwh), priceCKwh, eurInclTransfer: round4(eur) });
      }
    }
    if (mode === 'solar_charging') solarChargingHours += stepH;
    if (mode === 'greenhouse_heating') greenhouseHeatingHours += stepH;
    const modeEntry = duty !== null ? { ts: tIso, mode, duty: round2(duty) } : { ts: tIso, mode };
    // Additive field: surface the entry probability while in (or near,
    // P >= 5%) emergency so the UI can show threshold-crossing risk the
    // point trajectory hides. Existing fields are unchanged.
    if (mode === 'emergency_heating' || emergencyProb >= 0.05) {
      modeEntry.emergencyProb = round2(emergencyProb);
    }
    modeForecast.push(modeEntry);

    // Occupancy accumulation for modeFractions. Steps tile forecast
    // hours exactly (the fine window is a whole number of hours), so
    // each hour's stepH weights sum to 1. `solar` mirrors modeForecast's
    // overlay semantics: the fraction of the hour spent solar-charging.
    const hourIdx = Math.floor(elapsedMs / MS_PER_HOUR);
    const agg = hourAgg[hourIdx] || (hourAgg[hourIdx] = { modes: {}, solar: 0 });
    agg.modes[mode] = (agg.modes[mode] || 0) + stepH;
    if (mode === 'solar_charging') agg.solar += stepH;

    // Fan-cooling overlay — own hysteresis on the predicted greenhouse
    // temperature, can be active under any mode.
    if (gh > cfg.fanCoolEnterC) fanCooling = true;
    else if (gh < cfg.fanCoolExitC) fanCooling = false;

    // ── Compose physics + ML residual ──
    // The trees learn the bias correction (observed − physics), so the
    // step is `physics + residual`. Mode → physics carries the
    // threshold-driven dynamics; ML softens the systematic error.
    const frac = modeOneHot(mode);
    const aux = { heaterOn: typeof duty === 'number' ? duty : 0, fanCooling: fanCooling ? 1 : 0 };
    const row = featureRow(tankAvg, gh, outdoorC, wx, frac, aux, tMs, stepMs);
    if (outOfRangeCount(row, model.featureRanges) > 0) oodHours += stepH;

    const prevTankAvg = tankAvg;
    tankAvg += phys.dTankC + rf.predictForest(model.tank, row);
    gh += phys.dGhC + rf.predictForest(model.greenhouse, row);
    if (gh < outdoorC) gh = outdoorC; // can't fall below the outdoor air

    if (hoursUntilFloor === null && tankAvg < cfg.tankFloorC && prevTankAvg >= cfg.tankFloorC) {
      hoursUntilFloor = elapsedH + stepH * (prevTankAvg - cfg.tankFloorC) / (prevTankAvg - tankAvg);
    }
    elapsedMs += stepMs;
  }

  // Additive per-hour occupancy fractions (rec #5) — one entry per
  // forecast hour. `ts` is the FORECAST-hour start (now + h·1 h), NOT a
  // wall-clock hour start: `now` is whenever the forecast ran, so
  // consumers must not treat these timestamps as calendar-aligned.
  // modeForecast itself is deliberately unchanged (frozen contract).
  const modeFractions = hourAgg.map(function toEntry(agg, h) {
    const fractions = {};
    Object.keys(agg.modes).forEach(function toFrac(m) {
      fractions[m] = round4(agg.modes[m]);
    });
    return {
      ts: new Date(now + h * MS_PER_HOUR).toISOString(),
      fractions,
      solar: round4(agg.solar),
    };
  });

  // Trailing point at the 48 h horizon.
  const finalIso = new Date(now + HORIZON_MS).toISOString();
  tankTrajectory.push({
    ts: finalIso, top: round2(tankAvg + spread / 2), bottom: round2(tankAvg - spread / 2), avg: round2(tankAvg),
  });
  greenhouseTrajectory.push({ ts: finalIso, temp: round2(gh) });

  // ── Confidence ──
  let weatherFresh = false;
  if (cfg.weatherFetchedAt) {
    const fetchedMs = cfg.weatherFetchedAt instanceof Date
      ? cfg.weatherFetchedAt.getTime() : Number(cfg.weatherFetchedAt);
    weatherFresh = (now - fetchedMs) < 2 * MS_PER_HOUR;
  }
  let confidence = 'medium';
  if (oodHours > HORIZON_HOURS / 4) confidence = 'low';
  else if (oodHours === 0 && weatherFresh) confidence = 'high';

  // A NaN-poisoned model (e.g. leaves trained on NaN ΔT targets) emits
  // non-finite predictions, which propagate through the rollout. Fail
  // with a clear, handler-recognized message ("model not available" →
  // 503) instead of letting NaN crash the notes lookup below with a
  // cryptic "Cannot read properties of undefined (reading 'ts')" 500.
  if (!isFinite(tankAvg) || !isFinite(gh)) {
    throw new Error('ML model not available: produced non-finite predictions');
  }

  // ── Notes ──
  const ghTemps = greenhouseTrajectory.map(function temp(p) { return p.temp; });
  const ghMin = Math.min.apply(null, ghTemps);
  const ghMinIdx = ghTemps.indexOf(ghMin);
  const ghMinTs = Date.parse(greenhouseTrajectory[ghMinIdx].ts);
  const tankAvgNow = tankTrajectory[0].avg;
  const notes = buildNotes({
    confidence, ghMin, ghMinTs, electricKwh, electricCostEur,
    hoursUntilBackupNeeded, tankStoredKwhNow: tankStoredEnergyKwh(tankAvgNow),
  });

  return {
    generatedAt: new Date(now).toISOString(),
    engine: 'ml',
    horizonHours: HORIZON_HOURS,
    tankTrajectory,
    greenhouseTrajectory,
    modeForecast,
    modeFractions,
    hoursUntilFloor: hoursUntilFloor !== null ? round2(hoursUntilFloor) : null,
    hoursUntilBackupNeeded: hoursUntilBackupNeeded !== null ? round2(hoursUntilBackupNeeded) : null,
    electricKwh: round4(electricKwh),
    electricCostEur: round4(electricCostEur),
    costBreakdown,
    solarChargingHours: round2(solarChargingHours),
    greenhouseHeatingHours: round2(greenhouseHeatingHours),
    modelConfidence: confidence,
    notes,
  };
}

// Compact, operationally-ordered notes — capped at 3.
function buildNotes(ctx) {
  const notes = [];
  if (ctx.confidence === 'low') {
    notes.push('ML forecast is extrapolating beyond its trained conditions — treat as indicative.');
  }
  if (notes.length < 3) {
    const hhmm = helsinkiHHMM(ctx.ghMinTs);
    notes.push(ctx.electricKwh > 0
      ? 'Greenhouse cools to ' + ctx.ghMin.toFixed(1) + ' °C around ' + hhmm
        + ', when the space heater takes over.'
      : 'Greenhouse holds above ' + ctx.ghMin.toFixed(1) + ' °C the whole window'
        + ' — tank covers it without backup.');
  }
  if (notes.length < 3) {
    const stored = ctx.tankStoredKwhNow.toFixed(1);
    if (ctx.hoursUntilBackupNeeded === 0) {
      notes.push('Tank stores ~' + stored + ' kWh above the floor, but it’s too cold'
        + ' to drive the radiator — the space heater is providing the heating.');
    } else if (ctx.hoursUntilBackupNeeded !== null) {
      notes.push('Tank stores ~' + stored + ' kWh above the floor — covers greenhouse heating'
        + ' for about ~' + Math.round(ctx.hoursUntilBackupNeeded) + ' h before the space heater kicks in.');
    } else {
      notes.push('Tank stores ~' + stored + ' kWh above the floor'
        + ' — enough for the whole window with no backup needed.');
    }
  }
  if (ctx.electricKwh > 0 && notes.length < 3) {
    notes.push('Space heater projected: ~' + Math.round(ctx.electricKwh)
      + ' kWh over the next 48 h, costing about €' + ctx.electricCostEur.toFixed(2) + '.');
  }
  return notes;
}

module.exports = { computeMlForecast };
