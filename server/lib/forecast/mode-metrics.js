'use strict';

/**
 * Mode-schedule metrics — pure functions, no I/O.
 *
 * Scores a forecast engine's 48 h mode schedule against the mode
 * transitions the controller actually logged (state_events,
 * entity_type='mode'), and computes the hour-of-day climatology
 * baseline it has to beat. Motivated by the measured evidence in
 * design/docs/ml-mode-forecast-findings.md (recommendations #3 and #7):
 * hourly dominant-mode accuracy of the deployed schedule is 63–71 %
 * beyond 4 h vs 71 % for a trivial hour-of-day climatology, and
 * emergency_heating had 0–4 predicted hours vs 56 actual — neither was
 * visible anywhere because nothing in the pipeline scored the schedule.
 *
 * Join semantics mirror the offline backtest
 * (scripts/backtest-mode-forecast.mjs) and the findings doc:
 *   - a forecast_predictions row covers [for_hour - 1 h, for_hour) —
 *     scored against that EXACT window. Production for_hour values are
 *     generated_at + h·1h with generated_at ≈ HH:30:02, never
 *     hour-aligned, so an exact-hash join on hour starts would score 0
 *     samples on real data;
 *   - windows with < 50 min of logged mode coverage are excluded;
 *   - "actual solar" / "actual emergency" = that mode occupied > 25 %
 *     of the window (> 900 s), because the controller's median dwell is
 *     6–9 min and 27.8 % of hours have no ≥ 75 % dominant mode — a
 *     dominant-only definition would hide most real solar/emergency
 *     activity.
 *
 * All ratios are null when the denominator is 0 (no data ≠ 0 %).
 */

const HOUR_MS = 3600 * 1000;

// Exclude hours with < 50 min of mode coverage (same 3000 s cutoff as
// the backtest harness).
const MIN_COVERAGE_SEC = 3000;
// > 25 % of the hour → the mode "actually happened" that hour.
const ACTIVE_MIN_SEC = 900;

const HORIZON_BUCKETS = ['1', '2-6', '7-24', '25-48'];
const MODES = ['idle', 'solar_charging', 'greenhouse_heating', 'emergency_heating', 'active_drain'];

// Helsinki hour-of-day for the climatology baseline — same Intl idiom as
// ml-forecast.js / sustain-forecast-fit-base.js (DST-correct).
const HEL_HOUR_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Helsinki', hour: '2-digit', hour12: false,
});

function helsinkiHourOfDay(ms) {
  return parseInt(HEL_HOUR_FMT.format(new Date(ms)), 10) % 24;
}

function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return new Date(v).getTime();
}

function horizonBucket(h) {
  if (h <= 1) return '1';
  if (h <= 6) return '2-6';
  if (h <= 24) return '7-24';
  return '25-48';
}

function ratio(num, den) { return den > 0 ? num / den : null; }

// ── Occupancy ────────────────────────────────────────────────────────

/**
 * transitions: [{ ts, mode }] — a mode-change list in state_events shape
 * (ts = when `mode` became active). Builds the sorted, non-overlapping
 * mode segments clamped to [windowStartMs, windowEndMs). The last
 * transition is open-ended and extends to windowEndMs. Time before the
 * first transition has unknown mode and simply contributes no coverage,
 * so callers that want full coverage of the first hour should include
 * the latest transition at-or-before the window start.
 *
 * Outage caveat: the open-ended extension treats mode as persistent
 * state, so a telemetry outage (server down, no state_events written)
 * still yields FULL synthetic coverage from the last pre-outage
 * transition — windows inside the outage score against a possibly
 * wrong mode instead of hitting the coverage exclusion. Accepted:
 * mode genuinely is device-persistent across server outages and the
 * device keeps running; only a concurrent device restart would make
 * the carried mode wrong, and those windows are indistinguishable
 * from valid data here (PR #283 review).
 */
function buildSegments(transitions, windowStartMs, windowEndMs) {
  const trans = (transitions || [])
    .map(function (t) { return { ts: toMs(t.ts), mode: t.mode }; })
    .filter(function (t) { return isFinite(t.ts) && typeof t.mode === 'string' && t.mode !== ''; })
    .sort(function (a, b) { return a.ts - b.ts; });

  const segments = [];
  for (let i = 0; i < trans.length; i++) {
    const start = Math.max(trans[i].ts, windowStartMs);
    // Open-ended last segment extends to windowEndMs.
    const end = Math.min(i + 1 < trans.length ? trans[i + 1].ts : windowEndMs, windowEndMs);
    if (end > start) segments.push({ start, end, mode: trans[i].mode });
  }
  return segments;
}

/**
 * Mode occupancy over an arbitrary [startMs, endMs) window — the shared
 * segment-overlap core behind both the aligned hourly series and the
 * exact-window prediction join.
 *
 * segments: output of buildSegments (sorted, non-overlapping, clamped).
 * → { occupancy: { mode: seconds }, coverageSec, dominantMode }
 */
function windowOccupancy(segments, startMs, endMs) {
  const occupancy = {};
  let coverageSec = 0;
  // Binary search the first segment ending after startMs (segment ends
  // are ascending), then walk while segments still overlap the window.
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].end <= startMs) lo = mid + 1; else hi = mid;
  }
  for (let i = lo; i < segments.length && segments[i].start < endMs; i++) {
    const s = segments[i];
    const ov = Math.min(s.end, endMs) - Math.max(s.start, startMs);
    if (ov <= 0) continue;
    const sec = ov / 1000;
    occupancy[s.mode] = (occupancy[s.mode] || 0) + sec;
    coverageSec += sec;
  }
  let dominantMode = null;
  let best = 0;
  const modes = Object.keys(occupancy);
  for (let i = 0; i < modes.length; i++) {
    // Strict > : ties resolve to the first-seen mode (segment order),
    // which is deterministic for a given transition list.
    if (occupancy[modes[i]] > best) { best = occupancy[modes[i]]; dominantMode = modes[i]; }
  }
  return { occupancy, coverageSec, dominantMode };
}

/**
 * Returns one entry per hour whose start falls inside the window:
 * [{ hourStartMs, occupancy: { mode: seconds }, coverageSec, dominantMode }]
 * A trailing partial hour is included with its partial coverage — the
 * < 50 min rule then excludes it from scoring naturally.
 */
function computeOccupancySeries(transitions, windowStartMs, windowEndMs) {
  const segments = buildSegments(transitions, windowStartMs, windowEndMs);
  const hours = [];
  const firstHour = Math.ceil(windowStartMs / HOUR_MS) * HOUR_MS;
  for (let hs = firstHour; hs < windowEndMs; hs += HOUR_MS) {
    const w = windowOccupancy(segments, hs, hs + HOUR_MS);
    hours.push({
      hourStartMs: hs,
      occupancy: w.occupancy,
      coverageSec: w.coverageSec,
      dominantMode: w.dominantMode,
    });
  }
  return hours;
}

// ── Joining helpers ──────────────────────────────────────────────────
//
// A lookup resolves one prediction row (covering [forHour - 1 h,
// forHour)) to its scoreable actual window
// { occupancy, coverageSec, dominantMode, midMs }, or null when the
// window is missing / under-covered. Two flavours:
//   - alignedLookup(hours): exact hash on hour starts, for callers whose
//     forHour values are hour-aligned (mode-gate episode rollouts);
//   - exactLookup(segments): occupancy over the row's exact window —
//     production for_hour values sit at HH:30:02 offsets, so the hash
//     join would score 0 samples on real data.

function alignedLookup(hours) {
  const byStart = {};
  for (let i = 0; i < hours.length; i++) byStart[hours[i].hourStartMs] = hours[i];
  return function (p) {
    const startMs = toMs(p.forHour) - HOUR_MS;
    const hour = byStart[startMs];
    if (!hour || hour.coverageSec < MIN_COVERAGE_SEC || !hour.dominantMode) return null;
    return {
      occupancy: hour.occupancy,
      coverageSec: hour.coverageSec,
      dominantMode: hour.dominantMode,
      midMs: startMs + HOUR_MS / 2,
    };
  };
}

function exactLookup(segments) {
  return function (p) {
    const endMs = toMs(p.forHour);
    if (!isFinite(endMs)) return null;
    const w = windowOccupancy(segments, endMs - HOUR_MS, endMs);
    if (w.coverageSec < MIN_COVERAGE_SEC || !w.dominantMode) return null;
    w.midMs = endMs - HOUR_MS / 2;
    return w;
  };
}

function emptyBuckets() {
  const acc = {};
  for (let i = 0; i < HORIZON_BUCKETS.length; i++) {
    acc[HORIZON_BUCKETS[i]] = { n: 0, correct: 0 };
  }
  return acc;
}

function finalizeBuckets(acc) {
  for (let i = 0; i < HORIZON_BUCKETS.length; i++) {
    const b = acc[HORIZON_BUCKETS[i]];
    b.accuracy = ratio(b.correct, b.n);
  }
  return acc;
}

// ── Schedule scoring ─────────────────────────────────────────────────

/**
 * predictions: [{ forHour, horizonH, mode, hasSolarOverlay }]
 * lookup: a joining lookup (alignedLookup / exactLookup).
 *
 * Every (prediction row, covered window) pair is one sample — the same
 * window scored at several horizons counts once per horizon, matching
 * the backtest and the findings-doc accuracy tables.
 */
function scoreScheduleWith(predictions, lookup) {
  const accuracyByHorizon = emptyBuckets();
  const perMode = {};
  for (let i = 0; i < MODES.length; i++) {
    perMode[MODES[i]] = { predicted: 0, actual: 0, tp: 0 };
  }
  const pm = function (mode) {
    if (!perMode[mode]) perMode[mode] = { predicted: 0, actual: 0, tp: 0 };
    return perMode[mode];
  };
  const solar = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const emergency = { predictedSamples: 0, actualSamples: 0, tp: 0 };
  let sampleCount = 0;

  for (let i = 0; i < (predictions || []).length; i++) {
    const p = predictions[i];
    const hour = lookup(p);
    if (!hour) continue;
    sampleCount++;

    const correct = p.mode === hour.dominantMode;
    const b = accuracyByHorizon[horizonBucket(p.horizonH)];
    b.n++;
    if (correct) b.correct++;

    pm(p.mode).predicted++;
    pm(hour.dominantMode).actual++;
    if (correct) pm(p.mode).tp++;

    // Solar detection: predicted-solar = solar as the hour's mode OR as
    // an overlay on another mode; actual-solar = > 25 % occupancy.
    const predSolar = p.mode === 'solar_charging' || !!p.hasSolarOverlay;
    const actSolar = (hour.occupancy.solar_charging || 0) > ACTIVE_MIN_SEC;
    solar[predSolar ? (actSolar ? 'tp' : 'fp') : (actSolar ? 'fn' : 'tn')]++;

    // Emergency: the operationally significant miss (0–4 predicted vs
    // 56 actual DISTINCT hours in the backtest window). These counters
    // are per JOIN SAMPLE, not per distinct wall-clock hour: every
    // covered hour is joined by up to 48 prediction rows (one per
    // horizon from 48 generations), so the counts run up to ~48x the
    // distinct-hour figures in the findings doc (PR #283 review — 12
    // distinct emergency hours in a 30 d prod window would read as
    // several hundred samples here). Named *Samples to make that
    // unmistakable; recall is per-sample on both sides and therefore
    // comparable to the doc's per-hour recall.
    const predEmerg = p.mode === 'emergency_heating';
    const actEmerg = (hour.occupancy.emergency_heating || 0) > ACTIVE_MIN_SEC;
    if (predEmerg) emergency.predictedSamples++;
    if (actEmerg) emergency.actualSamples++;
    if (predEmerg && actEmerg) emergency.tp++;
  }

  const modeNames = Object.keys(perMode);
  for (let i = 0; i < modeNames.length; i++) {
    const m = perMode[modeNames[i]];
    m.precision = ratio(m.tp, m.predicted);
    m.recall = ratio(m.tp, m.actual);
  }
  solar.precision = ratio(solar.tp, solar.tp + solar.fp);
  solar.recall = ratio(solar.tp, solar.tp + solar.fn);
  emergency.recall = ratio(emergency.tp, emergency.actualSamples);

  return {
    sampleCount,
    accuracyByHorizon: finalizeBuckets(accuracyByHorizon),
    perMode,
    solar,
    emergency,
  };
}

/**
 * hours: output of computeOccupancySeries. Kept for hour-aligned callers
 * (mode-gate.js) — the hash join requires forHour values on exact hour
 * starts.
 */
function scoreSchedule(predictions, hours) {
  return scoreScheduleWith(predictions, alignedLookup(hours));
}

// ── Climatology baseline (the skill floor, findings #7) ──────────────

/**
 * Hour-of-day (Europe/Helsinki) dominant-mode climatology over the
 * covered hours. In-sample by construction (same caveat as the findings
 * doc) — it is a floor to beat, not a competing forecast.
 */
function computeClimatology(hours) {
  const counts = {};
  for (let i = 0; i < hours.length; i++) {
    const h = hours[i];
    if (h.coverageSec < MIN_COVERAGE_SEC || !h.dominantMode) continue;
    const hod = helsinkiHourOfDay(h.hourStartMs);
    if (!counts[hod]) counts[hod] = {};
    counts[hod][h.dominantMode] = (counts[hod][h.dominantMode] || 0) + 1;
  }
  const byHourOfDay = {};
  const hods = Object.keys(counts);
  for (let i = 0; i < hods.length; i++) {
    const c = counts[hods[i]];
    let best = 0;
    let mode = null;
    const modes = Object.keys(c);
    for (let j = 0; j < modes.length; j++) {
      if (c[modes[j]] > best) { best = c[modes[j]]; mode = modes[j]; }
    }
    byHourOfDay[hods[i]] = mode;
  }
  return { byHourOfDay };
}

/**
 * Accuracy of the climatology on the SAME joined sample the schedule
 * was scored on (the prediction rows only define which (window, horizon)
 * pairs are evaluated; their mode field is ignored here). The
 * climatology's hour-of-day is read at the joined window's midpoint —
 * for an aligned window that is the same Helsinki hour as its start.
 */
function scoreClimatologyWith(byHourOfDay, predictions, lookup) {
  const accuracyByHorizon = emptyBuckets();
  let n = 0;
  let correct = 0;
  for (let i = 0; i < (predictions || []).length; i++) {
    const p = predictions[i];
    const hour = lookup(p);
    if (!hour) continue;
    n++;
    const b = accuracyByHorizon[horizonBucket(p.horizonH)];
    b.n++;
    if (byHourOfDay[helsinkiHourOfDay(hour.midMs)] === hour.dominantMode) {
      correct++;
      b.correct++;
    }
  }
  return { n, correct, accuracy: ratio(correct, n), accuracyByHorizon: finalizeBuckets(accuracyByHorizon) };
}

// hours: output of computeOccupancySeries — hour-aligned callers only.
function scoreClimatology(byHourOfDay, predictions, hours) {
  return scoreClimatologyWith(byHourOfDay, predictions, alignedLookup(hours));
}

// ── One-call assembly for the diagnostics endpoint ───────────────────

function summarizeModeAccuracy(opts) {
  // The climatology table builds on the aligned hourly series; each
  // prediction row is joined against its EXACT [for_hour - 1 h,
  // for_hour) window (production for_hour values are never
  // hour-aligned — see the join-semantics note in the header).
  const hours = computeOccupancySeries(opts.transitions, opts.windowStartMs, opts.windowEndMs);
  const segments = buildSegments(opts.transitions, opts.windowStartMs, opts.windowEndMs);
  const lookup = exactLookup(segments);
  const sched = scoreScheduleWith(opts.predictions, lookup);
  const clim = computeClimatology(hours);
  const climScore = scoreClimatologyWith(clim.byHourOfDay, opts.predictions, lookup);
  return {
    sampleCount: sched.sampleCount,
    accuracyByHorizon: sched.accuracyByHorizon,
    perMode: sched.perMode,
    solar: sched.solar,
    emergency: sched.emergency,
    baselines: {
      climatology: {
        byHourOfDay: clim.byHourOfDay,
        n: climScore.n,
        correct: climScore.correct,
        accuracy: climScore.accuracy,
        accuracyByHorizon: climScore.accuracyByHorizon,
      },
    },
  };
}

module.exports = {
  buildSegments,
  windowOccupancy,
  computeOccupancySeries,
  scoreSchedule,
  computeClimatology,
  scoreClimatology,
  summarizeModeAccuracy,
  MIN_COVERAGE_SEC,
  ACTIVE_MIN_SEC,
  HORIZON_BUCKETS,
  MODES,
};
