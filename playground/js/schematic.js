/**
 * Playground schematic module.
 *
 * Public API:
 *   buildSchematic({ container, svgUrl })
 *     → Promise<{ update(state), destroy() }>
 *   handle.update(state)
 *     → Mutates the inlined SVG to reflect valve/pump/sensor state.
 *
 * Pure helpers exported for testing:
 *   computeActivePipes(state, pipes) → { [pipeId]: boolean }
 *
 * State shape:
 *   {
 *     valves: { vi_btm, vi_top, vi_coll, vo_coll, vo_rad, vo_tank, v_air },
 *     pump: boolean,
 *     fan: boolean,
 *     space_heater: boolean,
 *     sensors: { t_tank_top, t_tank_bottom, t_collector, t_greenhouse, t_outdoor },
 *   }
 */

import {
  PIPES,
  VALVE_IDS,
  ACTUATOR_CELLS,
  SENSOR_CELLS,
} from './schematic-topology.js';

/**
 * Pure: given a state object and a PIPES map, compute which pipes should
 * render "active" (water flowing). Returns a new object keyed by pipe id
 * with boolean values.
 */
export function computeActivePipes(state, pipes) {
  const result = {};
  const valves = (state && state.valves) || {};
  const pump = !!(state && state.pump);

  for (const id of Object.keys(pipes)) {
    const rule = pipes[id];
    const flowing = !rule.needsPump || pump;
    let open;
    if (rule.valves) {
      open = rule.valves.every((v) => !!valves[v]);
    } else if (rule.anyOf) {
      open = rule.anyOf.some((v) => !!valves[v]);
    } else {
      open = false;
    }
    result[id] = flowing && open;
  }
  return result;
}

// buildSchematic() and applyState() come in Task 7.
export async function buildSchematic() {
  throw new Error('buildSchematic not implemented yet');
}
