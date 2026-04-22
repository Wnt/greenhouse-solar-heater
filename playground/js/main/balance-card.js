// Today's balance card on the Status view. Extracted from main.js.
//
// External API:
//   initBalanceCard({ onRerender })
//     onRerender: callback invoked after the 48-hour history fetch
//       resolves, so the rest of the status view can pick up the
//       freshly-computed yesterdayHigh without waiting for the next
//       WS frame.
//   fetchBalanceHistory() — call when entering live mode.
//   appendBalanceLivePoint(state, result) — call from each WS frame.
//   renderBalanceCard() — re-render (also called internally).
//   getLiveYesterdayHigh() / resetLiveYesterdayHigh() — accessors the
//     display layer and mode-switch code use for the peak-temp label.

import { store } from '../app-state.js';
import {
  computeEnergyBalance,
  editorialDaySentence,
  editorialNightSentence,
} from '../energy-balance.js';

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

// Peak tank average across yesterday's local calendar day, computed
// from the 48h history fetch. null when no qualifying points.
let liveYesterdayHigh = null;

let _onRerender = () => {};

function isNum(v) { return typeof v === 'number' && !Number.isNaN(v); }

export function initBalanceCard({ onRerender } = {}) {
  if (typeof onRerender === 'function') _onRerender = onRerender;
}

export function getLiveYesterdayHigh() {
  return liveYesterdayHigh;
}

export function resetLiveYesterdayHigh() {
  liveYesterdayHigh = null;
}

export function fetchBalanceHistory() {
  if (store.get('phase') !== 'live') return;
  fetch('/api/history?range=48h')
    .then(r => r.json())
    .then(data => {
      if (store.get('phase') !== 'live') return;
      balanceHistory = data;
      balanceLivePoints = [];
      balanceLiveEvents = [];
      balanceLiveLastMode = null;
      liveYesterdayHigh = computeLiveYesterdayHigh(data && data.points);
      renderBalanceCard();
      // Balance fetch completes independently of the WS state stream,
      // so re-render so the peak label reflects the freshly-computed
      // yesterdayHigh instead of waiting for the next state frame.
      _onRerender();
    })
    .catch(() => { balanceHistory = null; });
}

// Peak tank average ((tank_top + tank_bottom) / 2) across points whose
// timestamps fall within yesterday's local calendar day. Matches what
// the graph's Tank line plots and the central tank gauge displays.
// Returns null when no qualifying points exist.
function computeLiveYesterdayHigh(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const now = new Date();
  const yStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const yEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let peak = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p || typeof p.ts !== 'number') continue;
    if (p.ts < yStart || p.ts >= yEnd) continue;
    if (!isNum(p.tank_top) || !isNum(p.tank_bottom)) continue;
    const avg = (p.tank_top + p.tank_bottom) / 2;
    if (peak === null || avg > peak) peak = avg;
  }
  return peak;
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
  const now = new Date();
  const fmt = (ts, refDate) => {
    const d = new Date(ts);
    const sameDay = d.toDateString() === refDate.toDateString();
    const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return hm;
    const yesterday = new Date(refDate);
    yesterday.setDate(refDate.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return hm + ' yesterday';
    return hm + ' ' + d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };
  return fmt(startTs, now) + ' → ' + (complete ? fmt(endTs, now) : 'now');
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
