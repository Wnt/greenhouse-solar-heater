/**
 * Pre-bake a deterministic 12-hour thermal-simulation snapshot for the
 * playground GitHub Pages deploy.
 *
 * Why it exists:
 *   The playground used to fast-forward 12 h of simulation in the
 *   browser on every page load. That made the pre-rolled history
 *   silently dependent on the *runtime* control-logic — nothing forced
 *   the developer to notice that a temperature-threshold tweak in
 *   shelly/control-logic.js had changed the dashboard's first-paint
 *   appearance. By baking the snapshot at build time and adding a
 *   drift test (see tests/bootstrap-history-drift.test.js), any change
 *   to the control logic or thermal model that affects the bootstrap
 *   forces a regeneration that has to be reviewed and committed
 *   alongside the logic change.
 *
 * What it does:
 *   1. Loads the real Shelly control logic from shelly/control-logic.js
 *      (CommonJS-style via Function-constructor, same trick as
 *      tests/playground-control.test.js).
 *   2. Loads the playground ControlStateMachine wrapper from
 *      playground/js/control.js with its async loader stubbed out, so
 *      the generated transition log text matches what the browser
 *      would produce.
 *   3. Runs `bootstrapSimulation()` for 12 h of sim time with the
 *      default scenario params (matching playground/js/main.js).
 *   4. Writes the result to playground/assets/bootstrap-history.json,
 *      which the playground fetches at runtime in pages-mode deploys.
 *
 * Used as a CLI:    `npm run bootstrap-history`
 * Imported as a fn: `import { generate } from '.../generate-bootstrap-history.mjs'`
 *                   — see tests/bootstrap-history-drift.test.js
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ThermalModel } from '../playground/js/physics.js';
import {
  bootstrapSimulation,
  getDayNightEnv,
} from '../playground/js/sim-bootstrap.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// ── Default simulation parameters ──────────────────────────────────
// Must match the `params` object in playground/js/main.js so the
// snapshot is generated under the same scenario that simLoop will
// continue from after auto-start.
export const DEFAULT_PARAMS = {
  t_outdoor: 10,
  irradiance: 500,
  t_tank_top: 12,
  t_tank_bottom: 9,
  t_greenhouse: 11,
  day_night_cycle: true,
  gh_thermal_mass: 250000,
  gh_heat_loss: 100,
};

// 12 h of sim time, recorded at 1 sample per minute. The runtime
// simLoop continues sampling at 5 s after auto-start, so the dashboard
// shows a coarser past + finer present — both feed the same store and
// the canvas renders them as a single sliding-window curve.
export const DURATION_SECONDS = 12 * 3600;
export const SAMPLE_INTERVAL_SECONDS = 60;
export const DT = 1;

// ── Load shelly/control-logic.js (CommonJS via Function shim) ──────
function loadShellyControlLogic() {
  const src = readFileSync(join(repoRoot, 'shelly', 'control-logic.js'), 'utf8');
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', src)(mod);
  return mod.exports;
}

// ── Load playground ControlStateMachine without its async loader ───
// playground/js/control.js exports `class ControlStateMachine` and an
// `initControlLogic()` async loader that fetches the Shelly script via
// HTTP. We don't have HTTP in Node, so we pre-populate the module's
// internal `_evaluate / _MODES / _MODE_VALVES / _MODE_ACTUATORS` vars
// directly with the values we already loaded from the Shelly source.
function loadControlStateMachineClass(shelly) {
  const src = readFileSync(join(repoRoot, 'playground', 'js', 'control.js'), 'utf8');

  // Strip ESM imports/exports and pre-bind the closure variables.
  const modified = src
    .replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?/g, '')
    .replace('export async function initControlLogic', 'async function initControlLogic')
    .replace('export class', 'class')
    .replace(
      'let _evaluate, _MODES, _MODE_VALVES, _MODE_ACTUATORS;',
      'var _evaluate = __evaluate, _MODES = __MODES, _MODE_VALVES = __MODE_VALVES, _MODE_ACTUATORS = __MODE_ACTUATORS;'
    );

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    '__evaluate', '__MODES', '__MODE_VALVES', '__MODE_ACTUATORS',
    modified + '\nreturn ControlStateMachine;'
  );

  return factory(
    shelly.evaluate,
    shelly.MODES,
    shelly.MODE_VALVES,
    shelly.MODE_ACTUATORS
  );
}

// ── Generator: pure, deterministic, no Date.now / no Math.random ───
export function generate() {
  const shelly = loadShellyControlLogic();
  const ControlStateMachine = loadControlStateMachineClass(shelly);

  const model = new ThermalModel({
    greenhouse_thermal_mass: DEFAULT_PARAMS.gh_thermal_mass,
    greenhouse_UA: DEFAULT_PARAMS.gh_heat_loss,
  });
  model.reset({
    t_tank_top: DEFAULT_PARAMS.t_tank_top,
    t_tank_bottom: DEFAULT_PARAMS.t_tank_bottom,
    t_greenhouse: DEFAULT_PARAMS.t_greenhouse,
    t_outdoor: DEFAULT_PARAMS.t_outdoor,
    irradiance: DEFAULT_PARAMS.irradiance,
  });

  // Minimal modes config — ControlStateMachine only reads it for the
  // valve display labels in the constructor (which we don't emit), so
  // an empty object is fine.
  const controller = new ControlStateMachine({});

  const result = bootstrapSimulation({
    model,
    controller,
    durationSeconds: DURATION_SECONDS,
    dt: DT,
    getEnv: (t) => getDayNightEnv(t, DEFAULT_PARAMS.t_outdoor, DEFAULT_PARAMS.irradiance),
  });

  // Downsample points to SAMPLE_INTERVAL_SECONDS to keep the committed
  // file small (~50 KB instead of ~700 KB at the 5-s native cadence).
  const sampledPoints = result.points.filter(
    (p) => p.time % SAMPLE_INTERVAL_SECONDS === 0
  );

  // Round floats to 4 decimal places for stable diffs across V8
  // versions. The thermal model is deterministic, but JSON.stringify
  // emits long-tail digits that look noisy in code review and risk
  // engine-version drift. 0.0001 °C is far below sensor resolution.
  const round = (x) => Math.round(x * 1e4) / 1e4;
  const points = sampledPoints.map((p) => ({
    time: p.time,
    values: {
      t_tank_top: round(p.values.t_tank_top),
      t_tank_bottom: round(p.values.t_tank_bottom),
      t_collector: round(p.values.t_collector),
      t_greenhouse: round(p.values.t_greenhouse),
      t_outdoor: round(p.values.t_outdoor),
    },
    mode: p.mode,
  }));

  const finalModelState = {
    t_tank_top: round(model.state.t_tank_top),
    t_tank_bottom: round(model.state.t_tank_bottom),
    t_collector: round(model.state.t_collector),
    t_greenhouse: round(model.state.t_greenhouse),
    t_outdoor: round(model.state.t_outdoor),
    irradiance: round(model.state.irradiance),
    simTime: model.state.simTime,
  };

  const finalControllerState = {
    currentMode: controller.currentMode,
    modeStartTime: controller.modeStartTime,
    collectorsDrained: !!controller.collectorsDrained,
    lastRefillAttempt: controller.lastRefillAttempt,
    emergencyHeatingActive: !!controller.emergencyHeatingActive,
    solarChargePeakTankTop: controller.solarChargePeakTankTop,
    solarChargePeakTankTopAt: controller.solarChargePeakTankTopAt,
  };

  return {
    meta: {
      version: 1,
      // No real wall-clock timestamp here — the file must be byte-stable
      // so the drift test can use plain string comparison.
      duration_seconds: DURATION_SECONDS,
      sample_interval_seconds: SAMPLE_INTERVAL_SECONDS,
      dt: DT,
      default_params: DEFAULT_PARAMS,
    },
    points,
    log_entries: result.logEntries,
    final_model_state: finalModelState,
    final_controller_state: finalControllerState,
  };
}

// Stable serialization the drift test can byte-compare against.
export function serialize(data) {
  return JSON.stringify(data, null, 2) + '\n';
}

// Default output location relative to repo root. The playground fetches
// this file at runtime via `./assets/bootstrap-history.json`.
export const OUTPUT_PATH = join(
  repoRoot,
  'playground',
  'assets',
  'bootstrap-history.json'
);

// CLI entry point — only runs when invoked directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  const data = generate();
  const text = serialize(data);
  writeFileSync(OUTPUT_PATH, text);
  console.log(
    `Wrote ${OUTPUT_PATH}: ${data.points.length} points, ` +
      `${data.log_entries.length} transitions, simTime=${data.final_model_state.simTime}s`
  );
}
