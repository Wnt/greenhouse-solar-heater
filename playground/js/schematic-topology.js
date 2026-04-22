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
 * Optional modifiers:
 *   reverseWhen: [v] — flip pulse animation direction when any listed valve open
 *   coldWhen:    [v] — repaint the pipe with the cold-water palette when any
 *                      listed valve is open (e.g. a nominally hot pipe that
 *                      runs cold in a specific mode)
 *
 * Topology (post-T-joint refactor):
 *   - tee_output_lower  sits below the output manifold. Its three ports join
 *     VO-tank (trunk), pipe_tank_vibtm (arm_right → VI-btm) and
 *     pipe_tee_lower_tee_upper (arm_left → upper tee).
 *   - tee_output_upper  sits above tee_output_lower. Ports: radiator return
 *     (trunk), pipe_tee_lower_tee_upper (arm_left), pipe_votank_tank
 *     (arm_right → tank btm_port).
 *   - tee_collectors    sits at the collector bottom. Ports: VO-coll supply
 *     (trunk), pipe_collbtm_vicoll (arm_right → collectors), and
 *     pipe_tee_collectors_vicoll (arm_left → VI-coll).
 *   - tee_collector_top sits above the collector block. Ports: collectors
 *     (arm_left, pipe_coll_top_tee), V-air stub (trunk, pipe_vair_colltee),
 *     and the direct link to the reservoir's upper left port (arm_right,
 *     pipe_coll_top_reservoir).
 *   - The reservoir itself has three dedicated left-side ports (no
 *     intermediate tee): left_upper (pipe_coll_top_reservoir inlet),
 *     left_dip (pipe_dip_reservoir inlet), and left_submerged
 *     (pipe_reservoir_vitop outlet, direct down to VI-top).
 *
 * When a new pipe is added to topology-layout.yaml, it MUST be added
 * here too. The schematic module warns at build time about any pipe
 * cell in the SVG that isn't in this map.
 */
export const PIPES = {
  // -- Input manifold stubs (tank side) ---------------------------------------
  // pipe_tank_vibtm is now sourced from tee_output_lower (not tank directly).
  // Flow direction is still tee → VI-btm, same as the drawn direction, so
  // no reverse needed — the valve gate for this pipe remains vi_btm.
  pipe_tank_vibtm:         { valves: ['vi_btm'],  needsPump: true },
  pipe_vibtm_pump:         { valves: ['vi_btm'],  needsPump: true },

  // pipe_reservoir_vitop runs direct from reservoir.left_submerged down to
  // VI-top (no intermediate tee). Only active in greenhouse_heating.
  pipe_reservoir_vitop:    { valves: ['vi_top'],  needsPump: true },
  pipe_vitop_pump:         { valves: ['vi_top'],  needsPump: true },

  pipe_vicoll_pump:        { valves: ['vi_coll'], needsPump: true },

  // -- Output manifold stubs --------------------------------------------------
  pipe_pump_vocoll:        { valves: ['vo_coll'], needsPump: true },
  // pipe_vocoll_collbtm now terminates at tee_collectors.trunk (not the
  // collector bottom directly). Flow direction unchanged: vo_coll → tee.
  pipe_vocoll_collbtm:     { valves: ['vo_coll'], needsPump: true },

  pipe_pump_vorad:         { valves: ['vo_rad'],  needsPump: true },
  pipe_vorad_radiator:     { valves: ['vo_rad'],  needsPump: true },
  // pipe_rad_return now terminates at tee_output_upper.trunk instead of the
  // tank port. Flow direction unchanged: radiator → tee.
  pipe_rad_return:         { valves: ['vo_rad'],  needsPump: true },

  pipe_pump_votank:        { valves: ['vo_tank'], needsPump: true },

  // -- New pipes introduced by the T-joint refactor ---------------------------
  // VO-tank → tee_output_lower.trunk — only active during drain.
  pipe_votank_tee_lower:   { valves: ['vo_tank'], needsPump: true },

  // tee_collectors.arm_left → VI-coll. Drawn direction matches flow direction
  // in drain mode (tee → VI-coll), so no reverse needed.
  pipe_tee_collectors_vicoll: { valves: ['vi_coll'], needsPump: true },

  // -- Collector-top junction and V-air stub ---------------------------------
  // pipe_coll_top_tee (collectors.top → tee_collector_top.arm_left): passive
  // red stub that's active whenever water (or air) moves through the
  // collector top — solar_charging (vo_coll, hot water out) or active_drain
  // (vi_coll, air in). Same reverse + cold semantics as pipe_coll_top_reservoir.
  pipe_coll_top_tee: {
    anyOf: ['vo_coll', 'vi_coll'],
    needsPump: true,
    reverseWhen: ['vi_coll'],
    coldWhen: ['vi_coll'],
  },

  // pipe_vair_colltee (tee_collector_top.trunk → v_air.top): only carries
  // anything when V-air opens (drain modes). Air flows INTO the system from
  // the atmosphere, so direction is V-air → tee (reverse of drawn) and it's
  // painted cold (it's air, not hot water).
  pipe_vair_colltee: {
    valves: ['v_air'],
    needsPump: true,
    reverseWhen: ['v_air'],
    coldWhen: ['v_air'],
  },

  // -- Pipes that now carry different flows in different modes ---------------
  // pipe_collbtm_vicoll is the passive stub between the collector bottom and
  // tee_collectors (drawn collectors → tee, i.e. downward).
  //   - active_drain   (vi_coll): collectors → tee (forward)
  //   - solar_charging (vo_coll): tee → collectors (reverse — VO-coll is
  //                               pushing water up into the panels)
  pipe_collbtm_vicoll: {
    anyOf: ['vo_coll', 'vi_coll'],
    needsPump: true,
    reverseWhen: ['vo_coll'],
  },

  // pipe_tee_lower_tee_upper is the short vertical link between the two
  // output tees (drawn tee_lower → tee_upper, i.e. upward).
  //   - active_drain   (vo_tank): tee_lower → tee_upper (forward)
  //   - solar_charging (vi_btm):  tee_upper → tee_lower (reverse — water is
  //                               pulled down from tank bottom through the
  //                               upper tee to the lower tee and out to VI-btm)
  pipe_tee_lower_tee_upper: {
    anyOf: ['vi_btm', 'vo_tank'],
    needsPump: true,
    reverseWhen: ['vi_btm'],
  },

  // pipe_votank_tank is now the shared segment between tee_output_upper and
  // the tank bottom port. It carries three different flows:
  //   - active_drain        (vo_tank): tee → tank (forward)
  //   - greenhouse_heating  (vo_rad):  tee → tank (forward — radiator return)
  //   - solar_charging      (vi_btm):  tank → tee (reverse — cold draw from
  //                                    tank bottom into the output tee chain)
  pipe_votank_tank: {
    anyOf: ['vi_btm', 'vo_rad', 'vo_tank'],
    needsPump: true,
    reverseWhen: ['vi_btm'],
  },

  // -- Passive cross-diagram links (drainback + gas vent) --------------------
  // pipe_coll_top_reservoir (drawn tee_collector_top.arm_right →
  // reservoir.left_upper): the horizontal passive pipe from the collector-top
  // tee into the reservoir. Active in solar_charging (forward, hot) and
  // active_drain (reverse, cold air).
  pipe_coll_top_reservoir: {
    anyOf: ['vo_coll', 'vi_coll'],
    needsPump: true,
    reverseWhen: ['vi_coll'],
    coldWhen: ['vi_coll'],
  },

  // pipe_dip_reservoir (drawn tank.gas_out → tee_reservoir_top.trunk):
  //   - greenhouse_heating (vi_top): tank → tee (forward; hot dip-tube supply
  //                                   into the reservoir-top tee)
  //   - solar_charging     (vi_btm): tee → tank (reverse; drainback return
  //                                   from the reservoir descends to the dip
  //                                   tube and into the tank via gas_out)
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
