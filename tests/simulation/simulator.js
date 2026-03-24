// Virtual-time simulation harness
// Runs thermal model + control logic together in virtual time

const { tick, createModel } = require('./thermal-model.js');
const { evaluate, MODES } = require('../../shelly/control-logic.js');

const CONTROL_INTERVAL = 30;  // seconds between evaluate() calls
const SIM_STEP = 10;  // seconds per simulation tick (must evenly divide CONTROL_INTERVAL)

function simulate(scenario, config) {
  const initTemps = scenario.initialState || {};
  let model = createModel(Object.assign({
    outdoor: scenario.ambient(0),
    irradiance: scenario.irradiance(0),
  }, initTemps));

  const trace = [];

  // Control state
  let currentMode = initTemps.mode || MODES.IDLE;
  let modeEnteredAt = 0;
  let collectorsDrained = initTemps.collectorsDrained || false;
  let lastRefillAttempt = initTemps.lastRefillAttempt || 0;
  let drainDryTicks = 0;

  // Initial evaluate
  let decisions = runEvaluate(0);

  for (let t = 0; t < scenario.duration; t += SIM_STEP) {
    // Update environment
    model.outdoor = scenario.ambient(t);
    model.irradiance = scenario.irradiance(t);

    // Tick thermal model
    model = tick(model, SIM_STEP, decisions);

    // Drain completion: simulate shell's dry-run detection
    if (currentMode === MODES.ACTIVE_DRAIN) {
      if (model.collectorWaterVolume <= 0) {
        drainDryTicks++;
        if (drainDryTicks >= 3) {
          collectorsDrained = true;
          currentMode = MODES.IDLE;
          modeEnteredAt = t;
          decisions = runEvaluate(t);
          drainDryTicks = 0;
        }
      } else {
        drainDryTicks = 0;
      }
    }

    // Control loop every CONTROL_INTERVAL seconds (skip if drain completion already evaluated)
    let evaluatedThisTick = false;
    if (currentMode === MODES.IDLE && trace.length > 0 && trace[trace.length - 1].mode === MODES.ACTIVE_DRAIN) {
      evaluatedThisTick = true;  // drain completion already ran evaluate
    }
    if (t > 0 && t % CONTROL_INTERVAL === 0 && !evaluatedThisTick) {
      decisions = runEvaluate(t);
    }

    // Pump power: depends on flow path, not just collector volume
    const solarOrDrain = decisions.valves.vi_coll || decisions.valves.vo_coll;
    const pumpPower = decisions.actuators.pump
      ? (solarOrDrain ? (model.collectorWaterVolume > 0.1 ? 50 : 10) : 50)
      : 0;

    // Event detection
    const prevMode = trace.length > 0 ? trace[trace.length - 1].mode : null;
    const event = currentMode !== prevMode
      ? 'MODE_TRANSITION: ' + (prevMode || 'INIT') + ' \u2192 ' + currentMode
      : null;

    trace.push({
      t,
      temps: {
        collector: round2(model.collector),
        tank_top: round2(model.tank_top),
        tank_bottom: round2(model.tank_bottom),
        greenhouse: round2(model.greenhouse),
        outdoor: round2(model.outdoor),
      },
      irradiance: round2(model.irradiance),
      mode: currentMode,
      valves: Object.assign({}, decisions.valves),
      pump: decisions.actuators.pump,
      pump_power: pumpPower,
      event,
    });
  }

  return trace;

  function runEvaluate(t) {
    const sensorAge = scenario.sensorAge
      ? scenario.sensorAge(t)
      : { collector: 0, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 };

    const evalState = {
      temps: {
        collector: model.collector,
        tank_top: model.tank_top,
        tank_bottom: model.tank_bottom,
        greenhouse: model.greenhouse,
        outdoor: model.outdoor,
      },
      currentMode,
      modeEnteredAt,
      now: t,
      collectorsDrained,
      lastRefillAttempt,
      sensorAge,
    };

    const result = evaluate(evalState, config);

    if (result.nextMode !== currentMode) {
      currentMode = result.nextMode;
      modeEnteredAt = t;
      drainDryTicks = 0;
    }
    collectorsDrained = result.flags.collectorsDrained;
    lastRefillAttempt = result.flags.lastRefillAttempt;

    return result;
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { simulate };
