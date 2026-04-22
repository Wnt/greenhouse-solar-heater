/**
 * Standalone all-modes flow tester.
 *
 * Renders one full schematic per operating mode so that pipe highlights
 * and flow directions can be compared side-by-side. This page is NOT
 * linked from the SPA navigation — it exists purely as a visual
 * verification tool. The schematics themselves are driven by the same
 * buildSchematic() module the production Components view uses.
 */

import { buildSchematic } from './schematic.js';
import { VALVE_IDS } from './schematic-topology.js';

// Mode presets — must mirror system.yaml `modes.<name>.valve_states` and
// `.actuators`. Kept separate from schematic-tester.js so that adding new
// modes here doesn't force the other tester to grow.
const MODES = [
  {
    key: 'idle',
    label: 'Idle',
    notes: 'All valves closed, pump off. Every pipe should dim; tees stay visible but no flow animation.',
    valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
    pump: false,
    space_heater: false,
  },
  {
    key: 'solar_charging',
    label: 'Solar charging',
    notes: 'Tank bottom → VI-btm → pump → VO-coll → collectors. Drainback return (passive): collectors → reservoir → tee → dip tube → tank. pipe_collbtm_vicoll, pipe_tee_lower_tee_upper, pipe_votank_tank and pipe_dip_reservoir animate in REVERSE relative to their drawn direction.',
    valves: { vi_btm: true, vi_top: false, vi_coll: false, vo_coll: true, vo_rad: false, vo_tank: false, v_air: false },
    pump: true,
    space_heater: false,
  },
  {
    key: 'greenhouse_heating',
    label: 'Greenhouse heating',
    notes: 'Tank top (via dip tube) + reservoir → tee → VI-top → pump → VO-rad → radiator → tee_output_upper → tank bottom. All flows run forward; both dip and reservoir feeds light up.',
    valves: { vi_btm: false, vi_top: true, vi_coll: false, vo_coll: false, vo_rad: true, vo_tank: false, v_air: false },
    pump: true,
    space_heater: false,
  },
  {
    key: 'active_drain',
    label: 'Active drain',
    notes: 'Collectors → tee_collectors → VI-coll → pump → VO-tank → tee_output_lower → tee_output_upper → tank bottom. Passive collector-top pipe animates in REVERSE and repaints blue (air, not water).',
    valves: { vi_btm: false, vi_top: false, vi_coll: true, vo_coll: false, vo_rad: false, vo_tank: true, v_air: true },
    pump: true,
    space_heater: false,
  },
  {
    key: 'emergency_heating',
    label: 'Emergency heating',
    notes: 'Space heater on, no pump, no valves open. Only the heater element should highlight; all pipes remain dim.',
    valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
    pump: false,
    space_heater: true,
  },
];

const SVG_URL = './assets/system-topology.svg';

// Mock sensor readings so the label nodes in each SVG render something
// realistic rather than "--°C". Values per mode are rough-but-plausible.
function sensorsForMode(key) {
  switch (key) {
    case 'solar_charging':
      return { t_collector: 55, t_tank_top: 42, t_tank_bottom: 28, t_outdoor: 12, t_greenhouse: 18 };
    case 'greenhouse_heating':
      return { t_collector: 4, t_tank_top: 48, t_tank_bottom: 26, t_outdoor: -3, t_greenhouse: 9 };
    case 'active_drain':
      return { t_collector: 0, t_tank_top: 35, t_tank_bottom: 22, t_outdoor: -6, t_greenhouse: 7 };
    case 'emergency_heating':
      return { t_collector: -8, t_tank_top: 14, t_tank_bottom: 12, t_outdoor: -12, t_greenhouse: 3 };
    case 'idle':
    default:
      return { t_collector: 8, t_tank_top: 22, t_tank_bottom: 20, t_outdoor: 6, t_greenhouse: 16 };
  }
}

function openValvesSummary(valves) {
  const open = VALVE_IDS.filter((v) => valves[v]);
  if (open.length === 0) return [{ text: 'all closed', klass: '' }];
  return VALVE_IDS.map((v) => ({ text: v, klass: valves[v] ? 'open' : '' }));
}

async function renderMode(mode) {
  const card = document.createElement('section');
  card.className = 'mode-card';
  card.dataset.mode = mode.key;

  const title = document.createElement('h2');
  title.textContent = mode.label;
  card.appendChild(title);

  const summary = document.createElement('div');
  summary.className = 'valve-summary';
  for (const item of openValvesSummary(mode.valves)) {
    const span = document.createElement('span');
    if (item.klass) span.className = item.klass;
    span.textContent = item.text;
    summary.appendChild(span);
  }
  const pumpSpan = document.createElement('span');
  pumpSpan.className = mode.pump ? 'open' : '';
  pumpSpan.textContent = mode.pump ? 'pump ON' : 'pump off';
  summary.appendChild(pumpSpan);
  if (mode.space_heater) {
    const shSpan = document.createElement('span');
    shSpan.className = 'open';
    shSpan.textContent = 'space heater ON';
    summary.appendChild(shSpan);
  }
  card.appendChild(summary);

  const host = document.createElement('div');
  host.className = 'schematic-host';
  card.appendChild(host);

  const notes = document.createElement('div');
  notes.className = 'notes';
  notes.textContent = mode.notes;
  card.appendChild(notes);

  document.getElementById('modes-grid').appendChild(card);

  try {
    const handle = await buildSchematic({ container: host, svgUrl: SVG_URL });
    handle.update({
      valves: { ...mode.valves },
      pump: mode.pump,
      space_heater: mode.space_heater,
      sensors: sensorsForMode(mode.key),
    });
  } catch (err) {
    host.textContent = 'Failed to load schematic: ' + err.message;
    console.error('[flow-tester]', mode.key, err);
  }
}

async function init() {
  // Render sequentially to avoid hammering the network with parallel fetches
  // of the same SVG — the browser cache kicks in after the first request.
  for (const mode of MODES) {
    await renderMode(mode);
  }
}

init();
