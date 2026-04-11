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

const STYLE_TAG_ID = 'schematic-base-styles';

const BASE_CSS = `
/*
 * Note: this <style> is injected into an SVG that was parsed via
 * container.innerHTML, which makes it document-scoped, not SVG-scoped.
 * Keep these selectors narrow to data-cell-id to avoid collisions
 * with any future markup elsewhere on the page.
 */

/* Default: managed cells render dim until update() is called */
[data-cell-id][data-active="false"] { opacity: 0.15; transition: opacity 180ms; }
[data-cell-id][data-active="true"]  { opacity: 1.00; transition: opacity 180ms; }

/* Valves stay a bit more visible than pipes when closed */
[data-cell-id^="vi_"][data-active="false"],
[data-cell-id^="vo_"][data-active="false"],
[data-cell-id^="v_"][data-active="false"]  { opacity: 0.30; }

/* Pump gets a teal highlight when on */
[data-cell-id="pump"][data-active="true"] path,
[data-cell-id="pump"][data-active="true"] ellipse { stroke: #43aea4; }
`;

/**
 * Fetch the SVG at `svgUrl`, inject it into `container`, install base styles,
 * initialize managed cells to data-active="false", and return a handle.
 */
export async function buildSchematic({ container, svgUrl }) {
  if (!container) throw new Error('buildSchematic: container is required');
  if (!svgUrl) throw new Error('buildSchematic: svgUrl is required');

  const res = await fetch(svgUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${svgUrl}: ${res.status}`);
  }
  const svgText = await res.text();
  container.innerHTML = svgText;

  const svgEl = container.querySelector('svg');
  if (!svgEl) throw new Error('buildSchematic: no <svg> element found in response');

  installBaseStyles(svgEl);
  initializeManagedCells(svgEl);

  return {
    update(state) {
      if (!state) return;
      applyState(svgEl, state);
    },
    destroy() {
      container.innerHTML = '';
    },
  };
}

function installBaseStyles(svgEl) {
  if (svgEl.querySelector('#' + STYLE_TAG_ID)) return;
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.id = STYLE_TAG_ID;
  style.textContent = BASE_CSS;
  svgEl.insertBefore(style, svgEl.firstChild);
}

function initializeManagedCells(svgEl) {
  const ids = [
    ...VALVE_IDS,
    ...Object.keys(ACTUATOR_CELLS),
    ...Object.keys(PIPES),
  ];
  for (const id of ids) {
    const cell = svgEl.querySelector(`[data-cell-id="${id}"]`);
    if (cell) cell.setAttribute('data-active', 'false');
  }
  // Warn about pipe cells in the SVG that aren't in the PIPES map — catches
  // "added a pipe to topology-layout.yaml but forgot schematic-topology.js"
  const pipeCells = svgEl.querySelectorAll('[data-cell-id^="pipe_"]');
  for (const cell of pipeCells) {
    const id = cell.getAttribute('data-cell-id');
    if (!PIPES[id] && typeof console !== 'undefined') {
      console.warn('[schematic] pipe cell has no PIPES entry:', id);
    }
  }
}

function applyState(svgEl, state) {
  // Valves
  for (const vid of VALVE_IDS) {
    const cell = svgEl.querySelector(`[data-cell-id="${vid}"]`);
    if (cell) cell.setAttribute('data-active', state.valves && state.valves[vid] ? 'true' : 'false');
  }

  // Actuator components (pump, space_heater, ...)
  for (const [cellId, stateKey] of Object.entries(ACTUATOR_CELLS)) {
    const cell = svgEl.querySelector(`[data-cell-id="${cellId}"]`);
    if (cell) cell.setAttribute('data-active', state[stateKey] ? 'true' : 'false');
  }

  // Pipes — computed from valve + pump state
  const activePipes = computeActivePipes(state, PIPES);
  for (const [pipeId, isActive] of Object.entries(activePipes)) {
    const cell = svgEl.querySelector(`[data-cell-id="${pipeId}"]`);
    if (cell) cell.setAttribute('data-active', isActive ? 'true' : 'false');
  }

  // Sensor temperature labels
  if (state.sensors) {
    for (const [cellId, stateKey] of Object.entries(SENSOR_CELLS)) {
      const val = state.sensors[stateKey];
      const text = formatTemp(val);
      updateSensorLabel(svgEl, cellId, text);
    }
  }
}

function formatTemp(v) {
  if (v == null || !Number.isFinite(v)) return '--°C';
  return v.toFixed(1) + '°C';
}

function updateSensorLabel(svgEl, cellId, text) {
  const cell = svgEl.querySelector(`[data-cell-id="${cellId}"]`);
  if (!cell) return;
  // drawio renders cell labels as either <text> or a foreignObject <div>.
  // Try text first, fall back to the deepest <div> inside any foreignObject.
  const textEl = cell.querySelector('text');
  if (textEl) {
    textEl.textContent = text;
    return;
  }
  const fo = cell.querySelector('foreignObject');
  if (fo) {
    const divs = fo.querySelectorAll('div');
    const target = divs[divs.length - 1];
    if (target) target.textContent = text;
  }
}
