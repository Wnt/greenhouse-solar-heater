// Shared cursor state for the diagnostics charts.
//
// Lets the three line charts (greenhouse, tank, outdoor) and the mode
// ribbon all draw a synced vertical line + value tooltip at the same
// timestamp. The cursor is driven by either:
//   - desktop hover/drag on any chart, or
//   - mobile long-press (≥ LONG_PRESS_MS) on any chart
//
// A short tap (no drift, no hold) instead falls through to onTap so the
// existing click-to-drill-into-generation behaviour still works on
// touch — without forcing the operator to hit a 3 px circle.
//
// All charts subscribe to the same singleton, so updating the cursor
// from one chart broadcasts to the others.

const _subscribers = new Set();
let _cursorTs = null;

const LONG_PRESS_MS = 350;
const TAP_DRIFT_PX  = 10;

export function subscribeCursor(cb) {
  _subscribers.add(cb);
  // Replay current state so a chart that subscribes mid-press picks
  // up the existing cursor without needing a new pointermove.
  cb(_cursorTs);
  return () => _subscribers.delete(cb);
}

export function setCursorTs(ts) {
  if (ts === _cursorTs) return;
  _cursorTs = ts;
  _subscribers.forEach(function (cb) { cb(_cursorTs); });
}

export function clearCursor() { setCursorTs(null); }

export function getCursorTs() { return _cursorTs; }

// Reset state between mounts/test runs. Subscribers stay attached
// (they belong to the chart elements that the test re-renders), but
// the global ts is wiped so a stale cursor doesn't leak.
export function resetCursor() {
  _cursorTs = null;
}

// Attach pointer handlers to a chart's overlay rect. Returns a detach
// function for unmount.
//
// opts:
//   getTsAtX(svgX)       — convert overlay-local X (px) to a timestamp.
//   nearestPointAtX(svgX) — return the nearest-by-x point or null. The
//                          point should expose `generatedAt` (used to
//                          drill on tap).
//   onTap(generatedAt)   — short-tap hit handler; called when the user
//                          taps without holding and without drifting.
//   svgRect              — the <rect> overlay element to attach to.
//   svg                  — the parent <svg> (used to map clientX → svgX).
export function attachInspectorPointer(opts) {
  const rect = opts.svgRect;
  const svg  = opts.svg;
  if (!rect || !svg) return function () {};

  // Per-pointer tracking. Pointer events deliver pointerId so concurrent
  // touches don't confuse state, but in practice we only follow one
  // primary pointer at a time.
  let pointerId  = null;
  let startX     = 0;
  let startY     = 0;
  let holdTimer  = null;
  let isInspect  = false;
  let isTouch    = false;

  function clientToSvgX(clientX) {
    const ctm = svg.getScreenCTM();
    if (!ctm) return 0;
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = 0;
    const local = pt.matrixTransform(ctm.inverse());
    return local.x;
  }

  function activateInspect(ev) {
    isInspect = true;
    if (isTouch && typeof navigator !== 'undefined'
        && typeof navigator.vibrate === 'function') {
      try { navigator.vibrate(10); } catch (_e) { /* ignore */ }
    }
    setCursorTs(opts.getTsAtX(clientToSvgX(ev.clientX)));
  }

  function onPointerDown(ev) {
    if (pointerId !== null) return;
    pointerId = ev.pointerId;
    startX = ev.clientX;
    startY = ev.clientY;
    isTouch = ev.pointerType === 'touch';
    isInspect = false;
    rect.setPointerCapture(ev.pointerId);

    if (!isTouch) {
      // Mouse / pen: activate immediately on press so the operator can
      // drag through the chart to scrub. No long-press delay needed.
      activateInspect(ev);
    } else {
      // Touch: defer activation so a vertical scroll-from-chart isn't
      // captured. Cancelled by drift (pointermove) or by lift.
      holdTimer = setTimeout(function () {
        holdTimer = null;
        // Synthesise current pointer event from saved coords. There's
        // no live event here, so build a minimal shim with clientX.
        activateInspect({ clientX: startX });
      }, LONG_PRESS_MS);
    }
  }

  function onPointerMove(ev) {
    if (ev.pointerId !== pointerId) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (isInspect) {
      // Scrubbing: prevent default so the page doesn't scroll while
      // the operator drags through the chart.
      if (ev.cancelable) ev.preventDefault();
      setCursorTs(opts.getTsAtX(clientToSvgX(ev.clientX)));
      return;
    }
    if (isTouch && holdTimer !== null
        && (Math.abs(dx) > TAP_DRIFT_PX || Math.abs(dy) > TAP_DRIFT_PX)) {
      // Drifted before long-press fired → user is scrolling, not
      // inspecting. Cancel the hold timer and let the gesture fall
      // through to the page.
      clearTimeout(holdTimer);
      holdTimer = null;
      pointerId = null;
    }
  }

  function onPointerUp(ev) {
    if (ev.pointerId !== pointerId) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const wasInspect = isInspect;
    if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; }
    pointerId = null;
    isInspect = false;

    if (wasInspect) {
      // End scrub; clear the cursor so it doesn't linger on the chart.
      clearCursor();
      return;
    }
    // Short tap → drill into the nearest predicted-point's generation.
    if (Math.abs(dx) <= TAP_DRIFT_PX && Math.abs(dy) <= TAP_DRIFT_PX) {
      const p = opts.nearestPointAtX(clientToSvgX(ev.clientX));
      if (p && p.generatedAt && typeof opts.onTap === 'function') {
        opts.onTap(p.generatedAt);
      }
    }
  }

  function onPointerCancel(ev) {
    if (ev.pointerId !== pointerId) return;
    if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; }
    pointerId = null;
    if (isInspect) clearCursor();
    isInspect = false;
  }

  rect.addEventListener('pointerdown',   onPointerDown);
  rect.addEventListener('pointermove',   onPointerMove);
  rect.addEventListener('pointerup',     onPointerUp);
  rect.addEventListener('pointercancel', onPointerCancel);

  return function detach() {
    rect.removeEventListener('pointerdown',   onPointerDown);
    rect.removeEventListener('pointermove',   onPointerMove);
    rect.removeEventListener('pointerup',     onPointerUp);
    rect.removeEventListener('pointercancel', onPointerCancel);
    if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; }
  };
}

// Test bridge — mirrors the window.__sync / window.__diag pattern so
// Playwright specs can assert subscription behaviour without faking
// pointer events.
if (typeof window !== 'undefined') {
  window.__diag = window.__diag || {};
  window.__diag.inspector = {
    setCursorTs,
    getCursorTs,
    clearCursor,
    LONG_PRESS_MS,
  };
}
