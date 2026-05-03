'use strict';

// sustain-forecast.js — pure 48 h tank sustain forecast engine.
// No I/O. No npm deps.
//
// Timezone: hour-of-day is computed via Intl.DateTimeFormat with
// timeZone: 'Europe/Helsinki' so the shading mask and user-facing
// hour notes are correct regardless of the server's TZ env (k8s
// pods default to UTC).
//
// Exports:
//   fitSolarEffectivenessByHour(history) → number[24]  (per-hour relative effectiveness)
//   fitEmpiricalCoefficients(history) → { tankLeakageWPerK, greenhouseLossWPerKBase,
//                                          windFactor, solarEffectivenessByHour }
//   computeSustainForecast({ now, tankTop, tankBottom, greenhouseTemp, currentMode,
//                            weather48h, prices48h, coefficients, config }) → forecast

const fit = require('./sustain-forecast-fit');
const TANK_THERMAL_MASS_J_PER_K = fit.TANK_THERMAL_MASS_J_PER_K;
const GH_THERMAL_MASS_J_PER_K   = fit.GH_THERMAL_MASS_J_PER_K;
const DEFAULT_SOLAR_EFFECTIVENESS = fit.DEFAULT_SOLAR_EFFECTIVENESS;
const helsinkiHour  = fit.helsinkiHour;
const helsinkiHHMM  = fit.helsinkiHHMM;
const fitSolarEffectivenessByHour = fit.fitSolarEffectivenessByHour;
const fitEmpiricalCoefficients    = fit.fitEmpiricalCoefficients;

// Engine fallbacks: used only when a caller passes a coefficients object
// missing a field (the fit module owns the canonical defaults).
const DEFAULT_TANK_LEAKAGE_W_PER_K = 3.0;
const DEFAULT_GH_LOSS_W_PER_K_BASE = 25.0;
const DEFAULT_WIND_FACTOR          = 0.05;

const SECONDS_PER_HOUR = 3600;


// ── Default config ──
const DEFAULT_CONFIG = {
  tankFloorC:               12,
  // Greenhouse heating setpoint aligned with control-logic.js
  // greenhouseEnterTemp = 10 °C, greenhouseExitTemp = 12 °C.
  // We target 10 °C as the "needs heating" threshold.
  greenhouseTargetC:        10,
  spaceHeaterKw:            1,    // from system.yaml space_heater.assumed_continuous_power_kw
  transferFeeCKwh:          5,    // from system.yaml electricity.transfer_fee_c_kwh
  collectorAreaM2:          4,    // from system.yaml (approx)
  collectorEfficiency:      0.5,  // empirical placeholder
  solarChargeMinRadiationWm2: 200,
  // Confidence boost: set this to a recent Date when weather was fetched
  weatherFetchedAt:         null,
  // Number of buckets used for the empirical fit (for confidence)
  fitBucketCount:           0,
};

/**
 * Compute 48 h sustain forecast.
 *
 * @param {object} opts
 *   opts.now             — Date or ms timestamp
 *   opts.tankTop         — °C
 *   opts.tankBottom      — °C
 *   opts.greenhouseTemp  — °C
 *   opts.currentMode     — string (unused in simulation but noted in output)
 *   opts.weather48h      — [{ ts, temperature, radiationGlobal, windSpeed }] length ≥ 48
 *   opts.prices48h       — [{ ts, priceCKwh }] length ≥ 48 (one per hour)
 *   opts.coefficients    — from fitEmpiricalCoefficients()
 *   opts.config          — override DEFAULT_CONFIG fields
 * @returns forecast object
 */
function computeSustainForecast(opts) {
  const now          = opts.now instanceof Date ? opts.now.getTime() : Number(opts.now || Date.now());
  const tankTop      = Number(opts.tankTop      || 20);
  const tankBottom   = Number(opts.tankBottom   || 18);
  const ghTemp       = Number(opts.greenhouseTemp || 10);
  const weather      = opts.weather48h  || [];
  const prices       = opts.prices48h   || [];
  const coeff        = opts.coefficients || {};
  const cfg          = Object.assign({}, DEFAULT_CONFIG, opts.config || {});

  const tankLeakageWPerK    = typeof coeff.tankLeakageWPerK    === 'number' ? coeff.tankLeakageWPerK    : DEFAULT_TANK_LEAKAGE_W_PER_K;
  const ghLossWPerKBase     = typeof coeff.greenhouseLossWPerKBase === 'number' ? coeff.greenhouseLossWPerKBase : DEFAULT_GH_LOSS_W_PER_K_BASE;
  const windFactor          = typeof coeff.windFactor          === 'number' ? coeff.windFactor          : DEFAULT_WIND_FACTOR;
  const solarEffByHour      = Array.isArray(coeff.solarEffectivenessByHour) && coeff.solarEffectivenessByHour.length === 24
    ? coeff.solarEffectivenessByHour
    : DEFAULT_SOLAR_EFFECTIVENESS;
  // usedDefaults is true when the caller explicitly set it, OR when no real
  // coefficient values were provided (empty object or coefficients not from fit).
  const usedDefaults = coeff.usedDefaults === true ||
    (typeof coeff.tankLeakageWPerK !== 'number' && typeof coeff.greenhouseLossWPerKBase !== 'number');
  const fitBuckets          = typeof cfg.fitBucketCount === 'number' ? cfg.fitBucketCount : 0;

  // ── Simulation state ──
  let tankTopC    = tankTop;
  let tankBotC    = tankBottom;
  let curGhTemp   = ghTemp;

  // Accumulators
  let electricKwh       = 0;
  let electricCostEur   = 0;
  let solarChargingHours     = 0;
  let greenhouseHeatingHours = 0;
  let hoursUntilFloor        = null;
  // Hours until tank can no longer cover the greenhouse heating load alone.
  // Always ≤ hoursUntilFloor — tank stops being able to heat the greenhouse
  // (avg ≤ floor + 5°C) before it actually crosses the floor. This is the
  // metric that matters operationally: it's when the space heater starts
  // taking over, not when stored heat is fully exhausted.
  let hoursUntilBackupNeeded = null;
  const costBreakdown          = [];
  const tankTrajectory         = [];
  const ghTrajectory           = [];

  const HOURS = 48;

  for (let h = 0; h < HOURS; h++) {
    const hourMs    = now + h * SECONDS_PER_HOUR * 1000;
    const hourDate  = new Date(hourMs).toISOString();

    const tankAvg = (tankTopC + tankBotC) / 2;

    // ── Check floor crossing at start of this hour ──
    if (hoursUntilFloor === null && tankAvg < cfg.tankFloorC) {
      // Interpolate: how far into the previous hour did we cross?
      // Already below — happened during the previous step.
      // Mark as this hour (we'll refine below when we detect the crossing).
      hoursUntilFloor = h;
    }

    // Record trajectory at start of hour
    tankTrajectory.push({ ts: hourDate, top: round2(tankTopC), bottom: round2(tankBotC), avg: round2(tankAvg) });
    ghTrajectory.push({ ts: hourDate, temp: round2(curGhTemp) });

    // ── Weather for this hour ──
    const wx = weather[h] || weather[weather.length - 1] || { temperature: 0, radiationGlobal: 0, windSpeed: 0 };
    const outdoorC   = typeof wx.temperature     === 'number' ? wx.temperature     : 0;
    const radiation  = typeof wx.radiationGlobal === 'number' ? wx.radiationGlobal : 0;
    const wind       = typeof wx.windSpeed       === 'number' ? wx.windSpeed       : 0;

    // ── Price for this hour ──
    const px = prices[h] || prices[prices.length - 1] || { priceCKwh: 10 };
    const priceCKwh = typeof px.priceCKwh === 'number' ? px.priceCKwh : 10;

    // ── 1. Heat losses ──
    // Tank loses heat to greenhouse (ambient)
    let tankLossW = tankLeakageWPerK * (tankAvg - curGhTemp);
    if (tankLossW < 0) tankLossW = 0; // tank can't gain from GH in this simplified model

    // Greenhouse loses heat to outdoor (with wind multiplier)
    let ghLossW = ghLossWPerKBase * (1 + windFactor * wind) * (curGhTemp - outdoorC);
    if (ghLossW < 0) ghLossW = 0; // greenhouse doesn't gain from outdoor in this model

    // Energy removed from / added to tank and greenhouse this hour (Joules)
    let tankDeltaJ = -tankLossW * SECONDS_PER_HOUR;
    let ghDeltaJ   = -ghLossW  * SECONDS_PER_HOUR;

    // ── 2. Greenhouse heating need ──
    if (curGhTemp < cfg.greenhouseTargetC) {
      // Greenhouse needs heat.
      if (tankAvg > cfg.tankFloorC + 5) {
        // Tank has enough — simulate greenhouse_heating mode.
        // The tank supplies ghLossW (to cover GH losses) plus its own natural losses.
        // Simplified: tank absorbs the greenhouse loss into itself.
        const heatDeliveredJ = ghLossW * SECONDS_PER_HOUR;
        // Greenhouse receives heat back (net: covered)
        ghDeltaJ += heatDeliveredJ;
        // Tank pays for it
        tankDeltaJ -= heatDeliveredJ;
        greenhouseHeatingHours += 1;
      } else {
        // Tank too depleted — space heater runs for the hour.
        if (hoursUntilBackupNeeded === null) hoursUntilBackupNeeded = h;
        const heaterEnergyKwh = cfg.spaceHeaterKw; // 1 kW × 1 h = 1 kWh
        electricKwh += heaterEnergyKwh;
        const costEur = heaterEnergyKwh * (priceCKwh + cfg.transferFeeCKwh) / 100;
        electricCostEur += costEur;
        costBreakdown.push({
          ts:            hourDate,
          kWh:           heaterEnergyKwh,
          priceCKwh,
          eurInclTransfer: round4(costEur),
        });
        // Space heater covers greenhouse heat need.
        ghDeltaJ += cfg.spaceHeaterKw * 1000 * SECONDS_PER_HOUR;
      }
    }

    // ── 3. Solar charging credit ──
    // Two gates must both pass:
    //   a) FMI radiation > threshold (there is sun in the sky at all)
    //   b) solarEffByHour[localHour] > 0 (the collectors actually see it)
    const hourOfDay = helsinkiHour(new Date(hourMs));
    const solarEff  = solarEffByHour[hourOfDay];
    let solarGainJ = 0;
    if (radiation > cfg.solarChargeMinRadiationWm2 && solarEff > 0 && tankAvg < 60) {
      const solarGainW = cfg.collectorAreaM2 * radiation * cfg.collectorEfficiency * solarEff;
      solarGainJ = solarGainW * SECONDS_PER_HOUR;
      tankDeltaJ += solarGainJ;
      solarChargingHours += 1;
    }

    // ── 4. Update tank state ──
    const prevTankAvg = tankAvg;
    const tankAvgDeltaC = tankDeltaJ / TANK_THERMAL_MASS_J_PER_K;

    if (solarGainJ > 0) {
      // On charge: 60% gain goes to top, 40% to bottom (stratification).
      const gainTop = solarGainJ * 0.6;
      const gainBot = solarGainJ * 0.4;
      const lossTop = tankLossW * SECONDS_PER_HOUR * 0.5;
      const lossBot = tankLossW * SECONDS_PER_HOUR * 0.5;
      // GH-mode draw from top
      const drawJ = Math.max(0, -tankDeltaJ - solarGainJ + (tankLossW * SECONDS_PER_HOUR));
      // Actually compute per-node simply:
      const topDeltaJ = gainTop - lossTop - drawJ * 0.6;
      const botDeltaJ = gainBot - lossBot - drawJ * 0.4;
      tankTopC += topDeltaJ / (TANK_THERMAL_MASS_J_PER_K / 2);
      tankBotC += botDeltaJ / (TANK_THERMAL_MASS_J_PER_K / 2);
    } else {
      // Even loss: split equally between top and bottom.
      const halfDeltaC = tankAvgDeltaC / 2;
      tankTopC += halfDeltaC;
      tankBotC += halfDeltaC;
    }

    // ── 5. Greenhouse temperature update ──
    curGhTemp += ghDeltaJ / GH_THERMAL_MASS_J_PER_K;
    // Clamp: greenhouse can't go below outdoor (passive equilibrium).
    if (curGhTemp < outdoorC) curGhTemp = outdoorC;

    // ── Floor crossing detection (interpolated) ──
    const newTankAvg = (tankTopC + tankBotC) / 2;
    if (hoursUntilFloor === null && newTankAvg < cfg.tankFloorC && prevTankAvg >= cfg.tankFloorC) {
      // Interpolate within this hour.
      const fraction = (prevTankAvg - cfg.tankFloorC) / (prevTankAvg - newTankAvg);
      hoursUntilFloor = h + fraction;
    }
  }

  // Append final-hour trailing point.
  const finalDate = new Date(now + HOURS * SECONDS_PER_HOUR * 1000).toISOString();
  const finalAvg  = (tankTopC + tankBotC) / 2;
  tankTrajectory.push({ ts: finalDate, top: round2(tankTopC), bottom: round2(tankBotC), avg: round2(finalAvg) });
  ghTrajectory.push({ ts: finalDate, temp: round2(curGhTemp) });

  // ── Confidence ──
  let confidence = 'medium';
  if (usedDefaults) {
    confidence = 'low';
  } else {
    let weatherFresh = false;
    if (cfg.weatherFetchedAt) {
      const fetchedMs = cfg.weatherFetchedAt instanceof Date
        ? cfg.weatherFetchedAt.getTime()
        : Number(cfg.weatherFetchedAt);
      weatherFresh = (now - fetchedMs) < 2 * 3600 * 1000;
    }
    if (fitBuckets >= 10 && weatherFresh) {
      confidence = 'high';
    }
  }

  // ── Notes ──
  const notes = buildNotes({
    now,
    solarChargingHours,
    greenhouseHeatingHours,
    electricKwh,
    hoursUntilFloor,
    hoursUntilBackupNeeded,
    usedDefaults,
    tankFloorC:              cfg.tankFloorC,
    weather48h:              weather,
    solarEffectivenessByHour: solarEffByHour,
  });

  return {
    generatedAt:            new Date(now).toISOString(),
    horizonHours:           HOURS,
    tankTrajectory,
    greenhouseTrajectory:   ghTrajectory,
    hoursUntilFloor:        hoursUntilFloor !== null ? round2(hoursUntilFloor) : null,
    hoursUntilBackupNeeded: hoursUntilBackupNeeded !== null ? round2(hoursUntilBackupNeeded) : null,
    electricKwh:            round4(electricKwh),
    electricCostEur:        round4(electricCostEur),
    costBreakdown,
    solarChargingHours,
    greenhouseHeatingHours,
    modelConfidence:        confidence,
    notes,
  };
}

// ── Note generation ──
function buildNotes(ctx) {
  const notes = [];

  if (ctx.usedDefaults) {
    notes.push('Forecast based on default coefficients — model still warming up with limited history.');
  }

  if (ctx.solarChargingHours > 0) {
    // Find the peak solar window using weather array.
    let peakH = -1;
    let peakR = 0;
    for (let i = 0; i < ctx.weather48h.length; i++) {
      if (ctx.weather48h[i] && ctx.weather48h[i].radiationGlobal > peakR) {
        peakR = ctx.weather48h[i].radiationGlobal;
        peakH = i;
      }
    }
    const dayLabel = peakH >= 24 ? 'Tomorrow' : 'Today';
    const solNote = dayLabel + ': ' + ctx.solarChargingHours + ' h of solar charging projected.';
    if (notes.length < 3) notes.push(solNote);
  }

  // Backup-needed note: tank can heat the greenhouse for X hours, then space
  // heater takes over. This is the operationally meaningful "tank lasts" point.
  if (ctx.hoursUntilBackupNeeded !== null && notes.length < 3) {
    const bH = ctx.hoursUntilBackupNeeded;
    const switchDate = new Date(ctx.now + bH * 3600 * 1000);
    const hhmm = helsinkiHHMM(switchDate);
    notes.push(
      'Tank can cover greenhouse heating for ~' + Math.round(bH) +
      ' h (until ' + hhmm + '). After that the space heater takes over for ~' +
      Math.round(ctx.electricKwh) + ' h.'
    );
  } else if (ctx.electricKwh > 0 && notes.length < 3) {
    // Backup runs but tank never crosses the "can't heat" threshold (intermittent
    // need, e.g. cold snaps). Still surface the cost so €X.YZ isn't a mystery.
    notes.push(
      'Space heater projected to run ~' + Math.round(ctx.electricKwh) +
      ' h over the next 48 h.'
    );
  }

  if (ctx.hoursUntilFloor !== null && notes.length < 3) {
    const floorDate = new Date(ctx.now + ctx.hoursUntilFloor * 3600 * 1000);
    notes.push(
      'Tank reaches ' + ctx.tankFloorC + '°C floor at ~' + helsinkiHHMM(floorDate) + '.'
    );
  }

  // Collector shading window note (only when the mask comes from real history).
  if (ctx.solarEffectivenessByHour && notes.length < 3) {
    let firstEffective = -1, lastEffective = -1;
    const EFF_THRESHOLD = 0.3;
    for (let he = 0; he < 24; he++) {
      if (ctx.solarEffectivenessByHour[he] > EFF_THRESHOLD) {
        if (firstEffective === -1) firstEffective = he;
        lastEffective = he;
      }
    }
    // Only emit when the window is narrower than 10..16 (i.e. data-derived, not the flat default).
    if (firstEffective !== -1 && !(firstEffective === 10 && lastEffective === 16)) {
      const winNote = 'Collectors typically gain heat from ' + pad2(firstEffective) + ':00 to ' + pad2(lastEffective) + ':00 based on the past 14 days.';
      notes.push(winNote);
    }
  }

  return notes;
}

function round2(v) { return Math.round(v * 100) / 100; }
function round4(v) { return Math.round(v * 10000) / 10000; }
function pad2(n)   { return n < 10 ? '0' + n : '' + n; }

module.exports = {
  fitSolarEffectivenessByHour,
  fitEmpiricalCoefficients,
  computeSustainForecast,
  // Exported for tests
  _TANK_THERMAL_MASS_J_PER_K: TANK_THERMAL_MASS_J_PER_K,
  _GH_THERMAL_MASS_J_PER_K:   GH_THERMAL_MASS_J_PER_K,
  _DEFAULT_TANK_LEAKAGE_W_PER_K:    DEFAULT_TANK_LEAKAGE_W_PER_K,
  _DEFAULT_GH_LOSS_W_PER_K_BASE:    DEFAULT_GH_LOSS_W_PER_K_BASE,
  _DEFAULT_WIND_FACTOR:             DEFAULT_WIND_FACTOR,
  _DEFAULT_SOLAR_EFFECTIVENESS:     DEFAULT_SOLAR_EFFECTIVENESS,
};
