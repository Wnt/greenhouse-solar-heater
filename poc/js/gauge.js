/**
 * SVG semicircular temperature gauge component.
 */

const GAUGE_DEFAULTS = {
  min: -20,
  max: 80,
  width: 220,
  height: 140,
  arcRadius: 85,
  arcWidth: 14,
  tickCount: 10,
};

/**
 * Color stops for the gauge arc gradient.
 * Maps normalized position (0-1) to color.
 */
const COLOR_STOPS = [
  { pos: 0,    color: '#42a5f5' },  // cold blue
  { pos: 0.25, color: '#4caf50' },  // cool green
  { pos: 0.5,  color: '#8bc34a' },  // warm green
  { pos: 0.7,  color: '#ff9800' },  // warm orange
  { pos: 1,    color: '#ef5350' },  // hot red
];

function lerpColor(stops, t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    if (t <= stops[i + 1].pos) {
      const range = stops[i + 1].pos - stops[i].pos;
      const local = (t - stops[i].pos) / range;
      return interpolateHex(stops[i].color, stops[i + 1].color, local);
    }
  }
  return stops[stops.length - 1].color;
}

function interpolateHex(c1, c2, t) {
  const r1 = parseInt(c1.slice(1, 3), 16), g1 = parseInt(c1.slice(3, 5), 16), b1 = parseInt(c1.slice(5, 7), 16);
  const r2 = parseInt(c2.slice(1, 3), 16), g2 = parseInt(c2.slice(3, 5), 16), b2 = parseInt(c2.slice(5, 7), 16);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r},${g},${b})`;
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

/**
 * Create or update an SVG gauge in a container element.
 * @param {HTMLElement} container - DOM element to render into
 * @param {object} opts - { value, min, max, label, unit }
 */
export function renderGauge(container, opts) {
  const { min, max, width, height, arcRadius, arcWidth } = { ...GAUGE_DEFAULTS, ...opts };
  const value = opts.value;
  const unit = opts.unit || '\u00B0C';

  const cx = width / 2;
  const cy = height - 10;
  const startAngle = 180;
  const endAngle = 360;

  // Normalized value position
  const clamped = Math.max(min, Math.min(max, value));
  const norm = (clamped - min) / (max - min);
  const valueAngle = startAngle + norm * (endAngle - startAngle);
  const valueColor = lerpColor(COLOR_STOPS, norm);

  // Build SVG
  const ns = 'http://www.w3.org/2000/svg';
  let svg = container.querySelector('svg.gauge-svg');
  if (!svg) {
    svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'gauge-svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    container.appendChild(svg);
  }

  // Build gradient arc segments
  let html = '';

  // Background arc (gray)
  html += `<path d="${describeArc(cx, cy, arcRadius, startAngle, endAngle)}"
    fill="none" stroke="#e2e6ea" stroke-width="${arcWidth}" stroke-linecap="round"/>`;

  // Colored arc segments (gradient effect)
  const segments = 40;
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    if (t1 > norm) break;
    const a0 = startAngle + t0 * (endAngle - startAngle);
    const a1 = startAngle + t1 * (endAngle - startAngle);
    const color = lerpColor(COLOR_STOPS, (t0 + t1) / 2);
    html += `<path d="${describeArc(cx, cy, arcRadius, a0, a1 + 0.5)}"
      fill="none" stroke="${color}" stroke-width="${arcWidth}" stroke-linecap="butt"/>`;
  }

  // Tick marks and labels
  const tickCount = opts.tickCount || GAUGE_DEFAULTS.tickCount;
  for (let i = 0; i <= tickCount; i++) {
    const t = i / tickCount;
    const angle = startAngle + t * (endAngle - startAngle);
    const innerR = arcRadius - arcWidth / 2 - 4;
    const outerR = arcRadius - arcWidth / 2 - 10;
    const p1 = polarToCartesian(cx, cy, innerR, angle);
    const p2 = polarToCartesian(cx, cy, outerR, angle);
    html += `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"
      stroke="#94a3b8" stroke-width="1"/>`;

    // Label
    const labelR = arcRadius - arcWidth / 2 - 20;
    const lp = polarToCartesian(cx, cy, labelR, angle);
    const tempVal = min + t * (max - min);
    html += `<text x="${lp.x}" y="${lp.y}" text-anchor="middle"
      dominant-baseline="middle" fill="#94a3b8" font-size="9"
      font-family="-apple-system, sans-serif">${Math.round(tempVal)}</text>`;
  }

  // Needle
  const needleLen = arcRadius - arcWidth / 2 - 6;
  const needleTip = polarToCartesian(cx, cy, needleLen, valueAngle);
  const needleBase1 = polarToCartesian(cx, cy, 4, valueAngle - 90);
  const needleBase2 = polarToCartesian(cx, cy, 4, valueAngle + 90);
  html += `<polygon points="${needleTip.x},${needleTip.y} ${needleBase1.x},${needleBase1.y} ${needleBase2.x},${needleBase2.y}"
    fill="${valueColor}"/>`;
  html += `<circle cx="${cx}" cy="${cy}" r="5" fill="${valueColor}"/>`;

  // Value text
  const displayValue = value !== null && value !== undefined ? value.toFixed(1) : '--.-';
  html += `<text x="${cx}" y="${cy - 22}" text-anchor="middle"
    fill="${value !== null ? valueColor : '#94a3b8'}" font-size="28" font-weight="700"
    font-family="-apple-system, sans-serif">${displayValue}</text>`;
  html += `<text x="${cx}" y="${cy - 8}" text-anchor="middle"
    fill="#94a3b8" font-size="12"
    font-family="-apple-system, sans-serif">${unit}</text>`;

  svg.innerHTML = html;
}

/**
 * Render a "no data" gauge placeholder.
 */
export function renderGaugeNoData(container, opts = {}) {
  renderGauge(container, { ...opts, value: null, min: -20, max: 80 });
}
