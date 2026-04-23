/**
 * Thermal Physics Engine — single source of truth for the greenhouse
 * solar heater simulation. Browser-safe ESM; imported by the playground
 * (via the `ThermalModel` class) and by the Node test simulator (via
 * the functional `createModel` / `tick` / `PARAMS` API).
 *
 * Parameter calibration (2026-04-23):
 *   Several parameters were fit against 3 days of production telemetry
 *   (2026-04-20 20:14 → 2026-04-23 17:52, 2-min resolution; see
 *   greenhouse.tsv on branch thermal-simulation-model-improvements).
 *   Methodology notes:
 *
 *   - Tank insulation fit uses tank_top only (not the mean of top+bottom).
 *     The drainback dumps the collector's ~10 L of cold water right at
 *     the dip tube near the tank_bottom sensor, so tank_bottom is
 *     unreliable for energy-balance fits for several hours after every
 *     drain event. Three overnight windows (post-drain, pump off, idle)
 *     converged on U_top ≈ 1.7–2.0 W/K → U_tank ≈ 3.4–4.0 W/K (R² 0.86–
 *     0.97). Using 4 W/K.
 *
 *   - Tank mixing fit: one clean night-21→22 window, d(top-bot)/dt log-
 *     linear regression gave mix ≈ 3.8 W/K (R² 0.92). Using 4 W/K.
 *
 *   - Water flow rate: energy-balance on the 2026-04-21 09:04 session
 *     (262 min continuous solar_charging). Six rolling 30-min midsection
 *     windows gave 2.11–2.66 L/min — duration-weighted 2.4 L/min. Using
 *     2.5 L/min.
 *
 *   - Greenhouse mass: qualitative only. Dusk→dawn cooling consistently
 *     follows a τ ≈ 5-6 h trajectory rather than the modeled 2.78 h.
 *     Doubled greenhouseThermalMass to 1_000_000 J/K to match the
 *     observed timescale.
 *
 * Model v2 additions (also 2026-04-23):
 *
 *   - Drain bolus: on every active_drain completion, the collector's
 *     ~10 L of water falls into the very bottom of the tank (physical
 *     drainback system, dip-tube geometry). That cold slug is what the
 *     tank_bottom sensor physically reads (not a zone average) for
 *     hours after a drain. Real data on 2026-04-21 21:44: tank_bottom
 *     dropped 35.45 → 16.7 °C in 6 min, then recovered over ~11 h (τ
 *     ≈ 4 h fitted). Modeled as a 10 L bolus layer with its own
 *     temperature; the tank_bottom sensor reads the bolus when present,
 *     the bolus mixes into the lower zone with τ_bolus, and solar-flow
 *     intake draws from the bolus first before pulling from the zone.
 *
 *     Bolus τ was refit 2026-04-23 (second pass) against 10 h of
 *     post-21:44 recovery: sensor 16.7 → 28.8 °C, τ = 21 h (R² 0.71).
 *     Using 20 h.
 *
 *   - Flow ramp: pump flow goes 0 → steady over pumpFlowRampSec
 *     seconds after each pump-on. Captures priming + pipe-fill +
 *     startup transients.
 *
 *   - Sky radiation: the collector faces a ~270 K sky on clear nights
 *     and radiates to it, driving plate temp below ambient. Modeled
 *     as an additional convective-style loss term toward a sky
 *     temperature of T_outdoor - skyDeltaK.
 *
 * Playground-only feature (kept opt-in via PARAMS):
 *
 *   - Passive greenhouse solar gain through glazing. Scenario-driven
 *     unit tests set greenhouseGlazingArea = 0 (the default) so they
 *     see a pure conduction greenhouse. The ThermalModel class sets a
 *     non-zero default so the browser dashboard shows a realistic
 *     daytime greenhouse warming curve.
 */

// ── Public constants used by callers (history + balance card) ───────

const WATER_CP = 4186;          // J/(kg·K)
const WATER_DENSITY = 1000;     // kg/m³

// Energy-stored math for the 300 L Jäspi tank, referenced to 12 °C
// (the practical floor below which stored heat is no longer useful for
// greenhouse heating). Used by the Status view's "Energy Stored" card
// and the Daily Solar Report notification.
const TANK_VOLUME_L = 300;
const TANK_BASE_TEMP_C = 12;
const WATER_SPECIFIC_HEAT_KJ = 4.186; // kJ/(kg·K)

export function tankStoredEnergyKwh(avgTankC) {
  if (typeof avgTankC !== 'number' || !isFinite(avgTankC)) return 0;
  const dT = Math.max(0, avgTankC - TANK_BASE_TEMP_C);
  return TANK_VOLUME_L * WATER_SPECIFIC_HEAT_KJ * dT / 3600;
}

// ── Functional API (used by tests/simulation/*) ─────────────────────

export const PARAMS = {
  // Collector
  collectorArea: 4,                // m²
  collectorAbsorptivity: 0.8,
  collectorHeatLossCoeff: 5,       // W/(m²·K) — convective loss to ambient
  collectorSkyLossCoeff: 4,        // W/(m²·K) — radiative loss toward T_sky
  skyDeltaK: 8,                    // T_sky ≈ T_outdoor - skyDeltaK on clear nights
  // Thermal mass fit 2026-04-23 (second pass). Evening 21:04 collector
  // cooldown against T_eff = (h_conv*T_out + h_sky*(T_out-skyΔ))/(h_conv+
  // h_sky) gave τ = 23.2 min, R² = 0.978. With combined h*A =
  // (h_conv + h_sky)·A = 36 W/K, C_dry = h*A × τ × 60 ≈ 50 kJ/K.
  // Wet adds 10 L of water @ 4186 J/(L·K) = 41.86 kJ/K.
  collectorThermalMassDry: 50000,  // J/K
  collectorThermalMassWet: 92000,  // J/K (= C_dry + 10 L × 4186)
  collectorWaterCapacity: 10,      // liters

  // Tank
  tankVolume: 300,                 // liters
  tankZoneSplit: 0.5,
  tankInsulationLoss: 4,           // W/K total
  tankMixingCoeff: 4,              // W/K stable top>bot, pump off
  tankPumpMixingCoeff: 300,        // W/K stable top>bot, pump running (plume entrainment)
  tankConvectiveMixing: 500,       // W/K unstable bot>top
  // Drain bolus: 10 L of cold water sits at the very bottom after a
  // drain, what the tank_bottom sensor physically reads. Fit from
  // 2026-04-21 drain recovery (10 h of data, sensor rose 16.7 → 28.8 °C).
  bolusMixTauSec: 20 * 3600,       // seconds
  bolusSensorThreshold: 0.5,       // L — below this, sensor reads zone, not bolus

  // Pump startup transient: flow ramps from 0 → steady over this window.
  pumpFlowRampSec: 60,

  // Greenhouse
  greenhouseHeatLoss: 50,          // W/K
  greenhouseThermalMass: 1000000,  // J/K
  radiatorCoeff: 200,              // W/K
  spaceHeaterPower: 2000,          // W
  immersionHeaterPower: 2000,      // W
  // Passive solar gain through glazing (playground-only; scenarios opt out
  // by leaving both zero). When area > 0, Qgh += transmittance × irr × area.
  greenhouseGlazingArea: 0,        // m²
  greenhouseSolarTransmittance: 0, // fraction

  // Water
  waterFlowRate: 2.5 / 60,         // L/s
  waterSpecificHeat: 4186,         // J/(kg·K)

  // Pump power (for trace)
  pumpPowerNormal: 50,             // W
  pumpPowerDry: 10,                // W
};

export function createModel(overrides) {
  const defaults = {
    collector: 20,
    tank_top: 40,
    tank_bottom: 30,
    greenhouse: 15,
    outdoor: 10,
    irradiance: 0,
    collectorWaterVolume: 0,
    // v2 state additions:
    tank_bolus_volume: 0,          // L, cold slug at tank bottom from last drain
    tank_bolus_temp: 10,           // °C
    flow_ramp: 0,                  // 0..1 ramp state since last pump-on
    prev_pump: false,              // for ramp reset detection
  };
  return Object.assign({}, defaults, overrides);
}

// Maximum sub-step size for numerical stability (seconds)
const MAX_SUBSTEP = 10;

export function tick(model, dt, decisions, params) {
  const p = params || PARAMS;
  const nSteps = Math.max(1, Math.ceil(dt / MAX_SUBSTEP));
  const subDt = dt / nSteps;
  let m = Object.assign({}, model);
  for (let i = 0; i < nSteps; i++) {
    m = tickStep(m, subDt, decisions, p);
  }
  return m;
}

function tickStep(model, dt, decisions, p) {
  const cp = p.waterSpecificHeat;
  const fFull = p.waterFlowRate;

  const Tcoll = model.collector;
  const Ttop = model.tank_top;
  // Read the TANK BOTTOM ZONE temperature, not the sensor reading. The
  // public `tank_bottom` field is the sensor reading (blended with bolus
  // layer); we preserve the true zone temperature in `tank_bottom_zone`
  // and must feed that back into the next step. Fall back to
  // `tank_bottom` only when starting from a model that lacks the
  // internal field (pre-v2 initial state).
  const Tbot_zone = (model.tank_bottom_zone !== undefined)
    ? model.tank_bottom_zone
    : model.tank_bottom;
  const Tgh = model.greenhouse;
  const Tout = model.outdoor;
  const irr = model.irradiance;
  let waterVol = model.collectorWaterVolume;
  let Vbolus = model.tank_bolus_volume;
  let Tbolus = model.tank_bolus_temp;

  const pump = decisions.actuators.pump;
  const solarFlow = pump && decisions.valves.vi_btm && decisions.valves.vo_coll;
  const radiatorFlow = pump && decisions.valves.vi_top && decisions.valves.vo_rad;
  const drainFlow = pump && decisions.valves.vi_coll && decisions.valves.vo_tank;

  // ── Flow ramp state ──
  let flowRamp = model.flow_ramp;
  const anyFlow = solarFlow || radiatorFlow || drainFlow;
  if (!model.prev_pump && anyFlow) flowRamp = 0;    // pump just turned on
  if (anyFlow) flowRamp = Math.min(1, flowRamp + dt / p.pumpFlowRampSec);
  if (!pump) flowRamp = 0;
  const f = fFull * flowRamp;

  // ── Solar flow: determine inlet temperature (bolus first, then bottom zone) ──
  let Tin = Tbot_zone;
  if (solarFlow && Vbolus > 0 && f > 0) {
    const drawThisStep = f * dt;
    if (drawThisStep >= Vbolus) {
      Tin = (Vbolus * Tbolus + (drawThisStep - Vbolus) * Tbot_zone) / drawThisStep;
      Vbolus = 0;
    } else {
      Tin = Tbolus;
      Vbolus -= drawThisStep;
    }
  }

  // ── Collector ──
  const waterFrac = Math.min(waterVol / p.collectorWaterCapacity, 1);
  const collMass = p.collectorThermalMassDry +
    (p.collectorThermalMassWet - p.collectorThermalMassDry) * waterFrac;

  let Qcoll = 0;
  Qcoll += irr * p.collectorArea * p.collectorAbsorptivity;
  Qcoll -= p.collectorHeatLossCoeff * p.collectorArea * (Tcoll - Tout);
  const Tsky = Tout - p.skyDeltaK;
  Qcoll -= p.collectorSkyLossCoeff * p.collectorArea * (Tcoll - Tsky);

  if (solarFlow && waterVol > 0.1) {
    Qcoll -= f * cp * (Tcoll - Tin);
  }

  const newCollector = Tcoll + (Qcoll / collMass) * dt;

  // Collector water volume
  let newWaterVol = waterVol;
  if (solarFlow) {
    newWaterVol = Math.min(waterVol + f * dt, p.collectorWaterCapacity);
  } else if (drainFlow && waterVol > 0) {
    newWaterVol = Math.max(waterVol - f * dt, 0);
  }

  // During drain, water leaves the collector and arrives at the bolus
  // layer (physically: at the tank bottom near the dip tube).
  if (drainFlow && waterVol > 0) {
    const arriving = Math.min(f * dt, waterVol);
    if (arriving > 0) {
      const newBolus = Math.min(Vbolus + arriving, p.collectorWaterCapacity);
      if (newBolus > 0) {
        Tbolus = (Vbolus * Tbolus + arriving * Tcoll) / newBolus;
      }
      Vbolus = newBolus;
    }
  }

  // ── Tank zones ──
  const Vzone = p.tankVolume * p.tankZoneSplit;
  const Czone = Vzone * cp;

  let Qtop = 0;
  let Qbot = 0;

  if (solarFlow && model.collectorWaterVolume > 0.1) {
    Qtop += f * cp * (Tcoll - Ttop);
  }

  if (radiatorFlow) {
    const Qrad = p.radiatorCoeff * (Ttop - Tgh);
    const Treturn = Math.max(Ttop - Qrad / (fFull * cp || 1), Tgh);
    Qtop -= f * cp * (Ttop - Tbot_zone);
    Qbot += f * cp * (Treturn - Tbot_zone);
  }

  if (decisions.actuators.immersion_heater) Qtop += p.immersionHeaterPower;

  Qtop -= (p.tankInsulationLoss / 2) * (Ttop - Tout);
  Qbot -= (p.tankInsulationLoss / 2) * (Tbot_zone - Tout);

  // Inter-zone mixing
  let mixCoeff;
  if (Tbot_zone > Ttop) mixCoeff = p.tankConvectiveMixing;
  else if (solarFlow || radiatorFlow) mixCoeff = p.tankPumpMixingCoeff;
  else mixCoeff = p.tankMixingCoeff;
  const Qmix = mixCoeff * (Ttop - Tbot_zone);
  Qtop -= Qmix;
  Qbot += Qmix;

  const newTankTop = Ttop + (Qtop / Czone) * dt;
  let newTankBottom_zone = Tbot_zone + (Qbot / Czone) * dt;

  // ── Bolus layer dynamics ──
  if (Vbolus > 0) {
    const alpha = Math.min(1, dt / p.bolusMixTauSec);
    const dEnergy = Vbolus * cp * (Tbolus - newTankBottom_zone) * alpha;
    newTankBottom_zone += dEnergy / Czone;
    Tbolus += alpha * (newTankBottom_zone - Tbolus);
    Vbolus = Math.max(0, Vbolus * (1 - alpha));
  }

  // ── Greenhouse ──
  let Qgh = 0;
  Qgh -= p.greenhouseHeatLoss * (Tgh - Tout);
  if (radiatorFlow) Qgh += p.radiatorCoeff * (Ttop - Tgh);
  if (decisions.actuators.space_heater) Qgh += p.spaceHeaterPower;
  // Passive solar gain through glazing (scenarios leave area = 0 → no-op).
  if (irr > 0 && p.greenhouseGlazingArea > 0) {
    Qgh += p.greenhouseSolarTransmittance * irr * p.greenhouseGlazingArea;
  }
  const newGreenhouse = Tgh + (Qgh / p.greenhouseThermalMass) * dt;

  // ── Sensor model ──
  // tank_bottom_sensor reads the bolus when bolus is present (sensor is
  // physically at the dip-tube level, where the bolus sits).
  let tank_bottom_sensor;
  if (Vbolus > p.bolusSensorThreshold) {
    tank_bottom_sensor = Tbolus;
  } else if (Vbolus > 0) {
    const w = Vbolus / p.bolusSensorThreshold;
    tank_bottom_sensor = w * Tbolus + (1 - w) * newTankBottom_zone;
  } else {
    tank_bottom_sensor = newTankBottom_zone;
  }

  return {
    collector: newCollector,
    tank_top: newTankTop,
    tank_bottom: tank_bottom_sensor,
    tank_bottom_zone: newTankBottom_zone,
    tank_bolus_volume: Vbolus,
    tank_bolus_temp: Tbolus,
    flow_ramp: flowRamp,
    prev_pump: pump,
    greenhouse: newGreenhouse,
    outdoor: Tout,
    irradiance: irr,
    collectorWaterVolume: newWaterVol,
  };
}

// ── Class API (used by playground) ──────────────────────────────────
//
// Thin wrapper over tick(). The browser simulator operates on class-
// style field names (t_tank_top, t_collector, …) and dispatches the
// current mode string rather than a full valve decision object; the
// wrapper translates to/from the functional model on every step.

// Mode → valves mapping. Matches MODE_VALVES in shelly/control-logic.js
// but lives here so physics.js stays free of any cross-dependency.
// Keys are lowercase to match how ControlStateMachine.evaluate() emits
// them (the browser simulator owns the lowercasing).
const MODE_VALVES_LC = {
  idle: {
    vi_btm: false, vi_top: false, vi_coll: false,
    vo_coll: false, vo_rad: false, vo_tank: false, v_air: false,
  },
  solar_charging: {
    vi_btm: true, vi_top: false, vi_coll: false,
    vo_coll: true, vo_rad: false, vo_tank: false, v_air: false,
  },
  greenhouse_heating: {
    vi_btm: false, vi_top: true, vi_coll: false,
    vo_coll: false, vo_rad: true, vo_tank: false, v_air: false,
  },
  active_drain: {
    vi_btm: false, vi_top: false, vi_coll: true,
    vo_coll: false, vo_rad: false, vo_tank: true, v_air: true,
  },
  emergency_heating: {
    vi_btm: false, vi_top: false, vi_coll: false,
    vo_coll: false, vo_rad: false, vo_tank: false, v_air: false,
  },
};

// Class-facing parameter defaults. Legacy names preserved because
// main.js writes to them via slider callbacks (model.p.greenhouse_UA,
// model.p.greenhouse_thermal_mass).
const CLASS_DEFAULTS = {
  greenhouse_UA: PARAMS.greenhouseHeatLoss,
  greenhouse_thermal_mass: PARAMS.greenhouseThermalMass,
  // Playground shows a realistic daytime greenhouse warming curve.
  greenhouse_glazing_area: 4.0,
  greenhouse_solar_transmittance: 0.15,
};

export class ThermalModel {
  constructor(params = {}) {
    this.p = { ...CLASS_DEFAULTS, ...params };
    this.reset();
  }

  reset(initial = {}) {
    this.state = {
      // Public class-facing fields — read/written by main.js, simLoop,
      // bootstrap snapshot loader.
      t_tank_top: initial.t_tank_top ?? 12,
      t_tank_bottom: initial.t_tank_bottom ?? 9,
      t_collector: initial.t_collector ?? 10,
      t_greenhouse: initial.t_greenhouse ?? 11,
      t_outdoor: initial.t_outdoor ?? 10,
      irradiance: initial.irradiance ?? 500,
      simTime: 0,
      // Internal functional-model bookkeeping carried across steps.
      // Default the collector full — matches the normal-operation
      // state the playground starts in (drain-on-freeze still empties
      // it when the control logic calls for it).
      collectorWaterVolume: initial.collectorWaterVolume ?? PARAMS.collectorWaterCapacity,
      tank_bolus_volume: 0,
      tank_bolus_temp: initial.t_tank_bottom ?? 9,
      tank_bottom_zone: initial.t_tank_bottom ?? 9,
      flow_ramp: 0,
      prev_pump: false,
    };
  }

  _effectiveParams() {
    return {
      ...PARAMS,
      greenhouseThermalMass: this.p.greenhouse_thermal_mass,
      greenhouseHeatLoss: this.p.greenhouse_UA,
      greenhouseGlazingArea: this.p.greenhouse_glazing_area,
      greenhouseSolarTransmittance: this.p.greenhouse_solar_transmittance,
    };
  }

  /**
   * Advance simulation by dt seconds.
   * @param {number} dt       — timestep in seconds
   * @param {object} env      — { t_outdoor, irradiance }
   * @param {object} actuators — { pump, fan, space_heater, immersion_heater? }
   * @param {string} mode     — current operating mode (lowercase)
   * @returns {object} updated state
   */
  step(dt, env, actuators, mode) {
    const s = this.state;
    if (env.t_outdoor !== undefined) s.t_outdoor = env.t_outdoor;
    if (env.irradiance !== undefined) s.irradiance = env.irradiance;

    const valves = MODE_VALVES_LC[mode] || MODE_VALVES_LC.idle;
    const decisions = {
      valves,
      actuators: {
        pump: !!actuators.pump,
        fan: !!actuators.fan,
        space_heater: !!actuators.space_heater,
        immersion_heater: !!actuators.immersion_heater,
      },
    };

    const fm = {
      collector: s.t_collector,
      tank_top: s.t_tank_top,
      tank_bottom: s.t_tank_bottom,
      tank_bottom_zone: s.tank_bottom_zone,
      greenhouse: s.t_greenhouse,
      outdoor: s.t_outdoor,
      irradiance: s.irradiance,
      collectorWaterVolume: s.collectorWaterVolume,
      tank_bolus_volume: s.tank_bolus_volume,
      tank_bolus_temp: s.tank_bolus_temp,
      flow_ramp: s.flow_ramp,
      prev_pump: s.prev_pump,
    };

    const next = tick(fm, dt, decisions, this._effectiveParams());

    s.t_collector = next.collector;
    s.t_tank_top = next.tank_top;
    s.t_tank_bottom = next.tank_bottom;
    s.tank_bottom_zone = next.tank_bottom_zone;
    s.t_greenhouse = next.greenhouse;
    s.collectorWaterVolume = next.collectorWaterVolume;
    s.tank_bolus_volume = next.tank_bolus_volume;
    s.tank_bolus_temp = next.tank_bolus_temp;
    s.flow_ramp = next.flow_ramp;
    s.prev_pump = next.prev_pump;
    s.simTime += dt;

    return { ...s };
  }

  getState() {
    return { ...this.state };
  }
}
