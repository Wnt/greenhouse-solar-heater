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
//     2.5 L/min.
//
//   - Greenhouse mass: qualitative only. Dusk→dawn cooling consistently
//     follows a τ ≈ 5-6 h trajectory rather than the modeled 2.78 h.
//     Doubled greenhouseThermalMass to 1_000_000 J/K to match the
//     observed timescale.
//
// Model v2 additions (also 2026-04-23):
//
//   - Drain bolus: on every active_drain completion, the collector's
//     ~10 L of water falls into the very bottom of the tank (physical
//     drainback system, dip-tube geometry). That cold slug is what the
//     tank_bottom sensor physically reads (not a zone average) for
//     hours after a drain. Real data on 2026-04-21 21:44: tank_bottom
//     dropped 35.45 → 16.7 °C in 6 min, then recovered over ~11 h (τ
//     ≈ 4 h fitted). Modeled as a 10 L bolus layer with its own
//     temperature; the tank_bottom sensor reads the bolus when present,
//     the bolus mixes into the lower zone with τ_bolus, and solar-flow
//     intake draws from the bolus first before pulling from the zone.
//     This is what creates the "collector spikes to 85 °C for a few
//     minutes after morning pump-start" pattern in the real data —
//     the dry-baked collector gets flushed with frigid bolus water,
//     peak plate temp stays high for the first ~1-2 min because the
//     absorber's thermal mass dominates, then drops fast as plate heat
//     transfers to the cold stream.
//
//     Bolus τ was refit 2026-04-23 (second pass) against 10 h of
//     post-21:44 recovery: sensor 16.7 → 28.8 °C, τ = 21 h (R² 0.71).
//     Using 20 h. Earlier 4 h was an eyeball guess — 5× too fast.
//
//   - Flow ramp: pump flow goes 0 → steady over pumpFlowRampSec
//     seconds after each pump-on. Captures priming + pipe-fill +
//     startup transients. Without this, the first 30 s of every
//     session has full-flow cooling that scrubs the collector too
//     fast.
//
//   - Sky radiation: the collector faces a ~270 K sky on clear nights
//     and radiates to it, driving plate temp below ambient. Modeled
//     as an additional convective-style loss term toward a sky
//     temperature of T_outdoor - skyDeltaK. Without this, freeze-
//     drain timing, dawn refill timing, and night collector temps all
//     disagree with production data.

const PARAMS = {
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
  // Earlier first-pass fit said C_dry ≈ 5 kJ/K, but that used the single
  // h*A = 20 W/K (before the sky term was added), so it undershot by
  // exactly the right factor. 50 kJ/K also lines up with literature for a
  // 4 m² glazed flat-plate collector (8-15 kJ/(m²·K) × 4 m² = 32-60 kJ/K).
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
  // Second-pass exponential fit against log((T_zone - T_sensor)) with
  // T_zone ≈ tank_top - 2 K gave τ = 21 h (R² = 0.71). Using 20 h for
  // simulation — earlier guess of 4 h decayed the bolus 5× too fast.
  bolusMixTauSec: 20 * 3600,       // seconds
  bolusSensorThreshold: 0.5,       // L — below this, sensor reads zone, not bolus

  // Pump startup transient: flow ramps from 0 → steady over this window.
  // Qualitative: ~60 s is typical for a drainback loop to prime + fill.
  pumpFlowRampSec: 60,

  // Greenhouse
  greenhouseHeatLoss: 50,          // W/K
  greenhouseThermalMass: 1000000,  // J/K
  radiatorCoeff: 200,              // W/K — no heating sessions in calibration window
  spaceHeaterPower: 2000,          // W
  immersionHeaterPower: 2000,      // W

  // Water
  waterFlowRate: 2.5 / 60,         // L/s
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

function tick(model, dt, decisions, params) {
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
  const waterVol = model.collectorWaterVolume;
  let Vbolus = model.tank_bolus_volume;
  let Tbolus = model.tank_bolus_temp;

  const pump = decisions.actuators.pump;
  const solarFlow = pump && decisions.valves.vi_btm && decisions.valves.vo_coll;
  const radiatorFlow = pump && decisions.valves.vi_top && decisions.valves.vo_rad;
  const drainFlow = pump && decisions.valves.vi_coll && decisions.valves.vo_tank;

  // ── Flow ramp state ──
  // Ramp progresses from 0 → 1 over pumpFlowRampSec while ANY flow path is
  // active, resets when pump turns off.
  let flowRamp = model.flow_ramp;
  const anyFlow = solarFlow || radiatorFlow || drainFlow;
  if (!model.prev_pump && anyFlow) flowRamp = 0;    // pump just turned on
  if (anyFlow) flowRamp = Math.min(1, flowRamp + dt / p.pumpFlowRampSec);
  if (!pump) flowRamp = 0;
  const f = fFull * flowRamp;

  // ── Solar flow: determine inlet temperature (bolus first, then bottom zone) ──
  // The pump draws from the bottom of the tank. If a bolus is present at
  // the very bottom, the first water through is bolus-temp; after the bolus
  // is consumed, normal bottom-zone water flows.
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
  // Convective loss to ambient air
  Qcoll -= p.collectorHeatLossCoeff * p.collectorArea * (Tcoll - Tout);
  // Radiative loss toward sky (at T_out - skyDeltaK)
  const Tsky = Tout - p.skyDeltaK;
  Qcoll -= p.collectorSkyLossCoeff * p.collectorArea * (Tcoll - Tsky);

  // Flow cooling: water goes in at Tin, leaves at ~Tcoll (assuming near-equilibrium
  // in a single pass — simplification; real collectors have finite heat-exchange
  // effectiveness but lumped f·cp·(Tcoll-Tin) is the conservative energy balance).
  if (solarFlow && waterVol > 0.1) {
    Qcoll -= f * cp * (Tcoll - Tin);
  }
  if (drainFlow && waterVol > 0) {
    // Water leaves the collector at Tcoll, no inflow (collector emptying).
    // Energy leaving the collector shell: f × cp × Tcoll per unit time.
    // Since collMass represents only the water still inside, and the
    // temperature of remaining water doesn't change when a mass of water
    // at Tcoll leaves, this term is zero. The collMass reduction via
    // waterFrac captures the heat leaving with the water.
    // (Kept as comment for clarity; no explicit term needed.)
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
  // layer (physically: at the tank bottom near the dip tube). Accumulates
  // gradually through the drain — not in a single dump at completion.
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
    // Hot water returns to the top zone at Tcoll
    Qtop += f * cp * (Tcoll - Ttop);
    // Cold water leaves from the bottom (either bolus or zone). The zone
    // itself only loses energy at the rate (drawn bottom-zone water) × ΔT
    // where ΔT is (Tbot_zone − Tin_zone_avg). But in this simplification
    // the draw balances at the top via mixing — explicit net flow on bot
    // zone is zero when draw is from bolus (bolus handles the loss).
    // When draw is from zone (bolus empty), flow is a net zero on the zone
    // because the return from the loop to the tank enters the top, and the
    // bot-zone water leaves at bot_zone temp → carried to collector. This
    // is captured in the top-zone gain above and in inter-zone mixing.
  }

  if (radiatorFlow) {
    const Qrad = p.radiatorCoeff * (Ttop - Tgh);
    const Treturn = Math.max(Ttop - Qrad / (fFull * cp || 1), Tgh);
    Qtop -= f * cp * (Ttop - Tbot_zone);
    Qbot += f * cp * (Treturn - Tbot_zone);
  }

  // Drain flow no longer directly heats the bot zone — it fills the bolus
  // layer (handled above). Bolus→zone mixing transfers energy over the
  // bolusMixTauSec timescale (handled below after zone update).

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
  // Bolus mixes with the bot zone over τ_bolus. This transfers BOTH
  // thermal energy and mass. Energy leaving the bolus equals energy
  // entering the zone, so total bottom-region energy is conserved.
  if (Vbolus > 0) {
    const alpha = Math.min(1, dt / p.bolusMixTauSec);
    // Energy moved bolus → zone this step (positive if bolus hotter)
    const dEnergy = Vbolus * cp * (Tbolus - newTankBottom_zone) * alpha;
    // Apply energy to the zone temperature (cp × m, with m as 150 kg)
    newTankBottom_zone += dEnergy / Czone;
    // Update bolus temperature toward zone
    Tbolus += alpha * (newTankBottom_zone - Tbolus);
    // Volume decays — mass transfer from bolus to zone. τ_bolus is ~4 h
    // from real-data fit.
    Vbolus = Math.max(0, Vbolus * (1 - alpha));
  }

  // ── Greenhouse ──
  let Qgh = 0;
  Qgh -= p.greenhouseHeatLoss * (Tgh - Tout);
  if (radiatorFlow) Qgh += p.radiatorCoeff * (Ttop - Tgh);
  if (decisions.actuators.space_heater) Qgh += p.spaceHeaterPower;
  const newGreenhouse = Tgh + (Qgh / p.greenhouseThermalMass) * dt;

  // ── Sensor model ──
  // tank_bottom_sensor reads the bolus when bolus is present (sensor is
  // physically at the dip-tube level, where the bolus sits). When bolus
  // is below the sensor threshold, it reads the bottom zone.
  let tank_bottom_sensor;
  if (Vbolus > p.bolusSensorThreshold) {
    tank_bottom_sensor = Tbolus;
  } else if (Vbolus > 0) {
    // Smooth transition: blend bolus and zone by remaining volume
    const w = Vbolus / p.bolusSensorThreshold;
    tank_bottom_sensor = w * Tbolus + (1 - w) * newTankBottom_zone;
  } else {
    tank_bottom_sensor = newTankBottom_zone;
  }

  return {
    collector: newCollector,
    tank_top: newTankTop,
    // Public "tank_bottom" is the SENSOR reading, not the zone temperature.
    // Internally we keep the zone temp separately (tank_bottom_zone).
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

module.exports = { createModel, tick, PARAMS };
