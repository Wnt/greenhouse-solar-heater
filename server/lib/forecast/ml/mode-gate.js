'use strict';

// Mode-schedule promotion guard (findings-doc rec #3, gate half).
//
// The temperature gate in ml-trainer.js (R2 floors + RMSE regression
// guard) only sees point-temperature error, but the operational output
// of the ML engine is the 48 h MODE SCHEDULE — and the measured
// evidence (design/docs/ml-mode-forecast-findings.md) showed the two
// move independently: hourly dominant-mode accuracy of the deployed
// schedule was 63–71 % beyond 4 h against a 71 % hour-of-day
// climatology, while the temperature metrics looked healthy. This
// guard replays K forecast episodes from the training window's
// held-out tail (the same fresh-subset concept the RMSE regression
// guard uses) with the candidate and the serving forests, scores both
// schedules with the shared mode-metrics helpers against the logged
// mode transitions, and refuses promotion when the candidate's overall
// dominant-mode accuracy is more than MODE_ACCURACY_MARGIN below the
// serving model's on the SAME episodes. No new absolute floors — a
// candidate only has to not regress the schedule.
//
// Weather caveat: the trainer's injected getForecastDataset surface
// returns the latest fetch per valid hour (DISTINCT ON (valid_at) …
// fetched_at DESC in forecast-dataset.js), so an as-of-episode-start
// weather snapshot is not reconstructable here. Both rollouts therefore
// see nowcast-quality weather, which makes the measured accuracies
// optimistic in ABSOLUTE terms but unbiased BETWEEN the two models —
// both see identical inputs. This is a relative guard, not an absolute
// accuracy claim.
//
// Like the fresh-subset guard, missing data must never block promotion:
// with too few reconstructable episodes or too little mode-event ground
// truth the guard SKIPS (pass=true, skipped=true, reason for the log).

const { computeMlForecast } = require('./ml-forecast');
const modeMetrics = require('../mode-metrics');

const HOUR_MS = 3600 * 1000;
const HORIZON_HOURS = 48;
// One episode start every 6 h across the fresh window. The fresh window
// begins at max(test-split start, serving.trainedAt), and with HEALTHY
// DAILY promotions serving.trainedAt is only ~24 h old at gate time —
// 12 h spacing yielded 2-3 starts there, so the guard skipped on every
// routine run and only came alive after promotions had already stalled
// ~1.5 days (PR #283 review: exactly not the threat it exists for). At
// 6 h spacing a ~19 h fresh window fits MIN_EPISODES starts; the 48 h
// episodes overlap heavily either way and the replay cost is tens of
// ms, so the extra density is free. MAX_EPISODES still bounds long
// windows while spanning day AND night starts.
const EPISODE_SPACING_MS = 6 * HOUR_MS;
const MAX_EPISODES = 10;
// Below this the accuracy comparison is episode-lottery noise — skip.
const MIN_EPISODES = 4;
// Minimum joined (prediction hour × covered hour) samples across all
// episodes — roughly one day of hourly ground truth. Below it a couple
// of odd hours swing the accuracy by whole percentage points.
const MIN_MODE_SAMPLES = 24;
// Reject when the candidate is more than 3 pp worse (findings rec #3).
// STRICTLY greater: a candidate exactly 3.0 pp worse is still promoted;
// the comparison below is `>`, not `>=`.
const MODE_ACCURACY_MARGIN = 0.03;
// An episode needs a sensor reading near its start for the initial
// state — same 8-min sensor-gap rule as dataset.js MAX_GAP_MS.
const INIT_MAX_GAP_MS = 8 * 60000;
// At least half the 48 h window must have real weather rows, or the
// episode is dropped (fill-forward covers isolated holes).
const MIN_WEATHER_ROWS = 24;
// The prediction-side twin of mode-metrics' ACTIVE_MIN_SEC (> 25 % of
// the hour): the rollout "predicts solar" for an hour when its
// occupancy fraction clears the same bar.
const SOLAR_OVERLAY_MIN_FRAC = 0.25;

function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return new Date(v).getTime();
}

// ── Episode reconstruction ───────────────────────────────────────────

// Sensor point nearest to `t` (within the gap rule) carrying finite
// initial-state temperatures. `points` is the trainer's pivoted history
// (sorted ascending by pivotReadings).
function nearestPoint(points, t) {
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const dist = Math.abs(p.ts - t);
    if (dist >= bestDist) { if (p.ts > t) break; continue; }
    if (Number.isFinite(p.tank_top) && Number.isFinite(p.tank_bottom)
      && Number.isFinite(p.greenhouse)) {
      best = p;
      bestDist = dist;
    }
  }
  return best && bestDist <= INIT_MAX_GAP_MS ? best : null;
}

// Controller mode at time `t` from the sorted transition list ('idle'
// before the first known transition — getEvents' leading-edge row makes
// that case rare in practice).
function modeAtTime(transitions, t) {
  let mode = 'idle';
  for (let i = 0; i < transitions.length; i++) {
    if (transitions[i].ts <= t) mode = transitions[i].mode; else break;
  }
  return mode;
}

// 48 hourly weather rows from `startMs`, filled forward across holes;
// null when fewer than MIN_WEATHER_ROWS real rows exist.
function weatherForEpisode(byHour, startMs) {
  const rows = [];
  let present = 0;
  let last = null;
  for (let h = 0; h < HORIZON_HOURS; h++) {
    const r = byHour[startMs + h * HOUR_MS];
    if (r) { present++; last = r; }
    rows.push(r || last);
  }
  if (present < MIN_WEATHER_ROWS) return null;
  let first = null;
  for (let i = 0; i < rows.length; i++) { if (rows[i]) { first = rows[i]; break; } }
  for (let i = 0; i < rows.length && !rows[i]; i++) rows[i] = first;
  return rows;
}

// Episode starts every EPISODE_SPACING_MS across [freshStartMs, endMs],
// HOUR-ALIGNED (mode-metrics joins predictions on exact hour starts, so
// a misaligned episode would silently score zero samples), keeping the
// freshest MAX_EPISODES. Exported for tests.
function buildEpisodes(opts) {
  const points = opts.points || [];
  const transitions = opts.transitions || [];
  const byHour = opts.weatherByHour || {};
  const starts = [];
  let start = Math.ceil(opts.freshStartMs / HOUR_MS) * HOUR_MS;
  for (; start + HOUR_MS <= opts.endMs; start += EPISODE_SPACING_MS) starts.push(start);
  const picked = starts.slice(Math.max(0, starts.length - MAX_EPISODES));

  const episodes = [];
  for (let i = 0; i < picked.length; i++) {
    const p = nearestPoint(points, picked[i]);
    if (!p) continue;
    const weather48h = weatherForEpisode(byHour, picked[i]);
    if (!weather48h) continue;
    episodes.push({
      startMs: picked[i],
      tankTop: p.tank_top,
      tankBottom: p.tank_bottom,
      greenhouseTemp: p.greenhouse,
      currentMode: modeAtTime(transitions, picked[i]),
      weather48h,
    });
  }
  return episodes;
}

// ── Rollout → hourly prediction rows ─────────────────────────────────

// One mode-metrics prediction row per forecast hour, from the rollout's
// additive modeFractions output (per-hour occupancy — the honest hourly
// summary; a row covers [forHour - 1 h, forHour), matching
// forecast_predictions semantics). Exported for tests.
function episodePredictions(forecast) {
  const out = [];
  const mf = (forecast && forecast.modeFractions) || [];
  for (let h = 0; h < mf.length; h++) {
    const entry = mf[h];
    const hourStart = Date.parse(entry.ts);
    if (!Number.isFinite(hourStart)) continue;
    let mode = 'idle';
    let best = 0;
    const fr = entry.fractions || {};
    const keys = Object.keys(fr);
    for (let i = 0; i < keys.length; i++) {
      if (fr[keys[i]] > best) { best = fr[keys[i]]; mode = keys[i]; }
    }
    out.push({
      forHour: hourStart + HOUR_MS,
      horizonH: h + 1,
      mode,
      hasSolarOverlay: (entry.solar || 0) > SOLAR_OVERLAY_MIN_FRAC,
    });
  }
  return out;
}

// ── Guard ────────────────────────────────────────────────────────────

// Strip the optional collector forest from BOTH sides: the candidate has
// none at gate time (it is only trained after promotion), so letting the
// serving model run the collector-driven solar rules while the candidate
// used the radiation-gate fallback would compare solar rules, not
// forests. featureRanges only feeds the confidence label, not modes.
function bareModel(m) {
  return { tank: m.tank, greenhouse: m.greenhouse, featureRanges: m.featureRanges };
}

function rolloutOpts(ep, model) {
  return {
    now: ep.startMs,
    tankTop: ep.tankTop,
    tankBottom: ep.tankBottom,
    greenhouseTemp: ep.greenhouseTemp,
    currentMode: ep.currentMode,
    emergencyRecentlyActive: ep.currentMode === 'emergency_heating',
    weather48h: ep.weather48h,
    // Prices only affect the cost outputs, never the schedule.
    prices48h: [],
    model,
    // Default thresholds on both sides — live tuning overrides are a
    // serving-time concern (ml-forecast-handler.js); identical config
    // keeps the comparison strictly about the forests.
  };
}

// Overall dominant-mode accuracy = total correct / total joined samples
// across all horizon buckets of a scoreSchedule result.
function overallAccuracy(score) {
  let n = 0;
  let correct = 0;
  const buckets = score.accuracyByHorizon;
  const keys = Object.keys(buckets);
  for (let i = 0; i < keys.length; i++) {
    n += buckets[keys[i]].n;
    correct += buckets[keys[i]].correct;
  }
  return n > 0 ? correct / n : NaN;
}

function round3(v) { return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null; }
function pct(v) { return (v * 100).toFixed(1) + '%'; }

/**
 * evaluateModeGuard(opts) → {
 *   pass, skipped, reason,
 *   candidateAccuracy, servingAccuracy, episodes, samples,
 * }
 *
 * opts:
 *   candidate       — { tank, greenhouse, featureRanges } (gate-time forests)
 *   serving         — full serving model object (or null on first run)
 *   points          — trainer history points (pivoted, ms ts)
 *   events          — mode state_events ({ ts, type, from, to })
 *   weather         — dataset weather rows ({ validAt, temperature, … })
 *   testStartMs     — first held-out (test-split) anchor time
 *   computeForecast — injectable rollout, default computeMlForecast
 *
 * Never throws; every unusable input degrades to a skip.
 */
function evaluateModeGuard(opts) {
  const compute = opts.computeForecast || computeMlForecast;
  function skip(reason) {
    return {
      pass: true, skipped: true, reason,
      candidateAccuracy: null, servingAccuracy: null, episodes: 0, samples: 0,
    };
  }

  const serving = opts.serving;
  if (!serving || !serving.tank || !serving.greenhouse) {
    return skip('no serving model to compare against');
  }
  if (!opts.candidate || !opts.candidate.tank || !opts.candidate.greenhouse) {
    return skip('no candidate forests');
  }

  const points = (opts.points || [])
    .filter(function fin(p) { return p && Number.isFinite(p.ts); })
    .slice()
    .sort(function cmp(a, b) { return a.ts - b.ts; });
  const transitions = (opts.events || [])
    .filter(function isMode(e) {
      return e && (e.type == null || e.type === 'mode') && typeof e.to === 'string';
    })
    .map(function row(e) { return { ts: toMs(e.ts), mode: e.to }; })
    .filter(function fin(t) { return Number.isFinite(t.ts); })
    .sort(function cmp(a, b) { return a.ts - b.ts; });
  const weatherByHour = {};
  const weather = opts.weather || [];
  for (let i = 0; i < weather.length; i++) {
    const ts = toMs(weather[i].validAt);
    if (Number.isFinite(ts)) weatherByHour[Math.floor(ts / HOUR_MS) * HOUR_MS] = weather[i];
  }

  // Fresh window: at/after the held-out test split AND after the serving
  // model's trainedAt (same reasoning as freshTestSubset — earlier data
  // is the serving model's own training set). Ground truth ends where
  // the sensor history does.
  const endMs = points.length ? points[points.length - 1].ts : NaN;
  let freshStartMs = Number(opts.testStartMs);
  const trainedAtMs = Date.parse(serving.trainedAt);
  if (Number.isFinite(trainedAtMs) && (!Number.isFinite(freshStartMs) || trainedAtMs > freshStartMs)) {
    freshStartMs = trainedAtMs;
  }
  if (!Number.isFinite(freshStartMs) || !Number.isFinite(endMs) || freshStartMs >= endMs) {
    return skip('no fresh episode window');
  }

  const episodes = buildEpisodes({ points, transitions, weatherByHour, freshStartMs, endMs });
  if (episodes.length < MIN_EPISODES) {
    return skip('insufficient episodes: ' + episodes.length + ' < ' + MIN_EPISODES);
  }

  const candModel = bareModel(opts.candidate);
  const servModel = bareModel(serving);
  const candPreds = [];
  const servPreds = [];
  let used = 0;
  for (let i = 0; i < episodes.length; i++) {
    let cf;
    let sf;
    try {
      cf = compute(rolloutOpts(episodes[i], candModel));
      sf = compute(rolloutOpts(episodes[i], servModel));
    } catch (_e) {
      // Drop the episode for BOTH models — keeping one side's rows
      // would break sample parity and bias the comparison.
      continue;
    }
    Array.prototype.push.apply(candPreds, episodePredictions(cf));
    Array.prototype.push.apply(servPreds, episodePredictions(sf));
    used++;
  }
  if (used < MIN_EPISODES) {
    return skip('insufficient episodes after rollout failures: ' + used + ' < ' + MIN_EPISODES);
  }

  const hours = modeMetrics.computeOccupancySeries(transitions, episodes[0].startMs, endMs);
  const candScore = modeMetrics.scoreSchedule(candPreds, hours);
  const servScore = modeMetrics.scoreSchedule(servPreds, hours);
  // The hour join is mode-independent (same episodes, same forHour set),
  // so both sample counts are identical — one thinness check suffices.
  if (candScore.sampleCount < MIN_MODE_SAMPLES) {
    return skip('ground-truth coverage too thin: ' + candScore.sampleCount
      + ' scored hours < ' + MIN_MODE_SAMPLES);
  }

  const candAcc = overallAccuracy(candScore);
  const servAcc = overallAccuracy(servScore);
  const result = {
    pass: true,
    skipped: false,
    reason: null,
    candidateAccuracy: round3(candAcc),
    servingAccuracy: round3(servAcc),
    episodes: used,
    samples: candScore.sampleCount,
  };
  if (servAcc - candAcc > MODE_ACCURACY_MARGIN) {
    result.pass = false;
    result.reason = 'mode schedule regressed (dominant-mode accuracy ' + pct(candAcc)
      + ' vs serving ' + pct(servAcc) + ' on ' + used + ' episodes, '
      + candScore.sampleCount + ' scored hours)';
  }
  return result;
}

module.exports = {
  evaluateModeGuard,
  buildEpisodes,
  episodePredictions,
  MIN_EPISODES,
  MAX_EPISODES,
  MIN_MODE_SAMPLES,
  MODE_ACCURACY_MARGIN,
  EPISODE_SPACING_MS,
};
