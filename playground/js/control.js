/**
 * Control State Machine for the simulator.
 * Evaluates mode triggers/exits from system.yaml and manages transitions.
 */

import { parseTrigger, evaluateTrigger } from './yaml-loader.js';

export class ControlStateMachine {
  constructor(modesConfig) {
    this.modes = modesConfig;
    this.currentMode = 'idle';
    this.modeStartTime = 0;
    this.collectorsDrained = false;
    this.transitionLog = [];

    // Parse triggers
    this.parsedTriggers = {};
    for (const [name, mode] of Object.entries(modesConfig)) {
      this.parsedTriggers[name] = {
        trigger: parseTrigger(mode.trigger),
        exit: parseTrigger(mode.exit),
      };
    }
  }

  /**
   * Evaluate state machine and return current mode + actuator commands.
   * @param {object} sensors - { t_collector, t_tank_top, t_tank_bottom, t_greenhouse, t_outdoor }
   * @param {number} simTime - current simulation time in seconds
   * @returns {{ mode: string, actuators: object, valves: object, transition: string|null }}
   */
  evaluate(sensors, simTime) {
    let transition = null;
    const prevMode = this.currentMode;

    // Check exit condition for current mode
    if (this.currentMode !== 'idle') {
      const exitCond = this.parsedTriggers[this.currentMode]?.exit;
      if (exitCond && evaluateTrigger(exitCond, sensors)) {
        this.currentMode = 'idle';
        transition = `${prevMode} → idle (exit condition met)`;
      }
    }

    // Minimum run time check
    const modeConf = this.modes[this.currentMode];
    const minRun = 120; // 2 minutes minimum run time
    const runDuration = simTime - this.modeStartTime;

    // Priority-ordered mode evaluation (only from idle)
    if (this.currentMode === 'idle' || this.currentMode === 'solar_charging') {
      // Emergency heating — highest priority
      if (sensors.t_greenhouse < 5 && sensors.t_tank_top < 25) {
        if (this.currentMode !== 'emergency_heating') {
          this.currentMode = 'emergency_heating';
          transition = `${prevMode} → emergency_heating (T_gh=${sensors.t_greenhouse.toFixed(1)}°C, T_tank_top=${sensors.t_tank_top.toFixed(1)}°C)`;
        }
      }
      // Active drain — freeze protection
      else if (sensors.t_outdoor < 2 && !this.collectorsDrained) {
        if (this.currentMode !== 'active_drain') {
          this.currentMode = 'active_drain';
          transition = `${prevMode} → active_drain (T_outdoor=${sensors.t_outdoor.toFixed(1)}°C)`;
        }
      }
      // Overheat drain
      else if (sensors.t_tank_top > 85 && this.currentMode === 'solar_charging') {
        this.currentMode = 'overheat_drain';
        transition = `solar_charging → overheat_drain (T_tank_top=${sensors.t_tank_top.toFixed(1)}°C)`;
      }
      // Greenhouse heating
      else if (this.currentMode === 'idle' && sensors.t_greenhouse < 10 && sensors.t_tank_top > 25) {
        this.currentMode = 'greenhouse_heating';
        transition = `idle → greenhouse_heating (T_gh=${sensors.t_greenhouse.toFixed(1)}°C)`;
      }
      // Solar charging
      else if (this.currentMode === 'idle' && sensors.t_collector > sensors.t_tank_bottom + 7) {
        this.currentMode = 'solar_charging';
        transition = `idle → solar_charging (T_coll=${sensors.t_collector.toFixed(1)}°C > T_bot+7=${(sensors.t_tank_bottom + 7).toFixed(1)}°C)`;
      }
    }

    // Active drain completion (simulate 3 min drain)
    if (this.currentMode === 'active_drain' && runDuration > 180) {
      this.collectorsDrained = true;
      this.currentMode = 'idle';
      transition = `active_drain → idle (drain complete)`;
    }

    // Overheat drain completion
    if (this.currentMode === 'overheat_drain' && runDuration > 180) {
      this.collectorsDrained = true;
      this.currentMode = 'idle';
      transition = `overheat_drain → idle (drain complete)`;
    }

    // Greenhouse heating exit
    if (this.currentMode === 'greenhouse_heating' && sensors.t_greenhouse > 12) {
      this.currentMode = 'idle';
      transition = `greenhouse_heating → idle (T_gh=${sensors.t_greenhouse.toFixed(1)}°C > 12°C)`;
    }

    // Solar charging exit
    if (this.currentMode === 'solar_charging' && runDuration > minRun && sensors.t_collector < sensors.t_tank_bottom + 3) {
      this.currentMode = 'idle';
      transition = `solar_charging → idle (insufficient gain)`;
    }

    // Emergency exit
    if (this.currentMode === 'emergency_heating' && sensors.t_greenhouse > 8) {
      this.currentMode = 'idle';
      transition = `emergency_heating → idle (T_gh=${sensors.t_greenhouse.toFixed(1)}°C > 8°C)`;
    }

    // Refill check: if drained and outdoor warms up
    if (this.collectorsDrained && sensors.t_outdoor > 5 && this.currentMode === 'idle') {
      this.collectorsDrained = false; // Allow solar charging again
    }

    if (transition) {
      this.modeStartTime = simTime;
      this.transitionLog.push({ time: simTime, transition });
    }

    // Get valve states and actuators for current mode
    const modeData = this.modes[this.currentMode] || this.modes.idle;
    const valves = modeData.valve_states || {};
    const actuators = {
      pump: (modeData.actuators?.pump || 'OFF') === 'ON',
      fan: (modeData.actuators?.fan || 'OFF') === 'ON',
      space_heater: false,
    };

    // Special: emergency heating uses space heater
    if (this.currentMode === 'emergency_heating') {
      actuators.space_heater = true;
    }

    return {
      mode: this.currentMode,
      actuators,
      valves,
      transition,
    };
  }

  reset() {
    this.currentMode = 'idle';
    this.modeStartTime = 0;
    this.collectorsDrained = false;
    this.transitionLog = [];
  }
}
