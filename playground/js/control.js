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
  /** Format all sensor values as a compact string */
  _sensorSummary(sensors) {
    return `T_coll=${sensors.t_collector.toFixed(1)} T_top=${sensors.t_tank_top.toFixed(1)} T_bot=${sensors.t_tank_bottom.toFixed(1)} T_gh=${sensors.t_greenhouse.toFixed(1)} T_out=${sensors.t_outdoor.toFixed(1)}`;
  }

  evaluate(sensors, simTime) {
    let transition = null;
    const prevMode = this.currentMode;
    const MIN_RUN = 120; // 2 minutes minimum run time
    const runDuration = simTime - this.modeStartTime;
    const pastMinRun = runDuration > MIN_RUN;
    const sensorStr = this._sensorSummary(sensors);
    const delta = sensors.t_collector - sensors.t_tank_bottom;

    // ── Exit checks (mode-specific, all respect minimum run time) ──

    // Active drain completion (3 min drain cycle)
    if (this.currentMode === 'active_drain' && runDuration > 180) {
      this.collectorsDrained = true;
      this.currentMode = 'idle';
      transition = `active_drain → idle | drain complete after ${Math.round(runDuration)}s | ${sensorStr}`;
    }

    // Overheat drain completion
    if (this.currentMode === 'overheat_drain' && runDuration > 180) {
      this.collectorsDrained = true;
      this.currentMode = 'idle';
      transition = `overheat_drain → idle | drain complete after ${Math.round(runDuration)}s | ${sensorStr}`;
    }

    // Greenhouse heating exit (greenhouse warm enough, or tank too cold to be useful)
    if (this.currentMode === 'greenhouse_heating' && pastMinRun &&
        (sensors.t_greenhouse > 12 || sensors.t_tank_top < 25)) {
      this.currentMode = 'idle';
      transition = sensors.t_tank_top < 25
        ? `greenhouse_heating → idle | T_top=${sensors.t_tank_top.toFixed(1)}°C < 25°C min tank | ${sensorStr}`
        : `greenhouse_heating → idle | T_gh=${sensors.t_greenhouse.toFixed(1)}°C > 12°C | ${sensorStr}`;
    }

    // Solar charging exit: collector delta dropped below +3°C
    if (this.currentMode === 'solar_charging' && pastMinRun && delta < 3) {
      this.currentMode = 'idle';
      transition = `solar_charging → idle | delta=${delta.toFixed(1)}°C < 3°C threshold | ${sensorStr}`;
    }

    // Emergency exit
    if (this.currentMode === 'emergency_heating' && pastMinRun && sensors.t_greenhouse > 12) {
      this.currentMode = 'idle';
      transition = `emergency_heating → idle | T_gh=${sensors.t_greenhouse.toFixed(1)}°C > 12°C | ${sensorStr}`;
    }

    // ── Priority-ordered mode entry (from idle, solar_charging, or greenhouse_heating for safety) ──
    if (this.currentMode === 'idle' || this.currentMode === 'solar_charging' || this.currentMode === 'greenhouse_heating') {
      // Emergency heating — highest priority (tank can't meaningfully heat greenhouse)
      if (sensors.t_greenhouse < 9 &&
          (sensors.t_tank_top <= sensors.t_greenhouse + 5 || sensors.t_tank_top < 25)) {
        if (this.currentMode !== 'emergency_heating') {
          this.currentMode = 'emergency_heating';
          transition = `${prevMode} → emergency_heating | T_gh=${sensors.t_greenhouse.toFixed(1)}°C < 9°C, T_top=${sensors.t_tank_top.toFixed(1)}°C ${sensors.t_tank_top < 25 ? '< 25°C min tank' : '≤ T_gh+5°C'} | ${sensorStr}`;
        }
      }
      // Active drain — freeze protection
      else if (sensors.t_outdoor < 2 && !this.collectorsDrained) {
        if (this.currentMode !== 'active_drain') {
          this.currentMode = 'active_drain';
          transition = `${prevMode} → active_drain | T_out=${sensors.t_outdoor.toFixed(1)}°C < 2°C | ${sensorStr}`;
        }
      }
      // Overheat drain
      else if (sensors.t_tank_top > 85 && this.currentMode === 'solar_charging') {
        this.currentMode = 'overheat_drain';
        transition = `solar_charging → overheat_drain | T_top=${sensors.t_tank_top.toFixed(1)}°C > 85°C | ${sensorStr}`;
      }
      // Greenhouse heating (tank must be meaningfully warmer than greenhouse and above minimum)
      else if (this.currentMode === 'idle' && sensors.t_greenhouse < 10 &&
               sensors.t_tank_top > sensors.t_greenhouse + 5 && sensors.t_tank_top >= 25) {
        this.currentMode = 'greenhouse_heating';
        transition = `idle → greenhouse_heating | T_gh=${sensors.t_greenhouse.toFixed(1)}°C < 10°C, T_top=${sensors.t_tank_top.toFixed(1)}°C > T_gh+5°C | ${sensorStr}`;
      }
      // Solar charging
      else if (this.currentMode === 'idle' && delta > 7) {
        this.currentMode = 'solar_charging';
        transition = `idle → solar_charging | delta=${delta.toFixed(1)}°C > 7°C threshold | ${sensorStr}`;
      }
    }

    // Refill check: if drained and outdoor warms up
    if (this.collectorsDrained && sensors.t_outdoor > 5 && this.currentMode === 'idle') {
      this.collectorsDrained = false;
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
