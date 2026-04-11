/**
 * Pipe → valve topology for the playground schematic.
 *
 * Each entry keys a `data-cell-id` in the generated topology SVG
 * (playground/assets/system-topology.svg). The rule determines whether
 * the pipe should render "active" (water flowing) given the current
 * valve + pump state.
 *
 * Rule shapes:
 *   valves: [a, b]  — active iff every listed valve is open
 *                     (AND pump on when needsPump)
 *   anyOf: [a, b]   — active iff any listed valve is open
 *                     (AND pump on when needsPump)
 *
 * When a new pipe is added to topology-layout.yaml, it MUST be added
 * here too. The schematic module warns at build time about any pipe
 * cell in the SVG that isn't in this map.
 */
export const PIPES = {
  // Input manifold stubs (tank side)
  pipe_tank_vibtm:         { valves: ['vi_btm'],  needsPump: true },
  pipe_vibtm_pump:         { valves: ['vi_btm'],  needsPump: true },
  pipe_reservoir_vitop:    { valves: ['vi_top'],  needsPump: true },
  pipe_vitop_pump:         { valves: ['vi_top'],  needsPump: true },
  pipe_collbtm_vicoll:     { valves: ['vi_coll'], needsPump: true },
  pipe_vicoll_pump:        { valves: ['vi_coll'], needsPump: true },

  // Output manifold stubs
  pipe_pump_vocoll:        { valves: ['vo_coll'], needsPump: true },
  pipe_vocoll_collbtm:     { valves: ['vo_coll'], needsPump: true },
  pipe_pump_vorad:         { valves: ['vo_rad'],  needsPump: true },
  pipe_vorad_radiator:     { valves: ['vo_rad'],  needsPump: true },
  pipe_rad_return:         { valves: ['vo_rad'],  needsPump: true },
  pipe_pump_votank:        { valves: ['vo_tank'], needsPump: true },
  pipe_votank_tank:        { valves: ['vo_tank'], needsPump: true },

  // Passive connections — flow direction depends on the active mode, so we
  // also declare which valves should REVERSE the pulse animation relative
  // to the drawio path direction.
  //
  // pipe_coll_top_reservoir (path drawn collector → reservoir):
  //   - solar_charging (vo_coll): flows collector → reservoir (forward)
  //   - active_drain   (vi_coll): reservoir → collector (reversed)
  // pipe_dip_reservoir (path drawn dip_port → reservoir):
  //   - greenhouse_heating (vi_top): dip_port → reservoir (forward)
  //   - solar_charging     (vi_btm): reservoir → dip_port (reversed)
  pipe_coll_top_reservoir: {
    anyOf: ['vo_coll', 'vi_coll'],
    needsPump: true,
    reverseWhen: ['vi_coll'],
    // In drain mode ambient reservoir water is pulled into the collectors,
    // so this pipe carries cold water — override the red baseline to blue.
    coldWhen: ['vi_coll'],
  },
  pipe_dip_reservoir: {
    anyOf: ['vi_btm', 'vi_top'],
    needsPump: true,
    reverseWhen: ['vi_btm'],
  },
};

/**
 * All valve ids managed by the schematic. Used for default `data-active="false"`
 * initialization and to translate state updates into DOM mutations.
 */
export const VALVE_IDS = [
  'vi_btm', 'vi_top', 'vi_coll',
  'vo_coll', 'vo_rad', 'vo_tank',
  'v_air',
];

/**
 * Non-valve components whose activity is driven directly by state flags.
 * Mapping of cell id → state key.
 */
export const ACTUATOR_CELLS = {
  pump: 'pump',
  space_heater: 'space_heater',
  // v_air is already in VALVE_IDS; fan cell removed in spec 024
};

/**
 * Non-pipe components whose activity is derived from valve + pump state,
 * same rule shapes as PIPES. Used so "downstream consumers" like the
 * radiator dim when no flow reaches them.
 */
export const COMPONENT_CELLS = {
  radiator: { valves: ['vo_rad'], needsPump: true },
};

/**
 * Sensor cell id → state key under `state.sensors`. The schematic module
 * finds the label text node inside each sensor cell and replaces its
 * textContent with the formatted temperature.
 */
export const SENSOR_CELLS = {
  t_tank_top:    't_tank_top',
  t_tank_bottom: 't_tank_bottom',
  t_collector:   't_collector',
  t_greenhouse:  't_greenhouse',
  t_outdoor:     't_outdoor',
};
