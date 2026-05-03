'use strict';

// sustain-forecast.js — pure 48 h tank sustain forecast engine.
// No I/O. No npm deps.
//
// Timezone assumption: ts.getHours() is called in fitSolarEffectivenessByHour to group
// readings by hour-of-day. Node.js returns LOCAL time hours, so the server timezone must
// be set to Europe/Helsinki (UTC+2 / UTC+3) for the shading mask to align with solar noon.
// In production the K8s pod TZ env var is set to Europe/Helsinki. In tests, synthetic
// readings are constructed so the hour is correct regardless of test runner timezone.
//
// Exports:
//   fitSolarEffectivenessByHour(history) → number[24]  (per-hour relative effectiveness)
//   fitEmpiricalCoefficients(history) → { tankLeakageWPerK, greenhouseLossWPerKBase,
//                                          windFactor, solarEffectivenessByHour }
//   computeSustainForecast({ now, tankTop, tankBottom, greenhouseTemp, currentMode,
//                            weather48h, prices48h, coefficients, config }) → forecast

// ── Physical constants ──
var TANK_THERMAL_MASS_J_PER_K = 300 * 4186;    // 300 L × 4186 J/(kg·K) = 1.2558e6 J/K
var GH_THERMAL_MASS_J_PER_K   = 200 * 1.2 * 1005; // 200 m³ × 1.2 kg/m³ × 1005 J/(kg·K) ≈ 2.412e5 J/K
var SECONDS_PER_HOUR = 3600;

// ── Default coefficients (used when history is too sparse) ──
var DEFAULT_TANK_LEAKAGE_W_PER_K    = 3.0;   // W/K
var DEFAULT_GH_LOSS_W_PER_K_BASE    = 25.0;  // W/K
// windFactor: 5% extra greenhouse loss per m/s wind speed.
// Placeholder constant for v1 — to be empirically fit in a future version
// once we have sufficient outdoor + greenhouse + wind history.
var DEFAULT_WIND_FACTOR             = 0.05;

var MIN_IDLE_BUCKET_MINUTES = 20;
var MIN_BUCKETS_FOR_FIT     = 5;

// ── Solar effectiveness fallback ──
// Default flat effectiveness mask: hours 10..16 = 1.0, others = 0.
// Used when history is too sparse to fit real shading data.
var DEFAULT_SOLAR_EFFECTIVENESS = (function() {
  var mask = new Array(24);
  for (var h = 0; h < 24; h++) {
    mask[h] = (h >= 10 && h <= 16) ? 1.0 : 0;
  }
  return mask;
}());

// Minimum number of rows per hour-of-day to trust the fit.
var MIN_ROWS_PER_HOUR_FOR_SHADE = 3;
// Minimum peak collector-outdoor excess (K) to indicate real sun was ever observed.
var MIN_PEAK_EXCESS_K = 5;

// ── Least-squares slope through origin: slope = Σ(xi·yi) / Σ(xi²) ──
function slopeThruOrigin(xs, ys) {
  var sumXY = 0, sumX2 = 0;
  for (var i = 0; i < xs.length; i++) {
    sumXY += xs[i] * ys[i];
    sumX2 += xs[i] * xs[i];
  }
  return sumX2 === 0 ? null : sumXY / sumX2;
}

/**
 * Derive per-hour-of-day solar effectiveness from collector history.
 *
 * Algorithm:
 *   1. Group readings by local hour-of-day (via ts.getHours()).
 *   2. Per row: collectorExcess = collector − outdoor.
 *   3. Per hour: 80th-percentile of collectorExcess (captures sunny-day upper envelope).
 *   4. Normalise by global peak percentile → values in [0, 1].
 *   5. Clamp values < 0.1 to 0 (kills pre-sunrise warm-up noise).
 *
 * Falls back to the flat 10..16 mask when:
 *   - Any hour has fewer than MIN_ROWS_PER_HOUR_FOR_SHADE rows, OR
 *   - Global peak excess < MIN_PEAK_EXCESS_K (no real sun observed).
 *
 * @param {object} history  Same shape as fitEmpiricalCoefficients: { readings, modes }
 * @returns {number[24]}   Per-hour effectiveness in [0, 1].
 */
function fitSolarEffectivenessByHour(history) {
  if (!history || !Array.isArray(history.readings) || history.readings.length === 0) {
    return DEFAULT_SOLAR_EFFECTIVENESS.slice();
  }

  var readings = history.readings;

  // Group collectorExcess values by local hour-of-day.
  var byHour = [];
  for (var h = 0; h < 24; h++) { byHour.push([]); }

  for (var i = 0; i < readings.length; i++) {
    var r = readings[i];
    if (typeof r.collector !== 'number' || typeof r.outdoor !== 'number') continue;
    var ts = r.ts instanceof Date ? r.ts : new Date(r.ts);
    var hour = ts.getHours(); // local Helsinki time (server TZ = Europe/Helsinki)
    var excess = r.collector - r.outdoor;
    byHour[hour].push(excess);
  }

  // Check minimum data per hour.
  for (var h = 0; h < 24; h++) {
    if (byHour[h].length < MIN_ROWS_PER_HOUR_FOR_SHADE) {
      return DEFAULT_SOLAR_EFFECTIVENESS.slice();
    }
  }

  // Compute 80th percentile per hour.
  var percentile80 = new Array(24);
  for (var h = 0; h < 24; h++) {
    percentile80[h] = percentile(byHour[h], 0.80);
  }

  // Global peak.
  var peakExcess = percentile80[0];
  for (var h = 1; h < 24; h++) {
    if (percentile80[h] > peakExcess) peakExcess = percentile80[h];
  }

  if (peakExcess < MIN_PEAK_EXCESS_K) {
    return DEFAULT_SOLAR_EFFECTIVENESS.slice();
  }

  // Normalise and clamp noise.
  var mask = new Array(24);
  for (var h = 0; h < 24; h++) {
    var v = percentile80[h] / peakExcess;
    if (v < 0) v = 0;
    if (v > 1) v = 1;
    if (v < 0.1) v = 0;
    mask[h] = v;
  }

  return mask;
}

/** Compute the p-th percentile of a numeric array (p in [0,1]). */
function percentile(arr, p) {
  if (arr.length === 0) return 0;
  // Sort a copy.
  var sorted = arr.slice().sort(function(a, b) { return a - b; });
  var idx = p * (sorted.length - 1);
  var lo  = Math.floor(idx);
  var hi  = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  var frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Fit empirical thermal coefficients from historical sensor + mode data.
 *
 * @param {object} history
 *   history.readings  — [{ ts: Date, tankTop, tankBottom, greenhouse, outdoor, collector }] ascending
 *   history.modes     — [{ ts: Date, mode: string }] ascending
 * @returns {{ tankLeakageWPerK, greenhouseLossWPerKBase, windFactor }}
 */
function fitEmpiricalCoefficients(history) {
  var defaults = {
    tankLeakageWPerK:        DEFAULT_TANK_LEAKAGE_W_PER_K,
    greenhouseLossWPerKBase: DEFAULT_GH_LOSS_W_PER_K_BASE,
    windFactor:              DEFAULT_WIND_FACTOR,
    solarEffectivenessByHour: DEFAULT_SOLAR_EFFECTIVENESS.slice(),
    usedDefaults:            true,
  };

  if (!history || !Array.isArray(history.readings) || history.readings.length < 2) {
    return defaults;
  }

  var readings = history.readings;
  var modes    = (history.modes || []).slice();

  // Build per-reading mode labels via a forward-walking cursor.
  var modeLabels = new Array(readings.length);
  var cursor = 0;
  var currentMode = 'idle';
  // Advance past any events before the first reading.
  while (cursor < modes.length) {
    var tsMs = modes[cursor].ts instanceof Date
      ? modes[cursor].ts.getTime()
      : Number(modes[cursor].ts);
    var r0Ms = readings[0].ts instanceof Date
      ? readings[0].ts.getTime()
      : Number(readings[0].ts);
    if (tsMs <= r0Ms) { currentMode = modes[cursor].mode; cursor++; }
    else break;
  }
  modeLabels[0] = currentMode;
  for (var i = 1; i < readings.length; i++) {
    var rMs = readings[i].ts instanceof Date
      ? readings[i].ts.getTime()
      : Number(readings[i].ts);
    while (cursor < modes.length) {
      var mMs = modes[cursor].ts instanceof Date
        ? modes[cursor].ts.getTime()
        : Number(modes[cursor].ts);
      if (mMs <= rMs) { currentMode = modes[cursor].mode; cursor++; }
      else break;
    }
    modeLabels[i] = currentMode;
  }

  // Bucket consecutive idle stretches: for each idle period of ≥ MIN_IDLE_BUCKET_MINUTES
  // total duration, emit one data point per consecutive reading pair within that period.
  // This produces multiple (deltaK, powerW) samples from a single long idle run.
  var tankXs = [], tankYs = [];
  var ghXs   = [], ghYs   = [];

  var bucketStart = -1;
  for (var j = 0; j <= readings.length; j++) {
    var isIdle = j < readings.length && modeLabels[j] === 'idle';
    if (isIdle && bucketStart === -1) {
      bucketStart = j;
    } else if (!isIdle && bucketStart !== -1) {
      var bucketEnd = j - 1;
      var r0span = readings[bucketStart];
      var r1span = readings[bucketEnd];
      var t0SpanMs = r0span.ts instanceof Date ? r0span.ts.getTime() : Number(r0span.ts);
      var t1SpanMs = r1span.ts instanceof Date ? r1span.ts.getTime() : Number(r1span.ts);
      var spanDtMin = (t1SpanMs - t0SpanMs) / 60000;

      if (spanDtMin >= MIN_IDLE_BUCKET_MINUTES) {
        // Emit one data point per consecutive pair within this idle period.
        for (var p = bucketStart; p < bucketEnd; p++) {
          var r0 = readings[p];
          var r1 = readings[p + 1];
          var t0Ms = r0.ts instanceof Date ? r0.ts.getTime() : Number(r0.ts);
          var t1Ms = r1.ts instanceof Date ? r1.ts.getTime() : Number(r1.ts);
          var dtMs = t1Ms - t0Ms;
          if (dtMs <= 0) continue;
          var dtSec = dtMs / 1000;
          // Tank leakage sample.
          var tankAvg0 = (r0.tankTop + r0.tankBottom) / 2;
          var tankAvg1 = (r1.tankTop + r1.tankBottom) / 2;
          var ghMid    = ((r0.greenhouse || 0) + (r1.greenhouse || 0)) / 2;
          var dTankAvg = tankAvg1 - tankAvg0;
          var dTankK   = dTankAvg / dtSec;              // K/s
          var powerW   = dTankK * TANK_THERMAL_MASS_J_PER_K;  // W (negative = losing)
          var deltaK   = ((tankAvg0 + tankAvg1) / 2) - ghMid; // tank-greenhouse ΔK
          if (deltaK > 2 && isFinite(powerW) && isFinite(deltaK)) {
            tankXs.push(deltaK);
            tankYs.push(-powerW);  // positive = loss
          }
          // Greenhouse loss sample.
          if (r0.outdoor !== undefined && r1.outdoor !== undefined &&
              r0.greenhouse !== undefined && r1.greenhouse !== undefined) {
            var ghAvgPair = (r0.greenhouse + r1.greenhouse) / 2;
            var outAvg    = (r0.outdoor + r1.outdoor) / 2;
            var dGhAvg    = r1.greenhouse - r0.greenhouse;
            var dGhK      = dGhAvg / dtSec;
            var ghPowerW  = dGhK * GH_THERMAL_MASS_J_PER_K;
            var ghDeltaK  = ghAvgPair - outAvg;
            if (ghDeltaK > 1 && isFinite(ghPowerW) && isFinite(ghDeltaK)) {
              ghXs.push(ghDeltaK);
              ghYs.push(-ghPowerW);
            }
          }
        }
      }
      bucketStart = -1;
    }
  }

  if (tankXs.length < MIN_BUCKETS_FOR_FIT && ghXs.length < MIN_BUCKETS_FOR_FIT) {
    return defaults;
  }

  var tankSlope = tankXs.length >= MIN_BUCKETS_FOR_FIT
    ? slopeThruOrigin(tankXs, tankYs)
    : null;
  var ghSlope = ghXs.length >= MIN_BUCKETS_FOR_FIT
    ? slopeThruOrigin(ghXs, ghYs)
    : null;

  return {
    tankLeakageWPerK:        tankSlope  !== null && tankSlope  > 0 ? tankSlope  : DEFAULT_TANK_LEAKAGE_W_PER_K,
    greenhouseLossWPerKBase: ghSlope    !== null && ghSlope    > 0 ? ghSlope    : DEFAULT_GH_LOSS_W_PER_K_BASE,
    windFactor:              DEFAULT_WIND_FACTOR,
    solarEffectivenessByHour: fitSolarEffectivenessByHour(history),
    usedDefaults:            (tankSlope === null && ghSlope === null),
  };
}

// ── Default config ──
var DEFAULT_CONFIG = {
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
  var now          = opts.now instanceof Date ? opts.now.getTime() : Number(opts.now || Date.now());
  var tankTop      = Number(opts.tankTop      || 20);
  var tankBottom   = Number(opts.tankBottom   || 18);
  var ghTemp       = Number(opts.greenhouseTemp || 10);
  var weather      = opts.weather48h  || [];
  var prices       = opts.prices48h   || [];
  var coeff        = opts.coefficients || {};
  var cfg          = Object.assign({}, DEFAULT_CONFIG, opts.config || {});

  var tankLeakageWPerK    = typeof coeff.tankLeakageWPerK    === 'number' ? coeff.tankLeakageWPerK    : DEFAULT_TANK_LEAKAGE_W_PER_K;
  var ghLossWPerKBase     = typeof coeff.greenhouseLossWPerKBase === 'number' ? coeff.greenhouseLossWPerKBase : DEFAULT_GH_LOSS_W_PER_K_BASE;
  var windFactor          = typeof coeff.windFactor          === 'number' ? coeff.windFactor          : DEFAULT_WIND_FACTOR;
  var solarEffByHour      = Array.isArray(coeff.solarEffectivenessByHour) && coeff.solarEffectivenessByHour.length === 24
    ? coeff.solarEffectivenessByHour
    : DEFAULT_SOLAR_EFFECTIVENESS;
  // usedDefaults is true when the caller explicitly set it, OR when no real
  // coefficient values were provided (empty object or coefficients not from fit).
  var usedDefaults = coeff.usedDefaults === true ||
    (typeof coeff.tankLeakageWPerK !== 'number' && typeof coeff.greenhouseLossWPerKBase !== 'number');
  var fitBuckets          = typeof cfg.fitBucketCount === 'number' ? cfg.fitBucketCount : 0;

  // ── Simulation state ──
  var tankTopC    = tankTop;
  var tankBotC    = tankBottom;
  var curGhTemp   = ghTemp;

  // Accumulators
  var electricKwh       = 0;
  var electricCostEur   = 0;
  var solarChargingHours     = 0;
  var greenhouseHeatingHours = 0;
  var hoursUntilFloor        = null;
  var costBreakdown          = [];
  var tankTrajectory         = [];
  var ghTrajectory           = [];

  var HOURS = 48;

  for (var h = 0; h < HOURS; h++) {
    var hourMs    = now + h * SECONDS_PER_HOUR * 1000;
    var hourDate  = new Date(hourMs).toISOString();

    var tankAvg = (tankTopC + tankBotC) / 2;

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
    var wx = weather[h] || weather[weather.length - 1] || { temperature: 0, radiationGlobal: 0, windSpeed: 0 };
    var outdoorC   = typeof wx.temperature     === 'number' ? wx.temperature     : 0;
    var radiation  = typeof wx.radiationGlobal === 'number' ? wx.radiationGlobal : 0;
    var wind       = typeof wx.windSpeed       === 'number' ? wx.windSpeed       : 0;

    // ── Price for this hour ──
    var px = prices[h] || prices[prices.length - 1] || { priceCKwh: 10 };
    var priceCKwh = typeof px.priceCKwh === 'number' ? px.priceCKwh : 10;

    // ── 1. Heat losses ──
    // Tank loses heat to greenhouse (ambient)
    var tankLossW = tankLeakageWPerK * (tankAvg - curGhTemp);
    if (tankLossW < 0) tankLossW = 0; // tank can't gain from GH in this simplified model

    // Greenhouse loses heat to outdoor (with wind multiplier)
    var ghLossW = ghLossWPerKBase * (1 + windFactor * wind) * (curGhTemp - outdoorC);
    if (ghLossW < 0) ghLossW = 0; // greenhouse doesn't gain from outdoor in this model

    // Energy removed from / added to tank and greenhouse this hour (Joules)
    var tankDeltaJ = -tankLossW * SECONDS_PER_HOUR;
    var ghDeltaJ   = -ghLossW  * SECONDS_PER_HOUR;

    // ── 2. Greenhouse heating need ──
    var heaterUsed = false;
    if (curGhTemp < cfg.greenhouseTargetC) {
      // Greenhouse needs heat.
      if (tankAvg > cfg.tankFloorC + 5) {
        // Tank has enough — simulate greenhouse_heating mode.
        // The tank supplies ghLossW (to cover GH losses) plus its own natural losses.
        // Simplified: tank absorbs the greenhouse loss into itself.
        var heatDeliveredJ = ghLossW * SECONDS_PER_HOUR;
        // Greenhouse receives heat back (net: covered)
        ghDeltaJ += heatDeliveredJ;
        // Tank pays for it
        tankDeltaJ -= heatDeliveredJ;
        greenhouseHeatingHours += 1;
      } else {
        // Tank too depleted — space heater runs for the hour.
        var heaterEnergyKwh = cfg.spaceHeaterKw; // 1 kW × 1 h = 1 kWh
        electricKwh += heaterEnergyKwh;
        var costEur = heaterEnergyKwh * (priceCKwh + cfg.transferFeeCKwh) / 100;
        electricCostEur += costEur;
        costBreakdown.push({
          ts:            hourDate,
          kWh:           heaterEnergyKwh,
          priceCKwh:     priceCKwh,
          eurInclTransfer: round4(costEur),
        });
        // Space heater covers greenhouse heat need.
        ghDeltaJ += cfg.spaceHeaterKw * 1000 * SECONDS_PER_HOUR;
        heaterUsed = true;
      }
    }

    // ── 3. Solar charging credit ──
    // Two gates must both pass:
    //   a) FMI radiation > threshold (there is sun in the sky at all)
    //   b) solarEffByHour[localHour] > 0 (the collectors actually see it)
    var hourOfDay = new Date(hourMs).getHours(); // local TZ (Europe/Helsinki in prod)
    var solarEff  = solarEffByHour[hourOfDay];
    var solarGainJ = 0;
    if (radiation > cfg.solarChargeMinRadiationWm2 && solarEff > 0 && tankAvg < 60) {
      var solarGainW = cfg.collectorAreaM2 * radiation * cfg.collectorEfficiency * solarEff;
      solarGainJ = solarGainW * SECONDS_PER_HOUR;
      tankDeltaJ += solarGainJ;
      solarChargingHours += 1;
    }

    // ── 4. Update tank state ──
    var prevTankAvg = tankAvg;
    var tankAvgDeltaC = tankDeltaJ / TANK_THERMAL_MASS_J_PER_K;

    if (solarGainJ > 0) {
      // On charge: 60% gain goes to top, 40% to bottom (stratification).
      var gainTop = solarGainJ * 0.6;
      var gainBot = solarGainJ * 0.4;
      var lossTop = tankLossW * SECONDS_PER_HOUR * 0.5;
      var lossBot = tankLossW * SECONDS_PER_HOUR * 0.5;
      // GH-mode draw from top
      var drawJ = Math.max(0, -tankDeltaJ - solarGainJ + (tankLossW * SECONDS_PER_HOUR));
      // Actually compute per-node simply:
      var topDeltaJ = gainTop - lossTop - drawJ * 0.6;
      var botDeltaJ = gainBot - lossBot - drawJ * 0.4;
      tankTopC += topDeltaJ / (TANK_THERMAL_MASS_J_PER_K / 2);
      tankBotC += botDeltaJ / (TANK_THERMAL_MASS_J_PER_K / 2);
    } else {
      // Even loss: split equally between top and bottom.
      var halfDeltaC = tankAvgDeltaC / 2;
      tankTopC += halfDeltaC;
      tankBotC += halfDeltaC;
    }

    // ── 5. Greenhouse temperature update ──
    curGhTemp += ghDeltaJ / GH_THERMAL_MASS_J_PER_K;
    // Clamp: greenhouse can't go below outdoor (passive equilibrium).
    if (curGhTemp < outdoorC) curGhTemp = outdoorC;

    // ── Floor crossing detection (interpolated) ──
    var newTankAvg = (tankTopC + tankBotC) / 2;
    if (hoursUntilFloor === null && newTankAvg < cfg.tankFloorC && prevTankAvg >= cfg.tankFloorC) {
      // Interpolate within this hour.
      var fraction = (prevTankAvg - cfg.tankFloorC) / (prevTankAvg - newTankAvg);
      hoursUntilFloor = h + fraction;
    }
  }

  // Append final-hour trailing point.
  var finalDate = new Date(now + HOURS * SECONDS_PER_HOUR * 1000).toISOString();
  var finalAvg  = (tankTopC + tankBotC) / 2;
  tankTrajectory.push({ ts: finalDate, top: round2(tankTopC), bottom: round2(tankBotC), avg: round2(finalAvg) });
  ghTrajectory.push({ ts: finalDate, temp: round2(curGhTemp) });

  // ── Confidence ──
  var confidence = 'medium';
  if (usedDefaults) {
    confidence = 'low';
  } else {
    var weatherFresh = false;
    if (cfg.weatherFetchedAt) {
      var fetchedMs = cfg.weatherFetchedAt instanceof Date
        ? cfg.weatherFetchedAt.getTime()
        : Number(cfg.weatherFetchedAt);
      weatherFresh = (now - fetchedMs) < 2 * 3600 * 1000;
    }
    if (fitBuckets >= 10 && weatherFresh) {
      confidence = 'high';
    }
  }

  // ── Notes ──
  var notes = buildNotes({
    solarChargingHours:      solarChargingHours,
    greenhouseHeatingHours:  greenhouseHeatingHours,
    electricKwh:             electricKwh,
    hoursUntilFloor:         hoursUntilFloor,
    usedDefaults:            usedDefaults,
    tankFloorC:              cfg.tankFloorC,
    weather48h:              weather,
    solarEffectivenessByHour: solarEffByHour,
  });

  return {
    generatedAt:            new Date(now).toISOString(),
    horizonHours:           HOURS,
    tankTrajectory:         tankTrajectory,
    greenhouseTrajectory:   ghTrajectory,
    hoursUntilFloor:        hoursUntilFloor !== null ? round2(hoursUntilFloor) : null,
    electricKwh:            round4(electricKwh),
    electricCostEur:        round4(electricCostEur),
    costBreakdown:          costBreakdown,
    solarChargingHours:     solarChargingHours,
    greenhouseHeatingHours: greenhouseHeatingHours,
    modelConfidence:        confidence,
    notes:                  notes,
  };
}

// ── Note generation ──
function buildNotes(ctx) {
  var notes = [];

  if (ctx.usedDefaults) {
    notes.push('Forecast based on default coefficients — model still warming up with limited history.');
  }

  if (ctx.solarChargingHours > 0) {
    // Find the peak solar window using weather array.
    var peakH = -1;
    var peakR = 0;
    for (var i = 0; i < ctx.weather48h.length; i++) {
      if (ctx.weather48h[i] && ctx.weather48h[i].radiationGlobal > peakR) {
        peakR = ctx.weather48h[i].radiationGlobal;
        peakH = i;
      }
    }
    var dayLabel = peakH >= 24 ? 'Tomorrow' : 'Today';
    var solNote = dayLabel + ': ' + ctx.solarChargingHours + ' h of solar charging projected.';
    if (notes.length < 3) notes.push(solNote);
  }

  if (ctx.hoursUntilFloor !== null) {
    var floorH = ctx.hoursUntilFloor;
    var floorDate = new Date(Date.now() + floorH * 3600 * 1000);
    var hhmm = pad2(floorDate.getUTCHours()) + ':' + pad2(floorDate.getUTCMinutes());
    var backupH = Math.ceil(48 - floorH);
    var floorNote = 'Tank reaches ' + ctx.tankFloorC + '°C floor at ~' + hhmm + 'Z, after which the space heater may run for up to ' + backupH + ' h.';
    if (notes.length < 3) notes.push(floorNote);
  }

  // Collector shading window note (only when the mask comes from real history).
  if (ctx.solarEffectivenessByHour && notes.length < 3) {
    var firstEffective = -1, lastEffective = -1;
    var EFF_THRESHOLD = 0.3;
    for (var he = 0; he < 24; he++) {
      if (ctx.solarEffectivenessByHour[he] > EFF_THRESHOLD) {
        if (firstEffective === -1) firstEffective = he;
        lastEffective = he;
      }
    }
    // Only emit when the window is narrower than 10..16 (i.e. data-derived, not the flat default).
    if (firstEffective !== -1 && !(firstEffective === 10 && lastEffective === 16)) {
      var winNote = 'Collectors typically gain heat from ' + pad2(firstEffective) + ':00 to ' + pad2(lastEffective) + ':00 based on the past 14 days.';
      notes.push(winNote);
    }
  }

  return notes;
}

function round2(v) { return Math.round(v * 100) / 100; }
function round4(v) { return Math.round(v * 10000) / 10000; }
function pad2(n)   { return n < 10 ? '0' + n : '' + n; }

module.exports = {
  fitSolarEffectivenessByHour: fitSolarEffectivenessByHour,
  fitEmpiricalCoefficients:    fitEmpiricalCoefficients,
  computeSustainForecast:      computeSustainForecast,
  // Exported for tests
  _TANK_THERMAL_MASS_J_PER_K: TANK_THERMAL_MASS_J_PER_K,
  _GH_THERMAL_MASS_J_PER_K:   GH_THERMAL_MASS_J_PER_K,
  _DEFAULT_TANK_LEAKAGE_W_PER_K:    DEFAULT_TANK_LEAKAGE_W_PER_K,
  _DEFAULT_GH_LOSS_W_PER_K_BASE:    DEFAULT_GH_LOSS_W_PER_K_BASE,
  _DEFAULT_WIND_FACTOR:             DEFAULT_WIND_FACTOR,
  _DEFAULT_SOLAR_EFFECTIVENESS:     DEFAULT_SOLAR_EFFECTIVENESS,
};
