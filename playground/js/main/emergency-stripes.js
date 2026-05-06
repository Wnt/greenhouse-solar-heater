// Diagonal-stripe fill for the EMERGENCY band on the duty-cycle bars.
// The band represents an OVERLAY (space heater on top of any pump mode)
// rather than a distinct mode of its own, so a hatch lets the
// underlying charging/heating bar stay visible — a solid fill used to
// read as a third stacked mode.
//
// Lives in its own module so both the historical bar renderer
// (history-graph.js) and the forecast bar renderer (forecast-overlay.js)
// can share it without creating an import cycle between them.

// 45° "/" stripes: each line satisfies x + y = k. Stepping k across the
// rectangle's diagonal extents covers the whole bar; clip() trims each
// line to the rect.
export function drawEmergencyStripes(ctx, x, y, w, h, color) {
  if (w <= 0 || h <= 0) return;
  const SPACING = 6;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'butt';
  const minK = x + y;
  const maxK = x + w + y + h;
  for (let k = Math.floor(minK / SPACING) * SPACING; k <= maxK; k += SPACING) {
    ctx.beginPath();
    ctx.moveTo(k - y, y);
    ctx.lineTo(k - (y + h), y + h);
    ctx.stroke();
  }
  ctx.restore();
}
