// Time-range slider — the 1H/6H/12H/24H… pill row above the history
// graph. Owns its own pointer/keyboard wiring and resyncs on phase
// flips so .live-only steps appear/disappear cleanly.

import { store } from '../app-state.js';
import { graphRange, setGraphRange } from './state.js';
import { fetchLiveHistory } from './live-history.js';
import { drawHistoryGraph } from './history-graph.js';
import { resetChartZoom } from './chart-pinch-zoom.js';

function hapticTick() {
  try { if (navigator.vibrate) navigator.vibrate(8); } catch (_) { /* noop */ }
}

export function setupTimeRangeSlider() {
  const slider = document.getElementById('time-range-slider');
  if (!slider) return;
  const thumb = slider.querySelector('.time-range-slider-thumb');
  const fill = slider.querySelector('.time-range-slider-fill');
  const stepsWrap = slider.querySelector('.time-range-slider-steps');
  const allSteps = Array.from(stepsWrap.querySelectorAll('.time-range-slider-step'));

  function visibleSteps() {
    return allSteps.filter(el => el.style.display !== 'none');
  }

  function updateThumb(stepEls, activeIdx) {
    if (stepEls.length === 0) return;
    // Pills size to their own text content (1h is narrower than 4mo), so
    // the thumb has to read each pill's actual layout box rather than
    // assuming equal widths. Layout width can briefly be 0 right after
    // the slider becomes visible — fall back to equal partitioning then.
    const wrapRect = stepsWrap.getBoundingClientRect();
    const wrapW = wrapRect.width;
    const activeBtn = stepEls[activeIdx];
    const btnRect = activeBtn.getBoundingClientRect();
    let leftPct, widthPct;
    if (wrapW > 0 && btnRect.width > 0) {
      leftPct = (btnRect.left - wrapRect.left) / wrapW * 100;
      widthPct = btnRect.width / wrapW * 100;
    } else {
      widthPct = 100 / stepEls.length;
      leftPct = widthPct * activeIdx;
    }
    thumb.style.width = widthPct + '%';
    thumb.style.transform = 'translateX(' + (leftPct / widthPct * 100) + '%)';
    fill.style.width = (leftPct + widthPct) + '%';
    allSteps.forEach(b => b.classList.remove('active'));
    stepEls[activeIdx].classList.add('active');
    slider.setAttribute('aria-valuemin', '0');
    slider.setAttribute('aria-valuemax', String(stepEls.length - 1));
    slider.setAttribute('aria-valuenow', String(activeIdx));
    slider.setAttribute('aria-valuetext', stepEls[activeIdx].textContent);
  }

  function commit(stepEls, idx, fromUser) {
    idx = Math.max(0, Math.min(stepEls.length - 1, idx));
    const el = stepEls[idx];
    const seconds = parseInt(el.dataset.range, 10);
    const changed = graphRange !== seconds;
    setGraphRange(seconds);
    updateThumb(stepEls, idx);
    if (changed) {
      // Picking a new timeframe is the explicit "show me this span"
      // action, so any pinch zoom inside the previous span goes away.
      resetChartZoom();
      if (fromUser) hapticTick();
      if (store.get('phase') === 'live') {
        fetchLiveHistory(graphRange);
      } else {
        drawHistoryGraph();
      }
    }
  }

  function idxFromClientX(stepEls, clientX) {
    // Snap to whichever pill's actual layout box the pointer sits inside.
    // Equal-width math would land in the wrong pill once the labels
    // diverge — `1h` is ~12 px narrower than `4mo`, so a click on the
    // left edge of `7d` falls into `3d`'s slot under uniform partitioning.
    for (let i = 0; i < stepEls.length; i++) {
      const r = stepEls[i].getBoundingClientRect();
      if (clientX < r.right) return i;
    }
    return stepEls.length - 1;
  }

  function syncFromState() {
    const stepEls = visibleSteps();
    let idx = stepEls.findIndex(el => parseInt(el.dataset.range, 10) === graphRange);
    if (idx < 0) {
      // graphRange points at a step hidden in this phase (e.g. switched
      // live→sim while on 7d). Clamp to the largest visible step and
      // rewrite state so subsequent fetches use a supported range.
      idx = stepEls.length - 1;
      const el = stepEls[idx];
      setGraphRange(parseInt(el.dataset.range, 10));
    }
    updateThumb(stepEls, idx);
  }
  syncFromState();

  stepsWrap.addEventListener('click', (e) => {
    const btn = e.target.closest('.time-range-slider-step');
    if (!btn || btn.style.display === 'none') return;
    const stepEls = visibleSteps();
    const idx = stepEls.indexOf(btn);
    if (idx >= 0) commit(stepEls, idx, true);
  });

  // Drag support: pointer events cover mouse + touch + pen uniformly.
  let dragging = false;
  let activePointer = null;
  let lastIdx = -1;

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    dragging = true;
    activePointer = e.pointerId;
    slider.classList.add('dragging');
    try { slider.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
    const stepEls = visibleSteps();
    const idx = idxFromClientX(stepEls, e.clientX);
    lastIdx = idx;
    commit(stepEls, idx, true);
    e.preventDefault();
  }

  function onMove(e) {
    if (!dragging || e.pointerId !== activePointer) return;
    const stepEls = visibleSteps();
    const idx = idxFromClientX(stepEls, e.clientX);
    if (idx !== lastIdx) {
      lastIdx = idx;
      commit(stepEls, idx, true);
    }
  }

  function onUp(e) {
    if (!dragging || (activePointer !== null && e.pointerId !== activePointer)) return;
    dragging = false;
    activePointer = null;
    lastIdx = -1;
    slider.classList.remove('dragging');
  }

  slider.addEventListener('pointerdown', onDown);
  slider.addEventListener('pointermove', onMove);
  slider.addEventListener('pointerup', onUp);
  slider.addEventListener('pointercancel', onUp);

  slider.addEventListener('keydown', (e) => {
    const stepEls = visibleSteps();
    const current = stepEls.findIndex(el => parseInt(el.dataset.range, 10) === graphRange);
    const cur = current < 0 ? 0 : current;
    let next;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - 1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = stepEls.length - 1;
    else return;
    e.preventDefault();
    commit(stepEls, next, true);
  });

  // Re-sync when phase flips live↔sim — .live-only steps show/hide and
  // the visible set changes. subscriptions.js has already toggled
  // display:none by the time this subscriber fires.
  store.subscribe('phase', () => { syncFromState(); });
}
