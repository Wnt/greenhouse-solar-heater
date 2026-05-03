// Today's balance card on the Status view. Extracted from main.js.
//
// External API:
//   initBalanceCard({ onRerender })
//     onRerender: callback invoked after the 48-hour history fetch
//       resolves, so the rest of the status view can re-render with
//       the freshly-loaded points without waiting for the next WS frame.
//   fetchBalanceHistory() — call when entering live mode.
//   appendBalanceLivePoint(state, result) — call from each WS frame.
//   renderBalanceCard() — re-render (also called internally).

import { store } from '../app-state.js';
import {
  computeEnergyBalance,
  editorialDaySentence,
  editorialNightSentence,
} from '../energy-balance.js';
import { helsinkiParts } from './time-format.js';
import { registerDataSource } from '../sync/registry.js';

const HELSINKI_TZ = 'Europe/Helsinki';
const fmtWindowClock = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: HELSINKI_TZ,
});
const fmtWindowDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', timeZone: HELSINKI_TZ,
});
// Helsinki date key "YYYY-MM-DD" used for same-day / yesterday checks
// against the user's wall clock rather than the browser's.
function helsinkiDateKey(tsMs) {
  const p = helsinkiParts(tsMs);
  return p.year + '-' + p.month + '-' + p.day;
}

// 48 h slice decoupled from the graph's 1H/6H/… pill so the numbers
// don't shrink when the user flips the range. balanceHistory holds
// the raw server response; balanceLivePoints is an incremental tail
// appended from live WS frames (rate-limited to one per 5 min,
// matching the DB aggregation cadence).
let balanceHistory = null;
let balanceLivePoints = [];
let balanceLiveEvents = [];
let balanceLiveLastMode = null;
let balanceLastAppendTs = 0;
const BALANCE_APPEND_MIN_INTERVAL_MS = 5 * 60 * 1000;

let _onRerender = () => {};

function isNum(v) { return typeof v === 'number' && !Number.isNaN(v); }

export function initBalanceCard({ onRerender } = {}) {
  if (typeof onRerender === 'function') _onRerender = onRerender;
}

// Drop the 48h snapshot + live-point buffer + mode tracker. Called
// when leaving live mode so a subsequent switch back re-fetches.
export function resetBalanceState() {
  balanceHistory = null;
  balanceLivePoints = [];
  balanceLiveEvents = [];
  balanceLiveLastMode = null;
  balanceLastAppendTs = 0;
}

// Fetcher: returns Promise<data>. AbortSignal honoured so the sync
// coordinator can cancel an in-flight request on overlapping resyncs.
function balanceHistoryFetch(signal) {
  return fetch('/api/history?range=48h', { signal }).then(r => r.json());
}

// Applier: idempotent write of the 48h snapshot into module state +
// re-render. Resets the live-tail buffers because the fresh history
// already covers everything they were tracking.
function applyBalanceHistory(data) {
  if (store.get('phase') !== 'live') return;
  balanceHistory = data;
  balanceLivePoints = [];
  balanceLiveEvents = [];
  balanceLiveLastMode = null;
  renderBalanceCard();
  // Balance fetch completes independently of the WS state stream;
  // re-render so the rest of the view picks up freshly-loaded points
  // without waiting for the next state frame.
  _onRerender();
}

export function fetchBalanceHistory() {
  if (store.get('phase') !== 'live') return;
  balanceHistoryFetch()
    .then(applyBalanceHistory)
    .catch(() => { balanceHistory = null; });
}

// Register the balance-history source with the sync coordinator so
// Android resume / network recovery / focus events refresh the
// 48h energy-balance card alongside the rest of the view.
export function registerBalanceHistorySource() {
  return registerDataSource({
    id: 'balance-history',
    isActive: () => store.get('phase') === 'live',
    fetch: (signal) => balanceHistoryFetch(signal),
    applyToStore: (data) => applyBalanceHistory(data),
  });
}

export function appendBalanceLivePoint(state, result) {
  if (store.get('phase') !== 'live') return;
  if (!isNum(state.t_tank_top) || !isNum(state.t_tank_bottom)) return;

  // Track mode changes as synthetic events so computeEnergyBalance
  // classifies recent deltas against the right mode (otherwise every
  // post-fetch sample would inherit the last historical mode).
  const currentMode = (result && result.mode) ? String(result.mode).toLowerCase() : null;
  if (currentMode && currentMode !== balanceLiveLastMode) {
    balanceLiveEvents.push({ ts: Date.now(), type: 'mode', to: currentMode });
    balanceLiveLastMode = currentMode;
  }

  const nowMs = Date.now();
  if (nowMs - balanceLastAppendTs < BALANCE_APPEND_MIN_INTERVAL_MS) return;
  balanceLastAppendTs = nowMs;
  balanceLivePoints.push({
    ts: nowMs,
    tank_top: state.t_tank_top,
    tank_bottom: state.t_tank_bottom,
  });
  renderBalanceCard();
}

function fmtBalanceKwh(v, { sign = false } = {}) {
  const rounded = Math.round(v * 10) / 10;
  if (sign) {
    if (rounded === 0) return '0.0';
    return (rounded > 0 ? '+' : '−') + Math.abs(rounded).toFixed(1);
  }
  return rounded.toFixed(1);
}

function fmtBalanceWindow(startTs, endTs, complete) {
  const nowMs = Date.now();
  const todayKey = helsinkiDateKey(nowMs);
  const yesterdayKey = helsinkiDateKey(nowMs - 24 * 3600 * 1000);
  const fmt = (ts) => {
    const key = helsinkiDateKey(ts);
    const hm = fmtWindowClock.format(new Date(ts));
    if (key === todayKey) return hm;
    if (key === yesterdayKey) return hm + ' yesterday';
    return hm + ' ' + fmtWindowDate.format(new Date(ts));
  };
  return fmt(startTs) + ' → ' + (complete ? fmt(endTs) : 'now');
}

function statHtml(label, kwh, { sign = false, extra = '' } = {}) {
  const val = fmtBalanceKwh(kwh, { sign });
  const cls = sign
    ? (kwh >= 0 ? ' positive' : ' negative')
    : '';
  const capHtml = extra ? '<span class="balance-stat-caption">' + extra + '</span>' : '';
  return '<div class="balance-stat">' +
    '<span class="balance-stat-label">' + label + '</span>' +
    '<div><span class="balance-stat-value' + cls + '">' + val + '</span>' +
    '<span class="balance-stat-unit">kWh</span></div>' +
    capHtml +
    '</div>';
}

function releasedStatHtml(heatingKwh, leakageKwh) {
  const total = heatingKwh + leakageKwh;
  const heating = heatingKwh >= 0.05;
  const leakage = leakageKwh >= 0.05;
  let caption;
  if (heating && leakage) {
    caption = fmtBalanceKwh(heatingKwh) + ' to greenhouse · ' +
      fmtBalanceKwh(leakageKwh) + ' to air';
  } else if (heating) {
    caption = 'to greenhouse';
  } else if (leakage) {
    caption = 'to air';
  } else {
    caption = '';
  }
  return '<div class="balance-stat">' +
    '<span class="balance-stat-label">Released</span>' +
    '<div><span class="balance-stat-value">−' + fmtBalanceKwh(total) + '</span>' +
    '<span class="balance-stat-unit">kWh</span></div>' +
    (caption ? '<span class="balance-stat-caption">' + caption + '</span>' : '') +
    '</div>';
}

function renderBalanceSection(section, window, sentence, stats) {
  if (!stats) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  section.querySelector('[id$="-window"]').textContent = window;
  section.querySelector('[id$="-sentence"]').textContent = sentence;
  section.querySelector('[id$="-stats"]').innerHTML = stats;
}

export function renderBalanceCard() {
  const card = document.getElementById('balance-card');
  if (!card) return;
  if (store.get('phase') !== 'live' || !balanceHistory) {
    card.style.display = 'none';
    return;
  }
  const points = (balanceHistory.points || []).concat(balanceLivePoints);
  const events = (balanceHistory.events || []).concat(balanceLiveEvents);
  if (points.length < 2) {
    card.style.display = 'none';
    return;
  }

  const balance = computeEnergyBalance(points, events, Date.now());
  if (!balance.night && !balance.day) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';

  // Night section
  const nightSec = document.getElementById('balance-night');
  if (balance.night) {
    const n = balance.night;
    const hasLoss = (n.heatingKwh + n.leakageKwh) >= 0.05;
    const stats = hasLoss
      ? releasedStatHtml(n.heatingKwh, n.leakageKwh)
      : statHtml('Net', n.netKwh, { sign: true });
    renderBalanceSection(
      nightSec,
      (n.complete ? 'Night · ' : 'Night so far · ') + fmtBalanceWindow(n.startTs, n.endTs, n.complete),
      editorialNightSentence(n),
      stats,
    );
  } else {
    nightSec.hidden = true;
  }

  // Day section
  const daySec = document.getElementById('balance-day');
  if (balance.day) {
    const d = balance.day;
    const stats = [
      statHtml('Gathered', d.gatheredKwh),
      releasedStatHtml(d.heatingKwh, d.leakageKwh),
      statHtml('Net today', d.netKwh, { sign: true }),
    ].join('');
    renderBalanceSection(
      daySec,
      (d.complete ? 'Day · ' : 'Day so far · ') + fmtBalanceWindow(d.startTs, d.endTs, d.complete),
      editorialDaySentence(d),
      stats,
    );
  } else {
    daySec.hidden = true;
  }
}
