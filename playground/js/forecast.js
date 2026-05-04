// Next-48-h forecast card on the Status view.
//
// The card itself shows three numerical tiles (Tank lasts / Backup heat /
// Backup cost) and up to three narrative notes. The actual time-series
// data — projected tank, greenhouse and emergency-heating bands — is
// pushed into shared state (setForecastData) and rendered as an overlay
// on the main history graph when the user toggles "Forecast" on. This
// keeps the card focused on the headline numbers and avoids two
// competing graph surfaces.
//
// External API:
//   initForecastCard()  — called from the app init path; registers the sync
//     source and inserts the card DOM above the energy-balance card.
//   renderForecastCard(data)  — exported for testability; mutates the existing
//     card DOM with a fresh API response.

import { store } from './app-state.js';
import { registerDataSource } from './sync/registry.js';
import { setForecastData } from './main/state.js';
import { drawHistoryGraph } from './main/history-graph.js';

// ── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// ── Number formatters ────────────────────────────────────────────────────────

function fmtHours(h) {
  if (h === null || h === undefined) return '48+ h';
  const rounded = Math.round(h * 2) / 2; // round to 0.5
  return '~' + rounded + ' h';
}

function fmtKwh(v) {
  if (v === null || v === undefined || typeof v !== 'number') return '— kWh';
  return (Math.round(v * 10) / 10).toFixed(1) + ' kWh';
}

function fmtEur(v) {
  if (v === null || v === undefined || typeof v !== 'number') return '—';
  return '€' + v.toFixed(2);
}

// ── Card DOM structure ───────────────────────────────────────────────────────

function createCardDom() {
  const card = el('div', 'card bento-span-3 forecast-card');
  card.id = 'forecast-card';

  // Header row
  const header = el('div', 'forecast-card-header');
  const title = el('h3', 'forecast-title', 'Next 48 h');
  header.appendChild(title);
  card.appendChild(header);

  // Headline stats
  const stats = el('div', 'forecast-stats');
  stats.id = 'forecast-stats';

  const s1 = el('div', 'forecast-stat');
  s1.innerHTML = '<span class="forecast-stat-label">Tank lasts</span>' +
    '<div class="forecast-stat-value" id="forecast-val-hours">—</div>';
  const s2 = el('div', 'forecast-stat');
  s2.innerHTML = '<span class="forecast-stat-label">Backup heat</span>' +
    '<div class="forecast-stat-value" id="forecast-val-kwh">—</div>';
  const s3 = el('div', 'forecast-stat');
  s3.innerHTML = '<span class="forecast-stat-label">Backup cost</span>' +
    '<div class="forecast-stat-value" id="forecast-val-eur">—</div>';
  stats.appendChild(s1);
  stats.appendChild(s2);
  stats.appendChild(s3);
  card.appendChild(stats);

  // Notes (narrative summary + occasional warning)
  const notes = el('div', 'forecast-notes');
  notes.id = 'forecast-notes';
  card.appendChild(notes);

  // Status line — loading / error / hint to use the chart toggle.
  // Single-line, low-visual-weight; lives where the old "tap to expand"
  // button used to so the layout doesn't shift.
  const status = el('div', 'forecast-status');
  status.id = 'forecast-status';
  card.appendChild(status);

  return card;
}

// ── Public render ────────────────────────────────────────────────────────────

export function renderForecastCard(data) {
  const card = document.getElementById('forecast-card');
  if (!card) return;

  const fc = (data && data.forecast) ? data.forecast : null;

  // Headline values
  const elHours = document.getElementById('forecast-val-hours');
  const elKwh   = document.getElementById('forecast-val-kwh');
  const elEur   = document.getElementById('forecast-val-eur');

  // "Tank lasts" = hours until the device's space-heater backup turns on.
  // That's hoursUntilBackupNeeded (when greenhouse cools below ehE in the
  // model). When it's null, the tank covers the entire 48 h window with no
  // backup — show "48+ h". We deliberately do NOT fall back to the tank-
  // floor crossing, because the floor isn't an actionable event for the
  // user (the controller doesn't actually flip a heater at 12 °C — backup
  // is gh-driven). The floor crossing, if any, ends up in the notes.
  const lastsH = fc ? fc.hoursUntilBackupNeeded : null;
  if (elHours) elHours.textContent = fc ? fmtHours(lastsH) : '—';
  if (elKwh)   elKwh.textContent   = fc ? fmtKwh(fc.electricKwh)       : '—';
  if (elEur)   elEur.textContent   = fc ? fmtEur(fc.electricCostEur)   : '—';

  // Notes — low-confidence warning + notes array
  const notesEl = document.getElementById('forecast-notes');
  if (notesEl) {
    notesEl.innerHTML = '';
    if (fc) {
      if (fc.modelConfidence === 'low') {
        const warn = el('p', 'forecast-note forecast-note-warn',
          '⚠ Forecast model still warming up — limited history.');
        notesEl.appendChild(warn);
      }
      const arr = Array.isArray(fc.notes) ? fc.notes : [];
      for (const note of arr) {
        const p = el('p', 'forecast-note', note);
        notesEl.appendChild(p);
      }
    }
  }

  // Status: hint pointing at the chart toggle.
  const status = document.getElementById('forecast-status');
  if (status) {
    status.textContent = fc
      ? 'Toggle "Forecast" above the chart to overlay the next 12 h.'
      : '';
  }

  // Push the data into shared state so the history graph can render it
  // when the user has the Forecast toggle on. drawHistoryGraph re-renders
  // immediately (cheap canvas redraw) — no-op when the toggle is off
  // because the overlay branch is gated by showForecast.
  setForecastData(data || null);
  drawHistoryGraph();

  // Clear any loading/error state
  card.classList.remove('forecast-card-error', 'forecast-card-loading');
}

function _showLoading() {
  const card = document.getElementById('forecast-card');
  if (!card) return;
  card.classList.add('forecast-card-loading');
  card.classList.remove('forecast-card-error');
  const elHours = document.getElementById('forecast-val-hours');
  const elKwh   = document.getElementById('forecast-val-kwh');
  const elEur   = document.getElementById('forecast-val-eur');
  if (elHours) elHours.textContent = '—';
  if (elKwh)   elKwh.textContent   = '—';
  if (elEur)   elEur.textContent   = '—';
  const notes = document.getElementById('forecast-notes');
  if (notes) notes.innerHTML = '';
  const status = document.getElementById('forecast-status');
  if (status) status.textContent = 'Loading next-48 h forecast…';
}

function _showError() {
  const card = document.getElementById('forecast-card');
  if (!card) return;
  card.classList.add('forecast-card-error');
  card.classList.remove('forecast-card-loading');
  const status = document.getElementById('forecast-status');
  if (status) {
    status.innerHTML = '';
    const msg = el('span', 'forecast-error-text', 'Forecast unavailable.');
    const retryBtn = el('button', 'forecast-retry-btn', 'Retry');
    retryBtn.id = 'forecast-retry-btn';
    retryBtn.setAttribute('type', 'button');
    retryBtn.addEventListener('click', function () { _doFetch(); });
    status.appendChild(msg);
    status.appendChild(retryBtn);
  }
}

// ── Fetch ────────────────────────────────────────────────────────────────────

function _doFetch(signal) {
  _showLoading();
  return fetch('/api/forecast', signal ? { signal } : {})
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) {
      renderForecastCard(data);
      return data;
    })
    .catch(function (err) {
      if (err && err.name === 'AbortError') return;
      _showError();
    });
}

// ── Init ─────────────────────────────────────────────────────────────────────

export function initForecastCard() {
  // Insert card above the balance card (or as the last card in .bento-grid
  // if the balance card is absent). The balance-card is the last child of
  // the .bento-grid inside #view-status.
  const bentoGrid = document.querySelector('#view-status .bento-grid');
  if (!bentoGrid) return;

  // Don't double-insert
  if (document.getElementById('forecast-card')) return;

  const card = createCardDom();

  const balanceCard = document.getElementById('balance-card');
  if (balanceCard) {
    bentoGrid.insertBefore(card, balanceCard);
  } else {
    bentoGrid.appendChild(card);
  }

  // Register with the sync coordinator so the card refreshes on Android
  // resume, network recovery, and tab focus — just like the balance card.
  registerDataSource({
    id: 'forecast',
    isActive: function () { return store.get('phase') === 'live'; },
    fetch: function (signal) {
      return fetch('/api/forecast', { signal }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    },
    applyToStore: function (data) {
      renderForecastCard(data);
    },
  });

  // Initial fetch when entering live mode — the sync coordinator will
  // drive subsequent refreshes, but we want data on first paint.
  store.subscribe('phase', function () {
    if (store.get('phase') === 'live') {
      _doFetch();
    }
  });
}
