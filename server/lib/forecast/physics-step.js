'use strict';

// physics-step.js — pure per-step thermal model for the greenhouse
// + tank system. Distilled from sustain-forecast.js's per-hour loop
// into a callable function with no I/O, no accumulators, no rollout.
//
// Why a separate module: the ML forecast engine uses it as the
// *structural* backbone of its predictions — the ML model learns the
// residual (observed minus physics), so the physics step has to be
// importable both at training time (over historical anchors) and at
// inference time (over each rollout step). A residual model trained
// against the same physics it's then composed with stays consistent;
// switching the physics out (or drifting it) without retraining
// would silently break the engine. Keep this file in lockstep with
// sustain-forecast.js's per-hour math.
//
// Outputs are per-step Δ values — the caller integrates them, decides
// modes, and accumulates costs. Coefficients are deliberately *fixed*
// defaults (not the live sustain-forecast-fit output) so the trainer
// can compute identical physics over historical anchors without
// re-running the fit per anchor. Bias from this choice is absorbed
// by the ML residual.

const TANK_THERMAL_MASS_J_PER_K = 300 * 4186; // 300 L water × 4186 J/(kg·K)
const SECONDS_PER_HOUR = 3600;

// Mirrors the thermal-related fields of sustain-forecast.js's
// DEFAULT_CONFIG. Threshold fields (geT/gxT/ehE/ehX) are NOT here —
// the caller supplies the mode it already decided from those.
const DEFAULT_CONFIG = {
  spaceHeaterKw:            1,
  radiatorPowerKw:          2.4,
  radiatorUaWPerK:          80,
  greenhouseLossWPerK:      120,
  tankLeakageWPerK:         3.0,
  tankMaxC:                 55,
  // Greenhouse-air heat-balance coefficients (passive cooling, solar
  // absorption, vent saturation). Defaults match sustain-forecast.js.
  ghTimeConstantH:          2.0,
  ghSolarAlphaCPerWm2:      0.025,
  ghVentOpenC:              33,
  ghVentTauH:               0.3,
  cloudReferenceWm2:        500,
  // Used by emergency-mode duty estimate: target GH temp the heater
  // tries to hold = midpoint(ehE, ehX). The caller passes the
  // thresholds the controller is using.
  emergencyEnterC:          9,
  emergencyExitC:           12,
};

// Per-clock-hour solar gain baseline (kWh). Conservative fallback that
// mirrors the one in sustain-forecast.js when no fitted profile is
// available. The ML residual absorbs deviations from this.
function defaultSolarGainByHour() {
  const a = new Array(24);
  for (let h = 0; h < 24; h++) a[h] = (h >= 10 && h <= 16) ? 0.4 : 0;
  return a;
}
const SOLAR_GAIN_KWH_BY_HOUR = defaultSolarGainByHour();

/**
 * Step the physics forward by `stepHours`. Pure.
 *
 * @param {object} args
 *   args.tankAvg     — current tank average °C
 *   args.gh          — current greenhouse °C
 *   args.outdoor     — outdoor °C this step
 *   args.radiation   — global radiation W/m² this step
 *   args.mode        — controller mode for this step
 *                      ('idle' | 'solar_charging' |
 *                       'greenhouse_heating' | 'emergency_heating')
 *   args.stepHours   — step length in hours (e.g. 1/12 for 5-min, 1 for hourly)
 *   args.hourOfDayHelsinki — 0..23 hour-of-day (Helsinki) for solar profile
 *   args.cfg         — optional override of DEFAULT_CONFIG fields
 * @returns { dTankC, dGhC, heaterDuty }
 */
function physicsStep(args) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, args.cfg || {});
  const stepH = Math.max(0, Number(args.stepHours) || 0);
  if (stepH === 0) return { dTankC: 0, dGhC: 0, heaterDuty: 0 };

  const tankAvg = Number(args.tankAvg);
  const gh = Number(args.gh);
  const outdoor = Number(args.outdoor) || 0;
  const radiation = Math.max(0, Number(args.radiation) || 0);
  const mode = String(args.mode || 'idle');
  const hod = ((args.hourOfDayHelsinki | 0) % 24 + 24) % 24;

  // ── Radiator delivery (only active in heating modes) ──
  const radDeltaT = Math.max(0, tankAvg - gh);
  const radPeakW = cfg.radiatorPowerKw * 1000;
  const radDeliveredW = Math.min(radPeakW, cfg.radiatorUaWPerK * radDeltaT);

  // ── Heater duty (only active in emergency mode) ──
  let heaterDuty = 0;
  let heaterHeatToGhW = 0;
  if (mode === 'emergency_heating') {
    const ghTarget = (cfg.emergencyEnterC + cfg.emergencyExitC) / 2;
    const ghLossAtTargetW = cfg.greenhouseLossWPerK * Math.max(0, ghTarget - outdoor);
    const heaterW = cfg.spaceHeaterKw * 1000;
    const heaterNeededW = Math.max(0, ghLossAtTargetW - radDeliveredW);
    heaterDuty = Math.min(1, heaterNeededW / heaterW);
    heaterHeatToGhW = heaterDuty * heaterW;
  }

  // ── Tank energy balance (Joules over the step) ──
  let tankDeltaJ = 0;
  const tankLossW = cfg.tankLeakageWPerK * Math.max(0, tankAvg - gh);
  tankDeltaJ -= tankLossW * SECONDS_PER_HOUR * stepH;

  let radHeatToGhW = 0;
  if (mode === 'greenhouse_heating' || mode === 'emergency_heating') {
    // The thermostatic-radiator duty cycle from sustain-forecast.js
    // bang-bangs the radiator; over a step we approximate it as
    // continuous delivery (the residual model corrects the duty).
    radHeatToGhW = radDeliveredW;
    tankDeltaJ -= radHeatToGhW * SECONDS_PER_HOUR * stepH;
  }

  // Solar charging credit (only when the caller picked solar_charging).
  if (mode === 'solar_charging' && tankAvg < cfg.tankMaxC) {
    const baseGainKwhPerH = SOLAR_GAIN_KWH_BY_HOUR[hod] || 0;
    let cloudFactor = radiation / cfg.cloudReferenceWm2;
    if (cloudFactor < 0)   cloudFactor = 0;
    if (cloudFactor > 1.5) cloudFactor = 1.5;
    const solarGainKwh = baseGainKwhPerH * cloudFactor * stepH;
    tankDeltaJ += solarGainKwh * 3.6e6;
  }

  const dTankC = tankDeltaJ / TANK_THERMAL_MASS_J_PER_K;

  // ── Greenhouse heat balance, substepped over the step ──
  // 12 substeps per call keeps the vent saturation term stable when
  // stepHours is small (5-min) and still gives 12 substeps for hourly.
  const SUBSTEPS = 12;
  const dtH = stepH / SUBSTEPS;
  let newGh = gh;
  for (let s = 0; s < SUBSTEPS; s++) {
    const ghPassive = (outdoor - newGh) / cfg.ghTimeConstantH;
    const ghSolar = cfg.ghSolarAlphaCPerWm2 * radiation;
    const ghVent = newGh > cfg.ghVentOpenC
      ? -(newGh - cfg.ghVentOpenC) / cfg.ghVentTauH : 0;
    const ghActive = (cfg.ghTimeConstantH > 0 && cfg.greenhouseLossWPerK > 0)
      ? (radHeatToGhW + heaterHeatToGhW) / (cfg.ghTimeConstantH * cfg.greenhouseLossWPerK) : 0;
    newGh += (ghPassive + ghSolar + ghVent + ghActive) * dtH;
  }
  let dGhC = newGh - gh;
  // Hard floor — gh can't drop below outdoor mathematically.
  if (gh + dGhC < outdoor) dGhC = outdoor - gh;

  return { dTankC, dGhC, heaterDuty };
}

module.exports = {
  physicsStep,
  TANK_THERMAL_MASS_J_PER_K,
  DEFAULT_CONFIG,
};
