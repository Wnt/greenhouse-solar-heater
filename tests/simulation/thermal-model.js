// Lumped-parameter thermal model for greenhouse solar heating simulation
// Pure functions — no side effects, no mutation

const PARAMS = {
  // Collector
  collectorArea: 4,                // m²
  collectorAbsorptivity: 0.8,
  collectorHeatLossCoeff: 5,       // W/(m²·K)
  collectorThermalMassDry: 5000,   // J/K
  collectorThermalMassWet: 20000,  // J/K
  collectorWaterCapacity: 10,      // liters

  // Tank
  tankVolume: 300,                 // liters
  tankZoneSplit: 0.5,
  tankInsulationLoss: 2,           // W/K total
  tankMixingCoeff: 0.5,            // W/K (stable: top > bottom)
  tankConvectiveMixing: 500,       // W/K (unstable: bottom > top, rapid natural convection)

  // Greenhouse
  greenhouseHeatLoss: 50,          // W/K
  greenhouseThermalMass: 500000,   // J/K
  radiatorCoeff: 200,              // W/K
  spaceHeaterPower: 2000,          // W
  immersionHeaterPower: 2000,      // W (heats tank top zone)

  // Water
  waterFlowRate: 5 / 60,           // L/s (5 L/min)
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
