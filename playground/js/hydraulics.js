/**
 * Hydraulic Simulation Engine
 *
 * Models communicating vessels physics, volume accounting,
 * air pocket tracking, and drainback dynamics.
 */

const DEFAULTS = {
  tank_volume: 300,          // L total capacity
  tank_height: 200,          // cm
  tank_cross_section: 0.15,  // m² (approx for 300L / 2m)
  reservoir_capacity: 30,    // L
  reservoir_height_range: [200, 220], // cm
  collector_volume: 8,       // L (when full)
  pipe_volume: 6,            // L (total piping)
  dip_tube_opening: 197,     // cm inside tank
  pump_flow_rate: 6,         // L/min
};

export class HydraulicModel {
  constructor(params = {}) {
    this.p = { ...DEFAULTS, ...params };
    this.reset();
  }

  reset(initial = {}) {
    const totalWater = initial.total_water ?? 320;
    // Distribute water across components
    const tankWater = Math.min(totalWater - this.p.pipe_volume, this.p.tank_volume);
    const remainder = totalWater - tankWater - this.p.pipe_volume;

    this.state = {
      // Water volumes in each component (L)
      tank_water: Math.min(tankWater, this.p.tank_volume),
      reservoir_water: Math.max(Math.min(remainder, this.p.reservoir_capacity), 0),
      collector_water: initial.collector_water ?? this.p.collector_volume,
      pipe_water: this.p.pipe_volume,

      // Air/gas
      tank_gas: Math.max(this.p.tank_volume - tankWater, 0), // L of gas in sealed tank
      collector_air: initial.collector_air ?? 0, // L of air in collectors
      system_air: initial.system_air ?? 0, // L of air in pipes

      // Derived levels (cm)
      tank_water_level: 0,
      reservoir_water_level: 0,

      // Status
      pump_primed: true,
      reservoir_overflow: false,

      simTime: 0,
    };

    this._updateLevels();
  }

  _updateLevels() {
    const s = this.state;
    const p = this.p;

    // Tank water level = water volume / cross-section (in cm)
    s.tank_water_level = (s.tank_water / p.tank_volume) * p.tank_height;

    // Communicating vessels: reservoir level matches dip tube opening
    // when gas doesn't interfere
    // h_reservoir = h_dip_tube - (gas_volume / tank_cross_section) * 100 (cm)
    const gasDisplacement = (s.tank_gas / (p.tank_cross_section * 10000)) * 100; // cm
    const equilibrium = p.dip_tube_opening - gasDisplacement;

    // Reservoir level based on its water volume
    const reservoirArea = 0.05; // m² cross-section (~25cm × 20cm)
    s.reservoir_water_level = p.reservoir_height_range[0] +
      (s.reservoir_water / p.reservoir_capacity) * (p.reservoir_height_range[1] - p.reservoir_height_range[0]);

    // Pump prime check: reservoir must have enough water
    s.pump_primed = s.reservoir_water > 1; // Need at least 1L

    // Overflow check
    s.reservoir_overflow = s.reservoir_water > p.reservoir_capacity;
  }

  /**
   * Advance simulation by dt seconds.
   * @param {number} dt - timestep in seconds
   * @param {string} mode - operating mode
   * @param {boolean} pumpOn - pump running?
   * @param {object} valves - valve states
   */
  step(dt, mode, pumpOn, valves = {}) {
    const s = this.state;
    const p = this.p;
    const flowPerSec = p.pump_flow_rate / 60; // L/s

    if (pumpOn && s.pump_primed) {
      const volumeMoved = flowPerSec * dt;

      switch (mode) {
        case 'solar_charging': {
          // tank bottom → pump → collectors → reservoir (via v_ret) → tank top (via dip tube)
          // Water circulates: draw from tank, push to collectors, return to reservoir
          // In steady state, levels remain stable — water just circulates
          // Net effect: small changes due to temperature expansion (ignored here)

          // Air in collectors gets pushed to reservoir and vents
          if (s.collector_air > 0) {
            const airPushed = Math.min(s.collector_air, volumeMoved * 0.5);
            s.collector_air -= airPushed;
            // Air vents from reservoir top — just disappears
          }
          break;
        }

        case 'greenhouse_heating': {
          // reservoir bottom → pump → radiator → tank bottom
          // Water circulates through a different path
          if (s.system_air > 0) {
            const airPushed = Math.min(s.system_air, volumeMoved * 0.3);
            s.system_air -= airPushed;
          }
          break;
        }

        case 'active_drain':
        case 'overheat_drain': {
          // collector bottom → pump → tank, air enters from collector top (v_air open)
          // Water drains from collectors into tank/reservoir
          if (s.collector_water > 0) {
            const drained = Math.min(s.collector_water, volumeMoved);
            s.collector_water -= drained;
            s.collector_air += drained;
            // Drained water goes to reservoir first, then equilibrates
            s.reservoir_water += drained;

            // Check overflow
            if (s.reservoir_water > p.reservoir_capacity) {
              const overflow = s.reservoir_water - p.reservoir_capacity;
              s.reservoir_water = p.reservoir_capacity;
              s.tank_water = Math.min(s.tank_water + overflow, p.tank_volume);
              s.reservoir_overflow = true;
            }
          }
          break;
        }
      }
    }

    // Communicating vessels equilibration (slow process)
    // Water flows between tank and reservoir through the dip tube pipe
    const targetReservoir = Math.min(
      (s.tank_water / p.tank_volume) * p.reservoir_capacity * 0.3 + p.reservoir_capacity * 0.1,
      p.reservoir_capacity
    );
    const eqRate = 0.05 * dt; // Slow equilibration
    const delta = (targetReservoir - s.reservoir_water) * eqRate;
    if (Math.abs(delta) > 0.001) {
      s.reservoir_water += delta;
      s.tank_water -= delta;
    }

    // Vent air from reservoir (open top)
    // Any air that reaches reservoir escapes
    if (s.system_air > 0) {
      s.system_air *= Math.exp(-0.01 * dt); // Slow air removal
    }

    s.simTime += dt;
    this._updateLevels();

    return this.getState();
  }

  /** Inject air into the system at a given point */
  injectAir(volume, location = 'collector_top') {
    const s = this.state;
    switch (location) {
      case 'collector_top':
        s.collector_air += volume;
        s.collector_water = Math.max(s.collector_water - volume, 0);
        break;
      case 'pipe':
        s.system_air += volume;
        break;
      case 'tank':
        s.tank_gas += volume;
        s.tank_water = Math.max(s.tank_water - volume, 0);
        break;
    }
    this._updateLevels();
  }

  /** Change total water volume (simulate adding/removing water) */
  setTotalWater(volume) {
    const current = this.state.tank_water + this.state.reservoir_water +
                    this.state.collector_water + this.state.pipe_water;
    const diff = volume - current;
    if (diff > 0) {
      this.state.reservoir_water += diff; // Water added via reservoir
    } else {
      this.state.reservoir_water += diff; // Water removed from reservoir first
      if (this.state.reservoir_water < 0) {
        this.state.tank_water += this.state.reservoir_water;
        this.state.reservoir_water = 0;
      }
    }
    this._updateLevels();
  }

  getState() {
    return { ...this.state };
  }

  getWarnings() {
    const w = [];
    if (!this.state.pump_primed) {
      w.push({ level: 'danger', msg: 'Pump has lost prime — reservoir empty!' });
    }
    if (this.state.reservoir_overflow) {
      w.push({ level: 'danger', msg: 'Reservoir overflow!' });
    }
    if (this.state.reservoir_water < 3) {
      w.push({ level: 'warning', msg: `Reservoir low: ${this.state.reservoir_water.toFixed(1)}L` });
    }
    if (this.state.collector_air > this.p.collector_volume * 0.5) {
      w.push({ level: 'warning', msg: `Significant air in collectors: ${this.state.collector_air.toFixed(1)}L` });
    }
    if (this.state.tank_gas > 20) {
      w.push({ level: 'warning', msg: `Large gas pocket in tank: ${this.state.tank_gas.toFixed(1)}L` });
    }
    return w;
  }
}
