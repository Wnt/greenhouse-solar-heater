/**
 * Standalone schematic component tester.
 *
 * Drives the reusable schematic module with either a mode preset
 * or individual valve/actuator toggles. No server, no auth, no
 * simulation — pure local state.
 */

import { buildSchematic } from './schematic.js';
import { VALVE_IDS } from './schematic-topology.js';

// Mode presets copied from system.yaml (modes.<name>.valve_states + .actuators).
// If system.yaml changes, update this table.
const PRESETS = {
  idle: {
    label: 'Idle',
    valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
    pump: false, fan: false, space_heater: false,
  },
  solar_charging: {
    label: 'Solar charging',
    valves: { vi_btm: true, vi_top: false, vi_coll: false, vo_coll: true, vo_rad: false, vo_tank: false, v_air: false },
    pump: true, fan: false, space_heater: false,
  },
  greenhouse_heating: {
    label: 'Greenhouse heating',
    valves: { vi_btm: false, vi_top: true, vi_coll: false, vo_coll: false, vo_rad: true, vo_tank: false, v_air: false },
    pump: true, fan: true, space_heater: false,
  },
  active_drain: {
    label: 'Active drain',
    valves: { vi_btm: false, vi_top: false, vi_coll: true, vo_coll: false, vo_rad: false, vo_tank: true, v_air: true },
    pump: true, fan: false, space_heater: false,
  },
  overheat_drain: {
    label: 'Overheat drain',
    valves: { vi_btm: false, vi_top: false, vi_coll: true, vo_coll: false, vo_rad: false, vo_tank: true, v_air: true },
    pump: true, fan: false, space_heater: false,
  },
  emergency_heating: {
    label: 'Emergency heating',
    valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
    pump: false, fan: false, space_heater: true,
  },
};

const ACTUATORS = [
  { key: 'pump', label: 'Pump' },
  { key: 'fan', label: 'Fan' },
  { key: 'space_heater', label: 'Space heater' },
];

const state = {
  valves: Object.fromEntries(VALVE_IDS.map((v) => [v, false])),
  pump: false,
  fan: false,
  space_heater: false,
  sensors: {},
};

let handle = null;

async function init() {
  const container = document.getElementById('schematic-container');
  try {
    handle = await buildSchematic({
      container,
      svgUrl: './assets/system-topology.svg',
    });
  } catch (err) {
    container.textContent = 'Failed to load schematic: ' + err.message;
    console.error(err);
    return;
  }

  renderPresetButtons();
  renderValveToggles();
  renderActuatorToggles();
  applyPreset('idle');
}

function renderPresetButtons() {
  const host = document.getElementById('preset-buttons');
  host.innerHTML = '';
  for (const [key, preset] of Object.entries(PRESETS)) {
    const btn = document.createElement('button');
    btn.textContent = preset.label;
    btn.dataset.preset = key;
    btn.addEventListener('click', () => applyPreset(key));
    host.appendChild(btn);
  }
}

function renderValveToggles() {
  const host = document.getElementById('valve-toggles');
  host.innerHTML = '';
  for (const vid of VALVE_IDS) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.valve = vid;
    cb.addEventListener('change', () => {
      state.valves[vid] = cb.checked;
      tick();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(vid));
    host.appendChild(label);
  }
}

function renderActuatorToggles() {
  const host = document.getElementById('actuator-toggles');
  host.innerHTML = '';
  for (const a of ACTUATORS) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.actuator = a.key;
    cb.addEventListener('change', () => {
      state[a.key] = cb.checked;
      tick();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(a.label));
    host.appendChild(label);
  }
}

function applyPreset(key) {
  const p = PRESETS[key];
  if (!p) return;
  for (const vid of VALVE_IDS) {
    state.valves[vid] = !!p.valves[vid];
  }
  state.pump = !!p.pump;
  state.fan = !!p.fan;
  state.space_heater = !!p.space_heater;
  syncCheckboxes();
  tick();
}

function syncCheckboxes() {
  for (const cb of document.querySelectorAll('[data-valve]')) {
    cb.checked = !!state.valves[cb.dataset.valve];
  }
  for (const cb of document.querySelectorAll('[data-actuator]')) {
    cb.checked = !!state[cb.dataset.actuator];
  }
}

function tick() {
  if (handle) handle.update(state);
}

init();
