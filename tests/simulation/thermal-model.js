// Lumped-parameter thermal model for greenhouse solar heating simulation
// Pure functions — no side effects, no mutation
//
// Parameter calibration (2026-04-23):
//   Several parameters were fit against 3 days of production telemetry
//   (2026-04-20 20:14 → 2026-04-23 17:52, 2-min resolution; see
//   greenhouse.tsv on branch thermal-simulation-model-improvements).
//   Methodology notes:
//
//   - Tank insulation fit uses tank_top only (not the mean of top+bottom).
//     The drainback dumps the collector's ~10 L of cold water right at
//     the dip tube near the tank_bottom sensor, so tank_bottom is
//     unreliable for energy-balance fits for several hours after every
//     drain event. Three overnight windows (post-drain, pump off, idle)
//     converged on U_top ≈ 1.7–2.0 W/K → U_tank ≈ 3.4–4.0 W/K (R² 0.86–
//     0.97). Using 4 W/K.
//
//   - Tank mixing fit: one clean night-21→22 window, d(top-bot)/dt log-
//     linear regression gave mix ≈ 3.8 W/K (R² 0.92). Using 4 W/K.
//
//   - Water flow rate: energy-balance on the 2026-04-21 09:04 session
//     (262 min continuous solar_charging). Six rolling 30-min midsection
//     windows gave 2.11–2.66 L/min — duration-weighted 2.4 L/min. Using
//     2.5 L/min. This was the biggest simulator error: the old 5 L/min
//     pinned T_coll ≈ T_bot+7 under flow, but reality runs T_coll
//     ≈ T_bot+8 at half the flow, and can spike to 85 °C under peak sun
//     when the pump briefly can't keep up — which was previously
//     invisible in sim.
//
//   - Greenhouse mass: qualitative only. Dusk→dawn cooling consistently
//     follows a τ ≈ 5–6 h trajectory rather than the modeled 2.78 h.
//     Cleanly fitting is hampered because radiative cooling to the cold
//     sky pulls greenhouse *below* outdoor on clear nights, breaking the
//     first-order decay assumption. Doubling greenhouseThermalMass to
//     1_000_000 J/K to match the observed timescale. The old 500 kJ/K
//     was way under what soil, benches, plants, and framing contribute.
//
//   - Not fit: collectorHeatLossCoeff, collectorThermalMassDry/Wet (the
//     collector radiates to sky temperature, which the model doesn't
//     represent separately — post-drain collector goes subzero under
//     clear skies while outdoor stays warmer), radiatorCoeff (no
//     greenhouse_heating sessions in the 3-day window).

const PARAMS = {
  // Collector
  collectorArea: 4,                // m²
  collectorAbsorptivity: 0.8,
  collectorHeatLossCoeff: 5,       // W/(m²·K) — not re-fit (sky-radiation confounds)
  collectorThermalMassDry: 5000,   // J/K — not re-fit
  collectorThermalMassWet: 20000,  // J/K
  collectorWaterCapacity: 10,      // liters

  // Tank
  tankVolume: 300,                 // liters
  tankZoneSplit: 0.5,
  tankInsulationLoss: 4,           // W/K total (fit 2026-04-23, was 2)
  tankMixingCoeff: 4,              // W/K stable top>bot (fit 2026-04-23, was 0.5)
  tankConvectiveMixing: 500,       // W/K unstable bot>top — natural convection, not fit

  // Greenhouse
  greenhouseHeatLoss: 50,          // W/K — not re-fit
  greenhouseThermalMass: 1000000,  // J/K (bumped 2026-04-23, was 500000; τ=5.56 h vs 2.78 h)
  radiatorCoeff: 200,              // W/K — no heating sessions in calibration window
  spaceHeaterPower: 2000,          // W
  immersionHeaterPower: 2000,      // W (heats tank top zone)

  // Water
  waterFlowRate: 2.5 / 60,         // L/s (2.5 L/min, fit 2026-04-23, was 5/60)
  waterSpecificHeat: 4186,         // J/(kg·K)

  // Pump power (for trace)
  pumpPowerNormal: 50,             // W
  pumpPowerDry: 10,                // W
};

function createModel(overrides) {
  const defaults = {
    collector: 20,
    tank_top: 40,
    tank_bottom: 30,
    greenhouse: 15,
    outdoor: 10,
    irradiance: 0,
    collectorWaterVolume: 0,
  };
  return Object.assign({}, defaults, overrides);
}

// Maximum sub-step size for numerical stability (seconds)
const MAX_SUBSTEP = 10;

function tick(model, dt, decisions, params) {
  const p = params || PARAMS;

  // Sub-step for numerical stability with large dt
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
  const f = p.waterFlowRate;  // L/s

  // Snapshot original temperatures — all heat flows computed from these
  const Tcoll = model.collector;
  const Ttop = model.tank_top;
  const Tbot = model.tank_bottom;
  const Tgh = model.greenhouse;
  const Tout = model.outdoor;
  const irr = model.irradiance;
  let waterVol = model.collectorWaterVolume;

  // Determine flow paths from valve + actuator state
  const pump = decisions.actuators.pump;
  const solarFlow = pump && decisions.valves.vi_btm && decisions.valves.vo_coll;
  const radiatorFlow = pump && decisions.valves.vi_top && decisions.valves.vo_rad;
  const drainFlow = pump && decisions.valves.vi_coll && decisions.valves.vo_tank;

  // ---- Collector ----
  const waterFrac = Math.min(waterVol / p.collectorWaterCapacity, 1);
  const collMass = p.collectorThermalMassDry +
    (p.collectorThermalMassWet - p.collectorThermalMassDry) * waterFrac;

  let Qcoll = 0;
  Qcoll += irr * p.collectorArea * p.collectorAbsorptivity;
  Qcoll -= p.collectorHeatLossCoeff * p.collectorArea * (Tcoll - Tout);

  if (solarFlow && waterVol > 0.1) {
    Qcoll -= f * cp * (Tcoll - Tbot);
  }

  // Drain flow: water leaving collectors takes heat with it
  if (drainFlow && waterVol > 0) {
    Qcoll -= f * cp * (Tcoll - Tbot);
  }

  const newCollector = Tcoll + (Qcoll / collMass) * dt;

  // Collector water volume
  if (solarFlow) {
    waterVol = Math.min(waterVol + f * dt, p.collectorWaterCapacity);
  } else if (drainFlow && waterVol > 0) {
    waterVol = Math.max(waterVol - f * dt, 0);
  }

  // ---- Tank ----
  const Vzone = p.tankVolume * p.tankZoneSplit;
  const Czone = Vzone * cp;

  let Qtop = 0;
  let Qbot = 0;

  if (solarFlow && model.collectorWaterVolume > 0.1) {
    // Hot water from collector enters top zone
    Qtop += f * cp * (Tcoll - Ttop);
    // Bottom zone: water leaves at T_bottom (no net heat change from flow)
  }

  if (radiatorFlow) {
    const Qrad = p.radiatorCoeff * (Ttop - Tgh);
    const Treturn = Math.max(Ttop - Qrad / (f * cp), Tgh);
    // Top zone loses hot water, replaced by cooler bottom water
    Qtop -= f * cp * (Ttop - Tbot);
    // Bottom zone receives cooled return water from radiator
    Qbot += f * cp * (Treturn - Tbot);
  }

  if (drainFlow && model.collectorWaterVolume > 0) {
    Qbot += f * cp * (Tcoll - Tbot);
  }

  // Immersion heater heats tank top zone
  if (decisions.actuators.immersion_heater) {
    Qtop += p.immersionHeaterPower;
  }

  Qtop -= (p.tankInsulationLoss / 2) * (Ttop - Tout);
  Qbot -= (p.tankInsulationLoss / 2) * (Tbot - Tout);

  const mixCoeff = Tbot > Ttop ? p.tankConvectiveMixing : p.tankMixingCoeff;
  const Qmix = mixCoeff * (Ttop - Tbot);
  Qtop -= Qmix;
  Qbot += Qmix;

  const newTankTop = Ttop + (Qtop / Czone) * dt;
  const newTankBottom = Tbot + (Qbot / Czone) * dt;

  // ---- Greenhouse ----
  let Qgh = 0;
  Qgh -= p.greenhouseHeatLoss * (Tgh - Tout);

  if (radiatorFlow) {
    Qgh += p.radiatorCoeff * (Ttop - Tgh);
  }

  if (decisions.actuators.space_heater) {
    Qgh += p.spaceHeaterPower;
  }

  const newGreenhouse = Tgh + (Qgh / p.greenhouseThermalMass) * dt;

  return {
    collector: newCollector,
    tank_top: newTankTop,
    tank_bottom: newTankBottom,
    greenhouse: newGreenhouse,
    outdoor: Tout,
    irradiance: irr,
    collectorWaterVolume: waterVol,
  };
}

module.exports = { createModel, tick, PARAMS };
