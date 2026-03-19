/**
 * Canvas-based time series chart for temperature history and valve state bands.
 */

export class TimeSeriesStore {
  /**
   * @param {number} maxAge - Maximum data age in milliseconds
   * @param {string[]} series - Line series names (temperatures)
   * @param {string[]} [bandSeries] - Band series names (valve states, 0/1)
   */
  constructor(maxAge, series, bandSeries = []) {
    this.maxAge = maxAge;
    this.seriesNames = series;
    this.bandSeriesNames = bandSeries;
    this.data = []; // [{time: Date, values: {name: number|null, ...}}]
  }

  add(values) {
    const now = new Date();
    this.data.push({ time: now, values: { ...values } });
    this.prune();
  }

  prune() {
    const cutoff = Date.now() - this.maxAge;
    while (this.data.length > 0 && this.data[0].time.getTime() < cutoff) {
      this.data.shift();
    }
  }

  /** Range calculation only considers line series, not bands. */
  getRange() {
    if (this.data.length === 0) return { minT: 0, maxT: 0, minV: 0, maxV: 30 };
    let minV = Infinity, maxV = -Infinity;
    for (const pt of this.data) {
      for (const name of this.seriesNames) {
        const v = pt.values[name];
        if (v !== null && v !== undefined) {
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
      }
    }
    if (!isFinite(minV)) { minV = 0; maxV = 30; }
    // Add padding
    const pad = Math.max(2, (maxV - minV) * 0.1);
    return {
      minT: this.data[0].time.getTime(),
      maxT: this.data[this.data.length - 1].time.getTime(),
      minV: Math.floor(minV - pad),
      maxV: Math.ceil(maxV + pad),
    };
  }
}

const SERIES_COLORS = [
  '#0056b2', // deep blue
  '#e53935', // red
  '#4caf50', // green
  '#ff9800', // orange
  '#9c27b0', // purple
];

const BAND_COLORS = [
  { on: '#4caf50', off: '#e8e8e8', label: '#64748b' }, // V1 green
  { on: '#ff9800', off: '#e8e8e8', label: '#64748b' }, // V2 orange
  { on: 'rgba(255, 152, 0, 0.35)', off: 'transparent', label: '#94a3b8' }, // V1 cooldown amber
  { on: 'rgba(255, 152, 0, 0.35)', off: 'transparent', label: '#94a3b8' }, // V2 cooldown amber
];

const BAND_HEIGHT = 14;
const BAND_HEIGHT_SMALL = 6;
const BAND_GAP = 3;
const BAND_GAP_TIGHT = 1;
const BAND_LABEL_WIDTH = 50;

/**
 * Draw the time series chart on a canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {TimeSeriesStore} store
 * @param {object} opts - { windowMs, seriesColors }
 */
export function drawChart(canvas, store, opts = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;

  // Calculate band area height — cooldown bands (index 2+) are small and tight
  const bandCount = store.bandSeriesNames.length;
  let bandAreaH = 0;
  if (bandCount > 0) {
    bandAreaH = 6;
    for (let bi = 0; bi < bandCount; bi++) {
      const isCooldown = bi >= 2;
      bandAreaH += (isCooldown ? BAND_HEIGHT_SMALL : BAND_HEIGHT);
      bandAreaH += (isCooldown ? BAND_GAP_TIGHT : BAND_GAP);
    }
  }

  const pad = { top: 16, right: 16, bottom: 32 + bandAreaH, left: 50 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  // Clear
  ctx.clearRect(0, 0, w, h);

  // Time window
  const windowMs = opts.windowMs || store.maxAge;
  const now = Date.now();
  const tMin = now - windowMs;
  const tMax = now;

  // Value range
  const range = store.getRange();
  const vMin = range.minV;
  const vMax = range.maxV;

  // Helpers
  const mapX = t => pad.left + ((t - tMin) / (tMax - tMin)) * plotW;
  const mapY = v => pad.top + (1 - (v - vMin) / (vMax - vMin)) * plotH;

  // Grid lines (horizontal)
  ctx.strokeStyle = '#e2e6ea';
  ctx.lineWidth = 1;
  ctx.font = '11px -apple-system, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  const vStep = niceStep(vMin, vMax, 6);
  for (let v = Math.ceil(vMin / vStep) * vStep; v <= vMax; v += vStep) {
    const y = mapY(v);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    ctx.fillText(v.toFixed(0) + '\u00B0', pad.left - 6, y);
  }

  // Grid lines (vertical - time)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const tStep = niceTimeStep(windowMs);
  const tStart = Math.ceil(tMin / tStep) * tStep;
  for (let t = tStart; t <= tMax; t += tStep) {
    const x = mapX(t);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, h - pad.bottom);
    ctx.stroke();
    ctx.fillText(formatTime(new Date(t)), x, h - pad.bottom + bandAreaH + 4);
  }

  // Plot area border
  ctx.strokeStyle = '#e2e6ea';
  ctx.strokeRect(pad.left, pad.top, plotW, plotH);

  // Draw temperature series
  const colors = opts.seriesColors || SERIES_COLORS;
  store.seriesNames.forEach((name, si) => {
    const color = colors[si % colors.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;

    for (const pt of store.data) {
      const v = pt.values[name];
      if (v === null || v === undefined) {
        started = false;
        continue;
      }
      const x = mapX(pt.time.getTime());
      const y = mapY(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  });

  // Draw valve state bands below the temperature plot
  if (bandCount > 0) {
    const bandTop = pad.top + plotH + 6;

    let bandYOffset = 0;
    store.bandSeriesNames.forEach((name, bi) => {
      const isCooldown = bi >= 2;
      const bh = isCooldown ? BAND_HEIGHT_SMALL : BAND_HEIGHT;
      const gap = isCooldown ? BAND_GAP_TIGHT : BAND_GAP;
      const bandY = bandTop + bandYOffset;
      bandYOffset += bh + gap;
      const bc = BAND_COLORS[bi % BAND_COLORS.length];

      // Band label
      ctx.fillStyle = bc.label;
      ctx.font = (isCooldown ? '8' : '10') + 'px -apple-system, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, pad.left - 6, bandY + bh / 2);

      // Draw background strip (skip for transparent backgrounds)
      if (bc.off !== 'transparent') {
        ctx.fillStyle = bc.off;
        ctx.fillRect(pad.left, bandY, plotW, bh);
      }

      // Draw "on" segments
      if (store.data.length > 0) {
        ctx.fillStyle = bc.on;
        let segStart = null;

        for (let i = 0; i < store.data.length; i++) {
          const pt = store.data[i];
          const t = pt.time.getTime();
          if (t < tMin) continue;
          if (t > tMax) break;

          const val = pt.values[name];

          if (val === 1 || val === true) {
            if (segStart === null) {
              segStart = t;
            }
          } else {
            if (segStart !== null) {
              const x1 = Math.max(mapX(segStart), pad.left);
              const x2 = Math.min(mapX(t), pad.left + plotW);
              if (x2 > x1) ctx.fillRect(x1, bandY, x2 - x1, bh);
              segStart = null;
            }
          }
        }
        // Close trailing on-segment
        if (segStart !== null) {
          const x1 = Math.max(mapX(segStart), pad.left);
          const x2 = pad.left + plotW;
          if (x2 > x1) ctx.fillRect(x1, bandY, x2 - x1, bh);
        }
      }

      // Band border (skip for cooldown bands)
      if (!isCooldown) {
        ctx.strokeStyle = '#d0d0d0';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(pad.left, bandY, plotW, bh);
      }
    });
  }

  // "No data" message
  if (store.data.length === 0) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '14px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Waiting for data...', w / 2, h / 2);
  }
}

function niceStep(min, max, targetTicks) {
  const range = max - min;
  if (range <= 0) return 5;
  const rough = range / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  let step;
  if (norm < 1.5) step = 1;
  else if (norm < 3.5) step = 2;
  else if (norm < 7.5) step = 5;
  else step = 10;
  return step * mag;
}

function niceTimeStep(windowMs) {
  const minute = 60000;
  const hour = 3600000;
  if (windowMs <= 10 * minute) return minute;
  if (windowMs <= 30 * minute) return 5 * minute;
  if (windowMs <= hour) return 10 * minute;
  if (windowMs <= 3 * hour) return 30 * minute;
  if (windowMs <= 8 * hour) return hour;
  return 2 * hour;
}

function formatTime(date) {
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}
