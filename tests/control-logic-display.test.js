// Display-formatter tests — extracted from control-logic.test.js on
// 2026-04-23 to keep the main test file under the 1200-line hard cap.
// formatDuration / formatTemp / buildDisplayLabels are pure helpers that
// don't touch the evaluator state machine, so they make a natural split.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { MODES, formatDuration, formatTemp, buildDisplayLabels } =
  require('../shelly/control-logic.js');

describe('formatDuration', () => {
  it('formats seconds', () => {
    assert.strictEqual(formatDuration(0), '0s');
    assert.strictEqual(formatDuration(30000), '30s');
    assert.strictEqual(formatDuration(59999), '59s');
  });

  it('formats minutes', () => {
    assert.strictEqual(formatDuration(60000), '1m');
    assert.strictEqual(formatDuration(2820000), '47m');
    assert.strictEqual(formatDuration(3599999), '59m');
  });

  it('formats hours and minutes', () => {
    assert.strictEqual(formatDuration(3600000), '1h0m');
    assert.strictEqual(formatDuration(4980000), '1h23m');
    assert.strictEqual(formatDuration(36000000), '10h0m');
  });
});

describe('formatTemp', () => {
  it('formats normal temperatures', () => {
    assert.strictEqual(formatTemp(68.2), '68C');
    assert.strictEqual(formatTemp(8.3), '8C');
    assert.strictEqual(formatTemp(-3.7), '-4C');
    assert.strictEqual(formatTemp(0), '0C');
  });

  it('returns -- for null/undefined', () => {
    assert.strictEqual(formatTemp(null), '--');
    assert.strictEqual(formatTemp(undefined), '--');
  });
});

describe('buildDisplayLabels', () => {
  function makeDisplayState(overrides) {
    const base = {
      mode: MODES.IDLE,
      modeDurationMs: 0,
      temps: { collector: 20, tank_top: 45, tank_bottom: 38, greenhouse: 8, outdoor: 3 },
      lastError: null,
      collectorsDrained: false,
    };
    return Object.assign({}, base, overrides);
  }

  it('shows mode and duration on ch0', () => {
    const labels = buildDisplayLabels(makeDisplayState({
      mode: MODES.SOLAR_CHARGING,
      modeDurationMs: 2820000,
    }));
    assert.strictEqual(labels[0], 'SOLAR 47m');
  });

  it('uses short mode names', () => {
    assert.strictEqual(buildDisplayLabels(makeDisplayState({ mode: MODES.IDLE }))[0], 'IDLE 0s');
    assert.strictEqual(buildDisplayLabels(makeDisplayState({ mode: MODES.GREENHOUSE_HEATING }))[0], 'HEAT 0s');
    assert.strictEqual(buildDisplayLabels(makeDisplayState({ mode: MODES.ACTIVE_DRAIN }))[0], 'DRAIN 0s');
    assert.strictEqual(buildDisplayLabels(makeDisplayState({ mode: MODES.EMERGENCY_HEATING }))[0], 'EMERG 0s');
  });

  it('prefixes ! on error', () => {
    const labels = buildDisplayLabels(makeDisplayState({
      mode: MODES.SOLAR_CHARGING,
      lastError: 'valve_vi_btm',
    }));
    assert.strictEqual(labels[0], '!SOLAR 0s');
  });

  it('appends D when drained and idle', () => {
    const labels = buildDisplayLabels(makeDisplayState({
      mode: MODES.IDLE,
      collectorsDrained: true,
    }));
    assert.strictEqual(labels[0], 'IDLE 0s D');
  });

  it('does not append D when drained but not idle', () => {
    const labels = buildDisplayLabels(makeDisplayState({
      mode: MODES.SOLAR_CHARGING,
      collectorsDrained: true,
    }));
    assert.strictEqual(labels[0], 'SOLAR 0s');
  });

  it('shows collector and tank temps on ch1', () => {
    const labels = buildDisplayLabels(makeDisplayState({
      temps: { collector: 68.2, tank_top: 45, tank_bottom: 38, greenhouse: 8, outdoor: 3 },
    }));
    assert.strictEqual(labels[1], 'Coll 68C Tk45C/38C');
  });

  it('shows greenhouse temp on ch2', () => {
    const labels = buildDisplayLabels(makeDisplayState({
      temps: { collector: 20, tank_top: 45, tank_bottom: 38, greenhouse: 8.3, outdoor: 3 },
    }));
    assert.strictEqual(labels[2], 'GH 8C');
  });

  it('shows outdoor temp on ch3', () => {
    const labels = buildDisplayLabels(makeDisplayState({
      temps: { collector: 20, tank_top: 45, tank_bottom: 38, greenhouse: 8, outdoor: 3.1 },
    }));
    assert.strictEqual(labels[3], 'Out 3C');
  });

  it('handles null temps with --', () => {
    const labels = buildDisplayLabels(makeDisplayState({
      temps: { collector: null, tank_top: null, tank_bottom: null, greenhouse: null, outdoor: null },
    }));
    assert.strictEqual(labels[1], 'Coll -- Tk--/--');
    assert.strictEqual(labels[2], 'GH --');
    assert.strictEqual(labels[3], 'Out --');
  });

  it('returns exactly 4 labels', () => {
    const labels = buildDisplayLabels(makeDisplayState({}));
    assert.strictEqual(labels.length, 4);
  });
});
