// Virtual-time simulation harness
// Runs thermal model + control logic together in virtual time

const { tick, createModel } = require('./thermal-model.js');
const { evaluate, MODES } = require('../../scripts/control-logic.js');

// TODO: implement virtual-time loop
// simulate(scenario) → trace[]
// - 1s ticks for thermal model
// - every 30s: extract temps, call evaluate(), apply decisions
// - record snapshot per tick
function simulate(scenario) {
  return [];
}

module.exports = { simulate };
