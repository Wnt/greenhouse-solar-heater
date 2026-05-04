// All touch gestures on the history-graph canvas funnel through here so
// pan / pinch / tap / long-press disambiguate against a single source of
// pointer-event truth.
//
//   2 fingers            — pinch zoom the x-axis (y stays fixed at 0–100°C).
//                          The 1H/6H/12H/24H timeframe-selector value is
//                          the upper bound; pinch-out past it snaps back
//                          to the default sliding window.
//   1 finger drag while  — pan the visible window left/right within the
//   zoomed                 timeframe-selector's natural span.
//   1 finger short tap   — reset zoom (no-op if already at default).
//   1 finger held still  — show the inspector tooltip; subsequent moves
//   400 ms                 track the crosshair until the finger lifts.
//
// Desktop hover uses mousemove via setupInspector and bypasses this
// disambiguator entirely.

import {
  graphRange, chartZoom, setChartZoom, timeSeriesStore,
  showForecast, FORECAST_OVERLAY_SEC,
} from './state.js';
import { drawHistoryGraph, getChartWindow } from './history-graph.js';
import { showInspector, hideInspector } from './graph-inspector.js';
import { store } from '../app-state.js';

const MIN_RANGE_SEC = 60; // 1-minute zoom floor
const TAP_MAX_PX = 8;     // movement that still counts as a tap
const TAP_MAX_MS = 300;   // touch duration that still counts as a tap
const LONG_PRESS_MS = 400;

// Mirror the pad object in drawHistoryGraph; needed to translate pinch
// midpoint pixels into a fraction of the plot area.
const PAD_LEFT = 8;
const PAD_RIGHT = 16;

// Pure: derive the new visible window from a 2-finger gesture. Returns
// null when the result would equal or exceed maxRange — caller then
// clears chartZoom so the default sliding view returns.
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

// Pure: shift a zoom window by `dt` seconds while keeping it inside
// `bound`. Width is preserved — when shifting would push past either
// edge, the window slides back to fit. Used by the 1-finger pan handler.
export function panZoomWindow(zoom, dt, bound) {
  let tMin = zoom.tMin + dt;
  let tMax = zoom.tMax + dt;
  if (tMin < bound.tMin) {
    tMax += bound.tMin - tMin;
    tMin = bound.tMin;
  }
  if (tMax > bound.tMax) {
    tMin -= tMax - bound.tMax;
    tMax = bound.tMax;
  }
  // If the zoom window was already wider than bound (shouldn't happen,
  // but defensive), pin to bound — preserves the invariant that callers
  // never see tMin > tMax.
  if (tMin < bound.tMin) tMin = bound.tMin;
  if (tMax > bound.tMax) tMax = bound.tMax;
  return { tMin, tMax };
}

export function resetChartZoom() {
  if (chartZoom) setChartZoom(null);
}

// Pure: compute the pannable/scrollable bound for the chart in seconds.
// When showForecast is true and the chart is in live mode, the right edge
// extends by forecastSec so a zoomed user can pan into the projected
// region. tMin always sits graphRange seconds before the historical right
// edge so the historical span never grows just because the forecast is on.
export function computeDefaultBound({ isLive, latestSampleT, nowSec, graphRange, showForecast, forecastSec }) {
  const baseRight = isLive ? nowSec : Math.max(graphRange, latestSampleT || 0);
  const tMax = (isLive && showForecast) ? baseRight + forecastSec : baseRight;
  return { tMin: baseRight - graphRange, tMax };
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

export function setupChartPinchZoom() {
  const canvas = document.getElementById('chart');
  if (!canvas) return;
  // Browser pinch-zooms the page on a 2-finger gesture by default. pan-y
  // keeps vertical scroll on a 1-finger drag (so users can still scroll
  // past the chart) while leaving horizontal moves and 2-finger gestures
  // for us to handle.
  canvas.style.touchAction = 'pan-y';

  const pointers = new Map();
  let pinch = null;
  let one = null;

  function plotWidth() {
    const r = canvas.getBoundingClientRect();
    return Math.max(1, r.width - PAD_LEFT - PAD_RIGHT);
  }

  function midpointFracX(rect, p1, p2) {
    const m = (p1.x + p2.x) / 2 - rect.left;
    const f = (m - PAD_LEFT) / plotWidth();
    if (f < 0) return 0;
    if (f > 1) return 1;
    return f;
  }

  function startPinch() {
    const pts = Array.from(pointers.values());
    if (pts.length !== 2) return;
    const d0 = Math.abs(pts[0].x - pts[1].x);
    if (d0 < 1) return;
    const rect = canvas.getBoundingClientRect();
    const f0 = midpointFracX(rect, pts[0], pts[1]);
    const win = getChartWindow();
    const range0 = win.tMax - win.tMin;
    const tMid = win.tMin + f0 * range0;
    pinch = { d0, f0, tMid, range0 };
  }

  function updatePinch(e) {
    if (!pinch) return;
    const pts = Array.from(pointers.values());
    if (pts.length !== 2) return;
    const d = Math.abs(pts[0].x - pts[1].x);
    if (d < 1) return;
    e.preventDefault();
    const bound = defaultBound();
    const next = pinchZoomWindow({
      initialRange: pinch.range0,
      initialFracOfPinchCenter: pinch.f0,
      initialTimeAtPinchCenter: pinch.tMid,
      distanceRatio: d / pinch.d0,
      // maxRange = the full default window (history + forecast horizon when
      // the overlay is on). Without this, pinch-out would snap back the
      // moment the zoom width grew past graphRange — even if the user is
      // still inside the chart's visible span.
      maxRange: bound.tMax - bound.tMin,
      minRange: MIN_RANGE_SEC,
    });
    setChartZoom(next);
    drawHistoryGraph();
  }

  function startOne(e) {
    const rect = canvas.getBoundingClientRect();
    const startCanvasX = e.clientX - rect.left;
    one = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startCanvasX,
      startTime: performance.now(),
      panActive: false,
      longPressActive: false,
      longPressTimer: null,
      anchorWindow: getChartWindow(),
    };
    one.longPressTimer = setTimeout(function () {
      if (!one || one.panActive) return;
      one.longPressActive = true;
      showInspector(one.startCanvasX);
    }, LONG_PRESS_MS);
  }

  function updateOne(e) {
    if (!one || e.pointerId !== one.pointerId) return;
    const dx = e.clientX - one.startX;
    const dy = e.clientY - one.startY;
    if (one.longPressActive) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      showInspector(e.clientX - rect.left);
      return;
    }
    if (one.panActive) {
      e.preventDefault();
      panBy(dx);
      return;
    }
    // Disambiguating: only commit to pan once the user moves past
    // TAP_MAX_PX, and only when zoomed (otherwise let the page scroll).
    if (Math.abs(dx) > TAP_MAX_PX || Math.abs(dy) > TAP_MAX_PX) {
      clearTimeout(one.longPressTimer);
      if (chartZoom) {
        one.panActive = true;
        e.preventDefault();
        panBy(dx);
      } else {
        // Movement without a zoom = the user is scrolling the page.
        // Drop the gesture so we don't intercept later moves.
        one = null;
      }
    }
  }

  function panBy(dxPx) {
    if (!one) return;
    const win = one.anchorWindow;
    const range = win.tMax - win.tMin;
    const dt = -(dxPx / plotWidth()) * range;
    const next = panZoomWindow(win, dt, defaultBound());
    setChartZoom(next);
    drawHistoryGraph();
  }

  function endOne(e) {
    if (!one || e.pointerId !== one.pointerId) return;
    clearTimeout(one.longPressTimer);
    if (one.longPressActive) {
      hideInspector();
    } else if (!one.panActive) {
      const elapsed = performance.now() - one.startTime;
      const dx = Math.abs(e.clientX - one.startX);
      const dy = Math.abs(e.clientY - one.startY);
      if (elapsed < TAP_MAX_MS && dx < TAP_MAX_PX && dy < TAP_MAX_PX) {
        if (chartZoom) {
          resetChartZoom();
          drawHistoryGraph();
        }
      }
    }
    one = null;
  }

  function cancelOne() {
    if (!one) return;
    clearTimeout(one.longPressTimer);
    if (one.longPressActive) hideInspector();
    one = null;
  }

  canvas.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse') return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      startOne(e);
    } else if (pointers.size === 2) {
      // 2-finger gesture takes over from any in-flight 1-finger state;
      // promoting a tap or pan into a pinch in the same gesture would be
      // confusing, so we drop it.
      cancelOne();
      startPinch();
    }
  });

  canvas.addEventListener('pointermove', function (e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      updatePinch(e);
    } else if (pointers.size === 1) {
      updateOne(e);
    }
  });

  function onEnd(e) {
    if (!pointers.has(e.pointerId)) return;
    const wasPinch = pointers.size === 2;
    pointers.delete(e.pointerId);
    if (wasPinch) {
      // Lifting one finger of a pinch ends the pinch. Don't promote the
      // remaining finger to a pan — that would surprise the user.
      pinch = null;
      cancelOne();
    } else if (one && e.pointerId === one.pointerId) {
      if (e.type === 'pointerup') endOne(e);
      else cancelOne();
    }
  }

  canvas.addEventListener('pointerup', onEnd);
  canvas.addEventListener('pointercancel', onEnd);
  canvas.addEventListener('pointerleave', onEnd);
}
