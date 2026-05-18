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
//   fitEmpiricalCoefficients(history, opts) →
//     { tankLeakageWPerK, solarGainKwhByHour, [greenhouseLossWPerK,] usedDefaults }
//   computeSustainForecast({ now, tankTop, tankBottom, greenhouseTemp, currentMode,
//                            weather48h, prices48h, coefficients, config }) → forecast

const fit = require('./sustain-forecast-fit');
const { tankStoredEnergyKwh } = require('../energy-balance');
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
  // Tank-side gates: enter requires tank_top > gh + gmD, stay requires
  // tank_top >= gh + gxD (mirrors control-logic.js; tu.gmD / tu.gxD).
  greenhouseMinTankDeltaC:  5,
  greenhouseExitTankDeltaC: 2,
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
  // GH-air heat balance defaults; sustain-forecast-fit overrides.
  ghTimeConstantH:          2.0,   // passive cooling τ (hours)
  ghSolarAlphaCPerWm2:      0.025, // °C rise per W/m² radiation
  // Vents engage at ~33 °C empirically (operational ceiling on sunny
  // days). Pre-2026-05-08 default of 27 capped sunny predictions ~6 K
  // low; fit-able but sparse-data, so defaults pin to user-observed.
  ghVentOpenC:              33,
  ghVentTauH:               0.3,   // cooling τ once vents open
  // Confidence boost: set this to a recent Date when weather was fetched
  weatherFetchedAt:         null,
  // Number of buckets used for the empirical fit (for confidence)
  fitBucketCount:           0,
  // Tank destratification. The step-4 solar skew (60/40 top/bottom) and
  // any other per-layer asymmetry would let the top/bottom split grow
  // without bound across a 48 h sim. Real tanks mix (conduction +
  // convection + pump circulation): observed tank_top − tank_bottom
  // stays ~1.5 K (14 d median 1.3, p90 3.4) and relaxes within hours.
  // Each sim hour the spread decays exponentially toward tankStratEqC
  // with time constant tankMixTauH. Set tankMixTauH ≤ 0 to disable.
  tankMixTauH:              2.0,
  tankStratEqC:             1.5,
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
  // True when the controller has fired emergency_heating in the past
  // hour. The simulation by itself only sees the greenhouse temp NOW
  // and projects forward, so it can report "Tank lasts 4 h" even
  // though the device has been cycling backup all morning. The flag
  // short-circuits hoursUntilBackupNeeded to 0 in that case so the
  // card honestly says "Tank exhausted" instead of "4 h until backup".
  const emergencyRecentlyActive = !!opts.emergencyRecentlyActive;
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
  // Coefficient overrides cfg, which overrides DEFAULT_CONFIG. Wired this
  // way so a fitted greenhouseLossWPerK from sustain-forecast-fit takes
  // precedence over the conservative warmup default; the DEFAULT_CONFIG
  // value still seeds the engine when the fit hasn't converged yet.
  // Coefficient overrides (each only when the fit actually emitted a
  // sane value; falls through to DEFAULT_CONFIG otherwise).
  applyCoeffOverride(cfg, coeff, 'greenhouseLossWPerK', v => v > 0);
  applyCoeffOverride(cfg, coeff, 'ghTimeConstantH',     v => v > 0);
  applyCoeffOverride(cfg, coeff, 'ghSolarAlphaCPerWm2', v => v >= 0);
  applyCoeffOverride(cfg, coeff, 'ghVentOpenC',         v => v > 0);
  applyCoeffOverride(cfg, coeff, 'ghVentTauH',          v => v > 0);

  const tankLeakageWPerK    = typeof coeff.tankLeakageWPerK    === 'number' ? coeff.tankLeakageWPerK    : DEFAULT_TANK_LEAKAGE_W_PER_K;
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
  // Backup is already engaged in real life if it cycled in the last
  // hour — the tank is functionally exhausted regardless of any
  // "above-floor stored energy" arithmetic.
  let hoursUntilBackupNeeded = emergencyRecentlyActive ? 0 : null;
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
  // Per-hour predicted components — what the simulation thinks
  // contributed to the tank/GH state during this hour. Surfaced in
  // forecast_predictions row capture so a future tuning pass can
  // diagnose which sub-model went wrong (the aggregate tank/GH temp
  // alone doesn't localise the error). One entry per simulated hour h
  // (0..47) describing the consumption between h and h+1.
  const componentTrajectory    = [];

  const HOURS = 48;

  for (let h = 0; h < HOURS; h++) {
    const hourMs    = now + h * SECONDS_PER_HOUR * 1000;
    const hourDate  = new Date(hourMs).toISOString();

    const tankAvg = (tankTopC + tankBotC) / 2;

    // Floor-crossing fallback (refined to fractional hour below).
    if (hoursUntilFloor === null && tankAvg < cfg.tankFloorC) hoursUntilFloor = h;

    tankTrajectory.push({ ts: hourDate, top: round2(tankTopC), bottom: round2(tankBotC), avg: round2(tankAvg) });
    ghTrajectory.push({ ts: hourDate, temp: round2(curGhTemp) });

    const wx = weather[h] || weather[weather.length - 1] || { temperature: 0, radiationGlobal: 0 };
    const outdoorC   = typeof wx.temperature     === 'number' ? wx.temperature     : 0;
    const radiation  = typeof wx.radiationGlobal === 'number' ? wx.radiationGlobal : 0;
    const px = prices[h] || prices[prices.length - 1] || { priceCKwh: 10 };
    const priceCKwh = typeof px.priceCKwh === 'number' ? px.priceCKwh : 10;

    // ── 1. Mode decision (mirror control-logic.js hysteresis) ──
    // greenhouse_heating: gh < geT AND tank_top > gh + gmD; the tank
    // gate suppresses heating bars when the tank can't drive the
    // radiator, so emergency fires at the right hour instead of behind
    // painted heating bars. emergency_heating: gh < ehE.
    const tankCanEnter   = tankTopC >  curGhTemp + cfg.greenhouseMinTankDeltaC;
    const tankCanSustain = tankTopC >= curGhTemp + cfg.greenhouseExitTankDeltaC;
    if (curGhTemp < cfg.emergencyEnterC) {
      if (simMode !== 'emergency_heating' && hoursUntilBackupNeeded === null) {
        hoursUntilBackupNeeded = h;
      }
      simMode = 'emergency_heating';
    } else if (simMode === 'emergency_heating' && curGhTemp > cfg.emergencyExitC) {
      // Backup exits when gh > ehX (matches the device's exit hysteresis).
      simMode = (curGhTemp < cfg.greenhouseEnterC && tankCanEnter)
        ? 'greenhouse_heating' : 'idle';
    } else if (curGhTemp < cfg.greenhouseEnterC && simMode === 'idle' && tankCanEnter) {
      simMode = 'greenhouse_heating';
    } else if (simMode === 'greenhouse_heating' &&
               (curGhTemp > cfg.greenhouseExitC || !tankCanSustain)) {
      simMode = 'idle';
    }

    // ── 2. Radiator heat transfer ──
    // P=UA·(T_tank−T_gh), capped at radPeakW. UA priority: fitted →
    // live tankDrop at h=0 in heating → hardcoded 80 fallback.
    const radDeltaT = Math.max(0, tankAvg - curGhTemp);
    const radUaWPerK = (function () {
      if (typeof coeff.radiatorUaWPerK === 'number' && coeff.radiatorUaWPerK > 0) {
        return coeff.radiatorUaWPerK;
      }
      if (observedTankDropKPerH !== null && currentMode === 'greenhouse_heating' && h === 0) {
        const observedW = observedTankDropKPerH * TANK_THERMAL_MASS_J_PER_K / SECONDS_PER_HOUR;
        const observedDeltaT = Math.max(1, tankAvg - curGhTemp);
        return Math.max(40, Math.min(200, observedW / observedDeltaT));
      }
      return 80;
    }());
    const radPeakW = cfg.radiatorPowerKw * 1000;

    let tankDeltaJ = 0;
    // Active power injected into GH air this hour. Each mode branch
    // sets these; the unified heat balance converts to ΔT. Idle = 0.
    let radHeatToGhW = 0;
    let heaterHeatToGhW = 0;
    // Radiator output while the thermostat has it ON during
    // greenhouse_heating; the substep loop cycles it bang-bang and the
    // resulting duty scales the tank draw. 0 for every other mode.
    let radWhenOnW = 0;
    // Components captured per-hour for forecast_predictions storage.
    let hourHeaterKwh = 0;
    let hourTankLossW = 0;

    if (simMode === 'greenhouse_heating') {
      modeForecast.push({ ts: hourDate, mode: simMode });
      // The real controller cycles the radiator to hold the greenhouse
      // inside [geT, gxT]. The substep loop below runs that bang-bang;
      // the tank draw is applied afterwards, scaled by the duty cycle.
      // Projecting a full hour of constant radiator output overshot the
      // ~1 K exit band by many K (radiator ≈ 7 K/h into GH air) and made
      // the trajectory sawtooth instead of holding the band flat.
      radWhenOnW = Math.min(radPeakW, radUaWPerK * radDeltaT);
      greenhouseHeatingHours += 1;
    } else if (simMode === 'emergency_heating') {
      // The real device overlays the heater on the active pump mode
      // (system.yaml overlays.emergency_heating: "the space heater is
      // overlaid on the active pump mode"). When the tank is hot enough
      // to drive the radiator, the radiator delivers most of the heat and
      // the heater fills only the remaining gap.
      const radDeliveredW = Math.min(radPeakW, radUaWPerK * radDeltaT);
      const ghTarget = (cfg.emergencyEnterC + cfg.emergencyExitC) / 2;
      const ghLossAtTargetW = cfg.greenhouseLossWPerK * Math.max(0, ghTarget - outdoorC);
      const heaterW  = cfg.spaceHeaterKw * 1000;
      // Heater fills the gap left by the radiator. When rad ≥ loss,
      // duty=0 and the heater stays idle.
      const heaterNeededW = Math.max(0, ghLossAtTargetW - radDeliveredW);
      const heaterDuty = Math.min(1, heaterNeededW / heaterW);
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
      // Radiator extracts heat from the tank (mirroring the real overlay).
      tankDeltaJ -= radDeliveredW * SECONDS_PER_HOUR;
      // Tank still leaks slowly during emergency.
      const tankLossW = tankLeakageWPerK * Math.max(0, tankAvg - curGhTemp);
      tankDeltaJ -= tankLossW * SECONDS_PER_HOUR;
      radHeatToGhW = radDeliveredW;
      heaterHeatToGhW = heaterDuty * heaterW;
      hourHeaterKwh = heaterEnergyKwh;
      hourTankLossW = tankLossW;
      // Carry the duty fraction so the chart can render <100% bars instead
      // of solid orange across hours where the heater barely cycles.
      modeForecast.push({ ts: hourDate, mode: simMode, duty: round2(heaterDuty) });
    } else {
      // Idle: only tank leakage on the tank side; the unified heat
      // balance below handles the GH update.
      const tankLossW = tankLeakageWPerK * Math.max(0, tankAvg - curGhTemp);
      tankDeltaJ -= tankLossW * SECONDS_PER_HOUR;
      hourTankLossW = tankLossW;
    }

    // ── Unified greenhouse heat balance (every mode, every hour) ──
    //   dT/dt = (outdoor−gh)/τ_gh                    ← passive loss
    //         + α_solar · radiation                   ← solar absorption
    //         − max(0, gh−vent_open)/τ_vent           ← vent saturation
    //         + (radHeat + heaterHeat)/(τ_gh·ghLoss)  ← active power
    //
    // Active term derivation: C_gh ≈ 3600·τ_gh·greenhouseLossWPerK, so
    // (W·3600)/C_gh = W/(τ·loss) in K/h. Substep with 60×1-min steps so
    // the short τ_vent doesn't overshoot under explicit Euler.
    const SUBSTEPS = 60;
    const dtH = 1 / SUBSTEPS;
    let newGhTemp = curGhTemp;
    // Thermostatic radiator: during greenhouse_heating the controller
    // cycles the radiator bang-bang to hold gh within [geT, gxT]. radOn
    // tracks that switch substep-by-substep; radOnSubsteps accumulates
    // the duty so the tank draw and component capture can be scaled.
    let radOn = simMode === 'greenhouse_heating' && curGhTemp < cfg.greenhouseExitC;
    let radOnSubsteps = 0;
    for (let s = 0; s < SUBSTEPS; s++) {
      if (simMode === 'greenhouse_heating') {
        if (newGhTemp >= cfg.greenhouseExitC) radOn = false;
        else if (newGhTemp <= cfg.greenhouseEnterC) radOn = true;
        if (radOn) radOnSubsteps += 1;
      }
      const radNowW = simMode === 'greenhouse_heating'
        ? (radOn ? radWhenOnW : 0) : radHeatToGhW;
      const ghPassive = (outdoorC - newGhTemp) / cfg.ghTimeConstantH;
      const ghSolar   = cfg.ghSolarAlphaCPerWm2 * radiation;
      const ghVent    = newGhTemp > cfg.ghVentOpenC
        ? -(newGhTemp - cfg.ghVentOpenC) / cfg.ghVentTauH : 0;
      const ghActive  = (cfg.ghTimeConstantH > 0 && cfg.greenhouseLossWPerK > 0)
        ? (radNowW + heaterHeatToGhW) / (cfg.ghTimeConstantH * cfg.greenhouseLossWPerK) : 0;
      newGhTemp += (ghPassive + ghSolar + ghVent + ghActive) * dtH;
    }
    // Apply the thermostatic radiator's tank draw once the duty is
    // known. radHeatToGhW (0 until here for greenhouse_heating) carries
    // the duty-averaged output into the per-hour component capture.
    if (simMode === 'greenhouse_heating') {
      radHeatToGhW = radWhenOnW * (radOnSubsteps / SUBSTEPS);
      tankDeltaJ -= radHeatToGhW * SECONDS_PER_HOUR;
    }

    // ── 3. Solar charging credit ──
    // Historical kWh-per-clock-hour baseline (encodes controller cycle
    // probability, shading, typical conditions) modulated by FMI
    // radiation. cloudReferenceWm2 (~500) maps to cloudFactor=1.
    // Capped at tank near max temp (system stops charging ~60 °C).
    const hourOfDay   = helsinkiHour(new Date(hourMs));
    const baseGainKwh = solarGainKwhByHour[hourOfDay];
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

    // ── 4b. Destratification ──
    // Conduction + convective mixing pull the top/bottom split back
    // toward a small equilibrium. Without this the step-4 solar skew
    // accumulates unboundedly — the 48 h projection drifts the top
    // several K too hot and the bottom several K too cold even though
    // the average stays accurate. Conserves the tank average.
    if (cfg.tankMixTauH > 0) {
      const stratAvg    = (tankTopC + tankBotC) / 2;
      const stratDecay  = Math.exp(-1 / cfg.tankMixTauH);
      const stratSpread = cfg.tankStratEqC + ((tankTopC - tankBotC) - cfg.tankStratEqC) * stratDecay;
      tankTopC = stratAvg + stratSpread / 2;
      tankBotC = stratAvg - stratSpread / 2;
    }

    // ── 5. Greenhouse temperature update ──
    curGhTemp = newGhTemp;
    // Hard floor at outdoor: the heat balance can't drive GH below
    // outdoor mathematically, but a misfit α_solar < 0 could; clamp.
    if (curGhTemp < outdoorC) curGhTemp = outdoorC;

    // ── 6. Capture per-hour predicted components ──
    componentTrajectory.push({
      ts: hourDate,
      solarGainKwh:    round4(solarGainKwh),
      radDeliveredW:   round2(radHeatToGhW),
      heaterKwh:       round4(hourHeaterKwh),
      tankLossW:       round2(hourTankLossW),
      cloudFactor:     round2(cloudFactor),
    });

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
    componentTrajectory,
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

// Notes are ordered by operational relevance: GH min temp, tank stored
// kWh + sustain hours, backup electric usage, solar gain. Capped at 3.
function buildNotes(ctx) {
  const notes = [];

  if (ctx.usedDefaults) {
    notes.push('Forecast based on default coefficients — model still warming up with limited history.');
  }

  // 1. Greenhouse minimum temperature.
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

  // 2. Tank storage + sustain hours. Same tankStoredEnergyKwh formula
  //    as the gauge tile / balance card / push notifications.
  if (ctx.tankStoredKwhNow !== undefined && notes.length < 3) {
    const stored = ctx.tankStoredKwhNow.toFixed(1);
    if (ctx.hoursUntilBackupNeeded === 0) {
      // Tank too cold for radiator OR backup already cycling — naming
      // this "~0 h until backup" reads as broken; surface it explicitly.
      notes.push(
        'Tank stores ~' + stored + ' kWh above the floor, but it’s too cold ' +
        'to drive the radiator — the space heater is providing the heating.'
      );
    } else if (ctx.hoursUntilBackupNeeded !== null) {
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

  // 4. Solar gain context (today / tomorrow), if there's slot room.
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

function applyCoeffOverride(cfg, coeff, key, isValid) {
  if (typeof coeff[key] === 'number' && isValid(coeff[key])) cfg[key] = coeff[key];
}

module.exports = {
  fitEmpiricalCoefficients,
  computeSustainForecast,
  // Exported for tests
  _TANK_THERMAL_MASS_J_PER_K:    TANK_THERMAL_MASS_J_PER_K,
  _DEFAULT_TANK_LEAKAGE_W_PER_K: DEFAULT_TANK_LEAKAGE_W_PER_K,
};
