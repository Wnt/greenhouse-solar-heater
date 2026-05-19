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
const { tankStoredEnergyKwh } = require('../../energy-balance');

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
  // solar_charging. Empirical: in the training history solar_charging
  // hours sit at a median ~550 W/m^2 vs ~44 for idle; ~150 cleanly
  // separates active charging from residual cloud.
  solarChargeRadiationMinWm2: 150,
  weatherFetchedAt: null,
};

// Feature indices whose drift outside the trained envelope means the
// model is extrapolating (winter cold, an unseen tank regime, ...).
const OOD_FEATURE_INDICES = [0, 4, 5]; // wx_temp_c, tank_avg_c, greenhouse_c

function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
function round2(v) { return Math.round(v * 100) / 100; }
function round4(v) { return Math.round(v * 10000) / 10000; }

function helsinkiHHMM(ms) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms));
}

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

  const tankTrajectory = [];
  const greenhouseTrajectory = [];
  const modeForecast = [];
  const costBreakdown = [];
  let electricKwh = 0;
  let electricCostEur = 0;
  let solarChargingHours = 0;
  let greenhouseHeatingHours = 0;
  let hoursUntilFloor = null;
  let hoursUntilBackupNeeded = opts.emergencyRecentlyActive ? 0 : null;
  // OOD time is summed in hours (steps have unequal length).
  let oodHours = 0;

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
    if (gh < cfg.emergencyEnterC) {
      if (heatMode !== 'emergency_heating' && hoursUntilBackupNeeded === null) {
        hoursUntilBackupNeeded = elapsedH;
      }
      heatMode = 'emergency_heating';
    } else if (heatMode === 'emergency_heating' && gh > cfg.emergencyExitC) {
      heatMode = (gh < cfg.greenhouseEnterC && tankCanEnter) ? 'greenhouse_heating' : 'idle';
    } else if (gh < cfg.greenhouseEnterC && heatMode === 'idle' && tankCanEnter) {
      heatMode = 'greenhouse_heating';
    } else if (heatMode === 'greenhouse_heating' && (gh > cfg.greenhouseExitC || !tankCanSustain)) {
      heatMode = 'idle';
    }
    // solar_charging is an exclusive mode in the training data; model it
    // as an overlay on an idle step when the sun is strong and the tank
    // still has headroom.
    let mode = heatMode;
    if (heatMode === 'idle' && radiation >= cfg.solarChargeRadiationMinWm2 && tankAvg < cfg.tankMaxC) {
      mode = 'solar_charging';
    }

    // ── Backup electricity (emergency steps only) ──
    let duty = null;
    if (mode === 'emergency_heating') {
      const ghTarget = (cfg.emergencyEnterC + cfg.emergencyExitC) / 2;
      const ghLossW = cfg.greenhouseLossWPerK * Math.max(0, ghTarget - outdoorC);
      const radDeliveredW = Math.min(
        cfg.radiatorPowerKw * 1000,
        cfg.radiatorUaWPerK * Math.max(0, tankAvg - gh)
      );
      const heaterW = cfg.spaceHeaterKw * 1000;
      duty = Math.min(1, Math.max(0, ghLossW - radDeliveredW) / heaterW);
      const kwh = duty * cfg.spaceHeaterKw * stepH;
      if (kwh > 0) {
        electricKwh += kwh;
        const eur = kwh * (priceCKwh + cfg.transferFeeCKwh) / 100;
        electricCostEur += eur;
        costBreakdown.push({ ts: tIso, kWh: round4(kwh), priceCKwh, eurInclTransfer: round4(eur) });
      }
    }
    if (mode === 'solar_charging') solarChargingHours += stepH;
    if (mode === 'greenhouse_heating') greenhouseHeatingHours += stepH;
    modeForecast.push(duty !== null ? { ts: tIso, mode, duty: round2(duty) } : { ts: tIso, mode });

    // Fan-cooling overlay — own hysteresis on the predicted greenhouse
    // temperature, can be active under any mode.
    if (gh > cfg.fanCoolEnterC) fanCooling = true;
    else if (gh < cfg.fanCoolExitC) fanCooling = false;

    // ── ML thermal step ──
    const frac = {};
    frac[mode] = 1;
    const aux = { heaterOn: typeof duty === 'number' ? duty : 0, fanCooling: fanCooling ? 1 : 0 };
    const row = featureRow(tankAvg, gh, outdoorC, wx, frac, aux, tMs, stepMs);
    if (outOfRangeCount(row, model.featureRanges) > 0) oodHours += stepH;

    const prevTankAvg = tankAvg;
    tankAvg += rf.predictForest(model.tank, row);
    gh += rf.predictForest(model.greenhouse, row);
    if (gh < outdoorC) gh = outdoorC; // can't fall below the outdoor air

    if (hoursUntilFloor === null && tankAvg < cfg.tankFloorC && prevTankAvg >= cfg.tankFloorC) {
      hoursUntilFloor = elapsedH + stepH * (prevTankAvg - cfg.tankFloorC) / (prevTankAvg - tankAvg);
    }
    elapsedMs += stepMs;
  }

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
