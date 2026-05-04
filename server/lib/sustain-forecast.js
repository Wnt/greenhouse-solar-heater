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
//   fitEmpiricalCoefficients(history) → { tankLeakageWPerK, solarGainKwhByHour, usedDefaults }
//   computeSustainForecast({ now, tankTop, tankBottom, greenhouseTemp, currentMode,
//                            weather48h, prices48h, coefficients, config }) → forecast

const fit = require('./sustain-forecast-fit');
const { tankStoredEnergyKwh } = require('./energy-balance');
const TANK_THERMAL_MASS_J_PER_K = fit.TANK_THERMAL_MASS_J_PER_K;
const helsinkiHour  = fit.helsinkiHour;
const helsinkiHHMM  = fit.helsinkiHHMM;
const fitEmpiricalCoefficients = fit.fitEmpiricalCoefficients;

// Engine fallback: used only when a caller passes a coefficients object
// missing the field (the fit module owns the canonical default).
const DEFAULT_TANK_LEAKAGE_W_PER_K = 3.0;

const SECONDS_PER_HOUR = 3600;


// ── Default config ──
const DEFAULT_CONFIG = {
  tankFloorC:               12,
  // Greenhouse-heating control thresholds. The handler reads the live
  // device-config tu.geT/gxT and overrides these per-request — the
  // defaults match shelly/control-logic.js when no user tuning is set.
  greenhouseEnterC:         10,   // controller enters heating when gh < this
  greenhouseExitC:          12,   // controller exits heating when gh > this
  // Emergency heating (space heater) thresholds — gh < emergencyEnterC turns
  // the space heater on; gh > emergencyExitC turns it off. The real device
  // is driven by tu.ehE / tu.ehX; defaults here mirror control-logic.js
  // DEFAULT_CONFIG.emergencyEnterTemp (9) / .emergencyExitTemp (12).
  emergencyEnterC:          9,
  emergencyExitC:           12,
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
  // Greenhouse heat-loss coefficient (W/K). Derived from observed
  // overnight cooldown: tank delivered ~6 kWh to the greenhouse over 10 h
  // at avg ΔT ~5 K → 600 W → 120 W/K. Used to estimate the space-heater
  // duty cycle during emergency mode (heater needs to cover ghLossW =
  // greenhouseLossWPerK × (target − outdoor); duty = needed/heater_kW).
  // Without this, the engine assumes 100% duty for every emergency hour,
  // which over-counts backup energy by ~30-40% in spring/fall conditions.
  greenhouseLossWPerK:      120,
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
  // Object.assign overwrites with undefined values too, which has burned us
  // before (handler passing tuning.greenhouseEnterTemp where the field was
  // `geT` → undefined → `gh < undefined` always false → backup never fires).
  // Filter out undefined fields so they fall through to DEFAULT_CONFIG.
  const cfgOverrides = {};
  if (opts.config) {
    Object.keys(opts.config).forEach(function (k) {
      if (opts.config[k] !== undefined) cfgOverrides[k] = opts.config[k];
    });
  }
  const cfg = Object.assign({}, DEFAULT_CONFIG, cfgOverrides);

  const tankLeakageWPerK    = typeof coeff.tankLeakageWPerK    === 'number' ? coeff.tankLeakageWPerK    : DEFAULT_TANK_LEAKAGE_W_PER_K;
  // Observed tank-drop rate during the most recent ~hour, in K/h (positive
  // = cooling). When the system is currently in heating mode we trust this
  // over the abstract "deliver exactly ghLossW" formula — it captures the
  // actual radiator output, control cycling and current outdoor delta.
  // Falls back to the empirical "while heating" rate (~2 K/h) when no
  // recent observation is available.
  const observedTankDropKPerH = typeof opts.observedTankDropKPerH === 'number'
    ? opts.observedTankDropKPerH : null;
  // Observed greenhouse-temp drop rate (K/h, positive = cooling) over the
  // last ~hour. Used to project greenhouse evolution while in heating mode
  // — the real greenhouse heat balance (with soil/structure thermal mass
  // and ventilation losses) is hard to fit from sparse history, but the
  // observed rate baked-in everything that matters for the next few hours.
  const observedGhDropKPerH = typeof opts.observedGhDropKPerH === 'number'
    ? opts.observedGhDropKPerH : null;
  // Empirical kWh-to-tank gain per clock hour (averaged over the historical
  // window). The forecast loop multiplies this by a cloud factor derived from
  // the FMI radiation. Falls back to a conservative low-gain mask.
  const solarGainKwhByHour  = Array.isArray(coeff.solarGainKwhByHour) && coeff.solarGainKwhByHour.length === 24
    ? coeff.solarGainKwhByHour
    : (function () { const a = new Array(24); for (let h = 0; h < 24; h++) a[h] = (h >= 10 && h <= 16) ? 0.4 : 0; return a; }());
  // usedDefaults is true when the caller explicitly set it, OR when no real
  // coefficient values were provided (empty object or coefficients not from fit).
  const usedDefaults = coeff.usedDefaults === true ||
    typeof coeff.tankLeakageWPerK !== 'number';
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
  // Per-hour mode prediction so the UI can render predicted heating /
  // emergency / charging bands past "now" the same way the historical
  // duty-cycle bars are drawn. mode ∈ { idle, greenhouse_heating,
  // emergency_heating, solar_charging }. solar_charging is independent
  // of the heating state (the device can charge while heating); when
  // both apply the entry is duplicated with separate ts/mode pairs.
  const modeForecast           = [];

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
    // Mirror the real device's hysteresis exactly:
    //   greenhouse_heating  enters when gh < geT, exits when gh > gxT
    //   emergency_heating   enters when gh < ehE, exits when gh > ehX
    // Critically, the device triggers emergency_heating on the GREENHOUSE
    // temperature (gh < ehE), NOT on tank state. Tank getting cold doesn't
    // immediately turn the space heater on — the greenhouse first has to
    // cool because the radiator stops being able to deliver useful heat.
    // The radiator-effectiveness model below makes the greenhouse cool
    // realistically when the tank gets too close to greenhouse temp, so
    // this hits the right hour for backup.
    if (curGhTemp < cfg.emergencyEnterC) {
      if (simMode !== 'emergency_heating' && hoursUntilBackupNeeded === null) {
        hoursUntilBackupNeeded = h;
      }
      simMode = 'emergency_heating';
    } else if (simMode === 'emergency_heating' && curGhTemp > cfg.emergencyExitC) {
      // Backup exits when gh > ehX (matches the device's exit hysteresis).
      simMode = curGhTemp < cfg.greenhouseEnterC ? 'greenhouse_heating' : 'idle';
    } else if (curGhTemp < cfg.greenhouseEnterC && simMode === 'idle') {
      simMode = 'greenhouse_heating';
    } else if (curGhTemp > cfg.greenhouseExitC && simMode === 'greenhouse_heating') {
      simMode = 'idle';
    }

    // ── 2. Radiator heat transfer (this hour) ──
    // Physics: P_radiator = U×A × (T_tank − T_greenhouse), capped by
    // the radiator's peak power. UA is fitted from the current observation
    // when one is available — tankDropRate × thermal_capacity / current_ΔT
    // gives the actual UA that's currently achieving the observed transfer
    // (typically ~80-100 W/K for this car-radiator + fan setup). Falls back
    // to 80 W/K when no observation. The radiator obviously can't heat the
    // greenhouse above tank temp, since that's where the heat comes from.
    const radDeltaT = Math.max(0, tankAvg - curGhTemp);
    const radUaWPerK = (function () {
      if (observedTankDropKPerH !== null && currentMode === 'greenhouse_heating' && h === 0) {
        const observedW = observedTankDropKPerH * TANK_THERMAL_MASS_J_PER_K / SECONDS_PER_HOUR;
        const observedDeltaT = Math.max(1, tankAvg - curGhTemp);
        return Math.max(40, Math.min(200, observedW / observedDeltaT));
      }
      return 80;
    }());
    const radPeakW = cfg.radiatorPowerKw * 1000;

    let tankDeltaJ = 0;
    let newGhTemp;

    if (simMode === 'greenhouse_heating' || simMode === 'emergency_heating') {
      modeForecast.push({ ts: hourDate, mode: simMode });
    }

    if (simMode === 'greenhouse_heating') {
      const radDeliveredW = Math.min(radPeakW, radUaWPerK * radDeltaT);
      tankDeltaJ -= radDeliveredW * SECONDS_PER_HOUR;
      // Greenhouse evolution: when the radiator's delivered W matches the
      // greenhouse's loss to outdoor, gh stays roughly stable (the case
      // we currently observe at ΔT≈6K with gh hovering around the
      // setpoint). When radiator falls below that, gh cools. We use the
      // observed gh rate as a baseline anchor for the first few hours
      // (captures whatever loss coefficient is actually achieved), then
      // taper toward natural cooling as the radiator effectiveness falls.
      const radEffectiveness = radPeakW > 0 ? Math.min(1, radDeliveredW / radPeakW) : 0;
      const observedGhKpH = (observedGhDropKPerH !== null && currentMode === 'greenhouse_heating' && h < 6)
        ? observedGhDropKPerH : 0.2;
      const naturalCoolKpH = (curGhTemp - outdoorC) / 8;
      const ghDropKpH = radEffectiveness * observedGhKpH + (1 - radEffectiveness) * naturalCoolKpH;
      newGhTemp = curGhTemp - ghDropKpH;
      greenhouseHeatingHours += 1;
    } else if (simMode === 'emergency_heating') {
      // Heater duty cycle = greenhouse heat losses / heater power.
      // The real heater is bang-bang controlled by the ehE/ehX hysteresis;
      // averaged over the hour it produces just enough to offset losses,
      // not always 1 kW. Old code charged 1 kWh per emergency hour
      // unconditionally, which overcounted backup energy by 30-40%
      // whenever outdoor wasn't drastically below the target.
      const ghTarget = (cfg.emergencyEnterC + cfg.emergencyExitC) / 2;
      const ghLossW  = cfg.greenhouseLossWPerK * Math.max(0, ghTarget - outdoorC);
      const heaterW  = cfg.spaceHeaterKw * 1000;
      const heaterDuty = Math.min(1, ghLossW / heaterW);
      const heaterEnergyKwh = heaterDuty * cfg.spaceHeaterKw;
      if (heaterEnergyKwh > 0) {
        electricKwh += heaterEnergyKwh;
        const costEur = heaterEnergyKwh * (priceCKwh + cfg.transferFeeCKwh) / 100;
        electricCostEur += costEur;
        costBreakdown.push({
          ts:            hourDate,
          kWh:           round4(heaterEnergyKwh),
          priceCKwh,
          eurInclTransfer: round4(costEur),
        });
      }
      // Tank still leaks slowly during emergency.
      const tankLossW = tankLeakageWPerK * Math.max(0, tankAvg - curGhTemp);
      tankDeltaJ -= tankLossW * SECONDS_PER_HOUR;
      // Greenhouse maintained at target by the heater. If outdoor
      // climbs above target, ghLossW = 0, heater isn't needed, gh
      // drifts toward outdoor — once gh > ehX the mode-decision
      // block exits emergency on the next iteration.
      newGhTemp = heaterDuty > 0
        ? ghTarget
        : curGhTemp + (outdoorC - curGhTemp) * (1 - Math.exp(-1 / 8));
    } else {
      // Idle.
      const tankLossW = tankLeakageWPerK * Math.max(0, tankAvg - curGhTemp);
      tankDeltaJ -= tankLossW * SECONDS_PER_HOUR;
      // Greenhouse drifts toward outdoor with τ = 8 h.
      newGhTemp = curGhTemp + (outdoorC - curGhTemp) * (1 - Math.exp(-1 / 8));
    }
    const ghDeltaJ = 0; void ghDeltaJ;

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
      modeForecast.push({ ts: hourDate, mode: 'solar_charging' });
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
  // Compute summary metrics for the notes.
  const ghTemps        = ghTrajectory.map(function (p) { return p.temp; });
  const ghMin          = Math.min.apply(null, ghTemps);
  const ghMinIdx       = ghTemps.indexOf(ghMin);
  const tankAvgs       = tankTrajectory.map(function (p) { return p.avg; });
  const tankMin        = Math.min.apply(null, tankAvgs);
  const tankAvgNow     = tankAvgs[0];
  // Tank energy stored above the floor — same formula the gauge tile,
  // balance card and push notifications use (server/lib/energy-balance.js
  // tankStoredEnergyKwh). Keeping a single source of truth means every
  // surface reports the same kWh figure for the same tank state.
  const tankStoredKwhNow = tankStoredEnergyKwh(tankAvgNow);

  const notes = buildNotes({
    now,
    solarChargingHours,
    greenhouseHeatingHours,
    electricKwh,
    electricCostEur,
    hoursUntilFloor,
    hoursUntilBackupNeeded,
    usedDefaults,
    tankFloorC:              cfg.tankFloorC,
    weather48h:              weather,
    solarGainByDay,
    ghMin,
    ghMinIdx,
    tankMin,
    tankAvgNow,
    tankStoredKwhNow,
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
    modeForecast,
    solarChargingHours,
    greenhouseHeatingHours,
    solarGainByDay,
    modelConfidence:        confidence,
    notes,
  };
}

// ── Note generation ──
//
// Notes are ordered by operational relevance:
//   1. Greenhouse temperature trajectory (what the user cares about most).
//   2. Tank stored energy + how long it sustains heating.
//   3. Backup electric usage + cost.
//   4. Solar gain context (today / tomorrow).
//
// Cap at 3 notes so the card stays scannable.
function buildNotes(ctx) {
  const notes = [];

  if (ctx.usedDefaults) {
    notes.push('Forecast based on default coefficients — model still warming up with limited history.');
  }

  // 1. Greenhouse temperature: the operator's primary concern. Surface the
  //    minimum temperature the greenhouse will reach and when it bottoms out.
  if (ctx.ghMin !== undefined && notes.length < 3) {
    const minDate = new Date(ctx.now + ctx.ghMinIdx * 3600 * 1000);
    const hhmm    = helsinkiHHMM(minDate);
    if (ctx.electricKwh > 0) {
      notes.push(
        'Greenhouse cools to ' + ctx.ghMin.toFixed(1) + ' °C around ' + hhmm +
        ', when the space heater takes over to hold it there.'
      );
    } else {
      notes.push(
        'Greenhouse holds above ' + ctx.ghMin.toFixed(1) + ' °C the whole window — tank covers it without backup.'
      );
    }
  }

  // 2. Tank storage + how long it sustains greenhouse heating. Phrasing
  //    matches the gauge tile / balance card / push notifications, which all
  //    use the same tankStoredEnergyKwh formula — so the kWh figure agrees
  //    across surfaces and the user doesn't see contradictory numbers.
  if (ctx.tankStoredKwhNow !== undefined && notes.length < 3) {
    const stored = ctx.tankStoredKwhNow.toFixed(1);
    if (ctx.hoursUntilBackupNeeded !== null) {
      notes.push(
        'Tank stores ~' + stored + ' kWh above the floor — covers greenhouse heating for about ~' +
        Math.round(ctx.hoursUntilBackupNeeded) + ' h before the space heater kicks in.'
      );
    } else if (ctx.electricKwh > 0) {
      notes.push(
        'Tank stores ~' + stored + ' kWh above the floor; heating bridges most of the night, with ~' +
        Math.round(ctx.electricKwh) + ' h of space-heater backup mixed in.'
      );
    } else {
      notes.push(
        'Tank stores ~' + stored + ' kWh above the floor — enough for the whole window with no backup needed.'
      );
    }
  }

  // 3. Backup electricity summary (cost and hours), if any.
  if (ctx.electricKwh > 0 && notes.length < 3) {
    const eur = ctx.electricCostEur;
    notes.push(
      'Space heater projected: ~' + Math.round(ctx.electricKwh) +
      ' kWh over the next 48 h, costing about €' + eur.toFixed(2) + '.'
    );
  }

  // 4. Solar gain context (today / tomorrow). Only include if there's room
  //    AND we haven't filled the slots with more pressing notes.
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
  }

  return notes;
}

function round2(v) { return Math.round(v * 100) / 100; }
function round4(v) { return Math.round(v * 10000) / 10000; }

module.exports = {
  fitEmpiricalCoefficients,
  computeSustainForecast,
  // Exported for tests
  _TANK_THERMAL_MASS_J_PER_K:    TANK_THERMAL_MASS_J_PER_K,
  _DEFAULT_TANK_LEAKAGE_W_PER_K: DEFAULT_TANK_LEAKAGE_W_PER_K,
};
