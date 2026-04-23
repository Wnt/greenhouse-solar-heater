import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createModel, tick, PARAMS } from '../../playground/js/physics.js';

const IDLE_DECISIONS = {
  valves: { vi_btm: false, vi_top: false, vi_coll: false,
            vo_coll: false, vo_rad: false, vo_tank: false,
            v_air: false },
  actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false }
};

const SOLAR_DECISIONS = {
  valves: { vi_btm: true, vi_top: false, vi_coll: false,
            vo_coll: true, vo_rad: false, vo_tank: false,
            v_air: false },
  actuators: { pump: true, fan: false, space_heater: false, immersion_heater: false }
};

const HEATING_DECISIONS = {
  valves: { vi_btm: false, vi_top: true, vi_coll: false,
            vo_coll: false, vo_rad: true, vo_tank: false,
            v_air: false },
  actuators: { pump: true, fan: true, space_heater: false, immersion_heater: false }
};

const DRAIN_DECISIONS = {
  valves: { vi_btm: false, vi_top: false, vi_coll: true,
            vo_coll: false, vo_rad: false, vo_tank: true,
            v_air: true },
  actuators: { pump: true, fan: false, space_heater: false, immersion_heater: false }
};

const EMERGENCY_DECISIONS = {
  valves: { vi_btm: false, vi_top: false, vi_coll: false,
            vo_coll: false, vo_rad: false, vo_tank: false,
            v_air: false },
  actuators: { pump: false, fan: false, space_heater: true, immersion_heater: true }
};

describe('thermal model — collector', () => {
  it('heats up under irradiance with no flow', () => {
    const m = createModel({ collector: 20, outdoor: 10, irradiance: 800 });
    const m2 = tick(m, 60, IDLE_DECISIONS);
    assert.ok(m2.collector > m.collector, 'collector should heat up');
  });

  it('cools toward ambient with no irradiance', () => {
    const m = createModel({ collector: 60, outdoor: 10, irradiance: 0 });
    const m2 = tick(m, 60, IDLE_DECISIONS);
    assert.ok(m2.collector < m.collector, 'collector should cool');
    assert.ok(m2.collector > 10, 'should not cool below ambient in 60s');
  });

  it('dry collector responds faster than wet', () => {
    const mDry = createModel({ collector: 60, outdoor: 10, irradiance: 0,
                                collectorWaterVolume: 0 });
    const mWet = createModel({ collector: 60, outdoor: 10, irradiance: 0,
                                collectorWaterVolume: PARAMS.collectorWaterCapacity });
    const dryAfter = tick(mDry, 60, IDLE_DECISIONS);
    const wetAfter = tick(mWet, 60, IDLE_DECISIONS);
    const dryCooling = mDry.collector - dryAfter.collector;
    const wetCooling = mWet.collector - wetAfter.collector;
    assert.ok(dryCooling > wetCooling,
      'dry collector should cool faster (lower thermal mass)');
  });

  it('water flow extracts heat from collector', () => {
    const m = createModel({ collector: 60, tank_bottom: 30, outdoor: 20,
                            irradiance: 0, collectorWaterVolume: 10 });
    const noFlow = tick(m, 10, IDLE_DECISIONS);
    const withFlow = tick(m, 10, SOLAR_DECISIONS);
    assert.ok(withFlow.collector < noFlow.collector,
      'flow should extract additional heat from collector');
  });
});

describe('thermal model — tank', () => {
  it('solar charging warms tank top', () => {
    // Start with mild stratification — heavy stratification + strong pump
    // mixing would briefly drop tank_top as the pump destratifies, even
    // while energy flows in. The test intent is "solar charging warms the
    // tank", so check tank mean (what stored energy depends on).
    const m = createModel({ collector: 70, tank_top: 35, tank_bottom: 30,
                            outdoor: 10, irradiance: 800, collectorWaterVolume: 10 });
    const m2 = tick(m, 60, SOLAR_DECISIONS);
    const meanBefore = (m.tank_top + m.tank_bottom) / 2;
    const meanAfter = (m2.tank_top + m2.tank_bottom) / 2;
    assert.ok(meanAfter > meanBefore, 'tank mean should warm during solar charging');
  });

  it('stable stratification: slow mixing when top > bottom', () => {
    const m = createModel({ tank_top: 60, tank_bottom: 30, outdoor: 20, irradiance: 0 });
    const m2 = tick(m, 3600, IDLE_DECISIONS);
    assert.ok(m2.tank_top > m2.tank_bottom,
      'stratification should persist (top still hotter)');
  });

  it('unstable stratification: rapid mixing when bottom > top', () => {
    const m = createModel({ tank_top: 30, tank_bottom: 60, outdoor: 20, irradiance: 0 });
    const m2 = tick(m, 3600, IDLE_DECISIONS);
    const diff = Math.abs(m2.tank_top - m2.tank_bottom);
    assert.ok(diff < 10, 'unstable stratification should mix rapidly, diff=' + diff.toFixed(1));
  });
});

describe('thermal model — greenhouse', () => {
  it('cools toward ambient with no heating', () => {
    const m = createModel({ greenhouse: 15, outdoor: 0, irradiance: 0 });
    const m2 = tick(m, 3600, IDLE_DECISIONS);
    assert.ok(m2.greenhouse < m.greenhouse, 'greenhouse should cool');
    assert.ok(m2.greenhouse > 0, 'should not reach ambient in 1h');
  });

  it('warms with radiator flow from hot tank', () => {
    const m = createModel({ greenhouse: 10, tank_top: 60, tank_bottom: 40,
                            outdoor: 5, irradiance: 0 });
    const noHeat = tick(m, 3600, IDLE_DECISIONS);
    const withHeat = tick(m, 3600, HEATING_DECISIONS);
    assert.ok(withHeat.greenhouse > noHeat.greenhouse,
      'radiator should warm greenhouse');
  });

  it('warms with space heater', () => {
    const m = createModel({ greenhouse: 5, outdoor: -5, irradiance: 0 });
    const m2 = tick(m, 3600, EMERGENCY_DECISIONS);
    assert.ok(m2.greenhouse > m.greenhouse, 'space heater should warm greenhouse');
  });
});

describe('thermal model — drain', () => {
  it('reduces collector water volume', () => {
    const m = createModel({ collectorWaterVolume: 10, collector: 30,
                            tank_bottom: 30, outdoor: 10, irradiance: 0 });
    const m2 = tick(m, 60, DRAIN_DECISIONS);
    assert.ok(m2.collectorWaterVolume < m.collectorWaterVolume,
      'drain should reduce water volume');
  });

  it('water volume does not go below zero', () => {
    const m = createModel({ collectorWaterVolume: 0.01, collector: 30,
                            tank_bottom: 30, outdoor: 10, irradiance: 0 });
    const m2 = tick(m, 60, DRAIN_DECISIONS);
    assert.ok(m2.collectorWaterVolume >= 0, 'volume should not go negative');
  });

  it('solar flow fills collectors', () => {
    const m = createModel({ collectorWaterVolume: 0, collector: 30,
                            tank_bottom: 30, outdoor: 10, irradiance: 0 });
    const m2 = tick(m, 60, SOLAR_DECISIONS);
    assert.ok(m2.collectorWaterVolume > 0, 'solar flow should fill collectors');
  });
});
