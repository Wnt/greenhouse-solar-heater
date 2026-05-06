// Desktop mouse interactions on the history-graph canvas — kept
// separate from chart-pinch-zoom.js so the touch state machine and
// the mouse state machine don't tangle. The two share their pure
// helpers (`panZoomWindow`, `pinchZoomWindow`, `computeDefaultBound`)
// from chart-pinch-zoom.js, but neither imports the other.
//
//   plain drag    — pan the visible window left/right within the
//                   pannable area returned by computeDefaultBound.
//   shift + drag  — rubber-band a time range; on mouseup the window
//                   zooms to that range. A semi-transparent overlay
//                   div in the chart container previews the selection
//                   while the mouse is held.
//
// Cursors hint at what the next click would do: `grab` over a
// pannable chart, `col-resize` while shift is held (zoom-select), and
// `grabbing` / `col-resize` while a drag is in flight. The inspector
// hover (graph-inspector.js) is suppressed during a drag.

import {
  graphRange, chartZoom, setChartZoom, timeSeriesStore,
  showForecast, FORECAST_OVERLAY_SEC,
} from './state.js';
import { drawHistoryGraph, getChartWindow } from './history-graph.js';
import { panZoomWindow, computeDefaultBound } from './chart-pinch-zoom.js';
import { hideInspector } from './graph-inspector.js';
import { store } from '../app-state.js';

const PAD_LEFT = 8;
const PAD_RIGHT = 16;
const MIN_RANGE_SEC = 60;
const MIN_SELECT_PX = 4;
// Below this many pixels of movement, a pointerup is treated as a
// click — used by the click-to-reset-zoom path.
const CLICK_MAX_PX = 4;
const SELECTION_CLASS = 'graph-selection';

// Pure: convert two canvas-relative x coords (e.g. mousedown x and
// mouseup x) into a {tMin, tMax} window for the *current* visible
// chart, clamped to the pannable bound. Returns null when the
// selection is degenerate (< minRange seconds wide).
export function selectionToWindow({
  startCanvasX, endCanvasX, padLeft, plotW, currentWindow, bound, minRange,
}) {
  if (plotW <= 0) return null;
  const x1 = Math.min(startCanvasX, endCanvasX);
  const x2 = Math.max(startCanvasX, endCanvasX);
  const range = currentWindow.tMax - currentWindow.tMin;
  const fracStart = clamp01((x1 - padLeft) / plotW);
  const fracEnd   = clamp01((x2 - padLeft) / plotW);
  let tMin = currentWindow.tMin + fracStart * range;
  let tMax = currentWindow.tMin + fracEnd * range;
  if (tMax - tMin < minRange) return null;
  if (tMin < bound.tMin) tMin = bound.tMin;
  if (tMax > bound.tMax) tMax = bound.tMax;
  if (tMax - tMin < minRange) return null;
  return { tMin, tMax };
}

function clamp01(f) { return f < 0 ? 0 : (f > 1 ? 1 : f); }

export function setupChartMouseZoom() {
  const canvas = document.getElementById('chart');
  if (!canvas) return;
  const container = canvas.parentElement;
  if (!container) return;

  // Selection overlay is created lazily on the first shift+drag so the
  // DOM stays free of chart-only elements until they're needed.
  let overlay = null;
  let shiftHeld = false;
  let drag = null;

  function plotWidth() {
    const r = canvas.getBoundingClientRect();
    return Math.max(1, r.width - PAD_LEFT - PAD_RIGHT);
  }

  function defaultBound() {
    const isLive = store.get('phase') === 'live';
    const latest = timeSeriesStore.times.length > 0
      ? timeSeriesStore.times[timeSeriesStore.times.length - 1]
      : 0;
    return computeDefaultBound({
      isLive,
      latestSampleT: latest,
      nowSec: Math.floor(Date.now() / 1000),
      graphRange,
      showForecast,
      forecastSec: FORECAST_OVERLAY_SEC,
    });
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = SELECTION_CLASS;
    overlay.style.cssText = 'display:none;position:absolute;top:0;bottom:0;background:rgba(255,255,255,0.12);border-left:1px solid rgba(255,255,255,0.4);border-right:1px solid rgba(255,255,255,0.4);pointer-events:none;z-index:3;';
    container.appendChild(overlay);
    return overlay;
  }

  function setOverlay(x1, x2) {
    const o = ensureOverlay();
    const left = Math.min(x1, x2);
    const width = Math.abs(x2 - x1);
    o.style.left = left + 'px';
    o.style.width = width + 'px';
    o.style.display = 'block';
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
  }

  // Pan is available whenever the pannable bound is wider than the
  // currently-visible window — i.e. there's somewhere to pan to.
  // Covers two cases: chartZoom set (window is narrower than bound),
  // and the forecast-toggle preset where the default visible shows
  // graphRange + range/2 forecast but the bound extends to the full
  // 48 h forecast horizon.
  function canPan() {
    const win = getChartWindow();
    const bound = defaultBound();
    return (bound.tMax - bound.tMin) > (win.tMax - win.tMin) + 1;
  }

  function refreshCursor() {
    if (drag && drag.mode === 'pan') {
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (drag && drag.mode === 'select') {
      canvas.style.cursor = 'col-resize';
      return;
    }
    if (shiftHeld) {
      canvas.style.cursor = 'col-resize';
      return;
    }
    canvas.style.cursor = canPan() ? 'grab' : 'default';
  }

  function startSelect(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    drag = {
      mode: 'select',
      startCanvasX: x,
      pointerId: e.pointerId,
      anchorWindow: getChartWindow(),
    };
    setOverlay(x, x);
    hideInspector();
    refreshCursor();
    e.preventDefault();
  }

  function startPan(e) {
    drag = {
      mode: 'pan',
      startX: e.clientX,
      maxAbsDx: 0,
      pointerId: e.pointerId,
      anchorWindow: getChartWindow(),
    };
    refreshCursor();
    e.preventDefault();
  }

  function updateDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.mode === 'pan') {
      const dx = e.clientX - drag.startX;
      if (Math.abs(dx) > drag.maxAbsDx) drag.maxAbsDx = Math.abs(dx);
      const win = drag.anchorWindow;
      const range = win.tMax - win.tMin;
      const dt = -(dx / plotWidth()) * range;
      const next = panZoomWindow(win, dt, defaultBound());
      setChartZoom(next);
      drawHistoryGraph();
      e.preventDefault();
      return;
    }
    if (drag.mode === 'select') {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      setOverlay(drag.startCanvasX, x);
      e.preventDefault();
    }
  }

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.mode === 'select') {
      const rect = canvas.getBoundingClientRect();
      const endX = e.clientX - rect.left;
      hideOverlay();
      if (Math.abs(endX - drag.startCanvasX) >= MIN_SELECT_PX) {
        const next = selectionToWindow({
          startCanvasX: drag.startCanvasX,
          endCanvasX: endX,
          padLeft: PAD_LEFT,
          plotW: plotWidth(),
          currentWindow: drag.anchorWindow,
          bound: defaultBound(),
          minRange: MIN_RANGE_SEC,
        });
        if (next) {
          setChartZoom(next);
          drawHistoryGraph();
        }
      }
    } else if (drag.mode === 'pan' && drag.maxAbsDx < CLICK_MAX_PX) {
      // A pan that never moved past CLICK_MAX_PX is a click — reset
      // the chart zoom back to the default window so users can escape
      // a deep zoom without hunting for a separate "reset" control.
      // updateDrag may have nudged chartZoom by a sub-pixel amount; a
      // straight setChartZoom(null) snaps it cleanly back to default.
      setChartZoom(null);
      drawHistoryGraph();
    }
    drag = null;
    refreshCursor();
  }

  function cancelDrag() {
    if (drag && drag.mode === 'select') hideOverlay();
    drag = null;
    refreshCursor();
  }

  canvas.addEventListener('pointerdown', function (e) {
    if (e.pointerType !== 'mouse') return;
    if (e.button !== 0) return;
    if (e.shiftKey) {
      startSelect(e);
    } else if (canPan() || chartZoom) {
      // canPan() covers the "default view but pannable" case (forecast
      // on with the range/2 preset — the bound extends to +48 h while
      // the visible window only shows +range/2). chartZoom covers the
      // "user has zoomed in" case. Both also enable click-to-reset so
      // the cancel-the-zoom click path works even at full default.
      startPan(e);
    }
  });

  canvas.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'mouse') return;
    if (drag) {
      updateDrag(e);
    } else {
      // Hover-only: keep the cursor in sync with shift state and
      // current zoom level so the affordance is always discoverable.
      refreshCursor();
    }
  });

  canvas.addEventListener('pointerup', function (e) {
    if (e.pointerType !== 'mouse') return;
    endDrag(e);
  });

  canvas.addEventListener('pointercancel', function (e) {
    if (e.pointerType !== 'mouse') return;
    if (drag && e.pointerId === drag.pointerId) cancelDrag();
  });

  canvas.addEventListener('pointerleave', function (e) {
    if (e.pointerType !== 'mouse') return;
    // Don't cancel an in-flight drag on leave — the user often whips
    // the mouse across the chart edge during a fast pan. The window
    // tracking pointerup catches the release wherever it lands.
    if (!drag) refreshCursor();
  });

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Shift' && !shiftHeld) {
      shiftHeld = true;
      refreshCursor();
    }
  });
  window.addEventListener('keyup', function (e) {
    if (e.key === 'Shift' && shiftHeld) {
      shiftHeld = false;
      refreshCursor();
    }
  });
  window.addEventListener('blur', function () {
    if (shiftHeld) {
      shiftHeld = false;
      refreshCursor();
    }
  });
  // Catch the pointerup that lands outside the canvas (user dragged
  // off the chart and released over another element).
  window.addEventListener('pointerup', function (e) {
    if (drag && e.pointerType === 'mouse' && e.pointerId === drag.pointerId) {
      endDrag(e);
    }
  });

  refreshCursor();
}
