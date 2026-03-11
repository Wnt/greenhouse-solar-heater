// Lumped-parameter thermal model for greenhouse solar heating simulation
// Pure functions — no side effects, no mutation

function createModel(overrides) {
  const defaults = {
    collector: 20,
    tank_top: 40,
    tank_bottom: 30,
    greenhouse: 15,
    outdoor: 10,
    collectorWaterVolume: 0,  // liters, 0 = drained
  };
  return Object.assign({}, defaults, overrides);
}

// TODO: implement thermal physics
// tick(model, dt, decisions) → updatedModel
// - dt: time step in seconds
// - decisions: { valves, actuators } from evaluate()
// - returns new model state (no mutation)
function tick(model, dt, decisions) {
  return Object.assign({}, model);
}

module.exports = { createModel, tick };
