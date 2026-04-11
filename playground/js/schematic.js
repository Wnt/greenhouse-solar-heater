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
  COMPONENT_CELLS,
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

/*
 * Hide drawio's raster label fallbacks. drawio wraps every foreignObject
 * label in a <switch> with a base64 PNG <image> sibling as the fallback.
 * The foreignObject carries requiredFeatures="…SVG11/feature#Extensibility"
 * but modern browsers no longer support SVG 1.1 feature strings, so the
 * switch picks the <image> instead — rendering light-mode PNG rasters on
 * top of the dark card. Hiding the raster leaves only the HTML foreignObject
 * label, which inherits the card's text color correctly.
 */
switch > image { display: none; }

/*
 * Recolor drawio's pipe-label backgrounds to match the card surface.
 * drawio gives pipe edge labels an inline background-color that masks
 * the pipe line behind the text. With our color-scheme: light it resolves
 * to #ffffff — a jarring white rectangle on the dark card. Override to the
 * card color (with a fallback) plus a little padding so the label reads as
 * a subtle badge over the pipe. !important overrides the inline style.
 */
foreignObject div[style*="background-color"] {
  background-color: var(--surface-container, #161a21) !important;
  padding: 1px 5px !important;
  border-radius: 3px !important;
}

/*
 * Flowing-water pulse overlay for active pipes. installFlowOverlays()
 * clones each pipe's first <path> and tags it with data-flow-overlay;
 * the clone is hidden by default and only renders on active pipes.
 * The dashoffset animation moves the dashes along the path, producing
 * a directional pulse effect. drop-shadow gives a subtle glow halo.
 */
@keyframes schematic-flow-pulse {
  from { stroke-dashoffset: 0; }
  to   { stroke-dashoffset: -36; }
}
@keyframes schematic-flow-pulse-reverse {
  from { stroke-dashoffset: 0; }
  to   { stroke-dashoffset: 36; }
}
path[data-flow-overlay] {
  display: none;
  pointer-events: none;
}
[data-cell-id^="pipe_"][data-active="true"] path[data-flow-overlay] {
  display: inline;
  animation: schematic-flow-pulse 1.2s linear infinite;
}
[data-cell-id^="pipe_"][data-active="true"][data-flow-reverse="true"] path[data-flow-overlay] {
  animation-name: schematic-flow-pulse-reverse;
}
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

  // drawio's CLI wraps every fill/stroke in `light-dark(source, substitute)`
  // where the SECOND value is a light-mode "correction" drawio injects for
  // readability on a light background. Our playground renders on a dark card
  // and WANTS the source colors. Forcing color-scheme: light on the SVG makes
  // the browser resolve `light-dark()` to the first argument — the actual
  // palette we authored in topology-layout.yaml.
  svgEl.style.colorScheme = 'light';

  installBaseStyles(svgEl);
  initializeManagedCells(svgEl);
  installFlowOverlays(svgEl);

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

function installFlowOverlays(svgEl) {
  const pipes = svgEl.querySelectorAll('[data-cell-id^="pipe_"]');
  for (const pipe of pipes) {
    if (pipe.querySelector('path[data-flow-overlay]')) continue;
    const firstPath = pipe.querySelector('path');
    if (!firstPath || !firstPath.parentElement) continue;
    const clone = firstPath.cloneNode(false);
    clone.setAttribute('data-flow-overlay', 'true');
    clone.removeAttribute('style');
    clone.setAttribute('stroke', '#ffffff');
    clone.setAttribute('stroke-width', '4');
    clone.setAttribute('stroke-dasharray', '6 30');
    clone.setAttribute('stroke-linecap', 'round');
    clone.setAttribute('fill', 'none');
    clone.setAttribute('opacity', '0.85');
    clone.style.filter = 'drop-shadow(0 0 2px rgba(255,255,255,0.7))';
    firstPath.parentElement.appendChild(clone);
  }
}

function initializeManagedCells(svgEl) {
  const ids = [
    ...VALVE_IDS,
    ...Object.keys(ACTUATOR_CELLS),
    ...Object.keys(PIPES),
    ...Object.keys(COMPONENT_CELLS),
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
  const valves = (state && state.valves) || {};
  for (const [pipeId, isActive] of Object.entries(activePipes)) {
    const cell = svgEl.querySelector(`[data-cell-id="${pipeId}"]`);
    if (!cell) continue;
    cell.setAttribute('data-active', isActive ? 'true' : 'false');
    // Flip the pulse animation when the pipe's reverseWhen valves are open.
    const rule = PIPES[pipeId];
    const reversed = !!(rule.reverseWhen && rule.reverseWhen.some((v) => valves[v]));
    cell.setAttribute('data-flow-reverse', reversed ? 'true' : 'false');
  }

  // Non-pipe components (radiator, …) — same rule shape, separate map
  const activeComponents = computeActivePipes(state, COMPONENT_CELLS);
  for (const [cellId, isActive] of Object.entries(activeComponents)) {
    const cell = svgEl.querySelector(`[data-cell-id="${cellId}"]`);
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
