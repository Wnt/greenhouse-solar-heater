'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const mm = require('../server/lib/forecast/mode-metrics.js');

const ts = (iso) => new Date(iso).getTime();

// ── Scenario A: 3-hour window with a boundary transition and an
//    open-ended last segment ──────────────────────────────────────────
//
//   07:30 idle | 08:20 solar_charging | 08:40 idle | 09:10 greenhouse_heating →
//   window 08:00 – 11:00 UTC
//
//   Hand-computed occupancy:
//     H08: idle 2400 s (08:00–08:20 + 08:40–09:00), solar_charging 1200 s
//     H09: idle 600 s, greenhouse_heating 3000 s
//     H10: greenhouse_heating 3600 s (open-ended last segment)
const SCENARIO_A_TRANSITIONS = [
  { ts: '2026-07-01T07:30:00Z', mode: 'idle' },
  { ts: '2026-07-01T08:20:00Z', mode: 'solar_charging' },
  { ts: '2026-07-01T08:40:00Z', mode: 'idle' },
  { ts: '2026-07-01T09:10:00Z', mode: 'greenhouse_heating' },
];
const A_START = ts('2026-07-01T08:00:00Z');
const A_END   = ts('2026-07-01T11:00:00Z');

describe('mode-metrics: computeOccupancySeries', () => {
  it('computes per-hour occupancy, coverage and dominant mode', () => {
    const hours = mm.computeOccupancySeries(SCENARIO_A_TRANSITIONS, A_START, A_END);
    assert.equal(hours.length, 3);

    assert.equal(hours[0].hourStartMs, A_START);
    assert.deepEqual(hours[0].occupancy, { idle: 2400, solar_charging: 1200 });
    assert.equal(hours[0].coverageSec, 3600);
    assert.equal(hours[0].dominantMode, 'idle');

    assert.deepEqual(hours[1].occupancy, { idle: 600, greenhouse_heating: 3000 });
    assert.equal(hours[1].dominantMode, 'greenhouse_heating');
  });

  it('extends the open-ended last segment to the window end', () => {
    const hours = mm.computeOccupancySeries(SCENARIO_A_TRANSITIONS, A_START, A_END);
    assert.deepEqual(hours[2].occupancy, { greenhouse_heating: 3600 });
    assert.equal(hours[2].coverageSec, 3600);
    assert.equal(hours[2].dominantMode, 'greenhouse_heating');
  });

  it('clamps segments that started before the window', () => {
    // The boundary 07:30 idle segment only counts from 08:00.
    const hours = mm.computeOccupancySeries(SCENARIO_A_TRANSITIONS, A_START, A_END);
    assert.equal(hours[0].occupancy.idle, 2400); // not 2400 + 30 min
  });

  it('reports partial coverage when no boundary transition is known', () => {
    // Without the 07:30 row the first 20 min of H08 are unknown.
    const hours = mm.computeOccupancySeries(SCENARIO_A_TRANSITIONS.slice(1), A_START, A_END);
    assert.equal(hours[0].coverageSec, 2400);
  });

  it('handles a churny hour (hysteresis cycling, no >=75% mode)', () => {
    // 6 dwells inside one hour — median real dwell is 6–9 min, so this is
    // the common case, not a corner case.
    const churny = [
      { ts: '2026-07-01T09:00:00Z', mode: 'solar_charging' },
      { ts: '2026-07-01T09:06:00Z', mode: 'idle' },
      { ts: '2026-07-01T09:15:00Z', mode: 'solar_charging' },
      { ts: '2026-07-01T09:24:00Z', mode: 'idle' },
      { ts: '2026-07-01T09:35:00Z', mode: 'solar_charging' },
      { ts: '2026-07-01T09:44:00Z', mode: 'idle' },
    ];
    const hours = mm.computeOccupancySeries(
      churny, ts('2026-07-01T09:00:00Z'), ts('2026-07-01T10:00:00Z'));
    assert.equal(hours.length, 1);
    // solar: 360 + 540 + 540 = 1440; idle: 540 + 660 + 960 = 2160
    assert.deepEqual(hours[0].occupancy, { solar_charging: 1440, idle: 2160 });
    assert.equal(hours[0].dominantMode, 'idle'); // only 60 % — still dominant
  });

  it('includes a trailing partial hour with its partial coverage', () => {
    const hours = mm.computeOccupancySeries(
      SCENARIO_A_TRANSITIONS, A_START, A_END + 30 * 60 * 1000);
    assert.equal(hours.length, 4);
    assert.equal(hours[3].coverageSec, 1800); // < 3000 → scoring excludes it
  });
});

describe('mode-metrics: scoreSchedule', () => {
  const hours = mm.computeOccupancySeries(SCENARIO_A_TRANSITIONS, A_START, A_END);
  // A prediction row covers [for_hour - 1 h, for_hour) — the join
  // semantics from design/docs/ml-mode-forecast-findings.md.
  const predictions = [
    // → H08 (actual idle, solar occupancy 1200 s > 900 s)
    { forHour: '2026-07-01T09:00:00Z', horizonH: 1,  mode: 'idle',               hasSolarOverlay: false },
    // → H09 (actual greenhouse_heating, no solar)
    { forHour: '2026-07-01T10:00:00Z', horizonH: 2,  mode: 'solar_charging',     hasSolarOverlay: false },
    // → H10 (actual greenhouse_heating, no solar); overlay counts as predicted-solar
    { forHour: '2026-07-01T11:00:00Z', horizonH: 3,  mode: 'greenhouse_heating', hasSolarOverlay: true },
    // → H08 again at a far horizon (actual idle)
    { forHour: '2026-07-01T09:00:00Z', horizonH: 25, mode: 'solar_charging',     hasSolarOverlay: false },
  ];
  const score = mm.scoreSchedule(predictions, hours);

  it('buckets accuracy by horizon (1, 2-6, 7-24, 25-48)', () => {
    assert.equal(score.sampleCount, 4);
    assert.deepEqual(score.accuracyByHorizon['1'],     { n: 1, correct: 1, accuracy: 1 });
    assert.deepEqual(score.accuracyByHorizon['2-6'],   { n: 2, correct: 1, accuracy: 0.5 });
    assert.deepEqual(score.accuracyByHorizon['7-24'],  { n: 0, correct: 0, accuracy: null });
    assert.deepEqual(score.accuracyByHorizon['25-48'], { n: 1, correct: 0, accuracy: 0 });
  });

  it('computes per-mode precision and recall over the joined sample', () => {
    // Joined pairs (pred → actual): idle→idle, solar→gh, gh→gh, solar→idle
    assert.deepEqual(score.perMode.idle,
      { predicted: 1, actual: 2, tp: 1, precision: 1, recall: 0.5 });
    assert.deepEqual(score.perMode.solar_charging,
      { predicted: 2, actual: 0, tp: 0, precision: 0, recall: null });
    assert.deepEqual(score.perMode.greenhouse_heating,
      { predicted: 1, actual: 2, tp: 1, precision: 1, recall: 0.5 });
    assert.deepEqual(score.perMode.emergency_heating,
      { predicted: 0, actual: 0, tp: 0, precision: null, recall: null });
  });

  it('scores solar detection with mode-or-overlay vs >25% occupancy', () => {
    // predSolar: P2 (mode), P3 (overlay), P4 (mode). actualSolar: H08 only.
    // P1→H08 miss (fn); P2→H09 fp; P3→H10 fp; P4→H08 tp.
    assert.deepEqual(score.solar,
      { tp: 1, fp: 2, fn: 1, tn: 0, precision: 1 / 3, recall: 0.5 });
  });

  it('excludes hours with <50 min coverage from scoring', () => {
    const partialHours = mm.computeOccupancySeries(
      SCENARIO_A_TRANSITIONS.slice(1), A_START, ts('2026-07-01T09:00:00Z'));
    assert.equal(partialHours[0].coverageSec, 2400); // < 3000 s
    const s = mm.scoreSchedule(
      [{ forHour: '2026-07-01T09:00:00Z', horizonH: 1, mode: 'idle', hasSolarOverlay: false }],
      partialHours);
    assert.equal(s.sampleCount, 0);
    assert.equal(s.accuracyByHorizon['1'].n, 0);
  });

  it('ignores predictions whose covered hour is outside the series', () => {
    const s = mm.scoreSchedule(
      [{ forHour: '2026-07-01T15:00:00Z', horizonH: 1, mode: 'idle', hasSolarOverlay: false }],
      hours);
    assert.equal(s.sampleCount, 0);
  });
});

describe('mode-metrics: emergency scoring', () => {
  // An emergency morning: 05:00–06:20 emergency_heating.
  //   H04 idle | H05 emergency (3600 s) | H06 emergency 1200 s + idle 2400 s
  //   (dominant idle but still an actual-emergency hour) | H07 idle
  const transitions = [
    { ts: '2026-05-10T03:00:00Z', mode: 'idle' },
    { ts: '2026-05-10T05:00:00Z', mode: 'emergency_heating' },
    { ts: '2026-05-10T06:20:00Z', mode: 'idle' },
  ];
  const hours = mm.computeOccupancySeries(
    transitions, ts('2026-05-10T04:00:00Z'), ts('2026-05-10T08:00:00Z'));
  const predictions = [
    { forHour: '2026-05-10T05:00:00Z', horizonH: 2, mode: 'idle',              hasSolarOverlay: false },
    { forHour: '2026-05-10T06:00:00Z', horizonH: 3, mode: 'emergency_heating', hasSolarOverlay: false },
    { forHour: '2026-05-10T07:00:00Z', horizonH: 4, mode: 'idle',              hasSolarOverlay: false },
    { forHour: '2026-05-10T08:00:00Z', horizonH: 5, mode: 'emergency_heating', hasSolarOverlay: false },
  ];

  it('counts predicted vs actual emergency hours and recall', () => {
    const score = mm.scoreSchedule(predictions, hours);
    // actual emergency hours: H05 (3600 s) + H06 (1200 s > 900 s) = 2
    // predicted: P2 (tp on H05) + P4 (fp on H07) = 2; recall 1/2
    assert.deepEqual(score.emergency,
      { predictedSamples: 2, actualSamples: 2, tp: 1, recall: 0.5 });
  });
});

describe('mode-metrics: hour-of-day climatology (Europe/Helsinki)', () => {
  // Three July days (Helsinki = UTC+3): 07:00Z (= 10:00 local) is solar
  // on all days; 08:00Z (= 11:00 local) is greenhouse_heating on day 1
  // but idle on days 2–3 → climatology picks idle.
  const transitions = [
    { ts: '2026-07-01T06:00:00Z', mode: 'idle' },
    { ts: '2026-07-01T07:00:00Z', mode: 'solar_charging' },
    { ts: '2026-07-01T08:00:00Z', mode: 'greenhouse_heating' },
    { ts: '2026-07-01T09:00:00Z', mode: 'idle' },
    { ts: '2026-07-02T07:00:00Z', mode: 'solar_charging' },
    { ts: '2026-07-02T08:00:00Z', mode: 'idle' },
    { ts: '2026-07-03T07:00:00Z', mode: 'solar_charging' },
    { ts: '2026-07-03T08:00:00Z', mode: 'idle' },
  ];
  const hours = mm.computeOccupancySeries(
    transitions, ts('2026-07-01T06:00:00Z'), ts('2026-07-03T09:00:00Z'));

  it('derives the dominant mode per Helsinki hour-of-day', () => {
    const clim = mm.computeClimatology(hours);
    assert.equal(clim.byHourOfDay[10], 'solar_charging'); // 07:00Z in summer
    assert.equal(clim.byHourOfDay[11], 'idle');           // 2 idle vs 1 heating
    assert.equal(clim.byHourOfDay[9], 'idle');
  });

  it('scores climatology on the same joined sample (the skill floor)', () => {
    const clim = mm.computeClimatology(hours);
    const predictions = [
      // → 08:00Z day 1: clim says idle, actual greenhouse_heating → wrong
      { forHour: '2026-07-01T09:00:00Z', horizonH: 3,  mode: 'idle', hasSolarOverlay: false },
      // → 07:00Z day 2: clim solar, actual solar → correct
      { forHour: '2026-07-02T08:00:00Z', horizonH: 26, mode: 'idle', hasSolarOverlay: false },
      // → 07:00Z day 3: clim solar, actual solar → correct
      { forHour: '2026-07-03T08:00:00Z', horizonH: 12, mode: 'idle', hasSolarOverlay: false },
    ];
    const s = mm.scoreClimatology(clim.byHourOfDay, predictions, hours);
    assert.equal(s.n, 3);
    assert.equal(s.correct, 2);
    assert.equal(s.accuracy, 2 / 3);
    assert.deepEqual(s.accuracyByHorizon['2-6'],   { n: 1, correct: 0, accuracy: 0 });
    assert.deepEqual(s.accuracyByHorizon['7-24'],  { n: 1, correct: 1, accuracy: 1 });
    assert.deepEqual(s.accuracyByHorizon['25-48'], { n: 1, correct: 1, accuracy: 1 });
  });
});

describe('mode-metrics: windowOccupancy over an arbitrary [start,end) window', () => {
  const segments = mm.buildSegments(SCENARIO_A_TRANSITIONS, A_START, A_END);

  it('computes occupancy for an unaligned window', () => {
    const w = mm.windowOccupancy(
      segments, ts('2026-07-01T08:30:02Z'), ts('2026-07-01T09:30:02Z'));
    // solar 08:30:02–08:40 = 598 s; idle 08:40–09:10 = 1800 s;
    // greenhouse_heating 09:10–09:30:02 = 1202 s
    assert.deepEqual(w.occupancy,
      { solar_charging: 598, idle: 1800, greenhouse_heating: 1202 });
    assert.equal(w.coverageSec, 3600);
    assert.equal(w.dominantMode, 'idle');
  });

  it('clamps to the outer data window', () => {
    const w = mm.windowOccupancy(
      segments, ts('2026-07-01T10:30:00Z'), ts('2026-07-01T11:30:00Z'));
    assert.deepEqual(w.occupancy, { greenhouse_heating: 1800 });
    assert.equal(w.coverageSec, 1800);
  });

  it('returns empty occupancy for a window with no coverage', () => {
    const w = mm.windowOccupancy(
      segments, ts('2026-07-01T12:00:00Z'), ts('2026-07-01T13:00:00Z'));
    assert.deepEqual(w.occupancy, {});
    assert.equal(w.coverageSec, 0);
    assert.equal(w.dominantMode, null);
  });
});

describe('mode-metrics: unaligned production for_hour values (HH:30:02 offsets)', () => {
  // Production forecast_predictions rows have for_hour = generated_at +
  // h·1h with generated_at ≈ HH:30:02 — NEVER hour-aligned. Each row
  // must be scored against its EXACT [for_hour - 1 h, for_hour) window;
  // an exact-hash join on hour starts scores 0 samples on real data.
  const transitions = [
    { ts: '2026-07-01T07:30:00Z', mode: 'idle' },
    { ts: '2026-07-01T08:20:00Z', mode: 'solar_charging' },
    { ts: '2026-07-01T08:40:00Z', mode: 'idle' },
    { ts: '2026-07-01T09:10:00Z', mode: 'greenhouse_heating' },
  ];
  const predictions = [
    { forHour: '2026-07-01T08:30:02Z', horizonH: 1, mode: 'idle',               hasSolarOverlay: false },
    { forHour: '2026-07-01T09:30:02Z', horizonH: 2, mode: 'solar_charging',     hasSolarOverlay: false },
    { forHour: '2026-07-01T10:30:02Z', horizonH: 3, mode: 'greenhouse_heating', hasSolarOverlay: false },
    // Window [10:30:02, 11:30:02) has only 1798 s of ground truth (the
    // data window ends 11:00) → excluded by the < 50 min rule.
    { forHour: '2026-07-01T11:30:02Z', horizonH: 4, mode: 'idle',               hasSolarOverlay: false },
  ];
  const out = mm.summarizeModeAccuracy({
    predictions,
    transitions,
    windowStartMs: ts('2026-07-01T07:00:00Z'),
    windowEndMs: ts('2026-07-01T11:00:00Z'),
  });

  it('joins every covered unaligned row (n > 0 on realistic offsets)', () => {
    assert.equal(out.sampleCount, 3);
  });

  it('scores hand-computed per-window dominant modes', () => {
    // [07:30:02, 08:30:02): idle 2998 s vs solar 602 s → idle; pred idle ✓
    // [08:30:02, 09:30:02): idle 1800 s dominant → pred solar ✗
    // [09:30:02, 10:30:02): greenhouse_heating 3600 s → pred gh ✓
    assert.deepEqual(out.accuracyByHorizon['1'],   { n: 1, correct: 1, accuracy: 1 });
    assert.deepEqual(out.accuracyByHorizon['2-6'], { n: 2, correct: 1, accuracy: 0.5 });
    assert.deepEqual(out.perMode.idle,
      { predicted: 1, actual: 2, tp: 1, precision: 1, recall: 0.5 });
    assert.deepEqual(out.perMode.greenhouse_heating,
      { predicted: 1, actual: 1, tp: 1, precision: 1, recall: 1 });
  });

  it('applies the >25% solar rule to the exact window', () => {
    // Solar occupancy per joined window: 602 s, 598 s, 0 s — none clears
    // the 900 s bar, so the one solar prediction is a false positive.
    assert.deepEqual(out.solar,
      { tp: 0, fp: 1, fn: 0, tn: 2, precision: 0, recall: null });
  });

  it('scores climatology on the same joined sample via window midpoints', () => {
    // Midpoints 08:00:02Z / 09:00:02Z / 10:00:02Z → Helsinki hours
    // 11 / 12 / 13. Climatology (from the aligned hourly series):
    // 11→idle, 12→greenhouse_heating, 13→greenhouse_heating
    // ⇒ correct, wrong, correct.
    assert.equal(out.baselines.climatology.n, 3);
    assert.equal(out.baselines.climatology.correct, 2);
    assert.equal(out.baselines.climatology.accuracy, 2 / 3);
  });
});

describe('mode-metrics: summarizeModeAccuracy', () => {
  it('assembles schedule score + climatology baseline in one call', () => {
    const predictions = [
      { forHour: '2026-07-01T09:00:00Z', horizonH: 1, mode: 'idle', hasSolarOverlay: false },
      { forHour: '2026-07-01T10:00:00Z', horizonH: 2, mode: 'solar_charging', hasSolarOverlay: false },
    ];
    const out = mm.summarizeModeAccuracy({
      predictions,
      transitions: SCENARIO_A_TRANSITIONS,
      windowStartMs: A_START,
      windowEndMs: A_END,
    });
    assert.deepEqual(out.accuracyByHorizon['1'], { n: 1, correct: 1, accuracy: 1 });
    assert.deepEqual(out.accuracyByHorizon['2-6'], { n: 1, correct: 0, accuracy: 0 });
    assert.equal(out.sampleCount, 2);
    assert.ok(out.perMode.idle);
    assert.ok(out.solar);
    assert.ok(out.emergency);
    // Climatology baseline scored on the same 2-pair joined sample.
    assert.equal(out.baselines.climatology.n, 2);
    assert.ok(out.baselines.climatology.byHourOfDay);
    assert.ok('accuracy' in out.baselines.climatology);
  });
});
