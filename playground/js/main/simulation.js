// Sim-only drivers: FAB play/pause button, the simLoop
// requestAnimationFrame tick, and the sim-time-of-day formatters
// used by logs and the day/night readout. Extracted from main.js.

import { SIM_START_HOUR, getDayNightEnv } from '../sim-bootstrap.js';
import {
  running, setRunning, model, controller, params, simSpeed,
  timeSeriesStore, trendStore, transitionLog,
} from './state.js';
import { updateDisplay } from './display-update.js';
import { updateSidebarSubtitle } from './connection.js';
import { resetModeEvents, appendModeEvent } from './mode-events.js';

const DT = 1;
let lastFrame = 0;
let simTimeAccum = 0;

export function setupFAB() {
  document.getElementById('fab-play').addEventListener('click', togglePlay);
}

export function togglePlay() {
  setRunning(!running);
  updateFABIcon();
  if (running) {
    lastFrame = 0;
    simTimeAccum = 0;
    if (model.state.simTime === 0) {
      model.reset({
        t_tank_top: params.t_tank_top,
        t_tank_bottom: params.t_tank_bottom,
        t_greenhouse: params.t_greenhouse,
        t_outdoor: params.t_outdoor,
        irradiance: params.irradiance,
      });
      controller.reset();
      timeSeriesStore.reset();
      trendStore.reset();
      transitionLog.length = 0;
      resetModeEvents();
    }
    document.getElementById('sim-status-text').textContent = 'Running — press pause to stop';
    updateSidebarSubtitle();
    requestAnimationFrame(simLoop);
  } else {
    document.getElementById('sim-status-text').textContent = 'Paused — press play to resume';
    updateSidebarSubtitle();
  }
}

export function updateFABIcon() {
  const fab = document.getElementById('fab-play');
  fab.querySelector('.material-symbols-outlined').textContent = running ? 'pause' : 'play_arrow';
  fab.title = running ? 'Pause simulation' : 'Start simulation';
}

// SIM_START_HOUR + getDayNightEnv live in sim-bootstrap.js so the
// pre-baked snapshot generator and simLoop share one source of truth.

// formatTimeOfDay moved to ./time-format.js so logs.js can reach
// it without forming a simulation ↔ logs cycle.

function getTimeOfDay(simTime) {
  const h = SIM_START_HOUR + simTime / 3600;
  return `${Math.floor(h % 24).toString().padStart(2, '0')}:${Math.floor((h * 60) % 60).toString().padStart(2, '0')}`;
}

// Exposed so main.js's resetSim and the bootstrap-snapshot loader
// can reset the accumulator alongside the model + controller reset.
export function resetSimulationTime() {
  lastFrame = 0;
  simTimeAccum = 0;
}

function simLoop(timestamp) {
  if (!running) return;
  if (!lastFrame) lastFrame = timestamp;
  const realDt = (timestamp - lastFrame) / 1000;
  lastFrame = timestamp;

  simTimeAccum += realDt * simSpeed;
  const steps = Math.min(Math.floor(simTimeAccum / DT), 50);
  simTimeAccum -= steps * DT;

  let result;
  for (let i = 0; i < steps; i++) {
    let env;
    if (params.day_night_cycle) {
      env = getDayNightEnv(model.state.simTime, params.t_outdoor, params.irradiance);
    } else {
      env = { t_outdoor: params.t_outdoor, irradiance: params.irradiance };
    }

    const sensors = {
      t_collector: model.state.t_collector,
      t_tank_top: model.state.t_tank_top,
      t_tank_bottom: model.state.t_tank_bottom,
      t_greenhouse: model.state.t_greenhouse,
      t_outdoor: model.state.t_outdoor,
    };

    const prevSimMode = controller.currentMode;
    const prevSimFanCool = !!controller.greenhouseFanCoolingActive;
    result = controller.evaluate(sensors, model.state.simTime);

    // Fan-cool overlay flip: separate from a mode change because the
    // overlay can fire while staying in the same pump mode.
    const curSimFanCool = !!controller.greenhouseFanCoolingActive;
    if (curSimFanCool !== prevSimFanCool) {
      transitionLog.unshift({
        kind: 'sim',
        eventType: 'overlay',
        time: model.state.simTime,
        overlayId: 'greenhouse_fan_cooling',
        from: prevSimFanCool ? 'on' : 'off',
        to: curSimFanCool ? 'on' : 'off',
      });
    }

    if (result.transition) {
      transitionLog.unshift({ kind: 'sim', time: model.state.simTime, text: result.transition, mode: result.mode });
      appendModeEvent({
        ts: model.state.simTime,
        type: 'mode',
        from: prevSimMode,
        to: result.mode,
      });
      // Prune sim entries older than 24h of simulated time
      const SIM_LOG_HORIZON = 86400; // 24h in seconds
      while (transitionLog.length > 0) {
        const oldest = transitionLog[transitionLog.length - 1];
        if (oldest.kind === 'sim' && (model.state.simTime - oldest.time) > SIM_LOG_HORIZON) {
          transitionLog.pop();
        } else {
          break;
        }
      }
    }

    model.step(DT, env, result.actuators, result.mode);

    // Record every ~5 seconds of sim time
    if (Math.floor(model.state.simTime) % 5 === 0) {
      const vals = {
        t_tank_top: model.state.t_tank_top,
        t_tank_bottom: model.state.t_tank_bottom,
        t_collector: model.state.t_collector,
        t_greenhouse: model.state.t_greenhouse,
        t_outdoor: model.state.t_outdoor,
      };
      timeSeriesStore.addPoint(model.state.simTime, vals);
      trendStore.addPoint(model.state.simTime, vals);
    }
  }

  // Update day/night display
  if (params.day_night_cycle) {
    const tod = getTimeOfDay(model.state.simTime);
    const el = document.getElementById('sim-time-of-day');
    if (el) el.textContent = tod;
  }

  if (result) updateDisplay(model.getState(), result);
  requestAnimationFrame(simLoop);
}
