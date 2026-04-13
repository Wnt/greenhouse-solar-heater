/**
 * Pre-roll the thermal simulation forward by N seconds so the graph
 * and System Logs are populated immediately on first paint.
 *
 * Used on deploys without live data (e.g. GitHub Pages) so the UI is
 * not empty when the user opens the page.
 *
 * Pure function: takes a model, a controller, params, and a duration,
 * advances the model in place, and returns the recorded points and log
 * entries — which the caller is responsible for pushing into the
 * UI-side stores. This separation keeps the function unit-testable
 * without a DOM and reusable from a Node generator script.
 *
 * Single source of truth for `SIM_START_HOUR` and `getDayNightEnv`:
 * both `playground/js/main.js` (for simLoop after auto-start) and
 * `scripts/generate-bootstrap-history.mjs` (for baking the snapshot)
 * import them here, so a change to the day/night curve cannot drift
 * between the live sim and the pre-baked history.
 */

// Sim time t=0 maps to this hour-of-day on the simulated clock.
export const SIM_START_HOUR = 8;

/**
 * Smooth day/night cycle for the standalone simulation. Mirrors the
 * curve simLoop uses so the resumed runtime continues seamlessly from
 * the pre-baked bootstrap snapshot.
 */
export function getDayNightEnv(simTime, baseOutdoor, peakIrradiance) {
  const hour = (SIM_START_HOUR + simTime / 3600) % 24;
  let irradiance = 0;
  if (hour >= 6 && hour <= 20) {
    irradiance = peakIrradiance * Math.sin((hour - 6) / 14 * Math.PI);
  }
  const t_outdoor = baseOutdoor + 5 * Math.cos((hour - 15) / 24 * 2 * Math.PI);
  return { t_outdoor, irradiance };
}

/**
 * @param {object} opts
 * @param {object} opts.model       — ThermalModel instance (mutated)
 * @param {object} opts.controller  — ControlStateMachine-like; must expose
 *                                    `evaluate(sensors, simTime)` returning
 *                                    `{ mode, actuators, transition }`
 * @param {object} opts.params      — { day_night_cycle, t_outdoor, irradiance }
 * @param {number} opts.durationSeconds — how far to fast-forward
 * @param {number} [opts.dt=1]      — integration timestep in seconds
 * @param {(simTime: number) => {t_outdoor: number, irradiance: number}} opts.getEnv
 *                                    — environment provider (day/night cycle, etc.)
 * @returns {{ points: Array, logEntries: Array }}
 */
export function bootstrapSimulation(opts) {
  const { model, controller, durationSeconds, getEnv } = opts;
  const dt = opts.dt || 1;

  const points = [];
  const logEntries = [];

  const totalSteps = Math.floor(durationSeconds / dt);
  for (let i = 0; i < totalSteps; i++) {
    const env = getEnv(model.state.simTime);

    const sensors = {
      t_collector: model.state.t_collector,
      t_tank_top: model.state.t_tank_top,
      t_tank_bottom: model.state.t_tank_bottom,
      t_greenhouse: model.state.t_greenhouse,
      t_outdoor: model.state.t_outdoor,
    };

    const result = controller.evaluate(sensors, model.state.simTime);

    if (result.transition) {
      logEntries.push({
        kind: 'sim',
        time: model.state.simTime,
        text: result.transition,
        mode: result.mode,
      });
    }

    model.step(dt, env, result.actuators, result.mode);

    // Record every ~5 seconds of sim time — matches simLoop's cadence.
    if (Math.floor(model.state.simTime) % 5 === 0) {
      points.push({
        time: model.state.simTime,
        values: {
          t_tank_top: model.state.t_tank_top,
          t_tank_bottom: model.state.t_tank_bottom,
          t_collector: model.state.t_collector,
          t_greenhouse: model.state.t_greenhouse,
          t_outdoor: model.state.t_outdoor,
        },
        mode: result.mode,
      });
    }
  }

  return { points, logEntries };
}
