/**
 * Thermal Physics Engine
 *
 * Simplified lumped-parameter model:
 * - Two-node tank (top/bottom) with stratification
 * - Flat-plate collector gain (Hottel-Whillier) with proper thermal mass
 * - Greenhouse heat loss
 * - Radiator heat output bounded by flow capacity
 */

// Physical constants
const WATER_CP = 4186;       // J/(kg·K)
const WATER_DENSITY = 1000;  // kg/m³

// System parameters (from system.yaml, with sensible defaults)
const DEFAULTS = {
  collector_area: 4.0,          // m²
  collector_eta0: 0.75,         // optical efficiency
  collector_UL: 4.0,            // W/(m²·K) loss coefficient
  collector_water_volume: 0.008,// m³ (8L in collectors)
  collector_plate_mass_cp: 20000, // J/K (absorber plate thermal capacity)
  tank_volume: 0.300,           // m³ (300L)
  tank_UA: 3.0,                 // W/K tank heat loss (insulated)
  greenhouse_UA: 25.0,          // W/K greenhouse envelope loss
  greenhouse_thermal_mass: 250000, // J/K (air + soil + structure)
  greenhouse_glazing_area: 4.0,  // m² effective south-facing glazing
  greenhouse_solar_transmittance: 0.15, // fraction of solar radiation transmitted
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
      t_tank_top: initial.t_tank_top ?? 12,
      t_tank_bottom: initial.t_tank_bottom ?? 9,
      t_collector: initial.t_collector ?? 10,
      t_greenhouse: initial.t_greenhouse ?? 11,
      t_outdoor: initial.t_outdoor ?? 10,
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

    const tankTopMass = (p.tank_volume / 2) * WATER_DENSITY;   // 150 kg
    const tankBotMass = (p.tank_volume / 2) * WATER_DENSITY;   // 150 kg

    // Collector thermal mass: water + absorber plate
    const collectorWaterMass = p.collector_water_volume * WATER_DENSITY; // 8 kg
    const collectorThermalMass = collectorWaterMass * WATER_CP + p.collector_plate_mass_cp;

    // ── Collector solar gain & heat loss (always active) ──
    const Q_coll_solar = p.collector_eta0 * p.collector_area * s.irradiance; // W
    const Q_coll_loss = p.collector_UL * p.collector_area *
      Math.max(s.t_collector - s.t_outdoor, 0); // W (loss to ambient)
    const Q_coll_net = Q_coll_solar - Q_coll_loss; // W (can be negative if cold & cloudy)

    // ── No-flow collector: heats/cools from sun and ambient ──
    if (!actuators.pump || (mode !== 'solar_charging')) {
      s.t_collector += Q_coll_net * dt / collectorThermalMass;
      // Collector can't go below outdoor temp (ambient loss limit)
      if (Q_coll_net < 0 && s.t_collector < s.t_outdoor) {
        s.t_collector = s.t_outdoor;
      }
    }

    // ── Solar Charging mode ──
    // Flow path: tank bottom → pump → collector → reservoir → tank top
    if (actuators.pump && mode === 'solar_charging') {
      const flowRate = p.pump_flow / 60 / 1000; // m³/s
      const flowMass = flowRate * WATER_DENSITY * dt; // kg moved this step

      // Cold water from tank bottom enters collector
      const t_in = s.t_tank_bottom;

      // Collector absorbs solar energy and exchanges heat with flowing water.
      // The collector temperature changes gradually based on:
      // 1. Solar gain onto absorber plate
      // 2. Heat loss to ambient
      // 3. Heat transfer from collector to flowing water
      // Heat exchange between collector and water: proportional to temp difference
      const collectorToWaterUA = flowRate * WATER_DENSITY * WATER_CP; // W/K (perfect heat exchanger)
      const Q_to_water = collectorToWaterUA * (s.t_collector - t_in); // W transferred to water

      // Update collector temperature: gains from sun, loses to ambient and water
      const dT_collector = (Q_coll_net - Q_to_water) * dt / collectorThermalMass;
      s.t_collector += dT_collector;

      // Water outlet temperature from collector
      const Q_pipe_loss = p.pipe_loss_per_meter * p.outdoor_pipe_length *
        (s.t_collector - s.t_outdoor); // W
      const t_out = t_in + (Q_to_water - Q_pipe_loss) * dt /
        Math.max(flowMass * WATER_CP, 1);

      // Hot water enters tank top (via reservoir) — only if warmer than tank top
      const energyIn = flowMass * WATER_CP * (t_out - s.t_tank_top);
      s.t_tank_top += energyIn / (tankTopMass * WATER_CP);

      // Cold water drawn from tank bottom — replaced by slightly warmer water
      // mixing down from above (handled by stratification mixing below)
    }

    // ── Greenhouse Heating mode ──
    // Flow path: tank top → dip tube → reservoir → pump → radiator → tank bottom
    if (actuators.pump && mode === 'greenhouse_heating') {
      const flowRate = p.pump_flow / 60 / 1000; // m³/s
      const flowMass = flowRate * WATER_DENSITY * dt; // kg moved this step

      // Hot water from tank top goes to radiator
      const t_water_in = s.t_tank_top;

      // Radiator heat transfer — bounded by BOTH radiator UA AND flow capacity
      // The radiator can't transfer more heat than the water can carry
      const radiator_potential = p.radiator_UA * (t_water_in - s.t_greenhouse); // W
      const flow_capacity = flowRate * WATER_DENSITY * WATER_CP *
        (t_water_in - s.t_greenhouse); // W (max if water exits at greenhouse temp)
      const Q_rad_rate = Math.max(Math.min(radiator_potential, flow_capacity), 0); // W
      const Q_rad = Q_rad_rate * dt; // J

      // Heat delivered to greenhouse
      s.t_greenhouse += Q_rad / p.greenhouse_thermal_mass;

      // Water returns cooler to tank bottom
      const t_water_out = t_water_in - Q_rad / Math.max(flowMass * WATER_CP, 1);
      // Clamp: water can't exit colder than greenhouse temp
      const t_return = Math.max(t_water_out, s.t_greenhouse);

      // Tank top loses the hot water that was drawn out.
      // The drawn volume is replaced by water from below (via mixing).
      // Energy balance: tank top loses energy proportional to flow volume
      const energyDrawn = flowMass * WATER_CP * (s.t_tank_top - s.t_tank_bottom);
      s.t_tank_top -= energyDrawn / (tankTopMass * WATER_CP);

      // Tank bottom receives cooled return water
      const energyReturn = flowMass * WATER_CP * (t_return - s.t_tank_bottom);
      s.t_tank_bottom += energyReturn / (tankBotMass * WATER_CP);
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
      // Natural stratification: top hot, bottom cold. Slow diffusion.
      s.t_tank_top -= diff * mixRate * 0.3;
      s.t_tank_bottom += diff * mixRate * 0.3;
    } else {
      // Inverted (bottom hotter than top): rapid convective mixing
      s.t_tank_top -= diff * mixRate * 2;
      s.t_tank_bottom += diff * mixRate * 2;
    }

    // ── Tank heat loss to environment ──
    const t_tank_avg = (s.t_tank_top + s.t_tank_bottom) / 2;
    const Q_tank_loss = p.tank_UA * (t_tank_avg - s.t_outdoor) * dt;
    s.t_tank_top -= Q_tank_loss * 0.5 / (tankTopMass * WATER_CP);
    s.t_tank_bottom -= Q_tank_loss * 0.5 / (tankBotMass * WATER_CP);

    // ── Greenhouse heat loss to outside ──
    const Q_gh_loss = p.greenhouse_UA * (s.t_greenhouse - s.t_outdoor) * dt;
    s.t_greenhouse -= Q_gh_loss / p.greenhouse_thermal_mass;

    // ── Passive solar gain into greenhouse ──
    // Solar radiation passes through glazing and heats the greenhouse
    if (s.irradiance > 0) {
      const Q_solar_passive = p.greenhouse_solar_transmittance * s.irradiance *
        p.greenhouse_glazing_area * dt; // W·s = J
      s.t_greenhouse += Q_solar_passive / p.greenhouse_thermal_mass;
    }

    s.simTime += dt;
    return { ...s };
  }

  getState() {
    return { ...this.state };
  }
}
