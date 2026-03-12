/**
 * Thermal Physics Engine
 *
 * Simplified lumped-parameter model:
 * - Two-node tank (top/bottom) with stratification
 * - Flat-plate collector gain (Hottel-Whillier)
 * - Greenhouse heat loss
 * - Radiator heat output
 */

// Physical constants
const WATER_CP = 4186;       // J/(kg·K)
const WATER_DENSITY = 1000;  // kg/m³

// System parameters (from system.yaml, with sensible defaults)
const DEFAULTS = {
  collector_area: 4.0,          // m²
  collector_eta0: 0.75,         // optical efficiency
  collector_UL: 4.0,            // W/(m²·K) loss coefficient
  tank_volume: 0.300,           // m³ (300L)
  tank_UA: 3.0,                 // W/K tank heat loss (insulated)
  greenhouse_UA: 25.0,          // W/K greenhouse envelope loss
  greenhouse_thermal_mass: 50000, // J/K (air + soil + structure)
  radiator_UA: 150.0,           // W/K radiator transfer coefficient
  pump_flow: 6.0,               // L/min
  pipe_loss_per_meter: 0.5,     // W/K per meter of outdoor pipe
  outdoor_pipe_length: 8.0,     // meters of outdoor pipe
  tank_mixing_coeff: 0.002,     // fraction per second of stratification mixing
};

export class ThermalModel {
  constructor(params = {}) {
    this.p = { ...DEFAULTS, ...params };
    this.reset();
  }

  reset(initial = {}) {
    this.state = {
      t_tank_top: initial.t_tank_top ?? 40,
      t_tank_bottom: initial.t_tank_bottom ?? 35,
      t_collector: initial.t_collector ?? 20,
      t_greenhouse: initial.t_greenhouse ?? 8,
      t_outdoor: initial.t_outdoor ?? 5,
      irradiance: initial.irradiance ?? 500,
      simTime: 0,
    };
  }

  /**
   * Advance simulation by dt seconds.
   * @param {number} dt - timestep in seconds
   * @param {object} env - { t_outdoor, irradiance }
   * @param {object} actuators - { pump: bool, fan: bool, space_heater: bool }
   * @param {string} mode - current operating mode name
   * @returns {object} updated state
   */
  step(dt, env, actuators, mode) {
    const s = this.state;
    const p = this.p;

    // Update environment
    if (env.t_outdoor !== undefined) s.t_outdoor = env.t_outdoor;
    if (env.irradiance !== undefined) s.irradiance = env.irradiance;

    const tankTopMass = (p.tank_volume / 2) * WATER_DENSITY;
    const tankBotMass = (p.tank_volume / 2) * WATER_DENSITY;

    // ── Collector ──
    let Q_collector = 0;
    if (s.irradiance > 0) {
      // Collector stagnation temp when no flow
      const t_coll_avg = actuators.pump && mode === 'solar_charging'
        ? (s.t_collector + s.t_tank_bottom) / 2
        : s.t_collector;
      Q_collector = p.collector_eta0 * p.collector_area * s.irradiance
        - p.collector_UL * p.collector_area * (t_coll_avg - s.t_outdoor);
      Q_collector = Math.max(Q_collector, 0);
    }

    // Collector temperature
    const collectorMass = 8 * WATER_DENSITY / 1000; // ~8L water in collectors
    const collectorThermalMass = collectorMass * WATER_CP + 20000; // + absorber plate mass
    if (!actuators.pump || mode === 'active_drain') {
      // No flow: collector heats up from sun, loses to ambient
      const Q_coll_loss = p.collector_UL * p.collector_area * (s.t_collector - s.t_outdoor);
      const Q_coll_gain = p.collector_eta0 * p.collector_area * s.irradiance;
      s.t_collector += (Q_coll_gain - Q_coll_loss) * dt / collectorThermalMass;
    }

    // ── Solar Charging mode ──
    if (actuators.pump && mode === 'solar_charging') {
      const flowRate = p.pump_flow / 60 / 1000; // m³/s
      const flowMass = flowRate * WATER_DENSITY * dt; // kg moved this step

      // Water from tank bottom goes to collector
      const t_in = s.t_tank_bottom;
      // Collector heats it
      const Q_pipe_loss = p.pipe_loss_per_meter * p.outdoor_pipe_length * (s.t_collector - s.t_outdoor) * dt;
      const t_out = t_in + (Q_collector * dt - Q_pipe_loss) / Math.max(flowMass * WATER_CP, 1);
      s.t_collector = t_in + (t_out - t_in) * 0.5; // avg collector temp

      // Hot water enters tank top (via reservoir)
      const energyIn = flowMass * WATER_CP * (t_out - s.t_tank_top);
      s.t_tank_top += energyIn / (tankTopMass * WATER_CP);

      // Cold water drawn from tank bottom
      const energyOut = flowMass * WATER_CP * (s.t_tank_bottom - t_in);
      // bottom temp stays roughly the same (drawing from itself)
    }

    // ── Greenhouse Heating mode ──
    if (actuators.pump && mode === 'greenhouse_heating') {
      const flowRate = p.pump_flow / 60 / 1000;
      const flowMass = flowRate * WATER_DENSITY * dt;

      // Water from tank top → radiator
      const t_water_in = s.t_tank_top;
      const radiator_output = p.radiator_UA * (t_water_in - s.t_greenhouse);
      const Q_rad = Math.max(radiator_output, 0) * dt;

      // Heat to greenhouse
      s.t_greenhouse += Q_rad / p.greenhouse_thermal_mass;

      // Water returns cooler to tank bottom
      const t_water_out = t_water_in - Q_rad / Math.max(flowMass * WATER_CP, 1);
      const energyLost = flowMass * WATER_CP * (s.t_tank_top - t_water_out);
      s.t_tank_top -= energyLost / (tankTopMass * WATER_CP) * 0.7;
      s.t_tank_bottom += flowMass * WATER_CP * (t_water_out - s.t_tank_bottom) / (tankBotMass * WATER_CP) * 0.3;
    }

    // ── Fan effect (radiator fan boosts heat transfer) ──
    if (actuators.fan && mode === 'greenhouse_heating') {
      // Fan already factored into radiator_UA — just cosmetic
    }

    // ── Space heater (emergency) ──
    if (actuators.space_heater) {
      const Q_heater = 2000 * dt; // 2kW
      s.t_greenhouse += Q_heater / p.greenhouse_thermal_mass;
    }

    // ── Tank stratification mixing ──
    const mixRate = p.tank_mixing_coeff * dt;
    const diff = s.t_tank_top - s.t_tank_bottom;
    if (diff > 0) {
      // Natural stratification: top stays hot. Slow mixing downward.
      s.t_tank_top -= diff * mixRate * 0.3;
      s.t_tank_bottom += diff * mixRate * 0.3;
    } else {
      // Inverted: fast mixing to equalize
      s.t_tank_top -= diff * mixRate * 2;
      s.t_tank_bottom += diff * mixRate * 2;
    }

    // ── Tank heat loss to environment ──
    const Q_tank_loss = p.tank_UA * ((s.t_tank_top + s.t_tank_bottom) / 2 - s.t_outdoor) * dt;
    s.t_tank_top -= Q_tank_loss * 0.5 / (tankTopMass * WATER_CP);
    s.t_tank_bottom -= Q_tank_loss * 0.5 / (tankBotMass * WATER_CP);

    // ── Greenhouse heat loss to outside ──
    const Q_gh_loss = p.greenhouse_UA * (s.t_greenhouse - s.t_outdoor) * dt;
    s.t_greenhouse -= Q_gh_loss / p.greenhouse_thermal_mass;

    // ── Solar gain into greenhouse (passive, small) ──
    if (s.irradiance > 50) {
      const Q_solar_passive = 0.1 * s.irradiance * 2 * dt; // ~10% of 2m² window
      s.t_greenhouse += Q_solar_passive / p.greenhouse_thermal_mass;
    }

    s.simTime += dt;
    return { ...s };
  }

  getState() {
    return { ...this.state };
  }
}
