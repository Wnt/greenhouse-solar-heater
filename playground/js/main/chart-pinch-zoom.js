// Two-finger pinch zoom for the history-graph canvas. The Y axis (0–100°C)
// is fixed; only the X axis zooms. The 1H/6H/12H/24H timeframe-selector
// value is the upper bound — pinch can shrink below it but never grow
// past it. A pinch that would zoom out beyond the timeframe snaps back
// to the default sliding window (chartZoom = null).

import { graphRange, chartZoom, setChartZoom } from './state.js';
import { drawHistoryGraph, getChartWindow } from './history-graph.js';

const MIN_RANGE_SEC = 60; // 1 minute floor — anything tighter is unreadable

// Mirrors the pad object in drawHistoryGraph; used to translate pinch-
// midpoint pixels into a fraction of the plot area.
const PAD_LEFT = 8;
const PAD_RIGHT = 16;

// Pure: derive the new visible window from a 2-finger gesture.
// Returns null when the result would equal or exceed maxRange — caller
// then clears chartZoom so the default sliding view returns.
export function pinchZoomWindow({
  initialRange,
  initialFracOfPinchCenter,
  initialTimeAtPinchCenter,
  distanceRatio,
  maxRange,
  minRange,
}) {
  let newRange = initialRange / distanceRatio;
  if (newRange >= maxRange) return null;
  if (newRange < minRange) newRange = minRange;
  const f = initialFracOfPinchCenter;
  const tc = initialTimeAtPinchCenter;
  return { tMin: tc - f * newRange, tMax: tc + (1 - f) * newRange };
}

// Reset zoom whenever the data span changes shape — e.g. timeframe
// selector switches the upper bound, sim is reset, or live history
// reloads. Cheap idempotent no-op when already null.
export function resetChartZoom() {
  if (chartZoom) setChartZoom(null);
}

export function setupChartPinchZoom() {
  const canvas = document.getElementById('chart');
  if (!canvas) return;
  // Browser default is to pan-zoom the page on a 2-finger gesture; tell
  // it to leave horizontal pan alone (we still want vertical scroll on
  // the page from a 1-finger drag, hence pan-y not none).
  canvas.style.touchAction = 'pan-y';

  const pointers = new Map();
  let gesture = null;

  function midpointFracX(canvasRect, p1, p2) {
    const pw = canvasRect.width - PAD_LEFT - PAD_RIGHT;
    if (pw <= 0) return 0.5;
    const m = (p1.x + p2.x) / 2 - canvasRect.left;
    const f = (m - PAD_LEFT) / pw;
    if (f < 0) return 0;
    if (f > 1) return 1;
    return f;
  }

  function startGesture() {
    const pts = Array.from(pointers.values());
    if (pts.length !== 2) return;
    const d0 = Math.abs(pts[0].x - pts[1].x);
    if (d0 < 1) return;
    const rect = canvas.getBoundingClientRect();
    const f0 = midpointFracX(rect, pts[0], pts[1]);
    const win = getChartWindow();
    const range0 = win.tMax - win.tMin;
    const tMid = win.tMin + f0 * range0;
    gesture = { d0, f0, tMid, range0 };
  }

  function updateGesture(e) {
    if (!gesture) return;
    const pts = Array.from(pointers.values());
    if (pts.length !== 2) return;
    const d = Math.abs(pts[0].x - pts[1].x);
    if (d < 1) return;
    e.preventDefault();
    const next = pinchZoomWindow({
      initialRange: gesture.range0,
      initialFracOfPinchCenter: gesture.f0,
      initialTimeAtPinchCenter: gesture.tMid,
      distanceRatio: d / gesture.d0,
      maxRange: graphRange,
      minRange: MIN_RANGE_SEC,
    });
    setChartZoom(next);
    drawHistoryGraph();
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) startGesture();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) updateGesture(e);
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) gesture = null;
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', endPointer);
}
