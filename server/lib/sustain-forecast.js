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
  // Greenhouse-heating control thresholds. The handler reads the live
  // device-config tu.geT/gxT and overrides these per-request — the
  // defaults match shelly/control-logic.js when no user tuning is set.
  greenhouseEnterC:         10,   // controller enters heating when gh < this
  greenhouseExitC:          12,   // controller exits heating when gh > this
  // Emergency heating (space heater) trigger — when gh drops below this we
  // expect the controller to turn the space heater on. Matches the real
  // device's behaviour driven by tu.ehE / tu.ehX.
  emergencyEnterC:          8,
  spaceHeaterKw:            1,    // from system.yaml space_heater.assumed_continuous_power_kw
  transferFeeCKwh:          5,    // from system.yaml electricity.transfer_fee_c_kwh
  // Reference FMI RadiationGlobal that maps to "cloudFactor = 1" in the data-
  // driven solar gain model. ~500 W/m² is a typical partly-cloudy noon at lat
  // 60° in May (clear sky peaks ~700-900). The historical solarGainKwhByHour
  // baseline is normalised against this reference.
  cloudReferenceWm2:        500,
  // Tank stops charging around this temperature in the real controller.
  tankMaxC:                 55,
  // Threshold for counting an hour as "solar charging" in the output.
  // 0.15 kWh corresponds to roughly the gain from 30 min of typical noontime
  // operation — below this we're seeing residual cloud-modulated noise, not
  // a meaningful charging window.
  solarChargeMinKwh:        0.15,
  // Radiator output power (kW from tank to greenhouse air) — observed in data.
  radiatorPowerKw:          2.4,
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
  const currentMode  = String(opts.currentMode || 'idle');
  const weather      = opts.weather48h  || [];
  const prices       = opts.prices48h   || [];
  const coeff        = opts.coefficients || {};
  const cfg          = Object.assign({}, DEFAULT_CONFIG, opts.config || {});

  const tankLeakageWPerK    = typeof coeff.tankLeakageWPerK    === 'number' ? coeff.tankLeakageWPerK    : DEFAULT_TANK_LEAKAGE_W_PER_K;
  const solarEffByHour      = Array.isArray(coeff.solarEffectivenessByHour) && coeff.solarEffectivenessByHour.length === 24
    ? coeff.solarEffectivenessByHour
    : DEFAULT_SOLAR_EFFECTIVENESS;
  // Observed tank-drop rate during the most recent ~hour, in K/h (positive
  // = cooling). When the system is currently in heating mode we trust this
  // over the abstract "deliver exactly ghLossW" formula — it captures the
  // actual radiator output, control cycling and current outdoor delta.
  // Falls back to the empirical "while heating" rate (~2 K/h) when no
  // recent observation is available.
  const observedTankDropKPerH = typeof opts.observedTankDropKPerH === 'number'
    ? opts.observedTankDropKPerH : null;
  // Empirical kWh-to-tank gain per clock hour (averaged over the historical
  // window). The forecast loop multiplies this by a cloud factor derived from
  // the FMI radiation. Falls back to a conservative low-gain mask.
  const solarGainKwhByHour  = Array.isArray(coeff.solarGainKwhByHour) && coeff.solarGainKwhByHour.length === 24
    ? coeff.solarGainKwhByHour
    : (function () { const a = new Array(24); for (let h = 0; h < 24; h++) a[h] = (h >= 10 && h <= 16) ? 0.4 : 0; return a; }());
  // usedDefaults is true when the caller explicitly set it, OR when no real
  // coefficient values were provided (empty object or coefficients not from fit).
  const usedDefaults = coeff.usedDefaults === true ||
    (typeof coeff.tankLeakageWPerK !== 'number' && typeof coeff.greenhouseLossWPerKBase !== 'number');
  const fitBuckets          = typeof cfg.fitBucketCount === 'number' ? cfg.fitBucketCount : 0;

  // ── Simulation state ──
  let tankTopC    = tankTop;
  let tankBotC    = tankBottom;
  let curGhTemp   = ghTemp;
  // Simulated mode — initialised from the actual current device mode so
  // the engine projects "tank stays draining" behaviour from the start
  // instead of waiting until the greenhouse has cooled to enterC again.
  let simMode = (currentMode === 'greenhouse_heating' || currentMode === 'emergency_heating')
    ? currentMode : 'idle';

  // Accumulators
  let electricKwh       = 0;
  let electricCostEur   = 0;
  let solarChargingHours     = 0;
  let greenhouseHeatingHours = 0;
  // Per-day buckets keyed by Helsinki date string (YYYY-MM-DD). The engine
  // emits the sum of solar kWh added on each day so the UI can show
  // "Today: 1 kWh, Tomorrow: 7 kWh" — much more useful than a single 48 h
  // total for understanding *when* recovery happens.
  const solarKwhByDay = {};
  const dayKeyFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit',
  });
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
    const wx = weather[h] || weather[weather.length - 1] || { temperature: 0, radiationGlobal: 0 };
    const outdoorC   = typeof wx.temperature     === 'number' ? wx.temperature     : 0;
    const radiation  = typeof wx.radiationGlobal === 'number' ? wx.radiationGlobal : 0;

    // ── Price for this hour ──
    const px = prices[h] || prices[prices.length - 1] || { priceCKwh: 10 };
    const priceCKwh = typeof px.priceCKwh === 'number' ? px.priceCKwh : 10;

    // ── 1. Decide simulation mode for this hour ──
    // Hysteresis matches the device: enter heating when gh < enterC, exit
    // when gh > exitC. Persist mode across hours via simMode below the loop.
    if (curGhTemp < cfg.greenhouseEnterC && simMode !== 'greenhouse_heating' && simMode !== 'emergency_heating') {
      simMode = 'greenhouse_heating';
    } else if (curGhTemp > cfg.greenhouseExitC) {
      simMode = 'idle';
    }
    // Backup (space_heater / emergency_heating) takes over from greenhouse
    // heating once the tank can no longer sustain the load OR greenhouse
    // drops below the device's emergency threshold.
    if (simMode === 'greenhouse_heating' &&
        (tankAvg <= cfg.tankFloorC + 5 || curGhTemp < cfg.emergencyEnterC)) {
      simMode = 'emergency_heating';
      if (hoursUntilBackupNeeded === null) hoursUntilBackupNeeded = h;
    }
    if (simMode === 'emergency_heating' && tankAvg > cfg.tankFloorC + 7) {
      // Tank recovered (e.g. solar charged it) — controller hands back to
      // greenhouse_heating. Exit purely on tank state; the greenhouse-warmth
      // check is implicit (if gh is still cold, the next iteration will
      // re-enter heating mode and the radiator will take over).
      simMode = 'greenhouse_heating';
    }

    // ── 2. Tank energy balance for this hour ──
    let tankDeltaJ = 0;
    // Greenhouse temp evolves on a simple "drift toward target" curve
    // rather than a real energy balance. The greenhouse has substantial
    // hidden thermal mass (soil, plants, water, structure — easily 30 MJ/K
    // vs the 240 kJ/K of air alone) that's hard to fit, but its observed
    // behaviour is well approximated as a 30-min time constant toward
    // whatever the controller is targeting (or toward outdoor in idle).
    let ghTarget;
    if (simMode === 'greenhouse_heating') {
      // Tank drops at the OBSERVED rate when we have a recent observation
      // from a heating-mode bucket; otherwise fall back to ~2.0 K/h
      // (≈ 0.7 kW continuous, matching the historical heating-mode mean).
      const dropKPerH = (observedTankDropKPerH !== null && currentMode === 'greenhouse_heating' && h < 6)
        ? observedTankDropKPerH
        : 2.0;
      tankDeltaJ -= dropKPerH * TANK_THERMAL_MASS_J_PER_K;
      ghTarget = (cfg.greenhouseEnterC + cfg.greenhouseExitC) / 2;
      greenhouseHeatingHours += 1;
    } else if (simMode === 'emergency_heating') {
      // Backup runs continuously at spaceHeaterKw. Tank just leaks naturally.
      const tankLossW = tankLeakageWPerK * Math.max(0, tankAvg - curGhTemp);
      tankDeltaJ -= tankLossW * SECONDS_PER_HOUR;
      const heaterEnergyKwh = cfg.spaceHeaterKw;
      electricKwh += heaterEnergyKwh;
      const costEur = heaterEnergyKwh * (priceCKwh + cfg.transferFeeCKwh) / 100;
      electricCostEur += costEur;
      costBreakdown.push({
        ts:            hourDate,
        kWh:           heaterEnergyKwh,
        priceCKwh,
        eurInclTransfer: round4(costEur),
      });
      // Backup keeps greenhouse around the emergency-exit threshold.
      ghTarget = cfg.emergencyEnterC + 1;
    } else {
      // Idle. Tank loses heat slowly to ambient.
      const tankLossW = tankLeakageWPerK * Math.max(0, tankAvg - curGhTemp);
      tankDeltaJ -= tankLossW * SECONDS_PER_HOUR;
      // Greenhouse drifts toward outdoor (slowly — the structure traps heat).
      ghTarget = outdoorC;
    }
    // Simple exponential approach: alpha = 1 - exp(-Δt/τ). For Δt = 1 h and
    // τ = 0.5 h (heating modes) or τ = 6 h (idle, slower passive cooling).
    const ghTau = (simMode === 'idle') ? 6 : 0.5;
    const ghAlpha = 1 - Math.exp(-1 / ghTau);
    const newGhTemp = curGhTemp + (ghTarget - curGhTemp) * ghAlpha;
    const ghDeltaJ = 0;  // unused now (kept for readability with stratification block)
    void ghDeltaJ;

    // ── 3. Solar charging credit (data-driven) ──
    // Use the historical kWh-per-clock-hour baseline (already integrates
    // controller cycle probability, shading, typical conditions) and modulate
    // by the FMI radiation forecast so cloudy/rainy hours get scaled down and
    // sunnier-than-average hours scaled up. No raw collector physics —
    // observed history already encodes the real system response.
    //
    // Cap at tank near max temp (system stops charging around 60 °C).
    const hourOfDay   = helsinkiHour(new Date(hourMs));
    const baseGainKwh = solarGainKwhByHour[hourOfDay];
    // Reference radiation: ~500 W/m² is roughly the historical-average sunny
    // hour at noon, lat 60° in spring. Forecast hours hitting this map to
    // cloudFactor = 1; clear midday (~700) maps to ~1.4; overcast (~150)
    // maps to ~0.3; rainy (~50) maps to ~0.1.
    let cloudFactor = radiation / cfg.cloudReferenceWm2;
    if (cloudFactor < 0)   cloudFactor = 0;
    if (cloudFactor > 1.5) cloudFactor = 1.5;
    let solarGainKwh = baseGainKwh * cloudFactor;
    if (tankAvg >= cfg.tankMaxC) solarGainKwh = 0;
    const solarGainJ = solarGainKwh * 3.6e6;
    if (solarGainKwh > cfg.solarChargeMinKwh) {
      tankDeltaJ += solarGainJ;
      solarChargingHours += 1;
      const dayKey = dayKeyFmt.format(new Date(hourMs));
      solarKwhByDay[dayKey] = (solarKwhByDay[dayKey] || 0) + solarGainKwh;
    }

    // ── 4. Update tank state ──
    // Simplified stratification: solar gain skews 60/40 top/bottom; losses
    // and draws split evenly. This is a rough proxy; the trajectory's
    // real value is the avg, which is what the floor checks operate on.
    const prevTankAvg = tankAvg;
    const tankAvgDeltaC = tankDeltaJ / TANK_THERMAL_MASS_J_PER_K;
    if (solarGainJ > 0) {
      const solarDeltaC = solarGainJ / TANK_THERMAL_MASS_J_PER_K;
      const otherDeltaC = tankAvgDeltaC - solarDeltaC;
      tankTopC += solarDeltaC * 1.2 + otherDeltaC;
      tankBotC += solarDeltaC * 0.8 + otherDeltaC;
    } else {
      tankTopC += tankAvgDeltaC;
      tankBotC += tankAvgDeltaC;
    }

    // ── 5. Greenhouse temperature update ──
    curGhTemp = newGhTemp;
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

  // Sorted [{ date, kWh }] per-day breakdown; the first two entries are
  // "today" and "tomorrow" in Helsinki days (or just "today" if the 48 h
  // window straddles only one day boundary).
  const solarGainByDay = Object.keys(solarKwhByDay).sort().map(function (k) {
    return { date: k, kWh: round4(solarKwhByDay[k]) };
  });

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
    solarGainByDay,
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
    solarGainByDay,
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

  // Per-day solar gain note. Maps the first two Helsinki days of the
  // forecast horizon to "Today"/"Tomorrow" labels (or just two date
  // labels if the user is reading at midnight).
  if (Array.isArray(ctx.solarGainByDay) && ctx.solarGainByDay.length > 0 && notes.length < 3) {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ctx.now));
    const parts = ctx.solarGainByDay.slice(0, 2).map(function (d) {
      const label = d.date === today ? 'Today' : 'Tomorrow';
      const kwh = d.kWh < 0.5 ? d.kWh.toFixed(1) : Math.round(d.kWh);
      return label + ' ~' + kwh + ' kWh';
    });
    if (parts.length > 0) {
      notes.push('Solar gain projected: ' + parts.join(', ') + '.');
    }
  } else if (notes.length < 3) {
    // No solar gain at all — be explicit.
    notes.push('No useful solar gain projected over the next 48 h.');
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
  fitSolarGainByHour: fit.fitSolarGainByHour,
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
