// Status-graph "Forecast" selector — a 3-way segmented switch:
// Off / ML / Physics. "Off" hides the overlay; ML and Physics both turn
// it on and pick the engine. The forecast data itself is fetched by
// playground/js/forecast.js (which re-fetches on engine change) and
// stashed in state (forecastData); this switch gates whether
// history-graph.js renders the overlay and which engine drives it.
// Hidden in sim mode via the .live-only class.

import { showForecast, setShowForecast } from './state.js';
import { getForecastEngine, setForecastEngine, onForecastEngineChange } from '../forecast.js';
import { drawHistoryGraph } from './history-graph.js';
import { resetChartZoom } from './chart-pinch-zoom.js';

// Reveal/hide the forecast-only legend items in step with the overlay.
function applyForecastLegendVisibility() {
  const display = showForecast ? '' : 'none';
  document.querySelectorAll('.forecast-legend').forEach((el) => {
    el.style.display = display;
  });
}

export function setupForecastToggle() {
  const seg = document.getElementById('graph-forecast-seg');
  if (!seg) return;
  const btns = Array.from(seg.querySelectorAll('.forecast-seg-btn'));
  if (btns.length === 0) return;

  // The active mode: 'off' when the overlay is hidden, otherwise the
  // chosen engine ('ml' / 'physics').
  const selected = () => (showForecast ? getForecastEngine() : 'off');

  const render = () => {
    const sel = selected();
    for (const b of btns) {
      const on = b.dataset.mode === sel;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    applyForecastLegendVisibility();
  };

  const choose = (mode) => {
    if (mode === selected()) return;
    if (mode === 'off') {
      setShowForecast(false);
    } else {
      // setForecastEngine notifies listeners — the forecast card
      // re-fetches with the new engine and refreshes forecastData.
      setForecastEngine(mode);
      setShowForecast(true);
    }
    // Snap the visible window back to the new default so the change is
    // revealed immediately; otherwise a previously-set chartZoom would
    // mask it.
    resetChartZoom();
    render();
    drawHistoryGraph();
  };

  for (const b of btns) {
    b.addEventListener('click', () => choose(b.dataset.mode));
  }
  seg.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    let idx = btns.findIndex((b) => b.dataset.mode === selected());
    idx = e.key === 'ArrowLeft'
      ? (idx - 1 + btns.length) % btns.length
      : (idx + 1) % btns.length;
    btns[idx].focus();
    choose(btns[idx].dataset.mode);
  });

  // Stay in sync when the engine is switched from the device-view
  // Forecast-preview selector.
  onForecastEngineChange(render);

  render();
}
