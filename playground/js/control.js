/**
 * Control State Machine for the simulator.
 *
 * Wraps the real Shelly control-logic.js (loaded at runtime via
 * control-logic-loader.js) so the simulator runs the exact same
 * decision logic as the deployed hardware.  This class adds:
 *   - state tracking (mode, timers, collectorsDrained)
 *   - human-readable transition log with sensor summaries
 *   - valve/actuator output from MODE_VALVES / MODE_ACTUATORS
 */

import { load } from './control-logic-loader.js';

// Will be populated by init()
let _evaluate, _MODES, _MODE_VALVES, _MODE_ACTUATORS;

/**
 * Load the shared control logic.  Must be called (and awaited) once
 * before constructing a ControlStateMachine.
 */
export async function initControlLogic() {
  const cl = await load();
  _evaluate = cl.evaluate;
  _MODES = cl.MODES;
  _MODE_VALVES = cl.MODE_VALVES;
  _MODE_ACTUATORS = cl.MODE_ACTUATORS;
}

export class ControlStateMachine {
  constructor(modesConfig) {
    this.modes = modesConfig;      // system.yaml modes (for valve display names)
    this.currentMode = 'idle';
    this.modeStartTime = 0;
    this.collectorsDrained = false;
    this.lastRefillAttempt = 0;
    this.emergencyHeatingActive = false;
    // Solar-charging tank-rise tracking (mirrors evaluate() flags).
    // Reset each time we leave SOLAR_CHARGING; carried across ticks
    // while we are in solar charging so the no-rise-for-5-min and
    // tank-dropped-2°C exit conditions can fire.
    this.solarChargePeakTankTop = null;
    this.solarChargePeakTankTopAt = 0;
    this.transitionLog = [];
  }

  /** Format all sensor values as a compact string */
  _sensorSummary(sensors) {
    return `T_coll=${sensors.t_collector.toFixed(1)} T_top=${sensors.t_tank_top.toFixed(1)} T_bot=${sensors.t_tank_bottom.toFixed(1)} T_gh=${sensors.t_greenhouse.toFixed(1)} T_out=${sensors.t_outdoor.toFixed(1)}`;
  }

  /** Map playground sensor names to Shelly state format */
  _buildShellyState(sensors, simTime) {
    return {
      temps: {
        collector:   sensors.t_collector,
        tank_top:    sensors.t_tank_top,
        tank_bottom: sensors.t_tank_bottom,
        greenhouse:  sensors.t_greenhouse,
        outdoor:     sensors.t_outdoor,
      },
      currentMode:      this.currentMode.toUpperCase(),
      modeEnteredAt:    this.modeStartTime,
      now:              simTime,
      collectorsDrained: this.collectorsDrained,
      lastRefillAttempt: this.lastRefillAttempt,
      emergencyHeatingActive: this.emergencyHeatingActive,
      solarChargePeakTankTop: this.solarChargePeakTankTop,
      solarChargePeakTankTopAt: this.solarChargePeakTankTopAt,
      sensorAge: { collector: 0, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 },
    };
  }

  /**
   * Evaluate state machine and return current mode + actuator commands.
   * @param {object} sensors - { t_collector, t_tank_top, t_tank_bottom, t_greenhouse, t_outdoor }
   * @param {number} simTime - current simulation time in seconds
   * @returns {{ mode: string, actuators: object, valves: object, transition: string|null }}
   */
  evaluate(sensors, simTime) {
    const prevMode = this.currentMode;
    const sensorStr = this._sensorSummary(sensors);
    const shellyState = this._buildShellyState(sensors, simTime);
    // Snapshot peak before evaluate() resets it so the transition log
    // can describe the session that just ended.
    const prevPeak = this.solarChargePeakTankTop;

    // Delegate decision to the real Shelly control logic
    const result = _evaluate(shellyState, null);
    const nextMode = result.nextMode.toLowerCase();

    // Update internal state
    this.collectorsDrained = result.flags.collectorsDrained;
    this.lastRefillAttempt = result.flags.lastRefillAttempt;
    this.emergencyHeatingActive = result.flags.emergencyHeatingActive;
    this.solarChargePeakTankTop = result.flags.solarChargePeakTankTop;
    this.solarChargePeakTankTopAt = result.flags.solarChargePeakTankTopAt;

    // Build transition log entry
    let transition = null;
    if (nextMode !== prevMode) {
      transition = this._describeTransition(prevMode, nextMode, sensors, sensorStr, prevPeak);
      this.currentMode = nextMode;
      this.modeStartTime = simTime;
      this.transitionLog.push({ time: simTime, transition });
    }

    // Use actuators/valves from evaluate result (includes emergency overlay)
    return {
      mode: nextMode,
      actuators: {
        pump:         !!result.actuators.pump,
        fan:          !!result.actuators.fan,
        space_heater: !!result.actuators.space_heater,
      },
      valves: result.valves,
      transition,
    };
  }

  /** Human-readable transition description for the log panel */
  _describeTransition(from, to, sensors, sensorStr, prevSolarPeak) {
    const s = sensors;
    const delta = (s.t_collector - s.t_tank_bottom).toFixed(1);

    if (to === 'solar_charging') {
      return `${from} → solar_charging | delta=${delta}°C > 10°C threshold | ${sensorStr}`;
    }
    if (to === 'greenhouse_heating') {
      return `${from} → greenhouse_heating | T_gh=${s.t_greenhouse.toFixed(1)}°C < 10°C, T_top=${s.t_tank_top.toFixed(1)}°C > T_gh+5°C | ${sensorStr}`;
    }
    if (to === 'emergency_heating') {
      return `${from} → emergency_heating | T_gh=${s.t_greenhouse.toFixed(1)}°C < 9°C, T_top=${s.t_tank_top.toFixed(1)}°C < T_gh+5°C (no useful tank) | ${sensorStr}`;
    }
    if (to === 'active_drain') {
      if (s.t_collector > 95) {
        return `${from} → active_drain | T_coll=${s.t_collector.toFixed(1)}°C > 95°C (overheat) | ${sensorStr}`;
      }
      return `${from} → active_drain | T_out=${s.t_outdoor.toFixed(1)}°C < 2°C (freeze) | ${sensorStr}`;
    }
    if (from === 'active_drain' && to === 'idle') {
      return `active_drain → idle | drain complete | ${sensorStr}`;
    }
    if (from === 'greenhouse_heating' && to === 'idle') {
      if (s.t_tank_top < s.t_greenhouse + 2) {
        return `greenhouse_heating → idle | T_top=${s.t_tank_top.toFixed(1)}°C < T_gh+2°C (would cool) | ${sensorStr}`;
      }
      return `greenhouse_heating → idle | T_gh=${s.t_greenhouse.toFixed(1)}°C > 12°C | ${sensorStr}`;
    }
    if (from === 'solar_charging' && to === 'idle') {
      const peak = (typeof prevSolarPeak === 'number') ? prevSolarPeak : null;
      if (peak !== null) {
        const drop = (peak - s.t_tank_top).toFixed(1);
        return `solar_charging → idle | tank stopped rising (peak T_top=${peak.toFixed(1)}°C, now ${s.t_tank_top.toFixed(1)}°C, drop ${drop}°C) | ${sensorStr}`;
      }
      return `solar_charging → idle | tank stopped rising | ${sensorStr}`;
    }
    if (from === 'emergency_heating' && to === 'idle') {
      return `emergency_heating → idle | T_gh=${s.t_greenhouse.toFixed(1)}°C > 12°C | ${sensorStr}`;
    }
    return `${from} → ${to} | ${sensorStr}`;
  }

  reset() {
    this.currentMode = 'idle';
    this.modeStartTime = 0;
    this.collectorsDrained = false;
    this.lastRefillAttempt = 0;
    this.emergencyHeatingActive = false;
    this.solarChargePeakTankTop = null;
    this.solarChargePeakTankTopAt = 0;
    this.transitionLog = [];
  }
}
