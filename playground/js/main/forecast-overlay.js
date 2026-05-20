// Forecast overlay rendering for the main history graph.
//
// Extracted from history-graph.js to keep that file under the 600-line
// hard cap. Pure-side-effect: drawForecastOverlay/drawForecastModeBars
// take a ctx + the engine's forecast payload and paint dashed
// trajectories + predicted mode bars + a "now" divider line. No state,
// no DOM lookups beyond what's passed in.

import { pickBucketSize } from '../ui.js';
import { drawEmergencyStripes } from './emergency-stripes.js';
import { hiddenSeries } from './state.js';

// Forecast overlay rendering: tank avg + greenhouse + outdoor trajectories
// (dashed) past "now", predicted mode bands (charging/heating/emergency)
// past "now", and a vertical "now" divider line. All clipped to
// [now, cutoffSec] AND the visible chart window.
export function drawForecastOverlay(ctx, data, nowSec, cutoffSec, tMin, tMax, visibleRange, barAreaH, barY0, pad, pw, ph, yMin, yMax) {
  const fc = data && data.forecast;
  if (!fc) return;

  // Trajectory points come from the engine as ISO strings (`ts` for
  // engine output, `validAt` for the raw weather array). Convert to
  // seconds and clip to [nowSec, cutoffSec] AND the chart window.
  // When the visible window falls between two forecast samples, the
  // trailing edge gets a synthesized interpolated point at tMax so
  // the line reaches the right edge of the chart instead of stopping
  // at the last in-window sample (which can be visibly far short of
  // the edge in zoomed-in views — e.g. 24h-range with forecast on
  // shows hourly samples but the 1h granularity puts the last
  // sample well before tMax).
  function toPts(traj, valOf, tsKey) {
    if (!Array.isArray(traj)) return [];
    const key = tsKey || 'ts';
    const pts = [];
    let lastT = null, lastV = null;
    for (let i = 0; i < traj.length; i++) {
      const t = Math.floor(new Date(traj[i][key]).getTime() / 1000);
      if (t < nowSec || t > cutoffSec) continue;
      const v = valOf(traj[i]);
      if (typeof v !== 'number' || !isFinite(v)) continue;
      if (t < tMin) { lastT = t; lastV = v; continue; }
      if (t > tMax) {
        // First post-window sample — interpolate to tMax and stop.
        if (lastT !== null) {
          const frac = (tMax - lastT) / (t - lastT);
          const vAtMax = lastV + (v - lastV) * frac;
          pts.push({
            x: pad.left + ((tMax - tMin) / visibleRange) * pw,
            y: pad.top + ph - ((vAtMax - yMin) / (yMax - yMin)) * ph,
          });
        }
        return pts;
      }
      pts.push({
        x: pad.left + ((t - tMin) / visibleRange) * pw,
        y: pad.top + ph - ((v - yMin) / (yMax - yMin)) * ph,
      });
      lastT = t; lastV = v;
    }
    return pts;
  }

  function drawDashed(pts, color, lineWidth) {
    if (pts.length < 2) return;
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash([4, 3]);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.restore();
  }

  // Tank avg + greenhouse + outdoor — match historical line colours, dashed.
  // Outdoor lives in the raw weather array (top-level of the response,
  // alongside `forecast`), not in the engine's projection — the engine
  // consumes it as an input to compute tank/greenhouse cooling.
  if (!hiddenSeries.has('forecast_tank'))       drawDashed(toPts(fc.tankTrajectory, p => (typeof p.avg === 'number' ? p.avg : (p.top + p.bottom) / 2)), '#e9c349', 1.5);
  if (!hiddenSeries.has('forecast_greenhouse')) drawDashed(toPts(fc.greenhouseTrajectory, p => p.temp), '#69d0c5', 1.5);
  if (!hiddenSeries.has('forecast_outdoor'))    drawDashed(toPts(data.weather, p => p.temperature, 'validAt'), '#42a5f5', 1);

  // Predicted mode bands (charging / heating / emergency) past "now",
  // bucketed at the same bucketSec as the historical duty bars on the
  // left so x-width and y-fractions visually line up across the now
  // divider.
  if (Array.isArray(fc.modeForecast) && fc.modeForecast.length > 0) {
    drawForecastModeBars(ctx, fc.modeForecast, nowSec, cutoffSec, tMin, tMax, visibleRange, barAreaH, barY0, pad, pw);
  }

  // "Now" divider — only draw when nowSec is inside the visible window.
  if (nowSec >= tMin && nowSec <= tMax) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    const x = pad.left + ((nowSec - tMin) / visibleRange) * pw;
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + ph);
    ctx.stroke();
    ctx.restore();
  }
}

// Pure: aggregate the modeForecast entries into bucket totals for
// [segStart, segEnd). Each entry is the mode active from its own
// timestamp until the next entry's — derived here rather than assumed,
// so this works for both the hourly physics engine and the ML engine's
// multi-resolution output (5-min near-term entries, 1-h tail). The last
// entry has no successor and falls back to a 1-h span. A bucket smaller
// than an entry's span gets its overlap fraction rather than the whole
// span, which is what keeps sub-hour zoom levels from rendering empty
// every-other bucket.
//
// Emergency entries carry an optional `duty` (0..1). The aggregator
// returns BOTH `emergencyHours` (duty-scaled — used for kWh/cost
// accounting in the inspector) AND `emergencyPresenceHours` (full
// overlap whenever mode='emergency_heating', regardless of duty —
// used for bar visibility). Pre-split, a duty=0 emergency hour
// vanished from the chart entirely; the bar now reflects "the engine
// predicts the heater mode is on" even when the physics duty formula
// happens to compute 0.
export function aggregateForecastBucket(modeForecast, segStart, segEnd) {
  const HOUR_SEC = 3600;
  let chargingHours = 0, heatingHours = 0, emergencyHours = 0, emergencyPresenceHours = 0;
  for (let i = 0; i < modeForecast.length; i++) {
    const e = modeForecast[i];
    const t = Math.floor(new Date(e.ts).getTime() / 1000);
    // Entry span runs to the next distinct timestamp (entries are
    // time-ordered; some engines emit a solar overlay sharing a ts).
    let eEnd = t + HOUR_SEC;
    for (let j = i + 1; j < modeForecast.length; j++) {
      const tj = Math.floor(new Date(modeForecast[j].ts).getTime() / 1000);
      if (tj > t) { eEnd = tj; break; }
    }
    const overlap = Math.max(0, Math.min(eEnd, segEnd) - Math.max(t, segStart));
    if (overlap <= 0) continue;
    const oh = overlap / HOUR_SEC;
    if (e.mode === 'solar_charging')          chargingHours += oh;
    else if (e.mode === 'greenhouse_heating') heatingHours  += oh;
    else if (e.mode === 'emergency_heating') {
      const duty = typeof e.duty === 'number' ? e.duty : 1;
      emergencyHours += duty * oh;
      emergencyPresenceHours += oh;
    }
  }
  return { chargingHours, heatingHours, emergencyHours, emergencyPresenceHours };
}

// Render predicted mode bars past "now" using the same x-bucketing AND
// fractional y-heights as the historical duty bars. Bars stack
// charging (red, bottom), heating (gold, middle), emergency (orange,
// top) — matching the historical stack order, with slightly dimmer
// alphas so the eye reads "projection".
function drawForecastModeBars(ctx, modeForecast, nowSec, cutoffSec, tMin, tMax, visibleRange, barAreaH, barY0, pad, pw) {
  const bucketSec = pickBucketSize(visibleRange);
  // Align bucket boundaries the same way dutyBucketsIn does so the right-
  // edge of the last historical bucket and the left-edge of the first
  // forecast bucket meet at the same hourly tick.
  const firstBucket = Math.floor(nowSec / bucketSec);
  const lastBucket  = Math.ceil(cutoffSec / bucketSec);
  const HOURS = 3600;

  ctx.save();
  for (let bi = firstBucket; bi < lastBucket; bi++) {
    const hrStart = bi * bucketSec;
    const hrEnd   = (bi + 1) * bucketSec;
    if (hrEnd <= tMin || hrStart >= tMax) continue;
    if (hrEnd <= nowSec) continue;
    if (hrStart >= cutoffSec) continue;
    const segStart = Math.max(hrStart, nowSec);
    const segEnd   = Math.min(hrEnd, cutoffSec);
    if (segEnd <= segStart) continue;

    const { chargingHours, heatingHours, emergencyPresenceHours } =
      aggregateForecastBucket(modeForecast, segStart, segEnd);
    // Per-bucket fraction = hours-on / hours-in-the-post-now slice of this
    // bucket. For the partial bucket straddling "now" we measure against
    // segLen (not bucketSec) — otherwise a single predicted hour in a 25-
    // min visible slice would compute as 1/3 even though the system is on
    // for 100% of what we're showing.
    const segLen      = segEnd - segStart;
    const segHours    = Math.max(1 / 60, segLen / HOURS); // avoid div-by-0
    const chargingFrac  = Math.min(1, chargingHours  / segHours);
    const heatingFrac   = Math.min(1, heatingHours   / segHours);
    // Emergency bar height tracks mode PRESENCE — duty-scaled bars
    // would disappear whenever the radiator already covers the loss
    // even though the engine still ran the heater mode. Cost/kWh
    // accounting still uses the duty-scaled emergencyHours field.
    const emergencyFrac = Math.min(1, emergencyPresenceHours / segHours);
    if (chargingFrac + heatingFrac + emergencyFrac === 0) continue;

    // Render using segStart..segEnd (post-now slice), not the full clock-
    // aligned bucket. The first forecast bar starts exactly at the "now"
    // divider; subsequent buckets render at full bucketSec width.
    const barX = pad.left + ((segStart - tMin) / visibleRange) * pw;
    const barW = Math.max(1, ((segEnd - segStart) / visibleRange) * pw - 2);
    let stackH = 0;

    if (chargingFrac > 0 && !hiddenSeries.has('forecast_charging')) {
      const bh = chargingFrac * barAreaH;
      ctx.fillStyle = 'rgba(238, 125, 119, 0.45)';
      ctx.fillRect(barX, barY0 - bh, barW, bh);
      stackH += bh;
    }
    if (heatingFrac > 0 && !hiddenSeries.has('forecast_heating')) {
      const bh = heatingFrac * barAreaH;
      ctx.fillStyle = 'rgba(233, 195, 73, 0.45)';
      ctx.fillRect(barX, barY0 - stackH - bh, barW, bh);
    }
    if (emergencyFrac > 0 && !hiddenSeries.has('forecast_emergency')) {
      const bh = emergencyFrac * barAreaH;
      // Mirror the historical band: anchor at baseline so the stripes
      // overlay the underlying charging/heating bar at the same X.
      drawEmergencyStripes(ctx, barX, barY0 - bh, barW, bh, 'rgba(255, 112, 67, 0.7)');
    }
  }
  ctx.restore();
}
