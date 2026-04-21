const { describe, it } = require('node:test');
const assert = require('node:assert');
const { detectAnomaly } = require('../../shelly/control-logic.js');

describe('watchdog simulation scenarios', () => {
  const cfg = {
    ce: true,
    we: { sng: 1, scs: 1, ggr: 1 },
    wz: {},
    mo: null
  };

  it('ggr fires when greenhouse heating door is open (greenhouse stays flat)', () => {
    const entry = {
      mode: 'GREENHOUSE_HEATING', at: 1000,
      tankTop: 48, collector: 20, greenhouse: 8
    };

    // Simulate a door open: greenhouse temperature stays at 8.1 despite
    // heating running. No fire should occur until 900s have elapsed.
    for (let t = 1000; t < 1900; t += 30) {
      const s = { collector: 20, tank_top: 48, greenhouse: 8.1 };
      const fired = detectAnomaly(entry, t, s, cfg);
      assert.strictEqual(fired, null, 'should not fire before window at t=' + t);
    }

    // At t=1900 (900s elapsed), fire
    const finalS = { collector: 20, tank_top: 48, greenhouse: 8.1 };
    const fired = detectAnomaly(entry, 1900, finalS, cfg);
    assert.strictEqual(fired, 'ggr');
  });

  it('scs fires when solar charging collector stays hot (stuck flow)', () => {
    const entry = {
      mode: 'SOLAR_CHARGING', at: 1000,
      tankTop: 40, collector: 80, greenhouse: 15
    };
    // Collector delta is only 1°C after 5 min — below the 3°C threshold
    const s = { collector: 79, tank_top: 40, greenhouse: 15 };
    const fired = detectAnomaly(entry, 1300, s, cfg);
    assert.strictEqual(fired, 'scs');
  });

  it('healthy solar charging produces zero fires within the first 30 min', () => {
    // "Healthy" here means the flow is circulating: collector drops
    // quickly at mode entry as cold tank water displaces the stagnant
    // hot water, and tank_top rises visibly within 10 min.
    //   - collector: 80 → 70 within 5 min (drop ≥ 3°C by t=300)
    //   - tank_top: 40 → 41 within 10 min (rise ≥ 0.5°C by t=600)
    const entry = {
      mode: 'SOLAR_CHARGING', at: 0,
      tankTop: 40, collector: 80, greenhouse: 15
    };
    let fires = 0;
    for (let t = 0; t <= 1800; t += 30) {
      // Fast initial collector drop (10°C in 5 min) then slow.
      // Tank rises steadily at 6°C/hr.
      const collectorDrop = Math.min(10, (t / 300) * 10) + Math.max(0, (t - 300) / 1800 * 5);
      const tankRise = (t / 3600) * 6;
      const fired = detectAnomaly(entry, t, {
        collector: 80 - collectorDrop,
        tank_top: 40 + tankRise,
        greenhouse: 15
      }, cfg);
      if (fired) fires++;
    }
    assert.strictEqual(fires, 0, 'healthy circulation produces no fires');
  });

  it('snooze suppresses detection for the full snooze window', () => {
    const entry = {
      mode: 'GREENHOUSE_HEATING', at: 1000,
      tankTop: 48, collector: 20, greenhouse: 8
    };
    const s = { collector: 20, tank_top: 48, greenhouse: 8.1 };
    // With ggr snoozed until t=99999, no fire even though 900s elapsed
    const cfgSnoozed = Object.assign({}, cfg, { wz: { ggr: 99999 } });
    const fired = detectAnomaly(entry, 1900, s, cfgSnoozed);
    assert.strictEqual(fired, null);

    // After snooze expires (t > 99999), fire resumes
    const firedAfter = detectAnomaly(entry, 100000, s, cfgSnoozed);
    assert.strictEqual(firedAfter, 'ggr');
  });

  it('active manual override fully suspends watchdog detection', () => {
    // Hard override (2026-04-21): mo.a=true alone is the suppression
    // signal; the old mo.ss field is gone. Watchdog must not fire
    // while the user is driving the system manually.
    const entry = {
      mode: 'GREENHOUSE_HEATING', at: 1000,
      tankTop: 48, collector: 20, greenhouse: 8
    };
    const s = { collector: 20, tank_top: 48, greenhouse: 8.1 };
    const cfgOverride = Object.assign({}, cfg, {
      mo: { a: true, fm: 'I', ex: 9999999999 }
    });
    const fired = detectAnomaly(entry, 1900, s, cfgOverride);
    assert.strictEqual(fired, null);
  });

  it('ce=false fully suspends detection (commissioning mode)', () => {
    const entry = {
      mode: 'GREENHOUSE_HEATING', at: 1000,
      tankTop: 48, collector: 20, greenhouse: 8
    };
    const s = { collector: 20, tank_top: 48, greenhouse: 8.1 };
    const cfgOff = Object.assign({}, cfg, { ce: false });
    const fired = detectAnomaly(entry, 1900, s, cfgOff);
    assert.strictEqual(fired, null);
  });
});
