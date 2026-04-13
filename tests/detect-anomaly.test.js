const { describe, it } = require('node:test');
const assert = require('node:assert');
const { detectAnomaly } = require('../shelly/control-logic.js');

function entry(overrides) {
  return Object.assign({
    mode: 'SOLAR_CHARGING',
    at: 1000,
    tankTop: 50,
    collector: 80,
    greenhouse: 10
  }, overrides || {});
}

function sensors(overrides) {
  return Object.assign({
    collector: 80,
    tank_top: 50,
    tank_bottom: 40,
    greenhouse: 10,
    outdoor: 5
  }, overrides || {});
}

function cfg(overrides) {
  return Object.assign({
    ce: true,
    we: { sng: 1, scs: 1, ggr: 1 },
    wz: {},
    mo: null
  }, overrides || {});
}

describe('detectAnomaly', () => {
  it('returns null when entry is null', () => {
    assert.strictEqual(detectAnomaly(null, 2000, sensors(), cfg()), null);
  });

  it('returns null when ce is false (commissioning)', () => {
    // Would otherwise fire scs
    assert.strictEqual(
      detectAnomaly(entry({ at: 1000 }), 1400, sensors({ collector: 80 }),
                    cfg({ ce: false })),
      null
    );
  });

  it('returns null when mo.ss=true (suppressSafety)', () => {
    assert.strictEqual(
      detectAnomaly(entry({ at: 1000 }), 1400, sensors({ collector: 80 }),
                    cfg({ mo: { a: true, ss: true, ex: 9999999999 } })),
      null
    );
  });

  it('detects scs: collector not dropping after 5 min', () => {
    // entry collector 80, current collector 79 (delta 1, < 3 threshold)
    // elapsed 300s = window exactly met
    const result = detectAnomaly(
      entry({ at: 1000, collector: 80 }),
      1300,
      sensors({ collector: 79 }),
      cfg()
    );
    assert.strictEqual(result, 'scs');
  });

  it('does not fire scs when collector has dropped enough', () => {
    const result = detectAnomaly(
      entry({ at: 1000, collector: 80 }),
      1300,
      sensors({ collector: 76 }),  // delta 4 > 3
      cfg()
    );
    assert.strictEqual(result, null);
  });

  it('detects sng: tank_top not rising after 10 min', () => {
    const result = detectAnomaly(
      entry({ at: 1000, tankTop: 50, collector: 80 }),
      1600,
      sensors({ tank_top: 50.2, collector: 70 }),  // collector OK (dropped 10), tank not (rose 0.2)
      cfg()
    );
    assert.strictEqual(result, 'sng');
  });

  it('fires scs before sng when both conditions hold at t=600', () => {
    // Both windows elapsed, both conditions met
    const result = detectAnomaly(
      entry({ at: 1000, tankTop: 50, collector: 80 }),
      1600,
      sensors({ tank_top: 50, collector: 80 }),
      cfg()
    );
    assert.strictEqual(result, 'scs');  // 5-min window wins over 10-min
  });

  it('returns null when scs is disabled', () => {
    const result = detectAnomaly(
      entry({ at: 1000, collector: 80 }),
      1300,
      sensors({ collector: 80 }),
      cfg({ we: { scs: 0, sng: 1, ggr: 1 } })
    );
    assert.strictEqual(result, null);
  });

  it('returns null when scs is snoozed', () => {
    const result = detectAnomaly(
      entry({ at: 1000, collector: 80 }),
      1300,
      sensors({ collector: 80 }),
      cfg({ wz: { scs: 2000 } })  // snoozed until now+700s
    );
    assert.strictEqual(result, null);
  });

  it('fires scs when snooze has expired', () => {
    const result = detectAnomaly(
      entry({ at: 1000, collector: 80 }),
      1300,
      sensors({ collector: 80 }),
      cfg({ wz: { scs: 1200 } })  // expired before now=1300
    );
    assert.strictEqual(result, 'scs');
  });

  it('detects ggr: greenhouse not rising after 15 min', () => {
    const result = detectAnomaly(
      entry({ mode: 'GREENHOUSE_HEATING', at: 1000, greenhouse: 8 }),
      1900,  // 900s elapsed
      sensors({ greenhouse: 8.2 }),  // delta 0.2 < 0.5
      cfg()
    );
    assert.strictEqual(result, 'ggr');
  });

  it('does not fire ggr when greenhouse has risen enough', () => {
    const result = detectAnomaly(
      entry({ mode: 'GREENHOUSE_HEATING', at: 1000, greenhouse: 8 }),
      1900,
      sensors({ greenhouse: 8.7 }),  // delta 0.7 > 0.5
      cfg()
    );
    assert.strictEqual(result, null);
  });

  it('returns null before window has elapsed', () => {
    const result = detectAnomaly(
      entry({ mode: 'GREENHOUSE_HEATING', at: 1000 }),
      1100,  // only 100s elapsed
      sensors({ greenhouse: 10 }),  // no rise
      cfg()
    );
    assert.strictEqual(result, null);
  });

  it('returns null for modes without watchdogs (ACTIVE_DRAIN)', () => {
    const result = detectAnomaly(
      entry({ mode: 'ACTIVE_DRAIN', at: 1000 }),
      1900,
      sensors(),
      cfg()
    );
    assert.strictEqual(result, null);
  });
});
